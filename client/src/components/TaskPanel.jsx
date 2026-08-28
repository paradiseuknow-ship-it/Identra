import React, { useEffect, useState } from 'react';
import api from '../api';

export default function TaskPanel({ profiles, notify, onLog, requestConfirm }) {
  const [tasks, setTasks] = useState([]);
  const [editing, setEditing] = useState(null);
  const [running, setRunning] = useState(null);

  const load = async () => { try { setTasks(await api.listTasks()); } catch (e) { notify(e.message, false); } };
  useEffect(() => { load(); }, []);

  const run = async (task) => {
    // 选 profile
    const pid = prompt('输入要执行的配置 ID（从「配置管理」复制）：\n' + profiles.map((p) => `${p.name} -> ${p.id}`).join('\n'), task.profileId || '');
    if (!pid) return;
    setRunning(task.id);
    onLog([`▶ 开始执行: ${task.name} (${pid})`]);
    try {
      const r = await api.runAutomation({ profileId: pid, taskId: task.id });
      onLog([`${r.success ? '✔ 成功' : '✘ 失败'}`, ...(r.log || []), r.error ? '错误: ' + r.error : '', r.extracted ? '提取: ' + JSON.stringify(r.extracted) : '']);
      notify(r.success ? '执行完成' : '执行失败: ' + (r.error || ''), r.success);
    } catch (e) { onLog([e.message]); notify(e.message, false); }
    finally { setRunning(null); }
  };

  const remove = (id) => { requestConfirm('确认删除该任务？', () => { api.deleteTask(id); load(); }); };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">自动化任务（{tasks.length}）</h2>
        <button onClick={() => setEditing({ name: '', type: 'registration', profileId: '', config: { url: '', selectors: {} }, steps: [] })}
          className="px-3 py-1.5 rounded bg-sky-600 text-white text-sm hover:bg-sky-500">+ 新建任务</button>
      </div>

      <div className="space-y-2">
        {tasks.map((t) => (
          <div key={t.id} className="flex items-center justify-between rounded border border-edge bg-panel px-4 py-2 text-sm">
            <div>
              <span className="font-medium">{t.name}</span>
              <span className="text-slate-500 ml-2">[{t.type}] {t.config.url || '(自定义步骤)'}</span>
            </div>
            <div className="flex gap-2">
              <button onClick={() => run(t)} disabled={running === t.id}
                className="px-2 py-1 rounded bg-emerald-600/80 hover:bg-emerald-600 text-white disabled:opacity-50">
                {running === t.id ? '执行中…' : '运行'}
              </button>
              <button onClick={() => setEditing(t)} className="px-2 py-1 rounded bg-edge hover:bg-slate-700">编辑</button>
              <button onClick={() => remove(t.id)} className="px-2 py-1 rounded bg-edge hover:bg-rose-700 text-rose-300">删除</button>
            </div>
          </div>
        ))}
        {tasks.length === 0 && <div className="text-slate-500 text-sm">暂无任务。点「新建任务」创建一个注册/结账自动化。</div>}
      </div>

      {editing && (
        <TaskEditor task={editing} profiles={profiles} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
    </div>
  );
}

function TaskEditor({ task, profiles, onClose, onSaved }) {
  const [form, setForm] = useState(task);
  const [preview, setPreview] = useState([]);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const previewSteps = async () => {
    try { setPreview(await api.previewAutomation({ type: form.type, config: form.config })); }
    catch (e) { setPreview([{ error: e.message }]); }
  };

  const save = async () => {
    try {
      if (form.id) await api.updateTask(form.id, form);
      else await api.createTask(form);
      onSaved();
    } catch (e) { alert('保存失败: ' + e.message); }
  };

  const setSel = (k, v) => setForm((f) => ({ ...f, config: { ...f.config, selectors: { ...f.config.selectors, [k]: v } } }));

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center overflow-auto p-6 z-50">
      <div className="w-full max-w-2xl bg-panel border border-edge rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">编辑任务</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white">✕</button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <div className="text-xs text-slate-400 mb-1">任务名</div>
            <input className="inp" value={form.name} onChange={(e) => set('name', e.target.value)} />
          </label>
          <label className="block">
            <div className="text-xs text-slate-400 mb-1">类型</div>
            <select className="inp" value={form.type} onChange={(e) => set('type', e.target.value)}>
              <option value="registration">注册流程</option>
              <option value="checkout">结账/支付流程</option>
              <option value="custom">自定义步骤</option>
            </select>
          </label>
        </div>

        <div className="mt-3">
          <div className="text-xs text-slate-400 mb-1">目标网址 URL</div>
          <input className="inp" value={form.config.url} onChange={(e) => setForm((f) => ({ ...f, config: { ...f.config, url: e.target.value } }))} />
        </div>

        <div className="mt-3 text-xs text-slate-400">站点选择器（按目标站点填写，留空使用默认宽松选择器）</div>
        <div className="grid grid-cols-2 gap-2 mt-1">
          {form.type === 'registration' && <>
            <input className="inp" placeholder="邮箱选择器" value={form.config.selectors.email || ''} onChange={(e) => setSel('email', e.target.value)} />
            <input className="inp" placeholder="密码选择器" value={form.config.selectors.password || ''} onChange={(e) => setSel('password', e.target.value)} />
            <input className="inp" placeholder="确认密码(可选)" value={form.config.selectors.passwordConfirm || ''} onChange={(e) => setSel('passwordConfirm', e.target.value)} />
            <input className="inp" placeholder="提交按钮选择器" value={form.config.selectors.submit || ''} onChange={(e) => setSel('submit', e.target.value)} />
          </>}
          {form.type === 'checkout' && <>
            <input className="inp" placeholder="卡号选择器" value={form.config.selectors.cardNumber || ''} onChange={(e) => setSel('cardNumber', e.target.value)} />
            <input className="inp" placeholder="持卡人选择器" value={form.config.selectors.cardName || ''} onChange={(e) => setSel('cardName', e.target.value)} />
            <input className="inp" placeholder="有效期(MM/YY)选择器" value={form.config.selectors.expiry || ''} onChange={(e) => setSel('expiry', e.target.value)} />
            <input className="inp" placeholder="CVV 选择器" value={form.config.selectors.cvv || ''} onChange={(e) => setSel('cvv', e.target.value)} />
            <input className="inp" placeholder="邮编选择器(可选)" value={form.config.selectors.billingZip || ''} onChange={(e) => setSel('billingZip', e.target.value)} />
            <input className="inp" placeholder="支付按钮选择器" value={form.config.selectors.pay || ''} onChange={(e) => setSel('pay', e.target.value)} />
          </>}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button onClick={previewSteps} className="px-3 py-1.5 rounded bg-edge hover:bg-slate-700 text-sm">预览生成步骤</button>
          <span className="text-xs text-slate-500">{'值用占位符：邮箱={{email}} 密码={{password}} 卡号={{card.number}} CVV={{card.cvv}}，运行时从加密保险库注入。'}</span>
        </div>
        {preview.length > 0 && (
          <pre className="text-xs bg-black/40 rounded p-3 overflow-auto max-h-48 text-slate-300 mt-2">
{JSON.stringify(preview, null, 2)}
          </pre>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded bg-edge hover:bg-slate-700">取消</button>
          <button onClick={save} className="px-4 py-2 rounded bg-sky-600 hover:bg-sky-500">保存</button>
        </div>
      </div>
    </div>
  );
}
