import React, { useEffect, useState, useCallback } from 'react';
import api from '../api';

const EMPTY_FORM = {
  name: '', description: '', os: '', browser: '',
  timezone: '', language: '',
  screenW: '', screenH: '', pixelRatio: '',
  hardwareConcurrency: '', deviceMemory: '',
};

// 表单 → API payload（空串 = 不约束，删除键）
function formToPayload(f) {
  const o = {};
  if (f.timezone.trim()) o.timezone = f.timezone.trim();
  if (f.language.trim()) o.language = f.language.trim();
  const sw = Number(f.screenW), sh = Number(f.screenH), pr = Number(f.pixelRatio);
  if (sw || sh || pr) {
    o.screen = {};
    if (sw) o.screen.width = sw;
    if (sh) o.screen.height = sh;
    if (pr) o.screen.pixelRatio = pr;
  }
  const hc = Number(f.hardwareConcurrency);
  if (hc) o.hardwareConcurrency = hc;
  const dm = Number(f.deviceMemory);
  if (dm) o.deviceMemory = dm;
  return {
    name: f.name.trim(),
    description: f.description,
    os: f.os || null,
    browser: f.browser || null,
    fingerprintOverride: o,
  };
}

function templateToForm(t) {
  const o = (t && t.fingerprintOverride) || {};
  return {
    name: t.name || '', description: t.description || '',
    os: t.os || '', browser: t.browser || '',
    timezone: o.timezone || '', language: o.language || '',
    screenW: (o.screen && o.screen.width) || '', screenH: (o.screen && o.screen.height) || '',
    pixelRatio: (o.screen && o.screen.pixelRatio) || '',
    hardwareConcurrency: o.hardwareConcurrency || '', deviceMemory: o.deviceMemory || '',
  };
}

function pinnedSummary(t) {
  const o = (t && t.fingerprintOverride) || {};
  const parts = [];
  if (t.os) parts.push(`os=${t.os}`);
  if (t.browser) parts.push(`browser=${t.browser}`);
  if (o.timezone) parts.push(`tz=${o.timezone}`);
  if (o.language) parts.push(`lang=${o.language}`);
  if (o.screen && o.screen.width) parts.push(`${o.screen.width}x${o.screen.height || '?'}@${o.screen.pixelRatio || '?'}x`);
  if (o.hardwareConcurrency) parts.push(`cores=${o.hardwareConcurrency}`);
  if (o.deviceMemory) parts.push(`mem=${o.deviceMemory}GB`);
  return parts.length ? parts.join(' · ') : '（无钉住字段——仅基线约束）';
}

