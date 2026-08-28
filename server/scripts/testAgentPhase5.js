'use strict';

// Phase 1.5 + Phase 2.1 验收：存储抽象 / 错误分类 / 确定性恢复 / replay / 任务恢复 / plan 版本化 / 凭据使用记录。
// 注意：本测试启动浏览器 Runtime，必须**停止 server 进程**后独立运行。
// 用法：node server/scripts/testAgentPhase5.js

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
async function waitStatus(taskId, targets, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const t = taskManager.getTask(taskId);
    if (t && targets.includes(t.status)) return t;
    await sleep(600);
  }
  return taskManager.getTask(taskId);
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
const CLICK_ACT = (semantic) => ({ type: 'click', target: { semantic }, risk: 'MEDIUM', verification: { type: 'none' } });

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
  console.log('[recovery-element] /renamed: 语义 Proceed 不存在 → 恢复探测 Continue → SUCCESS');
  await ensureTestSite();
  const ref = await makeProfile(false);
  const t1 = taskManager.createTask({ name: 'p5 element', objective: 'x', targetUrl: 'http://localhost:9555/renamed', profileId: PROFILE, executionMode: 'AUTONOMOUS', policy: { riskFloor: 'HIGH' } });
  taskManager.attachPlan(t1.id, {
    goal: 'element', steps: [
      { id: 'nav', type: 'NAVIGATE', description: '打开', expectedOutcome: 'o', risk: 'LOW', action: NAV_ACT('http://localhost:9555/renamed') },
      { id: 'click', type: 'ACT', description: '点击继续', expectedOutcome: 'o', risk: 'MEDIUM', action: CLICK_ACT('Proceed') },
    ],
  });
  taskManager.start(t1.id);
  const r1 = await waitStatus(t1.id, ['SUCCESS', 'FAILED'], 90000);
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
  const r2 = await waitStatus(t2.id, ['SUCCESS', 'FAILED'], 90000);
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
  const r3 = await waitStatus(t3.id, ['SUCCESS', 'FAILED'], 90000);
  ok(r3.status === 'SUCCESS', '恢复后继续执行到 SUCCESS', r3.error || '');
  const rp = replay.buildTaskReplay(taskManager.getTask(t3.id));
  ok(rp.chain.length >= 2, '恢复后可 replay 动作链', String(rp.chain.length));

  console.log(`\n== 结果: PASS ${pass} / FAIL ${fail} ==`);
  await cleanup([t1.id, t2.id, t3.id, t0.id]);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); testSite.cleanup(); process.exit(1); });
