'use strict';

// Phase 4.1 Execution Queue + 单 Worker 抽象测试。
// 目标：验证 Queue + Worker 编排层，且**单 Worker 行为与直接 taskManager.start 完全一致**。
// 不验证真实浏览器执行（环境限制；executor 异步失败不影响同步 start 返回）。
// 覆盖：
//  Case1 单 Worker submitAndRun ≡ taskManager.start（任务进入 RUNNING + execution 记录生成）
//  Case2 优先级调度 HUMAN_RESUME > RECOVERY > NORMAL > BACKGROUND_LEARNING
//  Case3 队列出队顺序符合优先级
//  Case4 Worker 生命周期状态可读（READY/RUNNING）
//  Case5 隔离：execution 记录不污染 store 其他集合

const store = require('../agent/store');
const taskManager = require('../agent/taskManager');
const execution = require('../agent/execution');
const lock = require('../agent/lock');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra != null ? '  [' + extra + ']' : '')); }
}

// 确保 runtime 的 executor 已注册（taskManager.start 依赖它触发 _kick）。
try { require('../agent/runtime'); } catch (e) { /* 浏览器缺失可忽略 */ }

const _createdTaskIds = [];
let _profileSeq = 0;
function clean() {
  for (const id of _createdTaskIds) {
    const t = taskManager.getTask(id);
    if (t && t.currentExecutionId) lock.releaseAllForExecution(t.currentExecutionId);
    store.remove('aiTasks', id);
  }
  _createdTaskIds.length = 0;
  execution.queueManager.clear();
  store.write('aiWorkers', []); // 测试隔离：重置 Worker 实体（避免固定 id 跨 Case 冲突）
}

function makeTask(name) {
  _profileSeq += 1;
  const t = taskManager.createTask({
    name, objective: 'test ' + name, targetUrl: 'https://example.com',
    profileId: 'p41_profile_' + _profileSeq, executionMode: 'SIMULATION',
  });
  _createdTaskIds.push(t.id);
  return t;
}

// ============================================================
console.log('\n[Case1] 单 Worker submitAndRun ≡ taskManager.start');
clean();
{
  const t = makeTask('p41_a');
  const pool = new execution.executorPool.ExecutorPool({ maxWorkers: 1 });
  // 4.3 生命周期：submit(QUEUED) → dispatch(ASSIGNED/STARTED) ≡ taskManager.start
  execution.queueManager.submit(t.id, { category: 'NORMAL' });
  const r = pool.dispatch(t.id);
  ok(r.ok, 'dispatch 同步返回成功', r.error);
  const task = taskManager.getTask(t.id);
  ok(task && task.status === 'RUNNING', '任务进入 RUNNING（与直接 start 一致）', task && task.status);
  const execs = execution.queueManager.listExecutions();
  ok(execs.length === 1 && execs[0].taskId === t.id, '生成 1 条 dispatch 记录', execs.length);
  ok(execs[0].workerId && (execs[0].status === 'STARTED' || execs[0].status === 'ASSIGNED'), 'dispatch 被 Worker 认领且 STARTED/ASSIGNED', JSON.stringify(execs[0] && { w: execs[0].workerId, s: execs[0].status }));
  // 对照：直接 start 行为等价（不重复任务）
  ok(task.currentExecutionId, 'currentExecutionId 已设置（等价于 start 效果）', task.currentExecutionId);
  pool.stopAll();
}

// ============================================================
console.log('\n[Case2] 调度优先级：HUMAN_RESUME > RECOVERY > NORMAL > BACKGROUND_LEARNING');
{
  const S = execution.scheduler;
  ok(S.priorityFor('HUMAN_RESUME') > S.priorityFor('RECOVERY'), 'HUMAN_RESUME > RECOVERY');
  ok(S.priorityFor('RECOVERY') > S.priorityFor('NORMAL'), 'RECOVERY > NORMAL');
  ok(S.priorityFor('NORMAL') > S.priorityFor('BACKGROUND_LEARNING'), 'NORMAL > BACKGROUND_LEARNING');
  ok(S.priorityFor('UNKNOWN') === S.priorityFor('NORMAL'), '未知类别回落 NORMAL');
}

// ============================================================
console.log('\n[Case3] 队列出队顺序符合优先级');
clean();
{
  const t1 = makeTask('p41_norm');
  const t2 = makeTask('p41_human');
  const t3 = makeTask('p41_bg');
  execution.queueManager.submit(t1.id, { category: 'NORMAL', profileId: 'p1' });
  execution.queueManager.submit(t2.id, { category: 'HUMAN_RESUME', profileId: 'p2' });
  execution.queueManager.submit(t3.id, { category: 'BACKGROUND_LEARNING', profileId: 'p3' });
  // 4.3：由 dispatchPolicy 按综合分排序（等价于出队顺序）
  const queued = execution.queueManager.listExecutions({ status: 'QUEUED' });
  const ranked = execution.dispatchPolicy.rank(queued.map((q) => ({
    taskId: q.taskId, priority: q.priority, category: q.category, createdAt: q.createdAt,
  })), { now: Date.now() });
  ok(ranked[0].taskId === t2.id, '最高优先级 HUMAN_RESUME 先派发', ranked.map((x) => x.taskId));
  ok(ranked[1].taskId === t1.id, '其次 NORMAL', ranked.map((x) => x.taskId));
  ok(ranked[2].taskId === t3.id, '最后 BACKGROUND_LEARNING', ranked.map((x) => x.taskId));
}

// ============================================================
console.log('\n[Case4] Worker 生命周期状态可读');
clean();
{
  const w = new execution.worker.Worker({ id: 'w_test' });
  ok(w.status === 'STARTING', '初始 STARTING');
  w.start();
  ok(w.status === 'READY', 'start 后 READY');
  const t = makeTask('p41_w');
  w.runDispatch({ queueItem: { taskId: t.id } });
  ok(w.status === 'RUNNING' || w.status === 'READY', 'runDispatch 触发后进入 RUNNING（或已回到 READY）', w.status);
  ok(typeof w.ping() === 'number', 'ping 返回心跳时间戳');
}

// ============================================================
console.log('\n[Case5] 执行记录隔离：不污染 aiTasks 其他字段');
clean();
{
  const t = makeTask('p41_iso');
  const pool = new execution.executorPool.ExecutorPool({ maxWorkers: 1 });
  execution.queueManager.submit(t.id, { category: 'NORMAL' });
  pool.dispatch(t.id);
  const task = taskManager.getTask(t.id);
  const execs = execution.queueManager.listExecutions();
  // execution 记录不应反向改写 task（除 start 既有字段外）
  ok(task.status === 'RUNNING', 'task 状态由 taskManager 控制');
  ok(execs.every((e) => e.taskId === t.id), 'execution 仅含本任务引用');
  pool.stopAll();
}

// ============================================================
console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
