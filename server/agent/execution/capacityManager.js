'use strict';

// Capacity Manager（Phase 4.3）。
// 职责：决定「当前是否还能派发新任务」以及「派给哪个 Worker」，基于 Worker 容量与在跑数。
//
// 设计原则（用户既定）：
//  - 不修改 Task 业务状态；只读取 Worker 实体（aiWorkers）与 dispatch 记录（aiDispatchExecutions）；
//  - 接口提前设计为支持多维 capacity（{ browser, cpu }），当前 Phase 4.3 简化为 maxConcurrent=1；
//  - Worker 数量=1 时，若来了 100 个任务，绝不能同时 claim——必须按容量逐批。
//
// 容量语义：
//   availableWorkers = READY 的 Worker（可接收新分配）
//   某 Worker 可用 ⇔ runningExecutions(workerId) < worker.capacity.maxConcurrent
//   （未来 capacity 可扩展为 { browser:2, cpu:4 }，每维度独立计数）

const workerManager = require('./workerManager');
const queueManager = require('./queueManager');
const { STATUS } = require('./workerState');

// 默认容量（单 Worker 单并发）。未来可注入 { browser, cpu } 多维。
const DEFAULT_CAPACITY = { maxConcurrent: 1 };

// 取可用 Worker 列表（READY 且未满载）。
// 返回 Worker 记录数组（含 computed: running, capacity）。
function getAvailableWorkers() {
  const workers = workerManager.list({ status: STATUS.READY });
  return workers
    .map((w) => decorate(w))
    .filter((w) => w.running < w.capacity.maxConcurrent);
}

// 计算某 Worker 的「在跑 dispatch 数」与「容量」。
function decorate(workerRec) {
  const cap = (workerRec.capacity && typeof workerRec.capacity === 'object')
    ? Object.assign({}, DEFAULT_CAPACITY, workerRec.capacity)
    : DEFAULT_CAPACITY;
  const running = queueManager.listExecutions({ workerId: workerRec.id, status: 'STARTED' }).length
    + queueManager.listExecutions({ workerId: workerRec.id, status: 'ASSIGNED' }).length;
  return Object.assign({}, workerRec, { capacity: cap, running });
}

// 是否还有容量派发（存在可用 Worker）。
function hasCapacity() {
  return getAvailableWorkers().length > 0;
}

// 选一个 Worker 派发（默认取第一个可用；可扩展为 least-loaded / affinity）。
// 返回装饰后的 Worker 记录或 null（满载）。
function selectWorker() {
  const avail = getAvailableWorkers();
  if (avail.length === 0) return null;
  // 当前策略：取 running 最少者（least-loaded）；并列取先注册。
  avail.sort((a, b) => (a.running - b.running) || (a.startedAt || 0) - (b.startedAt || 0));
  return avail[0];
}

// 全平台在跑 dispatch 数（用于观测 / 容量.full 事件判定）。
function totalRunning() {
  return queueManager.listExecutions({ status: 'STARTED' }).length
    + queueManager.listExecutions({ status: 'ASSIGNED' }).length;
}

// 是否整体满载（无可用 Worker）。
function isFull() {
  return !hasCapacity();
}

module.exports = {
  DEFAULT_CAPACITY, getAvailableWorkers, hasCapacity, selectWorker, totalRunning, isFull, decorate,
};
