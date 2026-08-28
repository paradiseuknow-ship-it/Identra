import React, { useState } from 'react';
import api from '../api';

export default function ProxyPanel({ proxies, onChange, notify, requestConfirm }) {
  const [form, setForm] = useState({ name: '', type: 'socks5', server: '', username: '', password: '', refreshUrl: '', ipLookupChannel: 'ipify' });
  const [checking, setChecking] = useState(null);

  const add = async () => {
    if (!form.server) return notify('请填写 server', false);
    await api.createProxy(form);
    setForm({ name: '', type: 'socks5', server: '', username: '', password: '', refreshUrl: '', ipLookupChannel: 'ipify' });
    onChange(); notify('已添加代理');
  };

  const check = async (id) => {
    setChecking(id);
    try {
      const r = await api.checkProxy(id);
      notify(r.ok ? `检测通过: ${r.ip} (${r.latencyMs}ms)` : `检测失败: ${r.error}`);
      onChange();
    } catch (e) { notify(e.message, false); }
    finally { setChecking(null); }
  };

  const remove = (id) => {
    requestConfirm('确认删除该代理？删除后无法恢复。', async () => {
      await api.deleteProxy(id); onChange(); notify('已删除');
    });
  };

  return (
    <div>
      <h2 className="text-xl font-semibold mb-4">代理管理</h2>
      <div className="rounded-lg border border-edge bg-panel p-4 mb-4">
        <div className="text-sm font-medium text-slate-300 mb-2">新增代理</div>
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
        <button onClick={add} className="mt-3 px-3 py-1.5 rounded bg-sky-600 text-white text-sm hover:bg-sky-500">添加</button>
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
            </div>
            <div className="flex gap-2">
              <button onClick={() => check(p.id)} disabled={checking === p.id}
                className="px-2 py-1 rounded bg-edge hover:bg-slate-700 disabled:opacity-50">
                {checking === p.id ? '检测中…' : '检测'}
              </button>
              <button onClick={() => remove(p.id)} className="px-2 py-1 rounded bg-edge hover:bg-rose-700 text-rose-300">删除</button>
            </div>
          </div>
        ))}
        {proxies.length === 0 && <div className="text-slate-500 text-sm">暂无代理</div>}
      </div>
    </div>
  );
}


