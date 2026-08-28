'use strict';

// Phase 5.9-B — Instrumentation（Benchmark 层，对 Runtime/verification/mock 只读）。
// 目标：把「C 为什么成功/失败」拆成可测量的层，回答：
//   C 失败，是 Plan 错、Action 错、Verification 错，还是 Recovery 没处理？
//
// 数据全部来自既有持久化集合（aiSteps / aiAttempts / aiEvents / aiRepairAttempts /
// aiIntelligenceEvaluations / aiDispatchExecutions / aiWorkers / aiBrowserResources /
// aiProfileBindings）+ observability trace/metrics。不写任何 Runtime 逻辑。
//
// 重要事实（5.9-B 核心结论前置）：当前 C 走「确定性 Plan + 无 Intelligence 介入」路径，
// Runtime 从未调用 evaluator.collect()，故 aiIntelligenceEvaluations 为空 →
// memoryLookup/memoryHit/routerDecision/routerCorrect/failureKnowledge* 均为 0/null。
// 这正是「Architecture ≠ Intelligence」的观测证据：C=72.7% 是 Runtime 架构贡献，
// 不是 Memory/Router/Failure Knowledge 贡献。

const stepManager = require('../server/agent/stepManager');
const observability = require('../server/agent/observability');
const store = require('../server/agent/store');

// 把 attempt.error 归类到「失败层」
function classifyFailureLayer(attempt) {
  const err = attempt && attempt.error ? String(attempt.error) : '';
  const code = (attempt && attempt.error && /\[(\w+)\]/.test(attempt.error))
    ? attempt.error.match(/\[(\w+)\]/)[1]
    : '';
  if (/VERIFY_FAILED/.test(err) || /验证/.test(err)) return 'Verification';
  if (/ACTION_REQUIRES_APPROVAL|CREDENTIAL|PASSWORD|SENSITIVE/.test(err)) return 'Policy/Action(Escalated)';
  if (/ELEMENT_NOT_FOUND|ACTION_INVALID|ACTION_FAILED/.test(err)) return 'Action';
  if (/STEP_TIMEOUT|timeout/.test(err)) return 'Timeout';
  if (/crash|CRASH/.test(err)) return 'Crash';
  if (code) return 'Action(' + code + ')';
  return 'Action';
}

// 逐 step 拆解：action / start / end / success / failure / verification
function buildSteps(taskId) {
  const steps = stepManager.listSteps(taskId);
  return steps.map((s) => {
    const attempts = stepManager.listAttempts(s.id);
    const first = attempts[0];
    const last = attempts[attempts.length - 1];
    const failedAttempts = attempts.filter((a) => a.status === 'FAILED');
    let layer = null;
    if (s.status === 'FAILED' && failedAttempts.length) {
      // 取最后一次失败尝试归类
      layer = classifyFailureLayer(last);
    }
    return {
      index: s.index,
      id: s.id,
      description: s.description,
      action: s.action ? { type: s.action.type, target: s.action.target || null, risk: s.action.risk } : null,
      verification: s.verification ? s.verification.type : 'none',
      status: s.status,
      attemptCount: attempts.length,
      retryable: s.retryable,
      startMs: first ? first.startedAt : null,
      endMs: last ? (last.endedAt || null) : null,
      durationMs: (first && last && last.endedAt) ? (last.endedAt - first.startedAt) : null,
      failureLayer: layer,
      lastError: last && last.error ? String(last.error).slice(0, 200) : null,
    };
  });
}

