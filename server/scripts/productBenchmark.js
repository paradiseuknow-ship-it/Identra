'use strict';

// Phase 5 Product Benchmark Runner（Task 2 / Task 4）。
//
// 批量执行真实场景任务，产出产品级能力指标。复用唯一真实链路：
//   taskManager.createTask(不 attachPlan) → start → runtime.run → Planner(DeepSeek) → browser → verification → recovery。
//
// 输出（stdout + JSON 文件，server/.benchmark/phase5_<ts>.json）：
//   {
//     totalTasks, successRate, humanEscalationRate,
//     avgSteps, avgRecovery, avgLatency,
//     plannerFailure, executionFailure, verificationFailure,
//     agentScore: { planning, execution, recovery, verification, autonomy, overall, sampleSize },
//     recoveryValidation: [ { type, ran, recoveryTriggered, recovered, finalStatus } ],  // Task 4
//     perTask: [ ... ]
//   }
//
// 约束（Phase 5 冻结）：不修改 runtime / planner / provider / fingerprint / E4 / matrix。
//   - 默认要求真实 LLM（DEEPSEEK_API_KEY / OPENAI_API_KEY / AI_PROVIDER）；无 key 且未显式 --mock 则退出（与 matrix.js 一致，不伪造成功）。
//   - --mock 仅用于框架自检（planner 为 mock、场景盲，结果标记为 SIMULATED，不构成产品结论）。
//
// 用法：
//   DEEPSEEK_API_KEY=sk-... node server/scripts/productBenchmark.js
//   node server/scripts/productBenchmark.js --mock                 # 框架自检（SIMULATED）
//   node server/scripts/productBenchmark.js --category saas --max 2
//   node server/scripts/productBenchmark.js --injection           # 仅跑 5 类失败注入
//   node server/scripts/productBenchmark.js --timeout 60000

const path = require('path');
const fs = require('fs');
const http = require('http');

const hasRealProvider = !!(
  process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || process.env.AI_API_KEY ||
  (process.env.AI_PROVIDER && ['deepseek', 'openai'].includes(process.env.AI_PROVIDER))
);

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const nxt = argv[i + 1];
  // 布尔标志：后面没有值或下一个也是 --flag 时视为 true
  if (nxt === undefined || nxt.startsWith('--')) return true;
  return nxt;
}
const USE_MOCK = arg('--mock', false) === true || arg('--mock', false) === 'true';
const FILTER_CATEGORY = arg('--category', null);
const ONLY_INJECTION = arg('--injection', false) === true;
const MAX = parseInt(arg('--max', '0'), 10) || 0;
const PER_TASK_TIMEOUT = parseInt(arg('--timeout', '90000'), 10) || 90000;

if (!hasRealProvider && !USE_MOCK) {
  console.error('[benchmark] 缺少真实 LLM 环境：未检测到 DEEPSEEK_API_KEY / OPENAI_API_KEY / AI_API_KEY / AI_PROVIDER。');
  console.error('[benchmark] 按 Phase 5 约束不回退模拟成功。提供 key 后重跑，或用 --mock 仅做框架自检（结果标记 SIMULATED）。');
  process.exit(2);
}
if (USE_MOCK) {
  console.warn('[benchmark] ⚠ --mock 模式：planner 为 mock（场景盲），结果仅用于框架自检，不构成产品结论。');
  process.env.AI_PROVIDER = 'mock';
} else {
  process.env.AI_PROVIDER = process.env.AI_PROVIDER || 'deepseek';
}
require('../agent/llm/providers/deepseek');
require('../agent/llm/providers/openai');

const scenarios = require('../scenarios');
const agentScore = require('../agentScore');
const store = require('../agent/store');

