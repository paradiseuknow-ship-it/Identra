import React, { useEffect, useState, useCallback } from 'react';
import api, { getAuthToken, setAuthToken } from './api';
import { toastBus } from './lib/toastBus.mjs';
import { useEscapeClose } from './lib/useEscapeClose.mjs';
import ProfileEditor from './components/ProfileEditor';
import ProxyPanel from './components/ProxyPanel';
import TaskPanel from './components/TaskPanel';
import BrowserViewer from './components/BrowserViewer';
import AiPanel from './components/AiPanel';
import ObservabilityPanel from './components/ObservabilityPanel';
import TemplatesPanel from './components/TemplatesPanel';
import SettingsPanel from './components/SettingsPanel';
import SchedulesPanel from './components/SchedulesPanel';
import ExecutionPanel from './components/ExecutionPanel';
import IntelligencePanel from './components/IntelligencePanel';
import ErrorBoundary from './components/ErrorBoundary';
import ToastHost from './components/ToastHost';
import GovernancePanel from './components/GovernancePanel';
import ReadinessPanel from './components/ReadinessPanel';
import AuthGate from './components/AuthGate';
import TaskDetail from './components/TaskDetail';
import OverviewPage from './components/OverviewPage';
import NewTaskModal from './components/NewTaskModal';
import { IconLogo, IconOverview, IconTasks, IconRuns, IconWindow, IconAI, IconClock, IconLayers, IconPulse, IconMemory, IconGlobe, IconShield, IconSettings, IconPlus } from './ui/icons';

// —— 导航信息架构（UI 高级化重构）——
// 四分组：WORKSPACE / AUTOMATION / INSIGHTS / SYSTEM。
// tab key 全部保持与后端无关的历史 key（panels 数据面零改动）；
// readiness 不进导航 —— 降级为 Workspace Health，从顶栏健康 pill 与 SETUP_REQUIRED 自动引导进入。
const NAV = [
  {
    group: 'Workspace', items: [
      ['overview', 'Overview', <IconOverview />],
      ['tasks', 'Tasks', <IconTasks />],
      ['execution', 'Runs', <IconRuns />],
      ['profiles', 'Browser Profiles', <IconWindow />],
    ],
  },
  {
    group: 'Automation', items: [
      ['ai', 'AI Operator', <IconAI />],
      ['schedules', 'Schedules', <IconClock />],
      ['templates', 'Templates', <IconLayers />],
    ],
  },
  {
    group: 'Insights', items: [
      ['observability', 'Activity', <IconPulse />],
      ['intelligence', 'Memory', <IconMemory />],
    ],
  },
  {
    group: 'System', items: [
      ['proxies', 'Proxies', <IconGlobe />],
      ['governance', 'Governance', <IconShield />],
      ['settings', 'Settings', <IconSettings />],
    ],
  },
];

// 顶栏页标题（第一层：普通用户语言）
const TITLES = {
  overview: ['Overview', '你的 AI 工作台全局视图'],
  tasks: ['Tasks', '自动化任务管理'],
  execution: ['Runs', '执行队列与运行记录'],
  profiles: ['Browser Profiles', '浏览器环境与指纹配置'],
  ai: ['AI Operator', '给 AI 一个目标，它来执行'],
  schedules: ['Schedules', '定时自动执行'],
  templates: ['Templates', '指纹模板库'],
  observability: ['Activity', '执行轨迹与事件流'],
  intelligence: ['Memory', '站点画像与经验记忆'],
  proxies: ['Proxies', '代理资源接入'],
  governance: ['Governance', '密钥、审计与协作'],
  settings: ['Settings', '系统配置'],
  readiness: ['Workspace Health', '环境自检与配置引导'],
};

