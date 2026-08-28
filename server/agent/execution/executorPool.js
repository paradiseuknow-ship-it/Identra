'use strict';

// Executor Pool（Phase 4.2 → 4.3 适配）。
// 4.1/4.2：池内仅 1 个 Worker，行为等价于「直接 taskManager.start」。
// 4.3：调度改由 Scheduler Loop 驱动；Pool 仅提供「运行态 Worker 实例集合」与生命周期接驳，
//       不再自管 dispatch（dispatch 状态流转归 queueManager + Scheduler Loop）。
//
// 职责边界（用户既定）：
//  - Pool/Scheduler 决定「派给哪个 Worker」，不实现执行；
//  - Runtime 实现 Agent 逻辑（异步 navigate/observe/...）；
//  - Worker 是执行容器，TaskManager 仍是任务状态唯一来源；
//  - 恢复：扫描 DEAD worker 的 STARTED dispatch → RECOVERING。

const { Worker } = require('./worker');
const queueManager = require('./queueManager');
const workerManager = require('./workerManager');
const heartbeat = require('./workerHeartbeat');
const { STATUS } = require('./workerState');

class ExecutorPool {
  constructor(opts) {
    opts = opts || {};
    this.maxWorkers = opts.maxWorkers || 1; // 4.3 仍固定 1
    this.workers = []; // 运行态 Worker 实例（与 aiWorkers 记录一一对应）
    this._initDefault();
  }

  _initDefault() {
    for (let i = 0; i < this.maxWorkers; i++) {
      const rec = workerManager.startWorker({ id: 'worker_' + (i + 1), capacity: 1 });
      const w = new Worker({ id: rec.id });
      w.status = rec.status; // 同步运行态
      this.workers.push(w);
    }
  }

  listWorkers() {
    return workerManager.list();
  }

  getReadyWorker() {
    return this.workers.find((w) => w.status === STATUS.READY) || null;
  }

  // 经 WorkerManager 派发一个已 SCHEDULED 的 task 给指定/首个可用 Worker。
  // 流程：queueManager.assign(taskId, workerId) → workerManager.assign → markRunning → worker.runDispatch。
  // 不直接调用 taskManager.start（委托 worker.runDispatch 内部触发）。
  // 返回 { ok, taskId, workerId, error }。
  dispatch(taskId, workerId) {
    const worker = workerId
      ? this.workers.find((w) => w.id === workerId)
      : this.getReadyWorker();
    if (!worker) return { ok: false, error: 'no ready worker' };

    const assigned = workerManager.assign(worker.id, taskId, taskId);
    if (!assigned.ok) return { ok: false, error: assigned.error, status: assigned.status };
    workerManager.markRunning(worker.id);
    worker.status = STATUS.RUNNING;
    // 推进 dispatch 状态：ASSIGNED → STARTED（Runtime 真正触发）
    queueManager.assign(taskId, worker.id);
    queueManager.start(taskId);
    const r = worker.runDispatch({ queueItem: { taskId }, execution: queueManager.get(taskId) });
    return Object.assign({ ok: r.ok, taskId, workerId: worker.id }, r);
  }

  // 任务完成回调：释放 Worker 执行权（回到 READY，除非 DRAINING 保持）。
  // success: boolean
  onTaskFinished(workerId, success) {
    const rel = workerManager.release(workerId, success);
    const w = this.workers.find((x) => x.id === workerId);
    if (w) w.status = rel.ok ? STATUS.READY : (rel.status || w.status);
    return rel;
  }

  stopAll() {
    this.workers.forEach((w) => workerManager.stopWorker(w.id));
  }

  // 崩溃恢复：扫描 DEAD worker 的 STARTED dispatch → RECOVERING。
  recovery(now, timeoutMs) {
    const dead = heartbeat.scan(now, timeoutMs);
    const deadIds = new Set(dead.map((d) => d.workerId));
    const running = queueManager.listExecutions({ status: 'STARTED' });
    const recovered = [];
    for (const ex of running) {
      if (ex.workerId && deadIds.has(ex.workerId)) {
        const rec = queueManager.recover(ex.taskId);
        if (rec) recovered.push({ taskId: ex.taskId, workerId: ex.workerId, status: rec.status });
      }
    }
    return { recovered, dead: dead.map((d) => d.workerId) };
  }
}

module.exports = { ExecutorPool, Worker };
