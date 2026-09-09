import { useSyncExternalStore, useCallback } from 'react';

// Identra 轻量 i18n：模块级 locale store + t() + useLocale()。
// 设计约束：
// - 零依赖、零 context prop 钻孔——kit.jsx 等深层工具直接 import { t } 消费；
// - localStorage 持久化（SSR/无 localStorage 环境静默降级 zh，SSR 探针输出与历史一致）；
// - 缺 key 时回落 zh，再回落 fallback 参数，最后回落 key 本身（渐进迁移不炸渲染）。

const LS_KEY = 'identra.locale';

let locale = 'zh';
try { locale = localStorage.getItem(LS_KEY) === 'en' ? 'en' : 'zh'; } catch (_) { /* SSR */ }

const listeners = new Set();

export function getLocale() { return locale; }

export function setLocale(next) {
  locale = next === 'en' ? 'en' : 'zh';
  try { localStorage.setItem(LS_KEY, locale); } catch (_) { /* SSR */ }
  listeners.forEach((fn) => { try { fn(); } catch (_) { /* 单个订阅者异常不阻断 */ } });
}

/** React 绑定：const [locale, setLocale] = useLocale()
 *  第三参 getServerSnapshot：react-dom/server SSR 必需（c74 A1 实录——缺失时全树 SSR 崩溃） */
export function useLocale() {
  const l = useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => locale,
    () => locale,
  );
  const set = useCallback((v) => setLocale(v), []);
  return [l, set];
}

