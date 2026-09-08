import React, { useEffect, useState, useCallback } from 'react';
import api from '../api';

// C26: 治理中心（API Key / 审计日志 / 工作空间与成员）。
// 缺口背景：/api/auth 下的 api-keys、audit、workspaces 三族端点此前 client 零消费
// （README 宣称的「多用户 / RBAC / 审计」在 UI 上完全不可达）。
// 语义对齐：
//   - API Key 明文只在创建响应出现一次，UI 必须「一次性展示 + 之后不可再取」；
//   - 审计为只读 + 导出，绝不提供写入/删除（合规流的不可篡改性）；
//   - 成员角色 OWNER 授予需 workspace:update，服务端会 403，UI 仅提示不做本地绕过判断。

const ROLES = ['MEMBER', 'ADMIN', 'OWNER'];
const SECRET_TYPES = ['email_password', 'api_key', 'payment', 'oauth_token', 'cookie', 'license', 'ssh_key', 'other'];

function download(name, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

const fmtTime = (t) => (t ? new Date(t).toLocaleString() : '—');

export default function GovernancePanel({ notify, requestConfirm }) {
  // C66：requestConfirm 是 callback 式（message, onConfirm）且无返回值；旧实现把
  // confirm 式签名（await boolean）叠在它上面 → `await confirmIt(...)` 恒 undefined →
  // 撤销 API Key / 删除凭据引用确认后永远静默 return（按钮点了没反应）。
  // 改为 callback 桥接：有 requestConfirm 走应用内确认弹窗；否则回退原生 confirm
  // （仅组件单测/独立渲染场景可达，正常 App 挂载恒走应用内弹窗）。
  const confirmIt = (msg, onConfirm) => {
    if (requestConfirm) requestConfirm(msg, onConfirm);
    else if (window.confirm(msg)) onConfirm();
  };

  const [me, setMe] = useState(null);
  const [keys, setKeys] = useState([]);
  const [newKey, setNewKey] = useState(null); // 一次性明文
  const [keyForm, setKeyForm] = useState({ name: '', readOnly: false });

  const [audit, setAudit] = useState({ entries: [], total: 0 });
  const [filter, setFilter] = useState({ action: '', resourceType: '', actorId: '', limit: 200 });

  const [workspaces, setWorkspaces] = useState([]);
  const [wsId, setWsId] = useState('');
  const [members, setMembers] = useState([]);
  const [wsName, setWsName] = useState('');
  const [memberForm, setMemberForm] = useState({ username: '', role: 'MEMBER' });

  // C35 凭据引用（credentialRef）：引用注册表，明文只在 Profile 编辑器 Account 页签维护
  const [secrets, setSecrets] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [secretForm, setSecretForm] = useState({ profileId: '', type: 'email_password', site: '', label: '' });

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const loadKeys = useCallback(async () => {
    try { setKeys((await api.apiKeys()).keys || []); } catch (e) { setErr(String(e.message || e)); }
  }, []);

  const loadAudit = useCallback(async () => {
    try {
      const qs = '?' + new URLSearchParams(
        Object.entries(filter).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)])
      ).toString();
      const r = await api.auditLog(qs);
      setAudit({ entries: r.entries || [], total: r.total || 0 });
    } catch (e) { setErr(String(e.message || e)); }
  }, [filter]);

  const loadWs = useCallback(async () => {
    try {
      const [m, w] = await Promise.all([api.me(), api.workspaces()]);
      setMe(m.user || null);
      const list = w.workspaces || [];
      setWorkspaces(list);
      if (!wsId && list.length) setWsId(m.workspaceId || list[0].id);
    } catch (e) { setErr(String(e.message || e)); }
  }, [wsId]);

  const loadMembers = useCallback(async () => {
    if (!wsId) return setMembers([]);
    try { setMembers((await api.workspaceMembers(wsId)).members || []); }
    catch (e) { setErr(String(e.message || e)); }
  }, [wsId]);

  // C35 凭据引用加载（列表为脱敏视图，永远不含明文）+ Profile 下拉数据
  const loadSecrets = useCallback(async () => {
    try {
      const r = await api.listSecrets();
      setSecrets(Array.isArray(r) ? r : (r.secrets || []));
    } catch (e) { setErr(String(e.message || e)); }
  }, []);
  const loadProfilesLite = useCallback(async () => {
    try { setProfiles(await api.listProfiles()); } catch (e) { /* 下拉置空不影响面板 */ }
  }, []);

  useEffect(() => { loadKeys(); loadWs(); loadSecrets(); loadProfilesLite(); }, [loadKeys, loadWs, loadSecrets, loadProfilesLite]);
  useEffect(() => { loadAudit(); }, [loadAudit]);
  useEffect(() => { loadMembers(); }, [loadMembers]);

  const createKey = async () => {
    if (!keyForm.name.trim()) return notify('请填写 Key 名称', false);
    setBusy(true);
    try {
      const r = await api.createApiKey({ name: keyForm.name.trim(), readOnly: !!keyForm.readOnly });
      setNewKey(r.key);
      setKeyForm({ name: '', readOnly: false });
      notify('API Key 已创建，请立即保存明文（仅此一次）');
      await loadKeys();
    } catch (e) { notify(e.message, false); }
    finally { setBusy(false); }
  };

  const revokeKey = (k) => {
    confirmIt(`撤销 API Key「${k.name}」？使用该 Key 的客户端将立即失效（不可恢复）。`, async () => {
      setBusy(true);
      try { await api.revokeApiKey(k.id); notify('已撤销'); await loadKeys(); await loadAudit(); }
      catch (e) { notify(e.message, false); }
      finally { setBusy(false); }
    });
  };

  const exportAudit = async () => {
    try {
      const qs = '?' + new URLSearchParams(
        Object.entries(filter).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)])
      ).toString();
      const r = await api.auditExport(qs);
      download('fpb-audit-export.json', JSON.stringify(r, null, 2));
      notify('审计日志已导出');
    } catch (e) { notify(e.message, false); }
  };

  const createWs = async () => {
    if (!wsName.trim()) return notify('请填写工作空间名称', false);
    setBusy(true);
    try {
      const r = await api.createWorkspace({ name: wsName.trim() });
      setWsName('');
      notify('工作空间已创建');
      setWsId('');
      await loadWs();
      if (r.workspace) setWsId(r.workspace.id);
    } catch (e) { notify(e.message, false); }
    finally { setBusy(false); }
  };

  const addMember = async () => {
    if (!memberForm.username.trim()) return notify('请填写用户名', false);
    setBusy(true);
    try {
      await api.addWorkspaceMember(wsId, { username: memberForm.username.trim(), role: memberForm.role });
      setMemberForm({ username: '', role: 'MEMBER' });
      notify('成员已添加');
      await loadMembers();
    } catch (e) { notify(e.message, false); }
    finally { setBusy(false); }
  };

  // C35：注册凭据引用（只登记 profileId+type+site+label，绝不经过明文）
  const createSecretRef = async () => {
    if (!secretForm.profileId) return notify('请选择 Profile', false);
    setBusy(true);
    try {
      await api.createSecret({
        profileId: secretForm.profileId,
        type: secretForm.type,
        site: secretForm.site.trim() || undefined,
        label: secretForm.label.trim() || undefined,
      });
      setSecretForm({ profileId: '', type: secretForm.type, site: '', label: '' });
      notify('凭据引用已注册');
      await loadSecrets();
    } catch (e) { notify(e.message, false); }
    finally { setBusy(false); }
  };
  const removeSecretRef = (s) => {
    confirmIt('删除凭据引用 ' + (s.id || '') + '？（只删除引用，不影响 Profile 内已存的明文）', async () => {
      setBusy(true);
      try { await api.deleteSecret(s.id); notify('已删除'); await loadSecrets(); }
      catch (e) { notify(e.message, false); }
      finally { setBusy(false); }
    });
  };

  return (
    <div className="space-y-4">
      {err && <div className="text-xs text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded px-3 py-2">{err}</div>}

      {/* API Keys */}
      <div className="bg-panel/60 border border-edge rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-slate-200">API Keys（{keys.length}）</span>
          <div className="flex items-center gap-2 text-xs">
            <input className="px-2 py-1 rounded bg-black/30 border border-edge text-slate-200"
              placeholder="Key 名称" value={keyForm.name}
              onChange={(e) => setKeyForm({ ...keyForm, name: e.target.value })} />
            <label className="flex items-center gap-1 text-slate-400">
              <input type="checkbox" checked={keyForm.readOnly}
                onChange={(e) => setKeyForm({ ...keyForm, readOnly: e.target.checked })} />只读
            </label>
            <button disabled={busy} onClick={createKey}
              className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white">创建</button>
          </div>
        </div>

        {newKey && (
          <div className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
            <div className="text-amber-300 font-semibold mb-1">⚠️ 明文仅出现这一次，关闭后无法再次获取</div>
            <div className="font-mono break-all text-slate-200 select-all">{newKey}</div>
            <div className="flex gap-2 mt-2">
              <button onClick={() => { navigator.clipboard.writeText(newKey); notify('已复制到剪贴板'); }}
                className="px-2 py-0.5 rounded border border-edge hover:bg-edge text-slate-300">复制</button>
              <button onClick={() => setNewKey(null)} className="px-2 py-0.5 rounded border border-edge hover:bg-edge text-slate-400">我已保存，关闭</button>
            </div>
          </div>
        )}

        <div className="space-y-1 max-h-52 overflow-auto">
          {keys.map((k) => (
            <div key={k.id} className="flex items-center justify-between rounded border border-edge px-3 py-1.5 text-xs">
              <div className="min-w-0">
                <span className="text-slate-200">{k.name}</span>
                <span className="ml-2 font-mono text-slate-500">{k.prefix}…</span>
                {k.readOnly && <span className="ml-2 px-1.5 py-0.5 rounded bg-slate-500/15 text-slate-400">只读</span>}
                {k.lastUsedAt && <span className="ml-2 text-slate-500">最近使用 {fmtTime(k.lastUsedAt)}</span>}
              </div>
              <button disabled={busy} onClick={() => revokeKey(k)}
                className="px-2 py-0.5 rounded border border-rose-500/40 text-rose-400 hover:bg-rose-500/10 disabled:opacity-40">撤销</button>
            </div>
          ))}
          {!keys.length && <div className="text-slate-500 text-xs">暂无 API Key。创建的 Key 可用于脚本/CLI 访问本服务。</div>}
        </div>
      </div>

      {/* 审计日志 */}
      <div className="bg-panel/60 border border-edge rounded-lg p-4">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <span className="text-sm font-semibold text-slate-200">审计日志（{audit.total}）</span>
          <div className="flex items-center gap-2 text-xs">
            <input className="px-2 py-1 rounded bg-black/30 border border-edge text-slate-200 w-32"
              placeholder="action" value={filter.action}
              onChange={(e) => setFilter({ ...filter, action: e.target.value })} />
            <input className="px-2 py-1 rounded bg-black/30 border border-edge text-slate-200 w-32"
              placeholder="resourceType" value={filter.resourceType}
              onChange={(e) => setFilter({ ...filter, resourceType: e.target.value })} />
            <input className="px-2 py-1 rounded bg-black/30 border border-edge text-slate-200 w-32"
              placeholder="actorId" value={filter.actorId}
              onChange={(e) => setFilter({ ...filter, actorId: e.target.value })} />
            <button onClick={loadAudit} className="px-2 py-1 rounded border border-edge hover:bg-edge text-slate-300">查询</button>
            <button onClick={exportAudit} className="px-2 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white">导出 JSON</button>
          </div>
        </div>
        <div className="overflow-auto max-h-72">
          <table className="w-full text-xs">
            <thead className="text-slate-500 text-left">
              <tr><th className="py-1">时间</th><th>操作者</th><th>动作</th><th>资源</th><th>资源 ID</th><th>详情</th></tr>
            </thead>
            <tbody>
              {audit.entries.map((e) => (
                <tr key={e.id} className="border-t border-edge/40 text-slate-300">
                  <td className="py-1 whitespace-nowrap text-slate-500">{fmtTime(e.at)}</td>
                  <td>{e.actorName || e.actorId || '—'}</td>
                  <td className="font-mono text-sky-300">{e.action}</td>
                  <td>{e.resourceType || '—'}</td>
                  <td className="font-mono text-slate-500">{e.resourceId || '—'}</td>
                  <td className="text-slate-500 max-w-xs truncate">{e.detail ? JSON.stringify(e.detail) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!audit.entries.length && <div className="text-slate-500 text-xs py-2">暂无审计记录。</div>}
        </div>
        <div className="text-[11px] text-slate-500 mt-2">审计流为只写不可篡改：UI 不提供删除/编辑入口；敏感字段（password/token/cookie…）落盘前已脱敏。</div>
      </div>

      {/* 工作空间与成员 */}
      <div className="bg-panel/60 border border-edge rounded-lg p-4">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <span className="text-sm font-semibold text-slate-200">
            工作空间与成员{me ? <span className="ml-2 text-xs text-slate-500">当前身份 {me.username}（{me.role || '—'}）</span> : null}
          </span>
          <div className="flex items-center gap-2 text-xs">
            <input className="px-2 py-1 rounded bg-black/30 border border-edge text-slate-200"
              placeholder="新工作空间名称" value={wsName}
              onChange={(e) => setWsName(e.target.value)} />
            <button disabled={busy} onClick={createWs}
              className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white">创建</button>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs mb-2">
          <select className="px-2 py-1 rounded bg-black/30 border border-edge text-slate-200"
            value={wsId} onChange={(e) => setWsId(e.target.value)}>
            {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}（{w.id}）</option>)}
          </select>
          <input className="px-2 py-1 rounded bg-black/30 border border-edge text-slate-200"
            placeholder="用户名" value={memberForm.username}
            onChange={(e) => setMemberForm({ ...memberForm, username: e.target.value })} />
          <select className="px-2 py-1 rounded bg-black/30 border border-edge text-slate-200"
            value={memberForm.role} onChange={(e) => setMemberForm({ ...memberForm, role: e.target.value })}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <button disabled={busy || !wsId} onClick={addMember}
            className="px-3 py-1 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white">添加成员</button>
        </div>

        <div className="space-y-1 max-h-40 overflow-auto">
          {members.map((m, i) => (
            <div key={m.userId || i} className="flex items-center justify-between rounded border border-edge px-3 py-1.5 text-xs">
              <span className="text-slate-200">{m.username}</span>
              <span className="px-1.5 py-0.5 rounded bg-slate-500/15 text-slate-400">{m.role}</span>
            </div>
          ))}
          {!members.length && <div className="text-slate-500 text-xs">该工作空间暂无其他成员记录。</div>}
        </div>
      </div>

      {/* C35 凭据引用（credentialRef）：AI 任务敏感字段只经引用解析，LLM 永不见明文 */}
      <div className="bg-panel/60 border border-edge rounded-lg p-4">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <span className="text-sm font-semibold text-slate-200">凭据引用（{secrets.length}）</span>
          <div className="flex items-center gap-2 text-xs flex-wrap">
            <select className="px-2 py-1 rounded bg-black/30 border border-edge text-slate-200 max-w-44"
              value={secretForm.profileId}
              onChange={(e) => setSecretForm({ ...secretForm, profileId: e.target.value })}>
              <option value="">选择 Profile…</option>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.name || p.id}</option>)}
            </select>
            <select className="px-2 py-1 rounded bg-black/30 border border-edge text-slate-200"
              value={secretForm.type}
              onChange={(e) => setSecretForm({ ...secretForm, type: e.target.value })}>
              {SECRET_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input className="px-2 py-1 rounded bg-black/30 border border-edge text-slate-200 w-28"
              placeholder="site（可选）" value={secretForm.site}
              onChange={(e) => setSecretForm({ ...secretForm, site: e.target.value })} />
            <input className="px-2 py-1 rounded bg-black/30 border border-edge text-slate-200 w-28"
              placeholder="备注（可选）" value={secretForm.label}
              onChange={(e) => setSecretForm({ ...secretForm, label: e.target.value })} />
            <button disabled={busy || !secretForm.profileId} onClick={createSecretRef}
              className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white">注册引用</button>
          </div>
        </div>

        <div className="space-y-1 max-h-44 overflow-auto">
          {secrets.map((s) => (
            <div key={s.id} className="flex items-center justify-between rounded border border-edge px-3 py-1.5 text-xs">
              <div className="min-w-0 flex flex-wrap items-center gap-2">
                <span className="font-mono text-sky-300">{s.id}</span>
                <span className="px-1.5 py-0.5 rounded bg-slate-500/15 text-slate-400">{s.type}</span>
                {s.site && <span className="text-slate-400">@{s.site}</span>}
                {s.label && <span className="text-slate-500">「{s.label}」</span>}
                <span className={s.available ? 'text-emerald-400' : 'text-rose-400'}>
                  {s.available ? '● 明文就绪' : '○ 明文未录'}
                </span>
                {s.maskedEmail && <span className="font-mono text-slate-500">{s.maskedEmail}</span>}
                {s.maskedCard && <span className="font-mono text-slate-500">{s.maskedCard}</span>}
              </div>
              <button disabled={busy} onClick={() => removeSecretRef(s)}
                className="px-2 py-0.5 rounded border border-rose-500/40 text-rose-400 hover:bg-rose-500/10 disabled:opacity-40">删除</button>
            </div>
          ))}
          {!secrets.length && <div className="text-slate-500 text-xs">暂无凭据引用。</div>}
        </div>

        <div className="text-[11px] text-slate-500 mt-2">
          引用只是「指针」：明文在对应 Profile 编辑器的 Account 页签维护（vault 加密落盘）。
          在 AI 对话中写 <span className="font-mono text-slate-400">cred_xxx</span> 即可让任务使用该凭据——模型全程只见脱敏视图，填表时明文才在执行层解密。
        </div>
      </div>
    </div>
  );
}
