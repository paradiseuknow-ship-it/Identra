import React, { useEffect, useState, useRef } from 'react';
import api from '../api';
import { humanStatus, humanMode, statusTone, StatusDot, SectionTitle } from '../ui/kit';
import { IconAI, IconExternal, IconChevron } from '../ui/icons';

// AI Operator —— AI Worker 工作页（UI 高级化重构）
// 三区：Goal（给 AI 一个目标）/ Execution（执行态 + 实时画面入口 + 快照）/ AI Activity（人话时间线）。
// 强调 Execution 而非 Conversation：聊天感降级为一次性目标输入，执行过程以时间线呈现。
// 数据面与后端契约零改动：aiChat/aiStartTask/SSE timeline/任务 CRUD 全部复用既有链路。

const RISK_COLOR = { LOW: 'text-slate-600', MEDIUM: 'text-slate-400', HIGH: 'text-amber-400', CRITICAL: 'text-rose-400' };

/** 事件类型 → { label, dot }（第一层人话；AI 自修复 = teal 特色事件） */
function eventInfo(type) {
  if (type.startsWith('ai.thinking')) return { label: '思考中', dot: 'bg-slate-600' };
  if (type === 'ai.plan.created') return { label: '已生成计划', dot: 'bg-sky-400' };
  if (type.includes('action.started')) return { label: '执行动作', dot: 'bg-slate-300' };
  if (type.includes('action.completed')) return { label: '动作完成', dot: 'bg-emerald-400' };
  if (type.includes('verification.completed')) return { label: '验证结果', dot: 'bg-sky-400' };
  if (type.includes('snapshot')) return { label: '页面快照', dot: 'bg-slate-600' };
  if (type.includes('needApproval')) return { label: '需要你确认', dot: 'bg-amber-400' };
  if (type.includes('warning')) return { label: '注意', dot: 'bg-amber-400' };
  if (type.includes('failed')) return { label: '遇到问题', dot: 'bg-rose-400' };
  if (type.includes('retry') || type.includes('recovered') || type.includes('RECOVERY')) return { label: 'AI 已自动恢复，继续执行', dot: 'bg-teal-300' };
  if (type.includes('paused')) return { label: '已暂停', dot: 'bg-amber-400' };
  if (type === 'task.completed') return { label: '任务完成', dot: 'bg-emerald-400' };
  return { label: type, dot: 'bg-slate-600' };
}

