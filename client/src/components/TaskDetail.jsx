import React, { useEffect, useRef, useState } from 'react';
import api from '../api';
import { createLatestGuard, createTrailingThrottle } from '../lib/reloadGuard.mjs';

// VIL 决策 → 默认人类可读说明（后端未提供 why 时使用）
const VIL_WHY = {
  RECHECK_OBSERVATION: '观测延迟，等待稳定后重验证',
  PROCEED: '当前观测一致，可继续推进',
  REPAIR: '检测到异常，建议执行修复策略',
  ESCALATE: '超出自动修复范围，建议升级人工',
  ABORT: '风险过高，建议中止任务',
};

const ST_COLOR = (s) => ({
  RUNNING: 'text-emerald-400', SUCCESS: 'text-emerald-400', PAUSED_FOR_HUMAN: 'text-amber-400',
  FAILED: 'text-rose-400', PENDING: 'text-slate-400', CANCELLED: 'text-slate-500',
  PLANNING: 'text-sky-400', PREPARING: 'text-sky-400', BROWSER_READY: 'text-sky-400', PROFILE_READY: 'text-sky-400',
}[s] || 'text-slate-400');

function lastByKind(timeline, kind) {
  if (!Array.isArray(timeline)) return null;
  for (let i = timeline.length - 1; i >= 0; i--) if (timeline[i].kind === kind) return timeline[i];
  return null;
}

function fmtConf(v) {
  if (v == null) return '-';
  if (typeof v === 'number' && v <= 1) return (v * 100).toFixed(0) + '%';
  return String(v);
}

// C27：任意结构的取证 JSON（诊断 / 执行详情 / 重放）——统一折叠 + 截断，避免长 payload 撑爆面板
function JsonBlock({ value, maxHeight }) {
  const [open, setOpen] = useState(false);
  if (value == null) return <span className="text-slate-600">暂无</span>;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="text-xs px-2 py-0.5 rounded border border-edge hover:bg-edge text-slate-300">
        {open ? '收起' : '展开原始 JSON'}
      </button>
      {open && (
        <pre className="text-xs bg-black/40 rounded p-2 overflow-auto text-slate-300 mt-1"
          style={{ maxHeight: maxHeight || 220 }}>{text.slice(0, 8000)}</pre>
      )}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="rounded border border-edge bg-panel p-3">
      <div className="text-xs font-semibold text-slate-400 mb-1.5">{title}</div>
      <div className="text-sm text-slate-200 break-words">{children || <span className="text-slate-600">暂无</span>}</div>
    </div>
  );
}

