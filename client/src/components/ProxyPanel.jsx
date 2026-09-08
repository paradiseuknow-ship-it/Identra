import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';

const HEALTH_STYLE = {
  healthy: 'bg-emerald-600/30 text-emerald-300',
  unchecked: 'bg-slate-700 text-slate-300',
  degraded: 'bg-amber-600/30 text-amber-300',
  dead: 'bg-rose-600/30 text-rose-300',
};
const HEALTH_LABEL = { healthy: '健康', unchecked: '未检', degraded: '降级', dead: '失效' };

export default function ProxyPanel({ proxies, onChange, notify, requestConfirm }) {
  const emptyForm = { name: '', type: 'socks5', server: '', username: '', password: '', refreshUrl: '', ipLookupChannel: 'ipify' };
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState(null); // C37: 正在编辑的代理 id（null = 新增模式）
  const [checking, setChecking] = useState(null);
  const [geoChecking, setGeoChecking] = useState(null);
  const [health, setHealth] = useState(null);

  const loadHealth = useCallback(async () => {
    try { setHealth(await api.proxyHealth()); } catch { /* 健康度加载失败不阻塞主列表 */ }
  }, []);
  useEffect(() => { loadHealth(); }, [loadHealth]);

  const healthOf = (id) => health && health.items && health.items.find((x) => x.id === id);

  // C70：补 try/catch —— 原实现 createProxy 抛错即 unhandled rejection，用户零反馈且表单不明所以
  const add = async () => {
    if (!form.server) return notify('请填写 server', false);
    try {
      await api.createProxy(form);
      setForm(emptyForm);
      onChange(); notify('已添加代理');
    } catch (e) { notify('添加失败: ' + e.message, false); }
  };

  // C37: 编辑代理（PUT /proxies/:id；id/归属/健康字段由服务端剥离）
  const saveEdit = async () => {
    if (!form.server) return notify('请填写 server', false);
    try {
      await api.updateProxy(editing, {
        name: form.name, type: form.type, server: form.server, username: form.username,
        password: form.password, refreshUrl: form.refreshUrl, ipLookupChannel: form.ipLookupChannel,
      });
      setEditing(null); setForm(emptyForm);
      onChange(); notify('代理已更新');
    } catch (e) { notify('更新失败: ' + e.message, false); }
  };

  const startEdit = (p) => {
    setEditing(p.id);
    setForm({
      name: p.name || '', type: p.type || 'socks5', server: p.server || '',
      username: p.username || '', password: p.password || '',
      refreshUrl: p.refreshUrl || '', ipLookupChannel: p.ipLookupChannel || 'ipify',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const cancelEdit = () => { setEditing(null); setForm(emptyForm); };

  // C37: 代理出口地理位置检测（POST /proxies/:id/check-geo → {ok, ip, geo:{country,city,...}}）
  const checkGeo = async (id) => {
    setGeoChecking(id);
    try {
      const r = await api.checkProxyGeo(id);
      if (r.ok) {
        const g = r.geo || {};
        notify(`出口 Geo: ${r.ip} · ${g.country || '?'}${g.city ? ' ' + g.city : ''}${r.detectedType ? ' (实际协议 ' + r.detectedType + ')' : ''} ${r.latencyMs}ms`);
      } else {
        notify('Geo 检测失败: ' + (r.error || 'unknown'), false);
      }
    } catch (e) { notify(e.message, false); }
    finally { setGeoChecking(null); }
  };

  const check = async (id) => {
    setChecking(id);
    try {
      const r = await api.checkProxy(id);
      notify(r.ok ? `检测通过: ${r.ip} (${r.latencyMs}ms)` : `检测失败: ${r.error}`);
      onChange(); loadHealth();
    } catch (e) { notify(e.message, false); }
    finally { setChecking(null); }
  };

  // C70：删除回调同样补 try/catch（失败静默 + 列表不刷新）
  const remove = (id) => {
    requestConfirm('确认删除该代理？删除后无法恢复。', async () => {
      try { await api.deleteProxy(id); onChange(); notify('已删除'); }
      catch (e) { notify('删除失败: ' + e.message, false); }
    });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">代理管理</h2>
        {health && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-500">池健康度 ({health.total}):</span>
            {['healthy', 'unchecked', 'degraded', 'dead'].map((k) => (
              health.summary[k] > 0 && (
                <span key={k} className={`px-2 py-0.5 rounded ${HEALTH_STYLE[k]}`}>
                  {HEALTH_LABEL[k]} {health.summary[k]}
                </span>
              )
            ))}
          </div>
        )}
      </div>
      <div className="rounded-lg border border-edge bg-panel p-4 mb-4">
        <div className="text-sm font-medium text-slate-300 mb-2">{editing ? '编辑代理（保存后生效）' : '新增代理'}</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <input className="inp" placeholder="名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <select className="inp" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            <option value="socks5">Socks5</option>
            <option value="http">HTTP</option>
            <option value="https">HTTPS</option>
          </select>
          <select className="inp" value={form.ipLookupChannel} onChange={(e) => setForm({ ...form, ipLookupChannel: e.target.value })}>
            <option value="ipify">ipify</option>
            <option value="ip2location">IP2Location</option>
            <option value="custom">自定义</option>
          </select>
          <input className="inp" placeholder="刷新 URL (可选)" value={form.refreshUrl} onChange={(e) => setForm({ ...form, refreshUrl: e.target.value })} />
          <input className="inp" placeholder="server (host:port)" value={form.server} onChange={(e) => setForm({ ...form, server: e.target.value })} />
          <input className="inp" placeholder="用户名(可选)" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
          <input className="inp" placeholder="密码(可选)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </div>
        {editing ? (
          <div className="mt-3 flex gap-2">
            <button onClick={saveEdit} className="px-3 py-1.5 rounded bg-emerald-600 text-white text-sm hover:bg-emerald-500">保存修改</button>
            <button onClick={cancelEdit} className="px-3 py-1.5 rounded border border-edge text-slate-300 text-sm hover:bg-edge">取消</button>
          </div>
        ) : (
          <button onClick={add} className="mt-3 px-3 py-1.5 rounded bg-sky-600 text-white text-sm hover:bg-sky-500">添加</button>
        )}
      </div>

      <div className="space-y-2">
        {proxies.map((p) => (
          <div key={p.id} className="flex items-center justify-between rounded border border-edge bg-panel px-4 py-2 text-sm">
            <div>
              <span className="font-medium">{p.name}</span>
              <span className="text-slate-500 ml-2">{p.type} · {p.server}</span>
              {p.lastCheck && (
                <span className={`ml-2 ${p.lastCheck.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {p.lastCheck.ok ? `✓ ${p.lastCheck.ip} ${p.lastCheck.latencyMs}ms` : `✗ ${p.lastCheck.error}`}
                </span>
              )}
              {healthOf(p.id) && (
                <span className={`ml-2 px-1.5 py-0.5 rounded text-xs ${HEALTH_STYLE[healthOf(p.id).status] || HEALTH_STYLE.unchecked}`}>
                  {HEALTH_LABEL[healthOf(p.id).status] || '未检'}
                  {healthOf(p.id).checked ? ` · ${healthOf(p.id).checked}次` : ''}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <button onClick={() => checkGeo(p.id)} disabled={geoChecking === p.id}
                className="px-2 py-1 rounded bg-edge hover:bg-slate-700 disabled:opacity-50" title="检测出口 IP 地理位置（IP/国家/城市）">
                {geoChecking === p.id ? 'Geo…' : 'Geo'}
              </button>
              <button onClick={() => check(p.id)} disabled={checking === p.id}
                className="px-2 py-1 rounded bg-edge hover:bg-slate-700 disabled:opacity-50">
                {checking === p.id ? '检测中…' : '检测'}
              </button>
              <button onClick={() => startEdit(p)} disabled={editing === p.id}
                className="px-2 py-1 rounded bg-edge hover:bg-slate-700 disabled:opacity-50" title="编辑该代理">编辑</button>
              <button onClick={() => remove(p.id)} className="px-2 py-1 rounded bg-edge hover:bg-rose-700 text-rose-300">删除</button>
            </div>
          </div>
        ))}
        {proxies.length === 0 && <div className="text-slate-500 text-sm">暂无代理</div>}
      </div>
    </div>
  );
}


