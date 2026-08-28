'use strict';

// Phase 1.2 验收测试（Agent Runtime 最小闭环）。
// 用法：node server/scripts/testAgentPhase2.js
// 依赖：本机系统 Chrome；自动启动/复用 localhost:9555 test-site。
// 覆盖：
//   Case 1: 打开 /form → Task SUCCESS（验证链路全通）
//   Case 2: /renamed（无表单）→ 元素不存在 → 重试后 Task FAILED（产生 Attempt）
//   Case 3: 点击成功 + Verification PASS（Case 1 内隐含）
//   Case 4: Checkpoint 已保存（供崩溃恢复）
//   Case 5: SIMULATION 模式 → 只观察不执行 → SUCCESS
//   Case 6: ASSIST 模式 + riskFloor MEDIUM → 提交(HIGH) → PAUSED_FOR_HUMAN

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const db = require('../db');
const vault = require('../vault');
const taskManager = require('../agent/taskManager');
const secretManager = require('../agent/secretManager');
const checkpoint = require('../agent/checkpoint');
const browserManager = require('../browserManager');
const store = require('../agent/store');
// 必须加载 runtime：注册 executor 钩子，否则 start() 的 kick 空转、任务永远停在 RUNNING
require('../agent/runtime');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect(port, host, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
  });
}

let testSiteProc = null;
async function ensureTestSite() {
  if (await portOpen(9555)) { console.log('  [test-site] 已在运行'); return; }
  console.log('  [test-site] 启动 server/test-site/server.js ...');
  testSiteProc = spawn(process.execPath, [path.join(__dirname, '..', 'test-site', 'server.js')], { stdio: 'ignore' });
  for (let i = 0; i < 20; i++) { if (await portOpen(9555)) return; await sleep(300); }
  throw new Error('test-site 启动失败');
}

async function waitForStatus(taskId, targets, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const t = taskManager.getTask(taskId);
    if (t && targets.includes(t.status)) return t;
    await sleep(500);
  }
  return taskManager.getTask(taskId);
}

const TEST_PROFILE = 'p_phase2_' + Date.now().toString(36);

async function makeProfile() {
  const profile = {
    id: TEST_PROFILE,
    name: 'Phase2 测试',
    group: 'default',
    tags: [], notes: '',
    seed: 'phase2-seed',
    headless: true,
    proxyMode: 'none',
    proxyId: null,
    proxyInline: null,
    os: 'Windows', browser: 'Chrome',
    startupUrls: [], launchArgs: [],
    launchBehavior: { restoreLastSession: false, blockVideo: false, blockImages: false, blockImagesThresholdKB: 10, clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false },
    fingerprintOverride: {},
    fingerprint: null,
    lastSessionUrls: [],
    createdAt: Date.now(),
  };
  db.upsertProfile(profile);
  vault.setProfileSecrets(TEST_PROFILE, { email: 'phase2@test.local', password: 'Phase2#Secret' });
  const ref = secretManager.createSecret({ profileId: TEST_PROFILE, type: 'email_password', site: 'test.local', label: 'phase2' });
  return ref.id;
}

async function cleanup() {
  try {
    browserManager.close(TEST_PROFILE).catch(() => {});
  } catch (e) {}
  const phase2Ids = [];
  for (const t of taskManager.listTasks().filter((x) => x.name && x.name.startsWith('Phase2'))) {
    phase2Ids.push(t.id);
    try { taskManager.cancel(t.id); } catch (e) {}
    store.remove('aiTasks', t.id);
  }
  store.write('aiCredentials', store.read('aiCredentials', []).filter((x) => x.profileId !== TEST_PROFILE));
  store.write('aiCheckpoints', store.read('aiCheckpoints', []).filter((x) => x.profileId !== TEST_PROFILE));
  store.write('aiQueue', store.read('aiQueue', []).filter((x) => x.profileId !== TEST_PROFILE && !phase2Ids.includes(x.taskId)));
  store.write('aiSteps', store.read('aiSteps', []).filter((x) => !phase2Ids.includes(x.taskId)));
  store.write('aiAttempts', store.read('aiAttempts', []).filter((a) => {
    const st = store.find('aiSteps', a.stepId);
    return st && !phase2Ids.includes(st.taskId);
  }));
  vault.deleteProfileSecrets(TEST_PROFILE);
  db.deleteProfile(TEST_PROFILE);
  if (testSiteProc) { try { testSiteProc.kill(); } catch (e) {} }
}

