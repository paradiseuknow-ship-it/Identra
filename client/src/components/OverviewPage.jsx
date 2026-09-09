import React, { useEffect, useState, useCallback } from 'react';
import api from '../api';
import { StatusDot, statusTone, humanStatus, SectionTitle } from '../ui/kit';
import { t, tFn } from '../lib/i18n';
import { IconPlus, IconExternal } from '../ui/icons';

// Overview —— AI Workspace 第一屏（第二阶段 PREMIUM REFINEMENT）
// 3 秒回答四问：① AI 现在在做什么 ② 今天完成了多少 ③ 什么事情需要我 ④ 如何开始新任务。
// LESS UI MORE PRODUCT：KPI 只留用户语言（Running/Completed today/Need attention/Success rate），
// 内部指标移 Runs/Analytics；Activity 时间线人话化（✓/↻/⚠），内部错误码进「查看技术详情」第二层。
// 数据面：aiListTasks（自带 plan.steps + currentStepId + profileId → 当前动作/进度零后端改动推导）。

const ACTIVE_SET = ['RUNNING', 'PLANNING', 'PREPARING', 'BROWSER_READY', 'PROFILE_READY', 'HEALING', 'RECOVERING'];

function greetingKey() {
  const h = new Date().getHours();
  if (h < 5) return 'ov.greeting.night';
  if (h < 12) return 'ov.greeting.morning';
  if (h < 18) return 'ov.greeting.afternoon';
  return 'ov.greeting.evening';
}

const isToday = (v) => v && new Date(v).toDateString() === new Date().toDateString();

function relTime(v) {
  if (!v) return '';
  const ms = Date.now() - new Date(v).getTime();
  if (ms < 60e3) return t('act.justNow') || '刚刚';
  if (ms < 3600e3) return Math.floor(ms / 60e3) + 'm';
  if (ms < 86400e3) return Math.floor(ms / 3600e3) + 'h';
  const d = new Date(v);
  return `${d.getMonth() + 1}-${d.getDate()}`;
}

/** 当前 AI 动作：currentStepId → plan.steps[].description（列表自带，零额外请求） */
function currentAction(task) {
  const steps = task.plan && Array.isArray(task.plan.steps) ? task.plan.steps : [];
  const cur = steps.find((s) => s.id === task.currentStepId);
  return (cur && cur.description) || null;
}

/** 步骤进度：当前步骤序号 / 计划总步数 */
function stepProgress(task) {
  const steps = task.plan && Array.isArray(task.plan.steps) ? task.plan.steps : [];
  if (!steps.length) return null;
  const idx = steps.findIndex((s) => s.id === task.currentStepId);
  if (idx < 0) return null;
  return { done: idx + 1, total: steps.length, pct: Math.round(((idx + 1) / steps.length) * 100) };
}

