'use strict';

// Agent Score（Phase 5 Task 3）：从单次任务的可观测指标计算五项能力分 + 总分。
//
// 输入（由 benchmark runner 从 store 聚合，不修改核心逻辑）：
//   {
//     taskId, status, error,
//     startedAt, finishedAt,
//     steps:    [{ status, hasVerification }],          // 每步是否具备验证
//     attempts: [{ status, isError }],                   // 所有 attempt（含重试）
//     retries:  number,                                  // 'agent.retrying' 事件数（确定性恢复）
//     repairs:  number,                                  // aiRepairAttempts 数（AI 修复编排）
//     escalated: boolean                                 // 终态是否为 HUMAN_ESCALATION
//   }
//
// 五项分（0~100）：
//   Planning   计划是否生成可执行（steps>0）
//   Execution  动作首次/总体成功率
//   Recovery   失败步骤中被恢复成功的占比
//   Verification 具备验证的步骤中通过占比
//   Autonomy   是否无需人工介入
// overall = 加权（planning .20 / execution .25 / recovery .20 / verification .20 / autonomy .15）
//
// 原则：纯读数聚合；不修改 runtime / planner / provider；不伪造成功。

const WEIGHTS = { planning: 0.20, execution: 0.25, recovery: 0.20, verification: 0.20, autonomy: 0.15 };

function clamp(n) { return Math.max(0, Math.min(100, Math.round(Number(n) || 0))); }

function scorePlanning(m) {
  // 计划生成：steps>0 即 Planner 产出可执行计划
  return m.steps && m.steps.length > 0 ? 100 : 0;
}

function scoreExecution(m) {
  const atts = m.attempts || [];
  if (!atts.length) return m.status === 'SUCCESS' ? 100 : 0;
  const ok = atts.filter((a) => !a.isError).length;
  return clamp((100 * ok) / atts.length);
}

function scoreRecovery(m) {
  const steps = m.steps || [];
  const failedSteps = steps.filter((s) => (m.attempts || []).some((a) => a.isError && a.stepId === s.id) || s.status === 'FAILED' || s.status === 'HEALING');
  if (!failedSteps.length) return 100; // 无失败，无需恢复
  const recovered = failedSteps.filter((s) => s.status === 'SUCCESS').length;
  return clamp((100 * recovered) / failedSteps.length);
}

function scoreVerification(m) {
  const steps = m.steps || [];
  const withV = steps.filter((s) => s.hasVerification);
  if (!withV.length) return 100;
  const passed = withV.filter((s) => s.status === 'SUCCESS').length;
  return clamp((100 * passed) / withV.length);
}

function scoreAutonomy(m) {
  // 任何需要人工介入（HUMAN_ESCALATION）即计 0；其余（含自主失败）计 100
  return m.escalated ? 0 : 100;
}

function compute(m) {
  const planning = scorePlanning(m);
  const execution = scoreExecution(m);
  const recovery = scoreRecovery(m);
  const verification = scoreVerification(m);
  const autonomy = scoreAutonomy(m);
  const overall = clamp(
    planning * WEIGHTS.planning +
    execution * WEIGHTS.execution +
    recovery * WEIGHTS.recovery +
    verification * WEIGHTS.verification +
    autonomy * WEIGHTS.autonomy
  );
  return { planning, execution, recovery, verification, autonomy, overall, weights: WEIGHTS };
}

// 跨任务聚合：对每项分取均值，再用均值计算总体分（与单任务口径一致）。
function aggregate(scores) {
  if (!scores.length) {
    return { planning: 0, execution: 0, recovery: 0, verification: 0, autonomy: 0, overall: 0, sampleSize: 0 };
  }
  const keys = ['planning', 'execution', 'recovery', 'verification', 'autonomy'];
  const acc = {};
  keys.forEach((k) => { acc[k] = clamp(scores.reduce((a, s) => a + s[k], 0) / scores.length); });
  const overall = clamp(
    acc.planning * WEIGHTS.planning + acc.execution * WEIGHTS.execution +
    acc.recovery * WEIGHTS.recovery + acc.verification * WEIGHTS.verification + acc.autonomy * WEIGHTS.autonomy
  );
  return Object.assign(acc, { overall, sampleSize: scores.length });
}

module.exports = { compute, aggregate, WEIGHTS, scorePlanning, scoreExecution, scoreRecovery, scoreVerification, scoreAutonomy };
