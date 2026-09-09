import React, { useCallback, useEffect, useState } from 'react';
import api from '../api';
import { useEscapeClose } from '../lib/useEscapeClose.mjs';
import { humanStatus, humanMode } from '../ui/kit';
import { IconChevron } from '../ui/icons';

// Goal-first 任务创建流：第一层只有一个问题「你希望 AI 做什么？」
// Profile / 执行模式等工程选项折叠进「高级选项」；生成计划后原地预览 → 一键开始执行。
// API 面：aiChat（复用既有规划链）→ aiStartTask，零新增后端。
// C87：错误反馈走应用内 toast（C70 红线：原生 alert 全库禁用，本文件是最后残留点）；
//      Escape 与 backdrop 同守卫（busy/starting 中不允许掐断弹层）。

export default function NewTaskModal({ profiles, notify, onClose, onCreated }) {
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [profileId, setProfileId] = useState('');
  const [mode, setMode] = useState('AUTONOMOUS');
  const [preview, setPreview] = useState(null); // { taskId, plan, status, sessionId }
  const [planError, setPlanError] = useState(''); // C97：规划失败持久化内联展示（toast 闪逝导致用户以为无响应）
  const [starting, setStarting] = useState(false);
  const guardedClose = useCallback(
    () => { if (!busy && !starting) onClose(); },
    [busy, starting, onClose]
  );
  useEscapeClose(true, guardedClose);

  // 无 profile 时默认禁用（AI 任务必须绑定一个浏览器环境）
  useEffect(() => { if (profiles.length === 1) setProfileId(profiles[0].id); }, [profiles]);

  const plan = async () => {
    if (!goal.trim()) return;
    setBusy(true);
    setPlanError('');
    try {
      const r = await api.aiChat({ message: goal.trim(), profileId: profileId || undefined, executionMode: mode });
      setPreview(r);
    } catch (e) {
      setPlanError(e.message || String(e)); // C97：错误常驻弹层，直到下一次重试
      notify('规划失败: ' + e.message, false);
    }
    finally { setBusy(false); }
  };

  const start = async () => {
    setStarting(true);
    try {
      await api.aiStartTask(preview.taskId);
      onCreated(preview.taskId);
    } catch (e) { notify('启动失败: ' + e.message, false); setStarting(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 pt-[10vh]" onClick={guardedClose}>
      <div className="w-[560px] max-w-[92vw] card shadow-2xl fade-up" onClick={(e) => e.stopPropagation()}>
        {!preview ? (
          <div className="p-6">
            <div className="text-lg font-medium text-slate-100">你希望 AI 做什么？</div>
            <textarea
              autoFocus
              className="inp mt-4 min-h-[96px] resize-y"
              placeholder="例如：打开 xxx.com，注册一个新账号并登录，完成后告诉我结果"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) plan(); }}
            />
            <div className="mt-2 text-[11px] text-slate-600">⌘/Ctrl + Enter 生成计划</div>

            {busy && (
              <div className="mt-4 flex items-center gap-2 text-xs text-sky-300">
                <span className="inline-block w-3 h-3 rounded-full border-2 border-sky-400/40 border-t-sky-300 animate-spin" />
                正在规划中，通常需要几秒到半分钟，请勿关闭弹层…
              </div>
            )}
            {!busy && planError && (
              <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                <div className="text-xs font-medium text-amber-300 mb-1">规划失败</div>
                <div className="text-xs text-slate-300 leading-relaxed break-words">{planError}</div>
                <div className="text-[11px] text-slate-500 mt-1.5">可修改目标或环境后重新点击「生成计划」重试。</div>
              </div>
            )}

            <button onClick={() => setAdvanced(!advanced)} className="mt-4 inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300">
              <span style={{ display: 'inline-flex', transform: advanced ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}><IconChevron size={12} /></span>
              高级选项
            </button>
            {advanced && (
              <div className="mt-3 space-y-3 rounded-lg border border-edge p-3.5">
                <label className="block">
                  <span className="label">使用哪个浏览器环境</span>
                  <select className="inp" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
                    <option value="">自动选择</option>
                    {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="label">执行模式</span>
                  <select className="inp" value={mode} onChange={(e) => setMode(e.target.value)}>
                    <option value="AUTONOMOUS">自主模式 — AI 全程执行，高风险动作才询问</option>
                    <option value="ASSIST">协助模式 — 每一步都需要你确认</option>
                    <option value="SIMULATION">演练模式 — 只规划不执行</option>
                    <option value="DEBUG">调试模式</option>
                  </select>
                </label>
              </div>
            )}

            <div className="flex justify-end gap-2 mt-6">
              <button onClick={onClose} className="btn btn-ghost">取消</button>
              <button onClick={plan} disabled={busy || !goal.trim()} className="btn btn-primary px-4">
                {busy ? '正在规划…' : '生成计划'}
              </button>
            </div>
          </div>
        ) : (
          <div className="p-6">
            <div className="text-[11px] tracking-widest text-slate-500 uppercase mb-2">执行计划预览</div>
            <div className="text-sm text-slate-200">{preview.plan?.goal || goal}</div>
            <div className="mt-4 space-y-2">
              {(preview.plan?.steps || []).map((s, i) => (
                <div key={s.id || i} className="flex items-start gap-2.5 text-xs">
                  <span className="w-5 h-5 rounded-full border border-edge text-slate-500 flex items-center justify-center shrink-0 tabular-nums">{i + 1}</span>
                  <span className="text-slate-300 flex-1">{s.description}</span>
                  {s.risk && <span className={`shrink-0 ${s.risk === 'LOW' ? 'text-slate-600' : s.risk === 'HIGH' || s.risk === 'CRITICAL' ? 'text-amber-400' : 'text-slate-500'}`}>{s.risk}</span>}
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button onClick={() => setPreview(null)} disabled={starting} className="btn btn-ghost">返回修改</button>
              <button onClick={start} disabled={starting} className="btn btn-primary px-4">
                {starting ? '启动中…' : '开始执行'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
