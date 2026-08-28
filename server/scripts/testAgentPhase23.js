'use strict';

// Phase 2.3 验收：Repair Planner。
// 覆盖：repairSchema / repairPolicy / repairPlanner / aiRepairAttempts 生命周期 /
//       cookie 弹窗修复 / timeout 修复（绕过确定性恢复进入 Repair）/ 修复耗尽→PAUSED / Attempt 双保留。
// 注意：集成部分启动浏览器，必须**停止 server 进程**后独立运行。
// 用法：node server/scripts/testAgentPhase23.js

const db = require('../db');
const taskManager = require('../agent/taskManager');
const browserManager = require('../browserManager');
const store = require('../agent/store');
require('../agent/runtime'); // executor + repair 集成
const testSite = require('./_testSite'); // 带版本探针的 test-site 助手

const repairSchema = require('../agent/repair/repairSchema');
const repairPolicy = require('../agent/repair/repairPolicy');
const repairPlanner = require('../agent/repair/repairPlanner');
const repairAttempts = require('../agent/repair/repairAttempts');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ensureTestSite = () => testSite.ensure();
async function waitStatus(taskId, targets, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const t = taskManager.getTask(taskId);
    if (t && targets.includes(t.status)) return t;
    await sleep(600);
  }
  return taskManager.getTask(taskId);
}

const PROFILE = 'p_phase23_' + Date.now().toString(36);
async function makeProfile() {
  db.upsertProfile({
    id: PROFILE, name: 'p23', group: 'default', tags: [], notes: '', seed: 'p23',
    headless: true, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { cacheClearMode: 'none' }, fingerprintOverride: {}, fingerprint: null, lastSessionUrls: [], createdAt: Date.now(),
  });
}
async function cleanup(ids) {
  try { browserManager.close(PROFILE).catch(() => {}); } catch (e) {}
  for (const id of ids) { try { taskManager.cancel(id); } catch (e) {} store.remove('aiTasks', id); }
  store.write('aiSteps', store.read('aiSteps', []).filter((x) => !ids.includes(x.taskId)));
  store.write('aiAttempts', store.read('aiAttempts', []).filter((a) => { const st = store.find('aiSteps', a.stepId); return st && !ids.includes(st.taskId); }));
  store.write('aiRepairAttempts', store.read('aiRepairAttempts', []).filter((x) => !ids.includes(x.taskId)));
  store.write('aiQueue', store.read('aiQueue', []).filter((x) => !ids.includes(x.taskId)));
  store.write('aiFailureSnapshots', store.read('aiFailureSnapshots', []).filter((x) => !ids.includes(x.taskId)));
  db.deleteProfile(PROFILE);
  testSite.cleanup();
}

const NAV = (url, timeoutMs) => ({ type: 'navigate', target: { url }, risk: 'LOW', verification: { type: 'page_change' }, timeoutMs: timeoutMs || 15000 });
const CLICK = (semantic, timeoutMs) => ({ type: 'click', target: { semantic }, risk: 'MEDIUM', verification: { type: 'none' }, timeoutMs: timeoutMs || 15000 });

async function runPlan(name, url, steps) {
  const t = taskManager.createTask({ name, objective: 'x', targetUrl: url, profileId: PROFILE, executionMode: 'AUTONOMOUS', policy: { riskFloor: 'HIGH' } });
  taskManager.attachPlan(t.id, { goal: name, steps });
  taskManager.start(t.id);
  const r = await waitStatus(t.id, ['SUCCESS', 'FAILED', 'PAUSED_FOR_HUMAN'], 120000);
  return { t, r };
}

