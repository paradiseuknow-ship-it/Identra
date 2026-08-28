'use strict';

// Evaluator：Phase 3.6 统一入口。
// 串联：collect(落库) → 计算指标 → 产出 Memory Adjustment Proposals。
// 关键约束：本层**永不**直接改写 Memory（element/flow/failure/site），
// 所有置信度调整以「proposal」形式输出，由人工 / 周期任务审批后落地。

const collector = require('./evaluationCollector');
const routerEvaluator = require('./routerEvaluator');
const memoryEvaluator = require('./memoryEvaluator');
const { buildReport } = require('./intelligenceReport');
const { experienceGainScore } = require('./metricCalculator');

// Task 完成时调用：收集一次结果 + 产出提案。
// input 同 evaluationCollector.collect。
function evaluateTask(input) {
  const c = collector.collect(input);
  if (!c.ok) return c;
  const record = c.record;
  // 基于当前全量评估（可按 site 过滤）产出提案
  const proposals = aggregateProposals({ site: record.site });
  return {
    ok: true,
    record,
    proposals,
  };
}

// 聚合当前所有提案（Router 降权 + Memory 调整）。
function aggregateProposals(filter) {
  const records = routerEvaluator.listEvaluations(filter || {});
  const routerProps = routerEvaluator.downweightProposals(records, filter || {});
  const memProps = memoryEvaluator.proposals(filter && filter.site);
  return { router: routerProps, memory: memProps, total: routerProps.length + memProps.length };
}

// 健康看板。
function report(filter) {
  return buildReport(filter);
}

// 经验增益综合分（供看板/报告调用）。
function gainScore(parts) {
  return experienceGainScore(parts);
}

module.exports = {
  collect: collector.collect,
  evaluateTask,
  aggregateProposals,
  report,
  gainScore,
  // 子模块透出，方便测试与上层调用
  routerEvaluator, memoryEvaluator, collector, router: require('./routerEvaluator'),
};