export default function TemplatesPanel({ notify, requestConfirm }) {
  const [templates, setTemplates] = useState([]);
  const [editing, setEditing] = useState(null); // null | 'new' | template object
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [checkResult, setCheckResult] = useState(null); // { tpl, report } | null
  const [checkingId, setCheckingId] = useState(null);
  const [batching, setBatching] = useState(null); // { tpl, count, namePrefix } | null

  const load = useCallback(async () => {
    try { setTemplates(await api.listTemplates()); } catch (e) { notify(e.message, false); }
  }, [notify]);
  useEffect(() => { load(); }, [load]);

  const openNew = () => { setForm(EMPTY_FORM); setEditing('new'); };
  const openEdit = (t) => { setForm(templateToForm(t)); setEditing(t); };

  const save = async () => {
    if (!form.name.trim()) return notify('模板名必填', false);
    setSaving(true);
    try {
      const payload = formToPayload(form);
      if (editing === 'new') { await api.createTemplate(payload); notify('模板已创建'); }
      else { await api.updateTemplate(editing.id, payload); notify('模板已更新'); }
      setEditing(null);
      await load();
    } catch (e) { notify(e.message, false); }
    finally { setSaving(false); }
  };

  const remove = (t) => {
    requestConfirm(`确认删除模板「${t.name}」？已引用的 profile 指纹不受影响（悬挂引用）。`, async () => {
      try { await api.deleteTemplate(t.id); await load(); notify('已删除'); }
      catch (e) { notify(e.message, false); }
    });
  };

  const runCheck = async (t) => {
    setCheckingId(t.id);
    try { setCheckResult({ tpl: t, report: await api.checkTemplate(t.id) }); }
    catch (e) { notify(e.message, false); }
    finally { setCheckingId(null); }
  };

  const runBatch = async () => {
    const count = Number(batching.count);
    if (!Number.isInteger(count) || count < 1 || count > 50) return notify('count 必须是 1-50 的整数', false);
    try {
      const r = await api.batchCreateProfiles({ count, namePrefix: batching.namePrefix || batching.tpl.name, templateId: batching.tpl.id });
      notify(`批量建号完成: 成功 ${r.created ? r.created.length : 0} / 失败 ${r.errors ? r.errors.length : 0}`);
      setBatching(null);
    } catch (e) { notify(e.message, false); }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">指纹模板（{templates.length}）</h2>
        <button onClick={openNew} className="px-3 py-1.5 rounded bg-sky-600 text-white text-sm hover:bg-sky-500">+ 新建模板</button>
      </div>
      <div className="text-xs text-slate-500 mb-4">模板钉住稳定字段（同形），每个 profile 由独立 seed 派生噪声字段（不同样）。</div>

      <div className="space-y-2">
        {templates.map((t) => (
          <div key={t.id} className="rounded border border-edge bg-panel px-4 py-3 text-sm">
            <div className="flex items-start justify-between">
              <div className="min-w-0">
                <div className="font-medium">{t.name}</div>
                {t.description && <div className="text-xs text-slate-500 mt-0.5">{t.description}</div>}
                <div className="text-xs text-slate-400 mt-1 font-mono">{pinnedSummary(t)}</div>
              </div>
              <div className="flex gap-2 shrink-0 ml-3">
                <button onClick={() => runBatch(t)} className="px-2 py-1 rounded bg-emerald-600/80 hover:bg-emerald-600 text-white text-xs">建号</button>
                <button onClick={() => runCheck(t)} disabled={checkingId === t.id}
                  className="px-2 py-1 rounded bg-edge hover:bg-slate-700 text-xs disabled:opacity-50">
                  {checkingId === t.id ? '体检中…' : '体检'}
                </button>
                <button onClick={() => openEdit(t)} className="px-2 py-1 rounded bg-edge hover:bg-slate-700 text-xs">编辑</button>
                <button onClick={() => remove(t)} className="px-2 py-1 rounded bg-edge hover:bg-rose-700 text-rose-300 text-xs">删除</button>
              </div>
            </div>
          </div>
        ))}
        {templates.length === 0 && <div className="text-slate-500 text-sm">暂无模板</div>}
      </div>

      {/* 创建/编辑弹窗 */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => !saving && setEditing(null)}>
          <div className="w-[520px] max-h-[80vh] overflow-auto rounded-lg border border-edge bg-panel p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="font-medium mb-4">{editing === 'new' ? '新建模板' : `编辑模板 — ${editing.name}`}</div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <label className="col-span-2 block">
                <span className="text-slate-400 text-xs">模板名 *（1-60 字符）</span>
                <input className="inp w-full mt-1" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </label>
              <label className="col-span-2 block">
                <span className="text-slate-400 text-xs">描述</span>
                <input className="inp w-full mt-1" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </label>
              <label className="block">
                <span className="text-slate-400 text-xs">OS 约束</span>
                <select className="inp w-full mt-1" value={form.os} onChange={(e) => setForm({ ...form, os: e.target.value })}>
                  <option value="">不约束（按池随机）</option>
                  <option value="windows">windows</option>
                  <option value="macos">macos</option>
                  <option value="linux">linux</option>
                </select>
              </label>
              <label className="block">
                <span className="text-slate-400 text-xs">浏览器约束</span>
                <select className="inp w-full mt-1" value={form.browser} onChange={(e) => setForm({ ...form, browser: e.target.value })}>
                  <option value="">不约束</option>
                  <option value="chrome">chrome</option>
                </select>
              </label>
              <label className="block">
                <span className="text-slate-400 text-xs">时区（IANA，留空不约束）</span>
                <input className="inp w-full mt-1" placeholder="Asia/Shanghai" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
              </label>
              <label className="block">
                <span className="text-slate-400 text-xs">语言（留空不约束）</span>
                <input className="inp w-full mt-1" placeholder="zh-CN" value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })} />
              </label>
              <label className="block">
                <span className="text-slate-400 text-xs">屏幕宽</span>
                <input type="number" className="inp w-full mt-1" value={form.screenW} onChange={(e) => setForm({ ...form, screenW: e.target.value })} />
              </label>
              <label className="block">
                <span className="text-slate-400 text-xs">屏幕高</span>
                <input type="number" className="inp w-full mt-1" value={form.screenH} onChange={(e) => setForm({ ...form, screenH: e.target.value })} />
              </label>
              <label className="block">
                <span className="text-slate-400 text-xs">pixelRatio（1-10）</span>
                <input type="number" step="0.5" className="inp w-full mt-1" value={form.pixelRatio} onChange={(e) => setForm({ ...form, pixelRatio: e.target.value })} />
              </label>
              <label className="block">
                <span className="text-slate-400 text-xs">CPU 核数（1-64）</span>
                <input type="number" className="inp w-full mt-1" value={form.hardwareConcurrency} onChange={(e) => setForm({ ...form, hardwareConcurrency: e.target.value })} />
              </label>
              <label className="block">
                <span className="text-slate-400 text-xs">内存（1/2/4/8 GB）</span>
                <select className="inp w-full mt-1" value={form.deviceMemory} onChange={(e) => setForm({ ...form, deviceMemory: e.target.value })}>
                  <option value="">不约束</option>
                  <option value="1">1</option>
                  <option value="2">2</option>
                  <option value="4">4</option>
                  <option value="8">8</option>
                </select>
              </label>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setEditing(null)} disabled={saving} className="px-3 py-1.5 rounded bg-edge hover:bg-slate-700 text-slate-200 text-sm">取消</button>
              <button onClick={save} disabled={saving} className="px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white text-sm disabled:opacity-50">
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 模板体检结果弹窗 */}
      {checkResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setCheckResult(null)}>
          <div className="w-[560px] max-h-[70vh] overflow-auto rounded-lg border border-edge bg-panel p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <div className="font-medium">
                模板体检 — {checkResult.tpl.name}
                <span className={`ml-2 px-2 py-0.5 rounded text-xs ${checkResult.report.warning === 0 ? 'bg-emerald-600/30 text-emerald-300' : 'bg-amber-600/30 text-amber-300'}`}>
                  通过 {checkResult.report.pass} / 警告 {checkResult.report.warning}
                </span>
              </div>
              <button onClick={() => setCheckResult(null)} className="text-slate-400 hover:text-slate-200">✕</button>
            </div>
            <div className="space-y-2 text-xs">
              {checkResult.report.checked === 0 && <div className="text-slate-500">该模板名下暂无 profile。</div>}
              {(checkResult.report.details || []).map((d) => (
                <div key={d.profileId} className="rounded border border-edge px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className={d.pass ? 'text-emerald-400' : 'text-amber-400'}>{d.pass ? '✓' : '⚠'}</span>
                    <span className="text-slate-200">{d.name}</span>
                    <span className={`ml-auto px-1.5 py-0.5 rounded ${d.pass ? 'bg-emerald-600/20 text-emerald-300' : 'bg-amber-600/20 text-amber-300'}`}>{d.status}</span>
                  </div>
                  {(d.failed || []).length > 0 && (
                    <div className="mt-1 pl-6 text-amber-400/90 font-mono">{d.failed.map((f, i) => <div key={i}>{f}</div>)}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 从模板批量建号弹窗 */}
      {batching && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setBatching(null)}>
          <div className="w-96 rounded-lg border border-edge bg-panel p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="font-medium mb-4">从模板建号 — {batching.tpl.name}</div>
            <div className="space-y-3 text-sm">
              <label className="block">
                <span className="text-slate-400 text-xs">数量（1-50）</span>
                <input type="number" min="1" max="50" className="inp w-full mt-1" value={batching.count}
                  onChange={(e) => setBatching({ ...batching, count: e.target.value })} />
              </label>
              <label className="block">
                <span className="text-slate-400 text-xs">名称前缀（默认 = 模板名）</span>
                <input className="inp w-full mt-1" value={batching.namePrefix}
                  onChange={(e) => setBatching({ ...batching, namePrefix: e.target.value })} />
              </label>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setBatching(null)} className="px-3 py-1.5 rounded bg-edge hover:bg-slate-700 text-slate-200 text-sm">取消</button>
              <button onClick={runBatch} className="px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white text-sm">创建</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
