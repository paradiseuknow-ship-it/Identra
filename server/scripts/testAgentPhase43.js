'use strict';

// Phase 4.3 Scheduler Loop 验收测试。
// 不启动浏览器（ensureBrowser 在测试环境会失败 → task.failed），但足以验证：
//   调度循环生命周期 / 优先级排序 / Worker 满载 / Aging 防饥饿 / Pause / Restart 恢复。

const path = require('path');
const store = require('../agent/store');
const taskManager = require('../agent/taskManager');
const execution = require('../agent/execution');
const SchedulerLoop = execution.schedulerLoop.SchedulerLoop;
const queueManager = execution.queueManager;
const workerManager = execution.workerManager;
const { STATUS: SCHED } = execution.schedulerState;
const { STATUS: WORKER } = execution.workerState;
const dispatchPolicy = execution.dispatchPolicy;

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra != null ? '  [' + JSON.stringify(extra) + ']' : '')); }
}

try { require('../agent/runtime'); } catch (e) { /* 浏览器缺失可忽略 */ }

let _pseq = 0;
function clean() {
  store.write('aiWorkers', []);
  store.write('aiDispatchExecutions', []);
  store.write('aiQueue', []);
  store.write('aiTasks', store.read('aiTasks', []).filter((t) => !(t.id || '').startsWith('p43_')));
  store.write('aiEvents', store.read('aiEvents', []).filter((e) => !(e.taskId || '').startsWith('p43_')));
}
function makeTask(category) {
  _pseq += 1;
  const t = taskManager.createTask({
    name: 'p43', objective: 'test', targetUrl: 'https://example.com',
    profileId: 'p43_p' + _pseq, executionMode: 'SIMULATION',
  });
  return t;
}

// 等待条件满足（轮询），超时即失败。
function waitFor(fn, timeoutMs, intervalMs) {
  timeoutMs = timeoutMs || 8000;
  intervalMs = intervalMs || 50;
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      let r;
      try { r = fn(); } catch (e) { r = false; }
      if (r) { clearInterval(iv); resolve(r); }
      else if (Date.now() - start > timeoutMs) { clearInterval(iv); reject(new Error('waitFor timeout')); }
    }, intervalMs);
  });
}

console.log('Phase 4.3 Scheduler Loop 测试');

