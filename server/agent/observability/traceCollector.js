'use strict';

// traceCollector（Phase 4.6）：Task Trace 聚合。
// 目标：一个失败/慢任务，从结构化数据直接追出完整链路，无需翻几十个 JSON。
//
// 链路分段（按用户设计）：
//   Queue → Router → Worker → Profile/Browser → Runtime → Recovery → Verification → Evaluation
//
// 实现：纯从既有持久化集合聚合（aiDispatchExecutions / aiTasks / aiIntelligenceEvaluations /
//        aiRepairAttempts / aiWorkers / aiBrowserResources / aiProfileBindings / aiEvents），
// 不引入新存储，避免数据漂移，且天然支持「Node 重启后仍能追」。

const store = require('../store');
const { STATUS: RES } = require('../execution/browser/browserResource');

// 统一可回放时间线（Phase 4.2）：把分散在 aiSteps / aiAttempts / aiRepairAttempts /
// aiCheckpoints / aiFailureSnapshots / aiEvents 的数据聚合为单一有序节点数组。
// 节点类型（按产品设计要求）：
//   PLAN / STEP / ACTION / OBSERVATION / ERROR / REPAIR / RETRY / VERIFICATION / CHECKPOINT
// 不引入新存储、不引入新事件；纯从既有集合聚合。
function buildTimeline(taskId) {
  if (!taskId) return [];
  const task = store.find('aiTasks', taskId);
  if (!task) return [];

  const steps = store.findWhere('aiSteps', (s) => s.taskId === taskId).sort((a, b) => a.index - b.index);
  const attempts = store.read('aiAttempts', []).filter((a) => steps.find((s) => s.id === a.stepId));
  const repairs = store.read('aiRepairAttempts', []).filter((r) => r.taskId === taskId).sort((a, b) => a.createdAt - b.createdAt);
  const checkpoints = store.read('aiCheckpoints', []).filter((c) => c.taskId === taskId).sort((a, b) => a.timestamp - b.timestamp);
  const snapshots = store.read('aiFailureSnapshots', []).filter((s) => s.taskId === taskId).sort((a, b) => a.timestamp - b.timestamp);
  const evts = store.read('aiEvents', []).filter((e) => e.taskId === taskId).sort((a, b) => (a.ts || a.timestamp || 0) - (b.ts || b.timestamp || 0));

  const nodes = [];

  // PLAN
  nodes.push({
    kind: 'PLAN', ts: task.createdAt || 0, taskId,
    objective: task.objective || null,
    targetUrl: task.targetUrl || null,
    mode: task.executionMode || null,
    stepCount: steps.length,
  });

  // STEP
  steps.forEach((s) => {
    nodes.push({
      kind: 'STEP', ts: s.createdAt || 0, stepId: s.id, index: s.index,
      type: s.type, status: s.status, description: s.description,
      verification: s.verification || null,
    });
  });

  // ACTION / OBSERVATION / ERROR / RETRY（按 attempt，计算 retry index）
  steps.forEach((s) => {
    const atts = attempts.filter((a) => a.stepId === s.id).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    atts.forEach((a, idx) => {
      const ts = a.startedAt || a.createdAt || 0;
      nodes.push({
        kind: 'ACTION', ts, stepId: a.stepId, attemptId: a.id, index: idx + 1,
        status: a.status, action: a.action || null,
      });
      const obsEvt = evts.find((e) => (e.type === 'agent.observing' || e.type === 'ai.observing') && e.stepId === a.stepId && e.attemptId === a.id);
      const obs = (a.observation) || (obsEvt && obsEvt.payload) || null;
      if (obs) nodes.push({ kind: 'OBSERVATION', ts, stepId: a.stepId, attemptId: a.id, observation: obs });
      if (a.error) nodes.push({
        kind: 'ERROR', ts: a.endedAt || ts, stepId: a.stepId, attemptId: a.id,
        code: a.error.code || null, message: a.error.message || null,
      });
      if (idx >= 1) nodes.push({ kind: 'RETRY', ts, stepId: a.stepId, attemptId: a.id, index: idx + 1 });
    });
  });

  // REPAIR
  repairs.forEach((r) => {
    nodes.push({
      kind: 'REPAIR', ts: r.createdAt || 0, repairId: r.id, stepId: r.stepId,
      strategy: r.strategy, strategyType: r.strategyType || null, status: r.status,
      risk: r.risk, durationMs: (r.createdAt && r.finishedAt) ? r.finishedAt - r.createdAt : null,
    });
  });

  // VIL DECISION（Verification Intelligence 决策流，Phase 12B §十四 补齐聚合）
  evts.filter((e) => e.type === 'ai.verification.decision').forEach((e) => {
    nodes.push({
      kind: 'VIL', ts: e.ts || e.timestamp || 0, stepId: e.stepId, attemptId: e.attemptId,
      decision: e.payload && e.payload.decision,
      failureType: e.payload && e.payload.failureType,
      confidence: e.payload && e.payload.confidence,
    });
  });

  // VIL RECOVERY（观察窗口内恢复成功）
  evts.filter((e) => e.type === 'ai.verification.recovered').forEach((e) => {
    nodes.push({
      kind: 'RECOVERY', ts: e.ts || e.timestamp || 0, stepId: e.stepId, attemptId: e.attemptId,
      recoveryAction: e.payload && e.payload.recoveryAction,
      observationCount: e.payload && e.payload.observationCount,
      elapsedMs: e.payload && e.payload.elapsedMs,
    });
  });

  // ESCALATION（人工升级，含 escalationKind 归因）
  evts.filter((e) => e.type === 'task.escalated').forEach((e) => {
    nodes.push({
      kind: 'ESCALATION', ts: e.ts || e.timestamp || 0,
      reason: e.payload && e.payload.reason,
      escalationKind: e.payload && e.payload.escalationKind,
    });
  });

  // VERIFICATION
  evts.filter((e) => e.type === 'ai.verification.completed' || e.type === 'agent.recovered').forEach((e) => {
    nodes.push({ kind: 'VERIFICATION', ts: e.ts || e.timestamp || 0, type: e.type, payload: e.payload || {} });
  });

  // CHECKPOINT
  checkpoints.forEach((c) => {
    nodes.push({
      kind: 'CHECKPOINT', ts: c.timestamp || 0, checkpointId: c.id, stepId: c.stepId,
      url: c.url, lastSuccessfulAction: c.lastSuccessfulAction,
      lastVerifiedState: c.lastVerifiedState || null,
    });
  });

  // FAILURE SNAPSHOT（错误补充，含截图引用）
  snapshots.forEach((s) => {
    nodes.push({
      kind: 'ERROR', ts: s.timestamp || 0, stepId: s.stepId,
      code: s.errorType || null, message: null, snapshotRef: s.screenshotRef || null,
    });
  });

  nodes.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return nodes;
}

