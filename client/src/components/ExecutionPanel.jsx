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
            {resList.slice(0, 10).map((r, i) => (
              <div key={r.id || r.profileId || i} className="text-xs font-mono text-slate-500 border-b border-edge/30 py-0.5 mt-1 flex justify-between">
                <span>{r.id || r.profileId}</span>
                <span>{r.status || ''}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