export default function TaskDetail({ taskId, onClose }) {
  const [task, setTask] = useState(null);
  const [trace, setTrace] = useState(null);
  const [events, setEvents] = useState([]);
  const [forensics, setForensics] = useState({ diagnosis: null, repairs: null, execution: null, replay: null });
  const [err, setErr] = useState('');
  const [recovering, setRecovering] = useState(false);
  const [recoverMsg, setRecoverMsg] = useState('');
  const eventsRef = useRef([]);

  useEffect(() => {
    let alive = true;
    // C37：SSE 与轮询双通道并发 reload —— latest-wins 守卫，先发后至的旧响应不落 state
    //（否则任务事件密集时旧 trace/observation 覆盖新数据，UI 状态回跳）。
    const guard = createLatestGuard();

    const reload = async () => {
      await guard(
        () => Promise.all([api.aiGetTask(taskId), api.aiTrace(taskId)]),
        ([t, tr]) => { if (alive) { setTask(t); setTrace(tr.trace || null); } }
      ).catch((e) => { if (alive) setErr(String(e.message || e)); });
      if (!alive) return;
      // C27 取证四件套：任一失败（404/未产生诊断）不阻断主面板，降级为 null
      await guard(
        () => Promise.all([
          api.aiDiagnosis(taskId).catch(() => null),
          api.aiRepairs(taskId).catch(() => null),
          api.aiExecutionDetail(taskId).catch(() => null),
          api.aiReplay(taskId).catch(() => null),
        ]),
        ([d, r, x, rp]) => { if (alive) setForensics({ diagnosis: d, repairs: r, execution: x, replay: rp }); }
      ).catch(() => {});
    };

    reload();
    const poll = setInterval(reload, 2500);

    // C37：SSE 收到事件仍实时追加 timeline，但数据刷新改为 800ms leading+trailing 节流 ——
    // 此前每条事件直触发一次完整 reload（6 请求/事件），任务执行事件密集时形成请求风暴。
    const bump = createTrailingThrottle(reload, 800);

    // 复用 SSE 进行实时更新
    let es;
    try {
      es = new EventSource('/api/ai/tasks/' + taskId + '/events');
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          eventsRef.current = [...eventsRef.current.slice(-199), data];
          setEvents(eventsRef.current);
          bump.call();
        } catch (e) { /* ignore malformed */ }
      };
    } catch (e) { /* EventSource 不可用时静默降级为轮询 */ }

    return () => {
      alive = false;
      clearInterval(poll);
      bump.cancel();
      if (es) es.close();
    };
  }, [taskId]);

  const timeline = (trace && trace.timeline) || [];
  const goal = task?.objective || task?.goal || task?.targetUrl || '-';
  const step = lastByKind(timeline, 'STEP');
  const action = lastByKind(timeline, 'ACTION');
  const observation = lastByKind(timeline, 'OBSERVATION');
  const verification = lastByKind(timeline, 'VERIFICATION');
  const vil = lastByKind(timeline, 'VIL');
  const repair = lastByKind(timeline, 'REPAIR');
  const checkpoint = lastByKind(timeline, 'CHECKPOINT');
  const escalation = lastByKind(timeline, 'ESCALATION');

  const browserUrl = checkpoint?.url || task?.targetUrl || '-';

  // C35：崩溃/进程重启后手动恢复（仅 RUNNING/HEALING/RECOVERING；从 checkpoint 重建，跳过已成功步骤）
  const canRecover = ['RUNNING', 'HEALING', 'RECOVERING'].includes(task?.status);
  const recoverTask = async () => {
    setRecovering(true);
    setRecoverMsg('');
    try {
      await api.aiRecoverTask(taskId);
      setRecoverMsg('已发出恢复指令（从 checkpoint 重建）');
    } catch (e) {
      setRecoverMsg('恢复失败：' + String(e.message || e).slice(0, 160));
    } finally { setRecovering(false); }
  };

  const vilText = vil
    ? `VIL 建议 ${vil.decision || '-'}${vil.failureType ? `（${vil.failureType}）` : ''}：${vil.why || VIL_WHY[vil.decision] || '—'}`
    : null;

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
      <div className="w-full max-w-4xl bg-panel border border-edge rounded-lg overflow-hidden flex flex-col" style={{ height: '90vh' }}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-edge bg-panel/80 shrink-0">
          <div className="text-sm font-semibold text-slate-200">📝 任务详情 · <span className="font-mono text-slate-400">{taskId}</span></div>
          <div className="flex items-center gap-2">
            {recoverMsg && <span className="text-xs text-amber-300">{recoverMsg}</span>}
            {canRecover && (
              <button disabled={recovering} onClick={recoverTask}
                className="text-xs px-2 py-1 rounded border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 disabled:opacity-40">
                {recovering ? '恢复中…' : '↻ 恢复任务'}
              </button>
            )}
            <button onClick={onClose} className="text-slate-400 hover:text-white">✕</button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-3">
          {err && <div className="text-rose-400 text-sm">{err}</div>}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Section title="Goal（目标）">{goal}</Section>
            <Section title="Status（状态）">
              <span className={ST_COLOR(task?.status)}>{task?.status || '-'}</span>
              {task?.error && <div className="text-xs text-rose-400 mt-1">{task.error}</div>}
            </Section>
            <Section title="Browser（浏览器）">
              <div>URL: <span className="font-mono">{browserUrl}</span></div>
              {task?.executionMode && <div className="text-xs text-slate-500 mt-1">模式: {task.executionMode}</div>}
            </Section>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Section title="Current Step（当前步骤）">
              {step ? `${step.type || ''} · ${step.description || ''} · ${step.status || ''}` : '-'}
            </Section>
            <Section title="Action（动作）">
              {action ? `${action.action?.type || action.action?.tool || '-'} · ${action.status || ''}` : '-'}
            </Section>
            <Section title="Observation（观测）">
              {observation ? <pre className="text-xs bg-black/40 rounded p-2 overflow-auto max-h-32 text-slate-300">{JSON.stringify(observation.observation, null, 2).slice(0, 600)}</pre> : '-'}
            </Section>
            <Section title="Verification（验证）">
              {verification
                ? (<>
                    <div className="text-xs">{verification.result != null ? (verification.result ? '通过 ✅' : '未通过 ❌') : (verification.passed != null ? (verification.passed ? '通过 ✅' : '未通过 ❌') : '-')}</div>
                    <pre className="text-xs bg-black/40 rounded p-2 overflow-auto max-h-32 text-slate-300 mt-1">{JSON.stringify(verification.payload || verification, null, 2).slice(0, 600)}</pre>
                  </>)
                : '-'}
            </Section>
            <Section title="VIL（VIL 决策）">
              {vilText
                ? (<>
                    <div>{vilText}</div>
                    <div className="text-xs text-slate-500 mt-1">confidence: {fmtConf(vil.confidence)}</div>
                  </>)
                : '-'}
            </Section>
            <Section title="Repair（修复）">
              {repair ? `${repair.strategy || ''} · ${repair.status || ''} · risk=${repair.risk || '-'}` : '-'}
            </Section>
          </div>

          {escalation && (
            <Section title="Escalation（升级）">
              <div className="text-amber-400">升级人工：{escalation.reason || 'verification 重试耗尽 / credential 需审批'}</div>
            </Section>
          )}

          {/* C27 取证四件套：诊断 / 修复尝试 / 执行详情 / 动作链重放（此前 client 零消费） */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Section title="Diagnosis（结构化诊断）">
              {forensics.diagnosis && forensics.diagnosis.available ? (
                <>
                  <div className="text-xs">
                    根因 <span className="text-sky-300 font-mono">{forensics.diagnosis.diagnosis.rootCause || '-'}</span>
                    {forensics.diagnosis.diagnosis.category ? <span className="ml-2 text-slate-500">类别 {forensics.diagnosis.diagnosis.category}</span> : null}
                    <span className="ml-2 text-slate-500">置信 {fmtConf(forensics.diagnosis.diagnosis.confidence)}</span>
                    {forensics.diagnosis.diagnosis.retryPolicy ? <span className="ml-2 text-slate-500">重试策略 {forensics.diagnosis.diagnosis.retryPolicy}</span> : null}
                  </div>
                  {forensics.diagnosis.diagnosis.summary && <div className="text-xs text-slate-300 mt-1">{forensics.diagnosis.diagnosis.summary}</div>}
                  {forensics.diagnosis.diagnosis.recommendation && <div className="text-xs text-emerald-300 mt-1">建议：{forensics.diagnosis.diagnosis.recommendation}</div>}
                  {Array.isArray(forensics.diagnosis.diagnosis.evidence) && forensics.diagnosis.diagnosis.evidence.length > 0 && (
                    <ul className="text-xs text-slate-500 mt-1 list-disc pl-4">
                      {forensics.diagnosis.diagnosis.evidence.slice(0, 5).map((e, i) => <li key={i}>{String(e).slice(0, 160)}</li>)}
                    </ul>
                  )}
                  {Array.isArray(forensics.diagnosis.failureSnapshots) && forensics.diagnosis.failureSnapshots.length > 0 && (
                    <div className="text-xs text-slate-500 mt-1">失败快照 {forensics.diagnosis.failureSnapshots.length} 条（最近）：
                      {forensics.diagnosis.failureSnapshots.slice(-3).map((s) => (
                        <span key={s.id} className="ml-1 font-mono">{s.errorType || 'ERR'}@{String(s.stepId || '').slice(-6)}</span>
                      ))}
                    </div>
                  )}
                  <div className="mt-1"><JsonBlock value={forensics.diagnosis.diagnosis} /></div>
                </>
              ) : <span className="text-slate-600">暂无诊断（任务未失败或尚未触发诊断）</span>}
            </Section>

            <Section title="Repair Attempts（修复尝试 · 策略成功率）">
              {forensics.repairs && (forensics.repairs.repairs || []).length > 0 ? (
                <>
                  <div className="space-y-1 max-h-28 overflow-auto">
                    {forensics.repairs.repairs.slice(-10).map((r, i) => (
                      <div key={r.id || i} className="text-xs flex justify-between border-b border-edge/30 py-0.5">
                        <span className="font-mono text-slate-300">{r.strategy || '-'}</span>
                        <span className={r.status === 'SUCCESS' ? 'text-emerald-400' : 'text-rose-400'}>{r.status || '-'}</span>
                      </div>
                    ))}
                  </div>
                  {Array.isArray(forensics.repairs.stats) && forensics.repairs.stats.length > 0 && (
                    <div className="text-xs text-slate-500 mt-1.5">
                      全局成功率：
                      {forensics.repairs.stats.slice(0, 5).map((s) => (
                        <span key={s.strategy} className="ml-1">{s.strategy} {(s.successRate * 100).toFixed(0)}%（{s.total}）</span>
                      ))}
                    </div>
                  )}
                </>
              ) : <span className="text-slate-600">暂无修复尝试</span>}
            </Section>

            <Section title="Execution Detail（执行记录）">
              <JsonBlock value={forensics.execution} />
            </Section>

            <Section title="Action Replay（动作链重放）">
              <JsonBlock value={forensics.replay} maxHeight={280} />
            </Section>
          </div>

          <div className="rounded border border-edge bg-panel p-3">
            <div className="text-xs font-semibold text-slate-400 mb-1.5">Live Events（SSE 实时流）</div>
            <div className="text-xs font-mono text-slate-400 max-h-40 overflow-auto space-y-0.5">
              {events.length === 0 && <div className="text-slate-600">等待事件…</div>}
              {events.slice(-50).map((e, i) => (
                <div key={i} className="truncate">
                  <span className="text-slate-600">{e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : ''}</span>{' '}
                  <span className="text-sky-400">{e.type}</span>{' '}
                  <span className="text-slate-500">{e.payload ? JSON.stringify(e.payload).slice(0, 120) : ''}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
