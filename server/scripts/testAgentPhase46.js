'use strict';

// Phase 4.6 Observability 测试。
// 运营级验收：100 Task Stress / Failure→Recovery Trace / Intelligence ROI。
// 原则：指标全部从「持久化集合」聚合验证（而非 mock 函数），确保真实可追责。

const assert = require('assert');
const store = require('../agent/store');
const obs = require('../agent/observability');
const { STATUS: RES } = require('../agent/execution/browser/resourceState');
const { STATUS: WK } = require('../agent/execution/workerState');
const { EXEC_COLLECTION } = require('../agent/execution/queueManager');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

// 清空观测相关集合（隔离）
function resetObs() {
  for (const c of ['aiTasks', 'aiDispatchExecutions', 'aiWorkers', 'aiBrowserResources',
    'aiProfileBindings', 'aiIntelligenceEvaluations', 'aiRepairAttempts', 'aiEvents']) {
    store.clear(c);
  }
}

console.log('Phase 4.6 Observability 测试');

// ============ Case1：100 Task Stress（运营级验收 1）============
console.log('Case1 100 Task Stress');
{
  resetObs();
  const now = Date.now();
  const N = 100;
  for (let i = 0; i < N; i++) {
    const id = 'st' + i;
    const profileId = 'p' + (i % 3); // 3 个 profile
    store.upsert('aiTasks', {
      id, profileId, status: (i % 10 === 0) ? 'FAILED' : 'COMPLETED',
      createdAt: now - 5000, startedAt: now - 4000, completedAt: now - 1000,
    });
    // dispatch 记录（id == taskId）
    store.upsert(EXEC_COLLECTION, {
      id, taskId: id, profileId, workerId: 'worker_1',
      status: (i % 10 === 0) ? 'FAILED' : 'COMPLETED',
      queuedAt: now - 5000, scheduledAt: now - 4800, assignedAt: now - 4600,
      startedAt: now - 4000, finishedAt: now - 1000,
    });
  }
  // 资源：3 profile 已释放（无活跃绑定）
  for (let p = 0; p < 3; p++) {
    store.upsert('aiBrowserResources', { id: 'b' + p, profileId: 'p' + p, status: RES.IDLE, owner: null });
  }
  const d = obs.dashboard();
  ok(d.task.total === N, 'dashboard 统计 100 任务', d.task.total);
  ok(d.task.completed === 90 && d.task.failed === 10, '成功 90 / 失败 10', { c: d.task.completed, f: d.task.failed });
  ok(d.task.successRate === 0.9, 'success rate 0.9', d.task.successRate);
  ok(d.task.latency.count === N && d.task.latency.avg === 3000, 'latency 平均 3s（started→finished）', d.task.latency.avg);
  ok(d.task.latency.p50 !== null && d.task.latency.p99 !== null, 'P50/P95/P99 存在', d.task.latency);

  // 无重复 execution：dispatch 数 == 任务数（100），无同一 taskId 多条
  const dispatches = store.read(EXEC_COLLECTION, []);
  const ids = new Set(dispatches.map((x) => x.id));
  ok(dispatches.length === N && ids.size === N, '无重复 execution（100 唯一条目）', dispatches.length);

  // 无 ghost lock：无 ACTIVE 绑定指向终态 task
  const res = obs.resourceMetrics.compute();
  ok(res.ghostLocks === 0, '无 ghost lock', res.ghostLocks);
  ok(res.isHealthy === true, 'resource isHealthy', res.isHealthy);

  // 无丢任务：task 数 == dispatch 数
  ok(d.task.total === dispatches.length, '无丢任务', { tasks: d.task.total, dispatches: dispatches.length });

  // 无 Worker 永久 RUNNING：构造 worker 也验证
  store.upsert('aiWorkers', { id: 'worker_1', status: WK.READY, createdAt: now - 5000, lastHeartbeat: now });
  const wm = obs.workerMetrics.compute();
  ok(wm.byStatus[WK.RUNNING] === undefined || wm.byStatus[WK.RUNNING] === 0, '无 Worker 永久 RUNNING', wm.byStatus);

  // Queue 最终归零：所有 dispatch 终态
  const qm = obs.queueMetrics.compute();
  ok(qm.depth === 0, 'Queue 最终归零（depth=0）', qm.depth);

  // 资源最终全部释放（无 BUSY）
  ok(res.browsers.busy === 0, 'Browser/Profile 最终全部释放（busy=0）', res.browsers.busy);
}

