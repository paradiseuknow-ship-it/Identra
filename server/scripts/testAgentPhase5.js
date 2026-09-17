'use strict';

// Phase 1.5 + Phase 2.1 验收：存储抽象 / 错误分类 / 确定性恢复 / replay / 任务恢复 / plan 版本化 / 凭据使用记录。
// 注意：本测试启动浏览器 Runtime，必须**停止 server 进程**后独立运行。
// 用法：node server/scripts/testAgentPhase5.js

// C140：数据根隔离。必须在**任何 require 之前** —— dataRoot / browserManager / identityStore
// 的数据根在模块加载期解析，晚于首个 require 的隔离行只覆盖一半（EX-08 同族实证）。
// 入集前提 = 已做数据根隔离（EXCLUDED_SUITES.json 登记纪律第 1/4 条）。
process.env.FPB_DATA_DIR = require('path').join(require('os').tmpdir(), 'c140_phase5_' + Date.now());

const db = require('../db');
const vault = require('../vault');
const taskManager = require('../agent/taskManager');
const stepManager = require('../agent/stepManager');
const secretManager = require('../agent/secretManager');
const checkpoint = require('../agent/checkpoint');
const browserManager = require('../browserManager');
const store = require('../agent/store');
require('../agent/runtime'); // 注册 executor + recovery 集成
const testSite = require('./_testSite'); // 带版本探针的 test-site 助手

const errorClassifier = require('../agent/recovery/errorClassifier');
const recoveryManager = require('../agent/recovery/recoveryManager');
const replay = require('../agent/recovery/replay');
const recorder = require('../agent/recorder');
const sites = require('../agent/sites');
const { JsonStore } = require('../agent/storage/jsonStore');
const { StoreInterface } = require('../agent/storage/store.interface');
// C140：等待「终态」必须用生产的**真终态集合**（唯一事实源），不得手写字面清单 —— 旧清单既可能漏
// `HUMAN_ESCALATION`（Phase 5.8 起的显式交人终态 ⇒ 任务已终态仍空转满观测窗），也可能混入非终态
// `PAUSED_FOR_HUMAN`（taskStateManager.TASK_TERMINAL 不含它 ⇒ waitStatus 提前返回 ⇒ TOCTOU 竞态读）。
const { TASK_TERMINAL } = require('../agent/taskStateManager');
// C141：等待原语收口到单一实现（不得再复制循环体）。
const taskWait = require('./taskWait');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
  });
}

let testSiteProc = null;
const ensureTestSite = () => testSite.ensure();
// C140：targets 必须覆盖**当前**终态词表 —— Phase 5.8 起「修复耗尽/需人工」是 HUMAN_ESCALATION
// 显式终态（runtime.js:1206 + taskManager.escalate.js:635；原 PAUSED_FOR_HUMAN 非终态会永久悬挂）。
// 旧词表漏掉它 ⇒ 任务早已终态仍空转满 90s 观测窗（§5/§6/§7 共 270s），
// 这正是 C135 实测「执行器 180s SIGTERM」的真因，而非套件跑不完。
// C141：委托单一实现（server/scripts/taskWait.js）。**必须保留其声明外壳**（即仍以
// `async function <该名字>(` 形式定义，只是体内改为一行委托）：c119 A6 以「该名字的出现数 −
// 其函数定义数 === 提取到的等待窗数」做自洽校验，去掉定义会使该算式漂移。
// ★ 注释里刻意不写出带左括号的完整函数名 —— 否则会污染任何按字面形状计数的既有守护（C131 同族教训）。
async function waitStatus(taskId, targets, timeoutMs) {
  return taskWait.waitTaskStatus(taskId, targets, timeoutMs);
}

const PROFILE = 'p_phase5_' + Date.now().toString(36);
async function makeProfile(withSecret) {
  db.upsertProfile({
    id: PROFILE, name: 'p5', group: 'default', tags: [], notes: '', seed: 'p5',
    headless: true, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { cacheClearMode: 'none' }, fingerprintOverride: {}, fingerprint: null, lastSessionUrls: [], createdAt: Date.now(),
  });
  let ref = null;
  if (withSecret) {
    vault.setProfileSecrets(PROFILE, { email: 'p5@test.local', password: 'P5#Secret' });
    ref = secretManager.createSecret({ profileId: PROFILE, type: 'email_password', site: 'test.local', label: 'p5' }).id;
  }
  return ref;
}

async function cleanup(ids) {
  try { browserManager.close(PROFILE).catch(() => {}); } catch (e) {}
  for (const id of ids) { try { taskManager.cancel(id); } catch (e) {} store.remove('aiTasks', id); }
  store.write('aiSteps', store.read('aiSteps', []).filter((x) => !ids.includes(x.taskId)));
  store.write('aiAttempts', store.read('aiAttempts', []).filter((a) => { const st = store.find('aiSteps', a.stepId); return st && !ids.includes(st.taskId); }));
  store.write('aiQueue', store.read('aiQueue', []).filter((x) => !ids.includes(x.taskId)));
  store.write('aiCredentials', store.read('aiCredentials', []).filter((x) => x.profileId !== PROFILE));
  store.write('aiCredentialUsage', store.read('aiCredentialUsage', []).filter((x) => !ids.includes(x.taskId)));
  vault.deleteProfileSecrets(PROFILE);
  db.deleteProfile(PROFILE);
  if (testSiteProc) { testSite.cleanup(); testSiteProc = null; }
}

