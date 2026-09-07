import React, { useCallback, useEffect, useState } from 'react';
import api from '../api';

// C30：系统就绪度自检 —— 首次运行引导 + 运行期健康体检。
// 只读面板：一切凭据走后端掩码，前端只展示 key 的 last4。
export default function ReadinessPanel({ notify, onNavigate, onRefresh }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api.systemReadiness();
      setData(r);
      setErr('');
      if (onRefresh) onRefresh(r);
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  }, [onRefresh]);

  useEffect(() => { load(); }, [load]);

  const go = (panel) => { if (onNavigate) onNavigate(panel); };

  const stage = data ? data.stage : 'LOADING';
  const stageCls = stage === 'READY'
    ? 'bg-emerald-600/15 text-emerald-300 border-emerald-700/50'
    : stage === 'LOADING'
      ? 'bg-slate-700/30 text-slate-300 border-slate-600'
      : 'bg-amber-600/15 text-amber-300 border-amber-700/50';
  const stageText = stage === 'READY' ? '就绪 READY' : stage === 'LOADING' ? '检查中…' : '待完成引导 SETUP_REQUIRED';

  return (
    <div className="space-y-4">
      <div className="rounded border border-edge bg-panel p-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <div className="text-sm font-semibold text-slate-200">系统就绪度</div>
            <span className={`text-xs px-2 py-0.5 rounded border ${stageCls}`}>{stageText}</span>
          </div>
          <button onClick={load} disabled={busy}
            className="text-xs px-3 py-1.5 rounded border border-edge hover:bg-edge disabled:opacity-50">
            {busy ? '检查中…' : '重新检查'}
          </button>
        </div>
        <div className="text-xs text-slate-500 mt-1.5">
          必需项全绿即可投入日常使用；可选项缺失不影响启动，只影响对应能力。
        </div>
        {err && <div className="text-xs text-rose-400 mt-2">{err}</div>}
      </div>

      {/* 检查项 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {(data ? data.checks : []).map((c) => {
          const tone = c.ok
            ? 'border-emerald-700/50'
            : (c.optional ? 'border-amber-700/50' : 'border-rose-700/60');
          const dot = c.ok
            ? 'bg-emerald-500'
            : (c.optional ? 'bg-amber-500' : 'bg-rose-500');
          return (
            <div key={c.key} className={`rounded border ${tone} bg-panel p-3`}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${dot}`} />
                  <span className="text-sm text-slate-200">{c.label}</span>
                  {c.optional && <span className="text-[10px] px-1.5 rounded bg-slate-700/60 text-slate-400">可选</span>}
                </div>
                <span className={`text-xs ${c.ok ? 'text-emerald-400' : c.optional ? 'text-amber-400' : 'text-rose-400'}`}>
                  {c.ok ? '通过' : c.optional ? '未配置' : '阻塞'}
                </span>
              </div>
              <div className="text-xs text-slate-400 mt-1.5 break-all">{c.detail}</div>
              {!c.ok && c.hint && (
                <button onClick={() => go(c.panel)}
                  className="mt-2 text-xs px-2 py-1 rounded border border-edge hover:bg-edge text-sky-300">
                  前往处理 · {c.hint}
                </button>
              )}
            </div>
          );
        })}
        {!data && !err && <div className="text-xs text-slate-500">加载中…</div>}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* 资产概览 */}
        <div className="rounded border border-edge bg-panel p-3">
          <div className="text-sm font-semibold text-slate-200 mb-2">资产概览</div>
          {data ? (
            <div className="grid grid-cols-2 gap-2 text-xs">
              {[['浏览器配置', data.assets.profiles], ['指纹模板', data.assets.templates],
                ['代理', data.assets.proxies], ['自动化任务', data.assets.tasks],
                ['活跃会话', data.assets.activeSessions]].map(([k, v]) => (
                <div key={k} className="flex items-center justify-between px-2 py-1.5 rounded bg-black/20 border border-edge">
                  <span className="text-slate-400">{k}</span>
                  <span className="text-sky-300 font-medium">{v}</span>
                </div>
              ))}
            </div>
          ) : <div className="text-xs text-slate-500">—</div>}
        </div>

        {/* LLM 与安全 */}
        <div className="rounded border border-edge bg-panel p-3">
          <div className="text-sm font-semibold text-slate-200 mb-2">LLM 与安全</div>
          {data ? (
            <div className="space-y-1.5 text-xs">
              <Row k="Provider" v={data.llm.provider || '—'} />
              <Row k="Model" v={data.llm.model || '（默认）'} />
              <Row k="API Key" v={data.llm.keyMasked || '未设置'} />
              <Row k="Base URL" v={data.llm.baseUrl || '（默认）'} />
              <Row k="监听地址" v={data.security.bind} />
              <Row k="访问令牌" v={data.security.tokenRequired ? '已启用' : '未启用（仅本机）'} tone={data.security.tokenRequired ? 'ok' : 'warn'} />
              <Row k="远程 JS 执行" v={data.security.evaluateEnabled ? '已开启' : '已关闭（推荐）'} tone={data.security.evaluateEnabled ? 'bad' : 'ok'} />
              <Row k="主加密密钥" v={data.security.masterKeySet ? '已设置' : '未设置（凭据不可用密文存储）'} tone={data.security.masterKeySet ? 'ok' : 'warn'} />
            </div>
          ) : <div className="text-xs text-slate-500">—</div>}
          {data && (
            <button onClick={() => go('settings')}
              className="mt-2 text-xs px-2 py-1 rounded border border-edge hover:bg-edge text-sky-300">
              前往系统设置调整
            </button>
          )}
        </div>
      </div>

      {data && data.auth && (
        <div className="rounded border border-edge bg-panel p-3 text-xs text-slate-400">
          当前身份：<span className="text-slate-200">{data.auth.username}</span>
          {' · 工作区 '}<span className="text-slate-300">{data.auth.workspaceId || '—'}</span>
          {' · 角色 '}<span className="text-slate-300">{data.auth.role || '—'}</span>
          {' · 来源 '}<span className="text-slate-300">{data.auth.kind === 'local' ? '本地单机' : data.auth.kind === 'apiKey' ? 'API Key' : '会话登录'}</span>
        </div>
      )}
    </div>
  );
}

function Row({ k, v, tone }) {
  const cls = tone === 'ok' ? 'text-emerald-400' : tone === 'bad' ? 'text-rose-400' : tone === 'warn' ? 'text-amber-400' : 'text-slate-300';
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-slate-500 shrink-0">{k}</span>
      <span className={`${cls} text-right break-all`}>{v}</span>
    </div>
  );
}