export default function AiPanel({ profiles, notify, onViewDetail, onGoToSettings, onOpenBrowser, focusTaskId }) {
  const [tasks, setTasks] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [stats, setStats] = useState(null);
  const [health, setHealth] = useState(null);

  // Goal composer
  const [goal, setGoal] = useState('');
  const [chatProfile, setChatProfile] = useState('');
  const [chatMode, setChatMode] = useState('AUTONOMOUS');
  const [chatSession, setChatSession] = useState('');
  const [preview, setPreview] = useState(null); // { sessionId, taskId, plan, status }
  const [chatBusy, setChatBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);

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
  // New Task 创建成功跳转过来：直接聚焦该任务
  useEffect(() => { if (focusTaskId) setSelectedTask(focusTaskId); }, [focusTaskId]);
  useEffect(() => { if (timelineRef.current) timelineRef.current.scrollTop = timelineRef.current.scrollHeight; }, [timeline]);

  // SSE + 轮询任务详情/快照
  useEffect(() => {
    if (!selectedTask) { setTimeline([]); setSnapshots([]); setTaskDetail(null); return; }
    // C37：切换任务后丢弃旧任务飞行中的响应（否则旧任务数据落到新任务面板）
    let active = true;
    const es = new EventSource('/api/ai/tasks/' + selectedTask + '/events');
    es.onmessage = (ev) => { try { setTimeline((p) => [...p.slice(-100), JSON.parse(ev.data)]); } catch (e) {} };
    const poll = setInterval(async () => {
      if (!active) return;
      try { setTaskDetail(await api.aiGetTask(selectedTask)); } catch (e) {}
      if (!active) return;
      try { setSnapshots(await api.aiSnapshots(selectedTask)); } catch (e) {}
      if (!active) return;
      load();
    }, 2500);
    api.aiTaskEvents(selectedTask).then((v) => { if (active) setTimeline(v); }).catch(() => {});
    api.aiGetTask(selectedTask).then((v) => { if (active) setTaskDetail(v); }).catch(() => {});
    api.aiSnapshots(selectedTask).then((v) => { if (active) setSnapshots(v); }).catch(() => {});
    return () => { active = false; es.close(); clearInterval(poll); };
  }, [selectedTask]);

  // Goal 发送：创建 Session + Task + Plan Preview（与旧 /chat 链路一致）
  const sendChat = async () => {
    if (!goal.trim()) { notify('请输入目标', false); return; }
    setChatBusy(true);
    try {
      const r = await api.aiChat({ message: goal, sessionId: chatSession || undefined, profileId: chatProfile || undefined, executionMode: chatMode });
      setPreview(r);
      setSelectedTask(r.taskId);
      setChatSession(r.sessionId);
      load();
      notify('计划已生成，确认后开始执行');
    } catch (e) { notify(e.message, false); }
    finally { setChatBusy(false); }
  };

  const startTask = async (id) => { try { await api.aiStartTask(id); notify('已开始执行'); load(); } catch (e) { notify(e.message, false); } };
  const pauseTask = async (id) => { try { await api.aiPauseTask(id); notify('已暂停'); load(); } catch (e) { notify(e.message, false); } };
  const cancelTask = async (id) => { try { await api.aiCancelTask(id); notify('已取消'); load(); } catch (e) { notify(e.message, false); } };
  const retryTask = async (id) => { try { await api.aiRetryTask(id); notify('已重试'); load(); } catch (e) { notify(e.message, false); } };
  const resumeTask = async (id) => { try { await api.aiResumeTask(id); notify('已从暂停点恢复'); load(); } catch (e) { notify(e.message, false); } }; // C37
  const approveTask = async (id) => { try { await api.aiApprove(id); notify('已批准执行'); load(); } catch (e) { notify(e.message, false); } };
  const rejectTask = async (id) => { try { await api.aiReject(id); notify('已拒绝'); load(); } catch (e) { notify(e.message, false); } };
  const modifyTask = async (id) => { try { await api.aiModify(id, { policy: { riskFloor: 'HIGH' } }); notify('已放宽风险级并恢复'); load(); } catch (e) { notify(e.message, false); } };

  const pa = taskDetail && taskDetail.pendingApproval;
  const runningProfile = taskDetail && taskDetail.profileId;
  const isLive = taskDetail && ['RUNNING', 'HEALING', 'RECOVERING', 'BROWSER_READY', 'PREPARING'].includes(taskDetail.status);

  return (
    <div className="fade-up space-y-5">
      {/* mock 模式引导横幅（C16）—— key 缺失时明确告知 + 一键跳转系统设置 */}
      {health && health.provider === 'mock' && (
        <div className="card border-amber-500/40 px-4 py-3 flex items-center justify-between gap-3">
          <span className="text-xs text-amber-300">AI 当前为 <b>演练模式</b>（未配置 LLM API key）——任务只会产生模拟计划，不会真正执行。</span>
          {onGoToSettings && (
            <button onClick={onGoToSettings} className="btn btn-outline text-xs border-amber-500/40 text-amber-300 whitespace-nowrap">前往设置 →</button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[340px_minmax(0,1fr)_280px] gap-5">
        {/* —— 左栏：Task（Goal composer + Plan + Approval）—— */}
        <div className="space-y-5">
          {/* C96：当前任务目标卡 —— 从 New Task / 队列跳转进来时，目标与状态常驻可见，
              消除「输入的内容丢了」感知（实录：用户跳转后只看到空输入框）。 */}
          {selectedTask && taskDetail && (
            <div className="card p-4 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] tracking-widest text-slate-500 uppercase">当前任务</span>
                <span className="text-[11px] text-slate-500 inline-flex items-center gap-1.5">
                  <StatusDot tone={statusTone(taskDetail.status)} live={isLive} />
                  {humanStatus(taskDetail.status)}
                </span>
              </div>
              <div className="text-sm text-slate-200 leading-snug">{taskDetail.objective || taskDetail.name}</div>
              {taskDetail.targetUrl && <div className="text-xs text-slate-500 truncate" title={taskDetail.targetUrl}>{taskDetail.targetUrl}</div>}
            </div>
          )}
          <div className="card p-5 space-y-3.5">
            <div>
              <div className="text-sm font-medium text-slate-100 inline-flex items-center gap-2"><span className="text-accent"><IconAI /></span>给 AI 一个目标</div>
              <div className="text-xs text-slate-500 mt-1">描述你要完成的事，AI 规划并执行，全程留痕。</div>
            </div>
            <textarea className="inp min-h-[88px] resize-y" value={goal} onChange={(e) => setGoal(e.target.value)}
              placeholder="例如：打开 xxx.com，注册一个新账号并登录" />
            <button onClick={() => setAdvanced(!advanced)} className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300">
              <span style={{ display: 'inline-flex', transform: advanced ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}><IconChevron size={12} /></span>
              高级选项
            </button>
            {advanced && (
              <div className="space-y-3 rounded-lg border border-edge p-3.5">
                <select className="inp" value={chatProfile} onChange={(e) => setChatProfile(e.target.value)}>
                  <option value="">自动选择浏览器环境</option>
                  {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <select className="inp" value={chatMode} onChange={(e) => setChatMode(e.target.value)}>
                  <option value="AUTONOMOUS">自主模式 — AI 全程执行，高风险才询问</option>
                  <option value="ASSIST">协助模式 — 每步确认</option>
                  <option value="SIMULATION">演练模式 — 只规划不执行</option>
                  <option value="DEBUG">调试模式</option>
                </select>
              </div>
            )}
            <button onClick={sendChat} disabled={chatBusy || !goal.trim()} className="btn btn-primary w-full">
              {chatBusy ? '正在规划…' : '生成计划'}
            </button>
          </div>

          {preview && (
            <div className="card p-5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">执行计划 · {humanStatus(preview.status)}</span>
                {preview.taskId === selectedTask && <span className="text-[10px] text-slate-600">已选中</span>}
              </div>
              <div className="text-sm text-slate-200">{preview.plan?.goal}</div>
              <div className="space-y-1.5">
                {(preview.plan?.steps || []).map((s, i) => (
                  <div key={s.id} className="flex items-start gap-2 text-xs">
                    <span className="w-5 h-5 rounded-full border border-edge text-slate-500 flex items-center justify-center shrink-0 tabular-nums">{i + 1}</span>
                    <span className="flex-1 text-slate-300">{s.description}</span>
                    <span className={`${RISK_COLOR[s.risk] || ''} font-medium shrink-0`}>{s.risk}</span>
                  </div>
                ))}
              </div>
              <button onClick={() => startTask(preview.taskId)} className="btn btn-primary w-full">开始执行</button>
            </div>
          )}

          {/* Approval Center —— 需要人工处理时最显眼位置 */}
          {selectedTask && taskDetail && taskDetail.status === 'PAUSED_FOR_HUMAN' && (
            <div className="card border-amber-500/50 p-5 space-y-3">
              <div className="flex items-center gap-2 text-amber-400 text-sm font-medium">
                <StatusDot tone={{ dot: 'bg-amber-400' }} live /> 需要你确认
              </div>
              <div className="text-sm text-slate-200">{pa ? (pa.reason + (pa.action ? `（动作: ${pa.action.type} ${pa.action.target ? (pa.action.target.semantic || pa.action.target.field || '') : ''}）` : '')) : taskDetail.error || '等待人工确认'}</div>
              <div className="flex gap-2">
                <button onClick={() => approveTask(selectedTask)} className="btn btn-primary text-xs flex-1">批准</button>
                <button onClick={() => modifyTask(selectedTask)} className="btn btn-outline text-xs" title="放宽风险级并恢复">放宽风险</button>
                <button onClick={() => rejectTask(selectedTask)} className="btn btn-ghost text-xs hover:text-rose-300">拒绝</button>
              </div>
            </div>
          )}

          {stats && (
            <div className="card p-5">
              <SectionTitle>AI 用量（今日）</SectionTitle>
              <div className="grid grid-cols-4 gap-2 text-center text-xs">
                <div><div className="text-base text-slate-100 font-semibold tabular-nums">{stats.today.calls}</div><div className="text-slate-500">调用</div></div>
                <div><div className="text-base text-slate-100 font-semibold tabular-nums">{stats.today.tokens.toLocaleString()}</div><div className="text-slate-500">Tokens</div></div>
                <div><div className="text-base text-slate-100 font-semibold tabular-nums">${stats.today.cost.toFixed(4)}</div><div className="text-slate-500">成本</div></div>
                <div><div className="text-base text-slate-100 font-semibold tabular-nums">${stats.avgCost.toFixed(4)}</div><div className="text-slate-500">均值</div></div>
              </div>
            </div>
          )}
        </div>

        {/* —— 中栏：Execution（执行态 + 时间线 + 快照）—— */}
        <div className="space-y-5 min-w-0">
          {!selectedTask ? (
            <div className="card flex flex-col items-center justify-center text-center px-6 py-20">
              <span className="text-accent"><IconAI size={28} /></span>
              <div className="text-sm text-slate-300 mt-3">还没有选中执行</div>
              <div className="text-xs text-slate-500 mt-1.5 max-w-sm">从右侧选择一个任务，或在左侧给 AI 一个新目标。执行过程中的每一步都会出现在这里。</div>
            </div>
          ) : (
            <>
              {/* 执行态卡：状态 + 动作 + 实时画面入口 */}
              <div className="card p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2.5">
                      <TaskStatusBadge status={taskDetail ? taskDetail.status : undefined} fallbackId={selectedTask} />
                    </div>
                    {taskDetail && taskDetail.error && <div className="text-xs text-rose-400 mt-1.5">{taskDetail.error}</div>}
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    {runningProfile && (
                      <button onClick={() => onOpenBrowser && onOpenBrowser(runningProfile)} className="btn btn-outline text-xs">
                        实时画面 <IconExternal size={12} />
                      </button>
                    )}
                    <button onClick={() => setSelectedTask(null)} className="btn btn-ghost text-xs">关闭</button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {taskDetail && (taskDetail.status === 'PENDING' || taskDetail.status === 'PLANNING' || taskDetail.status === 'FAILED') && (
                    <button onClick={() => startTask(taskDetail.id)} className="btn btn-primary text-xs">开始执行</button>
                  )}
                  {taskDetail && taskDetail.status === 'RUNNING' && <button onClick={() => pauseTask(taskDetail.id)} className="btn btn-outline text-xs">暂停</button>}
                  {taskDetail && taskDetail.status === 'PAUSED_FOR_HUMAN' && <button onClick={() => resumeTask(taskDetail.id)} className="btn btn-primary text-xs" title="从暂停点继续执行（不重新规划）">继续执行</button>}
                  {taskDetail && taskDetail.status === 'PAUSED_FOR_HUMAN' && <button onClick={() => retryTask(taskDetail.id)} className="btn btn-outline text-xs" title="放弃当前进度重新规划执行">重新规划</button>}
                  {taskDetail && ['PENDING', 'PLANNING', 'RUNNING', 'PREPARING', 'PAUSED_FOR_HUMAN'].includes(taskDetail.status) && (
                    <button onClick={() => cancelTask(taskDetail.id)} className="btn btn-ghost text-xs hover:text-rose-300">取消</button>
                  )}
                  {onViewDetail && taskDetail && <button onClick={() => onViewDetail(taskDetail.id)} className="btn btn-ghost text-xs text-slate-500">工程详情 →</button>}
                </div>
              </div>

              {/* AI Activity 时间线：人话 + 恢复事件特色化 */}
              <div className="card p-5">
                <SectionTitle action={(
                  <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
                    <input type="checkbox" checked={showDebug} onChange={(e) => setShowDebug(e.target.checked)} /> 原始事件
                  </label>
                )}>AI Activity</SectionTitle>
                <div ref={timelineRef} className="max-h-[420px] overflow-auto space-y-0.5">
                  {timeline.map((e) => {
                    const info = eventInfo(e.type);
                    const recovery = info.label.startsWith('AI 已自动恢复');
                    return (
                      <div key={e.eventId} className="flex items-baseline gap-2.5 text-xs rounded px-1.5 py-1 hover:bg-white/[0.03]">
                        <span className="text-slate-600 shrink-0 tabular-nums">{new Date(e.timestamp).toLocaleTimeString()}</span>
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 self-center ${info.dot}`} />
                        <span className={`shrink-0 ${recovery ? 'text-teal-300 font-medium' : 'text-slate-300'}`}>{info.label}</span>
                        {showDebug && <span className="text-slate-600 truncate">{e.type} {e.payload ? JSON.stringify(e.payload).slice(0, 120) : ''}</span>}
                      </div>
                    );
                  })}
                  {timeline.length === 0 && <div className="text-slate-600 text-xs py-4 text-center">暂无事件。任务开始执行后，这里会实时滚动 AI 的动作。</div>}
                </div>
              </div>

              {/* 快照条 */}
              <div className="card p-5">
                <SectionTitle>页面快照（{snapshots.length}）</SectionTitle>
                <div className="flex flex-wrap gap-2">
                  {snapshots.slice(-8).map((s) => (
                    <button key={s.file} onClick={() => setSnapView(s)} className="text-xs text-slate-400 hover:text-white border border-edge rounded-md px-2 py-1 hover:border-slate-600 transition-colors">{s.file.replace(/_\d+\.png$/, '')}</button>
                  ))}
                  {snapshots.length === 0 && <div className="text-slate-600 text-xs">暂无快照（动作执行后自动生成）。</div>}
                </div>
                {snapView && (
                  <div className="mt-3">
                    <img src={snapView.url} alt="snapshot" className="max-w-full rounded-lg border border-edge" />
                    <button onClick={() => setSnapView(null)} className="text-xs text-slate-500 mt-1.5 hover:text-white">收起</button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* —— 右栏：执行队列 —— */}
        <div className="space-y-2.5">
          <div className="px-1 flex items-center justify-between">
            <h3 className="text-[13px] font-medium text-slate-300">任务队列</h3>
            <span className="text-xs text-slate-600 tabular-nums">{tasks.length}</span>
          </div>
          {tasks.map((t) => {
            const tone = statusTone(t.status);
            return (
              <button key={t.id} onClick={() => setSelectedTask(t.id === selectedTask ? null : t.id)}
                className={`w-full text-left card card-hover p-3 ${t.id === selectedTask ? 'border-slate-500/70' : ''}`}>
                <div className="text-[13px] text-slate-200 truncate">{t.name}</div>
                <div className="flex items-center gap-2 mt-1.5 text-xs">
                  <span className={`inline-flex items-center gap-1.5 ${tone.text}`}>
                    <StatusDot tone={tone} live={tone.live} />{humanStatus(t.status)}
                  </span>
                  <span className="text-slate-600">{humanMode(t.executionMode)}</span>
                  {t.scheduleId && <span className="ml-auto text-[10px] text-slate-500 border border-edge rounded px-1 py-px" title="来自定时调度">定时</span>}
                </div>
                {t.error && <div className="text-xs text-rose-400/90 mt-1.5 truncate">{t.error}</div>}
              </button>
            );
          })}
          {tasks.length === 0 && <div className="text-xs text-slate-600 px-1 py-3">暂无任务。在左侧给 AI 第一个目标。</div>}
        </div>
      </div>
    </div>
  );
}

function TaskStatusBadge({ status, fallbackId }) {
  const s = status || 'PENDING';
  const tone = statusTone(s);
  return (
    <span className={`pill ${tone.bg || ''} ${tone.text} text-xs`}>
      <StatusDot tone={tone} live={tone.live} />
      {humanStatus(s)}
    </span>
  );
}
