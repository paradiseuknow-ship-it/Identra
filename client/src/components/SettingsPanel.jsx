import React, { useEffect, useState, useCallback } from 'react';
import api from '../api';

// C14: 系统设置中心。LLM 配置（key 打码 / 保存 / 清除 / 连通测试）+ env 对账表。
// apiKey 永不明文展示（服务端只回 last4 掩码）；保存后立即生效（无需重启）。

const inputCls = 'w-full bg-[#0F172A] border border-edge rounded px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-sky-500';

export default function SettingsPanel({ notify }) {
  const [data, setData] = useState(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [provider, setProvider] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const load = useCallback(async () => {
    try {
      const s = await api.getSettings();
      setData(s);
      const l = s.llm || {};
      setModel((l.model && l.model.set && l.model.masked) || '');
      setBaseUrl((l.baseUrl && l.baseUrl.set && l.baseUrl.masked) || '');
      setProvider((l.provider && l.provider.set && l.provider.masked) || '');
    } catch (e) { notify('加载设置失败: ' + e.message, false); }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  async function save(patch, okMsg) {
    setSaving(true);
    try {
      await api.updateSettings(patch);
      setApiKeyInput('');
      notify(okMsg || '已保存并即时生效');
      await load();
    } catch (e) { notify('保存失败: ' + e.message, false); }
    finally { setSaving(false); }
  }

  async function runTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const patch = {};
      if (model.trim()) patch.model = model.trim();
      if (baseUrl.trim()) patch.baseUrl = baseUrl.trim();
      if (Object.keys(patch).length) await api.updateSettings(patch); // 测试前先落盘非密字段
      const r = await api.testLlm({});
      setTestResult(r);
      notify(r.ok ? `连通正常 (${r.latencyMs}ms, ${r.model})` : `连通失败: ${r.error}`, r.ok);
    } catch (e) { notify('测试失败: ' + e.message, false); }
    finally { setTesting(false); }
  }

  if (!data) return <div className="text-slate-400 text-sm p-6">加载中…</div>;

  const llm = data.llm || {};
  const keyInfo = llm.apiKey || { set: false, masked: null };
  const envRows = (data.env || []).filter((r) => r.writable);
  const roRows = (data.env || []).filter((r) => !r.writable);

  return (
    <div className="max-w-4xl mx-auto space-y-4 p-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-100">系统设置</h2>
        <p className="text-xs text-slate-500 mt-1">保存后立即生效（无需重启）。API key 仅以密文落盘，界面只显示掩码。</p>
      </div>

      {/* LLM 配置 */}
      <div className="bg-panel/60 border border-edge rounded-lg p-4 space-y-3">
        <div className="text-sm font-medium text-slate-200">AI 模型 (DeepSeek)</div>

        <div>
          <label className="text-xs text-slate-400 block mb-1">API Key {keyInfo.set ? <span className="text-emerald-400 ml-2">已配置 · {keyInfo.masked}</span> : <span className="text-amber-400 ml-2">未配置（AI 功能将回退 mock）</span>}</label>
          <div className="flex gap-2">
            <input className={inputCls} type="password" placeholder={keyInfo.set ? '输入新 key 以更换' : 'sk-...'} value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)} />
            <button
              disabled={saving || !apiKeyInput.trim()}
              onClick={() => save({ apiKey: apiKeyInput.trim() }, 'API Key 已保存并生效')}
              className="px-4 py-2 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white text-sm whitespace-nowrap">保存</button>
            {keyInfo.set && (
              <button
                disabled={saving}
                onClick={() => save({ apiKey: null }, 'API Key 已清除（让位给 .env / 环境变量）')}
                className="px-4 py-2 rounded border border-edge hover:bg-edge text-slate-300 text-sm whitespace-nowrap">清除</button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-slate-400 block mb-1">Model</label>
            <input className={inputCls} placeholder="deepseek-chat" value={model} onChange={(e) => setModel(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">Base URL</label>
            <input className={inputCls} placeholder="https://api.deepseek.com" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </div>
        </div>

        <div className="flex items-center gap-3 pt-1">
          <button
            disabled={testing || saving}
            onClick={runTest}
            className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm">测试连通</button>
          <button
            disabled={saving || (!model.trim() && !baseUrl.trim())}
            onClick={() => save({ model: model.trim() || null, baseUrl: baseUrl.trim() || null }, '模型配置已保存')}
            className="px-4 py-2 rounded border border-edge hover:bg-edge text-slate-300 text-sm">保存模型配置</button>
          {testResult && (
            <span className={`text-xs ${testResult.ok ? 'text-emerald-400' : 'text-red-400'}`}>
              {testResult.ok ? `✅ ${testResult.model} · ${testResult.latencyMs}ms` : `❌ ${testResult.error}${testResult.message ? ' · ' + testResult.message : ''}`}
            </span>
          )}
        </div>
      </div>

      {/* env 对账 */}
      <div className="bg-panel/60 border border-edge rounded-lg p-4">
        <div className="text-sm font-medium text-slate-200 mb-2">配置对账（设置覆盖 vs 环境变量）</div>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-slate-500 text-left">
              <th className="py-1 pr-2">变量</th>
              <th className="py-1 pr-2">生效值</th>
              <th className="py-1">来源</th>
            </tr>
          </thead>
          <tbody>
            {envRows.map((r) => (
              <tr key={r.env} className="border-t border-edge/50">
                <td className="py-1.5 pr-2 font-mono text-slate-300">{r.env}</td>
                <td className="py-1.5 pr-2 font-mono text-slate-400">{r.effectiveMasked || <span className="text-slate-600">（空）</span>}</td>
                <td className="py-1.5">
                  {r.overriddenBySettings ? <span className="text-sky-400">设置覆盖</span>
                    : r.fromSettings ? <span className="text-slate-500">设置（待生效）</span>
                    : r.fromEnv ? <span className="text-slate-500">环境变量</span>
                    : <span className="text-slate-600">默认值</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 只读运行参数 */}
      <div className="bg-panel/60 border border-edge rounded-lg p-4">
        <div className="text-sm font-medium text-slate-200 mb-2">运行参数（只读，需改 .env / 环境变量后重启）</div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs font-mono">
          {roRows.map((r) => (
            <div key={r.env} className="flex justify-between border-b border-edge/30 py-1">
              <span className="text-slate-400">{r.env}</span>
              <span className="text-slate-500">{r.effectiveMasked || '—'}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
