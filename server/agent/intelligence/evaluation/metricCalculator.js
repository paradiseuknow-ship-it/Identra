'use strict';

// Metric Calculator：Phase 3.6 指标计算核心。
// 纯函数，输入评估记录列表 / 对照样本，输出：
//  - calibration：confidence bucket 校准（预测 vs 实际）
//  - llmAvoidanceRate：Router 相对纯 Planner 节省的 LLM 调用比例
//  - successRetention：LLM 节省是否换来了成功率下降
//  - experienceGainScore：经验增益综合分
//  - abSummary：A/B 实验对照指标

const { confidenceBucket } = require('./evaluationSchema');

// ---------- 校准 ----------
// 输入 records（评估记录数组）。返回每个 bucket 的预测均值、实际成功率、样本数、状态。
function calibration(records) {
  const buckets = {};
  for (const r of records) {
    const b = confidenceBucket(r.prediction.expectedSuccess);
    if (!buckets[b]) buckets[b] = { bucket: b, predicted: 0, actualSuccess: 0, n: 0 };
    const cell = buckets[b];
    cell.predicted += r.prediction.expectedSuccess;
    cell.actualSuccess += r.actual.success ? 1 : 0;
    cell.n += 1;
  }
  return Object.keys(buckets).sort().map((b) => {
    const cell = buckets[b];
    const predicted = Math.round((cell.predicted / cell.n) * 1000) / 1000;
    const actual = Math.round((cell.actualSuccess / cell.n) * 1000) / 1000;
    const gap = Math.round((predicted - actual) * 1000) / 1000;
    let status = 'GOOD';
    if (gap >= 0.15) status = 'OVER_CONFIDENT';      // 预测过高 → 应降权
    else if (gap <= -0.15) status = 'UNDER_CONFIDENT'; // 预测过低 → 可提权
    return { bucket: b, predicted, actual, n: cell.n, gap, status };
  });
}

// ---------- LLM 节省率 ----------
// 输入两类样本：
//  control：纯 Planner（每次都调 LLM，planner + diagnosis）
//  treatment：Router 路径（经验命中则 planner=0, diagnosis=0）
// 返回节省比例 0~1（1 = 完全不调 LLM）。
function llmAvoidanceRate(control, treatment) {
  const sumLLM = (arr) => arr.reduce((a, r) => a + ((r.actual && r.actual.llmCalls) || 0), 0);
  const cTot = sumLLM(control);
  const tTot = sumLLM(treatment);
  const cN = Math.max(1, control.length);
  const tN = Math.max(1, treatment.length);
  const cPer = cTot / cN; // 对照组平均每次 LLM 调用
  const tPer = tTot / tN; // 实验组平均每次 LLM 调用
  if (cPer <= 0) return { rate: 0, controlPerTask: cPer, treatmentPerTask: tPer, note: 'no control baseline' };
  const rate = Math.round((1 - tPer / cPer) * 1000) / 1000;
  return { rate: Math.max(0, rate), controlPerTask: Math.round(cPer * 1000) / 1000, treatmentPerTask: Math.round(tPer * 1000) / 1000 };
}

// ---------- 成功率保持率 ----------
// 实验组成功率 vs 对照组成功率 → 是否用 LLM 节省换来了成功率下降。
function successRetention(control, treatment) {
  const rate = (arr) => {
    if (!arr.length) return null;
    return arr.filter((r) => r.actual && r.actual.success).length / arr.length;
  };
  const c = rate(control), t = rate(treatment);
  if (c == null || t == null) return { controlRate: c, treatmentRate: t, retained: true, delta: 0 };
  const delta = Math.round((t - c) * 1000) / 1000;
  return {
    controlRate: Math.round(c * 1000) / 1000,
    treatmentRate: Math.round(t * 1000) / 1000,
    delta,
    retained: t >= c - 0.05, // 允许 ±5% 浮动，不视为显著下降
  };
}

// ---------- 经验增益综合分（Experience Gain Score）----------
// 公式：successRateImprovement + llmCostReduction + timeReduction - falsePositivePenalty
//  各分量均归一 0~1，最终裁剪到 [-1, 1]。
function experienceGainScore({ successRateImprovement = 0, llmCostReduction = 0, timeReduction = 0, falsePositivePenalty = 0 } = {}) {
  const raw = successRateImprovement + llmCostReduction + timeReduction - falsePositivePenalty;
  return Math.round(Math.max(-1, Math.min(1, raw)) * 1000) / 1000;
}

// ---------- A/B 汇总 ----------
// 输入 control / treatment 评估记录数组。输出对照表。
function abSummary(control, treatment) {
  const succ = (arr) => arr.filter((r) => r.actual && r.actual.success).length / Math.max(1, arr.length);
  const avg = (arr, f) => arr.reduce((a, r) => a + (f(r) || 0), 0) / Math.max(1, arr.length);
  const c = {
    tasks: control.length,
    successRate: Math.round(succ(control) * 1000) / 1000,
    avgLlmCalls: Math.round(avg(control, (r) => r.actual && r.actual.llmCalls) * 1000) / 1000,
    avgDurationMs: Math.round(avg(control, (r) => r.actual && r.actual.durationMs)),
    avgRepairCount: Math.round(avg(control, (r) => r.actual && r.actual.repairCount) * 1000) / 1000,
  };
  const t = {
    tasks: treatment.length,
    successRate: Math.round(succ(treatment) * 1000) / 1000,
    avgLlmCalls: Math.round(avg(treatment, (r) => r.actual && r.actual.llmCalls) * 1000) / 1000,
    avgDurationMs: Math.round(avg(treatment, (r) => r.actual && r.actual.durationMs)),
    avgRepairCount: Math.round(avg(treatment, (r) => r.actual && r.actual.repairCount) * 1000) / 1000,
  };
  const wins = t.successRate > c.successRate && t.avgLlmCalls <= c.avgLlmCalls;
  return {
    control: c,
    treatment: t,
    routerWins: wins,
    llmReductionPct: c.avgLlmCalls > 0 ? Math.round((1 - t.avgLlmCalls / c.avgLlmCalls) * 1000) / 1000 : 0,
    successDelta: Math.round((t.successRate - c.successRate) * 1000) / 1000,
  };
}

module.exports = {
  calibration, llmAvoidanceRate, successRetention, experienceGainScore, abSummary,
};
