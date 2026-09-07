import React, { useEffect, useState, useCallback } from 'react';
import api from '../api';

// C23: 执行引擎面板（Scheduler + Worker 池 + 队列 + 资源池）。
// 缺口背景：/api/ai/execution/* 全家桶（README 宣称的「Worker 池、容量管理」）此前 client 零消费。
// 语义对齐：scheduler start/stop/pause/resume/drain；worker 优雅停止（忙时 DRAINING）。

const BADGE = {
  RUNNING: 'bg-emerald-500/15 text-emerald-400',
  PAUSED: 'bg-amber-500/15 text-amber-400',
  STOPPED: 'bg-slate-500/15 text-slate-400',
  DRAINING: 'bg-sky-500/15 text-sky-400',
  READY: 'bg-emerald-500/15 text-emerald-400',
  DEAD: 'bg-rose-500/15 text-rose-400',
};
const badge = (s) => BADGE[s] || 'bg-slate-500/15 text-slate-400';

export default function ExecutionPanel({ notify }) {
  const [status, setStatus] = useState(null);
  const [workers, setWorkers] = useState([]);
  const [queue, setQueue] = useState(null);
  const [resources, setResources] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // C29：提交执行 / 崩溃恢复 / 资源池操作 / 契约与策略调试
  const [submitForm, setSubmitForm] = useState({ taskId: '', priorityOverride: '' });
  const [submitResult, setSubmitResult] = useState(null);
  const [recovery, setRecovery] = useState(null);
  const [recoverTimeoutMs, setRecoverTimeoutMs] = useState('30000');
  const [resProfileId, setResProfileId] = useState('');
  // 样例必须自身合法：MUST_VERIFY 类动作（click/fill/...）必须带 verification(type≠none) 或 expectedBusinessState，
  // 否则 schema 直接判不合法（业务完成契约：禁止仅以 action_success 作为完成证据）。
  const [contractText, setContractText] = useState(JSON.stringify({
    action: {
      type: 'click',
      target: { text: '加入购物车' },
      verification: { type: 'text_present', value: '购物车：1 件' },
    },
  }, null, 2));
  const [contractResult, setContractResult] = useState(null);

  const load = useCallback(async () => {
    try {
      const [s, w, q, r] = await Promise.all([
        api.executionStatus(), api.executionWorkers(), api.executionQueue(), api.executionResources(),
      ]);
      setStatus(s || {});
      setWorkers(w.workers || []);
      setQueue(q || {});
      setResources(r || {});
      setErr('');
    } catch (e) { setErr(String(e.message || e)); }
  }, []);

  useEffect(() => {
    load();
    const h = setInterval(load, 5000);
    return () => clearInterval(h);
  }, [load]);

  const ctl = async (action, okMsg) => {
    setBusy(true);
    try { await api.schedulerCtl(action); notify(okMsg || ('已 ' + action)); await load(); }
    catch (e) { notify(e.message, false); }
    finally { setBusy(false); }
  };

  // C29：提交任务到执行引擎（Scheduler 运行中入队；未运行则走唯一执行链直接启动，绝不卡 QUEUED）
  const submitTask = async () => {
    if (!submitForm.taskId.trim()) return notify('请填写 taskId', false);
    setBusy(true);
    try {
      const body = { taskId: submitForm.taskId.trim() };
      if (submitForm.priorityOverride !== '') body.priorityOverride = Number(submitForm.priorityOverride);
      const r = await api.executionSubmit(body);
      setSubmitResult(r);
      notify(r.mode === 'scheduled' ? '已入队（调度器派遣）' : '已直接启动（调度器未运行）');
      await load();
    } catch (e) { notify(e.message, false); setSubmitResult({ error: String(e.message || e) }); }
    finally { setBusy(false); }
  };

  // C29：崩溃恢复扫描（DEAD worker 上的 RUNNING execution → RECOVERING）
  const runRecovery = async () => {
    setBusy(true);
    try {
      const r = await api.executionRecovery({ timeoutMs: 30000 });
      setRecovery(r);
      notify(`恢复扫描完成：回收 ${r.recovered} · 判定 DEAD ${r.dead}`);
      await load();
    } catch (e) { notify(e.message, false); }
    finally { setBusy(false); }
  };

  const acquireResource = async () => {
    if (!resProfileId.trim()) return notify('请填写 profileId', false);
    setBusy(true);
    try { await api.resourceAcquire({ profileId: resProfileId.trim() }); notify('资源已获取'); await load(); }
    catch (e) { notify(e.message, false); }
    finally { setBusy(false); }
  };

  // C33：僵尸资源回收——心跳超时 / 已终态任务仍占着的浏览器资源绑定
  const [recover, setRecover] = useState(null);

  const runResourceRecover = async () => {
    setBusy(true);
    try {
      const r = await api.resourceRecover({ heartbeatTimeoutMs: Number(recoverTimeoutMs) || 30000 });
      setRecover(r);
      notify(`资源回收完成：动作 ${(r.actions || []).length} 项`);
      await load();
    } catch (e) { notify(e.message, false); setRecover({ error: String(e.message || e) }); }
    finally { setBusy(false); }
  };

  const releaseResource = async () => {
    if (!resProfileId.trim()) return notify('请填写 profileId', false);
    setBusy(true);
    try { await api.resourceRelease({ profileId: resProfileId.trim() }); notify('资源已释放'); await load(); }
    catch (e) { notify(e.message, false); }
    finally { setBusy(false); }
  };

  // C29：动作契约校验 + 策略判定（只读调试，不执行任何动作）
  const checkContract = async () => {
    let parsed;
    try { parsed = JSON.parse(contractText); }
    catch (e) { notify('JSON 解析失败: ' + e.message, false); return; }
    setBusy(true);
    try {
      const [v, p] = await Promise.all([
        api.schemaValidate(parsed.action || parsed).catch((e) => ({ ok: false, errors: [String(e.message || e)] })),
        api.policyDecide({ action: parsed.action || parsed, task: parsed.task }).catch((e) => ({ ok: false, errors: [String(e.message || e)] })),
      ]);
      setContractResult({ validation: v, policy: p });
    } finally { setBusy(false); }
  };

  const schedSt = status && (status.status || status.state) || '—';
  const baseQueue = (queue && queue.queue) || [];
  const dispatches = (queue && queue.dispatches) || [];
  const resList = (resources && resources.resources) || [];
  const bindings = (resources && resources.bindings) || [];

  return (
    <div className="space-y-4">
      {/* Scheduler 控制 */}
      <div className="bg-panel/60 border border-edge rounded-lg p-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-slate-200">派遣调度器</span>
            <span className={`px-2 py-0.5 rounded text-xs ${badge(schedSt)}`}>{schedSt}</span>
            {status && status.tickMs && <span className="text-xs text-slate-500">tick {status.tickMs}ms</span>}
          </div>
          <div className="flex gap-2 text-xs">
            <button disabled={busy} onClick={() => ctl('start', '调度器已启动')} className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white">启动</button>
            <button disabled={busy} onClick={() => ctl('pause', '调度器已暂停')} className="px-3 py-1.5 rounded bg-amber-600/80 hover:bg-amber-500 disabled:opacity-40 text-white">暂停</button>
            <button disabled={busy} onClick={() => ctl('resume', '调度器已恢复')} className="px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white">恢复</button>
            <button disabled={busy} onClick={() => ctl('drain', '排水完成（等当前任务收尾）')} className="px-3 py-1.5 rounded border border-edge hover:bg-edge text-slate-300 disabled:opacity-40">排水</button>
            <button disabled={busy} onClick={() => ctl('tick', '已手动执行一次派遣 tick')} className="px-3 py-1.5 rounded border border-edge hover:bg-edge text-slate-300 disabled:opacity-40">单次 tick</button>
            <button disabled={busy} onClick={() => ctl('stop', '调度器已停止')} className="px-3 py-1.5 rounded bg-rose-600/80 hover:bg-rose-500 disabled:opacity-40 text-white">停止</button>
          </div>
        </div>
        {err && <div className="text-xs text-rose-400 mt-2">{err}</div>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Worker 池 */}
        <div className="bg-panel/60 border border-edge rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-slate-200">Worker 池（{workers.length}）</span>
            <button disabled={busy} onClick={async () => { setBusy(true); try { await api.workerStart({}); notify('Worker 已启动'); await load(); } catch (e) { notify(e.message, false); } finally { setBusy(false); } }}
              className="px-2 py-1 rounded bg-emerald-600/80 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs">+ 启动 Worker</button>
          </div>
          <div className="space-y-1.5 max-h-56 overflow-auto">
            {workers.map((w) => (
              <div key={w.id} className="flex items-center justify-between rounded border border-edge px-3 py-1.5 text-xs">
                <div className="min-w-0">
                  <span className="font-mono text-slate-300">{w.id}</span>
                  <span className={`ml-2 px-1.5 py-0.5 rounded ${badge(w.status)}`}>{w.status}</span>
                  {w.currentExecutionId && <span className="ml-2 text-slate-500">执行 {String(w.currentExecutionId).slice(-8)}</span>}
                </div>
                {!['STOPPED', 'DEAD'].includes(w.status) && (
                  <button disabled={busy} onClick={async () => { setBusy(true); try { const r = await api.workerStop(w.id); notify(r.note || r.status || '已停止'); await load(); } catch (e) { notify(e.message, false); } finally { setBusy(false); } }}
                    className="px-2 py-0.5 rounded border border-rose-500/40 text-rose-400 hover:bg-rose-500/10 disabled:opacity-40">停止</button>
                )}
              </div>
            ))}
            {!workers.length && <div className="text-slate-500 text-xs">无 Worker——点击「+ 启动 Worker」创建。</div>}
          </div>
        </div>

        {/* 队列 + 资源池 */}
        <div className="space-y-4">
          <div className="bg-panel/60 border border-edge rounded-lg p-4">
            <div className="text-sm font-semibold text-slate-200 mb-2">任务队列</div>
            <div className="text-xs text-slate-400">基础队列 <span className="text-sky-300 font-medium">{baseQueue.length}</span> 项 · 派遣执行 <span className="text-sky-300 font-medium">{dispatches.length}</span> 项</div>
            {baseQueue.length > 0 && (
              <div className="mt-2 space-y-1 max-h-28 overflow-auto">
                {baseQueue.slice(0, 20).map((q, i) => (
                  <div key={q.taskId || q.id || i} className="text-xs font-mono text-slate-500 border-b border-edge/30 py-0.5 flex justify-between">
                    <span>{q.taskId || q.id}</span>
                    <span>p{q.priority != null ? q.priority : '—'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="bg-panel/60 border border-edge rounded-lg p-4">
            <div className="text-sm font-semibold text-slate-200 mb-2">浏览器资源池</div>
            <div className="text-xs text-slate-400">资源 <span className="text-sky-300 font-medium">{resList.length}</span> 项 · 绑定 <span className="text-sky-300 font-medium">{bindings.length}</span> 项</div>
            <div className="flex items-center gap-2 mt-2 text-xs">
              <input className="flex-1 px-2 py-1 rounded bg-black/30 border border-edge text-slate-200"
                placeholder="profileId" value={resProfileId}
                onChange={(e) => setResProfileId(e.target.value)} />
              <button disabled={busy} onClick={acquireResource} className="px-2 py-1 rounded bg-emerald-600/80 hover:bg-emerald-500 disabled:opacity-40 text-white">获取</button>
              <button disabled={busy} onClick={releaseResource} className="px-2 py-1 rounded border border-edge hover:bg-edge text-slate-300 disabled:opacity-40">释放</button>
            </div>
            {resList.slice(0, 10).map((r, i) => (
              <div key={r.id || r.profileId || i} className="text-xs font-mono text-slate-500 border-b border-edge/30 py-0.5 mt-1 flex justify-between">
                <span>{r.id || r.profileId}</span>
                <span>{r.status || ''}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* C29：提交执行 + 崩溃恢复 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-panel/60 border border-edge rounded-lg p-4">
          <div className="text-sm font-semibold text-slate-200 mb-2">提交执行</div>
          <div className="flex items-center gap-2 text-xs">
            <input className="flex-1 px-2 py-1 rounded bg-black/30 border border-edge text-slate-200" placeholder="taskId"
              value={submitForm.taskId} onChange={(e) => setSubmitForm({ ...submitForm, taskId: e.target.value })} />
            <input className="w-24 px-2 py-1 rounded bg-black/30 border border-edge text-slate-200" placeholder="优先级"
              value={submitForm.priorityOverride} onChange={(e) => setSubmitForm({ ...submitForm, priorityOverride: e.target.value })} />
            <button disabled={busy} onClick={submitTask} className="px-3 py-1 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white">提交</button>
          </div>
          <div className="text-[11px] text-slate-500 mt-1.5">调度器运行中 → 入队由调度循环派遣；未运行 → 直接经唯一执行链启动（不会卡在 QUEUED）。</div>
          {submitResult && (
            <pre className="text-xs bg-black/40 rounded p-2 overflow-auto max-h-28 text-slate-300 mt-2">{JSON.stringify(submitResult, null, 2).slice(0, 1200)}</pre>
          )}
        </div>

        <div className="bg-panel/60 border border-edge rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-slate-200">崩溃恢复扫描</span>
            <button disabled={busy} onClick={runRecovery} className="px-3 py-1 rounded bg-amber-600/80 hover:bg-amber-500 disabled:opacity-40 text-white text-xs">立即扫描</button>
          </div>
          <div className="text-[11px] text-slate-500">把 DEAD worker 上残留的 RUNNING 执行标记为 RECOVERING（超时默认 30s）。</div>
          {recovery && (
            <div className="text-xs text-slate-300 mt-2">
              回收 <span className="text-emerald-400">{Array.isArray(recovery.recovered) ? recovery.recovered.length : recovery.recovered}</span> ·
              DEAD <span className={(Array.isArray(recovery.dead) ? recovery.dead.length : recovery.dead) ? 'text-rose-400' : 'text-slate-400'}>{Array.isArray(recovery.dead) ? recovery.dead.length : recovery.dead}</span>
            </div>
          )}
        </div>

        {/* C33：僵尸资源回收（补全 resources/recover 端点 UI 缺口） */}
        <div className="bg-panel/60 border border-edge rounded-lg p-4">
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <span className="text-sm font-semibold text-slate-200">僵尸资源回收</span>
            <button disabled={busy} onClick={runResourceRecover} className="px-3 py-1 rounded bg-amber-600/80 hover:bg-amber-500 disabled:opacity-40 text-white text-xs">立即回收</button>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-500">心跳超时</span>
            <input className="w-24 px-2 py-1 rounded bg-black/30 border border-edge text-slate-200" value={recoverTimeoutMs}
              onChange={(e) => setRecoverTimeoutMs(e.target.value)} />
            <span className="text-slate-500">ms</span>
          </div>
          <div className="text-[11px] text-slate-500 mt-1.5">
            回收心跳超时或所属任务已终态的浏览器资源绑定，避免崩溃后资源泄漏占满池子。
          </div>
          {recover && (
            <pre className="text-xs bg-black/40 rounded p-2 overflow-auto max-h-32 text-slate-300 mt-2">{JSON.stringify(recover, null, 2).slice(0, 1200)}</pre>
          )}
        </div>
      </div>

      {/* C29：动作契约校验 + 策略判定（只读调试） */}
      <div className="bg-panel/60 border border-edge rounded-lg p-4">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <span className="text-sm font-semibold text-slate-200">动作契约校验 / 策略判定（只读调试）</span>
          <button disabled={busy} onClick={checkContract} className="px-3 py-1 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white text-xs">校验</button>
        </div>
        <textarea className="w-full h-28 px-2 py-1 rounded bg-black/30 border border-edge text-slate-200 font-mono text-xs"
          value={contractText} onChange={(e) => setContractText(e.target.value)} />
        {contractResult && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2 text-xs">
            <div className="rounded border border-edge p-2">
              <div className="text-slate-400 mb-1">Schema</div>
              <div className={contractResult.validation && contractResult.validation.ok ? 'text-emerald-400' : 'text-rose-400'}>
                {contractResult.validation && contractResult.validation.ok ? '合法 ✅' : '不合法 ❌'}
              </div>
              {contractResult.validation && contractResult.validation.errors && contractResult.validation.errors.length > 0 && (
                <ul className="list-disc pl-4 text-rose-400 mt-1">
                  {contractResult.validation.errors.slice(0, 8).map((e2, i) => <li key={i}>{typeof e2 === 'string' ? e2 : JSON.stringify(e2)}</li>)}
                </ul>
              )}
            </div>
            <div className="rounded border border-edge p-2">
              <div className="text-slate-400 mb-1">Policy</div>
              {contractResult.policy && contractResult.policy.ok ? (
                <>
                  <div>有效风险级 <span className="text-amber-300">{String(contractResult.policy.effectiveRisk)}</span></div>
                  <pre className="bg-black/40 rounded p-1.5 overflow-auto max-h-24 text-slate-400 mt-1">{JSON.stringify(contractResult.policy.decision, null, 2).slice(0, 800)}</pre>
                </>
              ) : (
                <div className="text-rose-400">判定失败：{JSON.stringify((contractResult.policy && contractResult.policy.errors) || contractResult.policy || {}).slice(0, 300)}</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
