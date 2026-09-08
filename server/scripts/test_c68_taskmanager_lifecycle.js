#!/usr/bin/env node
// C68 —— taskManager 生命周期守护（agent 子模块深扫第 1 批）：
//   D1 (B 类死逻辑)：retry()/deleteTask() 的 aiAttempts 清理先删 steps 再用
//     store.find('aiSteps', a.stepId) 反查 —— 被删 step 永远查不到 → 过滤恒真 →
//     attempt 孤儿永久残留（runtime errorHistory 按 a.taskId 消费这些孤儿记录）。
//     修复：删除前快照 stepIds + 直接按 a.taskId 过滤（v0.2.2 起 attempt 自带 taskId）。
//   D2 (B 类锁竞争)：recover() 的 lock.acquire 返回值未检查（start() 有完整失败处理）——
//     崩溃后同 profile 被新任务占锁时，recover 静默继续 → 双开同一 profile（C64 同族）
//     + 孤儿 RUNNING execution。修复：对齐 start() —— 失败即 FAILED 终态 + execution
//     markFinished + 抛错。
// 零浏览器零网络；FPB_DATA_DIR tmp 隔离（jsonStore 路径模块加载时解析，需子进程 env 注入）。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const here = __dirname;
let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + ': ' + detail); console.log('  FAIL ' + name + ' — ' + detail); }
}

// ---- 子进程隔离跑（FPB_DATA_DIR 在模块加载前生效）----
function runInChild(fnName, script) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c68-data-'));
  const tmpJS = path.join(os.tmpdir(), 'c68-' + fnName + '-' + Date.now() + '.js');
  fs.writeFileSync(tmpJS, script, 'utf8');
  const r = spawnSync(process.execPath, [tmpJS], {
    env: Object.assign({}, process.env, { FPB_DATA_DIR: dataDir }),
    encoding: 'utf8',
    timeout: 60000,
  });
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(tmpJS, { force: true }); } catch (e) {}
  return r;
}

// ---- P1: retry 清理 attempts（修复后：本任务 attempts 删除、他任务保留）----
{
  const script = `
'use strict';
const assert = require('assert');
const store = require('${here.replace(/\\/g, '/')}/../agent/store');
const taskManager = require('${here.replace(/\\/g, '/')}/../agent/taskManager');
const stepManager = require('${here.replace(/\\/g, '/')}/../agent/stepManager');

const out = { ok: true, error: null };
try {
  taskManager.setExecutor(null); // 不真跑 runtime

  // 任务 A（被 retry 的）与任务 B（对照组）
  const a = taskManager.createTask({ name: 'A', objective: 'obj-a' });
  const b = taskManager.createTask({ name: 'B', objective: 'obj-b' });

  // A: plan + steps + attempts（跨 execution 各一条）
  taskManager.attachPlan(a.id, { goal: 'g', steps: [{ title: 's1' }, { title: 's2' }] });
  const stepsA = stepManager.listSteps(a.id);
  assert.strictEqual(stepsA.length, 2, 'A should have 2 steps');
  const attA1 = stepManager.createAttempt(stepsA[0].id, 'exec-old', { type: 'click' });
  const attA2 = stepManager.createAttempt(stepsA[1].id, 'exec-old', { type: 'click' });

  // B: steps + attempts（必须幸存）
  taskManager.attachPlan(b.id, { goal: 'g', steps: [{ title: 'b1' }] });
  const stepB = stepManager.listSteps(b.id)[0];
  const attB = stepManager.createAttempt(stepB.id, 'exec-b', { type: 'click' });

  // A 走到 FAILED 再 retry
  taskManager.start(a.id);
  taskManager.fail(a.id, 'boom');
  taskManager.retry(a.id);

  const attemptsAfter = store.read('aiAttempts', []);
  const aLeft = attemptsAfter.filter((x) => x.taskId === a.id);
  const bKept = attemptsAfter.find((x) => x.id === attB.id);
  const orphanByStep = attemptsAfter.filter((x) => x.id === attA1.id || x.id === attA2.id);

  if (aLeft.length !== 0) throw new Error('P1a: A 的 attempts 未被清理: ' + aLeft.length + ' 条');
  if (orphanByStep.length !== 0) throw new Error('P1b: 旧 attempt(A1/A2) 残留（死逻辑未修）');
  if (!bKept) throw new Error('P1c: 任务 B 的 attempt 被误删');
  if (stepManager.listSteps(a.id).length !== 0) throw new Error('P1d: retry 应清空旧 steps（重规划由 runtime 负责）');
  out.p1 = 'attempts cleaned, B intact, old steps purged';
} catch (e) { out.ok = false; out.error = String(e && e.stack || e); }
console.log('__RESULT__' + JSON.stringify(out));
`;
  const r = runInChild('p1', script);
  const m = (r.stdout || '').match(/__RESULT__(.*)/);
  const out = m ? JSON.parse(m[1]) : { ok: false, error: 'no result marker. stdout: ' + (r.stdout || '').slice(-400) + ' stderr: ' + (r.stderr || '').slice(-400) };
  chk('P1.retry-purges-attempts', out.ok, out.error || 'see above');
}

