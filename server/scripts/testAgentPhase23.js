'use strict';

// Phase 2.3 验收：Repair Planner。
// 覆盖：repairSchema / repairPolicy / repairPlanner / aiRepairAttempts 生命周期 /
//       cookie 弹窗修复 / timeout 修复（绕过确定性恢复进入 Repair）/ 修复耗尽→PAUSED / Attempt 双保留。
// 注意：集成部分启动浏览器，必须**停止 server 进程**后独立运行。
// 用法：node server/scripts/testAgentPhase23.js

// C140：数据根隔离。必须在**任何 require 之前** —— dataRoot / browserManager / identityStore
// 的数据根在模块加载期解析，晚于首个 require 的隔离行只覆盖一半（EX-08 同族实证）。
// 入集前提 = 已做数据根隔离（EXCLUDED_SUITES.json 登记纪律第 1/4 条）。
process.env.FPB_DATA_DIR = require('path').join(require('os').tmpdir(), 'c140_phase23_' + Date.now());

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
// C140：终态词表的**唯一事实源**（必须是生产同一集合，不得手写字面清单）。旧字面清单同时犯两个错：
//  ① 漏 `HUMAN_ESCALATION` —— Phase 5.8 起它是「修复耗尽/需人工」的**显式终态**（runtime.js:1205-1210
//     的 `taskManager.escalate`）⇒ 任务已终态仍要空转满 120s 观测窗（本套件旧版 305s 的真因之一）；
//  ② 混入 `PAUSED_FOR_HUMAN` —— 而它**不是终态**（taskStateManager.TASK_TERMINAL 不含它，语义是
//     「等待人工、可 resume」）⇒ waitStatus 会在该中间态**提前返回**，随后读到的状态是 TOCTOU 竞态读。
//     本套件实测两次运行给出相反读数（一次 PAUSED_FOR_HUMAN / 一次 HUMAN_ESCALATION）即此。
// 改为派生自事实源后，非终态在结构上不可能再被当作等待目标。
const { TASK_TERMINAL } = require('../agent/taskStateManager');
// C141：等待原语收口到单一实现（不得再复制循环体）。
const taskWait = require('./taskWait');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ensureTestSite = () => testSite.ensure();
// C141：委托单一实现（server/scripts/taskWait.js）。**必须保留其声明外壳**（即仍以
// `async function <该名字>(` 形式定义，只是体内改为一行委托）：c119 A6 以「该名字的出现数 −
// 其函数定义数 === 提取到的等待窗数」做自洽校验，去掉定义会使算式漂移。
// ★ 注释里刻意不写出带左括号的完整函数名 —— 否则会污染任何按字面形状计数的既有守护（C131 同族教训）。
async function waitStatus(taskId, targets, timeoutMs) {
  return taskWait.waitTaskStatus(taskId, targets, timeoutMs);
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
// C140：click 属 schema/action.js MUST_VERIFY ⇒ verification 不能是 none（tools.execute 第 171 行
// validateAction 会恒拒 ACTION_INVALID）。§8 目标页改为 /renamed-nav（按钮同文案 Continue 但
// 点击真实跳转）⇒ page_change 成立；§7 的 ELEMENT_NOT_FOUND 场景不受影响。
const CLICK = (semantic, timeoutMs) => ({ type: 'click', target: { semantic }, risk: 'MEDIUM', verification: { type: 'page_change' }, timeoutMs: timeoutMs || 15000 });

async function runPlan(name, url, steps, extraPolicy) {
  const t = taskManager.createTask({ name, objective: 'x', targetUrl: url, profileId: PROFILE, executionMode: 'AUTONOMOUS', policy: { riskFloor: 'HIGH', ...(extraPolicy || {}) } });
  taskManager.attachPlan(t.id, { goal: name, steps });
  taskManager.start(t.id);
  // C140：等待目标 = 生产**真终态集合**（唯一事实源 TASK_TERMINAL），不是手写字面清单 —— 见文件头
  // 注释：旧清单既漏 HUMAN_ESCALATION（空转满窗，是旧执行器 180s/240s 被 SIGTERM 的真因），
  // 又混入非终态 PAUSED_FOR_HUMAN（提前返回 ⇒ 竞态读，本套件两次运行相反读数）。断言口径零变化。
  const r = await waitStatus(t.id, TASK_TERMINAL, 120000);
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
  // C140 归因：本用例的失败是**验证失败**（点击被遮罩挡住 → 未跳转 → page_change 不成立），
  // 而 repairManager.js:99-101 对 classifier.type === 'VERIFICATION_FAILED' **强制**把诊断类别
  // 改写为 VERIFICATION_FAILED（Phase 7 Step 5 的有意规则：禁止被重分类成 ELEMENT_CHANGED 后
  // 误用 SEMANTIC_RELOCATE）⇒ repairPlanner 必然产出 VERIFY_RETRY，
  // DISMISS_OVERLAY 在该场景**原理上不可达**（旧断言写在「验证失败强制路由」之前）。
  // 遮挡修复能力本身的覆盖由 [repair-planner] 段的 OBSTRUCTION → DISMISS_OVERLAY 断言承担。
  ok(repairs1.length >= 1 && repairs1.some((x) => x.strategy === 'VERIFY_RETRY'),
    '遮挡导致的验证失败 → VERIFY_FAILED 强制路由产出 VERIFY_RETRY RepairAttempt', JSON.stringify(repairs1.map((x) => x.strategy)));
  const attempts1 = store.read('aiAttempts', []).filter((a) => { const st = store.find('aiSteps', a.stepId); return st && st.taskId === c1.t.id; });
  ok(attempts1.length >= 1 && repairs1.length >= 1, '原始 Attempt 与 RepairAttempt 均保留', 'attempts=' + attempts1.length + ' repairs=' + repairs1.length);

  // ---- 6) 集成 Case 2：timeout 进入 Repair 层（慢请求数 > 确定性恢复预算）----
  console.log('[integration-timeout] /flaky4 确定性恢复耗尽 → WAIT_RETRY_RELOAD 修复 → 成功');
  // C140：复位夹具计数器（见 test-site /flaky4-reset 注释）—— 不复位会让本用例在第 2 次运行时
  // 夹具恒快、Repair 层不被触达，断言静默变红。
  await testSite.resetFlaky4();
  const c2 = await runPlan('p23 timeout', 'http://localhost:9555/flaky4', [
    { id: 'nav', type: 'NAVIGATE', description: '打开', expectedOutcome: 'o', risk: 'LOW', action: NAV('http://localhost:9555/flaky4', 1500) },
  ]);
  ok(c2.r.status === 'SUCCESS', 'Timeout Repair 成功', c2.r.error || '');
  const repairs2 = repairAttempts.listForTask(c2.t.id);
  // C140：夹具慢请求数已提到 > 确定性恢复预算（1+默认重试 3 次导航 + reload 上限 1）⇒ 恢复必然
  // 耗尽、Repair 层必然被触达。断言**不放宽**：仍要求真的产出 WAIT_RETRY_RELOAD。
  ok(repairs2.some((x) => x.strategy === 'WAIT_RETRY_RELOAD'), '产生 WAIT_RETRY_RELOAD RepairAttempt', JSON.stringify(repairs2.map((x) => x.strategy)));

  // ---- 7) 集成 Case 4：修复失败 → 显式交人终态 ----
  console.log('[integration-fail] /empty 完全找不到 → 修复耗尽 → HUMAN_ESCALATION');
  // C140：**显式关闭 replan**（maxReplans=0），使本用例只覆盖它自称的那条分支 —— 否则归宿取决于
  // 「replan 能否收敛」（LLM 可用性），断言会随外部条件漂移。探针实测（.benchmark/c140_probe_empty*.log）：
  //   · 放开 replan：RUNNING → PAUSED_FOR_HUMAN(69.2s) → RUNNING(70.5s) → **SUCCESS**(73.8s)
  //     —— replan 被 runtime.js:1171 用来「基于实况重规划剩余步骤」并**成功**，PAUSED_FOR_HUMAN
  //        在这里是**中间态**（窗口 ~1.2s ≥ 600ms 轮询 ⇒ 旧断言会读到它 ⇒ 两次运行相反读数）。
  //   · maxReplans=0：RUNNING → **HUMAN_ESCALATION**(69.5s)，不经过可观测的 PAUSED_FOR_HUMAN
  //     （task.paused 事件与 task.escalated 相隔 9ms），error 带根因。
  // ⇒ 「修复耗尽 → 显式交人终态」这条契约（Phase 5.8 / runtime.js:1205-1210）被**确定地**覆盖。
  const c3 = await runPlan('p23 fail', 'http://localhost:9555/empty', [
    { id: 'nav', type: 'NAVIGATE', description: '打开', expectedOutcome: 'o', risk: 'LOW', action: NAV('http://localhost:9555/empty') },
    { id: 'click', type: 'ACT', description: '点击 xyzzy', expectedOutcome: 'o', risk: 'MEDIUM', action: CLICK('xyzzy', 2500), maxRetries: 2 },
  ], { maxReplans: 0 });
  // C140：Phase 5.8 起「修复耗尽/需人工」是 HUMAN_ESCALATION **显式终态**（taskManager.escalate
  // 第 635 行；原 PAUSED_FOR_HUMAN 非终态会永久悬挂，runtime.js:1206 有明确记载）
  // ⇒ 断言改到当前契约，且同时咬住根因文案（不是只判状态）。**刻意不接受 PAUSED_FOR_HUMAN** ——
  // 它不在 TASK_TERMINAL 内，是被 replan 带回去继续执行的中间态，接受它等于接受竞态读。同族先例：Phase22:126。
  ok(c3.r.status === 'HUMAN_ESCALATION' && /需人工处理/.test(String(c3.r.error || '')),
    '修复耗尽 → HUMAN_ESCALATION 显式终态（带根因，不无限循环）', c3.r.status + ' / ' + (c3.r.error || ''));
  const repairs3 = repairAttempts.listForTask(c3.t.id);
  ok(repairs3.filter((x) => x.status === 'FAILED').length >= 1, '存在 FAILED RepairAttempt', String(repairs3.length));
  ok(repairs3.length <= 3, '修复尝试受 maxRepairAttempts 限制', String(repairs3.length));

  // ---- 8) 集成 Case 1：按钮变化（走确定性恢复层）----
  // C140：目标页由 /renamed 改为 /renamed-nav（同文案 Continue，但点击真实跳转）——
  // 旧页按钮无 onclick，在 click 强制 verification 契约下无法诚实验证。
  console.log('[integration-element] /renamed-nav Proceed→Continue 语义重定位成功');
  const c4 = await runPlan('p23 element', 'http://localhost:9555/renamed-nav', [
    { id: 'nav', type: 'NAVIGATE', description: '打开', expectedOutcome: 'o', risk: 'LOW', action: NAV('http://localhost:9555/renamed-nav') },
    { id: 'click', type: 'ACT', description: '点击 Proceed', expectedOutcome: 'o', risk: 'MEDIUM', action: CLICK('Proceed', 2500) },
  ]);
  ok(c4.r.status === 'SUCCESS', '按钮文字变化自动恢复成功', c4.r.error || '');

  console.log(`\n== 结果: PASS ${pass} / FAIL ${fail} ==`);
  await cleanup([c1.t.id, c2.t.id, c3.t.id, c4.t.id]);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); testSite.cleanup(); process.exit(1); });
