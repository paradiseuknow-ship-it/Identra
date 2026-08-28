'use strict';

// Router Evaluator：Phase 3.6 评估 Router 预测质量。
//  - 按 decision.source 统计：准确率、平均预测、平均实际成功率；
//  - 校准：调用 metricCalculator.calibration；
//  - 降权提案：某 source/site 在某 bucket 持续「过度自信」时，产出 Memory Adjustment Proposal
//    （仅提案，不直接改 Memory）。

const { calibration } = require('./metricCalculator');
const store = require('../../store');
const { COLLECTION, buildRecord } = require('./evaluationSchema');

// 读全部评估记录（可按 site 过滤）。
function listEvaluations(filter) {
  let arr = store.read(COLLECTION, []);
  if (filter && filter.site) arr = arr.filter((r) => r.site === filter.site);
  if (filter && filter.source) arr = arr.filter((r) => r.decision && r.decision.source === filter.source);
  return arr;
}

// 按 decision.source 聚合准确率。
function accuracyBySource(records) {
  const map = {};
  for (const r of records) {
    const s = (r.decision && r.decision.source) || 'UNKNOWN';
    if (!map[s]) map[s] = { source: s, n: 0, accurate: 0, predictedSum: 0, actualSuccess: 0 };
    const cell = map[s];
    cell.n += 1;
    cell.predictedSum += r.prediction.expectedSuccess;
    cell.actualSuccess += r.actual.success ? 1 : 0;
    // accuracy>=0.5 视为「预测足够接近结果」（误差<=0.5）
    if (r.metrics && r.metrics.accuracy >= 0.5) cell.accurate += 1;
  }
  return Object.keys(map).map((s) => {
    const c = map[s];
    return {
      source: s,
      n: c.n,
      accuracy: Math.round((c.accurate / c.n) * 1000) / 1000,
      avgPredicted: Math.round((c.predictedSum / c.n) * 1000) / 1000,
      actualSuccessRate: Math.round((c.actualSuccess / c.n) * 1000) / 1000,
    };
  });
}

// 整体 Router 准确率（所有评估记录加权）。
function routerAccuracy(records) {
  if (!records.length) return { accuracy: 0, n: 0 };
  const acc = records.reduce((a, r) => a + (r.metrics && r.metrics.accuracy || 0), 0) / records.length;
  return { accuracy: Math.round(acc * 1000) / 1000, n: records.length };
}

// 校准驱动的降权提案：
//  - 找出 status=OVER_CONFIDENT 的 bucket；
//  - 对出现过度自信的 source 产出 proposal（weight 调整建议）。
// 返回 proposal 列表（含 source、site、建议调整幅度、理由）。
function downweightProposals(records, filter) {
  const cal = calibration(records);
  const over = cal.filter((c) => c.status === 'OVER_CONFIDENT' && c.n >= 3);
  if (!over.length) return [];
  const proposals = [];
  for (const cell of over) {
    // 找出该 bucket 内命中失败的记录，定位主要 source
    const inBucket = records.filter((r) => {
      const b = require('./evaluationSchema').confidenceBucket(r.prediction.expectedSuccess);
      return b === cell.bucket && !r.actual.success;
    });
    const bySource = {};
    for (const r of inBucket) {
      const s = (r.decision && r.decision.source) || 'UNKNOWN';
      bySource[s] = (bySource[s] || 0) + 1;
    }
    const topSource = Object.keys(bySource).sort((a, b) => bySource[b] - bySource[a])[0];
    const site = filter && filter.site ? filter.site : (inBucket[0] && inBucket[0].site);
    const adjust = Math.round(Math.max(0.05, Math.min(0.3, cell.gap)) * 1000) / 1000; // 建议降权幅度
    proposals.push({
      type: 'CONFIDENCE_DOWNGRADE',
      target: topSource,
      site,
      bucket: cell.bucket,
      predicted: cell.predicted,
      actual: cell.actual,
      gap: cell.gap,
      suggestedWeightDelta: -adjust,
      reason: `预测过于乐观（预测 ${Math.round(cell.predicted * 100)}% vs 实际 ${Math.round(cell.actual * 100)}%），建议降低该来源置信度权重 ${Math.round(adjust * 100)}%`,
      createdAt: Date.now(),
    });
  }
  return proposals;
}

module.exports = { listEvaluations, accuracyBySource, routerAccuracy, downweightProposals, buildRecord };
