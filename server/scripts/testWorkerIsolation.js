'use strict';

// Worker 隔离测试（Phase 4.2）。
// 保证：
//  A. Worker 状态变化不影响 Task 状态（task.status 不被 Worker 操作改动）
//  B. Heartbeat 不改变 Execution（aiDispatchExecutions 不受心跳影响）
//  C. Dead Worker 不会重复恢复（RECOVERING 幂等，不重复标记）
//  D. DRAINING 不接新任务

const store = require('../agent/store');
const taskManager = require('../agent/taskManager');
const execution = require('../agent/execution');
const wm = execution.workerManager;
const registry = execution.workerRegistry;
const hb = execution.workerHeartbeat;
const qm = execution.queueManager;
const { STATUS } = execution.workerState;

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra != null ? '  [' + JSON.stringify(extra) + ']' : '')); }
}

try { require('../agent/runtime'); } catch (e) {}

function clean() {
  store.write('aiWorkers', []); // 全清：测试隔离
  store.write('aiTasks', store.read('aiTasks', []).filter((t) => !(t.id || '').startsWith('task_mt')));
  store.write('aiQueue', store.read('aiQueue', []).filter((x) => !(x.taskId || '').startsWith('task_mt')));
  store.write('aiDispatchExecutions', []);
}

console.log('Worker 隔离测试');

// Case A：Worker 状态变化不影响 Task 状态
console.log('Case A Worker 状态变化不污染 Task');
clean();
{
  const t = taskManager.createTask({
    name: 'iso', objective: 'x', targetUrl: 'https://example.com',
    profileId: 'iso42_p', executionMode: 'SIMULATION',
  });
  const before = taskManager.getTask(t.id).status;
  const w = wm.startWorker({ id: 'iso42_1' });
  wm.assign(w.id, 'exec_a', t.id);
  wm.markRunning(w.id);
  wm.stopWorker(w.id);
  wm.stopAfterDrain(w.id);
  const after = taskManager.getTask(t.id).status;
  ok(before === after, 'Task 状态不受 Worker 生命周期影响', { before, after });
}

// Case B：Heartbeat 不改变 Execution
console.log('Case B Heartbeat 不写 Execution');
clean();
{
  const t = taskManager.createTask({
    name: 'iso', objective: 'x', targetUrl: 'https://example.com',
    profileId: 'iso42_p', executionMode: 'SIMULATION',
  });
  qm.submit(t.id, {});
  const dispatch = { execution: qm.get(t.id) };
  const execBefore = JSON.parse(JSON.stringify(qm.listExecutions({})))[0];
  const w = wm.startWorker({ id: 'iso42_2' });
  wm.assign(w.id, t.id, t.id);
  hb.ping(w.id, t.id); // 心跳
  hb.ping(w.id, null);
  const execAfter = qm.listExecutions({})[0];
  ok(execAfter.status === execBefore.status && execAfter.id === execBefore.id,
    'Execution 记录不被心跳修改', { before: execBefore.status, after: execAfter.status });
  // 校验 aiDispatchExecutions 集合无新写入（数量不变）
  ok(qm.listExecutions({}).length === 1, '心跳未新增 execution 记录', qm.listExecutions({}).length);
}

// Case C：Dead Worker 不会重复恢复（recover 幂等）
console.log('Case C Dead Worker 不重复恢复');
clean();
{
  const t = taskManager.createTask({
    name: 'iso', objective: 'x', targetUrl: 'https://example.com',
    profileId: 'iso42_p', executionMode: 'SIMULATION',
  });
  qm.submit(t.id, {});
  qm.schedule(t.id);
  qm.assign(t.id, 'iso42_3');
  qm.start(t.id); // → STARTED（与 WorkerManager 协作）
  const w = wm.startWorker({ id: 'iso42_3' });
  wm.assign(w.id, t.id, t.id);
  wm.markRunning(w.id);
  // 模拟心跳死亡
  const rec = registry.get(w.id);
  rec.lastHeartbeat = Date.now() - 40000; store.upsert('aiWorkers', rec);
  // 直接调用 recovery 通过 pool 实例
  const pool = new execution.executorPool.ExecutorPool({ maxWorkers: 1 });
  const res1 = pool.recovery(Date.now(), 30000);
  const execAfter1 = qm.listExecutions({})[0];
  ok(execAfter1.status === 'RECOVERING', '首次 recovery → RECOVERING', execAfter1.status);
  const res2 = pool.recovery(Date.now(), 30000);
  const execAfter2 = qm.listExecutions({})[0];
  ok(execAfter2.status === 'RECOVERING', '二次 recovery 不重复（保持 RECOVERING）', execAfter2.status);
  ok(res2.recovered.length === 0, '二次 recovery 不再产出 recovered 项', res2.recovered.length);
}

// Case D：DRAINING 不接新任务
console.log('Case D DRAINING 拒绝新任务');
clean();
{
  const w = wm.startWorker({ id: 'iso42_4' });
  const t1 = taskManager.createTask({ name: 'a', objective: 'x', targetUrl: 'https://e.com', profileId: 'iso42_p1', executionMode: 'SIMULATION' });
  wm.assign(w.id, 'exec_d1', t1.id);
  wm.markRunning(w.id);
  const stop = wm.stopWorker(w.id); // → DRAINING
  ok(stop.status === STATUS.DRAINING, '进入 DRAINING', stop.status);
  const t2 = taskManager.createTask({ name: 'b', objective: 'x', targetUrl: 'https://e.com', profileId: 'iso42_p2', executionMode: 'SIMULATION' });
  const a = wm.assign(w.id, 'exec_d2', t2.id);
  ok(!a.ok && a.error === 'WORKER_DRAINING', 'DRAINING 不接新任务', a);
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
