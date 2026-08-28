'use strict';

// Execution Layer 入口（Phase 4.3 → 4.4）。
// Scheduler Loop + State + Policy + Capacity + Queue + Worker + Pool + Browser Resource 编排。
// 不改动 taskManager/runtime 执行逻辑；Scheduler 只调度，Worker 是执行容器，
// Browser/Profile 是可占用资源（与 Worker 解耦，经 BrowserResourcePool 申请/释放）。
//
// 角色定位（Phase 1 收口）：本层是【可选的编排/可观测层】，非独立执行路径。
// 唯一执行器始终是 runtime.run；Worker.runDispatch 内部委托 taskManager.start。
// Scheduler 仅在手动 POST /execution/scheduler/start 后介入（多任务容量门控 + 派遣记录）。
// 未启动 Scheduler 时，任务经 TaskManager.start 直接执行，本层仅提供资源池/可观测能力。

module.exports = {
  queueManager: require('./queueManager'),
  worker: require('./worker'),
  workerState: require('./workerState'),
  workerRegistry: require('./workerRegistry'),
  workerHeartbeat: require('./workerHeartbeat'),
  workerManager: require('./workerManager'),
  scheduler: require('./scheduler'),
  schedulerState: require('./schedulerState'),
  schedulerLoop: require('./schedulerLoop'),
  dispatchPolicy: require('./dispatchPolicy'),
  capacityManager: require('./capacityManager'),
  executorPool: require('./executorPool'),
  browser: require('./browser'),
  Worker: require('./worker').Worker,
  STATUS: require('./workerState').STATUS,
};
