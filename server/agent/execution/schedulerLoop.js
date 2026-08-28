'use strict';

// Scheduler Loop（Phase 4.3 核心）。
// 把「Queue → Worker → Runtime」升级为完整调度循环：
//   Task Intake → Scheduler Loop → Priority/Policy/Capacity Decision → Worker Assignment → Runtime → Outcome/Evaluation
//
// 设计原则（用户既定，严格遵守）：
//  - Scheduler **只负责调度**，不参与 Agent 推理、不修改 Task 业务状态；
//  - Scheduler 经 workerManager.assign + workerManager.markRunning + pool.dispatch 触发 Runtime；
//    **绝不**直接 taskManager.start()（那属于 Worker 内部委托）；
//  - TaskManager 仍是任务状态唯一来源；Scheduler 只推进「派遣记录」(aiDispatchExecutions) 的状态；
//  - 监听 task.completed / task.failed 事件，把对应的 dispatch 标记终态并释放 Worker。
//
// 单实例（Phase 4.3）：不引入 Leader Election / 分布式锁 / K8s（留待 4.4+）。
// 但状态机已为未来多实例预留（isAcceptingDispatch / 禁止非法跳变）。

const store = require('../store');
const events = require('../events');
const queueManager = require('./queueManager');
const workerManager = require('./workerManager');
const workerRegistry = require('./workerRegistry');
const workerHeartbeat = require('./workerHeartbeat');
const capacityManager = require('./capacityManager');
const dispatchPolicy = require('./dispatchPolicy');
const taskManager = require('../taskManager');
const schedulerState = require('./schedulerState');
const executorPool = require('./executorPool');
const browserPool = require('./browser').browserResourcePool;
const { STATUS: SCHED_STATUS } = schedulerState;
const { STATUS: WORKER_STATUS } = require('./workerState');

const DEFAULT_TICK_MS = 1000; // 调度 tick 间隔

class SchedulerLoop {
  constructor(opts) {
    opts = opts || {};
    this.tickMs = opts.tickMs || DEFAULT_TICK_MS;
    this.maxWorkers = opts.maxWorkers || 1;
    this.status = SCHED_STATUS.STOPPED;
    this.pool = new executorPool.ExecutorPool({ maxWorkers: this.maxWorkers });
    this._timer = null;
    this._tickCount = 0;
    this._listening = false;
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs || 30000;
  }

  // ---- 状态机 ----
  _setStatus(to) {
    if (!schedulerState.canTransition(this.status, to)) {
      throw new Error('illegal scheduler transition: ' + this.status + ' -> ' + to);
    }
    this.status = to;
  }

  // ---- 生命周期 ----
  // start：STOPPED → STARTING → RUNNING。启动 Worker + 监听事件 + 调度循环。
  start() {
    if (this.status !== SCHED_STATUS.STOPPED) {
      // 已运行/启动中：幂等返回当前
      return { ok: true, status: this.status, note: 'already running or starting' };
    }
    this._setStatus(SCHED_STATUS.STARTING);
    events.emit({ type: 'scheduler.started', payload: { at: Date.now(), maxWorkers: this.maxWorkers } });
    // Phase 5.8 修复（Finding #1 接缝）：本进程在此之前的所有 dispatch / 活跃 task 均为僵尸
    // （上一进程可能经非 scheduler 路径留下了 RUNNING 永久悬挂、孤儿 QUEUED dispatch 等）。
    // 若不清理：
    //   - 残留 ASSIGNED/STARTED dispatch → capacityManager 误判 worker 满载 → 新任务饿死在 QUEUED；
    //   - 残留 QUEUED 孤儿 dispatch → 自动 timer 抢占 worker，新任务被旧僵尸 task 挤掉；
    //   - 残留 RUNNING/HEALING task → 永不终态，违反验收「0 RUNNING 永久悬挂」。
    // 启动时全量收割（本进程 start 时尚未 submit 任何新任务，清空安全）。
    this._reapZombieDispatches();
    // Phase 5.8 修复（Finding #1 接缝·Worker 层）：
    // 上一进程残留的 aiWorkers 记录（w1/w2/worker_x/... DEAD 态）会污染 workerManager.list()，
    // 且本进程 start 时 executorPool 已建好 worker_1 的实例；若不清理旧记录，restart 后会出现
    // 多个僵尸 worker 与 registry 状态错乱。清空后由 executorPool 重新落库为唯一干净 worker_1。
    this._reapZombieWorkers();
    this._ensureListening();
    this._setStatus(SCHED_STATUS.RUNNING);
    this._startTimer();
    return { ok: true, status: this.status };
  }

