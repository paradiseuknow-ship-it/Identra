'use strict';

// Worker Heartbeat（Phase 4.2）。
// 职责边界（用户既定）：Heartbeat 只更新 aiWorkers.lastHeartbeat，
// **绝不写 execution**，避免「心跳污染执行记录」导致的恢复误判。
//
// 机制：
//  - 每次 ping：registry.heartbeat 更新 lastHeartbeat + currentExecutionId；
//  - 扫描：now - lastHeartbeat > TIMEOUT → 判定 DEAD（仅产出事件，不直接改 task）；
//  - DEAD 后由 Recovery 扫描其 RUNNING execution → RECOVERING。

const registry = require('./workerRegistry');
const { STATUS } = require('./workerState');

const DEFAULT_TIMEOUT_MS = 30000; // 30s 无心跳即判死亡

function ping(workerId, currentExecutionId) {
  const rec = registry.heartbeat(workerId, currentExecutionId);
  if (!rec) return { ok: false, error: 'unknown worker' };
  return { ok: true, workerId, lastHeartbeat: rec.lastHeartbeat, status: rec.status };
}

// 扫描所有非终态 Worker，返回「刚判定死亡」的列表（含 id / lastHeartbeat）。
// 不在本函数内修改业务状态——仅把 DEAD 落地到 aiWorkers 并产出事件，
// task / execution 的恢复交由 recovery 模块处理（见 executorPool.recovery）。
function scan(now, timeoutMs) {
  now = now || Date.now();
  timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS;
  // Phase 5.8 修复（Finding #1 接缝·Worker）：仅对「正在执行」的 Worker（ASSIGNED/RUNNING）做死亡判定。
  // 空闲 READY/STARTING 本就没有持续心跳（执行长任务才会由 scheduler 补 ping），误判 DEAD 会清空 capacity 造成饿死。
  const candidates = registry.list().filter((w) => w.status === STATUS.ASSIGNED || w.status === STATUS.RUNNING);
  const dead = [];
  for (const w of candidates) {
    if (now - (w.lastHeartbeat || 0) > timeoutMs) {
      // 落地 DEAD（带合法性校验：仅 STARTING/READY/ASSIGNED/RUNNING/PAUSED/DRAINING 可转 DEAD）
      const updated = registry.transition(w.id, STATUS.DEAD);
      if (updated && !updated.error) {
        dead.push({ workerId: w.id, lastHeartbeat: w.lastHeartbeat, now });
      }
    }
  }
  return dead;
}

module.exports = { ping, scan, DEFAULT_TIMEOUT_MS };
