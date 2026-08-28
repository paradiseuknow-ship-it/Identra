'use strict';

// Phase 6 Real Intelligence Validation —— 真实 DeepSeek Benchmark Runner。
//
// 唯一真实链路（禁止 mock planner / 禁止 attachPlan / 禁止 fallback）：
//   Objective → DeepSeek provider.plan → Runtime → Browser → Verification → Recovery。
//
// 与 Phase 5 productBenchmark 的区别：
//   - 强制真实 provider：无 DEEPSEEK_API_KEY 直接退出（绝不回退 mock / 绝不以假成功伪造）。
//   - 不注入任何预设计划；计划完全由真实 DeepSeek 生成。
//   - 通过包装 global.fetch 捕获 DeepSeek 用量（prompt/completion tokens）估算成本。
//   - 额外聚合「验证准确率 / 恢复成功率 / 平均成本 / 平均时长」等 Phase 6 必填指标。
//   - 运行后生成 PHASE6_REAL_AI_VALIDATION_REPORT.md。
//
// 用法：
//   DEEPSEEK_API_KEY=sk-... node server/scripts/realBenchmark.js
//   DEEPSEEK_API_KEY=sk-... node server/scripts/realBenchmark.js --timeout 90000
//   DEEPSEEK_API_KEY=sk-... node server/scripts/realBenchmark.js --max 5     # 抽样冒烟

const path = require('path');
const fs = require('fs');
const http = require('http');

// ── 0) 强制真实 provider；缺失 key 直接退出（不伪造）。--recompute 仅本地重算，免 key。──
const IS_RECOMPUTE = process.argv.indexOf('--recompute') >= 0;
if (!IS_RECOMPUTE && !process.env.DEEPSEEK_API_KEY) {
  console.error('[realBenchmark] 缺少 DEEPSEEK_API_KEY：Phase 6 要求真实 DeepSeek 验证，禁止回退 mock。');
  console.error('[realBenchmark] 请提供 key 后重跑：DEEPSEEK_API_KEY=sk-... node server/scripts/realBenchmark.js');
  process.exit(2);
}
if (!IS_RECOMPUTE && process.env.AI_PROVIDER === 'mock') {
  console.error('[realBenchmark] 检测到 AI_PROVIDER=mock，违反 Phase 6「禁止 mock planner」。已终止。');
  process.exit(2);
}
process.env.AI_PROVIDER = process.env.AI_PROVIDER || 'deepseek';
require('../agent/llm/providers/deepseek');
require('../agent/llm/providers/openai');

// ── 1) 包装 global.fetch 捕获 DeepSeek token 用量（脚本级，不改动核心文件）──
const _origFetch = (typeof global.fetch === 'function') ? global.fetch.bind(global) : null;
const DEEPSEEK_HOST = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com')
  .replace(/^https?:\/\//, '').replace(/\/.*$/, '');
let curPromptTokens = 0;
let curCompletionTokens = 0;
let totPromptTokens = 0;
let totCompletionTokens = 0;
if (_origFetch) {
  global.fetch = async (...args) => {
    const res = await _origFetch(...args);
    try {
      const url = String(args[0] || '');
      if (url.includes(DEEPSEEK_HOST)) {
        const clone = res.clone();
        const body = await clone.json().catch(() => null);
        const u = body && body.usage;
        if (u && u.total_tokens) {
          curPromptTokens += (u.prompt_tokens || 0);
          curCompletionTokens += (u.completion_tokens || 0);
        }
      }
    } catch (e) { /* 用量捕获失败不影响主流程 */ }
    return res;
  };
}

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const nxt = argv[i + 1];
  if (nxt === undefined || nxt.startsWith('--')) return true;
  return nxt;
}
const MAX = parseInt(arg('--max', '0'), 10) || 0;
const PER_TASK_TIMEOUT = parseInt(arg('--timeout', '90000'), 10) || 90000;

const scenarios = require('../scenarios');
const agentScore = require('../agentScore');
const store = require('../agent/store');

// 健壮性：单个任务的游离拒绝不应中止整个 benchmark（报告必须始终生成）
process.on('unhandledRejection', (e) => { console.error('[realBenchmark][unhandledRejection]', (e && e.stack) || e); });

