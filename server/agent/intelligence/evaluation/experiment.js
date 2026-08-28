'use strict';

// Experiment：Phase 3.6 A/B 实验支持。
// Control：旧流程 Parser → Planner LLM → Execute（每次都调 LLM）。
// Treatment：新流程 Parser → Router → Memory → Planner fallback（经验命中则跳过 LLM）。
// 通过评估记录上的「实验标记」区分两组，计算对照指标。
//
// 评估记录在 collect() 时可带 { experiment:{ group:'control'|'treatment', label } }。
// 本模块只做聚合与对照，不干预分流（分流由上层 taskManager / runtime 决定）。

const store = require('../../store');
const { COLLECTION } = require('./evaluationSchema');
const { abSummary, successRetention, llmAvoidanceRate } = require('./metricCalculator');

// 取某实验下的两组记录。
function groups(label) {
  const all = store.read(COLLECTION, [])
    .filter((r) => r.experiment && r.experiment.label === label);
  const control = all.filter((r) => r.experiment.group === 'control');
  const treatment = all.filter((r) => r.experiment.group === 'treatment');
  return { control, treatment };
}

// 实验结果：对照表 + 是否 Router 胜出。
function runExperiment(label) {
  const { control, treatment } = groups(label);
  const summary = abSummary(control, treatment);
  const retention = successRetention(control, treatment);
  const llm = llmAvoidanceRate(control, treatment);
  return {
    label,
    controlTasks: control.length,
    treatmentTasks: treatment.length,
    summary,
    successRetention: retention,
    llmAvoidance: llm,
    routerWins: summary.routerWins,
    conclusion: summary.routerWins
      ? 'Experience Router 优于传统 Agent（成功率不降且 LLM 调用更少）'
      : 'Router 尚未证明优于 Control，需更多样本或调参',
  };
}

// 列出进行中的实验 label。
function listExperiments() {
  const all = store.read(COLLECTION, []);
  const set = {};
  for (const r of all) {
    if (r.experiment && r.experiment.label) set[r.experiment.label] = true;
  }
  return Object.keys(set);
}

module.exports = { groups, runExperiment, listExperiments, abSummary };
