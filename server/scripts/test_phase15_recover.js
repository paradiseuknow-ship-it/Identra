'use strict';

// Phase 15 R10 编排本地验证（无浏览器/LLM，DeepSeek 402 期间的前置保障）：
// 1) checkpoint save/restore roundtrip（结构化恢复包：url/stepId/lastSuccessfulAction）
// 2) 主循环「已终态步骤跳过」语义（runtime.js:546 以 store 权威状态为准）
// 3) 跨进程 checkpoint 可见性（模拟 kill → 新进程 restore —— Gate F: process restart）
// 4) taskManager.recover 状态机约束（终态任务禁止恢复）
// 5) finalizeOrphanAttempts：中断残留 RUNNING attempt 强制收口
//
// 注意：必须在 require agent 模块之前设置 FPB_DATA_DIR（storage/index.js 在 require 时
// 求值 dataDir），因此本文件自启动：直接 node 运行，顶部先设 env 再 require。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const assert = require('assert');

process.env.FPB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-recover-test-'));

const store = require('../agent/store');
const stepManager = require('../agent/stepManager');
const checkpoint = require('../agent/checkpoint');
const taskManager = require('../agent/taskManager');

const pass = [];
const failures = [];
async function t(name, fn) {
  try { await fn(); pass.push(name); console.log('  ok - ' + name); }
  catch (e) { failures.push(name + ': ' + e.message); console.log('  FAIL - ' + name + ' :: ' + e.message); }
}

function makeTask(id) {
  const task = {
    id, name: 'r10_recover_test', objective: 'test', targetUrl: 'http://localhost:9555/form',
    profileId: null, executionMode: 'NORMAL', status: 'RUNNING',
    createdAt: Date.now(), currentExecutionId: null,
  };
  store.insert('aiTasks', task);
  return task;
}

async function main() {
  console.log('\n===== test_phase15_recover =====');
  const TASK_ID = 'task_r10_' + Date.now().toString(36);
  makeTask(TASK_ID);

  // ── 1. checkpoint roundtrip ──
  await t('1. checkpoint save→restore 结构化恢复包字段齐全', () => {
    checkpoint.save(TASK_ID, {
      executionId: 'exe_1', stepId: TASK_ID + '_step_001', attemptId: 'att_x',
      url: 'http://localhost:9555/form?step=1',
      lastVerifiedState: { url: 'http://localhost:9555/form?step=1', formFilled: true },
      lastSuccessfulAction: { type: 'fill', target: { field: 'email' } },
    });
    const r = checkpoint.restore(TASK_ID);
    assert.ok(r, 'restore 应返回恢复包');
    assert.strictEqual(r.url, 'http://localhost:9555/form?step=1');
    assert.strictEqual(r.stepId, TASK_ID + '_step_001');
    assert.strictEqual(r.lastSuccessfulAction.type, 'fill');
    assert.strictEqual(r.lastVerifiedState.formFilled, true);
  });

  await t('2. 多 checkpoint 时 restore 取最新（时间戳最大）', () => {
    checkpoint.save(TASK_ID, { url: 'http://localhost:9555/form?step=2', stepId: TASK_ID + '_step_002' });
    const r = checkpoint.restore(TASK_ID);
    assert.strictEqual(r.url, 'http://localhost:9555/form?step=2');
    assert.strictEqual(r.stepId, TASK_ID + '_step_002');
  });

  // ── 2. 步骤状态 + 主循环跳过语义 ──
  await t('3. 已 SUCCESS 步骤在恢复执行集之外（主循环 546 语义等价判定）', () => {
    // step_001 → PENDING→RUNNING→SUCCESS（真实落库）；step_002 保持 PENDING
    const s1 = stepManager.createStep(TASK_ID, { id: 'step_001', description: 'fill email', type: 'ACT', action: { type: 'fill', target: { field: 'email' }, value: 'a@b.c', verification: { type: 'none' } } }, 0);
    stepManager.createStep(TASK_ID, { id: 'step_002', description: 'submit', type: 'ACT', action: { type: 'submit', target: { semantic: 'submit button' }, verification: { type: 'none' } } }, 1);
    stepManager.setStepState(s1.id, 'RUNNING');
    const att = stepManager.createAttempt(s1.id, 'exe_1', s1.action);
    stepManager.succeedAttempt(att.id);
    stepManager.setStepState(s1.id, 'SUCCESS');

    // 主循环等价判定：以 store 权威状态为准（runtime.js:546）
    const steps = stepManager.listSteps(TASK_ID);
    const resumeSet = steps.filter((s) => {
      const live = (stepManager.getStep(s.id) || {}).status;
      return live !== 'SUCCESS' && live !== 'SKIPPED';
    });
    assert.strictEqual(resumeSet.length, 1, '恢复执行集应只含 step_002');
    assert.strictEqual(resumeSet[0].id, steps.find((s) => s.description === 'submit').id);
  });

  // ── 3. 跨进程 checkpoint 可见性（模拟 kill → restart）──
  await t('4. 进程重启后 checkpoint 仍可 restore（Gate F: process restart）', () => {
    const childScript = `
      const checkpoint = require('../agent/checkpoint');
      const r = checkpoint.restore(${JSON.stringify(TASK_ID)});
      process.stdout.write(JSON.stringify({ ok: !!r, url: r && r.url, stepId: r && r.stepId }));
    `;
    const out = spawnSync(process.execPath, ['-e', childScript], {
      encoding: 'utf8', timeout: 30000,
      cwd: path.join(__dirname), // server/scripts → 相对 require('../agent/...')
      env: Object.assign({}, process.env, { FPB_DATA_DIR: process.env.FPB_DATA_DIR }),
    });
    assert.strictEqual(out.status, 0, '子进程应正常退出: ' + out.stderr.slice(0, 200));
    const r = JSON.parse(out.stdout);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.url, 'http://localhost:9555/form?step=2');
    assert.strictEqual(r.stepId, TASK_ID + '_step_002');
  });

  // ── 4. recover 状态机约束 ──
  await t('5. 终态任务禁止 recover（状态机守卫）', () => {
    const doneId = TASK_ID + '_done';
    makeTask(doneId);
    store.upsert('aiTasks', { id: doneId, status: 'SUCCESS' });
    assert.throws(() => taskManager.recover(doneId), /不允许恢复/);
  });

  // ── 5. 中断残留 RUNNING attempt 收口 ──
  await t('6. finalizeOrphanAttempts 把中断残留 RUNNING 收口（ORPHAN_ATTEMPT）', () => {
    const orphanId = TASK_ID + '_orph';
    makeTask(orphanId);
    const s = stepManager.createStep(orphanId, { description: 'submit interrupted', type: 'ACT', action: { type: 'submit', verification: { type: 'none' } } }, 0);
    stepManager.setStepState(s.id, 'RUNNING');
    const att = stepManager.createAttempt(s.id, 'exe_orph', s.action);
    assert.strictEqual(att.status, 'RUNNING');
    const n = stepManager.finalizeOrphanAttempts(orphanId);
    assert.strictEqual(n, 1);
    const after = stepManager.getAttempt(att.id);
    assert.strictEqual(after.status, 'FAILED');
    assert.strictEqual(after.error && after.error.code, 'SUBMIT_RESULT_UNKNOWN'); // submit 类精确分类
    assert.ok(after.endedAt > 0);
  });

  console.log('\n===== test_phase15_recover =====');
  console.log('PASS=' + pass.length + ' FAIL=' + failures.length);
  if (failures.length) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
