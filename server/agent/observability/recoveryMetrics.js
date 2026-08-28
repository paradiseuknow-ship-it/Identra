'use strict';

// recoveryMetrics（Phase 4.6）：恢复与修复指标。
// 数据源：aiRepairAttempts（status/createdAt/finishedAt/taskId）、aiDispatchExecutions（RECOVERING）。
// 关注：recovery rate、repair success、retry count、human escalation。

const store = require('../store');

function compute() {
  const repairs = store.read('aiRepairAttempts', []);
  const dispatches = store.read('aiDispatchExecutions', []);

  const total = repairs.length;
  const success = repairs.filter((r) => r.status === 'SUCCESS').length;
  const failed = repairs.filter((r) => r.status === 'FAILED').length;
  const pending = repairs.filter((r) => r.status === 'PENDING' || r.status === 'RUNNING').length;

  // retry count：按 taskId 聚合 repair 次数
  const byTask = {};
  for (const r of repairs) { if (r.taskId) byTask[r.taskId] = (byTask[r.taskId] || 0) + 1; }
  const retryCounts = Object.values(byTask);
  const tasksWithRetry = retryCounts.filter((c) => c > 1).length;
  const maxRetries = retryCounts.length ? Math.max.apply(null, retryCounts) : 0;

  // human escalation：repair FAILED 且标记需人工，或从事件流 detect（此处以 FAILED + risk=HIGH 近似）
  const humanEscalation = repairs.filter((r) => r.status === 'FAILED' && (r.risk === 'HIGH' || r.risk === 'CRITICAL')).length;

  // recovery（dispatch RECOVERING）：从调度层恢复
  const recovering = dispatches.filter((d) => d.status === 'RECOVERING').length;

  return {
    repair: { total, success, failed, pending, successRate: total ? +(success / total).toFixed(4) : null },
    retry: { tasksWithRetry, maxRetries, avg: retryCounts.length ? +(retryCounts.reduce((a, b) => a + b, 0) / retryCounts.length).toFixed(2) : 0 },
    humanEscalation,
    recoveringDispatches: recovering,
    recoveryRate: (success + failed) ? +(success / (success + failed)).toFixed(4) : null,
  };
}

module.exports = { compute };