// ── 框架自检用的确定性 fixture-aware 计划（仅 --mock / 无真实 key 时使用）──
// 说明：这是【测试替身】，不是产品 Planner。真实 Planner（DeepSeek）在真实 key 模式下运行，
//       其能力已在 Phase 3 / 4.4 单独验证（10/10 SUCCESS）。本替身仅用于在本环境无 key 时，
//       驱动真实 runtime（tools/browser/verification/recovery/observability/scoring）做端到端自检。
//       目标解析走既有 semanticResolver（field 作为语义查询），不依赖 LLM。
function firstQuoted(s) { const m = s.match(/[“"]([^”"]+)[”"]/); return m ? m[1] : ''; }
function parseName(s) { const m = s.match(/姓名[“"]([^”"]+)[”"]/); return m ? m[1] : '测试用户'; }
function parseEmail(s) { const m = s.match(/邮箱[“"]([^”"]+)[”"]/); return m ? m[1] : 'test@test.io'; }
function parsePhone(s) { const m = s.match(/手机号[“"]([^”"]+)[”"]/); return m ? m[1] : '13800000000'; }
function isWrongCreds(s) { return /错误/.test(s); }

function navStep(url) {
  return { id: 's_nav', type: 'NAVIGATE', description: '打开 ' + url, expectedOutcome: '', risk: 'LOW',
    action: { type: 'navigate', target: { url }, risk: 'LOW', verification: { type: 'page_change' } } };
}
function fillStep(field, val) {
  return { id: 's_fill_' + field, type: 'ACT', description: '填写 ' + field, expectedOutcome: '', risk: 'MEDIUM',
    action: { type: 'fill', target: { field }, value: val, risk: 'MEDIUM', verification: { type: 'none' } } };
}
function selectStep(field, val) {
  return { id: 's_select_' + field, type: 'ACT', description: '选择 ' + field, expectedOutcome: '', risk: 'MEDIUM',
    action: { type: 'select', target: { field }, value: val, risk: 'MEDIUM', verification: { type: 'none' } } };
}
function clickStep(field, verifyText) {
  return { id: 's_click_' + field, type: 'ACT', description: '点击 ' + field, expectedOutcome: '', risk: 'MEDIUM',
    action: { type: 'click', target: { field }, risk: 'MEDIUM',
      verification: verifyText ? { type: 'text_present', expect: verifyText } : { type: 'none' } } };
}
function verifyStep(text) {
  // 用 inspect 取整页观察（可靠），再做 text_present 断言
  return { id: 's_verify', type: 'VERIFY', description: '验证出现“' + text + '”', expectedOutcome: '', risk: 'LOW',
    action: { type: 'inspect', target: { role: 'page' }, risk: 'LOW', verification: { type: 'text_present', expect: text } } };
}

function presetPlanFor(scn, targetUrl) {
  const kw = firstQuoted(scn.objective) || '测试';
  const f = scn.fixture || '';
  let steps = [];
  if (f.includes('ecommerce/search')) {
    steps = [navStep(targetUrl), fillStep('q', kw), clickStep('searchBtn', kw)];
  } else if (f.includes('saas/login')) {
    if (scn.id === 'saas.export_report') {
      steps = [navStep(targetUrl), fillStep('email', 'ops@cloudsaas.io'), fillStep('password', 'Saas#2024'), clickStep('loginBtn'), clickStep('exportBtn', '报表已导出')];
    } else if (isWrongCreds(scn.objective)) {
      steps = [navStep(targetUrl), fillStep('email', 'ops@cloudsaas.io'), fillStep('password', 'WrongPass123'), clickStep('loginBtn', '数据看板')];
    } else {
      steps = [navStep(targetUrl), fillStep('email', 'ops@cloudsaas.io'), fillStep('password', 'Saas#2024'), clickStep('loginBtn', '数据看板')];
    }
  } else if (f.includes('admin/users')) {
    steps = [navStep(targetUrl), fillStep('username', 'alice'), fillStep('email', 'alice@corp.io'), selectStep('role', 'viewer'), clickStep('addBtn', '用户已创建')];
  } else if (f.includes('data_entry/form')) {
    steps = [navStep(targetUrl), fillStep('name', parseName(scn.objective)), fillStep('email', parseEmail(scn.objective)), fillStep('phone', parsePhone(scn.objective)), clickStep('submitBtn', '注册成功')];
  } else if (f.includes('scraping/list')) {
    steps = [navStep(targetUrl), verifyStep('戴尔 U2723QE')];
  } else if (f.includes('misc/verify_fail')) {
    steps = [navStep(targetUrl), clickStep('actBtn', '操作成功')];
  } else if (f.includes('missing.html')) {
    steps = [navStep(targetUrl), fillStep('q', '测试'), clickStep('searchBtn')];
  } else if (scn.failureInjection && scn.failureInjection.type === 'network_failure') {
    steps = [navStep(targetUrl), fillStep('q', '测试')];
  } else {
    steps = [navStep(targetUrl), verifyStep('测试')];
  }
  return { goal: scn.objective, steps };
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

// 解析场景目标 URL（含失败注入处理）
function resolveTargetUrl(scn, baseUrl) {
  const inj = scn.failureInjection && scn.failureInjection.type;
  if (inj === 'network_failure') {
    // 不可达端口 → 连接被拒 → NETWORK_ERROR（不依赖任何 fixture）
    return 'http://127.0.0.1:1/';
  }
  const fixture = scn.fixture || 'search.html';
  return baseUrl + '/' + fixture;
}

const TERMINAL = ['SUCCESS', 'FAILED', 'HUMAN_ESCALATION', 'CANCELLED'];

async function runScenario(scn, baseUrl) {
  const db = require('../db');
  const taskManager = require('../agent/taskManager');
  const browserManager = require('../browserManager');
  require('../agent/runtime'); // 注册 executor 钩子

  const PROFILE_ID = 'p_bench_' + scn.id.replace(/[^a-zA-Z0-9]/g, '_') + '_' + Date.now().toString(36);
  const profile = {
    id: PROFILE_ID, name: 'Bench-' + scn.id, group: 'default', tags: [], notes: '',
    seed: 'bench-seed', headless: true, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { restoreLastSession: false, blockVideo: false, blockImages: false, clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false },
    fingerprintOverride: {}, fingerprint: null, lastSessionUrls: [], createdAt: Date.now(),
  };
  db.upsertProfile(profile);

  const targetUrl = resolveTargetUrl(scn, baseUrl);
  const task = taskManager.createTask({
    name: 'Bench ' + scn.name,
    objective: scn.objective,
    targetUrl,
    profileId: PROFILE_ID,
    executionMode: 'AUTONOMOUS',
    constraints: [],
    policy: { riskFloor: 'HIGH' },
  });

  // 框架自检模式：注入确定性 fixture-aware 计划（不调用 LLM Planner，走既有 attachPlan 路径）。
  // 真实 key 模式：不注入计划，由真实 DeepSeek Planner 运行时生成（端到端验证）。
  if (USE_MOCK) {
    taskManager.attachPlan(task.id, presetPlanFor(scn, targetUrl));
  }

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
    id: s.id,
    status: s.status,
    hasVerification: !!(s.verification && s.verification.type && s.verification.type !== 'none'),
  }));
  const attempts = store.read('aiAttempts', [])
    .filter((a) => stepIds.has(a.stepId))
    .map((a) => ({
      stepId: a.stepId,
      status: a.status,
      isError: a.status !== 'SUCCESS' && !!a.error,
      code: a.error && a.error.code,
    }));
  const retries = store.read('aiEvents', [])
    .filter((e) => e.taskId === task.id && e.type === 'agent.retrying').length;
  const repairs = store.read('aiRepairAttempts', [])
    .filter((r) => r.taskId === task.id).length;
  const snapshots = store.read('aiFailureSnapshots', [])
    .filter((s) => s.taskId === task.id);
  const escalated = final.status === 'HUMAN_ESCALATION';

  const metrics = {
    taskId: task.id, status: final.status,
    error: final.error || null,
    startedAt: final.startedAt, finishedAt: final.finishedAt,
    steps, attempts, retries, repairs, escalated,
  };
  const scores = agentScore.compute(metrics);
  const classification = classifyFailure(scn, final, steps, attempts, snapshots);

  // 清理（保留分析数据于 store / JSON）
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
    retries, repairs,
    latencyMs: (final.startedAt && final.finishedAt) ? final.finishedAt - final.startedAt : null,
    classification, // planner | execution | verification | null
    scores,
  };
}

// 失败分类（流水线视角，与注入类型正交）：planner / execution / verification
function classifyFailure(scn, final, steps, attempts, snapshots) {
  if (!final || final.status === 'SUCCESS') return null;
  const errText = String((final.error && (final.error.message || final.error)) || '');
  if (steps.length === 0 || /计划生成失败|计划为空|PLAN_FAIL|plan objective|planning/i.test(errText)) {
    return 'planner';
  }
  const inj = scn.failureInjection && scn.failureInjection.type;
  const codes = attempts.map((a) => a.code).filter(Boolean)
    .concat(snapshots.map((s) => s.errorType).filter(Boolean));
  const hasVerifyFail = codes.some((c) => /VERIFY|VERIFICATION/i.test(c)) ||
    inj === 'verification_failure' || inj === 'login_failure' ||
    /验证|VERIFY/i.test(errText);
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

  const scoreAgg = agentScore.aggregate(results.map((r) => r.scores));

  // Task 4：5 类失败注入覆盖验证
  const REQUIRED = ['page_not_found', 'element_changed', 'network_failure', 'login_failure', 'verification_failure'];
  const recoveryValidation = REQUIRED.map((type) => {
    const run = results.filter((r) => r.failureInjection === type);
    const ran = run.length > 0;
    const recoveryTriggered = ran && run.some((r) => r.retries + r.repairs > 0);
    const recovered = ran && run.some((r) => r.status === 'SUCCESS');
    return {
      type, ran,
      recoveryTriggered: !!recoveryTriggered,
      recovered: !!recovered,
      finalStatus: ran ? run.map((r) => r.status) : [],
    };
  });

  return {
    totalTasks: total,
    successRate: total ? +(success / total).toFixed(4) : null,
    humanEscalationRate: total ? +(escalated / total).toFixed(4) : null,
    avgSteps, avgRecovery, avgLatency,
    plannerFailure, executionFailure, verificationFailure,
    failedTasks: failed,
    agentScore: scoreAgg,
    recoveryValidation,
  };
}

async function main() {
  let list = scenarios.loadAll();
  if (ONLY_INJECTION) list = list.filter((s) => s.failureInjection && s.failureInjection.type);
  else if (FILTER_CATEGORY) list = list.filter((s) => s.category === FILTER_CATEGORY);
  if (MAX > 0) list = list.slice(0, MAX);

  console.log('== Phase 5 Product Benchmark ==');
  console.log('[benchmark] provider =', process.env.AI_PROVIDER, USE_MOCK ? '(SIMULATED)' : '(real)');
  console.log('[benchmark] 场景数 =', list.length, ONLY_INJECTION ? '(仅失败注入)' : FILTER_CATEGORY ? '(分类: ' + FILTER_CATEGORY + ')' : '');

  const mock = await startMockServer();
  const baseUrl = `http://127.0.0.1:${mock.port}`;
  console.log('[benchmark] mock-site =', baseUrl);

  const results = [];
  for (const scn of list) {
    process.stdout.write(`[benchmark] 「${scn.name}」(${scn.id}) ... `);
    let rec;
    try {
      rec = await runScenario(scn, baseUrl);
    } catch (e) {
      rec = { id: scn.id, name: scn.name, status: 'RUNNER_ERROR', error: String(e && e.message || e), scores: agentScore.compute({ steps: [], attempts: [], retries: 0, repairs: 0, escalated: false, status: 'RUNNER_ERROR' }) };
    }
    results.push(rec);
    console.log(`status=${rec.status} steps=${rec.stepCount} retries=${rec.retries} repairs=${rec.repairs} fail=${rec.classification || '-'} score=${rec.scores.overall}`);
  }

  const agg = aggregate(results);

  const out = {
    generatedAt: new Date().toISOString(),
    simulated: !!USE_MOCK,
    provider: process.env.AI_PROVIDER,
    summary: agg,
    perTask: results,
  };

  const dir = path.resolve(__dirname, '..', '..', '.benchmark');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const file = path.join(dir, 'phase5_' + Date.now() + '.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');

  console.log('\n================ PRODUCT BENCHMARK ================');
  console.log('模式            :', USE_MOCK ? 'SIMULATED (mock planner)' : 'REAL (' + process.env.AI_PROVIDER + ')');
  console.log('总任务数        :', agg.totalTasks);
  console.log('成功率          :', agg.successRate != null ? (agg.successRate * 100).toFixed(1) + '%' : '-');
  console.log('人工升级率      :', agg.humanEscalationRate != null ? (agg.humanEscalationRate * 100).toFixed(1) + '%' : '-');
  console.log('平均步骤数      :', agg.avgSteps);
  console.log('平均恢复次数    :', agg.avgRecovery);
  console.log('平均延迟(ms)    :', agg.avgLatency);
  console.log('计划失败        :', agg.plannerFailure);
  console.log('执行失败        :', agg.executionFailure);
  console.log('验证失败        :', agg.verificationFailure);
  console.log('Agent Score     :', JSON.stringify(agg.agentScore));
  console.log('恢复验证(Task4) :');
  agg.recoveryValidation.forEach((r) => {
    console.log(`  - ${r.type.padEnd(18)} ran=${r.ran} recoveryTriggered=${r.recoveryTriggered} recovered=${r.recovered} status=${r.finalStatus.join(',') || '-'}`);
  });
  console.log('结果 JSON       :', file);
  console.log('===================================================');

  try { mock.server.close(); } catch (e) {}
  process.exit(0);
}

main().catch((e) => { console.error('[benchmark] 异常:', e && e.stack || e); process.exit(1); });
