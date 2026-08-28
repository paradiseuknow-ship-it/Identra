'use strict';

// Phase 2 最小真实执行入口（AI Planner 产品闭环 smoke，非 benchmark / 非 E4）。
//
// 链路（唯一真实路径）：
//   ContextBuilder.build → planner.planObjective → provider.plan(DeepSeek) → schema 校验 → evidence
//   --full: taskManager.createTask(不 attachPlan) → start → runtime.run
//           → resolvePlan → ContextBuilder → Planner → provider.plan → browser 执行 → verification
//
// 约束（Phase 2 收口）：
//   - 不修改 E4 / benchmark / 历史实验。
//   - 不创建复杂 harness。
//   - 无 DEEPSEEK_API_KEY 时【不回退 mock、不模拟成功】，仅完成代码与可执行入口，诚实退出。
//
// 用法：
//   DEEPSEEK_API_KEY=sk-... node server/scripts/smoke.js           # 仅验证 Planner 链路（无需浏览器）
//   DEEPSEEK_API_KEY=sk-... node server/scripts/smoke.js --full    # 端到端：task→browser→planner→runtime 跑 mock-site/search.html

const path = require('path');
const http = require('http');
const fs = require('fs');

const FULL = process.argv.includes('--full');
const hasRealProvider = !!(
  process.env.DEEPSEEK_API_KEY ||
  (process.env.AI_PROVIDER && ['deepseek', 'openai'].includes(process.env.AI_PROVIDER))
);

if (!hasRealProvider) {
  console.error('[smoke] 缺少真实 LLM 环境：未检测到 DEEPSEEK_API_KEY / AI_PROVIDER=deepseek|openai。');
  console.error('[smoke] 按 Phase 2 约束，不回退 mock、不模拟成功。');
  console.error('[smoke] 提供 key 后重跑： DEEPSEEK_API_KEY=sk-... node server/scripts/smoke.js');
  process.exit(2);
}

// 强制使用真实 deepseek（绝不回退 mock）
process.env.AI_PROVIDER = process.env.AI_PROVIDER || 'deepseek';

const contextBuilder = require('../agent/contextBuilder');
const planner = require('../agent/planner');
const { createProvider } = require('../agent/provider');
// 注册 deepseek provider 工厂（createProvider('deepseek') 前必须先 require，否则工厂未注册）
require('../agent/llm/providers/deepseek');
const plannerEvidence = require('../agent/plannerEvidence');

// mock-site 本地文件（真实浏览器导航目标；用 file:// 免起 http server）。
// 注意：Windows 下 path.resolve 返回反斜杠路径，必须转为正斜杠并写成合法 file:///C:/... 形式，
// 否则 Playwright 导航失败（这正是 --full 首次跑 HUMAN_ESCALATION 的根因，属入口 URL 拼接问题）。
const _abs = path.resolve(__dirname, '..', '..', 'mock-site', 'search.html').replace(/\\/g, '/');
const MOCK_SEARCH = 'file:///' + _abs.replace(/^([A-Za-z]):/, (m, d) => d.toLowerCase() + ':');
const OBJECTIVE = '在搜索框输入 "hello world" 并提交，验证页面出现搜索结果';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 极简静态服务器托管 mock-site（与项目自有 test-site 同思路，用 http 而非 file:// 以避免本环境 file:// 导航不稳）。
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

// ── 阶段一：真实 Planner 链路（ContextBuilder → Planner → provider.plan → schema → evidence）──
async function runPlannerLink(targetUrl) {
  const taskId = 'smoke_task_' + Date.now().toString(36);
  const executionId = 'smoke_exec_' + Date.now().toString(36);

  const ctx = {
    taskId,
    executionId,
    context: contextBuilder.build({
      task: { id: taskId, objective: OBJECTIVE, targetUrl, executionMode: 'AUTONOMOUS', status: 'PLANNING' },
      steps: [],
      checkpoint: null,
      errorHistory: [],
      budgetCfg: { taskId },
    }),
  };

  const provider = createProvider('deepseek');
  console.log('[smoke] provider =', provider.kind, provider.model || '(env model)');
  console.log('[smoke] 调用 planner.planObjective（真实 DeepSeek provider.plan）...');

  const pr = await planner.planObjective({
    objective: OBJECTIVE,
    target: targetUrl,
    constraints: [],
    credentialRefs: [],
    executionMode: 'AUTONOMOUS',
    provider,
    ctx,
  });

  if (!pr.ok) {
    console.error('[smoke] 规划失败：', pr.error, pr.code ? '(' + pr.code + ')' : '');
    return { ok: false, error: pr.error, code: pr.code };
  }

  console.log('[smoke] 规划成功，capability =', pr.capability, '，steps =', pr.plan.steps.length);
  pr.plan.steps.forEach((s, i) => {
    console.log(`  step_${String(i + 1).padStart(3, '0')} ${s.type} :: ${s.description}  [action=${s.action && s.action.type}]`);
  });

  const ev = plannerEvidence.list(1)[0];
  console.log('[smoke] 已记录 Planner Evidence：', ev ? JSON.stringify({
    taskId: ev.taskId, executionId: ev.executionId, provider: ev.provider,
    model: ev.model, objectiveHash: ev.objectiveHash.slice(0, 12),
    stepCount: ev.stepCount, schemaResult: ev.schemaResult,
  }) : 'N/A');

  return { ok: true, plan: pr.plan, evidence: ev };
}