async function main() {
  console.log('== Phase 1.2 Agent Runtime 验收 ==');
  await ensureTestSite();
  const secretRef = await makeProfile();

  // ---- Case 1: 完整链路 SUCCESS ----
  console.log('[Case 1] AUTONOMOUS + riskFloor=HIGH → /form → SUCCESS');
  const t1 = taskManager.createTask({
    name: 'Phase2 happy', objective: '注册并验证', targetUrl: 'http://localhost:9555/form',
    profileId: TEST_PROFILE, executionMode: 'AUTONOMOUS',
    policy: { riskFloor: 'HIGH' }, secretRefs: [secretRef],
  });
  taskManager.start(t1.id);
  const r1 = await waitForStatus(t1.id, ['SUCCESS', 'FAILED'], 90000);
  ok(r1.status === 'SUCCESS', 'Case 1 Task SUCCESS', `status=${r1.status} error=${r1.error || ''}`);
  const exec1 = r1.currentExecutionId ? require('../agent/recorder').get(r1.currentExecutionId) : null;
  const stepOk1 = (exec1 && exec1.actions.some((a) => (a.tool === 'click' || a.tool === 'submit') && a.status === 'SUCCESS')) || false;
  ok(stepOk1, 'Case 3 点击成功并 Verification PASS');
  const cp1 = checkpoint.latest(t1.id);
  ok(!!cp1 && cp1.taskId === t1.id && !!cp1.stepId, 'Case 4 Checkpoint 已保存');

  // ---- Case 2: 元素不存在 → 重试 → 修复耗尽 → FAILED/PAUSED（Phase 2.3 后修复耗尽转人工）----
  console.log('[Case 2] /renamed 无表单 → ELEMENT_NOT_FOUND → 不成功（FAILED 或转人工）');
  const t2 = taskManager.createTask({
    name: 'Phase2 fail', objective: '无表单页面', targetUrl: 'http://localhost:9555/renamed',
    profileId: TEST_PROFILE, executionMode: 'AUTONOMOUS',
    policy: { riskFloor: 'HIGH' }, secretRefs: [secretRef],
  });
  taskManager.start(t2.id);
  const r2 = await waitForStatus(t2.id, ['SUCCESS', 'FAILED', 'PAUSED_FOR_HUMAN'], 90000);
  ok(r2.status !== 'SUCCESS' && r2.status !== 'PENDING' && r2.status !== 'PLANNING', 'Case 2 元素不存在 → 未成功（FAILED/PAUSED）', r2.status + ' | ' + (r2.error || ''));
  const attempts2 = store.read('aiAttempts', []).filter((a) => {
    const st = store.find('aiSteps', a.stepId);
    return st && st.taskId === t2.id;
  });
  ok(attempts2.length >= 2, 'Case 2 产生多个 Attempt（含重试）', 'attempts=' + attempts2.length);

  // ---- Case 5: SIMULATION ----
  console.log('[Case 5] SIMULATION → 只观察不执行 → SUCCESS');
  const t5 = taskManager.createTask({
    name: 'Phase2 sim', objective: '模拟', targetUrl: 'http://localhost:9555/form',
    profileId: TEST_PROFILE, executionMode: 'SIMULATION',
    policy: { riskFloor: 'HIGH' }, secretRefs: [secretRef],
  });
  taskManager.start(t5.id);
  const r5 = await waitForStatus(t5.id, ['SUCCESS', 'FAILED'], 60000);
  ok(r5.status === 'SUCCESS', 'Case 5 SIMULATION SUCCESS（未执行真实动作）', r5.error || '');
  const exec5 = r5.currentExecutionId ? require('../agent/recorder').get(r5.currentExecutionId) : null;
  const acted5 = (exec5 && exec5.actions.some((a) => a.tool === 'click' || a.tool === 'fill')) || false;
  ok(!acted5, 'Case 5 无 click/fill 真实执行');

  // ---- Case 6: ASSIST + riskFloor=MEDIUM → HIGH 提交 → PAUSED ----
  console.log('[Case 6] ASSIST + riskFloor=MEDIUM → submit(HIGH) → PAUSED_FOR_HUMAN');
  const t6 = taskManager.createTask({
    name: 'Phase2 assist', objective: '测试审批边界', targetUrl: 'http://localhost:9555/form',
    profileId: TEST_PROFILE, executionMode: 'ASSIST',
    policy: { riskFloor: 'MEDIUM' }, secretRefs: [secretRef],
  });
  taskManager.start(t6.id);
  const r6 = await waitForStatus(t6.id, ['PAUSED_FOR_HUMAN', 'SUCCESS', 'FAILED'], 60000);
  ok(r6.status === 'PAUSED_FOR_HUMAN', 'Case 6 HIGH 动作 → PAUSED_FOR_HUMAN', r6.error || '');
  taskManager.cancel(t6.id);

  console.log(`\n== 结果: PASS ${pass} / FAIL ${fail} ==`);
  await cleanup();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常:', e); cleanup(); process.exit(1); });
