'use strict';

// Worker Manager（Phase 4.2）：Worker 生命周期统一入口。
// 职责边界（用户既定）：
//   Scheduler → WorkerManager → Worker
// Scheduler 不直接操作 aiWorkers；任务状态仍由 TaskManager 负责；
// 本模块只管理「Worker 实体」：启动 / 停止 / 分配 / 释放 / 列举。
//
// 关键不变量：
//  - 一个 Worker 同一时刻最多绑定一个 execution（ASSIGNED/RUNNING 即占坑）→ 重复 assign 返回 WORKER_BUSY；
//  - DRAINING 状态拒绝新分配（优雅退出）；
//  - stopWorker：RUNNING/DRAINING 的任务继续跑完，Worker 转 DRAINING，当前任务完成后转 STOPPED。

const registry = require('./workerRegistry');
const heartbeat = require('./workerHeartbeat');
const { STATUS, isAssignable, isDraining } = require('./workerState');

// 启动一个 Worker：创建实体（STARTING）→ 置 READY（资源就绪）。返回记录。
// Phase 5.8 修复（Finding #1 接缝）：registry.create 在 worker id 已存在时重建为 STARTING，
//   但旧记录若为 DEAD/STOPPED，直接 DEAD→READY 属非法转换会被拒绝，导致 worker 永远不在
//   READY 列表 → Scheduler 认为无可用 Worker → 任务永久停在 PENDING/QUEUED。
//   修复：transition 失败时先复活到 STARTING（DEAD/STOPPED→STARTING 合法），再转 READY。
function startWorker(opts) {
  const rec = registry.create(opts || {});
  let ready = registry.transition(rec.id, STATUS.READY);
  if (!ready || ready.error) {
    // 复活到 STARTING 再转 READY（覆盖 DEAD/STOPPED 残留态）。
    const revived = registry.transition(rec.id, STATUS.STARTING);
    if (revived && !revived.error) ready = registry.transition(rec.id, STATUS.READY);
  }
  heartbeat.ping(rec.id, null);
  return ready && !ready.error ? ready : rec;
}

// 停止 Worker（优雅）。
// 行为：
//  - 若当前 RUNNING/ASSIGNED（有任务在身）→ 转 DRAINING（禁止新任务，等当前任务结束）；
//    调用方需在任务终态后再次调用 stopWorker 完成 STOPPED；
//  - 若当前 READY（无任务）→ 直接 STOPPED；
//  - 终态不可再转（除非 restart）。
// 返回 { ok, status, note }。
function stopWorker(workerId) {
  const rec = registry.get(workerId);
  if (!rec) return { ok: false, error: 'unknown worker' };
  if (rec.status === STATUS.STOPPED) return { ok: true, status: STATUS.STOPPED, note: 'already stopped' };
  if (rec.status === STATUS.DEAD) return { ok: false, error: 'worker dead, rebuild instead' };

  const busy = rec.currentExecutionId != null;
  const target = busy ? STATUS.DRAINING : STATUS.STOPPED;
  const updated = registry.transition(workerId, target);
  if (!updated || updated.error) return { ok: false, error: updated && updated.error, from: rec.status };
  return {
    ok: true,
    status: target,
    draining: target === STATUS.DRAINING,
    note: busy ? 'draining: current task continues, will STOP after finish' : 'stopped',
  };
}

// 当前任务完成后再停（由 Runtime 回调触发）。
// 仅当 Worker 处于 DRAINING 且有任务在身 → STOPPED。
function stopAfterDrain(workerId) {
  const rec = registry.get(workerId);
  if (!rec) return { ok: false, error: 'unknown worker' };
  if (rec.status !== STATUS.DRAINING) return { ok: true, status: rec.status, note: 'not draining' };
  if (rec.currentExecutionId != null) {
    return { ok: true, status: STATUS.DRAINING, note: 'still has task' };
  }
  const updated = registry.transition(workerId, STATUS.STOPPED);
  return { ok: true, status: updated.status };
}

// 分配任务执行权给 Worker（ASSIGNED）。
// 前置：Worker 必须 isAssignable（仅 READY）；否则：
//  - 已 ASSIGNED/RUNNING（占坑）→ WORKER_BUSY；
//  - DRAINING/PAUSED/STARTING/STOPPED/DEAD → 拒绝。
// 返回 { ok, status, error }。
function assign(workerId, executionId, taskId) {
  const rec = registry.get(workerId);
  if (!rec) return { ok: false, error: 'unknown worker' };
  if (isDraining(rec.status)) return { ok: false, error: 'WORKER_DRAINING', status: rec.status };
  if (!isAssignable(rec.status)) {
    return { ok: false, error: (rec.currentExecutionId != null ? 'WORKER_BUSY' : 'WORKER_NOT_READY'), status: rec.status };
  }
  const updated = registry.transition(workerId, STATUS.ASSIGNED, {
    currentExecutionId: executionId,
    currentTaskId: taskId,
  });
  if (!updated || updated.error) return { ok: false, error: updated && updated.error, status: rec.status };
  return { ok: true, status: STATUS.ASSIGNED, worker: updated };
}

// 任务进入真正执行（ASSIGNED → RUNNING）。
function markRunning(workerId) {
  const rec = registry.get(workerId);
  if (!rec) return { ok: false, error: 'unknown worker' };
  const updated = registry.transition(workerId, STATUS.RUNNING);
  if (!updated || updated.error) return { ok: false, error: updated && updated.error, status: rec.status };
  return { ok: true, status: STATUS.RUNNING, worker: updated };
}

// 释放执行权（任务终态后）。RUNNING/ASSIGNED → READY（除非 DRAINING）。
// 返回 { ok, status }。
function release(workerId, success) {
  const rec = registry.get(workerId);
  if (!rec) return { ok: false, error: 'unknown worker' };
  if (success != null) registry.recordOutcome(workerId, !!success);
  // 释放执行权
  const after = registry.transition(workerId, STATUS.READY, {
    currentExecutionId: null, currentTaskId: null,
  });
  if (!after || after.error) {
    // 可能因当前为 DRAINING（优雅退出中）不允许直接回到 READY——保持 DRAINING，等 stopAfterDrain。
    return { ok: false, status: rec.status, note: 'transition blocked (likely DRAINING)', error: after && after.error };
  }
  return { ok: true, status: STATUS.READY, worker: after };
}

function list(filter) {
  return registry.list(filter).map((w) => Object.assign({}, w));
}

function get(workerId) {
  return registry.get(workerId);
}

module.exports = {
  startWorker, stopWorker, stopAfterDrain, assign, markRunning, release, list, get,
};