export default function OverviewPage({ profiles, readiness, onNewTask, onNavigate, onOpenDetail }) {
  const [tasks, setTasks] = useState([]);
  const load = useCallback(async () => {
    try { setTasks(await api.aiListTasks()); } catch (e) { /* 静默：概览不阻断 */ }
  }, []);
  useEffect(() => { load(); const h = setInterval(load, 5000); return () => clearInterval(h); }, [load]);

  const active = tasks.filter((x) => ACTIVE_SET.includes(x.status));
  const paused = tasks.filter((x) => x.status === 'PAUSED_FOR_HUMAN');
  const failed = tasks.filter((x) => x.status === 'FAILED');
  const success = tasks.filter((x) => x.status === 'SUCCESS');
  const finished = success.length + failed.length;
  const rate = finished ? Math.round((success.length / finished) * 1000) / 10 : null;
  const doneToday = success.filter((x) => isToday(x.finishedAt) || (!x.finishedAt && isToday(x.createdAt))).length;
  const attention = paused.length + failed.length; // 真正需要用户处理的量（确认/失败）

  // createdAt 可能是 ISO 字符串或数字时间戳（服务端形状未契约化）——统一 String 归一后再比较，
  // 否则数字类型调 localeCompare 直接 TypeError（C88 实录：整页 ErrorBoundary 兜底）。
  const recent = [...tasks]
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, 6);

  // Batch work 感知：活跃任务分布在几个浏览器环境上（req #8，克制一行，不做数据大屏）
  const activeProfiles = new Set(active.map((x) => x.profileId).filter(Boolean));
  const batchLine = activeProfiles.size >= 2 ? activeProfiles.size : null;

  // Browser Profiles 分组：首页只留「组名 + 数量 + 运行态」，指纹/代理/WebGL 全部退二级页
  const groupMap = {};
  profiles.forEach((p) => {
    const g = p.group || 'default';
    (groupMap[g] = groupMap[g] || { name: g, total: 0, running: 0 });
    groupMap[g].total += 1;
    if (p.running) groupMap[g].running += 1;
  });
  const groups = Object.values(groupMap).sort((a, b) => b.total - a.total).slice(0, 6);
  const profileOf = (id) => profiles.find((p) => p.id === id) || null;

  const openTask = (id) => (onOpenDetail ? onOpenDetail(id) : onNavigate('ai'));

  return (
    <div className="fade-up space-y-7">
      {/* 问候 + 主行动 */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">{t(greetingKey())}。</h1>
          <p className="text-sm text-slate-500 mt-1">
            {active.length > 0
              ? tFn('ov.subtitle.active', active.length)
              : attention > 0
                ? t('ov.subtitle.attention')
                : t('ov.subtitle.idle')}
          </p>
        </div>
        <button onClick={onNewTask} className="btn btn-primary px-4 py-2">
          <IconPlus size={14} /> New Task
        </button>
      </div>

      {/* KPI 行：数字 + 标签，无卡片框；Need attention=0 时直接给确定性语句（req #4） */}
      <div className="flex items-center gap-10 text-sm">
        <Stat n={active.length} label={t('ov.kpi.running')} live={active.length > 0} />
        <Stat n={doneToday} label={t('ov.kpi.completedToday')} />
        {attention === 0 ? (
          <div className="inline-flex items-baseline gap-2">
            <span className="text-sm text-emerald-400/90 inline-flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />{t('ov.allCaughtUp')}
            </span>
          </div>
        ) : (
          <Stat n={attention} label={t('ov.kpi.needAttention')} tone="text-amber-400" />
        )}
        <Stat n={rate === null ? '—' : rate + '%'} label={t('ov.kpi.successRate')} tone={rate !== null && rate < 80 ? 'text-amber-400' : 'text-slate-100'} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Active Tasks：name/status/profile/current action/progress 五要素（req #2） */}
        <div className="lg:col-span-2 card p-5">
          <SectionTitle action={active.length > 0 && (
            <button onClick={() => onNavigate('ai')} className="text-xs text-slate-500 hover:text-slate-200 inline-flex items-center gap-1">{t('ov.openOperator')} <IconExternal size={12} /></button>
          )}>{t('ov.activeTasks')}</SectionTitle>
          {batchLine && (
            <div className="text-xs text-teal-300/80 mb-3 inline-flex items-center gap-1.5">
              <span className="text-teal-300">✦</span>{tFn('ov.runningAcross', batchLine)}
            </div>
          )}
          {active.length === 0 ? (
            <div className="text-xs text-slate-500 py-5 text-center">
              {t('ov.noActive')}
              <button onClick={onNewTask} className="ml-1 text-accent hover:underline">{t('ov.createOne')}</button>
            </div>
          ) : (
            <div className="space-y-1">
              {active.slice(0, 5).map((x) => (
                <TaskRow key={x.id} task={x} profile={profileOf(x.profileId)} onOpen={() => onNavigate('ai')} />
              ))}
            </div>
          )}
        </div>

        {/* 右列：Workspace ready 一行化（req #5）+ Browser Profiles 分组（req #9） */}
        <div className="space-y-6">
          <div className="card p-4">
            {readiness ? (
              <button onClick={() => onNavigate('readiness')} className="w-full flex items-center justify-between text-left group">
                <span className={`inline-flex items-center gap-2 text-sm ${readiness.ok ? 'text-emerald-400' : 'text-amber-400'}`}>
                  <StatusDot tone={{ dot: readiness.ok ? 'bg-emerald-400' : 'bg-amber-400' }} live={!readiness.ok} />
                  {readiness.ok ? t('ov.workspaceReady') : tFn('ov.healthIssue', readiness.checks.filter((c) => !c.ok && !c.optional).length)}
                </span>
                <span className="text-xs text-slate-600 group-hover:text-slate-400 transition-colors">{t('ov.checkDetails')} →</span>
              </button>
            ) : (
              <span className="text-sm text-slate-500 inline-flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-slate-600" />···
              </span>
            )}
          </div>

          <div className="card p-5">
            <SectionTitle action={groups.length > 0 && (
              <button onClick={() => onNavigate('profiles')} className="text-xs text-slate-500 hover:text-slate-200">{t('ov.manage')}</button>
            )}>{t('ov.browserProfiles')}</SectionTitle>
            {groups.length === 0 ? (
              <div className="text-xs text-slate-500 py-3">
                {t('ov.noProfiles')}
                <button onClick={() => onNavigate('profiles')} className="ml-1 text-accent hover:underline">{t('ov.createFirst')}</button>
              </div>
            ) : (
              <div className="space-y-2.5">
                {groups.map((g) => (
                  <button key={g.name} onClick={() => onNavigate('profiles')} className="w-full flex items-center justify-between text-left group">
                    <div className="text-sm text-slate-200 group-hover:text-white">{g.name}</div>
                    <div className="text-xs text-slate-400 inline-flex items-center gap-2">
                      {g.running > 0 && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />}
                      <span className="text-slate-500">{tFn('ov.profiles', g.total)}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Recent Activity：真正的 Activity Timeline（req #1/#6/#7）——
          人话三态 ✓/↻/⚠，动态高度不撑卡；内部错误码（HUMAN_ESCALATION 等）只在点击后的技术详情层 */}
      <div className="card p-5">
        <SectionTitle>{t('ov.recentActivity')}</SectionTitle>
        {recent.length === 0 ? (
          <div className="text-xs text-slate-500 py-3">{t('ov.noActivity')}</div>
        ) : (
          <div className="divide-y divide-edge/40">
            {recent.map((x) => <ActivityRow key={x.id} task={x} onOpen={() => openTask(x.id)} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ n, label, tone = 'text-slate-100', live }) {
  return (
    <div className="inline-flex items-baseline gap-2">
      <span className={`text-xl font-semibold tabular-nums ${tone}`}>{n}</span>
      {live && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse self-center" />}
      <span className="text-xs text-slate-500">{label}</span>
    </div>
  );
}

/** Active Task 行：name + ● status + profile + 当前 AI 动作 + 步骤进度 */
function TaskRow({ task, profile, onOpen }) {
  const tone = statusTone(task.status);
  const action = currentAction(task);
  const prog = stepProgress(task);
  return (
    <button onClick={onOpen} className="w-full flex items-center gap-3 text-left rounded-lg px-3 py-2.5 hover:bg-white/[0.04] transition-colors">
      <StatusDot tone={tone} live={tone.live} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2.5 min-w-0">
          <span className="text-sm text-slate-200 truncate">{task.name}</span>
          {profile && <span className="shrink-0 text-xs text-slate-500 truncate">{(profile.group || 'default')} · {profile.name}</span>}
        </div>
        <div className="text-xs text-slate-500 truncate mt-0.5">
          {action || humanStatus(task.status)}
        </div>
      </div>
      {prog ? (
        <div className="shrink-0 w-24 text-right">
          <div className="text-xs text-slate-400 tabular-nums">{tFn('ov.step', prog.done, prog.total)}</div>
          <div className="mt-1 h-0.5 rounded bg-white/[0.06] overflow-hidden">
            <div className="h-full bg-emerald-400/70 rounded" style={{ width: prog.pct + '%' }} />
          </div>
        </div>
      ) : (
        <span className={`shrink-0 text-xs ${tone.text}`}>{humanStatus(task.status)}</span>
      )}
    </button>
  );
}

/** Activity 时间线行：✓ 完成 / ↻ AI 自恢复（特色化）/ ⚠ 需要处理 / ● 执行中 + 相对时间 */
function ActivityRow({ task, onOpen }) {
  const recovering = task.status === 'HEALING' || task.status === 'RECOVERING';
  const paused = task.status === 'PAUSED_FOR_HUMAN';
  const done = task.status === 'SUCCESS';
  const failed = task.status === 'FAILED';
  const cancelled = task.status === 'CANCELLED';

  // 人话短语：内部状态码/错误码（HUMAN_ESCALATION、SUBMIT_RESULT_UNKNOWN、V1 rb-test 等）不在此层出现
  let glyph = <Glyph c="text-slate-500">●</Glyph>;
  let phrase = humanStatus(task.status);
  let note = null;
  let toneCls = 'text-slate-300';
  if (done) { glyph = <Glyph c="text-emerald-400">✓</Glyph>; phrase = t('act.completed'); toneCls = 'text-slate-200'; }
  else if (recovering) {
    glyph = <Glyph c="text-teal-300">↻</Glyph>;
    phrase = t('act.recovered');
    note = <span className="text-teal-300/70">{t('act.recoveredNote')}</span>;
    toneCls = 'text-teal-200';
  } else if (paused) { glyph = <Glyph c="text-amber-400">⚠</Glyph>; phrase = t('act.needsYou'); note = task.pendingReason ? <span className="text-amber-400/70">{task.pendingReason}</span> : null; toneCls = 'text-amber-200'; }
  else if (failed) { glyph = <Glyph c="text-rose-400">⚠</Glyph>; phrase = t('act.failed'); toneCls = 'text-rose-200'; }
  else if (cancelled) { glyph = <Glyph c="text-slate-600">✓</Glyph>; phrase = t('act.cancelled'); toneCls = 'text-slate-500'; }

  return (
    <button onClick={onOpen} title={t('ov.viewDetail')} className="w-full flex items-center gap-3 text-left px-1 py-2 hover:bg-white/[0.03] transition-colors group">
      {glyph}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className={`text-[13px] truncate ${toneCls}`}>{task.name}</span>
          <span className="text-xs text-slate-500 shrink-0">{phrase}</span>
        </div>
        {note && <div className="text-xs truncate mt-0.5">{note}</div>}
      </div>
      {task.scheduleId && <span className="text-[10px] text-slate-500 border border-edge/60 rounded px-1.5 py-0.5 shrink-0">{t('ov.scheduled')}</span>}
      <span className="text-[11px] text-slate-600 tabular-nums w-10 text-right shrink-0 group-hover:text-slate-400 transition-colors">{relTime(task.finishedAt || task.updatedAt || task.createdAt)}</span>
    </button>
  );
}

function Glyph({ c, children }) {
  return <span className={`shrink-0 w-4 text-center text-sm font-medium ${c}`}>{children}</span>;
}
