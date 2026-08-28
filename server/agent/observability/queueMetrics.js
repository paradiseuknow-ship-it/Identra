'use strict';

// queueMetrics（Phase 4.6）：队列与调度等待指标。
// 数据源：aiDispatchExecutions（queuedAt/scheduledAt/assignedAt/startedAt/status）。
// 关注：queue depth、waiting time、dispatch latency、starvation（低优先级等待过久）。

const store = require('../store');
const { CATEGORIES } = require('../execution/scheduler');

function compute() {
  const dispatches = store.read('aiDispatchExecutions', []);
  const now = Date.now();

  const queued = dispatches.filter((d) => d.status === 'QUEUED' || d.status === 'SCHEDULED').length;
  const assigned = dispatches.filter((d) => d.status === 'ASSIGNED').length;
  const started = dispatches.filter((d) => d.status === 'STARTED').length;
  const terminal = dispatches.filter((d) =>
    ['COMPLETED', 'FAILED', 'CANCELLED', 'RECOVERING'].indexOf(d.status) >= 0).length;

  // waiting time：queuedAt → startedAt
  const waits = [];
  for (const d of dispatches) {
    if (d.queuedAt && d.startedAt) waits.push(d.startedAt - d.queuedAt);
  }
  const dispatchLatencies = [];
  for (const d of dispatches) {
    if (d.scheduledAt && d.assignedAt) dispatchLatencies.push(d.assignedAt - d.scheduledAt);
  }

  // starvation：仍 QUEUED/SCHEDULED 且等待超过阈值（默认 60s）的低优先级项
  const STARVE_MS = 60000;
  const starving = dispatches.filter((d) =>
    (d.status === 'QUEUED' || d.status === 'SCHEDULED') &&
    d.queuedAt && (now - d.queuedAt) > STARVE_MS).length;

  return {
    depth: queued,            // 当前还在排队的数量
    assigned,
    started,
    terminal,
    total: dispatches.length,
    waitingTime: {
      count: waits.length,
      avg: waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : null,
      max: waits.length ? Math.max.apply(null, waits) : null,
    },
    dispatchLatency: {
      count: dispatchLatencies.length,
      avg: dispatchLatencies.length ? Math.round(dispatchLatencies.reduce((a, b) => a + b, 0) / dispatchLatencies.length) : null,
    },
    starvation: { thresholdMs: STARVE_MS, count: starving },
    categories: CATEGORIES,
  };
}

module.exports = { compute, CATEGORIES };
