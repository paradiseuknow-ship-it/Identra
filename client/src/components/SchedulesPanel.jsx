import React, { useEffect, useState, useCallback } from 'react';
import api from '../api';

// C17: 定时调度面板（CAP-M1 schedules 的 UI 出口）。
// 实体 = 任务模板 + profileIds[]（批量维度）+ intervalMs（周期）。
// 触发语义：每次到期/手动触发 = 每个 profileId 建一个独立 AI Task。

const inputCls = 'w-full bg-[#0F172A] border border-edge rounded px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-sky-500';

const EMPTY_FORM = {
  name: '', objective: '', targetUrl: '',
  profileIds: [], executionMode: 'ASSIST',
  intervalMin: 60, autoStart: true,
};

function fmtTs(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

function fmtInterval(ms) {
  const m = Math.round(ms / 60000);
  if (m >= 60 && m % 60 === 0) return (m / 60) + ' 小时';
  if (m >= 1) return m + ' 分钟';
  return Math.round(ms / 1000) + ' 秒';
}

export default function SchedulesPanel({ profiles, notify, requestConfirm }) {
  const [schedules, setSchedules] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [triggeringId, setTriggeringId] = useState(null);
  const [lastTrigger, setLastTrigger] = useState(null); // { name, taskIds, errors }

  const load = useCallback(async () => {
    try {
      const r = await api.listSchedules();
      setSchedules((r && r.schedules) || []);
    } catch (e) { notify('加载调度列表失败: ' + e.message, false); }
  }, [notify]);

  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  async function save() {
    if (!form.objective.trim() && !form.targetUrl.trim()) { notify('objective 或 targetUrl 至少填一项', false); return; }
    setSaving(true);
    try {
      await api.createSchedule({
        name: form.name.trim() || '定时任务',
        objective: form.objective.trim(),
        targetUrl: form.targetUrl.trim(),
        profileIds: form.profileIds,
        executionMode: form.executionMode,
        intervalMs: Math.max(1, Number(form.intervalMin) || 60) * 60000,
        autoStart: form.autoStart,
      });
      notify('定时任务已创建（默认 ACTIVE，到期自动触发）');
      setForm(EMPTY_FORM);
      setShowForm(false);
      await load();
    } catch (e) { notify('创建失败: ' + e.message, false); }
    finally { setSaving(false); }
  }

  async function trigger(s) {
    setTriggeringId(s.id);
    try {
      const r = await api.triggerSchedule(s.id);
      setLastTrigger({ name: s.name, taskIds: r.taskIds || [], errors: r.errors || [] });
      notify(`已触发「${s.name}」：创建 ${r.taskIds ? r.taskIds.length : 0} 个任务${r.errors && r.errors.length ? '，' + r.errors.length + ' 个失败' : ''}`, !(r.errors && r.errors.length));
      await load();
    } catch (e) { notify('触发失败: ' + e.message, false); }
    finally { setTriggeringId(null); }
  }

  async function toggleStatus(s) {
    try {
      await api.updateSchedule(s.id, { status: s.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' });
      notify(s.status === 'ACTIVE' ? '已暂停' : '已恢复');
      await load();
    } catch (e) { notify('操作失败: ' + e.message, false); }
  }

  function remove(s) {
    requestConfirm(`确认删除定时任务「${s.name}」？历史已创建的任务不受影响。`, async () => {
      try { await api.deleteSchedule(s.id); notify('已删除'); await load(); }
      catch (e) { notify('删除失败: ' + e.message, false); }
    });
  }

  const toggleProfile = (id) => {
    setForm((f) => ({
      ...f,
      profileIds: f.profileIds.includes(id) ? f.profileIds.filter((x) => x !== id) : [...f.profileIds, id],
    }));
  };

  return (
    <div className="max-w-5xl mx-auto space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">定时调度</h2>
          <p className="text-xs text-slate-500 mt-1">到周期后自动为每个勾选 Profile 创建独立 AI 任务（同 Profile 有互斥锁，不会并发抢占）。手动触发会顺延下一次周期。</p>
        </div>
        <button onClick={() => setShowForm(!showForm)} className="px-4 py-2 rounded bg-sky-600 hover:bg-sky-500 text-white text-sm whitespace-nowrap">
          {showForm ? '收起' : '+ 新建定时任务'}
        </button>
      </div>

      {lastTrigger && (
        <div className={`rounded border px-4 py-3 text-xs ${lastTrigger.errors.length ? 'border-amber-500/40 bg-amber-500/10 text-amber-300' : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'}`}>
          「{lastTrigger.name}」已触发：创建任务 {lastTrigger.taskIds.length} 个
          {lastTrigger.errors.length ? ' · 失败: ' + lastTrigger.errors.join('; ') : ''}（可在「AI 操作员」查看执行时间线）
          <button onClick={() => setLastTrigger(null)} className="ml-3 text-slate-400 hover:text-slate-200">关闭</button>
        </div>
      )}

      {showForm && (
        <div className="bg-panel/60 border border-edge rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-400 block mb-1">名称</label>
              <input className={inputCls} placeholder="例：每日签到巡检" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">执行间隔（分钟）</label>
              <input className={inputCls} type="number" min="1" value={form.intervalMin} onChange={(e) => setForm({ ...form, intervalMin: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">目标 URL（可选）</label>
            <input className={inputCls} placeholder="https://..." value={form.targetUrl} onChange={(e) => setForm({ ...form, targetUrl: e.target.value })} />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">任务目标 objective（自然语言，可选）</label>
            <textarea className={inputCls + ' min-h-[60px]'} placeholder="例：打开首页并确认登录状态正常" value={form.objective} onChange={(e) => setForm({ ...form, objective: e.target.value })} />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">执行 Profile（不选 = 无 Profile 执行；多选 = 批量）</label>
            <div className="flex flex-wrap gap-2">
              {profiles.map((p) => (
                <button key={p.id}
                  onClick={() => toggleProfile(p.id)}
                  className={`px-3 py-1 rounded text-xs border ${form.profileIds.includes(p.id) ? 'bg-sky-600 border-sky-500 text-white' : 'border-edge text-slate-300 hover:bg-edge'}`}>
                  {p.name}
                </button>
              ))}
              {!profiles.length && <span className="text-xs text-slate-500">（暂无 Profile）</span>}
            </div>
          </div>
          <div className="flex items-center gap-4">
            <label className="text-xs text-slate-400 flex items-center gap-2">
              执行模式
              <select className={inputCls + ' w-36'} value={form.executionMode} onChange={(e) => setForm({ ...form, executionMode: e.target.value })}>
                <option value="ASSIST">ASSIST</option>
                <option value="AUTONOMOUS">AUTONOMOUS</option>
              </select>
            </label>
            <label className="text-xs text-slate-400 flex items-center gap-2">
              <input type="checkbox" checked={form.autoStart} onChange={(e) => setForm({ ...form, autoStart: e.target.checked })} />
              创建后立即开始执行
            </label>
            <button disabled={saving} onClick={save} className="ml-auto px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm">创建</button>
          </div>
        </div>
      )}

      {/* 列表 */}
      <div className="space-y-2">
        {!schedules.length && <div className="text-sm text-slate-500 p-6 text-center border border-dashed border-edge rounded-lg">暂无定时任务——点击右上角「+ 新建定时任务」创建</div>}
        {schedules.map((s) => (
          <div key={s.id} className="bg-panel/60 border border-edge rounded-lg p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-slate-200">{s.name}</span>
                  <span className={`px-2 py-0.5 rounded text-xs ${s.status === 'ACTIVE' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-slate-500/15 text-slate-400'}`}>{s.status}</span>
                  <span className="text-xs text-slate-500">每 {fmtInterval(s.intervalMs)} · 已跑 {s.runCount || 0} 次 · {s.profileIds.length ? s.profileIds.length + ' 个 Profile' : '无 Profile'}</span>
                </div>
                {(s.objective || s.targetUrl) && <div className="text-xs text-slate-400 mt-1 truncate">{s.targetUrl ? s.targetUrl + ' · ' : ''}{s.objective}</div>}
                <div className="text-xs text-slate-500 mt-1">下次触发: {fmtTs(s.nextRunAt)} · 上次: {fmtTs(s.lastRunAt)}</div>
                {s.lastRunErrors && s.lastRunErrors.length > 0 && (
                  <div className="text-xs text-amber-400 mt-1">上次触发失败: {s.lastRunErrors.join('; ')}</div>
                )}
              </div>
              <div className="flex gap-2 shrink-0">
                <button disabled={triggeringId === s.id || s.status !== 'ACTIVE'}
                  onClick={() => trigger(s)}
                  className="px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white text-xs">立即触发</button>
                <button onClick={() => toggleStatus(s)} className="px-3 py-1.5 rounded border border-edge hover:bg-edge text-slate-300 text-xs">{s.status === 'ACTIVE' ? '暂停' : '恢复'}</button>
                <button onClick={() => remove(s)} className="px-3 py-1.5 rounded border border-rose-500/40 text-rose-400 hover:bg-rose-500/10 text-xs">删除</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