function trace(taskId) {
  if (!taskId) return null;
  const task = store.find('aiTasks', taskId);
  if (!task) return null;

  const dispatch = store.find('aiDispatchExecutions', taskId); // dispatch id == taskId
  const evalRec = (store.read('aiIntelligenceEvaluations', [])
    .filter((e) => e.taskId === taskId).sort((a, b) => a.createdAt - b.createdAt))[0] || null;
  const repairs = store.read('aiRepairAttempts', [])
    .filter((r) => r.taskId === taskId).sort((a, b) => a.createdAt - b.createdAt);
  const worker = dispatch && dispatch.workerId ? store.find('aiWorkers', dispatch.workerId) : null;
  const browser = dispatch && dispatch.profileId ? store.findWhere('aiBrowserResources', (r) => r.profileId === dispatch.profileId)[0] : null;
  const binding = dispatch && dispatch.profileId ? store.findWhere('aiProfileBindings', (b) => b.profileId === dispatch.profileId && (b.status === 'ACTIVE' || b.active))[0] : null;

  // 事件流（按时间排序，仅本 task）
  const evts = store.read('aiEvents', [])
    .filter((e) => e.taskId === taskId)
    .sort((a, b) => (a.ts || a.timestamp || 0) - (b.ts || b.timestamp || 0));

  const queue = dispatch ? {
    status: dispatch.status,
    queuedAt: dispatch.queuedAt,
    scheduledAt: dispatch.scheduledAt,
    assignedAt: dispatch.assignedAt,
    startedAt: dispatch.startedAt,
    finishedAt: dispatch.finishedAt,
    waitedMs: (dispatch.queuedAt && dispatch.startedAt) ? dispatch.startedAt - dispatch.queuedAt : null,
  } : null;

  const router = evalRec ? {
    source: evalRec.decision && evalRec.decision.source,
    strategy: evalRec.decision && evalRec.decision.strategy,
    confidence: evalRec.decision && evalRec.decision.confidence,
    predictedSuccess: evalRec.prediction && evalRec.prediction.expectedSuccess,
    accuracy: evalRec.metrics && evalRec.metrics.accuracy,
  } : null;

  const workerSeg = worker ? {
    id: worker.id,
    status: worker.status,
    lastHeartbeat: worker.lastHeartbeat,
  } : null;

  const profileBrowser = (binding || browser) ? {
    profileId: dispatch && dispatch.profileId,
    bindingStatus: binding ? binding.status : null,
    browserStatus: browser ? browser.status : null,
    browserId: browser ? browser.id : null,
    ownerTaskId: binding ? binding.ownerTaskId : null,
  } : null;

  const runtime = {
    actions: evts.filter((e) => ['agent.tool_called', 'agent.action.started', 'agent.action.completed', 'ai.action.started', 'ai.action.completed'].indexOf(e.type) >= 0)
      .map((e) => ({ type: e.type, ts: e.ts || e.timestamp, tool: (e.payload && e.payload.tool) || null })),
    observations: evts.filter((e) => e.type === 'agent.observing' || e.type === 'ai.observing').length,
  };

  const recovery = repairs.length ? {
    attempts: repairs.map((r) => ({
      id: r.id, strategy: r.strategy, status: r.status,
      createdAt: r.createdAt, finishedAt: r.finishedAt,
      durationMs: (r.createdAt && r.finishedAt) ? r.finishedAt - r.createdAt : null,
      risk: r.risk,
    })),
    count: repairs.length,
    finalStatus: repairs[repairs.length - 1].status,
  } : null;

  const verification = evts.filter((e) => e.type === 'ai.verification.completed' || e.type === 'agent.recovered')
    .map((e) => ({ type: e.type, ts: e.ts || e.timestamp, payload: e.payload || {} }));

  const vil = evts.filter((e) => e.type === 'ai.verification.decision' || e.type === 'ai.verification.recovered')
    .map((e) => ({ type: e.type, ts: e.ts || e.timestamp, payload: e.payload || {} }));

  const evaluation = evalRec ? {
    source: evalRec.decision && evalRec.decision.source,
    actualSuccess: evalRec.actual && evalRec.actual.success,
    llmCalls: evalRec.actual && evalRec.actual.llmCalls,
    repairCount: evalRec.actual && evalRec.actual.repairCount,
    accuracy: evalRec.metrics && evalRec.metrics.accuracy,
  } : null;

  return {
    taskId,
    status: task.status,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    profileId: task.profileId,
    segments: {
      queue, router, worker: workerSeg, profileBrowser,
      runtime, recovery, verification, evaluation,
    },
    vil,
    events: evts.map((e) => ({ type: e.type, ts: e.ts || e.timestamp, payload: e.payload || {} })),
    timeline: buildTimeline(taskId),
  };
}

module.exports = { trace, buildTimeline, RES };