  // 收割上一进程所有残留：
  //  - 所有 dispatch 记录（任意状态）→ cancel（释放 worker 占用计数，清空队列）
  //  - 所有非终态 aiTasks → fail（杜绝 RUNNING 永久悬挂）
  // QUEUED/SCHEDULED 也一并清（它们是孤儿，本进程无对应新提交）。
  _reapZombieDispatches() {
    try {
      // 1) 所有非终态 task → fail（带 escalate=false，标准失败终态）
      const tasks = store.read('aiTasks', []);
      let failedTasks = 0;
      for (const tk of tasks) {
        if (!['SUCCESS', 'FAILED', 'CANCELLED', 'HUMAN_ESCALATION'].includes(tk.status)) {
          try { taskManager.fail(tk.id, new Error('僵尸任务被 scheduler 启动时收割（上一进程中断）')); failedTasks += 1; } catch (_) {}
        }
        // 释放可能残留的 Browser/Profile 资源占用（防幽灵锁导致新任务 RESOURCE_BUSY 饿死）
        if (tk.profileId) {
          try { browserPool.releaseResource(tk.profileId, { taskId: tk.id }); } catch (_) {}
        }
      }
      // 2) 所有 dispatch 记录 → cancel
      const dispatches = queueManager.listExecutions({});
      for (const d of dispatches) {
        try { queueManager.cancel(d.taskId); } catch (_) {}
      }
      // 3) 同步清空基础优先级队列（避免孤儿 taskId 残留）
      try { queueManager.baseQueue.clear(); } catch (_) {}
      const reaped = failedTasks + dispatches.length;
      if (reaped) {
        events.emit({ type: 'scheduler.reaped', payload: { count: reaped, at: Date.now() } });
      }
    } catch (e) {
      // 收割失败不影响主流程
    }
  }

  stop() {
    // 硬停：清空 timer，状态 → STOPPED（允许重新 STARTING）。
    this._stopTimer();
    if (this._unsub) { try { this._unsub(); } catch (e) {} this._unsub = null; this._listening = false; }
    if (this.status !== SCHED_STATUS.STOPPED) this._setStatus(SCHED_STATUS.STOPPED);
    events.emit({ type: 'scheduler.stopped', payload: { at: Date.now() } });
    return { ok: true, status: this.status };
  }

  // 暂停：RUNNING → PAUSED。已有 RUNNING 任务继续，新 dispatch 拒绝。
  pause() {
    if (this.status !== SCHED_STATUS.RUNNING) return { ok: false, error: 'only RUNNING can pause', status: this.status };
    this._setStatus(SCHED_STATUS.PAUSED);
    this._stopTimer(); // 暂停时不再 tick 派发
    events.emit({ type: 'scheduler.paused', payload: { at: Date.now() } });
    return { ok: true, status: this.status };
  }

  // 恢复：PAUSED → RUNNING。
  resume() {
    if (this.status !== SCHED_STATUS.PAUSED) return { ok: false, error: 'only PAUSED can resume', status: this.status };
    this._setStatus(SCHED_STATUS.RUNNING);
    this._startTimer();
    events.emit({ type: 'scheduler.resumed', payload: { at: Date.now() } });
    return { ok: true, status: this.status };
  }

  // 优雅退出：RUNNING/PAUSED → DRAINING。等当前在跑任务完成，不再派新。
  drain() {
    if (this.status !== SCHED_STATUS.RUNNING && this.status !== SCHED_STATUS.PAUSED) {
      return { ok: false, error: 'only RUNNING/PAUSED can drain', status: this.status };
    }
    this._setStatus(SCHED_STATUS.DRAINING);
    this._stopTimer();
    events.emit({ type: 'scheduler.draining', payload: { at: Date.now() } });
    return { ok: true, status: this.status };
  }

  // ---- 事件监听（任务终态 → 释放 Worker + 标记 dispatch 终态）----
  _ensureListening() {
    if (this._listening) return;
    this._listening = true;
    const self = this;
    // 监听 task 终态事件（进程内订阅，区别于 SSE 客户端推送）
    this._unsub = events.on((evt) => {
      if (evt.type === 'task.completed') self._onTaskDone(evt.taskId, 'COMPLETED');
      else if (evt.type === 'task.failed') self._onTaskDone(evt.taskId, 'FAILED');
      else if (evt.type === 'task.cancelled') self._onTaskDone(evt.taskId, 'CANCELLED');
      else if (evt.type === 'task.escalated') self._onTaskDone(evt.taskId, 'HUMAN_ESCALATION');
    });
  }

