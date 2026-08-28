'use strict';

// Worker（Phase 4.1 抽象，4.3 适配）。
// 当前阶段：仅**单 Worker**，行为必须等价于「直接 taskManager.start(taskId)」。
// Worker 不重新实现执行逻辑——runDispatch 内部委托给既有 taskManager.start，
// 并通过 queueManager 的状态流转把生命周期接入编排层。
//
// 生命周期（4.2 完整，状态机在 workerState.js 统一定义）：
//   STARTING → READY → ASSIGNED → RUNNING → (PAUSED | FAILED) → STOPPED
// 4.3：dispatch 的 QUEUED→SCHEDULED→ASSIGNED→STARTED 由 Scheduler Loop + queueManager 负责；
//       Worker 仅负责「ASSIGNED→RUNNING 后触发 Runtime」这一段。

const queueManager = require('./queueManager');
const taskManager = require('../taskManager');
const { STATUS } = require('./workerState'); // 与 workerState 单一事实来源保持一致

let _seq = 0;
function uid() {
  _seq += 1;
  return 'worker_' + Date.now().toString(36) + '_' + _seq.toString(36);
}

class Worker {
  constructor(opts) {
    opts = opts || {};
    this.id = opts.id || uid();
    this.profileId = opts.profileId || null; // 留待 4.4 Browser Resource Pool
    this.status = STATUS.STARTING;
    this.currentTask = null;
    this.heartbeat = Date.now();
  }

  // 启动：状态 → READY（4.1 单 Worker 立即就绪）。
  start() {
    this.status = STATUS.READY;
    this.heartbeat = Date.now();
    return this;
  }

  // 领取并执行一个 task（dispatch 状态已由 Scheduler Loop 推进到 ASSIGNED）。
  // 入参 dispatch: { queueItem: { taskId }, execution }
  // 注意：taskManager.start 为同步（executor 异步触发，不影响同步返回），故本方法同步。
  // 返回 { ok, taskId, execution, error }。
  runDispatch(dispatch) {
    if (!dispatch) return { ok: false, error: 'no dispatch' };
    const taskId = dispatch.queueItem.taskId;
    if (this.status !== STATUS.READY && this.status !== STATUS.RUNNING) {
      this.status = STATUS.READY;
    }
    this.status = STATUS.RUNNING;
    this.currentTask = taskId;
    this.heartbeat = Date.now();
    try {
      // 委托既有执行逻辑——行为等价于 taskManager.start，零改动 runtime。
      taskManager.start(taskId);
      return { ok: true, taskId, execution: dispatch.execution || queueManager.get(taskId) };
    } catch (e) {
      this.status = STATUS.FAILED;
      return { ok: false, taskId, execution: dispatch.execution || null, error: String(e.message || e).slice(0, 300) };
    }
  }

  stop() {
    this.status = STATUS.STOPPED;
    this.currentTask = null;
  }

  // 心跳（4.2 调度存活检测用）。
  ping() { this.heartbeat = Date.now(); return this.heartbeat; }
}

module.exports = { Worker, STATUS };
