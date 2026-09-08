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

export default function App() {
  const [tab, setTab] = useState('profiles');
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

  // 应用内确认弹窗，替代原生 window.confirm（原生框在某些环境下会被静默拦截导致“点击无反应”）
  const requestConfirm = (message, onConfirm) => setConfirmState({ message, onConfirm });
  useEscapeClose(!!confirmState, () => setConfirmState(null)); // C43：Esc 关确认弹窗（取消语义，不触发确认）
  const runConfirm = () => {
    const { onConfirm } = confirmState || {};
    setConfirmState(null);
    if (onConfirm) onConfirm();
  };

  // C41：notify 转发到 ToastHost 总线（签名不变，调用方零改动）。
  // 旧单条 toast + 裸 setTimeout 的截断竞态与卸载后 setState 由 ToastHost 修复。
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
  const duplicate = async (id) => { await api.duplicateProfile(id); await loadProfiles(); notify('已复制'); };
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

  // C49：多用户模式登录门控全屏接管（放在所有 hook 之后，条件返回合法）
  if (needAuth) return <AuthGate onAuthed={handleAuthed} />;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="flex items-center gap-3 px-5 py-3 border-b border-edge bg-panel">
        <div className="text-lg font-semibold">🛰️ 指纹浏览器控制台</div>
        <span className="text-xs text-slate-500">Chromium 内核 · 指纹伪装 · 自动化执行</span>
        {readiness && (
          <button onClick={() => setTab('readiness')}
            title={readiness.checks.filter((c) => !c.ok && !c.optional).map((c) => c.label).join('、') || '必需项全部就绪'}
            className={`ml-auto text-xs px-2 py-0.5 rounded border ${readiness.ok
              ? 'border-emerald-700/60 text-emerald-300 bg-emerald-600/10'
              : 'border-amber-700/60 text-amber-300 bg-amber-600/10'}`}>
            {readiness.ok ? '● 就绪' : '● 待引导'}
          </button>
        )}
        {hasSession && (
          <button onClick={doLogout} title="结束当前会话并返回登录页（C49）"
            className={`text-xs px-2 py-0.5 rounded border border-edge text-slate-400 hover:text-slate-200 ${readiness ? '' : 'ml-auto'}`}>
            退出登录
          </button>
        )}
      </header>

      <div className="flex flex-1 min-h-0">
        <nav className="w-48 border-r border-edge bg-panel/60 p-3 space-y-1">
                    {[['readiness', '就绪检查'], ['profiles', '配置管理'], ['templates', '指纹模板'], ['proxies', '代理管理'], ['tasks', '自动化任务'], ['ai', 'AI 操作员'], ['schedules', '定时调度'], ['execution', '执行引擎'], ['intelligence', '智能记忆'], ['governance', '治理中心'], ['observability', 'Observability'], ['settings', '系统设置']].map(([k, label]) => (
            <button key={k}
              onClick={() => setTab(k)}
              className={`w-full text-left px-3 py-2 rounded ${tab === k ? 'bg-sky-600 text-white' : 'hover:bg-edge text-slate-300'}`}>
              {label}
            </button>
          ))}
        </nav>

        <main className="flex-1 overflow-auto p-5">
          {/* C40：面板级错误边界——任一面板渲染崩溃只显示本面板错误卡（可重试/刷新），不再拖垮整树白屏；key=tab 保证切回时重置 */}
          <ErrorBoundary key={tab} name={tab}>
          {tab === 'profiles' && (
            <ProfilesTab
              profiles={profiles} proxies={proxies} runtime={runtime}
              onAdd={addNew} onEdit={setEditing} onLaunch={launch} onStop={stop}
              onDuplicate={duplicate} onRemove={remove} onView={setViewingId}
              onRotate={rotate} onExport={exportProfiles} onImport={importProfiles}
              notify={notify} onBatch={() => setBatch({ count: 5, namePrefix: '批量配置' })}
            />
          )}
          {tab === 'templates' && <TemplatesPanel notify={notify} requestConfirm={requestConfirm} />}
          {tab === 'proxies' && <ProxyPanel proxies={proxies} onChange={loadProxies} notify={notify} requestConfirm={requestConfirm} />}
          {tab === 'tasks' && <TaskPanel profiles={profiles} notify={notify} onLog={setRunLog} requestConfirm={requestConfirm} />}
          {tab === 'ai' && <AiPanel profiles={profiles} notify={notify} onViewDetail={setDetailId} onGoToSettings={() => setTab('settings')} />}
          {tab === 'schedules' && <SchedulesPanel profiles={profiles} notify={notify} requestConfirm={requestConfirm} onViewDetail={setDetailId} />}
          {tab === 'execution' && <ExecutionPanel notify={notify} />}
          {tab === 'intelligence' && <IntelligencePanel notify={notify} />}
          {tab === 'readiness' && <ReadinessPanel notify={notify} onNavigate={setTab} onRefresh={setReadiness} />}
          {tab === 'governance' && <GovernancePanel notify={notify} requestConfirm={requestConfirm} />}
          {tab === 'observability' && <ObservabilityPanel onViewDetail={setDetailId} />}
          </ErrorBoundary>
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

      <ToastHost />
      {confirmState && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-80 rounded-lg border border-edge bg-panel p-5 shadow-2xl">
            <div className="text-sm text-slate-200 mb-5">{confirmState.message}</div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmState(null)} className="px-3 py-1.5 rounded bg-edge hover:bg-slate-700 text-slate-200 text-sm">取消</button>
              <button onClick={runConfirm} className="px-3 py-1.5 rounded bg-rose-600 hover:bg-rose-500 text-white text-sm">确认删除</button>
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

function ProfilesTab({ profiles, proxies, runtime, onAdd, onEdit, onLaunch, onStop, onDuplicate, onRemove, onView, onRotate, onExport, onImport, onBatch, notify }) {
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

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">配置（{profiles.length}）</h2>
        <div className="flex gap-2">
          <button onClick={onImport} className="px-3 py-1.5 rounded bg-edge hover:bg-slate-700 text-slate-200 text-sm">导入</button>
          <button onClick={onExport} className="px-3 py-1.5 rounded bg-edge hover:bg-slate-700 text-slate-200 text-sm">导出</button>
          <button onClick={onBatch} className="px-3 py-1.5 rounded bg-edge hover:bg-slate-700 text-slate-200 text-sm" title="同模板基线 + 每号独立 seed（同形不同样）">批量</button>
          <button onClick={onAdd} className="px-3 py-1.5 rounded bg-sky-600 text-white text-sm hover:bg-sky-500">+ 新建配置</button>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {profiles.map((p) => (
          <div key={p.id} className="rounded-lg border border-edge bg-panel p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="font-medium">{p.name}</div>
                <div className="text-xs text-slate-500">{p.group} · {p.id}</div>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded ${p.running ? 'bg-emerald-600/30 text-emerald-300' : 'bg-slate-700 text-slate-300'}`}>
                {p.running ? '运行中' : '已停止'}
              </span>
            </div>
            {p.running && runtime && runtime[p.id] && (
              <div className="mt-3 rounded bg-sky-500/10 border border-sky-500/20 px-3 py-2 text-xs space-y-0.5">
                <div>运行时长: <span className="text-sky-300 font-medium">{fmtUptime(runtime[p.id].uptimeMs)}</span>
                  <span className="text-slate-500 ml-2">页签 {runtime[p.id].pagesCount || 1}</span>
                  {runtime[p.id].proxyId && <span className="text-slate-500 ml-2" title="本次会话使用的代理">代理 {runtime[p.id].proxyId}</span>}
                </div>
                {runtime[p.id].currentUrl && (
                  <div className="text-slate-400 truncate" title={runtime[p.id].currentUrl}>当前: {runtime[p.id].currentUrl}</div>
                )}
              </div>
            )}
            {p.fingerprint && (
              <div className="mt-3 text-xs space-y-1 text-slate-400">
                <div>OS: <span className="text-slate-200">{p.fingerprint.os} / {p.fingerprint.browser}</span></div>
                <div>分辨率: <span className="text-slate-200">{p.fingerprint.screen.width}x{p.fingerprint.screen.height} @ {p.fingerprint.screen.pixelRatio}x</span></div>
                <div>时区: <span className="text-slate-200">{p.fingerprint.timezone}</span></div>
                <div>语言: <span className="text-slate-200">{p.fingerprint.language}</span></div>
                <div>UA: <span className="text-slate-200 break-all">{p.fingerprint.userAgent.slice(0, 48)}…</span></div>
                <div>WebGL: <span className="text-slate-200">{p.fingerprint.webgl.renderer.slice(0, 40)}…</span></div>
              </div>
            )}
            <div className="mt-2 text-xs text-slate-500">
              {p.vault?.locked ? (
                <span className="text-amber-400" title="数据以其他主密钥加密，重新录入后自动恢复">🔒 凭据已锁定（主密钥不匹配）— 点击编辑重新录入</span>
              ) : (
                <>
                  凭据: {p.vault?.hasEmail ? '✓邮箱' : '✗'} {p.vault?.hasPassword ? '✓密码' : '✗'}
                  {p.vault?.card ? ` · ✓卡尾${p.vault.card.numberMasked?.slice(-4)}` : ''}
                </>
              )}
            </div>
            <div className="mt-4 flex flex-wrap gap-2 text-xs">
              {p.running ? (
                <>
                  <button onClick={() => onView(p.id)} className="px-2 py-1 rounded bg-sky-600/80 hover:bg-sky-600 text-white">查看</button>
                  <button onClick={() => onStop(p.id)} className="px-2 py-1 rounded bg-rose-600/80 hover:bg-rose-600 text-white">停止</button>
                  <button onClick={() => exportCookies(p.id)} className="px-2 py-1 rounded bg-edge hover:bg-slate-700" title="导出运行中浏览器的全部 Cookie（JSON）">Cookie</button>
                </>
              ) : (
                <button onClick={() => onLaunch(p.id)} className="px-2 py-1 rounded bg-emerald-600/80 hover:bg-emerald-600 text-white">启动</button>
              )}
              <button onClick={() => onEdit(p)} className="px-2 py-1 rounded bg-edge hover:bg-slate-700">编辑</button>
              <button onClick={() => onDuplicate(p.id)} className="px-2 py-1 rounded bg-edge hover:bg-slate-700">复制</button>
              {p.proxyId && (
                <button onClick={() => onRotate(p.id)} className="px-2 py-1 rounded bg-edge hover:bg-slate-700" title="把保存代理换到同池健康替补">换线</button>
              )}
              <button onClick={() => runIntegrity(p)} disabled={checkingId === p.id}
                className="px-2 py-1 rounded bg-edge hover:bg-slate-700 disabled:opacity-50"
                title="指纹一致性体检（启动态镜像）">
                {checkingId === p.id ? '体检中…' : '体检'}
              </button>
              <button onClick={() => onRemove(p.id)} className="px-2 py-1 rounded bg-edge hover:bg-rose-700 text-rose-300">删除</button>
            </div>
          </div>
        ))}
      </div>

      {batch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => !batching && setBatch(null)}>
          <div className="w-96 rounded-lg border border-edge bg-panel p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="font-medium mb-4">批量建号</div>
            <div className="space-y-3 text-sm">
              <label className="block">
                <span className="text-slate-400 text-xs">数量（1-50）</span>
                <input type="number" min="1" max="50" className="inp w-full mt-1" value={batch.count}
                  onChange={(e) => setBatch({ ...batch, count: e.target.value })} />
              </label>
              <label className="block">
                <span className="text-slate-400 text-xs">名称前缀</span>
                <input className="inp w-full mt-1" value={batch.namePrefix}
                  onChange={(e) => setBatch({ ...batch, namePrefix: e.target.value })} />
              </label>
              <div className="text-xs text-slate-500">稳定字段共享基线，噪声字段每号独立派生（「同形不同样」）。</div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setBatch(null)} disabled={batching} className="px-3 py-1.5 rounded bg-edge hover:bg-slate-700 text-slate-200 text-sm">取消</button>
              <button onClick={runBatch} disabled={batching} className="px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white text-sm disabled:opacity-50">
                {batching ? '创建中…' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {integrity && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setIntegrity(null)}>
          <div className="w-[560px] max-h-[70vh] overflow-auto rounded-lg border border-edge bg-panel p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <div className="font-medium">
                指纹体检 — {integrity.name}
                <span className={`ml-2 px-2 py-0.5 rounded text-xs ${integrity.report.pass ? 'bg-emerald-600/30 text-emerald-300' : 'bg-amber-600/30 text-amber-300'}`}>
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