// ============ Case2：Failure → Recovery Trace（运营级验收 2）============
console.log('Case2 Failure → Recovery Trace');
{
  resetObs();
  const now = Date.now();
  const taskId = 'trace_fail';
  store.upsert('aiTasks', { id: taskId, profileId: 'pX', status: 'COMPLETED', createdAt: now - 9000, startedAt: now - 8000, completedAt: now - 1000 });
  store.upsert(EXEC_COLLECTION, {
    id: taskId, taskId, profileId: 'pX', workerId: 'worker_1', status: 'COMPLETED',
    queuedAt: now - 9000, scheduledAt: now - 8800, assignedAt: now - 8600, startedAt: now - 8000, finishedAt: now - 1000,
  });
  // 6 类故障：在 repair + events 中体现
  const faults = ['TIMEOUT', 'BROWSER_DEAD', 'WORKER_DEAD', 'ELEMENT_CHANGED', '403', 'SESSION_EXPIRED'];
  faults.forEach((f, i) => {
    const created = now - 7000 + i * 1000;
    store.upsert('aiRepairAttempts', {
      id: 'ra_' + i, taskId, stepId: 's' + i, strategy: 'fix_' + f, risk: 'HIGH',
      status: i === 5 ? 'FAILED' : 'SUCCESS', createdAt: created, finishedAt: created + 800,
    });
    store.appendEvent({ type: 'agent.repairing', taskId, payload: { fault: f, attempt: i + 1 } });
    store.appendEvent({ type: 'agent.recovered', taskId, payload: { fault: f, success: i !== 5 } });
  });
  // evaluation
  store.upsert('aiIntelligenceEvaluations', {
    id: 'ev_1', taskId, site: 'x.com',
    decision: { source: 'FLOW_MEMORY', strategy: 'f', confidence: 0.9 },
    prediction: { expectedSuccess: 0.9 }, actual: { success: true, durationMs: 7000, llmCalls: 0, repairCount: faults.length },
    metrics: { accuracy: 1 },
  });

  const t = obs.trace(taskId);
  ok(t && t.taskId === taskId, 'trace 返回任务链路', t && t.taskId);
  // Queue 段
  ok(t.segments.queue && t.segments.queue.waitedMs === 1000, 'Queue 段：waited 1s', t.segments.queue && t.segments.queue.waitedMs);
  // Router 段
  ok(t.segments.router && t.segments.router.source === 'FLOW_MEMORY' && t.segments.router.confidence === 0.9, 'Router 段：source/confidence', t.segments.router);
  // Recovery 段：6 次尝试，最终 SUCCESS（除第6次 FAILED）
  ok(t.segments.recovery && t.segments.recovery.count === 6, 'Recovery 段：6 次尝试', t.segments.recovery && t.segments.recovery.count);
  ok(t.segments.recovery.attempts.every((a) => a.durationMs === 800), '每次重试耗时 800ms 可追', t.segments.recovery.attempts[0]);
  // Verification 段
  ok(t.segments.verification.length === 6, 'Verification 段：6 次 recovered 事件', t.segments.verification.length);
  // Evaluation 段
  ok(t.segments.evaluation && t.segments.evaluation.llmCalls === 0 && t.segments.evaluation.repairCount === 6, 'Evaluation 段：LLM avoided + repairCount', t.segments.evaluation);
  // 能从 trace 回答"是否需要人工"：第6次 FAILED + HIGH risk
  const lastRepair = t.segments.recovery.attempts[5];
  ok(lastRepair.status === 'FAILED', '第6类故障（SESSION_EXPIRED）最终需要人工升级', lastRepair);
}

