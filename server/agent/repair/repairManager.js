'use strict';

// Repair Manager：Step 修复编排（Phase 2.3）。
// FailureSnapshot → Diagnosis → RepairPlanner → RepairSchema → RepairPolicy → Executor → Verification。
// AI 只规划修复，执行仍走 Runtime/Tools/Policy/Verification。
// 修复尝试有界（maxRepairAttempts=3），耗尽后 PAUSED_FOR_HUMAN，杜绝无限循环。

const events = require('../events');
const store = require('../store');
const taskManager = require('../taskManager');
const diagnosisEngine = require('../diagnosis/diagnosisEngine');
const errorClassifier = require('../recovery/errorClassifier');
const failureSnapshot = require('../recovery/failureSnapshot');
const failureAdvisor = require('../intelligence/failure/failureAdvisor');
const failureCollector = require('../intelligence/failure/failureCollector');
const repairPlanner = require('./repairPlanner');
const repairPolicy = require('./repairPolicy');
const executor = require('./executor');
const repairAttempts = require('./repairAttempts');

function siteOf(url) {
  if (!url) return null;
  try { return new URL(url).hostname || null; } catch (e) { return null; }
}

async function handleStepFailure({ task, step, error, observation, execution, provider, repairAttemptId, priorDiagnosis }) {
  const ctx = { taskId: task.id, executionId: task.currentExecutionId };
  const _diagId = repairAttemptId || (process.env.E3_1_DIAG === '1' ? 'RA_orphan_' + Date.now().toString(36) : null);
  if (_diagId) console.warn('[E3.1-DIAG] REPAIR_ENTER', JSON.stringify({ repairAttemptId: _diagId, taskId: task.id, stepId: step.id, errorCode: error && error.code, errorMsg: String(error && error.message || error || '').slice(0, 120) }));

  // 0) 廉价错误分类（无 LLM）
  const classifier = errorClassifier.classify(error, { url: observation && observation.url });

  // 0.05) STEP 4 统一诊断短路门：诊断已判定「不可重试」时，不再走 LLM 重分类、
  //      也不再让修复链路在页面上执行任何动作。
  //      验证码 / OTP / 权限 / 支付被拒 / 凭据错误 / 记录重复 —— 这些失败的正确处理
  //      是把根因交给人。花一次 LLM 调用把它重分类成 ELEMENT_CHANGED 后去点三次按钮，
  //      既浪费成本，又可能在风控页面上放大风险（绝不允许尝试绕过验证码 / 3DS）。
  if (priorDiagnosis && priorDiagnosis.retryPolicy === 'escalate') {
    const reason = `${priorDiagnosis.rootCause}：${priorDiagnosis.summary}`;
    const t0 = taskManager.getTask(task.id);
    if (t0) {
      t0.lastDiagnosis = { ...priorDiagnosis, fromLLM: false, fromUnifiedDiagnosis: true };
      store.upsert('aiTasks', t0);
    }
    events.emit({
      ...ctx, stepId: step.id, type: 'ai.failed',
      payload: { code: 'DIAGNOSIS_NOT_RETRIABLE', rootCause: priorDiagnosis.rootCause, message: reason, evidence: priorDiagnosis.evidence.slice(0, 5) },
    });
    taskManager.pauseForHuman(task.id, reason, { stepId: step.id, action: step.action });
    return { paused: true, reason, category: classifier.type, notRetriable: true, rootCause: priorDiagnosis.rootCause };
  }

  // 0.1) 失败经验查询（在 Diagnosis 之前，命中则跳过 LLM Diagnosis，降低成本）
  let diag = null;
  let usedMemory = false;
  try {
    const r = failureAdvisor.resolveDiagnosis({
      site: siteOf(task.targetUrl),
      url: (observation && observation.url) || task.targetUrl,
      errorType: classifier.type,
      action: (step && step.action && step.action.type) || undefined,
      pageState: (observation && observation.pageState) || undefined,
      observationHash: (observation && observation.hash) || null,
    });
    if (r.useMemory) {
      let snap = null;
      try { snap = await failureSnapshot.create({ taskId: task.id, stepId: step && step.id, url: (observation && observation.url) || task.targetUrl, title: observation && observation.title, errorType: classifier.type, confidence: classifier.confidence, lastAction: step && step.action, observation, executionId: task.currentExecutionId }); } catch (e) {}
      diag = { ok: true, fromLLM: false, fromFailureMemory: true, diagnosis: r.syntheticDiagnosis, failureSnapshot: snap, classifier };
      usedMemory = true;
    }
  } catch (e) {}

  // 1) 诊断（若未命中历史经验）
  if (!diag) {
    try {
      diag = await diagnosisEngine.runDiagnosis({ task, step, error, observation, execution, provider, ctx });
    } catch (e) {
      diag = null;
    }
  }
  const category = diag ? diag.diagnosis.category : 'UNKNOWN';

  // Phase 7 Step 5：VERIFY_FAILED 的修复必须走「等待稳定→重观察→重试验证」序列，
  // 而非被 Diagnosis LLM 重分类为 ELEMENT_CHANGED 后误用 SEMANTIC_RELOCATE（对验证期望未满足无效）。
  // 以原始分类（errorClassifier.type）为权威，强制路由到 VERIFY_RETRY 策略。
  if (classifier.type === 'VERIFICATION_FAILED' && diag && diag.diagnosis) {
    diag.diagnosis.category = 'VERIFICATION_FAILED';
  }
  if (_diagId) console.warn('[E3.1-DIAG] DIAGNOSIS_RESULT', JSON.stringify({ repairAttemptId: _diagId, taskId: task.id, category, fromFailureMemory: !!(diag && diag.fromFailureMemory), fromLLM: !!(diag && diag.fromLLM) }));
  const t = taskManager.getTask(task.id);
  if (t && diag) {
    t.lastDiagnosis = { ...diag.diagnosis, fromLLM: diag.fromLLM, fromFailureMemory: diag.fromFailureMemory, failureSnapshotId: diag.failureSnapshot && diag.failureSnapshot.id };
    store.upsert('aiTasks', t);
  }
  events.emit({ ...ctx, stepId: step.id, type: 'agent.diagnosing', payload: { category, confidence: diag ? diag.diagnosis.confidence : null, fromFailureMemory: diag ? !!diag.fromFailureMemory : false, recommendation: diag ? diag.diagnosis.recommendation : null } });

  // 2) Repair Plan
  const pr = repairPlanner.planFromDiagnosis({
    task, step,
    diagnosis: diag ? diag.diagnosis : null,
    classifier: diag ? diag.classifier : null,
    failureSnapshot: diag ? diag.failureSnapshot : null,
  });
  if (!pr.ok) {
    events.emit({ ...ctx, stepId: step.id, type: 'ai.failed', payload: { category, message: pr.error } });
    taskManager.pauseForHuman(task.id, pr.error, { stepId: step.id, action: step.action });
    return { paused: true, reason: pr.error, category };
  }

  // 3) Repair Policy
  const pol = repairPolicy.canExecute({ plan: pr.plan, task });
  if (!pol.allowed) {
    events.emit({ ...ctx, stepId: step.id, type: 'ai.needApproval', payload: { reason: pol.reason, strategy: pr.plan.strategy } });
    taskManager.pauseForHuman(task.id, pol.reason, { stepId: step.id, action: step.action });
    return { paused: true, reason: pol.reason, category };
  }

  // 4) 执行（有界 maxRepairAttempts）
  let lastOut = null;
  if (_diagId) console.warn('[E3.1-DIAG] AUTO_REPAIR_ENTER', JSON.stringify({ repairAttemptId: _diagId, taskId: task.id, stepId: step.id, strategyType: pr.plan.strategyType, strategy: pr.plan.strategy, maxAttempts: pr.plan.maxAttempts }));
  for (let i = 0; i < pr.plan.maxAttempts; i++) {
    if (_diagId) console.warn('[E3.1-DIAG] AUTO_REPAIR_ITER', JSON.stringify({ repairAttemptId: _diagId, taskId: task.id, stepId: step.id, iter: i }));
    // v0.2.1：将原始错误（含 failureType）透传给 executor → 策略，供 verifyFailed 按 taxonomy 分流
    ctx.error = error;
    lastOut = await executor.executePlan({ task, step, plan: pr.plan, ctx, repairAttemptId: _diagId });
    if (lastOut.ok) break;
    if (lastOut.needsApproval) {
      taskManager.pauseForHuman(task.id, '修复策略需要人工处理（' + pr.plan.strategy + '）', { stepId: step.id, action: step.action });
      return { paused: true, reason: '需要人工处理', category };
    }
  }

  // 5) 修复结果落库为失败经验（学习闭环）
  const repairOk = !!(lastOut && lastOut.ok);
  if (lastOut && lastOut.needsApproval) {
    // 已转人工，不计入失败经验（等待人工）
  } else {
    try {
      failureCollector.recordRepair({
        site: siteOf(task.targetUrl),
        category,
        errorType: classifier.type,
        url: (observation && observation.url) || task.targetUrl,
        actionType: (step && step.action && step.action.type) || '?',
        pageState: (observation && observation.pageState) || '?',
        element: (step && step.action && step.action.target && (step.action.target.semantic || step.action.target.field)) || undefined,
        strategy: pr.plan.strategy,
        steps: (pr.plan.steps || []).map((s) => s.action || s.type || 'step'),
        success: repairOk,
        source: { type: 'repair_success' },
      });
    } catch (e) {}
  }

  // 6) 返回结果
  if (repairOk) return { ok: true, category, usedMemory, repairAttempt: lastOut.repairAttempt };

  // 修复耗尽 → PAUSED_FOR_HUMAN（不无限循环）
  const errMsg = `修复尝试已达上限(${pr.plan.strategy})，需人工处理`;
  events.emit({ ...ctx, stepId: step.id, type: 'ai.failed', payload: { category, message: errMsg } });
  taskManager.pauseForHuman(task.id, errMsg, { stepId: step.id, action: step.action });
  return { paused: true, reason: errMsg, category, usedMemory, repairStats: repairAttempts.statsByStrategy() };
}

module.exports = { handleStepFailure };