  _onTaskDone(taskId, dispatchStatus) {
    // 1) 标记 dispatch 终态
    const rec = queueManager.get(taskId);
    if (rec && ['STARTED', 'ASSIGNED', 'RECOVERING'].indexOf(rec.status) >= 0) {
      queueManager.finish(taskId, dispatchStatus);
    }
    // 2) 释放 Worker（由 aiDispatchExecutions.workerId 反查）
    if (rec && rec.workerId) {
      const w = workerManager.get(rec.workerId);
      if (w && (w.status === WORKER_STATUS.RUNNING || w.status === WORKER_STATUS.ASSIGNED)) {
        const rel = this.pool.onTaskFinished(rec.workerId, dispatchStatus === 'COMPLETED');
        // 若 Worker 处于 DRAINING（优雅退出中），释放后应 STOPPED
        if (rel && rel.ok === false && rel.status === WORKER_STATUS.DRAINING) {
          workerManager.stopAfterDrain(rec.workerId);
        }
      }
    }
    // 3) 幂等释放 Browser/Profile 资源（无论 SUCCESS/FAILED/CANCEL，均解除占用，防幽灵锁）
    const task = store.find('aiTasks', taskId);
    if (task && task.profileId) {
      try {
        browserPool.releaseResource(task.profileId, { taskId });
      } catch (e) { /* 资源释放失败不影响主流程 */ }
    }
    // 4) 若 Scheduler 处于 DRAINING 且已无在跑任务 → STOPPED
    if (this.status === SCHED_STATUS.DRAINING && capacityManager.totalRunning() === 0) {
      this._setStatus(SCHED_STATUS.STOPPED);
      events.emit({ type: 'scheduler.stopped', payload: { at: Date.now(), reason: 'drain complete' } });
    }
  }

  // 收割上一进程残留的 aiWorkers 记录（DEAD/STOPPED 僵尸），保证本进程只有干净的 worker_1。
  // 必须在 executorPool 已构造（构造函数内 _initDefault 建好 worker_1 实例）之后调用。
  _reapZombieWorkers() {
    try {
      workerRegistry.clear();
      // 重建唯一干净 worker（与 executorPool._initDefault 的 id 一致）。
      const rec = workerManager.startWorker({ id: 'worker_1', capacity: 1 });
      if (rec && rec.error) {
        // 极端情况下 startWorker 仍失败则忽略，下一 tick 会因无可用 worker 自然等待。
      }
    } catch (e) { /* 不影响主流程 */ }
  }

  // ---- 调度循环核心 ----
  _startTimer() {
    this._stopTimer();
    const self = this;
    this._timer = setInterval(() => self._tick(), this.tickMs);
    if (this._timer.unref) this._timer.unref();
  }
  _stopTimer() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  // 单轮 tick（同步逻辑；Runtime 异步执行不阻塞 tick）。
  _tick() {
    this._tickCount += 1;
    // 0) 进程内 Worker 存活保活：本架构为单进程单 Worker，Worker 与调度同进程，
    //    「存活」等价于 Node 进程存活。执行长任务（> heartbeatTimeoutMs）期间 runtime 不会主动 ping，
    //    若直接扫描会把正在执行任务的 Worker 误判 DEAD → capacity 归零 → 后续任务饿死。
    //    因此在死亡扫描前，对当前 RUNNING/ASSIGNED 的 Worker 补一次心跳（它们显然还活着）。
    const liveNow = Date.now();
    for (const w of workerManager.list()) {
      if (w.status === WORKER_STATUS.RUNNING || w.status === WORKER_STATUS.ASSIGNED) {
        try { workerHeartbeat.ping(w.id, w.currentExecutionId); } catch (_) {}
      }
    }
    // 1) 心跳扫描（死亡判定，落地 DEAD；恢复交 recovery）
    const dead = this.pool.recovery(liveNow, this.heartbeatTimeoutMs);

    // 1) 不接受 dispatch（非 RUNNING）→ 不发 tick 派发，但仍可处理终态释放（事件驱动）。
    if (!schedulerState.isAcceptingDispatch(this.status)) {
      return;
    }

    events.emit({ type: 'scheduler.tick', payload: { tick: this._tickCount, at: Date.now() } });

    // 2) 容量检查
    const worker = capacityManager.selectWorker();
    if (!worker) {
      events.emit({ type: 'worker.capacity.full', payload: { at: Date.now(), running: capacityManager.totalRunning() } });
      return; // 满载，等下一 tick
    }

    // 3) 取待调度队列（QUEUED），按 dispatchPolicy 排序
    const queued = queueManager.listExecutions({ status: 'QUEUED' });
    if (queued.length === 0) return;

    const now = Date.now();
    const ranked = dispatchPolicy.rank(queued.map((q) => ({
      taskId: q.taskId, priority: q.priority, category: q.category,
      createdAt: q.createdAt, retryCount: q.retryCount || 0, blocked: !!q.blocked,
    })), { now });

    // 4) 逐优先派发（单个 tick 最多填满当前可用容量）
    for (const item of ranked) {
      const w = capacityManager.selectWorker();
      if (!w) {
        events.emit({ type: 'worker.capacity.full', payload: { at: Date.now(), running: capacityManager.totalRunning() } });
        break;
      }
      this._dispatchOne(item.taskId, w.id);
    }
  }

