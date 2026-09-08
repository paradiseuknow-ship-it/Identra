import React, { useEffect, useState, useCallback } from 'react';
import api from '../api';
import { StatusPill, StatusDot, statusTone, humanStatus, humanMode, SectionTitle, EmptyState } from '../ui/kit';
import { IconPlus, IconChevron, IconExternal } from '../ui/icons';

// Overview —— 新首页（AI Workspace 第一屏）
// 3 秒回答三问：AI 现在在做什么 / 今天完成了多少 / 下一步做什么。
// 数据面：aiListTasks（自带轮询）+ profiles（App 注入）+ readiness（App 注入）；零新后端依赖。

const ACTIVE_SET = ['RUNNING', 'PLANNING', 'PREPARING', 'BROWSER_READY', 'PROFILE_READY', 'HEALING', 'RECOVERING'];

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return '夜深了';
  if (h < 12) return '早上好';
  if (h < 18) return '下午好';
  return '晚上好';
}

export default function OverviewPage({ profiles, readiness, onNewTask, onNavigate }) {
  const [tasks, setTasks] = useState([]);
  const load = useCallback(async () => {
    try { setTasks(await api.aiListTasks()); } catch (e) { /* 静默：概览不阻断 */ }
  }, []);
  useEffect(() => { load(); const h = setInterval(load, 5000); return () => clearInterval(h); }, [load]);

  const active = tasks.filter((t) => ACTIVE_SET.includes(t.status));
  const paused = tasks.filter((t) => t.status === 'PAUSED_FOR_HUMAN');
  const failed = tasks.filter((t) => t.status === 'FAILED');
  const success = tasks.filter((t) => t.status === 'SUCCESS');
  const finished = success.length + failed.length;
  const rate = finished ? Math.round((success.length / finished) * 1000) / 10 : null;
  const isToday = (t) => t.createdAt && new Date(t.createdAt).toDateString() === new Date().toDateString();
  const todayCount = tasks.filter(isToday).length;
  const attention = paused.length + failed.length;

  // createdAt 可能是 ISO 字符串或数字时间戳（服务端形状未契约化）——统一 String 归一后再比较，
  // 否则数字类型调 localeCompare 直接 TypeError（C88 实录：整页 ErrorBoundary 兜底）。
  const recent = [...tasks]
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, 7);

  // Browser Profiles 分组：group 字段聚合，运行态计数
  const groupMap = {};
  profiles.forEach((p) => {
    const g = p.group || 'default';
    (groupMap[g] = groupMap[g] || { name: g, total: 0, running: 0, items: [] });
    groupMap[g].total += 1;
    if (p.running) groupMap[g].running += 1;
    groupMap[g].items.push(p);
  });
  const groups = Object.values(groupMap).sort((a, b) => b.total - a.total).slice(0, 6);

  const health = readiness
    ? { ok: readiness.ok, text: readiness.ok ? 'All systems operational' : `${readiness.checks.filter((c) => !c.ok && !c.optional).length} 项需要配置` }
    : null;

  return (
    <div className="fade-up space-y-6">
      {/* 问候 + 主行动 */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">{greeting()}。</h1>
          <p className="text-sm text-slate-500 mt-1">
            {active.length > 0
              ? `AI 正在执行 ${active.length} 个任务，其余一切正常。`
              : attention > 0
                ? '有任务需要你确认或处理。'
                : '给 AI 一个目标，剩下的交给它。'}
          </p>
        </div>
        <button onClick={onNewTask} className="btn btn-primary px-4 py-2">
          <IconPlus size={14} /> New Task
        </button>
      </div>

      {/* 克制统计行：数字 + 标签，无卡片框 */}
      <div className="flex items-center gap-10 text-sm">
        <Stat n={active.length} label="执行中" tone="text-slate-100" live={active.length > 0} />
        <Stat n={todayCount || tasks.length} label={todayCount ? '今日任务' : '全部任务'} />
        <Stat n={rate === null ? '—' : rate + '%'} label="成功率" tone={rate !== null && rate < 80 ? 'text-amber-400' : 'text-slate-100'} />
        <Stat n={attention} label="需要关注" tone={attention > 0 ? 'text-amber-400' : 'text-slate-400'} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Active Tasks：当前在跑什么 + AI 当前状态 */}
        <div className="lg:col-span-2 card p-5">
          <SectionTitle action={active.length > 0 && (
            <button onClick={() => onNavigate('ai')} className="text-xs text-slate-500 hover:text-slate-200 inline-flex items-center gap-1">进入 AI Operator <IconExternal size={12} /></button>
          )}>Active Tasks</SectionTitle>
          {active.length === 0 ? (
            <div className="text-xs text-slate-500 py-6 text-center">
              没有正在执行的任务。
              <button onClick={onNewTask} className="ml-1 text-accent hover:underline">创建一个 →</button>
            </div>
          ) : (
            <div className="space-y-2.5">
              {active.slice(0, 5).map((t) => <TaskRow key={t.id} task={t} onOpen={() => onNavigate('ai')} />)}
            </div>
          )}
        </div>

        {/* 右列：环境健康 + Browser Profiles 分组 */}
        <div className="space-y-5">
          <div className="card p-5">
            <SectionTitle>Workspace Health</SectionTitle>
            {health ? (
              <button onClick={() => onNavigate('readiness')} className="w-full text-left group">
                <span className={`inline-flex items-center gap-2 text-sm ${health.ok ? 'text-emerald-400' : 'text-amber-400'}`}>
                  <StatusDot tone={{ dot: health.ok ? 'bg-emerald-400' : 'bg-amber-400' }} live={!health.ok} />
                  {health.text}
                </span>
                <span className="block text-xs text-slate-500 mt-1.5 group-hover:text-slate-400 transition-colors">点击查看完整自检 →</span>
              </button>
            ) : <div className="text-xs text-slate-500">自检中…</div>}
          </div>

          <div className="card p-5">
            <SectionTitle action={groups.length > 0 && (
              <button onClick={() => onNavigate('profiles')} className="text-xs text-slate-500 hover:text-slate-200">管理 →</button>
            )}>Browser Profiles</SectionTitle>
            {groups.length === 0 ? (
              <div className="text-xs text-slate-500 py-3">还没有浏览器环境。<button onClick={() => onNavigate('profiles')} className="text-accent hover:underline">创建第一个 →</button></div>
            ) : (
              <div className="space-y-2.5">
                {groups.map((g) => (
                  <button key={g.name} onClick={() => onNavigate('profiles')} className="w-full flex items-center justify-between text-left group">
                    <div>
                      <div className="text-sm text-slate-200 group-hover:text-white">{g.name}</div>
                      <div className="text-xs text-slate-500">{g.total} profiles</div>
                    </div>
                    <div className="text-xs text-slate-400 inline-flex items-center gap-1.5">
                      {g.running > 0 && (<><span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /><span>{g.running} running</span></>)}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Recent Activity：含 AI 自修复特色化 */}
      <div className="card p-5">
        <SectionTitle>Recent Activity</SectionTitle>
        {recent.length === 0 ? (
          <div className="text-xs text-slate-500 py-4">暂无活动记录。创建第一个任务后，这里会显示 AI 的执行动态。</div>
        ) : (
          <div className="space-y-1">
            {recent.map((t) => <ActivityRow key={t.id} task={t} onOpen={() => onNavigate('ai')} />)}
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

function TaskRow({ task, onOpen }) {
  const tone = statusTone(task.status);
  return (
    <button onClick={onOpen} className="w-full flex items-center justify-between gap-3 text-left rounded-lg px-3 py-2.5 hover:bg-white/[0.04] transition-colors">
      <div className="min-w-0">
        <div className="text-sm text-slate-200 truncate">{task.name}</div>
        {task.error && <div className="text-xs text-rose-400/90 truncate mt-0.5">{task.error}</div>}
      </div>
      <span className={`shrink-0 inline-flex items-center gap-2 text-xs ${tone.text}`}>
        <StatusDot tone={tone} live={tone.live} />
        {humanStatus(task.status)}
      </span>
    </button>
  );
}

function ActivityRow({ task, onOpen }) {
  const tone = statusTone(task.status);
  const recovering = task.status === 'HEALING' || task.status === 'RECOVERING';
  const paused = task.status === 'PAUSED_FOR_HUMAN';
  return (
    <button onClick={onOpen} className="w-full flex items-center gap-3 text-left rounded-lg px-2 py-2 hover:bg-white/[0.04] transition-colors">
      <StatusDot tone={tone} live={tone.live} />
      <div className="min-w-0 flex-1">
        <span className="text-sm text-slate-300 truncate">{task.name}</span>
        <span className={`text-xs ml-2 ${tone.text}`}>{humanStatus(task.status)}</span>
        {task.error && <div className="text-xs text-rose-400/80 truncate">{task.error}</div>}
        {paused && task.pendingReason && <div className="text-xs text-amber-400/80 truncate">{task.pendingReason}</div>}
      </div>
      {recovering && (
        <span className="pill bg-teal-500/10 text-teal-300 shrink-0">AI 已自动恢复</span>
      )}
      {task.scheduleId && <span className="text-[10px] text-slate-500 border border-edge rounded px-1.5 py-0.5 shrink-0">定时</span>}
    </button>
  );
}