async function main() {
  console.log('== Phase 2.3 Repair Planner 验收 ==');

  // ---- 1) repairSchema ----
  console.log('[repair-schema]');
  const good = { diagnosisId: 'fs_1', strategy: 'SEMANTIC_RELOCATE', strategyType: 'elementChanged', confidence: 0.91, risk: 'LOW', steps: [{ type: 'inspect', description: '观察' }], verification: { type: 'action_success' }, maxAttempts: 3 };
  ok(repairSchema.validate(good).ok, '合法 Repair Plan 通过');
  ok(!repairSchema.validate({ ...good, strategy: 'MAGIC_FIX' }).ok, '非法 strategy 被拒');
  ok(!repairSchema.validate({ ...good, confidence: 2, risk: 'X', steps: [] }).ok, '非法 confidence/risk/steps 被拒');

  // ---- 2) repairPlanner：诊断类别 → 策略 ----
  console.log('[repair-planner]');
  const plan = (cat, conf) => repairPlanner.planFromDiagnosis({ task: {}, step: { action: { type: 'click', target: { semantic: 'Continue' } } }, diagnosis: { category: cat, confidence: conf }, classifier: { type: cat }, failureSnapshot: { id: 'fs_demo' } });
  let p = plan('ELEMENT_CHANGED', 0.91);
  ok(p.ok && p.plan.strategy === 'SEMANTIC_RELOCATE' && p.plan.risk === 'LOW', 'ELEMENT_CHANGED → SEMANTIC_RELOCATE/LOW', p.error || '');
  p = plan('TIMEOUT', 0.85);
  ok(p.ok && p.plan.strategy === 'WAIT_RETRY_RELOAD' && p.plan.risk === 'LOW', 'TIMEOUT → WAIT_RETRY_RELOAD/LOW');
  p = plan('OBSTRUCTION', 0.9);
  ok(p.ok && p.plan.strategy === 'DISMISS_OVERLAY' && p.plan.risk === 'MEDIUM', 'OBSTRUCTION → DISMISS_OVERLAY/MEDIUM');
  p = plan('SESSION_EXPIRED', 0.95);
  ok(p.ok && p.plan.strategy === 'REAUTH_OR_PAUSE' && p.plan.risk === 'HIGH', 'SESSION_EXPIRED → REAUTH_OR_PAUSE/HIGH');
  p = plan('HTTP_FORBIDDEN', 0.8);
  ok(p.ok && p.plan.risk === 'HIGH', 'HTTP_FORBIDDEN → 保守 HIGH（人工）');

  // ---- 3) repairPolicy ----
  console.log('[repair-policy]');
  const pol = repairPolicy.canExecute;
  ok(pol({ plan: { strategy: 'S', risk: 'LOW', confidence: 0.5 }, task: {} }).allowed, 'LOW 自动');
  ok(pol({ plan: { strategy: 'S', risk: 'MEDIUM', confidence: 0.9 }, task: {} }).allowed, 'MEDIUM + conf 0.9 自动');
  ok(!pol({ plan: { strategy: 'S', risk: 'MEDIUM', confidence: 0.5 }, task: {} }).allowed, 'MEDIUM + conf<0.85 → 人工');
  ok(!pol({ plan: { strategy: 'S', risk: 'HIGH', confidence: 1 }, task: {} }).allowed, 'HIGH → 人工');

  // ---- 4) aiRepairAttempts 生命周期 ----
  console.log('[repair-attempts]');
  const ra = repairAttempts.create({ taskId: 'task_demo', stepId: 's1', strategy: 'SEMANTIC_RELOCATE', strategyType: 'elementChanged', risk: 'LOW', confidence: 0.9 });
  repairAttempts.update(ra.id, { status: 'RUNNING' });
  repairAttempts.update(ra.id, { status: 'SUCCESS', actions: [{ tool: 'retry', ok: true }], finishedAt: Date.now() });
  const raFinal = repairAttempts.get(ra.id);
  ok(raFinal.status === 'SUCCESS' && raFinal.actions.length === 1, 'RepairAttempt 生命周期 PENDING→RUNNING→SUCCESS');

  // ---- 5) 集成 Case 3：cookie 弹窗 → 自动关闭 → 成功 ----
  console.log('[integration-cookie] /cookie 点击被遮挡 → OBSTRUCTION 修复 → 成功');
  await ensureTestSite();
  await makeProfile();
  const c1 = await runPlan('p23 cookie', 'http://localhost:9555/cookie', [
    { id: 'nav', type: 'NAVIGATE', description: '打开', expectedOutcome: 'o', risk: 'LOW', action: NAV('http://localhost:9555/cookie') },
    { id: 'click', type: 'ACT', description: '点击 Continue 并验证跳转', expectedOutcome: 'o', risk: 'MEDIUM', action: { type: 'click', target: { semantic: 'Continue' }, risk: 'MEDIUM', verification: { type: 'page_change' }, timeoutMs: 2500 } },
  ]);
  ok(c1.r.status === 'SUCCESS', 'Cookie 弹窗修复成功', c1.r.error || '');
  const repairs1 = repairAttempts.listForTask(c1.t.id);
  ok(repairs1.length >= 1 && repairs1.some((x) => x.strategy === 'DISMISS_OVERLAY'), '产生 DISMISS_OVERLAY RepairAttempt', JSON.stringify(repairs1.map((x) => x.strategy)));
  const attempts1 = store.read('aiAttempts', []).filter((a) => { const st = store.find('aiSteps', a.stepId); return st && st.taskId === c1.t.id; });
  ok(attempts1.length >= 1 && repairs1.length >= 1, '原始 Attempt 与 RepairAttempt 均保留', 'attempts=' + attempts1.length + ' repairs=' + repairs1.length);

  // ---- 6) 集成 Case 2：timeout 进入 Repair 层（前 4 次都慢）----
  console.log('[integration-timeout] /flaky4 确定性恢复失败 → WAIT_RETRY_RELOAD 修复 → 成功');
  const c2 = await runPlan('p23 timeout', 'http://localhost:9555/flaky4', [
    { id: 'nav', type: 'NAVIGATE', description: '打开', expectedOutcome: 'o', risk: 'LOW', action: NAV('http://localhost:9555/flaky4', 1500) },
  ]);
  ok(c2.r.status === 'SUCCESS', 'Timeout Repair 成功', c2.r.error || '');
  const repairs2 = repairAttempts.listForTask(c2.t.id);
  ok(repairs2.some((x) => x.strategy === 'WAIT_RETRY_RELOAD'), '产生 WAIT_RETRY_RELOAD RepairAttempt', JSON.stringify(repairs2.map((x) => x.strategy)));

  // ---- 7) 集成 Case 4：修复失败 → PAUSED_FOR_HUMAN ----
  console.log('[integration-fail] /empty 完全找不到 → 修复耗尽 → 人工');
  const c3 = await runPlan('p23 fail', 'http://localhost:9555/empty', [
    { id: 'nav', type: 'NAVIGATE', description: '打开', expectedOutcome: 'o', risk: 'LOW', action: NAV('http://localhost:9555/empty') },
    { id: 'click', type: 'ACT', description: '点击 xyzzy', expectedOutcome: 'o', risk: 'MEDIUM', action: CLICK('xyzzy', 2500), maxRetries: 2 },
  ]);
  ok(c3.r.status === 'PAUSED_FOR_HUMAN', '修复耗尽 → PAUSED_FOR_HUMAN（不无限循环）', c3.r.error || '');
  const repairs3 = repairAttempts.listForTask(c3.t.id);
  ok(repairs3.filter((x) => x.status === 'FAILED').length >= 1, '存在 FAILED RepairAttempt', String(repairs3.length));
  ok(repairs3.length <= 3, '修复尝试受 maxRepairAttempts 限制', String(repairs3.length));

  // ---- 8) 集成 Case 1：按钮变化（走确定性恢复层）----
  console.log('[integration-element] /renamed Proceed→Continue 语义重定位成功');
  const c4 = await runPlan('p23 element', 'http://localhost:9555/renamed', [
    { id: 'nav', type: 'NAVIGATE', description: '打开', expectedOutcome: 'o', risk: 'LOW', action: NAV('http://localhost:9555/renamed') },
    { id: 'click', type: 'ACT', description: '点击 Proceed', expectedOutcome: 'o', risk: 'MEDIUM', action: CLICK('Proceed', 2500) },
  ]);
  ok(c4.r.status === 'SUCCESS', '按钮文字变化自动恢复成功', c4.r.error || '');

  console.log(`\n== 结果: PASS ${pass} / FAIL ${fail} ==`);
  await cleanup([c1.t.id, c2.t.id, c3.t.id, c4.t.id]);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); testSite.cleanup(); process.exit(1); });