// ---- P2: deleteTask 清理 attempts（修复前只删 steps）----
{
  const script = `
'use strict';
const assert = require('assert');
const store = require('${here.replace(/\\/g, '/')}/../agent/store');
const taskManager = require('${here.replace(/\\/g, '/')}/../agent/taskManager');
const stepManager = require('${here.replace(/\\/g, '/')}/../agent/stepManager');

const out = { ok: true, error: null };
try {
  taskManager.setExecutor(null);
  const a = taskManager.createTask({ name: 'A', objective: 'obj' });
  const b = taskManager.createTask({ name: 'B', objective: 'obj' });
  taskManager.attachPlan(a.id, { goal: 'g', steps: [{ title: 's1' }] });
  const stepsA = stepManager.listSteps(a.id);
  const attA = stepManager.createAttempt(stepsA[0].id, 'exec-x', { type: 'click' });
  taskManager.attachPlan(b.id, { goal: 'g', steps: [{ title: 'b1' }] });
  const attB = stepManager.createAttempt(stepManager.listSteps(b.id)[0].id, 'exec-b', { type: 'click' });

  taskManager.deleteTask(a.id);
  const attemptsAfter = store.read('aiAttempts', []);
  if (attemptsAfter.find((x) => x.id === attA.id)) throw new Error('P2a: 被删任务的 attempt 残留');
  if (!attemptsAfter.find((x) => x.id === attB.id)) throw new Error('P2b: 他任务 attempt 被误删');
  out.p2 = 'deleted-task attempts purged, others intact';
} catch (e) { out.ok = false; out.error = String(e && e.stack || e); }
console.log('__RESULT__' + JSON.stringify(out));
`;
  const r = runInChild('p2', script);
  const m = (r.stdout || '').match(/__RESULT__(.*)/);
  const out = m ? JSON.parse(m[1]) : { ok: false, error: 'no result marker. stdout: ' + (r.stdout || '').slice(-400) + ' stderr: ' + (r.stderr || '').slice(-400) };
  chk('P2.deleteTask-purges-attempts', out.ok, out.error || 'see above');
}