async function main() {
// Case1 基础循环：提交 taskA → scheduler start → queue EMPTY + worker RUNNING + dispatch STARTED
console.log('Case1 基础调度循环');
clean();
{
  const sched = new SchedulerLoop({ maxWorkers: 1, tickMs: 50 });
  const t = makeTask('NORMAL');
  sched.submit(t.id, { category: 'NORMAL' });
  ok(queueManager.get(t.id) && queueManager.get(t.id).status === 'QUEUED', '提交后 dispatch 为 QUEUED', queueManager.get(t.id) && queueManager.get(t.id).status);
  const r = sched.start();
  ok(r.ok && r.status === SCHED.RUNNING, 'scheduler → RUNNING', r.status);
  await waitFor(() => {
    const d = queueManager.get(t.id);
    return d && d.status === 'STARTED';
  }).then(() => {
    ok(true, 'taskA dispatch 推进到 STARTED');
  }).catch(() => {
    ok(false, 'taskA dispatch 推进到 STARTED（超时）', queueManager.get(t.id));
  });
  await waitFor(() => {
    const w = workerManager.get('worker_1');
    return w && w.status === WORKER.RUNNING;
  }).then(() => ok(true, 'worker 进入 RUNNING')).catch(() => ok(false, 'worker 进入 RUNNING（超时）'));
  await waitFor(() => queueManager.listExecutions({ status: 'QUEUED' }).length === 0)
    .then(() => ok(true, '队列清空（EMPTY）')).catch(() => ok(false, '队列清空（超时）'));
  sched.stop();
}

// Case2 优先级：human > recovery > normal
console.log('Case2 优先级排序');
clean();
{
  const items = [
    { taskId: 'p43_n', priority: 50, category: 'NORMAL', createdAt: Date.now() },
    { taskId: 'p43_r', priority: 80, category: 'RECOVERY', createdAt: Date.now() },
    { taskId: 'p43_h', priority: 90, category: 'HUMAN_RESUME', createdAt: Date.now() },
  ];
  const ranked = dispatchPolicy.rank(items, { now: Date.now() });
  ok(ranked[0].taskId === 'p43_h', 'human 排第一', ranked.map((x) => x.taskId));
  ok(ranked[1].taskId === 'p43_r', 'recovery 排第二', ranked.map((x) => x.taskId));
  ok(ranked[2].taskId === 'p43_n', 'normal 排第三', ranked.map((x) => x.taskId));
}

// Case3 Worker 满载：capacity=1，提交 A、B → A ASSIGNED/STARTED，B 仍 QUEUED（不并发 RUNNING）
console.log('Case3 Worker 满载不并发');
clean();
{
  const sched = new SchedulerLoop({ maxWorkers: 1, tickMs: 50 });
  const a = makeTask('NORMAL');
  const b = makeTask('NORMAL');
  sched.submit(a.id, { category: 'NORMAL' });
  sched.submit(b.id, { category: 'NORMAL' });
  sched.start();
  await waitFor(() => {
    const da = queueManager.get(a.id);
    const db = queueManager.get(b.id);
    return da && (da.status === 'STARTED' || da.status === 'ASSIGNED') && db && db.status === 'QUEUED';
  }).then(() => ok(true, 'A 派发、B 仍 QUEUED（无并发）')).catch(() => {
    const da = queueManager.get(a.id), db = queueManager.get(b.id);
    ok(false, 'A 派发、B 仍 QUEUED（超时）', { a: da && da.status, b: db && db.status });
  });
  // 校验不出现两个同时 RUNNING/STARTED
  const running = queueManager.listExecutions({ status: 'STARTED' }).length
    + queueManager.listExecutions({ status: 'ASSIGNED' }).length;
  ok(running <= 1, '在跑 dispatch 不超过 1（capacity=1）', running);
  sched.stop();
}

// Case4 Aging：normal 等 1h vs background 等 2h → 老化后 background 不被 normal 永久压制
console.log('Case4 Aging 防饥饿');
clean();
{
  const now = Date.now();
  const normal = { taskId: 'n', priority: 50, category: 'NORMAL', createdAt: now - 60 * 60000 };       // 等 1h
  const bg = { taskId: 'b', priority: 10, category: 'BACKGROUND_LEARNING', createdAt: now - 120 * 60000 }; // 等 2h
  const ranked = dispatchPolicy.rank([normal, bg], { now });
  ok(ranked[0].taskId === 'b', 'BACKGROUND 等 2h 因 aging 反超 NORMAL 等 1h', ranked.map((x) => x.taskId + ':' + x._score.score));
  // 对比：无 aging（刚入队）时 normal 应高于 background
  const fresh = dispatchPolicy.rank(
    [{ taskId: 'n2', priority: 50, category: 'NORMAL', createdAt: now }, { taskId: 'b2', priority: 10, category: 'BACKGROUND_LEARNING', createdAt: now }],
    { now }
  );
  ok(fresh[0].taskId === 'n2', '刚入队时 NORMAL > BACKGROUND（无 aging 压制）', fresh.map((x) => x.taskId));
}

// Case5 Pause：已有 RUNNING 继续，新 QUEUED 不派发
console.log('Case5 Scheduler 暂停');
clean();
{
  const sched = new SchedulerLoop({ maxWorkers: 1, tickMs: 50 });
  const a = makeTask('NORMAL');
  const b = makeTask('NORMAL');
  sched.submit(a.id, { category: 'NORMAL' });
  sched.submit(b.id, { category: 'NORMAL' });
  sched.start();
  await waitFor(() => { const d = queueManager.get(a.id); return d && d.status === 'STARTED'; })
    .catch(() => {});
  const p = sched.pause();
  ok(p.ok && p.status === SCHED.PAUSED, 'scheduler → PAUSED', p.status);
  // 提交新任务，应仍 QUEUED
  sched.submit(b.id, { category: 'NORMAL' });
  await new Promise((res) => setTimeout(res, 300)); // 等一会确认不派发
  const db = queueManager.get(b.id);
  ok(db && db.status === 'QUEUED', '暂停后新任务保持 QUEUED（不派发）', db && db.status);
  const da = queueManager.get(a.id);
  ok(da && (da.status === 'STARTED' || da.status === 'FAILED' || da.status === 'COMPLETED'), '已有任务继续（未中断）', da && da.status);
  sched.stop();
}

// Case6 Restart 恢复：模拟 scheduler crash → 扫描 QUEUED/ASSIGNED/STARTED 继续
console.log('Case6 崩溃重启恢复');
clean();
{
  // 1) 先由旧 scheduler 派发 A，并让 A 处于 STARTED（运行中）
  const oldSched = new SchedulerLoop({ maxWorkers: 1, tickMs: 50 });
  const a = makeTask('NORMAL');
  oldSched.submit(a.id, { category: 'NORMAL' });
  oldSched.start();
  await waitFor(() => { const d = queueManager.get(a.id); return d && d.status === 'STARTED'; }).catch(() => {});
  // 模拟崩溃：直接停掉旧 scheduler 的 timer + 监听（不标记任何终态），留下 STARTED 残留
  oldSched._stopTimer();
  if (oldSched._unsub) { try { oldSched._unsub(); } catch (e) {} oldSched._unsub = null; oldSched._listening = false; }
  ok(queueManager.get(a.id).status === 'STARTED', '崩溃前 A 残留 STARTED', queueManager.get(a.id).status);

  // 2) 新 scheduler 启动（restart）→ 扫描恢复
  const newSched = new SchedulerLoop({ maxWorkers: 1, tickMs: 50 });
  const b = makeTask('NORMAL');
  newSched.submit(b.id, { category: 'NORMAL' }); // 同时有个新 QUEUED
  const r = newSched.start();
  ok(r.ok && r.status === SCHED.RUNNING, '新 scheduler → RUNNING', r.status);
  // 恢复逻辑：A 已是 STARTED（由其所属 worker 继续），B 被新调度派发
  await waitFor(() => {
    const db = queueManager.get(b.id);
    return db && (db.status === 'STARTED' || db.status === 'ASSIGNED' || db.status === 'FAILED' || db.status === 'COMPLETED');
  }).then(() => ok(true, '重启后新 QUEUED 任务继续被调度')).catch(() => ok(false, '重启后新任务未调度（超时）', queueManager.get(b.id)));
  // 确认 A 仍被视为在跑或已正常终态（未被丢弃为 QUEUED）
  const da = queueManager.get(a.id);
  ok(da && da.status !== 'QUEUED', '崩溃残留的 STARTED 任务未被重置为 QUEUED（继续/终态）', da && da.status);
  newSched.stop();
}
}

main().then(() => {
  console.log('\nPhase 4.3 结果: ' + pass + ' pass, ' + fail + ' fail');
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => {
  console.error('测试异常:', e);
  console.log('\nPhase 4.3 结果: ' + pass + ' pass, ' + fail + ' fail');
  process.exit(1);
});