// ── 阶段二（--full）：端到端 task → browser → planner → runtime ──
async function runFull(targetUrl) {
  const db = require('../db');
  const taskManager = require('../agent/taskManager');
  const store = require('../agent/store');
  const browserManager = require('../browserManager');
  // 必须加载 runtime：注册 executor 钩子，否则 start() 的 kick 空转、任务永远停在 RUNNING
  require('../agent/runtime');

  const PROFILE_ID = 'p_smoke_' + Date.now().toString(36);
  const profile = {
    id: PROFILE_ID, name: 'Smoke', group: 'default', tags: [], notes: '',
    seed: 'smoke-seed', headless: true, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { restoreLastSession: false, blockVideo: false, blockImages: false, clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false },
    fingerprintOverride: {}, fingerprint: null, lastSessionUrls: [], createdAt: Date.now(),
  };
  db.upsertProfile(profile);

  const task = taskManager.createTask({
    name: 'Smoke real',
    objective: OBJECTIVE,
    targetUrl,
    profileId: PROFILE_ID,
    executionMode: 'AUTONOMOUS',
    constraints: [],
    // 受控 smoke：本任务为良性搜索 demo，显式抬高 riskFloor 至 HIGH，
    // 使 HIGH 风险 submit 在 AUTONOMOUS 下自动执行（policy 框架原生支持 per-task riskFloor，
    // 不改动核心策略逻辑；CRITICAL 仍独立受 autoPayment 约束）。
    policy: { riskFloor: 'HIGH' },
    // 注意：不调用 attachPlan —— 强制 runtime.resolvePlan 走真实 Planner，不复用预置 plan
  });

  console.log('[smoke][full] 创建 task', task.id, '→ start（runtime 将启动浏览器并调用 Planner）');
  console.log('[smoke][full] 浏览器导航目标：', targetUrl);
  taskManager.start(task.id);

  const end = Date.now() + 120000;
  let final = null;
  while (Date.now() < end) {
    final = taskManager.getTask(task.id);
    if (final && ['SUCCESS', 'FAILED', 'HUMAN_ESCALATION', 'CANCELLED'].includes(final.status)) break;
    await sleep(500);
  }

  // 清理
  try { taskManager.cancel(task.id); } catch (e) {}
  try { browserManager.close(PROFILE_ID).catch(() => {}); } catch (e) {}
  try { db.deleteProfile(PROFILE_ID); } catch (e) {}
  try { store.write('aiSteps', store.read('aiSteps', []).filter((s) => s.taskId !== task.id)); } catch (e) {}

  if (!final) { console.error('[smoke][full] 超时未达终态'); process.exit(1); }
  console.log('[smoke][full] 终态 status =', final.status, final.error ? '| error=' + final.error : '');
  const ev = plannerEvidence.list(1)[0];
  console.log('[smoke][full] Planner Evidence：', ev ? JSON.stringify({ provider: ev.provider, model: ev.model, stepCount: ev.stepCount, schemaResult: ev.schemaResult }) : 'N/A');
  return { ok: final.status === 'SUCCESS', status: final.status };
}

async function main() {
  console.log('== Phase 2 最小真实执行入口（smoke）==');
  console.log('[smoke] 目标：', OBJECTIVE);
  const mock = await startMockServer();
  const targetUrl = `http://127.0.0.1:${mock.port}/search.html`;
  console.log('[smoke] mock-site 入口：', targetUrl, '（file:// 形式', MOCK_SEARCH, '仅用于显示）');

  const link = await runPlannerLink(targetUrl);
  if (!link.ok) {
    // 真实调用失败（如 key 无效 / 网络 / schema 不通过）—— 诚实报告，不伪造成功
    console.error('[smoke] Planner 链路真实调用未通过，exit 1');
    try { mock.server.close(); } catch (e) {}
    process.exit(1);
  }

  if (!FULL) {
    console.log('\n[smoke] Planner 链路验证通过（未启用浏览器）。');
    console.log('[smoke] 端到端（task→browser→planner→runtime）请加 --full 重跑：');
    console.log('        DEEPSEEK_API_KEY=sk-... node server/scripts/smoke.js --full');
    try { mock.server.close(); } catch (e) {}
    process.exit(0);
  }

  console.log('\n[smoke] --full：进入端到端浏览器执行...');
  const full = await runFull(targetUrl);
  try { mock.server.close(); } catch (e) {}
  process.exit(full.ok ? 0 : 1);
}

main().catch((e) => { console.error('[smoke] 异常:', e && e.stack || e); process.exit(1); });