// Retry / Recovery 层
function buildRecovery(taskId) {
  const evts = store.read('aiEvents', [])
    .filter((e) => e.taskId === taskId)
    .sort((a, b) => (a.timestamp || a.ts || 0) - (b.timestamp || b.ts || 0));
  const retryEvts = evts.filter((e) => e.type === 'agent.retrying');
  const repairEvts = evts.filter((e) => e.type === 'agent.repairing');
  const recoverEvts = evts.filter((e) => e.type === 'agent.recovered');
  const diagEvts = evts.filter((e) => e.type === 'agent.diagnosing');

  const repairs = store.read('aiRepairAttempts', [])
    .filter((r) => r.taskId === taskId)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  const recoveryTypes = new Set();
  for (const e of diagEvts) {
    if (e.payload && e.payload.category) recoveryTypes.add(e.payload.category);
  }
  for (const r of repairs) {
    if (r.strategy) recoveryTypes.add(r.strategy);
  }

  const recoveryTriggered = retryEvts.length > 0 || repairEvts.length > 0 || repairs.length > 0;
  // recoverySuccess：有 agent.recovered 事件，或 repair 终态 SUCCESS
  const recoverySuccess = recoverEvts.length > 0 ||
    repairs.some((r) => r.status === 'SUCCESS');

  // recoveryLatency：第一条 recovery 触发到成功/终态
  let recoveryLatency = null;
  if (recoveryTriggered) {
    const startE = retryEvts[0] || repairEvts[0];
    const endE = recoverEvts[recoverEvts.length - 1] || (repairs.length ? repairs[repairs.length - 1] : null);
    const startT = startE ? (startE.timestamp || startE.ts) : (repairs[0] ? repairs[0].createdAt : null);
    const endT = endE ? (endE.timestamp || endE.ts || endE.finishedAt || endE.createdAt) : null;
    if (startT && endT) recoveryLatency = endT - startT;
  }

  const humanEscalationEvt = evts.filter((e) =>
    e.type === 'ai.warning' && /HUMAN|escalat|APPROVAL/i.test(JSON.stringify(e.payload || {}))).length > 0;

  return {
    retryCount: retryEvts.length,
    recoveryTriggered,
    recoveryTypes: Array.from(recoveryTypes),
    recoverySuccess,
    recoveryLatencyMs: recoveryLatency,
    repairAttempts: repairs.length,
    humanEscalationEvt,
    recoveryEvents: recoverEvts.length,
  };
}

// Intelligence 层（当前 C 基线：应全部为 0/null —— 诚实记录「未接入」）
function buildIntelligence(taskId) {
  const evals = store.read('aiIntelligenceEvaluations', [])
    .filter((e) => e.taskId === taskId);
  const evts = store.read('aiEvents', [])
    .filter((e) => e.taskId === taskId);
  // failureKnowledge 命中：repairManager 中 failureAdvisor.resolveDiagnosis fromFailureMemory=true
  const fkHit = evts.filter((e) =>
    e.type === 'agent.diagnosing' && (e.payload && e.payload.fromFailureMemory)).length > 0;
  const memHit = evts.filter((e) =>
    e.type === 'agent.diagnosing' && (e.payload && e.payload.fromMemory)).length > 0;

  if (!evals.length) {
    return {
      recorded: false,            // 关键：Runtime 未调用 evaluator.collect()
      memoryLookup: 0,
      memoryHit: 0,
      memoryHitRate: 0,
      routerDecision: null,
      routerCorrect: null,
      routerAccuracy: null,
      failureKnowledgeLookup: 0,
      failureKnowledgeHit: fkHit,
      llmCalled: false,
      llmCalls: 0,
      tokens: 0,
      estimatedCost: 0,
    };
  }
  const e = evals[0];
  const src = (e.decision && e.decision.source) || null;
  const actual = e.actual || {};
  return {
    recorded: true,
    memoryLookup: src ? 1 : 0,
    memoryHit: memHit ? 1 : 0,
    memoryHitRate: memHit ? 1 : 0,
    routerDecision: src,
    routerCorrect: (e.metrics && typeof e.metrics.accuracy === 'number') ? e.metrics.accuracy : null,
    routerAccuracy: (e.metrics && typeof e.metrics.accuracy === 'number') ? e.metrics.accuracy : null,
    failureKnowledgeLookup: fkHit ? 1 : 0,
    failureKnowledgeHit: fkHit,
    llmCalled: (actual.llmCalls || 0) > 0,
    llmCalls: actual.llmCalls || 0,
    tokens: actual.tokens || 0,
    estimatedCost: 0,
  };
}