// ============ Case3：Intelligence ROI（运营级验收 3）============
console.log('Case3 Intelligence ROI');
{
  resetObs();
  const now = Date.now();
  // 构造 20 条 evaluation：12 条 Memory 驱动（无 LLM），8 条 PLANNER_LLM
  const sources = [];
  for (let i = 0; i < 12; i++) sources.push(['FLOW_MEMORY', 'ELEMENT_MEMORY', 'SITE_MEMORY'][i % 3]);
  for (let i = 0; i < 8; i++) sources.push('PLANNER_LLM');
  sources.forEach((src, i) => {
    const memoryDriven = src !== 'PLANNER_LLM';
    store.upsert('aiIntelligenceEvaluations', {
      id: 'roi_' + i, taskId: 't' + i, site: 's.com',
      decision: { source: src, strategy: 'x', confidence: 0.85 },
      prediction: { expectedSuccess: 0.85 },
      actual: {
        success: i < 18, // 18 成功 2 失败
        durationMs: 5000,
        llmCalls: memoryDriven ? 0 : 3, // Memory 驱动避免 LLM
        repairCount: i % 4 === 0 ? 1 : 0,
      },
      metrics: { accuracy: i < 18 ? 1 : 0 },
    });
  });
  const ai = obs.aiMetrics.compute();
  ok(ai.total === 20, 'ROI 样本 20', ai.total);
  ok(ai.memoryHitRate === 0.6, 'Memory Hit Rate 0.6（12/20）', ai.memoryHitRate);
  ok(ai.llmAvoidanceRate === 0.6, 'LLM Avoidance Rate 0.6（未走 PLANNER_LLM）', ai.llmAvoidanceRate);
  ok(Math.abs(ai.routerAccuracy - 0.9) < 1e-9, 'Router Accuracy 0.9', ai.routerAccuracy);
  // repair success：repairCount>0 的任务中成功比例
  ok(ai.repairSuccessRate !== null, 'Repair Success Rate 可算', ai.repairSuccessRate);
  // cost per successful task：总 llmCalls / 成功数
  // 8 条 LLM 各 3 calls = 24；成功 18
  ok(ai.llmCallsTotal === 24, 'LLM calls 总 24', ai.llmCallsTotal);
  ok(ai.costPerSuccessfulTask === +(24 / 18).toFixed(4), 'Cost/ Successful Task = 1.3333', ai.costPerSuccessfulTask);

  // dashboard 整体含 ai 段
  const d = obs.dashboard();
  ok(d.ai && d.ai.total === 20, 'dashboard.ai 汇聚 Intelligence ROI', d.ai && d.ai.total);
}

// ============ Case4：指标模块独立可用 + Worker/Queue 聚合 ============
console.log('Case4 指标模块独立 + 聚合一致');
{
  resetObs();
  const now = Date.now();
  store.upsert('aiWorkers', { id: 'w1', status: WK.RUNNING, createdAt: now - 3000, lastHeartbeat: now });
  store.upsert('aiWorkers', { id: 'w2', status: WK.DEAD, createdAt: now - 3000, lastHeartbeat: now - 60000 });
  store.upsert(EXEC_COLLECTION, { id: 'q1', taskId: 'q1', status: 'QUEUED', queuedAt: now - 2000, scheduledAt: null, assignedAt: null, startedAt: null, finishedAt: null });
  store.upsert(EXEC_COLLECTION, { id: 'q2', taskId: 'q2', status: 'STARTED', queuedAt: now - 5000, scheduledAt: now - 4800, assignedAt: now - 4600, startedAt: now - 4000, finishedAt: null });

  const wm = obs.workerMetrics.compute();
  ok(wm.total === 2 && wm.dead === 1 && wm.running === 1, 'workerMetrics：1 RUNNING + 1 DEAD', wm.byStatus);
  const qm = obs.queueMetrics.compute();
  ok(qm.depth === 1 && qm.started === 1, 'queueMetrics：depth=1（仅 QUEUED 计 depth）', { depth: qm.depth, started: qm.started });
  // 不变量：dashboard 各段均存在
  const d = obs.dashboard();
  ['task', 'queue', 'worker', 'resource', 'ai', 'recovery'].forEach((k) => ok(k in d, 'dashboard 含 ' + k + ' 段'));
}

console.log('\nPhase 4.6 结果: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail === 0 ? 0 : 1);
