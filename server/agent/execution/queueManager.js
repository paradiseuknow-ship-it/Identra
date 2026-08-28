'use strict';

// Execution Queue Manager（Phase 4.1 → 4.3 生命周期升级）。
// 在既有 aiQueue（优先级队列）之上，增加「执行派遣记录」aiDispatchExecutions，
// 把「入队 → 出队 → 派遣给 Worker」编排成可观测的闭环。
//
// 设计原则（与 Phase 4 全局一致）：
//  - **不改动** taskManager / runtime 的执行逻辑；本层只是编排薄封装；
//  - Scheduler Loop 是驱动方，Worker 是执行容器，TaskManager 仍是任务状态唯一来源；
//  - aiDispatchExecutions 记录每次派遣（workerId / priority / status / retryCount），供 4.6 Observability 消费；
//  - **生命周期与 aiExecutions 严格区分**（用户既定）：
//      aiExecutions（recorder）：RUNNING → SUCCESS/FAILED   ← 浏览器执行会话
//      aiDispatchExecutions：QUEUED → SCHEDULED → ASSIGNED → STARTED → COMPLETED/FAILED/CANCELLED
//
// Dispatch 生命周期（4.3 明确）：
//   QUEUED    任务入队，等待调度
//   SCHEDULED Scheduler 选中（tick 决定派发），尚未绑定 Worker
//   ASSIGNED  已绑定 Worker（workerManager.assign 占位）
//   STARTED   Runtime 真正触发（workerManager.markRunning 后 taskManager.start）
//   COMPLETED / FAILED / CANCELLED  终态
//   恢复态（崩溃后）：RECOVERING（由 recovery() 产生）

const store = require('../store');
const baseQueue = require('../queue');
const scheduler = require('./scheduler');

// recorder 已占用 aiExecutions（浏览器执行会话生命周期）。
// 本层派遣记录使用独立集合 aiDispatchExecutions，两套语义绝不混集。
const EXEC_COLLECTION = 'aiDispatchExecutions';

// Dispatch 终态集合（便于判定）。
const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];

// 任务入队（由 Scheduler 决定优先级）。仅写 aiQueue + 建 QUEUED 派遣记录。
// input: { taskId, profileId, category, priorityOverride }
// 返回 queue item（含最终 priority）。
function submit(taskId, opts) {
  opts = opts || {};
  const priority = opts.priorityOverride != null
    ? opts.priorityOverride
    : scheduler.priorityFor(opts.category || 'NORMAL');
  // 幂等：baseQueue.enqueue 内部以 taskId 为 id，重复提交同一 task 只更新优先级不重复插入。
  const item = baseQueue.enqueue({
    taskId, profileId: opts.profileId || null, priority, createdAt: Date.now(),
  });
  // 同步建立 QUEUED 派遣记录（Scheduler 后续只推进状态，不重复建记录）。
  const existing = store.find(EXEC_COLLECTION, taskId);
  if (!existing) {
    store.insert(EXEC_COLLECTION, {
      id: taskId,
      taskId,
      workerId: null,
      queueItemId: taskId,
      priority: item.priority,
      category: opts.category || 'NORMAL',
      status: 'QUEUED',
      retryCount: 0,
      createdAt: Date.now(),
      scheduledAt: null,
      assignedAt: null,
      startedAt: null,
      finishedAt: null,
    });
  }
  return item;
}

// 出队（从 aiQueue 取下一个）。不建 dispatch 记录（submit 已建 QUEUED）。
// 返回 queueItem 或 null（无可派遣）。
function dequeueNext() {
  return baseQueue.dequeue();
}

// Scheduler 选中某 task 准备派发：QUEUED → SCHEDULED。
function schedule(taskId) {
  const rec = store.find(EXEC_COLLECTION, taskId);
  if (!rec) return null;
  if (rec.status !== 'QUEUED') return rec;
  rec.status = 'SCHEDULED';
  rec.scheduledAt = Date.now();
  store.upsert(EXEC_COLLECTION, rec);
  return rec;
}

// Worker 认领：SCHEDULED → ASSIGNED（回填 workerId + 占位）。
function assign(taskId, workerId) {
  const rec = store.find(EXEC_COLLECTION, taskId);
  if (!rec) return null;
  rec.workerId = workerId;
  rec.status = 'ASSIGNED';
  rec.assignedAt = Date.now();
  store.upsert(EXEC_COLLECTION, rec);
  return rec;
}

// Runtime 触发：ASSIGNED → STARTED（真正开始执行）。
function start(taskId) {
  const rec = store.find(EXEC_COLLECTION, taskId);
  if (!rec) return null;
  rec.status = 'STARTED';
  rec.startedAt = Date.now();
  store.upsert(EXEC_COLLECTION, rec);
  // 同步 queue item 状态（既有 aiQueue 终态标记在 finish 时写）
  return rec;
}

// 标记 dispatch 终态：STARTED → COMPLETED/FAILED/CANCELLED。
function finish(taskId, status) {
  const rec = store.find(EXEC_COLLECTION, taskId);
  if (!rec) return null;
  if (TERMINAL.indexOf(status) < 0) status = 'FAILED';
  rec.status = status;
  rec.finishedAt = Date.now();
  store.upsert(EXEC_COLLECTION, rec);
  // 同步 aiQueue 终态（脱队）
  baseQueue.markDone(rec.taskId, status === 'COMPLETED' ? 'DONE' : 'FAILED');
  return rec;
}

// 取消（QUEUED/SCHEDULED/ASSIGNED 可取消 → CANCELLED）。
function cancel(taskId) {
  const rec = store.find(EXEC_COLLECTION, taskId);
  if (!rec) return null;
  if (TERMINAL.indexOf(rec.status) >= 0) return rec; // 已终态不重复
  rec.status = 'CANCELLED';
  rec.finishedAt = Date.now();
  store.upsert(EXEC_COLLECTION, rec);
  baseQueue.markDone(rec.taskId, 'CANCELLED');
  return rec;
}

// 崩溃恢复：STARTED/ASSIGNED（视为中途中断）→ RECOVERING（幂等：非这两态不动）。
function recover(taskId) {
  const rec = store.find(EXEC_COLLECTION, taskId);
  if (!rec) return null;
  if (rec.status !== 'STARTED' && rec.status !== 'ASSIGNED') return rec;
  rec.status = 'RECOVERING';
  rec.recoveredAt = Date.now();
  store.upsert(EXEC_COLLECTION, rec);
  return rec;
}

function get(taskId) {
  return store.find(EXEC_COLLECTION, taskId);
}

function listExecutions(filter) {
  let arr = store.read(EXEC_COLLECTION, []);
  if (filter && filter.workerId) arr = arr.filter((r) => r.workerId === filter.workerId);
  if (filter && filter.status) arr = arr.filter((r) => r.status === filter.status);
  return arr;
}

function clear() {
  baseQueue.clear();
  store.write(EXEC_COLLECTION, []);
}

module.exports = {
  EXEC_COLLECTION, TERMINAL, submit, dequeueNext, schedule, assign, start, finish, cancel, recover, get, listExecutions, clear, baseQueue,
};