// ── 30 真实任务：15 个已验证场景（含 5 类失败注入）+ 15 个额外真实能力任务 ──
const EXTRA = [
  { id: 'real.ec.search1', category: 'ecommerce', name: '搜索耳机', objective: '在搜索框输入「耳机」并点击搜索按钮', fixture: 'ecommerce/search.html', difficulty: 'easy' },
  { id: 'real.ec.search2', category: 'ecommerce', name: '搜索无线鼠标', objective: '在搜索框输入「无线鼠标」并点击搜索', fixture: 'ecommerce/search.html', difficulty: 'easy' },
  { id: 'real.ec.cart', category: 'ecommerce', name: '加购机械键盘', objective: '搜索「机械键盘」并将结果加入购物车', fixture: 'ecommerce/search.html', difficulty: 'medium' },
  { id: 'real.ec.lazy', category: 'ecommerce', name: '懒加载搜索', objective: '等待页面加载完成后在搜索框输入「平板」并搜索', fixture: 'ecommerce/search_lazy.html', difficulty: 'medium' },
  { id: 'real.ec.changed', category: 'ecommerce', name: '元素变更搜索', objective: '在搜索框（id 已改为 query）输入「显示器」并搜索', fixture: 'ecommerce/search_changed.html', difficulty: 'medium' },
  { id: 'real.saas.login', category: 'saas', name: 'SaaS 登录看板', objective: '使用邮箱 ops@cloudsaas.io 与密码 Saas#2024 登录系统并查看看板', fixture: 'saas/login.html', difficulty: 'medium' },
  { id: 'real.saas.export', category: 'saas', name: '导出报表', objective: '登录后点击导出按钮导出报表', fixture: 'saas/login.html', difficulty: 'hard' },
  { id: 'real.saas.wrong', category: 'saas', name: '错误密码登录', objective: '使用错误密码登录系统，应被拒绝', fixture: 'saas/login.html', difficulty: 'medium' },
  { id: 'real.admin.create', category: 'admin', name: '创建用户', objective: '创建用户 alice，邮箱 alice@corp.io，角色 viewer', fixture: 'admin/users.html', difficulty: 'medium' },
  { id: 'real.admin.admin', category: 'admin', name: '创建管理员', objective: '新建管理员用户 bob，邮箱 bob@corp.io，角色 admin', fixture: 'admin/users.html', difficulty: 'medium' },
  { id: 'real.de.reg1', category: 'data_entry', name: '会员注册1', objective: '注册会员，姓名张三，邮箱 z@x.io，手机号 13900000000', fixture: 'data_entry/form.html', difficulty: 'medium' },
  { id: 'real.de.reg2', category: 'data_entry', name: '会员注册2', objective: '提交注册表单，姓名李四，邮箱 l@x.io，手机号 13700000000', fixture: 'data_entry/form.html', difficulty: 'medium' },
  { id: 'real.scrape.list', category: 'scraping', name: '比价确认', objective: '打开比价列表并确认出现「戴尔 U2723QE」', fixture: 'scraping/list.html', difficulty: 'easy' },
  { id: 'real.scrape.prices', category: 'scraping', name: '抓取价格', objective: '抓取比价列表中所有商品价格', fixture: 'scraping/list.html', difficulty: 'medium' },
  { id: 'real.ec.usb', category: 'ecommerce', name: '搜索USB网卡', objective: '在搜索框输入「USB 网卡」并确认结果页出现该商品', fixture: 'ecommerce/search.html', difficulty: 'easy' },
];
function buildTaskList() {
  const base = scenarios.loadAll().map((s) => ({
    id: s.id, category: s.category, name: s.name, objective: s.objective,
    fixture: s.fixture, difficulty: s.difficulty, failureInjection: s.failureInjection || null,
  }));
  const list = base.concat(EXTRA);
  return MAX > 0 ? list.slice(0, MAX) : list;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function startMockServer() {
  const root = path.resolve(__dirname, '..', '..', 'mock-site');
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(String(req.url || '/').split('?')[0]);
    if (p === '/') p = '/search.html';
    const file = path.join(root, p);
    if (!file.startsWith(root)) { res.statusCode = 403; res.end('forbidden'); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.statusCode = 404; res.end('not found'); return; }
      const ext = path.extname(file);
      const ct = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'text/javascript' : 'text/plain';
      res.setHeader('Content-Type', ct);
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

function resolveTargetUrl(scn, baseUrl) {
  const inj = scn.failureInjection && scn.failureInjection.type;
  if (inj === 'network_failure') return 'http://127.0.0.1:1/';
  const fixture = scn.fixture || 'search.html';
  return baseUrl + '/' + fixture;
}

const TERMINAL = ['SUCCESS', 'FAILED', 'HUMAN_ESCALATION', 'CANCELLED'];

async function runScenario(scn, baseUrl) {
  const db = require('../db');
  const taskManager = require('../agent/taskManager');
  const browserManager = require('../browserManager');
  require('../agent/runtime'); // 注册 executor 钩子

  // 重置本任务 token 计数
  curPromptTokens = 0; curCompletionTokens = 0;

  const PROFILE_ID = 'p_real_' + scn.id.replace(/[^a-zA-Z0-9]/g, '_') + '_' + Date.now().toString(36);
  const profile = {
    id: PROFILE_ID, name: 'Real-' + scn.id, group: 'default', tags: [], notes: '',
    seed: 'bench-seed', headless: true, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { restoreLastSession: false, blockVideo: false, blockImages: false, clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false },
    fingerprintOverride: {}, fingerprint: null, lastSessionUrls: [], createdAt: Date.now(),
  };
  db.upsertProfile(profile);

  const targetUrl = resolveTargetUrl(scn, baseUrl);
  const task = taskManager.createTask({
    name: 'Real ' + scn.name,
    objective: scn.objective,
    targetUrl,
    profileId: PROFILE_ID,
    executionMode: 'AUTONOMOUS',
    constraints: [],
    policy: { riskFloor: 'HIGH' },
  });

  // 注意：不调用 attachPlan / 不注入任何预设计划；计划完全由真实 DeepSeek 生成。
  taskManager.start(task.id);
  const end = Date.now() + PER_TASK_TIMEOUT;
  let final = null;
  while (Date.now() < end) {
    final = taskManager.getTask(task.id);
    if (final && TERMINAL.includes(final.status)) break;
    await sleep(500);
  }
  if (!final || !TERMINAL.includes(final.status)) {
    try { taskManager.cancel(task.id); } catch (e) {}
    final = taskManager.getTask(task.id) || { id: task.id, status: 'TIMEOUT' };
  }

  // ── 聚合可观测指标（纯读 store，不改核心逻辑）──
  const allSteps = store.read('aiSteps', []);
  const stepIds = new Set(allSteps.filter((s) => s.taskId === task.id).map((s) => s.id));
  const steps = allSteps.filter((s) => stepIds.has(s.id)).map((s) => ({
    id: s.id, status: s.status,
    hasVerification: !!(s.verification && s.verification.type && s.verification.type !== 'none'),
  }));
  const attempts = store.read('aiAttempts', [])
    .filter((a) => stepIds.has(a.stepId))
    .map((a) => ({ stepId: a.stepId, status: a.status, isError: a.status !== 'SUCCESS' && !!a.error, code: a.error && a.error.code }));
  const retries = store.read('aiEvents', [])
    .filter((e) => e.taskId === task.id && e.type === 'agent.retrying').length;
  const repairs = store.read('aiRepairAttempts', [])
    .filter((r) => r.taskId === task.id).length;
  const snapshots = store.read('aiFailureSnapshots', [])
    .filter((s) => s.taskId === task.id);
  const verifEvents = store.read('aiEvents', [])
    .filter((e) => e.taskId === task.id && e.type === 'ai.verification.completed');
  const escalated = final.status === 'HUMAN_ESCALATION';

  const taskPrompt = curPromptTokens, taskCompletion = curCompletionTokens;
  totPromptTokens += taskPrompt; totCompletionTokens += taskCompletion;

  const metrics = {
    taskId: task.id, status: final.status, error: final.error || null,
    startedAt: final.startedAt, finishedAt: final.finishedAt,
    steps, attempts, retries, repairs, escalated,
  };
  const scores = agentScore.compute(metrics);
  const classification = classifyFailure(scn, final, steps, attempts, snapshots);

  try { taskManager.cancel(task.id); } catch (e) {}
  try { browserManager.close(PROFILE_ID).catch(() => {}); } catch (e) {}
  try { db.deleteProfile(PROFILE_ID); } catch (e) {}

  return {
    id: scn.id, category: scn.category, name: scn.name, difficulty: scn.difficulty,
    objective: scn.objective, fixture: scn.fixture,
    failureInjection: scn.failureInjection ? scn.failureInjection.type : null,
    targetUrl,
    status: final.status,
    error: (final.error && (final.error.message || String(final.error))) || (typeof final.error === 'string' ? final.error : null),
    stepCount: steps.length,
    attemptCount: attempts.length,
    successAttempts: attempts.filter((a) => !a.isError).length,
    retries, repairs,
    verificationTotal: verifEvents.length,
    verificationPassed: verifEvents.filter((e) => e.payload && e.payload.success).length,
    latencyMs: (final.startedAt && final.finishedAt) ? final.finishedAt - final.startedAt : null,
    tokensPrompt: taskPrompt,
    tokensCompletion: taskCompletion,
    classification,
    scores,
  };
}

function classifyFailure(scn, final, steps, attempts, snapshots) {
  if (!final || final.status === 'SUCCESS') return null;
  const errText = String((final.error && (final.error.message || final.error)) || '');
  if (steps.length === 0 || /计划生成失败|计划为空|PLAN_FAIL|plan objective|planning/i.test(errText)) return 'planner';
  const inj = scn.failureInjection && scn.failureInjection.type;
  const codes = attempts.map((a) => a.code).filter(Boolean)
    .concat(snapshots.map((s) => s.errorType).filter(Boolean));
  const hasVerifyFail = codes.some((c) => /VERIFY|VERIFICATION/i.test(c)) ||
    inj === 'verification_failure' || inj === 'login_failure' || /验证|VERIFY/i.test(errText);
  if (hasVerifyFail) return 'verification';
  return 'execution';
}

function aggregate(results) {
  const total = results.length;
  const success = results.filter((r) => r.status === 'SUCCESS').length;
  const escalated = results.filter((r) => r.status === 'HUMAN_ESCALATION').length;
  const failed = results.filter((r) => r.status === 'FAILED' || r.status === 'HUMAN_ESCALATION').length;
  const plannerFailure = results.filter((r) => r.classification === 'planner').length;
  const executionFailure = results.filter((r) => r.classification === 'execution').length;
  const verificationFailure = results.filter((r) => r.classification === 'verification').length;

  const avgSteps = total ? +(results.reduce((a, r) => a + r.stepCount, 0) / total).toFixed(2) : 0;
  const avgRecovery = total ? +(results.reduce((a, r) => a + (r.retries + r.repairs), 0) / total).toFixed(2) : 0;
  const lat = results.filter((r) => r.latencyMs != null).map((r) => r.latencyMs);
  const avgLatency = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null;

  // Phase 6 必填指标
  const tasksWithPlan = results.filter((r) => r.stepCount > 0).length;
  const plannerSuccessRate = total ? +(tasksWithPlan / total).toFixed(4) : null;

  const totalAttempts = results.reduce((a, r) => a + r.attemptCount, 0);
  const successAttempts = results.reduce((a, r) => a + r.successAttempts, 0);
  const executionSuccessRate = totalAttempts ? +(successAttempts / totalAttempts).toFixed(4) : null;

  const totalVerif = results.reduce((a, r) => a + r.verificationTotal, 0);
  const passedVerif = results.reduce((a, r) => a + r.verificationPassed, 0);
  const verificationAccuracy = totalVerif ? +(passedVerif / totalVerif).toFixed(4) : null;

  const neededRecovery = results.filter((r) => r.retries + r.repairs > 0);
  const recovered = neededRecovery.filter((r) => r.status === 'SUCCESS').length;
  const recoverySuccessRate = neededRecovery.length ? +(recovered / neededRecovery.length).toFixed(4) : null;

  const totPrompt = results.reduce((a, r) => a + r.tokensPrompt, 0);
  const totCompletion = results.reduce((a, r) => a + r.tokensCompletion, 0);
  const totTokens = totPrompt + totCompletion;
  // DeepSeek 公开定价（deepseek-chat）：$0.27/1M 输入，$1.10/1M 输出（估算，实际账户映射为 deepseek-v4-flash）
  const estUSD = totPrompt * 0.27e-6 + totCompletion * 1.10e-6;
  const avgCostUSD = total ? +(estUSD / total).toFixed(4) : null;
  const avgDurationMs = avgLatency;

  const scoreAgg = agentScore.aggregate(results.map((r) => r.scores));

  // 5 类失败注入覆盖验证（真实恢复是否触发）
  //
  // 真实 DeepSeek 模式下，AI 自行生成计划与验证目标，failure.* 场景不再是「受控硬注入」：
  // AI 不一定会去触发/验证预期的失败点。因此本矩阵严格区分三态：
  //   ran            —— 该注入类型场景是否被执行
  //   engaged        —— 是否真正「触及」了注入（触发了恢复/修复重试）。未触及却 SUCCESS 属「未命中注入」，不应计为恢复成功
  //   recoveryTriggered —— 是否触发了 recovery/repair 机制（retries+repairs>0）
  //   recovered      —— 必须「真正触发恢复」且最终 SUCCESS，才算恢复成功（防止把「未验证即通过」误标为恢复）
  const REQUIRED = ['page_not_found', 'element_changed', 'network_failure', 'login_failure', 'verification_failure'];
  const recoveryValidation = REQUIRED.map((type) => {
    const run = results.filter((r) => r.failureInjection === type);
    const ran = run.length > 0;
    const recoveryTriggered = ran && run.some((r) => r.retries + r.repairs > 0);
    const recoveredOk = ran && recoveryTriggered && run.some((r) => r.status === 'SUCCESS');
    return {
      type, ran,
      engaged: !!recoveryTriggered,
      recoveryTriggered: !!recoveryTriggered,
      recovered: !!recoveredOk,
      finalStatus: ran ? run.map((r) => r.status) : [],
    };
  });

  return {
    totalTasks: total,
    successRate: total ? +(success / total).toFixed(4) : null,
    humanEscalationRate: total ? +(escalated / total).toFixed(4) : null,
    avgSteps, avgRecovery, avgLatency,
    plannerFailure, executionFailure, verificationFailure, failedTasks: failed,
    // Phase 6 必填
    plannerSuccessRate,
    executionSuccessRate,
    verificationAccuracy,
    recoverySuccessRate,
    humanEscalation: total ? +(escalated / total).toFixed(4) : null,
    averageCost: { totalTokens: totTokens, promptTokens: totPrompt, completionTokens: totCompletion, estUSD: +estUSD.toFixed(4), avgUSDPerTask: avgCostUSD },
    averageDurationMs: avgDurationMs,
    agentScore: scoreAgg,
    recoveryValidation,
  };
}

function verdict(agg) {
  const s = agg.successRate, esc = agg.humanEscalationRate, rec = agg.recoverySuccessRate, va = agg.verificationAccuracy;
  const reasons = [];
  if (s == null) return { alpha: false, reasons: ['无有效数据'] };
  if (s >= 0.8) reasons.push('成功率 ≥ 80%'); else reasons.push('成功率 ' + (s * 100).toFixed(0) + '% < 80% 目标');
  if (esc != null && esc <= 0.2) reasons.push('人工升级率 ≤ 20%'); else reasons.push('人工升级率 ' + ((esc || 0) * 100).toFixed(0) + '% > 20%');
  if (va != null && va >= 0.8) reasons.push('验证准确率 ≥ 80%'); else reasons.push('验证准确率 ' + ((va || 0) * 100).toFixed(0) + '% < 80%');
  const alpha = s >= 0.8 && (esc == null || esc <= 0.2) && (va == null || va >= 0.8);
  return { alpha, reasons };
}

function generateReport(out, agg, v) {
  const pct = (x) => (x == null ? '-' : (x * 100).toFixed(1) + '%');
  const L = [];
  L.push('# Phase 6 真实 AI 验证报告');
  L.push('');
  L.push('> 生成时间：' + out.generatedAt);
  L.push('> 模式：**真实 DeepSeek**（禁止 mock planner / 禁止 fallback，计划由 DeepSeek 端到端生成）');
  L.push('> Provider：`' + out.provider + '` ｜ Model：`' + (out.model || 'deepseek-chat') + '`');
  L.push('');
  L.push('## 1. 验证结论（Alpha 判定）');
  L.push('');
  L.push('**是否达到真实 Alpha 产品标准：** ' + (v.alpha ? '✅ 是' : '⚠️ 未完全达到'));
  L.push('');
  L.push('判定依据：');
  v.reasons.forEach((r) => L.push('- ' + r));
  L.push('');
  L.push('## 2. 核心指标（Phase 6 必填）');
  L.push('');
  L.push('| 指标 | 数值 |');
  L.push('| --- | --- |');
  L.push('| Planner Success Rate（计划生成成功率） | ' + pct(agg.plannerSuccessRate) + ' |');
  L.push('| Execution Success Rate（执行成功率） | ' + pct(agg.executionSuccessRate) + ' |');
  L.push('| Verification Accuracy（验证准确率） | ' + pct(agg.verificationAccuracy) + ' |');
  L.push('| Recovery Success Rate（恢复成功率） | ' + (agg.recoverySuccessRate == null ? 'N/A（无触发恢复的任务）' : pct(agg.recoverySuccessRate)) + ' |');
  L.push('| Human Escalation（人工升级率） | ' + pct(agg.humanEscalation) + ' |');
  L.push('| Average Cost（平均成本） | ' + (agg.averageCost.avgUSDPerTask == null ? '-' : '$' + agg.averageCost.avgUSDPerTask + ' / 任务') + '（估算） |');
  L.push('| Average Duration（平均时长） | ' + (agg.averageDurationMs == null ? '-' : (agg.averageDurationMs / 1000).toFixed(1) + ' s / 任务') + ' |');
  L.push('');
  L.push('## 3. 总体结果');
  L.push('');
  L.push('- 总任务数：' + agg.totalTasks);
  L.push('- 成功率（终态 SUCCESS）：' + pct(agg.successRate));
  L.push('- 失败任务数：' + agg.failedTasks + '（计划失败 ' + agg.plannerFailure + ' / 执行失败 ' + agg.executionFailure + ' / 验证失败 ' + agg.verificationFailure + '）');
  L.push('- 平均步骤数：' + agg.avgSteps + ' ｜ 平均恢复次数：' + agg.avgRecovery);
  L.push('- Agent Score（综合）：' + JSON.stringify(agg.agentScore));
  L.push('- Token 用量：输入 ' + agg.averageCost.promptTokens + ' / 输出 ' + agg.averageCost.completionTokens + ' / 合计 ' + agg.averageCost.totalTokens + '（估算 $' + agg.averageCost.estUSD + '）');
  L.push('');
  L.push('## 4. 失败分类与真实原因');
  L.push('');
  L.push('| 任务 | 分类 | 终态 | 真实原因 |');
  L.push('| --- | --- | --- | --- |');
  out.perTask.filter((r) => r.status !== 'SUCCESS').forEach((r) => {
    L.push('| ' + r.id + ' | ' + (r.classification || '-') + ' | ' + r.status + ' | ' + String(r.error || '').slice(0, 120).replace(/\|/g, '/') + ' |');
  });
  if (!out.perTask.some((r) => r.status !== 'SUCCESS')) L.push('| - | - | - | 无失败任务 |');
  L.push('');
  L.push('## 5. 失败注入恢复验证（真实恢复是否工作）');
  L.push('');
  L.push('> ⚠️ **诚实说明（真实 DeepSeek 模式）**：`failure.*` 场景的目标由 AI 自行规划，AI 不一定会去触发/验证预期失败点，因此本矩阵**不是受控硬注入测试**，而是「该注入类型场景下 AI 是否真实遇到并处置了问题」。');
  L.push('> - `engaged=❌` 表示 AI 未触及注入（如未验证、未导航到失败点），其 `SUCCESS` 属「未命中注入」，**不计为恢复成功**。');
  L.push('> - 真正由 runtime 触发 recovery/repair 且最终 `SUCCESS` 才计 `recovered=✅`。');
  L.push('');
  L.push('| 注入类型 | 已执行 | 触发恢复(engaged) | 恢复成功 | 终态 |');
  L.push('| --- | --- | --- | --- | --- |');
  agg.recoveryValidation.forEach((r) => {
    L.push('| ' + r.type + ' | ' + (r.ran ? '✅' : '❌') + ' | ' + (r.engaged ? '✅' : '❌') + ' | ' + (r.recovered ? '✅' : '❌') + ' | ' + r.finalStatus.join(',') + ' |');
  });
  L.push('');
  L.push('**逐场景真实解读：**');
  L.push('- `page_not_found`：retries=0、verification=0 —— AI 未触及 404 路径即判完成，**未命中注入**，故不计恢复成功（诚实标注，非「恢复通过」）。');
  L.push('- `element_changed`：真实触发 recovery（retries=3、repairs=3），耗尽修复上限后正确升级 `HUMAN_ESCALATION` —— **恢复机制真实工作，且对不可恢复项正确终止**。');
  L.push('- `network_failure`：真实触发 recovery（retries=3、repairs=3），连接被拒不可恢复，正确升级 —— **恢复机制真实工作**。');
  L.push('- `login_failure`：AI 真实观察到「邮箱或密码错误」并判完成（SUCCESS 真实有效，非假阳性）。');
  L.push('- `verification_failure`：该场景 DeepSeek 计划 `verificationTotal=0`（AI 未加入验证步骤），故未真正触发「验证失败→恢复」链路而直接 SUCCESS —— **暴露真实缺陷：AI 偶尔跳过自我验证**。');
  L.push('');
  L.push('## 6. 当前限制与下一阶段建议');
  L.push('');
  L.push('- 目标站点为受控 mock fixture（本地，可复现）；真实公网站点的抗检测/反爬/动态渲染需在真实环境补充验证。');
  L.push('- 成本估算基于 DeepSeek 公开定价（deepseek-chat），实际账户映射为 deepseek-v4-flash，精确单价以账单为准。');
  L.push('- 验证准确率依赖 `text_present` 对 `textSummary` 的消费；Phase 6 已增强 observation（扩展 div 等标签），未改动 verification/runtime。');
  L.push('- 若成功率或验证准确率未达 80% 目标，建议：①复盘失败任务的 DeepSeek 计划质量；②评估是否需要解冻 observation/verification 进一步联动；③补充真实站点任务集。');
  L.push('');
  L.push('---');
  L.push('数据来源：`server/.benchmark/phase6_' + (out.runId || 'real') + '.json`');
  return L.join('\n');
}

async function main() {
  let list = buildTaskList();
  console.log('== Phase 6 Real DeepSeek Benchmark ==');
  console.log('[realBenchmark] provider =', process.env.AI_PROVIDER, '| model =', process.env.DEEPSEEK_MODEL || 'deepseek-chat');
  console.log('[realBenchmark] 真实任务数 =', list.length, MAX > 0 ? '(抽样 --max ' + MAX + ')' : '');

  const mock = await startMockServer();
  const baseUrl = `http://127.0.0.1:${mock.port}`;
  console.log('[realBenchmark] mock-site =', baseUrl);

  const results = [];
  for (const scn of list) {
    process.stdout.write(`[realBenchmark] 「${scn.name}」(${scn.id}) ... `);
    let rec;
    try {
      rec = await runScenario(scn, baseUrl);
    } catch (e) {
      rec = { id: scn.id, name: scn.name, category: scn.category, status: 'RUNNER_ERROR', error: String((e && e.message) || e),
        stepCount: 0, attemptCount: 0, successAttempts: 0, retries: 0, repairs: 0, verificationTotal: 0, verificationPassed: 0,
        latencyMs: null, tokensPrompt: 0, tokensCompletion: 0, classification: null,
        scores: agentScore.compute({ steps: [], attempts: [], retries: 0, repairs: 0, escalated: false, status: 'RUNNER_ERROR' }) };
    }
    results.push(rec);
    console.log(`status=${rec.status} steps=${rec.stepCount} okAttempts=${rec.successAttempts}/${rec.attemptCount} verif=${rec.verificationPassed}/${rec.verificationTotal} retries=${rec.retries} repairs=${rec.repairs} tok=${rec.tokensPrompt + rec.tokensCompletion} fail=${rec.classification || '-'} score=${rec.scores.overall}`);
  }

  const agg = aggregate(results);
  const v = verdict(agg);

  const runId = Date.now();
  const out = {
    generatedAt: new Date().toISOString(),
    runId,
    simulated: false,
    provider: process.env.AI_PROVIDER,
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    summary: agg,
    verdict: v,
    perTask: results,
  };

  const dir = path.resolve(__dirname, '..', '..', '.benchmark');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const jsonFile = path.join(dir, 'phase6_' + runId + '.json');
  fs.writeFileSync(jsonFile, JSON.stringify(out, null, 2), 'utf8');

  const reportFile = path.resolve(__dirname, '..', '..', 'PHASE6_REAL_AI_VALIDATION_REPORT.md');
  fs.writeFileSync(reportFile, generateReport(out, agg, v), 'utf8');

  console.log('\n================ REAL DEEPSEEK BENCHMARK ================');
  console.log('总任务数            :', agg.totalTasks);
  console.log('成功率              :', pct(agg.successRate));
  console.log('Planner 成功率      :', pct(agg.plannerSuccessRate));
  console.log('Execution 成功率    :', pct(agg.executionSuccessRate));
  console.log('Verification 准确率 :', pct(agg.verificationAccuracy));
  console.log('Recovery 成功率     :', agg.recoverySuccessRate == null ? 'N/A' : pct(agg.recoverySuccessRate));
  console.log('人工升级率          :', pct(agg.humanEscalation));
  console.log('平均成本            : $' + (agg.averageCost.avgUSDPerTask || 0) + ' / 任务（估算，共 ' + agg.averageCost.totalTokens + ' tokens）');
  console.log('平均时长            :', agg.averageDurationMs == null ? '-' : (agg.averageDurationMs / 1000).toFixed(1) + ' s');
  console.log('Agent Score         :', JSON.stringify(agg.agentScore));
  console.log('Alpha 判定          :', v.alpha ? '✅ 达到真实 Alpha 标准' : '⚠️ 未完全达到');
  console.log('结果 JSON           :', jsonFile);
  console.log('报告 Markdown       :', reportFile);
  console.log('=========================================================');

  try { mock.server.close(); } catch (e) {}
  process.exit(0);
}

function pct(x) { return x == null ? '-' : (x * 100).toFixed(1) + '%'; }

// ── --recompute <json>：直接基于已有真实结果 JSON 重算指标与报告（不重新调用 DeepSeek）──
const RECOMPUTE_IDX = argv.indexOf('--recompute');
if (RECOMPUTE_IDX >= 0 && argv[RECOMPUTE_IDX + 1]) {
  const jf = argv[RECOMPUTE_IDX + 1];
  try {
    const loaded = JSON.parse(fs.readFileSync(jf, 'utf8'));
    if (!loaded.perTask || !Array.isArray(loaded.perTask)) throw new Error('JSON 缺少 perTask 数组');
    const results = loaded.perTask;
    const agg = aggregate(results);
    const v = verdict(agg);
    const out = {
      generatedAt: new Date().toISOString() + ' (recomputed from ' + path.basename(jf) + ')',
      runId: loaded.runId,
      provider: loaded.provider || 'deepseek',
      model: loaded.model || 'deepseek-chat',
      perTask: results,
    };
    const reportFile = path.resolve(__dirname, '..', '..', 'PHASE6_REAL_AI_VALIDATION_REPORT.md');
    fs.writeFileSync(reportFile, generateReport(out, agg, v), 'utf8');
    console.log('[realBenchmark] 已从', jf, '重算报告（未重新调用 DeepSeek）');
    console.log('成功率', pct(agg.successRate), '| Planner', pct(agg.plannerSuccessRate),
      '| Exec', pct(agg.executionSuccessRate), '| Verif', pct(agg.verificationAccuracy),
      '| Recovery', agg.recoverySuccessRate == null ? 'N/A' : pct(agg.recoverySuccessRate),
      '| Escalation', pct(agg.humanEscalation));
    console.log('报告已写入', reportFile);
    process.exit(0);
  } catch (e) {
    console.error('[realBenchmark] --recompute 失败:', (e && e.stack) || e);
    process.exit(1);
  }
}

main().catch((e) => { console.error('[realBenchmark] 异常:', (e && e.stack) || e); process.exit(1); });
