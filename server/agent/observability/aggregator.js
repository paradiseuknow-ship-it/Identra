'use strict';

// aggregator（Phase 4.6）：统一聚合 6 指标模块 + Trace，产出 Dashboard 快照。
// 所有数据从既有持久化集合聚合，无副作用。

const taskMetrics = require('./taskMetrics');
const queueMetrics = require('./queueMetrics');
const workerMetrics = require('./workerMetrics');
const resourceMetrics = require('./resourceMetrics');
const aiMetrics = require('./aiMetrics');
const recoveryMetrics = require('./recoveryMetrics');
const traceCollector = require('./traceCollector');
const deprecationMetrics = require('./deprecationMetrics');

function dashboard() {
  return {
    generatedAt: Date.now(),
    task: taskMetrics.compute(),
    queue: queueMetrics.compute(),
    worker: workerMetrics.compute(),
    resource: resourceMetrics.compute(),
    ai: aiMetrics.compute(),
    recovery: recoveryMetrics.compute(),
    deprecation: deprecationMetrics.snapshot(), // C44：遗留端点命中
  };
}

module.exports = {
  dashboard,
  taskMetrics, queueMetrics, workerMetrics, resourceMetrics, aiMetrics, recoveryMetrics,
  trace: traceCollector.trace,
};
