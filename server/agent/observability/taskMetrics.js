'use strict';

// taskMetrics（Phase 4.6）：任务级运营指标。
// 数据源：aiTasks（createdAt/startedAt/status）、aiDispatchExecutions（queuedAt/startedAt/finishedAt）。
// 纯聚合，不写库；可直接对 store 查询，跨重启可追。

const store = require('../store');

function percentile(sortedNums, p) {
  if (!sortedNums.length) return null;
  const idx = Math.min(sortedNums.length - 1, Math.max(0, Math.ceil((p / 100) * sortedNums.length) - 1));
  return sortedNums[idx];
}

function compute() {
  const tasks = store.read('aiTasks', []);
  const total = tasks.length;
  const completed = tasks.filter((t) => t.status === 'COMPLETED' || t.status === 'SUCCESS').length;
  const failed = tasks.filter((t) => t.status === 'FAILED').length;
  const cancelled = tasks.filter((t) => t.status === 'CANCELLED').length;
  const pendingOrRunning = tasks.filter((t) =>
    ['PENDING', 'QUEUED', 'PLANNING', 'RUNNING', 'PREPARING', 'RECOVERING'].indexOf(t.status) >= 0).length;

  // latency：从 dispatch 记录取 startedAt→finishedAt（优先）；否则 createdAt→completedAt
  const dispatches = store.read('aiDispatchExecutions', []);
  const latencies = [];
  for (const d of dispatches) {
    if (d.startedAt && d.finishedAt) latencies.push(d.finishedAt - d.startedAt);
  }
  if (!latencies.length) {
    for (const t of tasks) {
      if (t.startedAt && (t.completedAt || t.finishedAt)) latencies.push((t.completedAt || t.finishedAt) - t.startedAt);
    }
  }
  const sorted = latencies.slice().sort((a, b) => a - b);

  return {
    total,
    completed,
    failed,
    cancelled,
    pendingOrRunning,
    successRate: total ? +(completed / total).toFixed(4) : null,
    failureRate: total ? +(failed / total).toFixed(4) : null,
    throughputPerMin: null, // 由时间窗聚合补充（见 aggregator）
    latency: {
      count: sorted.length,
      avg: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      min: sorted.length ? sorted[0] : null,
      max: sorted.length ? sorted[sorted.length - 1] : null,
    },
  };
}

module.exports = { compute, percentile };
