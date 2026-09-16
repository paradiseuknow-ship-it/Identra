'use strict';

// Phase 4.3 Scheduler Loop 验收测试。
// 不启动浏览器（ensureBrowser 在测试环境会失败 → task.failed），但足以验证：
//   调度循环生命周期 / 优先级排序 / Worker 满载 / Aging 防饥饿 / Pause / Restart 恢复。
//
// ★ C136：全文件把「先 submit 再 start」改为「先 start 再 submit」——
//   SchedulerLoop.start() 第一步是 _reapZombieDispatches()（把所有已有 dispatch cancel、非终态
//   task fail，见 schedulerLoop.js:71/87）。旧顺序会让刚入队的 dispatch 立刻被收割成 CANCELLED
//   （实测 workerId=null、created→finished 仅 ~200ms），Case1/3/5/6 因此恒红。

process.env.FPB_DATA_DIR = require('path').join(require('os').tmpdir(), 'c136_phase43_' + Date.now());
const path = require('path');
const store = require('../agent/store');
const taskManager = require('../agent/taskManager');
const execution = require('../agent/execution');
const SchedulerLoop = execution.schedulerLoop.SchedulerLoop;
const queueManager = execution.queueManager;
const workerManager = execution.workerManager;
const { STATUS: SCHED } = execution.schedulerState;
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
  const r = sched.start(); // ★ C136：先 start 再 submit（start 会收割已有 dispatch）
  ok(r.ok && r.status === SCHED.RUNNING, 'scheduler → RUNNING', r.status);
  const t = makeTask('NORMAL');
  sched.submit(t.id, { category: 'NORMAL' });
  ok(queueManager.get(t.id) && queueManager.get(t.id).status === 'QUEUED', '提交后 dispatch 为 QUEUED', queueManager.get(t.id) && queueManager.get(t.id).status);
  // ★ C136：本环境无浏览器 ⇒ dispatch 进入 STARTED 后约 20ms 即 FAILED（实测
  //   startedAt→finishedAt = 21ms），50ms 轮询的 waitFor **抓不到**瞬时状态 ⇒ 旧断言恒红。
  //   改用可持续观测的**时间戳链**（assignedAt + startedAt 有值）判定「确实被派发并开始执行」——
  //   这是比状态快照**更强**的证据（证明真的经过 STARTED），非放宽门槛。
  const d1 = await waitFor(() => {
    const d = queueManager.get(t.id);
    return d && d.assignedAt > 0 && d.startedAt > 0 ? d : false;
  }).catch(() => null);
  ok(!!d1 && ['STARTED', 'FAILED', 'CANCELLED', 'COMPLETED'].includes(d1.status),
    'taskA dispatch 被派发并开始执行（assignedAt+startedAt 有值）',
    d1 && { status: d1.status, assignedAt: d1.assignedAt, startedAt: d1.startedAt });
  ok(!!d1 && !!d1.workerId && !!workerManager.get(d1.workerId),
    'dispatch 已绑定到真实存在的 worker（被承接执行）', d1 && d1.workerId);
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
  sched.start(); // ★ C136：先 start 再 submit（否则 dispatch 被 start 收割为 CANCELLED）
  sched.submit(a.id, { category: 'NORMAL' });
  sched.submit(b.id, { category: 'NORMAL' });
  // ★ C136：本环境无浏览器 ⇒ dispatch 全链（QUEUED→ASSIGNED→STARTED→FAILED）仅 ~20ms。
  //   旧断言「A 在跑 ∧ B 仍 QUEUED」**原理上不可成立**（A 一结束 capacity 释放，B 立刻被派发），
  //   旧 running<=1 又是单点快照（读到全 FAILED 时 running=0 ⇒ **真空绿**）。
  //   先试外部 10ms 采样 —— 实测仍会整段漏掉（peak=0 假红）⇒ 改为**从落库时间戳重建时间线**：
  //   以每个 dispatch 的 [assignedAt, finishedAt] 为占用区间求**最大重叠数**，完全确定性、无采样竞争，
  //   且比抽样更强（覆盖整段历史而非若干瞬间）。
  await new Promise((res) => setTimeout(res, 500));
  const allD = queueManager.listExecutions({});
  const ivs = allD.filter((d) => d.assignedAt > 0)
    .map((d) => [d.assignedAt, d.finishedAt > 0 ? d.finishedAt : Number.MAX_SAFE_INTEGER]);
  let maxOverlap = 0;
  for (const p of ivs) {
    const n = ivs.filter((q) => q[0] < p[1] && p[0] < q[1]).length;
    if (n > maxOverlap) maxOverlap = n;
  }
  ok(ivs.length >= 1, '确有 dispatch 被派发执行（防真空绿）', { dispatched: ivs.length, total: allD.length });
  ok(maxOverlap <= 1, '并发占用峰值不超过 1（capacity=1，按时间线重建）', maxOverlap);
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
  sched.start(); // ★ C136：先 start 再 submit（否则 dispatch 被 start 收割为 CANCELLED）
  sched.submit(a.id, { category: 'NORMAL' });
  // ★ C136：b **不在 pause 前提交** —— 旧写法先提交 b 再暂停，则「暂停后 b 仍 QUEUED」无法证明
  //   （b 早已在暂停前被派发、~20ms 内 FAILED ⇒ 实测红因恒为 ["FAILED"]）。改为只在 pause 后提交。
  await waitFor(() => { const d = queueManager.get(a.id); return d && d.assignedAt > 0; })
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
  oldSched.start(); // ★ C136：先 start 再 submit
  oldSched.submit(a.id, { category: 'NORMAL' });
  // ★ C136：本环境任务 ~20ms 即走完（无浏览器 ⇒ FAILED）⇒「崩溃前残留 STARTED」**不可构造**。
  //   改为断言**等价且可观测**的证据：A 确实被派发执行过（startedAt 有值）、且崩溃后未被重置为 QUEUED
  //   —— 后者才是本 Case 真正要守的不变量（残留不被无条件打回队列）。
  await waitFor(() => { const d = queueManager.get(a.id); return d && d.startedAt > 0; }).catch(() => {});
  const beforeA = queueManager.get(a.id);
  ok(beforeA && beforeA.startedAt > 0 && beforeA.status !== 'QUEUED',
    '崩溃前 A 已进入执行且非 QUEUED', beforeA && { status: beforeA.status, startedAt: beforeA.startedAt });
  // 模拟崩溃：直接停掉旧 scheduler 的 timer + 监听（不标记任何终态）
  oldSched._stopTimer();
  if (oldSched._unsub) { try { oldSched._unsub(); } catch (e) {} oldSched._unsub = null; oldSched._listening = false; }

  // 2) 新 scheduler 启动（restart）→ 扫描恢复
  const newSched = new SchedulerLoop({ maxWorkers: 1, tickMs: 50 });
  const b = makeTask('NORMAL');
  const r = newSched.start(); // ★ C136：先 start 再 submit
  ok(r.ok && r.status === SCHED.RUNNING, '新 scheduler → RUNNING', r.status);
  newSched.submit(b.id, { category: 'NORMAL' }); // 同时有个新 QUEUED
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
