'use strict';

// Phase 4.2 Worker 生命周期 + aiWorkers 心跳 验收测试。
// 不启动浏览器（环境限制），仅验证 Worker 作为「可管理实体」的状态机、心跳、分配、优雅退出、防重复绑定。

const path = require('path');
const store = require('../agent/store');
const taskManager = require('../agent/taskManager');
const execution = require('../agent/execution');
const wm = execution.workerManager;
const registry = execution.workerRegistry;
const hb = execution.workerHeartbeat;
const { STATUS } = execution.workerState;

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra != null ? '  [' + JSON.stringify(extra) + ']' : '')); }
}

try { require('../agent/runtime'); } catch (e) { /* 浏览器缺失可忽略 */ }

let _pseq = 0;
function clean() {
  // 清理测试产生的 worker / task / queue / dispatch
  store.write('aiWorkers', []); // 全清：测试隔离，避免固定 id 跨 Case 累积
  store.write('aiTasks', store.read('aiTasks', []).filter((t) => !(t.id || '').startsWith('task_mt')));
  store.write('aiQueue', store.read('aiQueue', []).filter((x) => !(x.taskId || '').startsWith('task_mt')));
  store.write('aiDispatchExecutions', []);
}
function makeTask() {
  _pseq += 1;
  const t = taskManager.createTask({
    name: 't42', objective: 'test', targetUrl: 'https://example.com',
    profileId: 'w42_p' + _pseq, executionMode: 'SIMULATION',
  });
  return t;
}

console.log('Phase 4.2 测试');

// Case1 Worker 启动：STARTING → heartbeat → READY
console.log('Case1 Worker 启动与 READY');
clean();
{
  const rec = registry.create({ id: 'w42_1' });
  ok(rec.status === STATUS.STARTING, 'create 后状态 STARTING', rec.status);
  const ready = registry.transition(rec.id, STATUS.READY);
  ok(ready && ready.status === STATUS.READY, 'transition → READY', ready && ready.status);
  hb.ping(rec.id, null);
  const back = registry.get(rec.id);
  ok(back.status === STATUS.READY && back.lastHeartbeat > 0, 'READY 且心跳已写入', back.status);
}

// Case2 分配任务：ASSIGNED → RUNNING
console.log('Case2 分配任务 ASSIGNED → RUNNING');
clean();
{
  const w = wm.startWorker({ id: 'w42_2' });
  ok(w.status === STATUS.READY, 'startWorker → READY', w.status);
  const t = makeTask();
  const a = wm.assign(w.id, 'exec_x', t.id);
  ok(a.ok && a.status === STATUS.ASSIGNED, 'assign → ASSIGNED', a);
  const run = wm.markRunning(w.id);
  ok(run.ok && run.status === STATUS.RUNNING, 'markRunning → RUNNING', run.status);
  const back = registry.get(w.id);
  ok(back.currentExecutionId === 'exec_x' && back.currentTaskId === t.id, 'worker 记录绑定 execution/task', back);
}

// Case3 心跳丢失 → DEAD 事件
console.log('Case3 心跳丢失判定 DEAD');
clean();
{
  const w = wm.startWorker({ id: 'w42_3' });
  // 手动把 lastHeartbeat 拨到 40s 前
  const rec = registry.get(w.id);
  rec.lastHeartbeat = Date.now() - 40000;
  store.upsert('aiWorkers', rec);
  const dead = hb.scan(Date.now(), 30000);
  ok(dead.some((d) => d.workerId === w.id), 'scan 产出 DEAD 事件', dead);
  const back = registry.get(w.id);
  ok(back.status === STATUS.DEAD, 'worker 落地 DEAD', back.status);
  // 重复 scan 不应重复恢复（这里指不再改变状态，DEAD 是终态由 transition 校验）
  const dead2 = hb.scan(Date.now(), 30000);
  ok(dead2.length === 0, 'DEAD 不会重复产生事件', dead2);
}

// Case4 Graceful Shutdown：RUNNING taskA → stopWorker → DRAINING（taskA 继续）→ 完成 → STOPPED
console.log('Case4 优雅关闭 DRAINING → STOPPED');
clean();
{
  const w = wm.startWorker({ id: 'w42_4' });
  const t = makeTask();
  wm.assign(w.id, 'exec_a', t.id);
  wm.markRunning(w.id);
  const stop = wm.stopWorker(w.id);
  ok(stop.ok && stop.status === STATUS.DRAINING, 'RUNNING 时 stop → DRAINING', stop);
  const back = registry.get(w.id);
  ok(back.status === STATUS.DRAINING && back.currentExecutionId === 'exec_a', 'DRAINING 仍持有任务（继续跑）', back);
  // 任务完成：先在 registry 清掉 execution 绑定，再 stopAfterDrain
  const rec = registry.get(w.id);
  rec.currentExecutionId = null; rec.currentTaskId = null;
  store.upsert('aiWorkers', rec);
  const after = wm.stopAfterDrain(w.id);
  ok(after.ok && after.status === STATUS.STOPPED, '任务结束后 DRAINING → STOPPED', after);
}

// Case5 不允许重复绑定：worker1 占 A，再次 assign(B) → WORKER_BUSY
console.log('Case5 防重复绑定 WORKER_BUSY');
clean();
{
  const w = wm.startWorker({ id: 'w42_5' });
  const tA = makeTask();
  const a1 = wm.assign(w.id, 'exec_a', tA.id);
  ok(a1.ok, '首次 assign 成功', a1);
  const tB = makeTask();
  const a2 = wm.assign(w.id, 'exec_b', tB.id);
  ok(!a2.ok && a2.error === 'WORKER_BUSY', '再次 assign 拒绝（WORKER_BUSY）', a2);
  ok(registry.get(w.id).currentExecutionId === 'exec_a', '仍绑定原 execution', registry.get(w.id).currentExecutionId);
  // DRAINING 拒绝新分配：让 worker 处于 ASSIGNED（占坑）后 stopWorker → DRAINING，再 assign 应拒绝
  const w2 = wm.startWorker({ id: 'w42_5b' });
  const tB2 = makeTask();
  wm.assign(w2.id, 'exec_b2', tB2.id); // ASSIGNED 占坑
  const stop2 = wm.stopWorker(w2.id); // 有任务 → DRAINING
  ok(stop2.ok && stop2.status === STATUS.DRAINING, 'ASSIGNED 占坑时 stop → DRAINING', stop2);
  const tC = makeTask();
  const a3 = wm.assign(w2.id, 'exec_c', tC.id);
  ok(!a3.ok && a3.error === 'WORKER_DRAINING', 'DRAINING 拒绝新分配', a3);
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
