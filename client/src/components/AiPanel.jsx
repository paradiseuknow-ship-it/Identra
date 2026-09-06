import React, { useEffect, useState, useRef } from 'react';
import api from '../api';

// AI Browser Operator Console（Phase 1.4）
// 五大区块：Chat / Plan Preview / Timeline / Snapshot / Approval Center + LLM Dashboard。
// 流程：用户输入 → POST /api/ai/chat → Plan Preview → [执行] → Runtime → Timeline 实时更新。

const RISK_COLOR = { LOW: 'text-emerald-400', MEDIUM: 'text-sky-400', HIGH: 'text-amber-400', CRITICAL: 'text-rose-400' };
const ST_COLOR = (s) => ({
  RUNNING: 'text-emerald-400', SUCCESS: 'text-emerald-400', PAUSED_FOR_HUMAN: 'text-amber-400',
  FAILED: 'text-rose-400', PENDING: 'text-slate-400', CANCELLED: 'text-slate-500',
  PLANNING: 'text-sky-400', PREPARING: 'text-sky-400', BROWSER_READY: 'text-sky-400', PROFILE_READY: 'text-sky-400',
}[s] || 'text-slate-400');

function eventIcon(type) {
  if (type.startsWith('ai.thinking')) return '🧠';
  if (type === 'ai.plan.created') return '📋';
  if (type.includes('action.started')) return '▶';
  if (type.includes('action.completed')) return '✔';
  if (type.includes('verification.completed')) return '🔎';
  if (type.includes('snapshot')) return '📸';
  if (type.includes('warning')) return '⚠';
  if (type.includes('needApproval')) return '🙋';
  if (type.includes('failed')) return '✘';
  if (type.includes('retry') || type.includes('recovered')) return '↻';
  if (type.includes('paused')) return '⏸';
  if (type === 'task.completed') return '✅';
  return '·';
}