const NAV_ACT = (url, timeoutMs) => ({ type: 'navigate', target: { url }, risk: 'LOW', verification: { type: 'page_change' }, timeoutMs: timeoutMs || 15000 });
// C140：click 属 schema/action.js MUST_VERIFY ⇒ verification 不能是 none（否则 tools.execute
// 第 171 行 validateAction 恒拒 ACTION_INVALID，与解析/恢复链无关）。目标页面改为 /renamed-nav
// （按钮同文案 Continue，但点击真实跳转）⇒ page_change 是可验证的真实效果。
const CLICK_ACT = (semantic) => ({ type: 'click', target: { semantic }, risk: 'MEDIUM', verification: { type: 'page_change' } });

async function main() {
  console.log('== Phase 1.5 + Phase 2.1 验收 ==');

  // ---- 1) 存储抽象 ----
  console.log('[storage]');
  ok(store instanceof JsonStore, 'store 委托 JsonStore');
  ok(JsonStore.prototype instanceof StoreInterface, 'JsonStore 实现 StoreInterface');
  store.write('aiQueue', []); // 冒烟：读写正常
  ok(Array.isArray(store.read('aiQueue', [])), 'JsonStore 读写正常');

  // ---- 2) 错误分类（v2：返回 {type, confidence, evidence}）----
  console.log('[classifier]');
  const C = (err) => errorClassifier.classify(err).type;
  ok(C({ code: 'ELEMENT_NOT_FOUND' }) === 'ELEMENT_NOT_FOUND', 'ELEMENT_NOT_FOUND 分类');
  ok(C({ code: 'VERIFY_FAILED' }) === 'VERIFICATION_FAILED', 'VERIFICATION_FAILED 分类');
  ok(C({ code: 'TOOL_EXECUTION', message: 'Timeout 30000ms exceeded' }) === 'TIMEOUT', 'timeout 分类');
  ok(C({ code: 'TOOL_EXECUTION', message: 'net::ERR_CONNECTION_RESET' }) === 'NETWORK_ERROR', 'network 分类');
  ok(C({ code: 'TOOL_EXECUTION', message: 'Failed to navigate' }) === 'NAVIGATION_FAILED', 'navigation 分类');
  ok(C({ code: 'ACTION_REQUIRES_APPROVAL' }) === 'APPROVAL_REQUIRED', 'approval 分类');
  ok(C({ code: 'X', message: 'some random' }) === 'UNKNOWN', 'unknown 分类');
  const cDetail = errorClassifier.classify({ code: 'ELEMENT_NOT_FOUND' });
  ok(typeof cDetail.confidence === 'number' && Array.isArray(cDetail.evidence), '分类器带 confidence + evidence');

  // ---- 3) replay ----
  console.log('[replay]');
  const exe = recorder.createExecution('task_demo', PROFILE, {});
  recorder.recordAction(exe.id, { stepId: 's1', tool: 'navigate', action: { type: 'navigate', target: { url: 'http://x' } }, status: 'SUCCESS' });
  recorder.recordAction(exe.id, { stepId: 's2', tool: 'click', action: { type: 'click', target: { semantic: 'x' } }, status: 'FAILED', error: 'boom' });
  const rep = replay.buildChain(exe.id);
  ok(rep.chain.length === 2 && rep.text.includes('navigate → SUCCESS'), 'replay 输出动作链', rep.text);

  // ---- 4) plan 版本化 ----
  console.log('[plan-version]');
  const t0 = taskManager.createTask({ name: 'pv', objective: 'x', targetUrl: 'http://localhost:9555/form', profileId: PROFILE, executionMode: 'AUTONOMOUS', policy: { riskFloor: 'HIGH' } });
  taskManager.attachPlan(t0.id, { goal: 'v1', steps: [{ id: 'a', type: 'NAVIGATE', description: 'a', expectedOutcome: 'o', risk: 'LOW', action: NAV_ACT('http://localhost:9555/form') }] });
  const v1 = taskManager.getTask(t0.id);
  ok(v1.planVersion === 'plan_v1', '首次挂载 = plan_v1', v1.planVersion);
  taskManager.attachPlan(t0.id, { goal: 'v2', steps: [{ id: 'b', type: 'NAVIGATE', description: 'b', expectedOutcome: 'o', risk: 'LOW', action: NAV_ACT('http://localhost:9555/form') }] });
  const v2 = taskManager.getTask(t0.id);
  ok(v2.planVersion === 'plan_v2' && v2.planHistory.length === 1, '修订后 = plan_v2 + 旧计划入 history', v2.planVersion + ' hist=' + v2.planHistory.length);

  // ---- 5) 确定性恢复：按钮文字变化（Proceed → 实际是 Continue）----
  // C140：页面由 /renamed 改为 /renamed-nav —— 旧页按钮无 onclick、点击无任何页面变化，
  // 在 click 强制 verification 契约（schema/action.js MUST_VERIFY）下**无法诚实验证**：
  // 写 verification:none 会被判 ACTION_INVALID，写任何 DOM 断言都是恒真假绿。新页同文案但真实跳转。
  console.log('[recovery-element] /renamed-nav: 语义 Proceed 不存在 → 恢复探测 Continue → page_change 成立 → SUCCESS');
  await ensureTestSite();
  const ref = await makeProfile(false);
  const t1 = taskManager.createTask({ name: 'p5 element', objective: 'x', targetUrl: 'http://localhost:9555/renamed-nav', profileId: PROFILE, executionMode: 'AUTONOMOUS', policy: { riskFloor: 'HIGH' } });
  taskManager.attachPlan(t1.id, {
    goal: 'element', steps: [
      { id: 'nav', type: 'NAVIGATE', description: '打开', expectedOutcome: 'o', risk: 'LOW', action: NAV_ACT('http://localhost:9555/renamed-nav') },
      { id: 'click', type: 'ACT', description: '点击继续', expectedOutcome: 'o', risk: 'MEDIUM', action: CLICK_ACT('Proceed') },
    ],
  });
  taskManager.start(t1.id);
  const r1 = await waitStatus(t1.id, TASK_TERMINAL, 90000);
  ok(r1.status === 'SUCCESS', '恢复重定位成功（Proceed→Continue）', r1.error || '');
  const att1 = store.read('aiAttempts', []).filter((a) => { const st = store.find('aiSteps', a.stepId); return st && st.taskId === t1.id; });
  ok(att1.length >= 2, '多次 Attempt（含恢复）', 'attempts=' + att1.length);

  // ---- 6) 确定性恢复：慢页面 timeout ----
  console.log('[recovery-timeout] /flaky 首访超时 → wait 后重试 → SUCCESS');
  const t2 = taskManager.createTask({ name: 'p5 timeout', objective: 'x', targetUrl: 'http://localhost:9555/flaky', profileId: PROFILE, executionMode: 'AUTONOMOUS', policy: { riskFloor: 'HIGH' } });
  taskManager.attachPlan(t2.id, {
    goal: 'timeout', steps: [
      { id: 'nav', type: 'NAVIGATE', description: '打开', expectedOutcome: 'o', risk: 'LOW', action: NAV_ACT('http://localhost:9555/flaky', 1500) },
    ],
  });
  taskManager.start(t2.id);
  const r2 = await waitStatus(t2.id, TASK_TERMINAL, 90000);
  ok(r2.status === 'SUCCESS', 'timeout 恢复成功（重试后命中快速响应）', r2.error || '');

  // ---- 7) 任务恢复：模拟 Node 重启（RUNNING 任务 → recover → 继续到 SUCCESS）----
  console.log('[task-recovery] 模拟重启恢复');
  const ref2 = await makeProfile(true);
  const t3 = taskManager.createTask({ name: 'p5 recovery', objective: '注册', targetUrl: 'http://localhost:9555/form', profileId: PROFILE, executionMode: 'AUTONOMOUS', policy: { riskFloor: 'HIGH' }, secretRefs: [ref2] });
  taskManager.attachPlan(t3.id, { goal: 'recovery', steps: [
    { id: 'nav', type: 'NAVIGATE', description: '打开', expectedOutcome: 'o', risk: 'LOW', action: NAV_ACT('http://localhost:9555/form') },
    { id: 'obs', type: 'OBSERVE', description: '观察', expectedOutcome: 'o', risk: 'LOW', action: { type: 'inspect', target: { role: 'page' }, risk: 'LOW', verification: { type: 'none' } } },
  ] });
  // 模拟崩溃：任务处于 RUNNING、无执行（相当于进程重启前的内存态丢失）
  const raw = taskManager.getTask(t3.id);
  raw.status = 'RUNNING';
  store.upsert('aiTasks', raw);
  checkpoint.save(t3.id, { profileId: PROFILE, url: 'http://localhost:9555/form', lastVerifiedState: { stepId: 'nav' } });
  const recovered = recoveryManager.recoverInterruptedTasks();
  ok(recovered.includes(t3.id), '启动扫描识别并恢复 RUNNING 任务', recovered.join(','));
  const r3 = await waitStatus(t3.id, TASK_TERMINAL, 90000);
  ok(r3.status === 'SUCCESS', '恢复后继续执行到 SUCCESS', r3.error || '');
  const rp = replay.buildTaskReplay(taskManager.getTask(t3.id));
  ok(rp.chain.length >= 2, '恢复后可 replay 动作链', String(rp.chain.length));

  console.log(`\n== 结果: PASS ${pass} / FAIL ${fail} ==`);
  await cleanup([t1.id, t2.id, t3.id, t0.id]);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); testSite.cleanup(); process.exit(1); });
