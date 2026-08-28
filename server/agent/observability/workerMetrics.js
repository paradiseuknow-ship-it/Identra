'use strict';

// workerMetrics（Phase 4.6）：Worker 生命周期与利用率指标。
// 数据源：aiWorkers（status/createdAt/lastHeartbeat/startedAt/runStartedAt）、aiDispatchExecutions（workerId/startedAt/finishedAt）。
// 关注：utilization、busy time、idle time、DEAD 次数、recovery 次数。

const store = require('../store');
const { STATUS } = require('../execution/workerState');

function compute() {
  const workers = store.read('aiWorkers', []);
  const dispatches = store.read('aiDispatchExecutions', []);
  const now = Date.now();

  const byStatus = {};
  for (const w of workers) byStatus[w.status] = (byStatus[w.status] || 0) + 1;

  const dead = workers.filter((w) => w.status === STATUS.DEAD).length;
  const running = workers.filter((w) => w.status === STATUS.RUNNING).length;
  const ready = workers.filter((w) => w.status === STATUS.READY).length;

  // busy time：从 dispatch 记录聚合每 worker 的 RUNNING 时长
  const busyMap = {};
  for (const d of dispatches) {
    if (d.workerId && d.startedAt && d.finishedAt) {
      busyMap[d.workerId] = (busyMap[d.workerId] || 0) + (d.finishedAt - d.startedAt);
    }
  }
  const busyTimes = Object.values(busyMap);
  const totalBusy = busyTimes.reduce((a, b) => a + b, 0);
  // idle time：worker 存在时长 - busy（近似；单 worker 场景足够）
  const totalLifetime = workers.reduce((a, w) => a + ((w.lastHeartbeat || now) - (w.createdAt || w.startedAt || now)), 0);

  // recovery 次数：dispatch 状态 RECOVERING 或 worker 曾 DEAD 后恢复（以 RECOVERING 计数）
  const recovery = dispatches.filter((d) => d.status === 'RECOVERING').length;

  return {
    total: workers.length,
    byStatus,
    dead,
    running,
    ready,
    utilization: totalLifetime ? +(totalBusy / totalLifetime).toFixed(4) : null,
    busyTimeMs: totalBusy,
    idleTimeMs: Math.max(0, totalLifetime - totalBusy),
    recoveryCount: recovery,
    STATUS,
  };
}

module.exports = { compute };
