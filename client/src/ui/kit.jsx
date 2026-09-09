import React from 'react';
import { t } from '../lib/i18n';

// 设计系统共享原语 + 领域语言映射（Progressive Disclosure 第一层：普通用户语言）。
// 工程字段（executionId/checkpointId/provider 等）一律留在各面板「查看详情」第二层。

/** 状态 → 普通用户语言（i18n：zh/en 随顶栏切换） */
export const humanStatus = (s) => t('st.' + s, s);

/** 执行模式 → 普通用户语言 */
export const humanMode = (m) => t('mode.' + m, m);

/** 状态 → { 文字色, 点色, 极轻背景 }（状态色只用于点/文字/极轻背景，不染整卡） */
export const statusTone = (s) => ({
  RUNNING: { text: 'text-emerald-400', dot: 'bg-emerald-400', bg: 'bg-emerald-500/10', live: true },
  SUCCESS: { text: 'text-emerald-400', dot: 'bg-emerald-400' },
  FAILED: { text: 'text-rose-400', dot: 'bg-rose-400' },
  PAUSED_FOR_HUMAN: { text: 'text-amber-400', dot: 'bg-amber-400', bg: 'bg-amber-500/10' },
  HEALING: { text: 'text-teal-300', dot: 'bg-teal-300', live: true },
  RECOVERING: { text: 'text-teal-300', dot: 'bg-teal-300', live: true },
  PLANNING: { text: 'text-sky-400', dot: 'bg-sky-400', live: true },
  PREPARING: { text: 'text-sky-400', dot: 'bg-sky-400', live: true },
  BROWSER_READY: { text: 'text-sky-400', dot: 'bg-sky-400', live: true },
  PROFILE_READY: { text: 'text-sky-400', dot: 'bg-sky-400', live: true },
  PENDING: { text: 'text-slate-400', dot: 'bg-slate-500' },
  CANCELLED: { text: 'text-slate-500', dot: 'bg-slate-600' },
}[s] || { text: 'text-slate-400', dot: 'bg-slate-500' });

/** 状态点（live 状态带呼吸动画） */
export function StatusDot({ tone, live }) {
  return (
    <span className="relative inline-flex shrink-0 w-2 h-2">
      <span className={`w-2 h-2 rounded-full ${tone.dot}`} />
      {live && <span className={`absolute inset-0 rounded-full ${tone.dot} animate-ping opacity-60`} />}
    </span>
  );
}

/** 状态 pill */
export function StatusPill({ status, tone }) {
  const t = tone || statusTone(status);
  return (
    <span className={`pill ${t.bg || ''} ${t.text}`}>
      <StatusDot tone={t} live={t.live} />
      {humanStatus(status)}
    </span>
  );
}

/** 地理位置 → 人话（C92：坐标缺失/NaN 逐字段兜底，绝不因对抗性指纹形状崩渲染） */
export function fmtGeo(geo) {
  if (!geo || typeof geo !== 'object') return '—';
  const num = (v) => (Number.isFinite(v) ? v.toFixed(2) : '-');
  return `[${geo.mode || 'random'}] ${num(geo.lat)}, ${num(geo.lng)}`;
}

/** 面板内小节标题 */
export function SectionTitle({ children, action }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h3 className="text-[13px] font-medium text-slate-300">{children}</h3>
      {action}
    </div>
  );
}

/** 空状态：一句话 + 可选动作，不铺插画 */
export function EmptyState({ title, hint, action }) {
  return (
    <div className="card flex flex-col items-center justify-center text-center px-6 py-12">
      <div className="text-sm text-slate-300">{title}</div>
      {hint && <div className="text-xs text-slate-500 mt-1.5 max-w-sm">{hint}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
