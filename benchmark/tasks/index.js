'use strict';

// Phase 5.1 — Benchmark Task 集定义
// 11 类任务，覆盖你列出的对照维度：
//   登录 / 搜索 / 表单填写 / 页面导航 / 元素文案变化 /
//   Timeout / Cookie 弹窗 / 页面结构变化 / Session 失效 /
//   Browser crash / Worker crash
//
// 每个 Task 统一 schema（三组 Runner A/B/C 同入参同判分）：
//   id          任务唯一 id
//   category    上述 11 类之一
//   objective   自然语言目标（喂给 Agent Parser / LLM）
//   targetUrl   Mock 站点入口（真实站点任务覆盖此字段）
//   mock        仅在 Mock 站点生效的故障注入/页面配置
//   verify      成功判据：{ type: 'text'|'url'|'selector'|'state', value, timeoutMs }
//   real        { enabled:true, url, note } 真实站点覆盖（5.5 用）

const TASKS = [
  {
    id: 'login',
    category: 'login',
    objective: '打开登录页，输入用户名 alice 和密码 secret123，点击登录，等待进入 dashboard',
    targetUrl: '/login',
    mock: { route: '/login', inject: 'login-form' },
    verify: { type: 'url', value: '/dashboard', timeoutMs: 8000 },
  },
  {
    id: 'search',
    category: 'search',
    objective: '在搜索框输入 "benchmark test"，点击搜索按钮，等待结果列表出现',
    targetUrl: '/search',
    mock: { route: '/search', inject: 'search-box' },
    verify: { type: 'selector', value: '#results', timeoutMs: 8000 },
  },
  {
    id: 'form',
    category: 'form',
    objective: '填写联系表单：姓名填 Bob，邮箱填 bob@example.com，留言填 hello，提交后等待成功提示',
    targetUrl: '/form',
    mock: { route: '/form', inject: 'contact-form' },
    verify: { type: 'text', value: '提交成功', timeoutMs: 8000 },
  },
  {
    id: 'nav',
    category: 'navigation',
    objective: '从首页依次点击 产品 -> 文档 -> 快速开始，最终停留在快速开始页面',
    targetUrl: '/',
    mock: { route: '/', inject: 'home-nav' },
    verify: { type: 'url', value: '/docs/quickstart', timeoutMs: 8000 },
  },
  {
    id: 'text-change',
    category: 'text-change',
    objective: '点击刷新按钮，等待页面状态文案从 "Loading" 变为 "Ready"',
    targetUrl: '/text-change',
    mock: { route: '/text-change', inject: 'text-toggle' },
    verify: { type: 'text', value: 'Ready', timeoutMs: 8000 },
  },
  {
    id: 'timeout',
    category: 'timeout',
    objective: '点击一个 5 秒内不会响应的按钮，验证系统能正确识别超时而不是卡死',
    targetUrl: '/timeout',
    mock: { route: '/timeout', inject: 'slow-button', latencyMs: 5000 },
    verify: { type: 'state', value: 'timeout-detected', timeoutMs: 9000 },
  },
  {
    id: 'cookie',
    category: 'cookie-consent',
    objective: '页面弹出 Cookie 同意框，点击 "接受全部"，等待弹窗消失',
    targetUrl: '/cookie',
    mock: { route: '/cookie', inject: 'cookie-banner' },
    verify: { type: 'state', value: 'cookie-dismissed', timeoutMs: 8000 },
  },
  {
    id: 'structure-change',
    category: 'structure-change',
    objective: '页面布局会在加载后变化（按钮从底部移到顶部），定位并点击 "提交" 按钮',
    targetUrl: '/structure',
    mock: { route: '/structure', inject: 'morph-layout' },
    verify: { type: 'text', value: 'done', timeoutMs: 8000 },
  },
  {
    id: 'session-expired',
    category: 'session-expired',
    objective: '执行操作前 session 已失效，系统应检测到未登录并重新登录后继续',
    targetUrl: '/session',
    mock: { route: '/session', inject: 'expired-session' },
    verify: { type: 'url', value: '/dashboard', timeoutMs: 12000 },
  },
  {
    id: 'browser-crash',
    category: 'browser-crash',
    objective: '执行中浏览器进程崩溃，系统应检测到崩溃并恢复后完成任务',
    targetUrl: '/crash',
    mock: { route: '/crash', inject: 'crash-midway' },
    verify: { type: 'text', value: 'recovered', timeoutMs: 15000 },
  },
  {
    id: 'worker-crash',
    category: 'worker-crash',
    objective: '执行中 Worker 异常退出，系统应重新调度并完成任务',
    targetUrl: '/worker-crash',
    mock: { route: '/worker-crash', inject: 'worker-die' },
    verify: { type: 'text', value: 'recovered', timeoutMs: 15000 },
  },
];

const REAL_SITE_OVERRIDES = [
  // 5.5 真实浏览器集成时填充，例如：
  // { id: 'login-real', category:'login', real:{ enabled:true, url:'https://example.com/login', note:'公开演示站点' } }
];

function allTasks() {
  const merged = TASKS.map((t) => {
    const ov = REAL_SITE_OVERRIDES.find((r) => r.id === t.id);
    return ov ? { ...t, ...ov, targetUrl: ov.real.url } : t;
  });
  return merged;
}

function getTask(id) {
  return allTasks().find((t) => t.id === id) || null;
}

module.exports = { TASKS, allTasks, getTask, CATEGORIES: TASKS.map((t) => t.category) };