// ---- P3: recover() 锁竞争 → FAILED 终态（修复前静默继续）----
{
  const script = `
'use strict';
const assert = require('assert');
const taskManager = require('${here.replace(/\\/g, '/')}/../agent/taskManager');
const lock = require('${here.replace(/\\/g, '/')}/../agent/lock');
const store = require('${here.replace(/\\/g, '/')}/../agent/store');

const out = { ok: true, error: null };
try {
  taskManager.setExecutor(null);
  // 用一个真实 task 走到 RUNNING 持锁，然后手动把锁让给「另一个 execution」
  const a = taskManager.createTask({ name: 'A', objective: 'obj', profileId: 'prof-lock' });
  taskManager.start(a.id); // 持锁 execution E1
  const t1 = taskManager.getTask(a.id);
  const e1 = t1.currentExecutionId;
  assert.ok(e1, 'start should create execution');

  // 模拟：E1 锁先释放，随后另一个 execution 抢占同 profile 锁（公开 API 注入）
  const key = lock.resourceKeyForProfile('prof-lock');
  lock.releaseAllForExecution(e1);
  const grabbed = lock.acquire(key, { executionId: 'exec-intruder', taskId: 'task-intruder' });
  assert.ok(grabbed.ok, 'intruder should grab the freed lock');

  // recover 必须失败而不是静默继续
  let threw = null;
  try { taskManager.recover(a.id); } catch (e) { threw = e; }
  if (!threw) throw new Error('P3a: 锁被他人持有时 recover 未抛错（静默双开风险）');
  const t2 = taskManager.getTask(a.id);
  if (t2.status !== 'FAILED') throw new Error('P3b: recover 失败后任务应落 FAILED 终态，实际 ' + t2.status);
  const execs = store.read('aiExecutions', []).filter((x) => x.taskId === a.id);
  const last = execs[execs.length - 1];
  if (!last || last.status !== 'FAILED') throw new Error('P3c: 恢复 execution 应 markFinished FAILED，实际 ' + (last && last.status));
  out.p3 = 'recover failed loudly, task FAILED, execution closed';
} catch (e) { out.ok = false; out.error = String(e && e.stack || e); }
console.log('__RESULT__' + JSON.stringify(out));
`;
  const r = runInChild('p3', script);
  const m = (r.stdout || '').match(/__RESULT__(.*)/);
  const out = m ? JSON.parse(m[1]) : { ok: false, error: 'no result marker. stdout: ' + (r.stdout || '').slice(-400) + ' stderr: ' + (r.stderr || '').slice(-400) };
  chk('P3.recover-lock-contention-fails-loud', out.ok, out.error || 'see above');
}

// ---- P4: recover() 正常路径不回归（锁空闲时恢复成功）----
{
  const script = `
'use strict';
const assert = require('assert');
const taskManager = require('${here.replace(/\\/g, '/')}/../agent/taskManager');
const lock = require('${here.replace(/\\/g, '/')}/../agent/lock');

const out = { ok: true, error: null };
try {
  taskManager.setExecutor(null);
  const a = taskManager.createTask({ name: 'A', objective: 'obj', profileId: 'prof-ok' });
  taskManager.start(a.id);
  taskManager.fail(a.id, 'boom'); // FAILED
  // FAILED 不允许 recover（状态机口径：仅 RUNNING/HEALING/RECOVERING）
  // 模拟「进程崩溃后任务仍标记 RUNNING」的真实恢复场景：直接改回 RUNNING
  const t0 = taskManager.getTask(a.id);
  t0.status = 'RUNNING';
  const store = require('${here.replace(/\\/g, '/')}/../agent/store');
  store.upsert('aiTasks', t0);

  const t = taskManager.recover(a.id);
  if (t.status !== 'RUNNING') throw new Error('P4a: 恢复后应 RUNNING，实际 ' + t.status);
  if (!t.currentExecutionId || t.currentExecutionId === undefined) throw new Error('P4b: 应有新 execution');
  // 锁应被恢复 execution 持有（公开 API 探测：他人再 acquire 必须 busy）
  const key = lock.resourceKeyForProfile('prof-ok');
  const probe = lock.acquire(key, { executionId: 'probe', taskId: 'probe' });
  if (probe.ok) throw new Error('P4c: 恢复后应持有 profile 锁（探测 acquire 竟然成功）');
  out.p4 = 'happy-path recover intact';
} catch (e) { out.ok = false; out.error = String(e && e.stack || e); }
console.log('__RESULT__' + JSON.stringify(out));
`;
  const r = runInChild('p4', script);
  const m = (r.stdout || '').match(/__RESULT__(.*)/);
  const out = m ? JSON.parse(m[1]) : { ok: false, error: 'no result marker. stdout: ' + (r.stdout || '').slice(-400) + ' stderr: ' + (r.stderr || '').slice(-400) };
  chk('P4.recover-happy-path-intact', out.ok, out.error || 'see above');
}

console.log('\n==== C68 RESULT: ' + pass + ' pass / ' + fail + ' fail ====');
if (failures.length) failures.forEach((f) => console.log('  FAILED: ' + f));
process.exit(fail ? 1 : 0);