export const dict = {
  zh: {
    // —— 导航 ——
    'navGroup.Workspace': '工作区', 'navGroup.Automation': '自动化', 'navGroup.Insights': '洞察', 'navGroup.System': '系统',
    'nav.overview': '总览', 'nav.tasks': '任务', 'nav.execution': '运行记录', 'nav.profiles': '浏览器环境',
    'nav.ai': 'AI 操作员', 'nav.schedules': '定时调度', 'nav.templates': '模板库',
    'nav.observability': '动态', 'nav.intelligence': '记忆',
    'nav.governance': '治理中心', 'nav.settings': '设置',
    // —— 顶栏 ——
    'top.newTask': '新建任务', 'top.logout': '退出', 'top.healthOk': 'All systems operational',
    'top.healthIssues': (n) => `${n} 项需要配置`,
    // —— 页面标题/副标题 ——
    'title.overview': '总览', 'title.tasks': '任务', 'title.execution': '运行记录', 'title.profiles': '浏览器环境',
    'title.ai': 'AI 操作员', 'title.schedules': '定时调度', 'title.templates': '模板库',
    'title.observability': '动态', 'title.intelligence': '记忆', 'title.proxies': '代理接入',
    'title.governance': '治理中心', 'title.settings': '设置', 'title.readiness': '工作区健康',
    'desc.overview': '你的 AI 工作台全局视图', 'desc.tasks': '自动化任务管理', 'desc.execution': '执行队列与运行记录',
    'desc.profiles': '浏览器环境与指纹配置', 'desc.ai': '给 AI 一个目标，它来执行', 'desc.schedules': '定时自动执行',
    'desc.templates': '指纹模板库', 'desc.observability': '执行轨迹与事件流', 'desc.intelligence': '站点画像与经验记忆',
    'desc.proxies': '代理资源接入', 'desc.governance': '密钥、审计与协作', 'desc.settings': '系统配置',
    'desc.readiness': '环境自检与配置引导',
    // —— 状态语言（kit.jsx humanStatus）——
    'st.PENDING': '排队中', 'st.PLANNING': '规划中', 'st.PREPARING': '准备中', 'st.PROFILE_READY': '环境就绪',
    'st.BROWSER_READY': '浏览器就绪', 'st.RUNNING': '执行中', 'st.PAUSED_FOR_HUMAN': '需要你确认',
    'st.HEALING': 'AI 自修复中', 'st.RECOVERING': '恢复中', 'st.SUCCESS': '已完成', 'st.FAILED': '失败',
    'st.CANCELLED': '已取消',
    'mode.ASSIST': '协助模式', 'mode.AUTONOMOUS': '自主模式', 'mode.SIMULATION': '演练模式', 'mode.DEBUG': '调试模式',
    // —— Overview ——
    'ov.greeting.night': '夜深了', 'ov.greeting.morning': '早上好', 'ov.greeting.afternoon': '下午好', 'ov.greeting.evening': '晚上好',
    'ov.subtitle.active': (n) => `AI 正在执行 ${n} 个任务，其余一切正常。`,
    'ov.subtitle.attention': '有任务需要你确认或处理。',
    'ov.subtitle.idle': '给 AI 一个目标，剩下的交给它。',
    'ov.kpi.running': '执行中', 'ov.kpi.completedToday': '今日完成', 'ov.kpi.needAttention': '需要处理', 'ov.kpi.successRate': '成功率',
    'ov.allCaughtUp': 'All caught up',
    'ov.activeTasks': '正在运行的任务', 'ov.openOperator': '进入 AI Operator',
    'ov.noActive': '没有正在执行的任务。', 'ov.createOne': '创建一个 →',
    'ov.runningAcross': (n) => `并行运行于 ${n} 个浏览器环境`,
    'ov.step': (a, b) => `步骤 ${a}/${b}`,
    'ov.workspaceReady': 'Workspace ready', 'ov.healthIssue': (n) => `${n} 项需要配置`,
    'ov.checkDetails': '查看详情',
    'ov.browserProfiles': '浏览器环境', 'ov.manage': '管理 →', 'ov.profiles': (n) => `${n} profiles`,
    'ov.runningShort': '运行中', 'ov.noProfiles': '还没有浏览器环境。', 'ov.createFirst': '创建第一个 →',
    'ov.recentActivity': 'Recent Activity', 'ov.noActivity': '暂无活动记录。创建第一个任务后，这里会显示 AI 的执行动态。',
    'ov.scheduled': '定时', 'ov.viewDetail': '查看技术详情',
    // —— Activity 时间线人话（req #6/#7）——
    'act.completed': '任务完成', 'act.recovered': 'AI 已自动恢复',
    'act.recoveredNote': '页面结构变化，AI 已重新定位目标并继续执行。',
    'act.needsYou': '需要你的确认', 'act.failed': '执行失败', 'act.cancelled': '已取消', 'act.working': '正在执行',
    // —— 通用弹窗/按钮 ——
    'c.cancel': '取消', 'c.confirmDelete': '确认删除', 'c.create': '创建', 'c.creating': '创建中…',
    'c.count': '数量（1-50）', 'c.prefix': '名称前缀', 'c.batchTitle': '批量创建 Profiles',
    'c.batchNote': '稳定字段共享基线，噪声字段每号独立派生（「同形不同样」）。',
    'c.lang': 'EN',
    // —— Settings 内嵌 Network 小节 ——
    'set.network': 'Network · 代理接入',
  },
  en: {
    'navGroup.Workspace': 'Workspace', 'navGroup.Automation': 'Automation', 'navGroup.Insights': 'Insights', 'navGroup.System': 'System',
    'nav.overview': 'Overview', 'nav.tasks': 'Tasks', 'nav.execution': 'Runs', 'nav.profiles': 'Browser Profiles',
    'nav.ai': 'AI Operator', 'nav.schedules': 'Schedules', 'nav.templates': 'Templates',
    'nav.observability': 'Activity', 'nav.intelligence': 'Memory',
    'nav.governance': 'Governance', 'nav.settings': 'Settings',
    'top.newTask': 'New Task', 'top.logout': 'Sign out', 'top.healthOk': 'All systems operational',
    'top.healthIssues': (n) => `${n} item${n === 1 ? '' : 's'} to configure`,
    'title.overview': 'Overview', 'title.tasks': 'Tasks', 'title.execution': 'Runs', 'title.profiles': 'Browser Profiles',
    'title.ai': 'AI Operator', 'title.schedules': 'Schedules', 'title.templates': 'Templates',
    'title.observability': 'Activity', 'title.intelligence': 'Memory', 'title.proxies': 'Proxies',
    'title.governance': 'Governance', 'title.settings': 'Settings', 'title.readiness': 'Workspace Health',
    'desc.overview': 'Your AI workspace at a glance', 'desc.tasks': 'Manage automation tasks', 'desc.execution': 'Queue and run history',
    'desc.profiles': 'Browser environments & fingerprints', 'desc.ai': 'Give AI a goal, it does the rest', 'desc.schedules': 'Run on a schedule',
    'desc.templates': 'Fingerprint template library', 'desc.observability': 'Traces and event stream', 'desc.intelligence': 'Site profiles & learned memory',
    'desc.proxies': 'Proxy resources', 'desc.governance': 'Keys, audit & collaboration', 'desc.settings': 'System settings',
    'desc.readiness': 'Environment checks & setup guide',
    'st.PENDING': 'Queued', 'st.PLANNING': 'Planning', 'st.PREPARING': 'Preparing', 'st.PROFILE_READY': 'Environment ready',
    'st.BROWSER_READY': 'Browser ready', 'st.RUNNING': 'Running', 'st.PAUSED_FOR_HUMAN': 'Needs your confirmation',
    'st.HEALING': 'AI recovering', 'st.RECOVERING': 'Recovering', 'st.SUCCESS': 'Completed', 'st.FAILED': 'Failed',
    'st.CANCELLED': 'Cancelled',
    'mode.ASSIST': 'Assist', 'mode.AUTONOMOUS': 'Autonomous', 'mode.SIMULATION': 'Simulation', 'mode.DEBUG': 'Debug',
    'ov.greeting.night': 'Working late', 'ov.greeting.morning': 'Good morning', 'ov.greeting.afternoon': 'Good afternoon', 'ov.greeting.evening': 'Good evening',
    'ov.subtitle.active': (n) => `AI is running ${n} task${n === 1 ? '' : 's'}. Everything else looks good.`,
    'ov.subtitle.attention': 'Some tasks need your confirmation.',
    'ov.subtitle.idle': 'Give AI a goal and let it handle the rest.',
    'ov.kpi.running': 'Running', 'ov.kpi.completedToday': 'Completed today', 'ov.kpi.needAttention': 'Need attention', 'ov.kpi.successRate': 'Success rate',
    'ov.allCaughtUp': 'All caught up',
    'ov.activeTasks': 'Active Tasks', 'ov.openOperator': 'Open AI Operator',
    'ov.noActive': 'Nothing running right now.', 'ov.createOne': 'Start one →',
    'ov.runningAcross': (n) => `Running across ${n} browser profiles`,
    'ov.step': (a, b) => `Step ${a}/${b}`,
    'ov.workspaceReady': 'Workspace ready', 'ov.healthIssue': (n) => `${n} item${n === 1 ? '' : 's'} to configure`,
    'ov.checkDetails': 'View details',
    'ov.browserProfiles': 'Browser Profiles', 'ov.manage': 'Manage →', 'ov.profiles': (n) => `${n} profiles`,
    'ov.runningShort': 'running', 'ov.noProfiles': 'No browser profiles yet.', 'ov.createFirst': 'Create your first →',
    'ov.recentActivity': 'Recent Activity', 'ov.noActivity': 'No activity yet. Once you create a task, AI progress shows up here.',
    'ov.scheduled': 'Scheduled', 'ov.viewDetail': 'View technical detail',
    'act.completed': 'Task completed', 'act.recovered': 'AI recovered automatically',
    'act.recoveredNote': 'The page changed. AI found the new target and resumed.',
    'act.needsYou': 'Needs your attention', 'act.failed': 'Task failed', 'act.cancelled': 'Cancelled', 'act.working': 'Working',
    'act.justNow': 'Just now',
    'c.cancel': 'Cancel', 'c.confirmDelete': 'Confirm delete', 'c.create': 'Create', 'c.creating': 'Creating…',
    'c.count': 'Count (1-50)', 'c.prefix': 'Name prefix', 'c.batchTitle': 'Batch create profiles',
    'c.batchNote': 'Stable fields share a baseline; noisy fields are derived per profile.',
    'c.lang': '中',
    'set.network': 'Network · Proxies',
  },
};

/** 翻译：缺 key 回落 zh → fallback → key。值可以是函数（带参文案）。 */
export function t(key, fallback) {
  const d = dict[locale] || dict.zh;
  const v = d[key] !== undefined ? d[key] : dict.zh[key];
  if (v === undefined) return fallback !== undefined ? fallback : key;
  return typeof v === 'function' ? v : v;
}

/** 带参翻译（字典值为函数时）：tFn('ov.runningAcross', 3) → 文案 */
export function tFn(key, ...args) {
  const v = t(key);
  return typeof v === 'function' ? v(...args) : v;
}