export default function App() {
  const [tab, setTab] = useState('overview');
  const [profiles, setProfiles] = useState([]);
  const [proxies, setProxies] = useState([]);
  const [editing, setEditing] = useState(null); // profile object or 'new'
  const [runLog, setRunLog] = useState([]);
  const [viewingId, setViewingId] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [confirmState, setConfirmState] = useState(null); // { message, onConfirm, ok }
  const [readiness, setReadiness] = useState(null); // C30 就绪度快照（header 徽标用）
  const [needAuth, setNeedAuth] = useState(false); // C49：多用户模式 401 → 全屏登录门控
  const [hasSession, setHasSession] = useState(!!getAuthToken()); // C49：header 退出登录按钮显隐
  const [authTick, setAuthTick] = useState(0); // C49：登录成功后重跑启动探测（readiness + 列表）
  const [newTaskOpen, setNewTaskOpen] = useState(false); // Goal-first 创建流
  const [focusTaskId, setFocusTaskId] = useState(null); // New Task 成功后跳转 AI Operator 并选中该任务

  // 应用内确认弹窗，替代原生 window.confirm（原生框在某些环境下会被静默拦截导致“点击无反应”）
  // C74：第三参 okLabel —— 非删除类破坏性操作（如撤销 API Key）可自定义确认按钮文案，
  //      不再被硬编码的「确认删除」误导；默认保持「确认删除」（现有调用点均为删除语义）。
  const requestConfirm = (message, onConfirm, okLabel) => setConfirmState({ message, onConfirm, okLabel });
  useEscapeClose(!!confirmState, () => setConfirmState(null)); // C43：Esc 关确认弹窗（取消语义，不触发确认）
  const runConfirm = () => {
    const { onConfirm } = confirmState || {};
    setConfirmState(null);
    if (onConfirm) onConfirm();
  };

  // C41：notify 转发到 ToastHost 总线（签名不变，调用方零改动）。
  const notify = (msg, ok = true) => toastBus.emit(msg, ok);

  const loadProfiles = useCallback(async () => {
    try { setProfiles(await api.listProfiles()); } catch (e) { notify(e.message, false); }
  }, []);

  const loadProxies = useCallback(async () => {
    try { setProxies(await api.listProxies()); } catch (e) { notify(e.message, false); }
  }, []);

  useEffect(() => { loadProfiles(); loadProxies(); }, [loadProfiles, loadProxies]);

  // C30：启动即跑就绪度自检——必需项缺失时自动落到引导页（不再让用户自己猜缺什么）
  // C49：探测 401（多用户模式未登录/会话过期）→ 全屏登录门控；本地单机模式永远 200 不触发。
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api.systemReadiness();
        if (!alive) return;
        setReadiness(r);
        if (r && r.stage === 'SETUP_REQUIRED') setTab('readiness');
      } catch (e) {
        if (alive && e && e.status === 401) setNeedAuth(true);
        /* 其余自检失败不阻断主流程 */
      }
    })();
    return () => { alive = false; };
  }, [authTick]);

  // C49：登录/注册成功回调——交还控制权并重跑启动加载链
  const handleAuthed = useCallback(() => {
    setNeedAuth(false);
    setHasSession(true);
    setAuthTick((t) => t + 1);
    loadProfiles();
    loadProxies();
  }, [loadProfiles, loadProxies]);

  // C49：退出登录（仅会话模式可见；本地单机无 token 不渲染）
  const doLogout = async () => {
    try { await api.logout(); } catch (e) { /* 会话已失效也照常清本地凭据 */ }
    setAuthToken('');
    setHasSession(false);
    setNeedAuth(true);
  };

  // C20：运行态快照轮询（仅 profiles tab 活跃时，5s 一拍；失败静默——运行态是增强不是关键路径）
  const [runtime, setRuntime] = useState({});
  useEffect(() => {
    if (tab !== 'profiles') return undefined;
    let alive = true;
    const tick = async () => {
      try {
        const r = await api.profileRuntime();
        if (!alive) return;
        const m = {};
        (r.profiles || []).forEach((s) => { m[s.profileId] = s; });
        setRuntime(m);
      } catch (e) { /* 静默 */ }
    };
    tick();
    const h = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(h); };
  }, [tab]);

  const launch = async (id) => {
    try { await api.launch(id); notify('已启动'); await loadProfiles(); }
    catch (e) { notify(e.message, false); }
  };
  const stop = async (id) => {
    try { await api.stop(id); notify('已停止'); await loadProfiles(); }
    catch (e) { notify(e.message, false); }
  };
  // C74：duplicate 补 try/catch（C70 D3 同族）——复制失败此前是 unhandled rejection，
  //      用户零反馈、列表不刷新；对齐 launch/stop 的错误处理口径。
  const duplicate = async (id) => {
    try { await api.duplicateProfile(id); await loadProfiles(); notify('已复制'); }
    catch (e) { notify(e.message, false); }
  };
  const remove = (id) => {
    requestConfirm('确认删除该配置？删除后无法恢复。', async () => {
      try {
        await api.deleteProfile(id); await loadProfiles(); notify('已删除');
      } catch (e) { notify(e.message, false); }
    });
  };

  const exportCookies = async (id) => {
    try {
      const cookies = await api.exportCookies(id);
      const blob = new Blob([JSON.stringify(cookies, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `cookies-${id}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      notify(`已导出 ${cookies.length} 条 Cookie`);
    } catch (e) { notify(e.message, false); }
  };

  const [batch, setBatch] = useState(null); // { count, namePrefix } | null
  const [batching, setBatching] = useState(false);

  const runBatch = async () => {
    const count = Number(batch.count);
    if (!Number.isInteger(count) || count < 1 || count > 50) return notify('count 必须是 1-50 的整数', false);
    setBatching(true);
    try {
      const r = await api.batchCreateProfiles({ count, namePrefix: batch.namePrefix || '批量配置' });
      notify(`批量建号完成: 成功 ${r.created ? r.created.length : 0} / 失败 ${r.errors ? r.errors.length : 0}`);
      setBatch(null);
      await loadProfiles();
    } catch (e) { notify(e.message, false); }
    finally { setBatching(false); }
  };

  const addNew = () => setEditing({ name: '', group: 'default', headless: false, proxyMode: 'inline', proxyId: null, fingerprintOverride: {} });

  const rotate = async (id) => {
    try {
      const r = await api.rotateProfileProxy(id);
      if (r.rotated) notify(`已换线: ${r.from || '无'} → ${r.to && r.to.name}`);
      else notify(`无需换线: ${r.reason || '当前代理健康'}`);
      await loadProfiles();
    } catch (e) { notify(e.message, false); }
  };

  const exportProfiles = async () => {
    try {
      const data = await api.exportProfiles();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `profiles-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      notify('已导出（凭据不在导出文件内）');
    } catch (e) { notify(e.message, false); }
  };

  const importProfiles = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const items = Array.isArray(parsed) ? parsed : parsed.profiles;
        if (!Array.isArray(items)) throw new Error('文件格式不正确（需要 profiles 数组）');
        const r = await api.importProfiles({ profiles: items });
        notify(`导入完成: 成功 ${r.imported ? r.imported.length : 0} / 失败 ${r.errors ? r.errors.length : 0}`);
        await loadProfiles();
      } catch (e) { notify(e.message, false); }
    };
    input.click();
  };

  const onSaved = () => { setEditing(null); loadProfiles(); };

  // New Task 创建成功：关弹窗 → 进 AI Operator 并聚焦新任务
  const onTaskCreated = (taskId) => {
    setNewTaskOpen(false);
    setFocusTaskId(taskId);
    setTab('ai');
  };

  // C49：多用户模式登录门控全屏接管（放在所有 hook 之后，条件返回合法）
  if (needAuth) return <AuthGate onAuthed={handleAuthed} />;

  const [title, desc] = TITLES[tab] || [tab, ''];
  const failedChecks = readiness && !readiness.ok
    ? readiness.checks.filter((c) => !c.ok && !c.optional).length : 0;

  return (
    <div className="min-h-screen flex bg-ink">
      {/* —— 侧栏 220px：分组导航，空间产生层级 —— */}
      <aside className="w-[220px] shrink-0 h-screen sticky top-0 flex flex-col border-r border-edge/70 bg-[#0D0E13] px-3 pb-4 overflow-y-auto">
        <div className="flex items-center gap-2.5 px-2.5 pt-4 pb-1">
          <IconLogo />
          <div>
            <div className="text-sm font-semibold text-slate-100 leading-tight">Identra</div>
            <div className="text-[10px] text-slate-600">AI Browser Workspace</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5">
          {NAV.map((g) => (
            <div key={g.group}>
              <div className="navgroup">{g.group}</div>
              {g.items.map(([k, label, icon]) => (
                <button key={k} onClick={() => setTab(k)}
                  className={`navitem ${tab === k ? 'navitem-active' : ''}`}>
                  <span className="text-slate-500 shrink-0 [&>svg]:block">{icon}</span>
                  {label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="px-2.5 pt-3 text-[10px] text-slate-700 border-t border-edge/50 mt-3">
          Generic AI Browser Operator
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col min-h-screen">
        {/* —— 顶栏：页标题 + Workspace Health pill + New Task + 会话 —— */}
        <header className="h-14 shrink-0 flex items-center gap-3 px-8 border-b border-edge/70 bg-ink/80 backdrop-blur sticky top-0 z-30">
          <div className="min-w-0">
            <span className="text-sm font-medium text-slate-200">{title}</span>
            <span className="text-xs text-slate-600 ml-2.5 hidden md:inline">{desc}</span>
          </div>
          <div className="ml-auto flex items-center gap-2.5">
            {readiness && (
              <button onClick={() => setTab('readiness')}
                title={failedChecks ? `点击查看：${readiness.checks.filter((c) => !c.ok && !c.optional).map((c) => c.label).join('、')}` : '全部必需项就绪'}
                className={`pill ${readiness.ok ? 'text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/15' : 'text-amber-400 bg-amber-500/10 hover:bg-amber-500/15'} transition-colors`}>
                <span className={`w-1.5 h-1.5 rounded-full ${readiness.ok ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                {readiness.ok ? 'All systems operational' : `${failedChecks} 项需要配置`}
              </button>
            )}
            <button onClick={() => setNewTaskOpen(true)} className="btn btn-primary px-3.5 py-1.5 text-[13px]">
              <IconPlus size={13} /> New Task
            </button>
            {hasSession && (
              <button onClick={doLogout} title="结束当前会话并返回登录页"
                className="btn btn-ghost text-xs">退出</button>
            )}
          </div>
        </header>

        {/* —— 内容区：max-w 1400 + 40–64px 页边距 —— */}
        <main className="flex-1 overflow-auto">
          <div className="max-w-page mx-auto px-10 py-8">
            <ErrorBoundary key={tab} name={tab}>
              {tab === 'overview' && (
                <OverviewPage
                  profiles={profiles}
                  readiness={readiness}
                  onNewTask={() => setNewTaskOpen(true)}
                  onNavigate={setTab}
                />
              )}
              {tab === 'profiles' && (
                <ProfilesTab
                  profiles={profiles} proxies={proxies} runtime={runtime}
                  onAdd={addNew} onEdit={setEditing} onLaunch={launch} onStop={stop}
                  onDuplicate={duplicate} onRemove={remove} onView={setViewingId}
                  onRotate={rotate} onExport={exportProfiles} onImport={importProfiles}
                  onExportCookies={exportCookies}
                  notify={notify} onBatch={() => setBatch({ count: 5, namePrefix: '批量配置' })}
                />
              )}
              {tab === 'templates' && <TemplatesPanel notify={notify} requestConfirm={requestConfirm} />}
              {tab === 'proxies' && <ProxyPanel proxies={proxies} onChange={loadProxies} notify={notify} requestConfirm={requestConfirm} />}
              {tab === 'tasks' && <TaskPanel profiles={profiles} notify={notify} onLog={setRunLog} requestConfirm={requestConfirm} />}
              {tab === 'ai' && (
                <AiPanel
                  profiles={profiles} notify={notify}
                  onViewDetail={setDetailId}
                  onGoToSettings={() => setTab('settings')}
                  onOpenBrowser={setViewingId}
                  focusTaskId={focusTaskId}
                />
              )}
              {tab === 'schedules' && <SchedulesPanel profiles={profiles} notify={notify} requestConfirm={requestConfirm} onViewDetail={setDetailId} />}
              {tab === 'execution' && <ExecutionPanel notify={notify} />}
              {tab === 'intelligence' && <IntelligencePanel notify={notify} />}
              {tab === 'readiness' && <ReadinessPanel notify={notify} onNavigate={setTab} onRefresh={setReadiness} />}
              {tab === 'governance' && <GovernancePanel notify={notify} requestConfirm={requestConfirm} />}
              {tab === 'observability' && <ObservabilityPanel onViewDetail={setDetailId} />}
            </ErrorBoundary>
          </div>
        </main>
      </div>

      {editing && (
        <ProfileEditor
          profile={editing}
          proxies={proxies}
          onClose={() => setEditing(null)}
          onSaved={onSaved}
          notify={notify}
        />
      )}

      {viewingId && (
        <BrowserViewer profileId={viewingId} onClose={() => setViewingId(null)} />
      )}

      {detailId && (
        <TaskDetail taskId={detailId} onClose={() => setDetailId(null)} />
      )}

      {newTaskOpen && (
        <NewTaskModal
          profiles={profiles}
          notify={notify}
          onClose={() => setNewTaskOpen(false)}
          onCreated={onTaskCreated}
        />
      )}

      <ToastHost />
      {/* C74：批量建号弹窗从 ProfilesTab 移回 App —— batch/batching/setBatch/runBatch/loadProfiles
          全部是 App 作用域，ProfilesTab 从未收到这些标识符 → 弹窗块渲染即 ReferenceError
          （配置管理 tab 整页被 C40 ErrorBoundary 掩成错误卡，SSR 探针实录 batch is not defined）。
          「批量」按钮经既有 onBatch prop 打开，状态所有权与渲染位置对齐。 */}
      {batch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => !batching && setBatch(null)}>
          <div className="w-96 card p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="font-medium mb-4 text-slate-100">批量创建 Profiles</div>
            <div className="space-y-3 text-sm">
              <label className="block">
                <span className="label">数量（1-50）</span>
                <input type="number" min="1" max="50" className="inp w-full" value={batch.count}
                  onChange={(e) => setBatch({ ...batch, count: e.target.value })} />
              </label>
              <label className="block">
                <span className="label">名称前缀</span>
                <input className="inp w-full" value={batch.namePrefix}
                  onChange={(e) => setBatch({ ...batch, namePrefix: e.target.value })} />
              </label>
              <div className="text-xs text-slate-500">稳定字段共享基线，噪声字段每号独立派生（「同形不同样」）。</div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setBatch(null)} disabled={batching} className="btn btn-outline">取消</button>
              <button onClick={runBatch} disabled={batching} className="btn btn-primary">
                {batching ? '创建中…' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmState && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-80 card p-5 shadow-2xl">
            <div className="text-sm text-slate-200 mb-5">{confirmState.message}</div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmState(null)} className="btn btn-outline">取消</button>
              <button onClick={runConfirm} className="btn btn-danger">{confirmState.okLabel || '确认删除'}</button>
            </div>
          </div>
        </div>
      )}
      {runLog.length > 0 && (
        <div className="fixed bottom-5 left-5 max-w-md max-h-60 overflow-auto bg-black/80 border border-edge rounded p-3 text-xs font-mono text-green-300">
          {runLog.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
    </div>
  );
}

// C74：具名导出 ProfilesTab —— 守护测试（test_c74）SSR 探针需零浏览器渲染运行中配置态；
// 对 Vite 构建零影响（default 导出 App 不变）。
// UI 重构：Browser Profiles 成为清晰核心资源 —— 分组卡 + 运行态前置 + 指纹细节收敛到一行摘要。
export function ProfilesTab({ profiles, proxies, runtime, onAdd, onEdit, onLaunch, onStop, onDuplicate, onRemove, onView, onRotate, onExport, onImport, onExportCookies, onBatch, notify }) {
  const [integrity, setIntegrity] = useState(null); // { id, report } | null
  const [checkingId, setCheckingId] = useState(null);

  const fmtUptime = (ms) => {
    if (!ms || ms < 0) return '0s';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm' + (s % 60) + 's';
    const h = Math.floor(m / 60);
    return h + 'h' + (m % 60) + 'm';
  };

  const runIntegrity = async (p) => {
    setCheckingId(p.id);
    try {
      const report = await api.profileIntegrity(p.id);
      setIntegrity({ id: p.id, name: p.name, report });
    } catch (e) { notify(e.message, false); }
    finally { setCheckingId(null); }
  };

  const groups = profiles.reduce((acc, p) => {
    const g = p.group || 'default';
    (acc[g] = acc[g] || []).push(p);
    return acc;
  }, {});

  return (
    <div className="fade-up">
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-lg font-semibold text-slate-100">全部环境（{profiles.length}）</h2>
        <div className="flex gap-2">
          <button onClick={onImport} className="btn btn-outline text-xs">导入</button>
          <button onClick={onExport} className="btn btn-outline text-xs">导出</button>
          <button onClick={onBatch} className="btn btn-outline text-xs" title="同模板基线 + 每号独立 seed（同形不同样）">批量创建</button>
          <button onClick={onAdd} className="btn btn-primary text-xs">+ 新建 Profile</button>
        </div>
      </div>

      {profiles.length === 0 && (
        <div className="card flex flex-col items-center text-center px-6 py-14">
          <div className="text-sm text-slate-300">还没有 Browser Profile</div>
          <div className="text-xs text-slate-500 mt-1.5 max-w-sm">Profile 是 AI 工作的浏览器环境：指纹、代理、Cookie 都由它承载。创建一个，或批量生成一组。</div>
          <div className="mt-4 flex gap-2">
            <button onClick={onAdd} className="btn btn-primary text-xs">新建 Profile</button>
            <button onClick={onBatch} className="btn btn-outline text-xs">批量创建</button>
          </div>
        </div>
      )}

      {Object.entries(groups).map(([g, items]) => {
        const running = items.filter((p) => p.running).length;
        return (
          <div key={g} className="mb-7">
            <div className="flex items-center gap-2.5 mb-3">
              <span className="text-[13px] font-medium text-slate-300">{g}</span>
              <span className="text-xs text-slate-500">{items.length} profiles</span>
              {running > 0 && (
                <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />{running} running
                </span>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {items.map((p) => <ProfileCard key={p.id} p={p} rt={runtime && runtime[p.id]} fmtUptime={fmtUptime}
                onView={onView} onStop={onStop} onExportCookies={onExportCookies} onLaunch={onLaunch}
                onEdit={onEdit} onDuplicate={onDuplicate} onRotate={onRotate} onRemove={onRemove}
                runIntegrity={runIntegrity} checkingId={checkingId} />)}
            </div>
          </div>
        );
      })}

      {integrity && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setIntegrity(null)}>
          <div className="w-[560px] max-h-[70vh] overflow-auto card p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <div className="font-medium text-slate-100">
                环境体检 — {integrity.name}
                <span className={`ml-2 pill text-xs ${integrity.report.pass ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300'}`}>
                  {integrity.report.status}
                </span>
              </div>
              <button onClick={() => setIntegrity(null)} className="text-slate-400 hover:text-slate-200">✕</button>
            </div>
            <div className="space-y-1 text-xs font-mono">
              {(integrity.report.results || []).map((r, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className={r.ok ? 'text-emerald-400' : 'text-amber-400'}>{r.ok ? '✓' : '⚠'}</span>
                  <span className="text-slate-500 w-20 shrink-0">{r.area}</span>
                  <span className="text-slate-300">{r.msg}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProfileCard({ p, rt, fmtUptime, onView, onStop, onExportCookies, onLaunch, onEdit, onDuplicate, onRotate, onRemove, runIntegrity, checkingId }) {
  return (
    <div className={`card card-hover p-4 ${p.running ? 'border-emerald-900/40' : ''}`}>
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <div className="font-medium text-slate-100 truncate">{p.name}</div>
          <div className="text-xs text-slate-500 mt-0.5">{p.fingerprint ? `${p.fingerprint.os} · ${p.fingerprint.timezone}` : p.id}</div>
        </div>
        <span className={`pill shrink-0 ${p.running ? 'bg-emerald-500/10 text-emerald-400' : 'text-slate-400'}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${p.running ? 'bg-emerald-400' : 'bg-slate-600'}`} />
          {p.running ? '运行中' : '已停止'}
        </span>
      </div>
      {p.running && rt && (
        <div className="mt-3 rounded-lg bg-emerald-500/[0.07] border border-emerald-900/40 px-3 py-2 text-xs space-y-0.5">
          <div className="text-emerald-300/90">运行 {fmtUptime(rt.uptimeMs)}
            <span className="text-slate-500 ml-2">页签 {rt.pagesCount || 1}</span>
            {rt.proxyId && <span className="text-slate-500 ml-2" title="本次会话使用的代理">代理 {rt.proxyId}</span>}
          </div>
          {rt.currentUrl && <div className="text-slate-400 truncate" title={rt.currentUrl}>{rt.currentUrl}</div>}
        </div>
      )}
      {p.fingerprint && (
        <div className="mt-3 text-[11px] text-slate-500 truncate" title={`${p.fingerprint.screen.width}x${p.fingerprint.screen.height} @ ${p.fingerprint.screen.pixelRatio}x · ${p.fingerprint.language}`}>
          {p.fingerprint.screen.width}×{p.fingerprint.screen.height} · {p.fingerprint.language} · {p.fingerprint.userAgent.slice(0, 40)}…
        </div>
      )}
      <div className="mt-2 text-[11px] text-slate-500">
        {p.vault?.locked ? (
          <span className="text-amber-400" title="数据以其他主密钥加密，重新录入后自动恢复">凭据已锁定（主密钥不匹配）— 编辑可重新录入</span>
        ) : (
          <>凭据：{p.vault?.hasEmail ? '邮箱' : '—'} · {p.vault?.hasPassword ? '密码' : '—'}{p.vault?.card ? ` · 卡尾 ${p.vault.card.numberMasked?.slice(-4)}` : ''}</>
        )}
      </div>
      <div className="mt-3.5 flex flex-wrap gap-1.5 text-xs">
        {p.running ? (
          <>
            <button onClick={() => onView(p.id)} className="btn btn-accent px-2.5 py-1 text-xs">实时画面</button>
            <button onClick={() => onStop(p.id)} className="btn btn-outline px-2.5 py-1 text-xs hover:text-rose-300">停止</button>
            <button onClick={() => onExportCookies(p.id)} className="btn btn-outline px-2.5 py-1 text-xs" title="导出运行中浏览器的全部 Cookie（JSON）">Cookie</button>
          </>
        ) : (
          <button onClick={() => onLaunch(p.id)} className="btn btn-primary px-2.5 py-1 text-xs">启动</button>
        )}
        <button onClick={() => onEdit(p)} className="btn btn-ghost px-2.5 py-1 text-xs">编辑</button>
        <button onClick={() => onDuplicate(p.id)} className="btn btn-ghost px-2.5 py-1 text-xs">复制</button>
        {p.proxyId && (
          <button onClick={() => onRotate(p.id)} className="btn btn-ghost px-2.5 py-1 text-xs" title="把保存代理换到同池健康替补">换线</button>
        )}
        <button onClick={() => runIntegrity(p)} disabled={checkingId === p.id}
          className="btn btn-ghost px-2.5 py-1 text-xs disabled:opacity-50"
          title="指纹一致性体检（启动态镜像）">
          {checkingId === p.id ? '体检中…' : '体检'}
        </button>
        <button onClick={() => onRemove(p.id)} className="btn btn-ghost px-2.5 py-1 text-xs hover:text-rose-300">删除</button>
      </div>
    </div>
  );
}