// Resource 层（全局快照：per-run 累积；并发=1 时 contention 应接近 0）
// 注意：不直接信任 observability.workerMetrics.utilization（其 totalLifetime 计算在单 worker
// 短生命周期场景下会算出 >100% 的异常值）。这里从原始集合重新安全推导。
function buildResource() {
  const wm = observability.workerMetrics.compute();
  const rm = observability.resourceMetrics.compute();

  // 安全重新推导 worker utilization
  const workers = store.read('aiWorkers', []);
  const dispatches = store.read('aiDispatchExecutions', []);
  const now = Date.now();
  let busy = 0;
  for (const d of dispatches) {
    if (d.workerId && d.startedAt && d.finishedAt && d.finishedAt >= d.startedAt) {
      busy += (d.finishedAt - d.startedAt);
    }
  }
  let lifetime = 0;
  for (const w of workers) {
    const start = w.createdAt || w.startedAt || now;
    const end = w.lastHeartbeat || now;
    if (end >= start) lifetime += (end - start);
  }
  let workerUtil = null;
  if (lifetime > 0 && busy <= lifetime) workerUtil = +(busy / lifetime).toFixed(4);
  else if (lifetime > 0) workerUtil = 1; // busy>lifetime 视为满载（边界情况）

  return {
    workerBusyMs: busy,
    workerIdleMs: Math.max(0, lifetime - busy),
    workerUtilization: workerUtil,
    workerTotal: wm.total,
    browserBusy: rm.browsers ? rm.browsers.busy : null,
    browserTotal: rm.browsers ? rm.browsers.total : null,
    browserUtilization: rm.browserUtilization,
    profileContention: rm.contentionProfiles,
    resourceBusyEvents: rm.resourceBusyEvents,
    ghostLock: rm.ghostLocks,
  };
}

// 主入口：组装单任务完整 trace
function collectTaskTrace(taskId, executionId, taskMeta) {
  const trace = observability.trace(taskId) || {};
  const queue = (trace.segments && trace.segments.queue) || null;
  const steps = buildSteps(taskId);
  const recovery = buildRecovery(taskId);
  const intelligence = buildIntelligence(taskId);

  const planStepCount = steps.length;
  const executedStepCount = steps.filter((s) => s.status === 'SUCCESS').length;
  const failedSteps = steps.filter((s) => s.status === 'FAILED');

  // 失败归因（针对最终 groundTruth=false 的任务）：
  //   planMismatch  → plan 未完整执行（exec < plan）
  //   actionError   → 存在 Action 层失败 step
  //   verifyError   → 存在 Verification 层失败 step
  //   recoveryGap   → 触发了 recovery 但未成功（含 HUMAN_ESCALATION）
  let failureAttribution = null;
  if (taskMeta && taskMeta.groundTruth === false) {
    const layers = new Set();
    for (const s of failedSteps) if (s.failureLayer) layers.add(s.failureLayer);
    if (executedStepCount < planStepCount) layers.add('Plan(Incomplete)');
    if (recovery.recoveryTriggered && !recovery.recoverySuccess) layers.add('Recovery(Unhandled)');
    failureAttribution = {
      layers: Array.from(layers),
      executedStepCount,
      planStepCount,
      failedStepIndices: failedSteps.map((s) => s.index),
    };
  }

  return {
    taskId,
    executionId,
    category: taskMeta ? taskMeta.category : null,
    runtimeStatus: taskMeta ? taskMeta.runtimeStatus : null,
    groundTruth: taskMeta ? taskMeta.groundTruth : null,
    groundTruthError: taskMeta ? taskMeta.groundTruthError : null,
    fairnessMismatch: taskMeta ? taskMeta.fairnessMismatch : null,
    queueWaitMs: queue && queue.waitedMs != null ? queue.waitedMs : null,
    planStepCount,
    executedStepCount,
    planEqualsExec: planStepCount === executedStepCount,
    steps,
    recovery,
    intelligence,
    failureAttribution,
    resourceSnapshot: buildResource(),
  };
}

module.exports = {
  collectTaskTrace,
  buildSteps,
  buildRecovery,
  buildIntelligence,
  buildResource,
  classifyFailureLayer,
};
