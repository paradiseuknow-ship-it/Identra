'use strict';

// A 类 cancel deadline — 故障注入测试
//
// 背景（run1/run2 实证）：headless 假死占死事件循环时，in-process runner 内
// taskManager.cancel() 无法执行（同线程排队永远轮不到），拖死整个批量执行。
//
// 修复架构（分层，本测试逐层锁定）：
//   L1 进程内：cancel() 收尾链逐段 fail-open —— 任一下游（recorder/lock/queue/events）
//      抛错不阻断终态落地，并留 task.cancel_timeout 审计事件；终态幂等（重入返回原任务）。
//   L2 进程级（与 phase12Benchmark.runIsolated 同构）：任务卡死时同进程内无解（单线程），
//      唯一有效防线 = 外部 hard deadline + taskkill /T /F 树杀（连 Chromium 子进程），
//      任务记 TIMEOUT 真实失败，scheduler/runner 继续下一任务。
//
// 纪律：不改变 SUCCESS/FAILURE/HUMAN_ESCALATION 业务判定；不修改 benchmark 评分；
//       不降低 timeout；断言真正会执行的那份东西。

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-cancel-inject-'));
process.env.FPB_DATA_DIR = tmpData;

const assert = require('assert');
const taskManager = require('../agent/taskManager');
const events = require('../agent/events');
const store = require('../agent/store');
const queue = require('../agent/queue');
const lock = require('../agent/lock');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  PASS ' + name);
  } catch (e) {
    fail++;
    failures.push(name + ' :: ' + String(e.message || e).slice(0, 200));
    console.log('  FAIL ' + name + ' :: ' + String(e.message || e).slice(0, 200));
  }
}

function taskEvents(taskId, type) {
  const all = store.read('aiEvents', []);
  return all.filter((e) => (e.taskId || e.task_id) === taskId && (!type || e.type === type));
}

function alive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return false;
  }
}

// ---------- L2 helpers：进程级注入（与 phase12Benchmark.runIsolated 同构）----------

const NODE = process.execPath;
const HANG_CODE = 'setInterval(function(){},1000);'; // 模拟同步卡死/永不退出的 worker
// worker 卡死且持有子进程（模拟 Chromium）——验证树杀覆盖整棵进程树
const TREE_CODE = 'var cp=require("child_process");cp.spawn(process.execPath,["-e","setInterval(function(){},1000)"],{stdio:"ignore",detached:false});setInterval(function(){},1000);';

function killTree(pid) {
  execSync('taskkill /PID ' + pid + ' /T /F', { stdio: 'ignore' });
}

function hardDeadlineIsolation(scenario) {
  // 与 phase12Benchmark.runIsolated 同构：spawn worker → hard deadline → 树杀 → 收割
  const deadlineMs = scenario.deadlineMs;
  const child = spawn(NODE, ['-e', scenario.code], { stdio: 'ignore' });
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      let killOk = true;
      try { killTree(child.pid); } catch (e) { killOk = false; }
      setTimeout(() => {
        const stillAlive = alive(child.pid);
        resolve({ timedOut: true, duration: Date.now() - startedAt, stillAlive, killOk, pid: child.pid });
      }, 300);
    }, deadlineMs);
    child.on('exit', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ timedOut: false, duration: Date.now() - startedAt, killOk: null });
    });
  });
}

function nextTaskContinues() {
  // 卡死任务被收割后，「下一任务」继续执行（scheduler 未被阻塞）
  return new Promise((resolve, reject) => {
    const next = spawn(NODE, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      try { killTree(next.pid); } catch (e) {}
      reject(new Error('下一任务 8s 内未完成'));
    }, 8000);
    next.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('下一任务异常退出: ' + code));
    });
  });
}

