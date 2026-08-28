'use strict';

// Observability 层入口（Phase 4.6）。
// 6 指标模块 + Trace + Aggregator。数据均从既有持久化集合聚合。

module.exports = {
  aggregator: require('./aggregator'),
  dashboard: require('./aggregator').dashboard,
  trace: require('./traceCollector').trace,
  taskMetrics: require('./taskMetrics'),
  queueMetrics: require('./queueMetrics'),
  workerMetrics: require('./workerMetrics'),
  resourceMetrics: require('./resourceMetrics'),
  aiMetrics: require('./aiMetrics'),
  recoveryMetrics: require('./recoveryMetrics'),
  traceCollector: require('./traceCollector'),
  observabilityEvent: require('./observabilityEvent'),
};
