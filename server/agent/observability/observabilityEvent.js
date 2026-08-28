'use strict';

// Observability 事件总线（Phase 4.6）。
// 轻量包装 events.emit，统一发出 observability.* 事件，供实时订阅/调试。
// 注意：所有**持久化指标与 Trace 均从既有存储集合聚合**（可跨重启、可追责），
// 本模块仅负责「实时事件通知」，不承载权威数据。

const events = require('../events');

const TYPES = [
  'observability.trace.stage',   // 任务某个阶段完成
  'observability.metrics.tick',  // 指标快照（可选周期广播）
];

function emitStage(taskId, stage, data) {
  events.emit({ type: 'observability.trace.stage', taskId, stage, payload: data || {} });
}

function emitMetricsTick(snapshot) {
  events.emit({ type: 'observability.metrics.tick', taskId: null, payload: snapshot || {} });
}

module.exports = { TYPES, emitStage, emitMetricsTick };
