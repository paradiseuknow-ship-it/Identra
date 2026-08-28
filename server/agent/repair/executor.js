'use strict';

// Repair Executor：执行 Repair Plan（受控，不绕过 Runtime/Policy/Verification）。
// 每个 Repair 产生独立 RepairAttempt + 新 Action Attempt（原始 Attempt 保留）。
// 所有浏览器操作仍经 tools（Policy + Lock + Recorder）。

const tools = require('../tools');
const stepManager = require('../stepManager');
const events = require('../events');
const verification = require('../verification');
const repairAttempts = require('./repairAttempts');

const STRATEGY_MODS = {
  elementChanged: require('./strategies/elementChanged'),
  timeout: require('./strategies/timeout'),
  obstruction: require('./strategies/obstruction'),
  navigation: require('./strategies/navigation'),
  sessionExpired: require('./strategies/sessionExpired'),
  verifyFailed: require('./strategies/verifyFailed'),
  generic: require('./strategies/generic'),
};

async function executePlan({ task, step, plan, ctx, repairAttemptId }) {
  const _diagId = repairAttemptId || (process.env.E3_1_DIAG === '1' ? 'RA_orphan_' + Date.now().toString(36) : null);
  if (_diagId) console.warn('[E3.1-DIAG] EXECUTOR_ENTER', JSON.stringify({ repairAttemptId: _diagId, taskId: task.id, stepId: step.id, strategyType: plan.strategyType }));
  // 1) RepairAttempt 生命周期（PENDING → RUNNING → SUCCESS/FAILED）
  const repairAttempt = repairAttempts.create({
    taskId: task.id, stepId: step.id, diagnosisId: plan.diagnosisId,
    strategy: plan.strategy, strategyType: plan.strategyType, risk: plan.risk, confidence: plan.confidence,
  });
  repairAttempts.update(repairAttempt.id, { status: 'RUNNING' });
  events.emit({ taskId: task.id, executionId: task.currentExecutionId, stepId: step.id, type: 'agent.repairing', payload: { repairId: repairAttempt.repairId, strategy: plan.strategy } });

  // 2) 每个修复动作 = 新 Action Attempt（经 tools 全链路）
  let lastRes = { observation: null };
  let beforeObs = null; // v0.2.1：修复动作执行前的观察，作为验证 before（修复 before=null 缺陷）
  const runAction = async (action) => {
    const attempt = stepManager.createAttempt(step.id, task.currentExecutionId, action);
    if (_diagId) console.warn('[E3.1-DIAG] EXEC_RUN_ACTION_ENTER', JSON.stringify({ repairAttemptId: _diagId, taskId: task.id, stepId: step.id, actionType: action && action.type, target: (action && action.target && (action.target.semantic || action.target.field || action.target.url)) || null }));
    let res;
    try {
      res = await tools.execute({ action, taskId: task.id, executionId: task.currentExecutionId, stepId: step.id, attemptId: attempt.id });
    } catch (e) {
      res = { success: false, error: { code: 'TOOL_EXECUTION', message: String(e.message || e).slice(0, 200) } };
    }
    if (_diagId) console.warn('[E3.1-DIAG] EXEC_RUN_ACTION_RETURN', JSON.stringify({ repairAttemptId: _diagId, taskId: task.id, stepId: step.id, actionType: action && action.type, success: !!(res && res.success), code: res && res.error && res.error.code }));
    if (res && res.success) stepManager.succeedAttempt(attempt.id);
    else stepManager.failAttempt(attempt.id, (res && res.error) || { code: 'UNKNOWN', message: '修复动作失败' });
    beforeObs = lastRes.observation || beforeObs; // 记录上一次观察作为下次的 before
    lastRes = res || lastRes;
    return res || { success: false, error: { code: 'UNKNOWN', message: '未知' } };
  };

  // 3) 执行策略（策略内已含 inspect / semantic_resolve / wait / reload / dismiss 等）
  const strat = STRATEGY_MODS[plan.strategyType] || STRATEGY_MODS.generic;
  let out = { ok: false, actions: [], needsApproval: false };
  try {
    out = await strat.execute({ task, step, ctx: { runAction, taskId: task.id, executionId: task.currentExecutionId, error: (ctx && ctx.error) || null } });
  } catch (e) {
    out = { ok: false, actions: [{ tool: 'error', ok: false, error: String(e.message || e).slice(0, 200) }] };
  }

  // 4) 验证门：修复动作成功 ≠ 修复成功；仍须通过 Step Verification（与 Runtime 同标准）
  if (out.ok && step.verification && step.verification.type !== 'none') {
    const vres = verification.verify(step.verification, lastRes.observation, beforeObs);
    out.actions.push({ tool: 'verify', ok: vres.success, evidence: vres.evidence.slice(0, 3) });
    if (!vres.success) out.ok = false;
  }

  // 4) 结束 RepairAttempt
  repairAttempts.update(repairAttempt.id, {
    status: out.ok ? 'SUCCESS' : 'FAILED',
    actions: out.actions || [],
    verification: plan.verification,
    error: out.ok ? null : (out.error || (out.needsApproval ? '需要人工处理' : '修复失败')),
    finishedAt: Date.now(),
  });

  if (out.ok) stepManager.setStepState(step.id, 'SUCCESS');
  events.emit({ taskId: task.id, executionId: task.currentExecutionId, stepId: step.id, type: out.ok ? 'agent.recovered' : 'agent.repairing', payload: { repairId: repairAttempt.repairId, ok: out.ok } });
  if (_diagId) console.warn('[E3.1-DIAG] EXECUTOR_RETURN', JSON.stringify({ repairAttemptId: _diagId, taskId: task.id, stepId: step.id, ok: out.ok, needsApproval: !!out.needsApproval }));
  return { ok: out.ok, needsApproval: !!out.needsApproval, repairAttempt: repairAttempts.get(repairAttempt.id) };
}

module.exports = { executePlan };