export default function AiPanel({ profiles, notify, onViewDetail, onGoToSettings }) {
  const [tasks, setTasks] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [stats, setStats] = useState(null);
  const [health, setHealth] = useState(null);

  // Chat
  const [chatInput, setChatInput] = useState('帮我打开 http://localhost:9555/form 注册一个账号');
  const [chatProfile, setChatProfile] = useState('');
  const [chatMode, setChatMode] = useState('ASSIST');
  const [chatSession, setChatSession] = useState('');
  const [preview, setPreview] = useState(null); // { sessionId, taskId, plan, status }
  const [chatBusy, setChatBusy] = useState(false);

  // 选中任务 + Timeline + Snapshot
  const [selectedTask, setSelectedTask] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [snapView, setSnapView] = useState(null);
  const [taskDetail, setTaskDetail] = useState(null);
  const [showDebug, setShowDebug] = useState(false);
  const timelineRef = useRef(null);

  const load = async () => {
    try { setTasks(await api.aiListTasks()); } catch (e) {}
    try { setSessions(await api.aiSessions()); } catch (e) {}
    try { setStats(await api.aiLLMStats()); } catch (e) {}
    try { setHealth(await api.aiHealth()); } catch (e) {}
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { if (timelineRef.current) timelineRef.current.scrollTop = timelineRef.current.scrollHeight; }, [timeline]);

  // SSE + 轮询任务详情/快照
  useEffect(() => {
    if (!selectedTask) { setTimeline([]); setSnapshots([]); setTaskDetail(null); return; }
    const es = new EventSource('/api/ai/tasks/' + selectedTask + '/events');
    es.onmessage = (ev) => { try { setTimeline((p) => [...p.slice(-100), JSON.parse(ev.data)]); } catch (e) {} };
    const poll = setInterval(async () => {
      try { setTaskDetail(await api.aiGetTask(selectedTask)); } catch (e) {}
      try { setSnapshots(await api.aiSnapshots(selectedTask)); } catch (e) {}
      load();
    }, 2500);
    api.aiTaskEvents(selectedTask).then(setTimeline).catch(() => {});
    api.aiGetTask(selectedTask).then(setTaskDetail).catch(() => {});
    api.aiSnapshots(selectedTask).then(setSnapshots).catch(() => {});
    return () => { es.close(); clearInterval(poll); };
  }, [selectedTask]);

  // Chat 发送：创建 Session + Task + Plan Preview
  const sendChat = async () => {
    if (!chatInput.trim()) { notify('请输入目标', false); return; }
    setChatBusy(true);
    try {
      const r = await api.aiChat({ message: chatInput, sessionId: chatSession || undefined, profileId: chatProfile || undefined, executionMode: chatMode });
      setPreview(r);
      setSelectedTask(r.taskId);
      setChatSession(r.sessionId);
      load();
      notify('计划已生成，请确认后执行');
    } catch (e) { notify(e.message, false); }
    finally { setChatBusy(false); }
  };

  const startTask = async (id) => { try { await api.aiStartTask(id); notify('已开始执行'); load(); } catch (e) { notify(e.message, false); } };
  const pauseTask = async (id) => { try { await api.aiPauseTask(id); notify('已暂停'); load(); } catch (e) { notify(e.message, false); } };
  const cancelTask = async (id) => { try { await api.aiCancelTask(id); notify('已取消'); load(); } catch (e) { notify(e.message, false); } };
  const retryTask = async (id) => { try { await api.aiRetryTask(id); notify('已重试'); load(); } catch (e) { notify(e.message, false); } };
  const approveTask = async (id) => { try { await api.aiApprove(id); notify('已批准执行'); load(); } catch (e) { notify(e.message, false); } };
  const rejectTask = async (id) => { try { await api.aiReject(id); notify('已拒绝'); load(); } catch (e) { notify(e.message, false); } };
  const modifyTask = async (id) => { try { await api.aiModify(id, { policy: { riskFloor: 'HIGH' } }); notify('已放宽风险级并恢复'); load(); } catch (e) { notify(e.message, false); } };

  const pa = taskDetail && taskDetail.pendingApproval;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* C16：mock 模式引导横幅 —— key 缺失时明确告知 + 一键跳转系统设置 */}
      {health && health.provider === 'mock' && (
        <div className="lg:col-span-2 rounded border border-amber-500/40 bg-amber-500/10 px-4 py-3 flex items-center justify-between gap-3">
          <span className="text-xs text-amber-300">⚠️ AI 功能当前为 <b>mock 模式</b>（未配置 LLM API key）——任务只会产生模拟计划，不会真正执行。配置 DeepSeek API key 后即可真实执行。</span>
          {onGoToSettings && (
            <button onClick={onGoToSettings} className="px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-white text-xs whitespace-nowrap">前往系统设置 →</button>
          )}
        </div>
      )}
      {/* 左列：Chat + Plan Preview + Approval */}
      <div className="space-y-4">
        <div className="rounded border border-edge bg-panel p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-200">🤖 Chat — 告诉 AI 你要完成什么</span>
            {health && <span className="text-xs text-slate-500">Provider={health.provider} · {health.phase}</span>}
          </div>
          <textarea className="inp min-h-[70px]" value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="例：打开 xxx.com 注册账号并登录" />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <select className="inp w-44" value={chatProfile} onChange={(e) => setChatProfile(e.target.value)}>
              <option value="">— Profile —</option>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select className="inp w-40" value={chatMode} onChange={(e) => setChatMode(e.target.value)}>
              <option value="ASSIST">ASSIST</option><option value="AUTONOMOUS">AUTONOMOUS</option>
              <option value="SIMULATION">SIMULATION</option><option value="DEBUG">DEBUG</option>
            </select>
            <button onClick={sendChat} disabled={chatBusy} className="px-4 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white disabled:opacity-50">
              {chatBusy ? '规划中…' : '生成计划'}
            </button>
          </div>

          {preview && (
            <div className="rounded bg-black/30 border border-edge p-3 space-y-2">
              <div className="text-xs text-slate-400">📋 Plan Preview · {preview.taskId} · <span className={ST_COLOR(preview.status)}>{preview.status}</span></div>
              <div className="text-sm text-slate-200">{preview.plan.goal}</div>
              <div className="space-y-1">
                {preview.plan.steps.map((s, i) => (
                  <div key={s.id} className="flex items-center gap-2 text-xs">
                    <span className="text-slate-500 w-8">{i + 1}.</span>
                    <span className="flex-1 text-slate-300">{s.description}</span>
                    <span className={`${RISK_COLOR[s.risk] || ''} font-medium`}>{s.risk}</span>
                  </div>
                ))}
              </div>
              <button onClick={() => startTask(preview.taskId)} className="px-4 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-sm">▶ 批准执行</button>
            </div>
          )}
        </div>

        {/* Approval Center */}
        {selectedTask && taskDetail && taskDetail.status === 'PAUSED_FOR_HUMAN' && (
          <div className="rounded border border-amber-500/50 bg-amber-500/10 p-4 space-y-2">
            <div className="flex items-center gap-2 text-amber-300 font-medium">🙋 需要人工处理</div>
            <div className="text-sm text-slate-200">{pa ? (pa.reason + (pa.action ? `（动作: ${pa.action.type} ${pa.action.target ? (pa.action.target.semantic || pa.action.target.field || '') : ''}）` : '')) : taskDetail.error || '等待人工确认'}</div>
            <div className="flex gap-2">
              <button onClick={() => approveTask(selectedTask)} className="px-4 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-sm">Approve</button>
              <button onClick={() => modifyTask(selectedTask)} className="px-4 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white text-sm">Modify（放宽风险）</button>
              <button onClick={() => rejectTask(selectedTask)} className="px-4 py-1.5 rounded bg-rose-600 hover:bg-rose-500 text-white text-sm">Reject</button>
            </div>
          </div>
        )}

        {/* LLM Dashboard */}
        {stats && (
          <div className="rounded border border-edge bg-panel p-4">
            <div className="text-sm font-semibold text-slate-200 mb-2">📊 LLM 今日统计</div>
            <div className="grid grid-cols-4 gap-2 text-center text-xs">
              <div><div className="text-lg text-sky-400 font-semibold">{stats.today.calls}</div><div className="text-slate-500">Calls</div></div>
              <div><div className="text-lg text-sky-400 font-semibold">{stats.today.tokens.toLocaleString()}</div><div className="text-slate-500">Tokens</div></div>
              <div><div className="text-lg text-emerald-400 font-semibold">${stats.today.cost.toFixed(4)}</div><div className="text-slate-500">Cost</div></div>
              <div><div className="text-lg text-emerald-400 font-semibold">${stats.avgCost.toFixed(4)}</div><div className="text-slate-500">Avg/Task</div></div>
            </div>
          </div>
        )}
      </div>

      {/* 右列：任务列表 + Timeline + Snapshot */}
      <div className="space-y-4">
        <div className="rounded border border-edge bg-panel p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-slate-200">任务</span>
            <label className="flex items-center gap-1 text-xs text-slate-500"><input type="checkbox" checked={showDebug} onChange={(e) => setShowDebug(e.target.checked)} /> Debug</label>
          </div>
          <div className="space-y-2 max-h-56 overflow-auto">
            {tasks.map((t) => (
              <div key={t.id} className={`rounded border px-3 py-2 text-sm ${t.id === selectedTask ? 'border-sky-600' : 'border-edge'}`}>
                <button className="text-left w-full" onClick={() => setSelectedTask(t.id === selectedTask ? null : t.id)}>
                  <span className="font-medium text-slate-200">{t.name}</span>
                  <span className={`ml-2 text-xs ${ST_COLOR(t.status)}`}>{t.status}</span>
                  <span className="text-slate-500 text-xs ml-2">{t.executionMode}</span>
                </button>
                {t.error && <div className="text-xs text-rose-400 mt-1">{t.error}</div>}
                <div className="flex gap-2 mt-1.5">
                  {(t.status === 'PENDING' || t.status === 'PLANNING' || t.status === 'FAILED') && <button onClick={() => startTask(t.id)} className="px-2 py-0.5 rounded bg-emerald-600/80 text-white text-xs">Start</button>}
                  {t.status === 'RUNNING' && <button onClick={() => pauseTask(t.id)} className="px-2 py-0.5 rounded bg-amber-600/80 hover:bg-amber-500 text-white text-xs">Pause</button>}
                  {t.status === 'PAUSED_FOR_HUMAN' && <button onClick={() => retryTask(t.id)} className="px-2 py-0.5 rounded bg-sky-600/80 text-white text-xs">Retry</button>}
                  {['PENDING', 'PLANNING', 'RUNNING', 'PREPARING', 'PAUSED_FOR_HUMAN'].includes(t.status) && <button onClick={() => cancelTask(t.id)} className="px-2 py-0.5 rounded bg-rose-600/70 text-white text-xs">Cancel</button>}
                  {onViewDetail && <button onClick={() => onViewDetail(t.id)} className="px-2 py-0.5 rounded bg-edge hover:bg-slate-700 text-slate-200 text-xs">详情</button>}
                </div>
              </div>
            ))}
            {tasks.length === 0 && <div className="text-slate-500 text-xs">暂无任务。</div>}
          </div>
        </div>

        {selectedTask && (
          <>
            <div className="rounded border border-edge bg-panel p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-slate-200">⏱ Timeline · {selectedTask}</span>
                <button onClick={() => setSelectedTask(null)} className="text-xs text-slate-500 hover:text-white">关闭</button>
              </div>
              <div ref={timelineRef} className="max-h-64 overflow-auto space-y-1 text-xs font-mono">
                {timeline.map((e) => (
                  <div key={e.eventId} className="flex gap-2 text-slate-400">
                    <span className="text-slate-600 shrink-0">{new Date(e.timestamp).toLocaleTimeString()}</span>
                    <span className="shrink-0">{eventIcon(e.type)}</span>
                    <span className="text-sky-400 shrink-0">{e.type}</span>
                    <span className="truncate">{e.payload ? JSON.stringify(showDebug ? e.payload : {}) .slice(1, -1).slice(0, 120) : ''}</span>
                  </div>
                ))}
                {timeline.length === 0 && <div className="text-slate-600">暂无事件。</div>}
              </div>
            </div>

            <div className="rounded border border-edge bg-panel p-4">
              <div className="text-sm font-semibold text-slate-200 mb-2">📸 Snapshots（{snapshots.length}）</div>
              <div className="flex flex-wrap gap-2">
                {snapshots.slice(-8).map((s) => (
                  <button key={s.file} onClick={() => setSnapView(s)} className="text-xs text-slate-400 hover:text-white border border-edge rounded px-2 py-1">{s.file.replace(/_\d+\.png$/, '')}</button>
                ))}
                {snapshots.length === 0 && <div className="text-slate-500 text-xs">暂无快照（动作执行后产生）。</div>}
              </div>
              {snapView && (
                <div className="mt-2">
                  <img src={snapView.url} alt="snapshot" className="max-w-full rounded border border-edge" />
                  <button onClick={() => setSnapView(null)} className="text-xs text-slate-500 mt-1 hover:text-white">关闭</button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
