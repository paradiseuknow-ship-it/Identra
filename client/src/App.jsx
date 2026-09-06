import React, { useEffect, useState, useCallback } from 'react';
import api from './api';
import ProfileEditor from './components/ProfileEditor';
import ProxyPanel from './components/ProxyPanel';
import TaskPanel from './components/TaskPanel';
import BrowserViewer from './components/BrowserViewer';
import AiPanel from './components/AiPanel';
import ObservabilityPanel from './components/ObservabilityPanel';
import TaskDetail from './components/TaskDetail';

export default function App() {
  const [tab, setTab] = useState('profiles');
  const [profiles, setProfiles] = useState([]);
  const [proxies, setProxies] = useState([]);
  const [editing, setEditing] = useState(null); // profile object or 'new'
  const [runLog, setRunLog] = useState([]);
  const [toast, setToast] = useState(null);
  const [viewingId, setViewingId] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [confirmState, setConfirmState] = useState(null); // { message, onConfirm, ok }

  // 应用内确认弹窗，替代原生 window.confirm（原生框在某些环境下会被静默拦截导致“点击无反应”）
  const requestConfirm = (message, onConfirm) => setConfirmState({ message, onConfirm });
  const runConfirm = () => {
    const { onConfirm } = confirmState || {};
    setConfirmState(null);
    if (onConfirm) onConfirm();
  };

  const notify = (msg, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 2500);
  };

  const loadProfiles = useCallback(async () => {
    try { setProfiles(await api.listProfiles()); } catch (e) { notify(e.message, false); }
  }, []);

  const loadProxies = useCallback(async () => {
    try { setProxies(await api.listProxies()); } catch (e) { notify(e.message, false); }
  }, []);

  useEffect(() => { loadProfiles(); loadProxies(); }, [loadProfiles, loadProxies]);

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

  const addNew = () => setEditing({ name: '', group: 'default', headless: false, proxyMode: 'inline', proxyId: null, fingerprintOverride: {} });

  const onSaved = () => { setEditing(null); loadProfiles(); };

  return (
    <div className="min-h-screen flex flex-col">
      <header className="flex items-center gap-3 px-5 py-3 border-b border-edge bg-panel">
        <div className="text-lg font-semibold">🛰️ 指纹浏览器控制台</div>
        <span className="text-xs text-slate-500">Chromium 内核 · 指纹伪装 · 自动化执行</span>
      </header>

      <div className="flex flex-1 min-h-0">
        <nav className="w-48 border-r border-edge bg-panel/60 p-3 space-y-1">
          {[['profiles', '配置管理'], ['proxies', '代理管理'], ['tasks', '自动化任务'], ['ai', 'AI 操作员'], ['observability', 'Observability']].map(([k, label]) => (
            <button key={k}
              onClick={() => setTab(k)}
              className={`w-full text-left px-3 py-2 rounded ${tab === k ? 'bg-sky-600 text-white' : 'hover:bg-edge text-slate-300'}`}>
              {label}
            </button>
          ))}
        </nav>

        <main className="flex-1 overflow-auto p-5">
          {tab === 'profiles' && (
            <ProfilesTab
              profiles={profiles} proxies={proxies}
              onAdd={addNew} onEdit={setEditing} onLaunch={launch} onStop={stop}
              onDuplicate={duplicate} onRemove={remove} onView={setViewingId}
            />
          )}
          {tab === 'proxies' && <ProxyPanel proxies={proxies} onChange={loadProxies} notify={notify} requestConfirm={requestConfirm} />}
          {tab === 'tasks' && <TaskPanel profiles={profiles} notify={notify} onLog={setRunLog} requestConfirm={requestConfirm} />}
          {tab === 'ai' && <AiPanel profiles={profiles} notify={notify} onViewDetail={setDetailId} />}
          {tab === 'observability' && <ObservabilityPanel onViewDetail={setDetailId} />}
        </main>
      </div>

      {editing && (
        <ProfileEditor
          profile={editing}
          proxies={proxies}
          onClose={() => setEditing(null)}
          onSaved={onSaved}
        />
      )}

      {viewingId && (
        <BrowserViewer profileId={viewingId} onClose={() => setViewingId(null)} />
      )}

      {detailId && (
        <TaskDetail taskId={detailId} onClose={() => setDetailId(null)} />
      )}

      {toast && (
        <div className={`fixed bottom-5 right-5 px-4 py-2 rounded shadow-lg ${toast.ok ? 'bg-emerald-600' : 'bg-rose-600'} text-white text-sm`}>
          {toast.msg}
        </div>
      )}
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

function ProfilesTab({ profiles, proxies, onAdd, onEdit, onLaunch, onStop, onDuplicate, onRemove, onView }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">配置（{profiles.length}）</h2>
        <button onClick={onAdd} className="px-3 py-1.5 rounded bg-sky-600 text-white text-sm hover:bg-sky-500">+ 新建配置</button>
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
                </>
              ) : (
                <button onClick={() => onLaunch(p.id)} className="px-2 py-1 rounded bg-emerald-600/80 hover:bg-emerald-600 text-white">启动</button>
              )}
              <button onClick={() => onEdit(p)} className="px-2 py-1 rounded bg-edge hover:bg-slate-700">编辑</button>
              <button onClick={() => onDuplicate(p.id)} className="px-2 py-1 rounded bg-edge hover:bg-slate-700">复制</button>
              <button onClick={() => onRemove(p.id)} className="px-2 py-1 rounded bg-edge hover:bg-rose-700 text-rose-300">删除</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
