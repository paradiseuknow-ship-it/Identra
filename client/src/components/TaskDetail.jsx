import React, { useEffect, useRef, useState } from 'react';
import api from '../api';

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
  const [err, setErr] = useState('');
  const eventsRef = useRef([]);

  useEffect(() => {
    let alive = true;

    const reload = async () => {
      try {
        const [t, tr] = await Promise.all([api.aiGetTask(taskId), api.aiTrace(taskId)]);
        if (!alive) return;
        setTask(t);
        setTrace(tr.trace || null);
      } catch (e) {
        if (alive) setErr(String(e.message || e));
      }
    };

    reload();
    const poll = setInterval(reload, 2500);

    // 复用 SSE 进行实时更新：收到事件即追加，并触发一次数据刷新
    let es;
    try {
      es = new EventSource('/api/ai/tasks/' + taskId + '/events');
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          eventsRef.current = [...eventsRef.current.slice(-199), data];
          setEvents(eventsRef.current);
          reload();
        } catch (e) { /* ignore malformed */ }
      };
    } catch (e) { /* EventSource 不可用时静默降级为轮询 */ }

    return () => {
      alive = false;
      clearInterval(poll);
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

  const vilText = vil
    ? `VIL 建议 ${vil.decision || '-'}${vil.failureType ? `（${vil.failureType}）` : ''}：${vil.why || VIL_WHY[vil.decision] || '—'}`
    : null;

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
      <div className="w-full max-w-4xl bg-panel border border-edge rounded-lg overflow-hidden flex flex-col" style={{ height: '90vh' }}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-edge bg-panel/80 shrink-0">
          <div className="text-sm font-semibold text-slate-200">📝 任务详情 · <span className="font-mono text-slate-400">{taskId}</span></div>
          <button onClick={onClose} className="text-slate-400 hover:text-white">✕</button>
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
