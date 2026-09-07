import React, { useState } from 'react';
import api, { setAuthToken } from '../api';

// C49：多用户模式（FPB_API_TOKEN 部署）登录门控。
// 缺口背景：该模式下无有效身份时全部 API 401（readiness 的 auth 检查项 detail=「未解析到身份」，
// hint 引导去治理中心建账号——但治理中心本身也 401，形成鸡生蛋死锁），且 client 此前零
// register/login 消费。本组件在启动探测 401 时全屏接管，登录/注册成功后交还控制权。
// 本地单机模式（loopback 自动挂 local 用户）永远不会触发本门控。
export default function AuthGate({ onAuthed }) {
  const [mode, setMode] = useState('login'); // login | register
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [email, setEmail] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (mode === 'register' && password !== password2) { setErr('两次输入的密码不一致'); return; }
    setBusy(true);
    try {
      if (mode === 'register') {
        // 服务端约束：用户名 ≥3 字符（[A-Za-z0-9_.-]）、密码 ≥8 位；注册即赠个人工作区
        await api.register({ username, password, email: email || undefined });
      }
      // 注册端点不返回 token（安全语义：注册≠认证），统一走登录换取会话
      const r = await api.login({ username, password });
      setAuthToken(r.token);
      if (onAuthed) onAuthed(r.user);
    } catch (ex) {
      setErr(String(ex.message || ex));
    } finally {
      setBusy(false);
    }
  };

  const inputCls = 'w-full px-3 py-2 rounded bg-black/30 border border-edge text-sm text-slate-200 focus:outline-none focus:border-sky-600';
  const tabCls = (m) => `flex-1 py-2 text-sm rounded ${mode === m ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'}`;

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950">
      <form onSubmit={submit} className="w-96 max-w-[92vw] rounded border border-edge bg-panel p-6 space-y-3">
        <div className="text-lg font-semibold text-slate-200">🛰️ 指纹浏览器控制台</div>
        <div className="text-xs text-slate-500">当前部署启用了访问令牌（多用户模式），请先登录。本地单机模式无需登录。</div>
        <div className="flex gap-2 pt-1">
          <button type="button" onClick={() => { setMode('login'); setErr(''); }} className={tabCls('login')}>登录</button>
          <button type="button" onClick={() => { setMode('register'); setErr(''); }} className={tabCls('register')}>注册</button>
        </div>
        <label className="block text-xs text-slate-400">
          用户名
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username"
            className={`${inputCls} mt-1`} placeholder="至少 3 个字符" required />
        </label>
        <label className="block text-xs text-slate-400">
          密码
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            className={`${inputCls} mt-1`} placeholder={mode === 'register' ? '至少 8 位' : '密码'} required />
        </label>
        {mode === 'register' && (
          <label className="block text-xs text-slate-400">
            确认密码
            <input type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} autoComplete="new-password"
              className={`${inputCls} mt-1`} required />
          </label>
        )}
        {mode === 'register' && (
          <label className="block text-xs text-slate-400">
            邮箱（可选）
            <input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email"
              className={`${inputCls} mt-1`} placeholder="name@example.com" />
          </label>
        )}
        {err && <div className="text-xs text-rose-400 break-all">{err}</div>}
        <button type="submit" disabled={busy || !username || !password}
          className="w-full py-2 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-sm font-medium">
          {busy ? '提交中…' : mode === 'login' ? '登录' : '注册并登录'}
        </button>
        {mode === 'register' && (
          <div className="text-[11px] text-slate-500">注册即创建个人工作区（OWNER 角色）；跨工作区授权由管理员在治理中心分配。</div>
        )}
      </form>
    </div>
  );
}