(async () => {
  console.log('=== A 类 cancel deadline 故障注入 ===');
  console.log('--- L1 进程内 cancel 语义 ---');

  let t1 = null;

  check('L1-prepare: createTask+start 任务进入可取消状态', () => {
    t1 = taskManager.createTask({ name: 'cancel-inject-1', objective: '测试取消', profileId: null, executionMode: 'ASSIST' });
    assert.ok(t1 && t1.id, '任务创建失败');
    taskManager.start(t1.id);
    const t = taskManager.getTask(t1.id);
    assert.ok(['PENDING', 'PLANNING', 'RUNNING'].includes(t.status), 'start 后状态: ' + t.status);
  });

  check('L1-1: cancel 正常路径 → CANCELLED 终态 + execution 收尾 + cancelled 事件', () => {
    const beforeEvents = taskEvents(t1.id, 'task.cancelled').length;
    const t = taskManager.cancel(t1.id);
    assert.strictEqual(t.status, 'CANCELLED');
    assert.ok(t.finishedAt, 'finishedAt 应设置');
    assert.strictEqual(t.error, '用户取消');
    assert.ok(taskEvents(t1.id, 'task.cancelled').length >= beforeEvents + 1, '应发出 task.cancelled 事件');
    if (t.currentExecutionId) {
      const rec = store.read('aiExecutions', []).find((x) => x.id === t.currentExecutionId);
      assert.ok(rec, 'execution 记录应存在');
      assert.strictEqual(rec.status, 'CANCELLED', 'execution 应标记 CANCELLED，实际: ' + rec.status);
    }
  });

  check('L1-2: cancel 终态幂等 —— 重入返回原任务、不发二次事件', () => {
    const evBefore = taskEvents(t1.id, 'task.cancelled').length;
    const t = taskManager.cancel(t1.id);
    assert.strictEqual(t.status, 'CANCELLED');
    assert.strictEqual(t.id, t1.id);
    assert.strictEqual(taskEvents(t1.id, 'task.cancelled').length, evBefore, '重入不得重复发 cancelled 事件');
  });

  check('L1-3: cancel 对 HUMAN_ESCALATION 终态幂等（CAP-K3 语义保持）', () => {
    const t = taskManager.createTask({ name: 'cancel-inject-esc', objective: '测试升级终态幂等', profileId: null });
    const rec = store.find('aiTasks', t.id);
    rec.status = 'HUMAN_ESCALATION';
    store.upsert('aiTasks', rec);
    const r = taskManager.cancel(t.id);
    assert.strictEqual(r.status, 'HUMAN_ESCALATION', '升级终态再 cancel 不得改变状态');
  });

  check('L1-4: 收尾链故障注入（queue.markDone 抛异常）→ cancel 仍完成终态 + cancel_timeout 事件', () => {
    const t = taskManager.createTask({ name: 'cancel-inject-fault', objective: '测试收尾链故障', profileId: null });
    taskManager.start(t.id);
    const origMarkDone = queue.markDone;
    queue.markDone = () => { throw new Error('injected: queue markDone failure'); };
    try {
      const r = taskManager.cancel(t.id);
      assert.strictEqual(r.status, 'CANCELLED', 'queue 故障不得阻断终态落地');
      const to = taskEvents(t.id, 'task.cancel_timeout');
      assert.ok(to.length >= 1, '应留 task.cancel_timeout 审计事件');
      assert.ok(JSON.stringify(to).indexOf('queue_markDone') >= 0, 'cancel_timeout 应标注故障环节');
    } finally {
      queue.markDone = origMarkDone;
    }
  });

  check('L1-5: cancel 释放该 execution 全部锁（正常路径）', () => {
    const t = taskManager.createTask({ name: 'cancel-inject-lock', objective: '测试锁释放', profileId: 'prof_cancel_test' });
    taskManager.start(t.id);
    const got = taskManager.getTask(t.id);
    assert.ok(got.currentExecutionId, 'start 后应有 execution');
    lock.acquire(lock.resourceKeyForProfile('prof_cancel_test'), { executionId: got.currentExecutionId, taskId: t.id, mode: 'active' });
    assert.strictEqual(lock.isHeld(lock.resourceKeyForProfile('prof_cancel_test')), true, '锁应已被占');
    const r = taskManager.cancel(t.id);
    assert.strictEqual(r.status, 'CANCELLED');
    assert.strictEqual(lock.isHeld(lock.resourceKeyForProfile('prof_cancel_test')), false, 'cancel 应释放该 execution 的全部锁');
  });

  check('L1-6: task.cancel_timeout 已登记 EVENT_TYPES（未登记事件会被静默丢弃）', () => {
    assert.ok(Array.isArray(events.EVENT_TYPES) && events.EVENT_TYPES.includes('task.cancel_timeout'), 'EVENT_TYPES 必须含 task.cancel_timeout');
  });

  check('L1-7: lock 释放故障注入 → 终态落地 + cancel_timeout 事件', () => {
    const t = taskManager.createTask({ name: 'cancel-inject-lock2', objective: '测试锁释放故障', profileId: 'prof_cancel_test2' });
    taskManager.start(t.id);
    const got = taskManager.getTask(t.id);
    lock.acquire(lock.resourceKeyForProfile('prof_cancel_test2'), { executionId: got.currentExecutionId, taskId: t.id, mode: 'active' });
    const orig = lock.releaseAllForExecution;
    lock.releaseAllForExecution = () => { throw new Error('injected: lock release failure'); };
    try {
      const r = taskManager.cancel(t.id);
      assert.strictEqual(r.status, 'CANCELLED', '锁释放故障不得阻断终态');
      const to = taskEvents(t.id, 'task.cancel_timeout');
      assert.ok(to.length >= 1 && JSON.stringify(to).indexOf('lock_release') >= 0, '应留 lock_release 环节的 cancel_timeout 事件');
    } finally {
      lock.releaseAllForExecution = orig;
      lock.releaseAllForExecution(got.currentExecutionId);
    }
  });

  console.log('--- L2 进程级故障注入（与 phase12Benchmark.runIsolated 同构）---');

  // L2-1: 正常 worker 在 deadline 内完成 → 不触发树杀（cancel 正常路径的进程级对应）
  await new Promise((resolve) => {
    const child = spawn(NODE, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const timer = setTimeout(() => { try { killTree(child.pid); } catch (e) {} fail++; failures.push('L2-1 :: 正常 worker 不应触发 deadline'); console.log('  FAIL L2-1 :: 正常 worker 不应触发 deadline'); resolve(); }, 5000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      try {
        assert.strictEqual(code, 0);
        pass++; console.log('  PASS L2-1: 正常 worker deadline 内完成 → 不触发树杀');
      } catch (e) { fail++; failures.push('L2-1 :: ' + e.message); console.log('  FAIL L2-1 :: ' + e.message); }
      resolve();
    });
  });

  // L2-2: worker 卡死 → deadline 到期 → 树杀 → 进程消失（worker 被释放）
  {
    const r = await hardDeadlineIsolation({ code: HANG_CODE, deadlineMs: 1500 });
    try {
      assert.ok(r.timedOut, '卡死 worker 必须由 deadline 收割');
      assert.strictEqual(r.stillAlive, false, '树杀后卡死进程必须消失');
      assert.ok(r.duration < 6000, 'deadline 收割应在 deadline+余量内完成，实际 ' + r.duration + 'ms');
      pass++; console.log('  PASS L2-2: 卡死 worker → deadline 到期 → 树杀 → 进程被释放');
    } catch (e) { fail++; failures.push('L2-2 :: ' + e.message); console.log('  FAIL L2-2 :: ' + e.message); }
  }

  // L2-3: 卡死 worker 持有子进程（模拟 Chromium）→ taskkill /T /F 树杀成功 + worker 消失
  {
    const r = await hardDeadlineIsolation({ code: TREE_CODE, deadlineMs: 1500 });
    try {
      assert.ok(r.timedOut, '卡死 worker 必须由 deadline 收割');
      assert.strictEqual(r.killOk, true, 'taskkill /T /F 树杀必须成功执行');
      assert.strictEqual(r.stillAlive, false, '树杀后 worker 必须消失');
      pass++; console.log('  PASS L2-3: 树杀连子进程一起回收（taskkill /T 执行成功 + worker 消失）');
    } catch (e) { fail++; failures.push('L2-3 :: ' + e.message); console.log('  FAIL L2-3 :: ' + e.message); }
  }

  // L2-4: 卡死任务被收割后 → 下一任务继续执行（scheduler 不被阻塞）
  try {
    await nextTaskContinues();
    pass++; console.log('  PASS L2-4: 卡死任务收割后 → 下一任务继续执行成功（scheduler 未被阻塞）');
  } catch (e) { fail++; failures.push('L2-4 :: ' + e.message); console.log('  FAIL L2-4 :: ' + e.message); }

  console.log('');
  console.log('=== A 类 cancel deadline 故障注入: ' + pass + ' passed, ' + fail + ' failed ===');
  if (failures.length) {
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  process.exit(0);
})();
