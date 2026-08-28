'use strict';

// Intelligence Report：Phase 3.6 健康看板聚合。
// 返回 GET /intelligence/evaluation/report 的数据：
// {
//   "routerAccuracy": 0.87,
//   "llmReduction": 0.73,
//   "memoryROI": { "element": 0.91, "flow": 0.88, "failure": 0.76 },
//   "experiments": { ... },
//   "weakAreas": [ { "type":"flow", "site":"xxx", "reason":"prediction too optimistic" } ]
// }

const routerEvaluator = require('./routerEvaluator');
const memoryEvaluator = require('./memoryEvaluator');
const experiment = require('./experiment');
const { calibration } = require('./metricCalculator');

function buildReport(filter) {
  const records = routerEvaluator.listEvaluations(filter || {});
  const acc = routerEvaluator.routerAccuracy(records);
  const roi = memoryEvaluator.memoryROI(filter && filter.site);

  // LLM 节省：仅基于带 experiment 标记的记录（对照组 vs 实验组）
  let llmReduction = 0;
  const expLabels = experiment.listExperiments();
  if (expLabels.length) {
    const first = experiment.runExperiment(expLabels[0]);
    llmReduction = first.llmAvoidance ? first.llmAvoidance.rate : 0;
  } else {
    // 无实验：用 treatment 经验命中样本反推（requireLLM=false 视为省 LLM）
    const treatmentLike = records.filter((r) => (r.decision && r.decision.source !== 'PLANNER_LLM' && r.decision && r.decision.source !== 'ROUTER_FALLBACK'));
    const all = records.length || 1;
    llmReduction = Math.round((treatmentLike.length / all) * 1000) / 1000;
  }

  // 弱项：校准过度自信 + 应淘汰经验
  const weakAreas = [];
  const cal = calibration(records).filter((c) => c.status === 'OVER_CONFIDENT' && c.n >= 3);
  for (const c of cal) {
    weakAreas.push({ type: 'router_calibration', bucket: c.bucket, reason: 'prediction too optimistic', predicted: c.predicted, actual: c.actual });
  }
  const depProposals = memoryEvaluator.proposals(filter && filter.site)
    .filter((p) => p.type === 'MEMORY_DEPRECATE');
  for (const p of depProposals) {
    weakAreas.push({ type: p.memoryType, id: p.id, site: p.site, reason: 'low success rate, suggest deprecate' });
  }

  return {
    routerAccuracy: acc.accuracy,
    routerAccuracyN: acc.n,
    llmReduction,
    memoryROI: roi,
    experiments: expLabels.map((l) => experiment.runExperiment(l)),
    weakAreas,
    generatedAt: Date.now(),
  };
}

module.exports = { buildReport };
