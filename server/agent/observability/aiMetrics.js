'use strict';

// aiMetrics（Phase 4.6）：Intelligence ROI 核心指标。
// 数据源：aiIntelligenceEvaluations（decision.source / actual.llmCalls / actual.repairCount / actual.success / metrics.accuracy）。
// 这是本项目区别于普通 Browser Automation 的关键：证明 Memory/Router 减少了 LLM 消耗。

const store = require('../store');
const { DECISION_SOURCES } = require('../intelligence/evaluation/evaluationSchema');

// Memory 驱动的决策来源（非 LLM Planner）
const MEMORY_SOURCES = ['FLOW_MEMORY', 'PROFILE_MEMORY', 'ELEMENT_MEMORY', 'FAILURE_MEMORY', 'SITE_MEMORY'];
const LLM_SOURCE = 'PLANNER_LLM';

function compute() {
  const evals = store.read('aiIntelligenceEvaluations', []);
  const total = evals.length;
  if (!total) {
    return { total: 0, llmAvoidanceRate: null, memoryHitRate: null, routerAccuracy: null,
      repairSuccessRate: null, llmCallsTotal: 0, costPerSuccessfulTask: null, sourceBreakdown: {} };
  }

  let memoryHits = 0, llmSource = 0, llmCallsTotal = 0, successTotal = 0, repairTasks = 0, repairSuccess = 0;
  let accuracySum = 0;
  const sourceBreakdown = {};
  for (const e of evals) {
    const src = (e.decision && e.decision.source) || 'ROUTER_FALLBACK';
    sourceBreakdown[src] = (sourceBreakdown[src] || 0) + 1;
    if (MEMORY_SOURCES.indexOf(src) >= 0) memoryHits += 1;
    if (src === LLM_SOURCE) llmSource += 1;
    const actual = e.actual || {};
    llmCallsTotal += (actual.llmCalls || 0);
    if (actual.success) { successTotal += 1; if ((actual.repairCount || 0) > 0) repairSuccess += 1; }
    if ((actual.repairCount || 0) > 0) repairTasks += 1;
    if (e.metrics && typeof e.metrics.accuracy === 'number') accuracySum += e.metrics.accuracy;
  }

  return {
    total,
    sourceBreakdown,
    llmAvoidanceRate: +((total - llmSource) / total).toFixed(4), // 未走 PLANNER_LLM 的比例
    memoryHitRate: +(memoryHits / total).toFixed(4),
    routerAccuracy: +(accuracySum / total).toFixed(4),
    repairSuccessRate: repairTasks ? +(repairSuccess / repairTasks).toFixed(4) : null,
    llmCallsTotal,
    costPerSuccessfulTask: successTotal ? +(llmCallsTotal / successTotal).toFixed(4) : null,
    MEMORY_SOURCES,
    LLM_SOURCE,
  };
}

module.exports = { compute, MEMORY_SOURCES, LLM_SOURCE };
