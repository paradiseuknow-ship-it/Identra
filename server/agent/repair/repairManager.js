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
// PHASE 17-A P0-B：LLM 结构化决策（state / blockedActions / required）→ Runtime 动作策略层。
// 此前 Diagnosis 的唯一消费口是「选修复策略」，Runtime 从不读它（R3 473s 实证）。
const diagnosisDecision = require('../diagnosisDecision');
const repairPlanner = require('./repairPlanner');
const repairPolicy = require('./repairPolicy');
const executor = require('./executor');
const repairAttempts = require('./repairAttempts');

// C147：委托唯一实现（此前是库内 8 份同义副本之一 —— 裸域名会让它静默返回 null）
function siteOf(url) {
  return require('../urlIdentity').hostOf(url);
}

// C151：诊断类别 → 修复路由类别的**唯一判定点**（纯函数，无副作用，供守护双向锚定）。
//
// 背景：Phase 7 Step 5 以 errorClassifier.type 为权威，把 VERIFY_FAILED 的诊断类别一律覆盖为
// VERIFICATION_FAILED（防止 Diagnosis LLM 重分类成 ELEMENT_CHANGED 后误用 SEMANTIC_RELOCATE）。
// 但**遮挡不是验证策略过严** —— cookie/consent 横幅、模态弹窗是可执行的真实原因，诊断层已经
// 给出可执行建议（accept/reject 弹窗后重试）。无条件覆盖把它丢掉 ⇒ 只能重观察重验证
// （对遮挡原理上无效）⇒ 真实站点上「按钮被横幅盖住」时会永远点不到目标。
//
// 方向：**收紧为条件豁免**（只放行 OBSTRUCTION），不是放宽 ——
//   · OBSTRUCTION 保持原类别 → repairPlanner 既定映射 DISMISS_OVERLAY/MEDIUM（风险由
//     repairPolicy 的 MEDIUM+conf≥0.85 门把守，实测诊断置信度 0.9）；
//   · 其它一切类别照旧被覆盖为 VERIFICATION_FAILED（C140 原意 100% 保留）。
function resolveDiagnosisCategory({ classifierType, diagnosisCategory }) {
  if (classifierType !== 'VERIFICATION_FAILED') return diagnosisCategory || classifierType || 'UNKNOWN';
  if (diagnosisCategory === 'OBSTRUCTION') return 'OBSTRUCTION';
  return 'VERIFICATION_FAILED';
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

  // P0-B：解析 LLM 产出的结构化 Decision（未产出时保持 null，绝不编造）。
  // 它通过 handleStepFailure 的返回值交给 runtime —— 这是 F22/F23 的「最小接口连接」：
  // 诊断结论从此能真正进入 Runtime Decision Layer，而不只是被写进 task.lastDiagnosis。
  let decision = null;
  try { decision = diagnosisDecision.fromLLM(diag && diag.diagnosis); } catch (e) { decision = null; }
  if (decision) {
    events.emit({ ...ctx, stepId: step.id, type: 'agent.diagnosis_decision', payload: { state: decision.state, blockedActions: decision.blockedActions, required: decision.required, source: 'llm', confidence: decision.confidence } });
  }

  // Phase 7 Step 5：VERIFY_FAILED 的修复必须走「等待稳定→重观察→重试验证」序列，
  // 而非被 Diagnosis LLM 重分类为 ELEMENT_CHANGED 后误用 SEMANTIC_RELOCATE（对验证期望未满足无效）。
  // 以原始分类（errorClassifier.type）为权威，强制路由到 VERIFY_RETRY 策略。
  //
  // C151：本节原本是**无条件覆盖**，把诊断层给出的 category 一律改写为 VERIFICATION_FAILED。
  // 它顺手丢掉了 OBSTRUCTION —— 而遮挡（cookie/consent 遮罩、模态弹窗）不是「验证策略过严」，
  // 它是**可执行的真实原因**，且诊断层已经给出可执行建议。实测（localhost 夹具 /cookie，
  // 全屏遮罩盖住目标按钮）：
  //   agent.diagnosing { category:'OBSTRUCTION', confidence:0.9,
  //                      recommendation:'按站点规则处理弹窗（accept/reject）后重试' }
  //   → 覆盖发生 → repairPlanner 产出 VERIFY_RETRY（只重观察重验证，**对遮挡原理上无效**）
  //   → 3 次修复全 ok:false → HUMAN_ESCALATION。
  // 真实站点同形：落地页的 cookie 横幅盖住注册/试用按钮 ⇒ 智能体永远点不到用户要点的那个按钮
  // （用户实测主诉「连注册按钮都找不到」的同族形态）。
  // 处置：**只对 OBSTRUCTION 豁免**，其余重分类一律照旧被覆盖 —— C140 的原意（禁止重分类为
  // ELEMENT_CHANGED 后误用 SEMANTIC_RELOCATE）完全保留，且 OBSTRUCTION → DISMISS_OVERLAY
  // 本就是 repairPlanner 的既定映射，风险由 repairPolicy 的 MEDIUM+conf≥0.85 门把守。
  const _resolvedCat = resolveDiagnosisCategory({
    classifierType: classifier.type,
    diagnosisCategory: diag && diag.diagnosis ? diag.diagnosis.category : null,
  });
  if (diag && diag.diagnosis && _resolvedCat && diag.diagnosis.category !== _resolvedCat) {
    diag.diagnosis.category = _resolvedCat;
  }
  if (_diagId) console.warn('[E3.1-DIAG] DIAGNOSIS_RESULT', JSON.stringify({ repairAttemptId: _diagId, taskId: task.id, category, fromFailureMemory: !!(diag && diag.fromFailureMemory), fromLLM: !!(diag && diag.fromLLM) }));
  const t = taskManager.getTask(task.id);
  if (t && diag) {
    t.lastDiagnosis = { ...diag.diagnosis, fromLLM: diag.fromLLM, fromFailureMemory: diag.fromFailureMemory, failureSnapshotId: diag.failureSnapshot && diag.failureSnapshot.id };
    store.upsert('aiTasks', t);
  }
  // C151：`category` 是**覆盖前**的诊断类别；`resolvedCategory` 是**实际用于选修复策略**的类别。
  // 二者此前可能不同（覆盖发生时）且只有前者被上报 ⇒ 遥测显示 OBSTRUCTION、实际却按
  // VERIFICATION_FAILED 路由，归因时会产生「看事件以为走了遮挡修复」的误读。
  // 新增字段是**加性**的：不改任何判定，只让路由类别可审计（既有消费方零影响）。
  events.emit({ ...ctx, stepId: step.id, type: 'agent.diagnosing', payload: { category, resolvedCategory: _resolvedCat, confidence: diag ? diag.diagnosis.confidence : null, fromFailureMemory: diag ? !!diag.fromFailureMemory : false, recommendation: diag ? diag.diagnosis.recommendation : null } });

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
    lastOut = await executor.executePlan({ task, step, plan: pr.plan, ctx, repairAttemptId: _diagId, observation });
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
  if (repairOk) return { ok: true, category, usedMemory, repairAttempt: lastOut.repairAttempt, decision };

  // 修复耗尽 → PAUSED_FOR_HUMAN（不无限循环）
  const errMsg = `修复尝试已达上限(${pr.plan.strategy})，需人工处理`;
  events.emit({ ...ctx, stepId: step.id, type: 'ai.failed', payload: { category, message: errMsg } });
  taskManager.pauseForHuman(task.id, errMsg, { stepId: step.id, action: step.action });
  return { paused: true, reason: errMsg, category, usedMemory, decision, repairStats: repairAttempts.statsByStrategy() };
}

module.exports = { handleStepFailure, resolveDiagnosisCategory };
