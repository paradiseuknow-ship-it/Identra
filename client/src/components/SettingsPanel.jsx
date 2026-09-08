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
  const [pendingRestore, setPendingRestore] = useState(null); // C47：两步恢复确认

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

  async function exportBackup() {
    try {
      const snap = await api.exportBackup();
      const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'identra-backup-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
      notify('备份已导出（' + Object.keys(snap.files || {}).length + ' 个文件）');
    } catch (e) { notify('备份导出失败: ' + e.message, false); }
  }

  // C66：恢复流程两步确认接线（C47 半成品收尾）。旧实现原生 window.confirm 在
  // 自动化浏览器/部分 WebView 中被静默拦截（恒 false）→ 恢复按钮是死的；且
  // pendingRestore 状态与确认 UI 块从未被赋值/实现（confirmRestore 不存在，纯死代码）。
  // 现流程：选文件 → 本地解析+校验 JSON → 挂起待确认（不触网不发请求）→
  // 显式「确认恢复」按钮才真正调用 restore API；取消/重选即丢弃。
  async function restoreBackup(ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = ''; // 允许重复选择同一文件
    if (!file) return;
    try {
      const snapshot = JSON.parse(await file.text());
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        notify('备份文件格式无效（需要一个 JSON 对象快照）', false);
        return;
      }
      setPendingRestore({ name: file.name, snapshot });
    } catch (e) {
      notify('备份文件解析失败: ' + e.message, false);
    }
  }

  async function confirmRestore() {
    if (!pendingRestore) return;
    const snapshot = pendingRestore.snapshot;
    setPendingRestore(null);
    try {
      const r = await api.restoreBackup(snapshot);
      notify('恢复完成（' + r.restored.length + ' 个文件）。建议重启服务确保全部模块重新读盘。');
    } catch (e) { notify('恢复失败: ' + e.message, false); }
  }

  if (!data) return <div className="text-slate-400 text-sm p-6">加载中…</div>;

  const llm = data.llm || {};
  const keyInfo = llm.apiKey || { set: false, masked: null };
  const envRows = (data.env || []).filter((r) => r.writable);
  const roRows = (data.env || []).filter((r) => !r.writable);

  return (
    <div className="max-w-4xl mx-auto space-y-4 p-4">
      <StorageView notify={notify} />
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
      {/* 数据备份 / 恢复（C22） */}
      <div className="bg-panel/60 border border-edge rounded-lg p-4">
        <div className="text-sm font-medium text-slate-200 mb-1">数据备份 / 恢复</div>
        <div className="text-xs text-slate-500 mb-3">全量快照含 Profile、代理、加密凭据（密文）与 AI 记忆。备份文件请妥善保管——含加密凭据数据，丢失主密钥无法解密。</div>
        <div className="flex gap-2">
          <button onClick={exportBackup}
            className="px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white text-xs">导出备份（下载 JSON）</button>
          <label className="px-3 py-1.5 rounded border border-rose-500/40 text-rose-400 hover:bg-rose-500/10 text-xs cursor-pointer">
            恢复备份（全量覆盖）
            <input type="file" accept=".json,application/json" className="hidden" onChange={restoreBackup} />
          </label>
        </div>
        {pendingRestore && (
          <div className="mt-2 flex items-center gap-2 text-xs bg-rose-500/10 border border-rose-500/40 rounded px-2 py-1.5">
            <span className="text-rose-300">待恢复：{pendingRestore.name}（全量覆盖当前数据，旧数据自动快照）</span>
            <button onClick={confirmRestore} className="px-2 py-0.5 rounded bg-rose-600 hover:bg-rose-500 text-white">确认恢复</button>
            <button onClick={() => setPendingRestore(null)} className="px-2 py-0.5 rounded border border-edge text-slate-400">取消</button>
          </div>
        )}
        <div className="text-xs text-slate-600 mt-2">恢复前旧数据自动快照到 data/backups/pre-restore-*；恢复后建议重启服务。</div>
      </div>
    </div>
  );
}


// C47：存储使用与清理（白名单 + dry-run 预览 + 显式确认才真正删除）
const fmtBytes = (n) => {
  if (n == null) return '-';
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
};
function StorageView({ notify }) {
  const [items, setItems] = useState(null);
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = React.useCallback(async () => {
    try { setItems((await api.storageStats()).items); } catch (e) { notify('加载存储统计失败: ' + e.message, false); }
  }, [notify]);
  React.useEffect(() => { load(); }, [load]);
  const preview = async () => {
    setBusy(true);
    try {
      const r = await api.storageCleanup({ targets: ['benchmarkLogs', 'browserProfiles'], olderThanDays: 7, dryRun: true });
      setPlan(r);
      notify(r.count ? ('可清理 ' + r.count + ' 项，约 ' + fmtBytes(r.freed)) : '没有可清理项');
    } catch (e) { notify('清理预览失败: ' + e.message, false); }
    setBusy(false);
  };
  const execute = async () => {
    setBusy(true);
    try {
      const r = await api.storageCleanup({ targets: ['benchmarkLogs', 'browserProfiles'], olderThanDays: 7, dryRun: false });
      notify('已清理 ' + r.count + ' 项，释放约 ' + fmtBytes(r.freed));
      setPlan(null); load();
    } catch (e) { notify('清理失败: ' + e.message, false); }
    setBusy(false);
  };
  return (
    <div className="bg-white dark:bg-gray-800 rounded shadow p-4">
      <div className="font-medium mb-2 flex justify-between items-center">
        <span>存储使用</span>
        <span>
          <button disabled={busy} onClick={preview} className="text-xs px-2 py-1 bg-gray-200 dark:bg-gray-700 rounded mr-2 disabled:opacity-50">清理预览</button>
          {plan && plan.count > 0 && (
            <button disabled={busy} onClick={execute} className="text-xs px-2 py-1 bg-rose-600 text-white rounded disabled:opacity-50">确认清理（{plan.count} 项 / {fmtBytes(plan.freed)}）</button>
          )}
        </span>
      </div>
      {!items && <div className="text-gray-400 text-sm">统计中…（大目录首次统计可能需要数十秒）</div>}
      {items && (
        <table className="w-full text-sm">
          <thead><tr className="text-left text-gray-500"><th className="py-1">目录</th><th>体积</th><th>文件数</th></tr></thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.key} className="border-t">
                <td className="py-1.5">{it.label}</td>
                <td className="font-mono text-xs">{it.exists ? fmtBytes(it.bytes) : '不存在'}{it.truncated ? '（截断统计）' : ''}</td>
                <td className="text-xs text-gray-500">{it.files}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="text-[11px] text-gray-400 mt-2">清理范围白名单：回归日志（保留最近 3 个）与未运行 profile 的浏览器数据；业务数据集合不参与清理。预览（dry-run）不会删除任何文件。</div>
    </div>
  );
}