  // 派发单个 task 给指定 Worker（推进 dispatch 状态机）。
  // 关键资源闸门：先经 BrowserResourcePool 为 task.profileId 申请资源；
  //   RESOURCE_BUSY（同 Profile 已被占）→ 退回 QUEUED，绝不派发给 Worker（不在 Browser 报错后才发现）。
  // 注意：Worker 占位（ASSIGNED）/ markRunning / Runtime 触发全部由 pool.dispatch 内部完成，
  // Scheduler 不重复调用 workerManager（避免双占导致 WORKER_BUSY）。
  _dispatchOne(taskId, workerId) {
    const task = store.find('aiTasks', taskId);
    // 资源层占用（RESOURCE_BUSY 阻断，先于 Worker 分配）
    if (task && task.profileId) {
      const acq = browserPool.acquireResource(task.profileId, { taskId, workerId });
      if (!acq.ok) {
        // 资源不可用（被同 Profile 其他任务占用）→ 退回 QUEUED，待持有者释放后再排
        const rec = queueManager.get(taskId);
        if (rec && (rec.status === 'QUEUED' || rec.status === 'SCHEDULED')) { rec.status = 'QUEUED'; store.upsert(queueManager.EXEC_COLLECTION, rec); }
        events.emit({ type: 'dispatch.rejected', payload: { taskId, workerId, reason: acq.reason, at: Date.now() } });
        return { ok: false, error: acq.reason };
      }
    }
    // SCHEDULED
    queueManager.schedule(taskId);
    events.emit({ type: 'dispatch.selected', payload: { taskId, workerId, at: Date.now() } });
    // 触发 Runtime（pool.dispatch 内部：workerManager.assign → markRunning → queueManager ASSIGNED/STARTED → runDispatch）
    const r = this.pool.dispatch(taskId, workerId);
    if (r && r.ok) {
      events.emit({ type: 'dispatch.assigned', payload: { taskId, workerId, at: Date.now() } });
    } else {
      // 分配失败（Worker 忙/退出）→ 退回 QUEUED 并释放刚占的资源（幂等）
      const rec = queueManager.get(taskId);
      if (rec && rec.status === 'SCHEDULED') { rec.status = 'QUEUED'; store.upsert(queueManager.EXEC_COLLECTION, rec); }
      if (task && task.profileId) browserPool.releaseResource(task.profileId, { taskId });
      events.emit({ type: 'dispatch.rejected', payload: { taskId, workerId, reason: r && r.error, at: Date.now() } });
    }
    return r;
  }

  // ---- 手动接口 ----
  // 提交任务（等价于 taskManager 已入队 + 建 QUEUED 记录）。
  submit(taskId, opts) {
    queueManager.submit(taskId, opts || {});
    return { ok: true, taskId };
  }

  // 立即执行一轮 tick（测试/手动触发）。
  tickOnce() {
    this._tick();
    return { ok: true, tick: this._tickCount, status: this.status };
  }

  getStatus() {
    return {
      status: this.status,
      tickCount: this._tickCount,
      running: capacityManager.totalRunning(),
      workers: workerManager.list().map((w) => ({ id: w.id, status: w.status })),
      queue: queueManager.listExecutions({ status: 'QUEUED' }).length,
    };
  }
}

// 单例（默认 1 Worker）。
let _instance = null;
function getInstance(opts) {
  if (!_instance) _instance = new SchedulerLoop(opts || {});
  return _instance;
}

module.exports = { SchedulerLoop, getInstance, DEFAULT_TICK_MS };
