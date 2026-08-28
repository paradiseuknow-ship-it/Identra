'use strict';

// Evaluation Collector：Phase 3.6 收集一次决策结果。
// 接入点：Runtime 在 Task SUCCESS / FAILED 时调用 collect()。
// 收集：使用了哪个经验（source/strategy/confidence）、预测成功率、是否成功、是否 repair、是否调 LLM。
// 落 aiIntelligenceEvaluations；不直接改 Memory（调整由 evaluator 提案）。

const store = require('../../store');
const { COLLECTION, buildRecord, validateRecord } = require('./evaluationSchema');

// input:
// {
//   taskId, site,
//   decision: { source, strategy, confidence },   // 来自 router.decide().decision 或 task 实际走的路径
//   prediction: { expectedSuccess },              // router 给出的预计成功率
//   actual: { success, durationMs, llmCalls, repairCount },
//   experiment: { group:'control'|'treatment', label }  // 可选，A/B 用
// }
function collect(input) {
  input = input || {};
  const rec = buildRecord(input);
  const v = validateRecord(rec);
  if (!v.ok) return { ok: false, error: v.errors.join('; '), record: null };
  // 写入实验标记
  if (input.experiment) rec.experiment = input.experiment;
  store.insert(COLLECTION, rec);
  return { ok: true, record: rec };
}

function list(filter) {
  let arr = store.read(COLLECTION, []);
  if (filter && filter.site) arr = arr.filter((r) => r.site === filter.site);
  if (filter && filter.taskId) arr = arr.filter((r) => r.taskId === filter.taskId);
  return arr;
}

function clear() {
  store.write(COLLECTION, []);
}

module.exports = { collect, list, clear, COLLECTION };
