'use strict';

// TaskManager：AI 任务唯一写入口（CANONICAL EXECUTION ENTRY）。
//
// 唯一执行链（Phase 1 收口，单一事实来源）：
//   TaskManager.start(taskId)
//     ├─ queue.enqueue()         // aiQueue 记账（同 profile 串行，配合 Resource Lock）
//     └─ _kick → runtime.run()   // 真正驱动浏览器执行（BrowserManager）
//
// 说明：
//  - runtime.run 是【唯一】执行器；无论经 API 直启（POST /tasks）还是经调度层派遣，
//    最终都汇入 runtime.run（execution/worker.Worker.runDispatch 内部亦委托 taskManager.start）。
//  - execution/（scheduler/worker/pool/browserResource）是【可选的编排/可观测层】，
//    仅在手动启动 Scheduler（POST /execution/scheduler/start）后介入，用于多任务容量门控与
//    派遣生命周期记录；它不改变「runtime.run 为唯一执行器」的事实。
//  - 禁止 runtime 到处直接改 task 状态；一切状态变更经 taskStateManager 校验后，
//    由 taskManager 落库并广播事件。同时负责 Resource Lock 与 Execution 生命周期。

const store = require('./store');
const tsm = require('./taskStateManager');
const lock = require('./lock');
const events = require('./events');
const checkpoint = require('./checkpoint');
const recorder = require('./recorder');
const budget = require('./budget');
const queue = require('./queue');
const stepManager = require('./stepManager');
const { DEFAULT_POLICY } = require('./policy');

const EXECUTION_MODES = ['SIMULATION', 'ASSIST', 'AUTONOMOUS', 'DEBUG'];

// Runtime 钩子：start/resume/retry 后自动触发执行循环（避免 taskManager↔runtime 循环依赖）
let executor = null;
function setExecutor(fn) { executor = fn; }
function _kick(taskId) {
  if (executor) {
    setImmediate(() => executor(taskId).catch((e) => {
      console.error('[agent.runtime] 执行异常:', e && e.stack ? e.stack : e);
      try { fail(taskId, e); } catch (_) {}
    }));
  }
}

function uid(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---- 创建 / 查询 ----
function createTask(input = {}) {
  const task = {
    id: uid('task_'),
    name: input.name || '未命名任务',
    objective: input.objective || '',
    targetUrl: input.targetUrl || '',
    profileId: input.profileId || null,
    executionMode: EXECUTION_MODES.includes(input.executionMode) ? input.executionMode : 'ASSIST',
    policy: { ...DEFAULT_POLICY, ...(input.policy || {}) },
    budget: input.budget || null,       // 空则启动时用默认预算
    priority: Number.isInteger(input.priority) ? input.priority : 50,
    secretRefs: Array.isArray(input.secretRefs) ? input.secretRefs : [],
    dependsOn: Array.isArray(input.dependsOn) ? input.dependsOn : [], // Phase 12B §T16 任务依赖
    status: 'PENDING',
    plan: [],
    planVersion: null,     // plan_v1 / plan_v2 ...（支持 Plan Revision）
    planHistory: [],       // [{ version, stepIds, timestamp }] 旧计划快照
    pendingApproval: null,
    approvedActions: [],
    currentStepId: null,
    currentExecutionId: null,
    checkpointId: null,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
  };
  store.insert('aiTasks', task);
  events.emit({ taskId: task.id, type: 'task.created', payload: { name: task.name, objective: task.objective, executionMode: task.executionMode } });
  if (task.profileId) {
    queue.enqueue({ taskId: task.id, priority: task.priority, profileId: task.profileId });
  }
  return task;
}

function getTask(id) {
  return store.find('aiTasks', id);
}

// Phase 12B §I7：更新任务心跳时间戳（供 stale-task 扫描判断）。不改变状态，仅落 lastActivityAt。
function touch(id, ts) {
  const task = getTask(id);
  if (!task) return;
  task.lastActivityAt = ts || Date.now();
  store.upsert('aiTasks', task);
}

function listTasks() {
  return store.read('aiTasks', []);
}

function deleteTask(id) {
  const t = getTask(id);
  if (!t) return null;
  if (t.status === 'RUNNING' || t.status === 'PREPARING') {
    throw new Error('任务运行中，请先取消');
  }
  if (t.currentExecutionId) lock.releaseAllForExecution(t.currentExecutionId);
  store.remove('aiTasks', id);
  store.write('aiSteps', store.read('aiSteps', []).filter((s) => s.taskId !== id));
  queue.markDone(id, 'CANCELLED');
  return t;
}

// ---- 状态转换核心（统一入口）----
function _setTaskState(task, next, opts = {}) {
  const prev = task.status;
  const nextState = tsm.transitionTask(prev, next); // 非法转换会抛错
  // ── 5.9-E3.1-DIAG（仅诊断，纯日志）── 记录所有 task.status mutation，含 prev→next，
  // 用于定位「谁把终态重新写回 RUNNING」。受 E3_1_DIAG=1 触发，不改行为。
  if (process.env.E3_1_DIAG === '1') {
    console.warn('[E3.1-DIAG] TASK_STATUS_MUTATE', JSON.stringify({ taskId: task.id, prev, next: nextState, via: new Error().stack.split('\n')[2] ? new Error().stack.split('\n')[2].trim() : 'unknown' }));
  }
  task.status = nextState;
  task.error = opts.error || task.error;
  store.upsert('aiTasks', task);
  return { prev, next: nextState };
}

// ---- 启动：Acquire Lock → Execution → 状态流转 ----
function start(id) {
  const task = getTask(id);
  if (!task) throw new Error('任务不存在: ' + id);
  if (!['PENDING', 'PLANNING', 'FAILED'].includes(task.status)) {
    throw new Error(`任务状态 ${task.status} 不允许启动`);
  }

  // Phase 12B §T16：任务依赖——依赖任务必须全部 SUCCESS 才允许启动（否则保持 PENDING）。
  if (Array.isArray(task.dependsOn) && task.dependsOn.length) {
    const unmet = task.dependsOn.filter((depId) => {
      const d = getTask(depId);
      return !d || d.status !== 'SUCCESS';
    });
    if (unmet.length) {
      throw new Error('依赖任务未完成（需先 SUCCESS）: ' + unmet.join(', '));
    }
  }

  // 1) 创建 Execution + 预算
  const execution = recorder.createExecution(task.id, task.profileId, {
    executionMode: task.executionMode,
    policy: task.policy,
  });

  // 2) Profile Lock：同一 profile 同时只能一个 active execution（先建 execution，再以其 id 占锁）
  if (task.profileId) {
    const res = lock.acquire(lock.resourceKeyForProfile(task.profileId), { executionId: execution.id, taskId: task.id });
    if (!res.ok) {
      recorder.markFinished(execution.id, 'FAILED', res.reason);
      // Phase 5.8 修复：lock 失败必须让 task 进入终态，否则停在 PROFILE_READY/BROWSER_READY 永久悬挂。
      try { _setTaskState(task, 'FAILED', { error: '启动失败(资源锁): ' + res.reason }); } catch (_) {}
      task.finishedAt = Date.now();
      store.upsert('aiTasks', task);
      queue.markDone(task.id, 'FAILED');
      throw new Error(`启动失败: ${res.reason}`);
    }
  }
  task.currentExecutionId = execution.id;
  task.currentStepId = null;
  task.startedAt = Date.now();
  task.finishedAt = null;
  budget.createBudget(task.id, task.budget || undefined);

  // 3) 状态流转：PENDING → PLANNING → PREPARING → PROFILE_READY → BROWSER_READY → RUNNING
  //    （Phase 1.1 只跑通基础设施；BROWSER_READY 后的实际 executor 在 Phase 1.2 接入）
  // Phase 5.8 修复：整段流转用 try/catch 兜底，任何非法转换都必须让 task 落到 FAILED 终态，
  //    杜绝 RUNNING 之外的悬挂态（契约 Finding #1）。
  try {
    _setTaskState(task, 'PLANNING');
    events.emit({ taskId: task.id, executionId: execution.id, type: 'task.planned', payload: { step: 'planner' } });
    _setTaskState(task, 'PREPARING');
    events.emit({ taskId: task.id, executionId: execution.id, type: 'task.started', payload: { step: 'preparing' } });

    const profOk = task.profileId ? true : false; // 1.2 里执行 integrity + launch
    if (task.profileId) _setTaskState(task, 'PROFILE_READY');
    _setTaskState(task, 'BROWSER_READY');
    _setTaskState(task, 'RUNNING');
  } catch (e) {
    recorder.markFinished(execution.id, 'FAILED', String(e.message || e).slice(0, 300));
    try { _setTaskState(task, 'FAILED', { error: '状态流转异常: ' + String(e.message || e).slice(0, 300) }); } catch (_) {}
    task.finishedAt = Date.now();
    store.upsert('aiTasks', task);
    queue.markDone(task.id, 'FAILED');
    throw e;
  }

  // 4) 初始 checkpoint
  const cp = checkpoint.save(task.id, {
    executionId: execution.id,
    profileId: task.profileId,
    url: task.targetUrl,
    lastVerifiedState: { started: true },
  });
  task.checkpointId = cp.id;
  store.upsert('aiTasks', task);

  recorder.update(execution.id, { status: 'RUNNING' });
  events.emit({ taskId: task.id, executionId: execution.id, type: 'agent.observing', payload: { step: 'initial' } });
  _kick(task.id); // 触发 Runtime 执行循环（Phase 1.2）
  return { task, execution };
}

// ---- 人工介入 / 恢复 / 取消 ----
function pauseForHuman(id, reason, opts = {}) {
  const task = getTask(id);
  if (!task) throw new Error('任务不存在');
  _setTaskState(task, 'PAUSED_FOR_HUMAN', { error: null });
  // 记录待审批动作（供 Approve/Modify 使用）
  if (opts.action || opts.stepId) {
    task.pendingApproval = {
      stepId: opts.stepId || null,
      action: opts.action || null,
      reason: String(reason || '需要人工处理').slice(0, 200),
    };
    store.upsert('aiTasks', task);
  }
  if (task.currentExecutionId) lock.markPaused(lock.resourceKeyForProfile(task.profileId), task.currentExecutionId);
  events.emit({ taskId: task.id, executionId: task.currentExecutionId, type: 'ai.needApproval', payload: { reason: String(reason || '需要人工处理').slice(0, 200), stepId: opts.stepId || null, action: opts.action || null } });
  events.emit({ taskId: task.id, executionId: task.currentExecutionId, type: 'task.paused', payload: { reason: String(reason || '需要人工处理').slice(0, 200) } });
  return task;
}

function resume(id) {
  const task = getTask(id);
  if (!task) throw new Error('任务不存在');
  if (task.status !== 'PAUSED_FOR_HUMAN') throw new Error('任务不在暂停状态');
  _setTaskState(task, 'RUNNING');
  if (task.currentExecutionId) lock.markActive(lock.resourceKeyForProfile(task.profileId), task.currentExecutionId);
  events.emit({ taskId: task.id, executionId: task.currentExecutionId, type: 'task.resumed', payload: {} });
  _kick(task.id); // 恢复执行循环
  return task;
}

// 人工审批：批准待执行动作（写入 approvedActions，policy 据此放行）
function approve(id) {
  const task = getTask(id);
  if (!task) throw new Error('任务不存在');
  if (task.status !== 'PAUSED_FOR_HUMAN') throw new Error('任务不在暂停状态');
  const pa = task.pendingApproval;
  if (pa && pa.action) {
    task.approvedActions = task.approvedActions || [];
    task.approvedActions.push({ type: pa.action.type, semantic: pa.action.target && (pa.action.target.semantic || pa.action.target.field || null), grantedAt: Date.now() });
    events.emit({ taskId: task.id, executionId: task.currentExecutionId, type: 'ai.approved', payload: { action: pa.action.type } });
  }
  task.pendingApproval = null;
  store.upsert('aiTasks', task);
  return resume(id);
}

// 人工拒绝：取消任务
function reject(id) {
  const task = getTask(id);
  if (!task) throw new Error('任务不存在');
  const pa = task.pendingApproval;
  events.emit({ taskId: task.id, executionId: task.currentExecutionId, type: 'ai.rejected', payload: { action: pa && pa.action ? pa.action.type : null } });
  return cancel(id);
}

// 人工修改：调整执行策略（如 riskFloor）后恢复，重新过 policy 决策
function modify(id, patch = {}) {
  const task = getTask(id);
  if (!task) throw new Error('任务不存在');
  if (task.status !== 'PAUSED_FOR_HUMAN' && task.status !== 'PLANNING') throw new Error('任务状态不允许修改（需暂停或计划待确认）');
  if (patch.policy) task.policy = { ...task.policy, ...patch.policy };
  if (EXECUTION_MODES.includes(patch.executionMode)) task.executionMode = patch.executionMode;
  if (patch.pendingApproval === false) task.pendingApproval = null;
  // Plan Revision：用户给出新计划 → 版本化挂载（旧计划保留）
  if (patch.plan && Array.isArray(patch.plan.steps) && patch.plan.steps.length) {
    attachPlan(id, patch.plan);
  }
  store.upsert('aiTasks', task);
  events.emit({ taskId: task.id, executionId: task.currentExecutionId, type: 'ai.modified', payload: { policy: task.policy, planVersion: task.planVersion } });
  // 若暂停中则恢复执行（新计划则从头执行）；若 PLANNING 则由用户自行 start
  return task.status === 'PAUSED_FOR_HUMAN' ? resume(id) : task;
}

// 将已校验的 Plan 挂到任务上（Chat 流程：先展示计划，人工确认后 start 执行）
// 支持版本化：再次挂载 = Plan Revision，旧计划快照进 planHistory（plan_v1 → plan_v2）
function attachPlan(id, plan) {
  const task = getTask(id);
  if (!task) throw new Error('任务不存在');
  if (task.status !== 'PENDING' && task.status !== 'PLANNING') throw new Error(`任务状态 ${task.status} 不允许挂载计划`);

  // 旧计划快照（如有）
  const oldSteps = stepManager.listSteps(id);
  if (oldSteps.length) {
    task.planHistory = task.planHistory || [];
    task.planHistory.push({ version: task.planVersion || 'plan_v0', stepIds: oldSteps.map((s) => s.id), timestamp: Date.now() });
  }
  store.write('aiSteps', store.read('aiSteps', []).filter((s) => s.taskId !== id));
  const steps = plan.steps.map((s, i) => stepManager.createStep(task.id, s, i));
  task.plan = steps.map((s) => s.id);
  task.planGoal = plan.goal || task.objective; // Phase 3.2：供成功落库 Flow 时使用
  task.planVersion = nextPlanVersion(task);
  task.pendingApproval = null;
  if (task.status === 'PENDING') _setTaskState(task, 'PLANNING');
  store.upsert('aiTasks', task);
  events.emit({ taskId: task.id, type: 'ai.plan.created', payload: { goal: plan.goal, stepCount: steps.length, planVersion: task.planVersion } });
  return task;
}

function nextPlanVersion(task) {
  const cur = task.planVersion || 'plan_v0';
  const m = cur.match(/(\d+)$/);
  const n = m ? parseInt(m[1], 10) + 1 : 1;
  return 'plan_v' + n;
}

// Plan Revision：用户修改计划 → 新版本计划（旧计划保留在 planHistory）
function revisePlan(id, plan) {
  return attachPlan(id, plan);
}

// 启动恢复：被中断任务 → RECOVERING → 新 Execution + 重获锁 + checkpoint → RUNNING → kick
function recover(id) {
  const task = getTask(id);
  if (!task) throw new Error('任务不存在');
  if (!['RUNNING', 'HEALING', 'RECOVERING'].includes(task.status)) {
    throw new Error(`任务状态 ${task.status} 不允许恢复`);
  }
  _setTaskState(task, 'RECOVERING');

  const execution = recorder.createExecution(task.id, task.profileId, { recovery: true });
  if (task.profileId) {
    lock.releaseAllForExecution(task.currentExecutionId); // 释放旧锁（可能已随进程消失）
    lock.acquire(lock.resourceKeyForProfile(task.profileId), { executionId: execution.id, taskId: task.id });
  }
  // B.13：从 checkpoint.restore 重建恢复状态（结构化，含 url/step/lastSuccessfulAction），
  // runtime recover 时只导航回 url 并跳过已 SUCCESS 步骤，不重复已成功动作。
  const cp = checkpoint.restore(task.id);
  task.currentExecutionId = execution.id;
  task.recoveryUrl = (cp && cp.url) || task.targetUrl || null;
  store.upsert('aiTasks', task);

  events.emit({ taskId: task.id, executionId: execution.id, type: 'execution.recovered', payload: { reason: 'recovery', checkpointUrl: task.recoveryUrl } });
  _setTaskState(task, 'RUNNING');
  _kick(task.id); // 触发 runtime：ensureBrowser 会 relaunch + 导航到 recoveryUrl 后继续
  return task;
}

function cancel(id) {
  const task = getTask(id);
  if (!task) throw new Error('任务不存在');
  if (['SUCCESS', 'CANCELLED', 'FAILED'].includes(task.status)) return task; // 终态幂等
  _setTaskState(task, 'CANCELLED', { error: '用户取消' });
  task.finishedAt = Date.now();
  store.upsert('aiTasks', task);
  if (task.currentExecutionId) {
    recorder.markFinished(task.currentExecutionId, 'CANCELLED', '用户取消');
    lock.releaseAllForExecution(task.currentExecutionId);
  }
  queue.markDone(task.id, 'CANCELLED');
  events.emit({ taskId: task.id, executionId: task.currentExecutionId, type: 'task.cancelled', payload: {} });
  return task;
}

function retry(id) {
  const task = getTask(id);
  if (!task) throw new Error('任务不存在');
  if (!['FAILED', 'CANCELLED'].includes(task.status)) {
    throw new Error(`任务状态 ${task.status} 不允许重试`);
  }
  // 清理旧计划/尝试，回退到 PLANNING（FAILED→PLANNING 合法），再走一次 start
  store.write('aiSteps', store.read('aiSteps', []).filter((s) => s.taskId !== id));
  store.write('aiAttempts', store.read('aiAttempts', []).filter((a) => {
    const st = store.find('aiSteps', a.stepId);
    return !st || st.taskId !== id;
  }));
  _setTaskState(task, 'PLANNING');
  task.error = null;
  task.finishedAt = null;
  store.upsert('aiTasks', task);
  return start(id);
}

// ---- 完成 / 失败 ----
function complete(id, result) {
  const task = getTask(id);
  if (!task) throw new Error('任务不存在');
  _setTaskState(task, 'SUCCESS');
  task.finishedAt = Date.now();
  task.result = result || null;
  store.upsert('aiTasks', task);
  if (task.currentExecutionId) {
    recorder.markFinished(task.currentExecutionId, 'SUCCESS', null);
    lock.releaseAllForExecution(task.currentExecutionId);
  }
  queue.markDone(task.id, 'SUCCESS');
  events.emit({ taskId: task.id, executionId: task.currentExecutionId, type: 'task.completed', payload: { result: !!result } });
  // Phase 3.2 消费点：成功任务提炼为 Flow Memory（状态经验，非固定点击脚本）
  try {
    const flowMemory = require('./intelligence/flowMemory');
    flowMemory.recordFlowFromTask(task);
  } catch (e) { /* 经验落库失败不影响任务结果 */ }
  // Phase 3.4 消费点：成功 → 更新 Profile 评分 / 站点成功率 / 生命周期
  try {
    const site = siteOfUrl(task.targetUrl);
    if (task.profileId && site) require('./intelligence/profile/profileAnalyzer').recordTaskOutcome(task.profileId, site, true);
  } catch (e) { /* 评分落库失败不影响任务结果 */ }
  return task;
}

// 从 URL 提取 site（hostname），用于经验落库
function siteOfUrl(url) {
  if (!url) return null;
  try { return new URL(url).hostname || null; } catch (e) { return null; }
}

function fail(id, error, opts = {}) {
  const task = getTask(id);
  if (!task) throw new Error('任务不存在');
  const terminalState = opts.escalate ? 'HUMAN_ESCALATION' : 'FAILED';
  _setTaskState(task, terminalState, { error: String((error && error.message) || error || '任务失败').slice(0, 500) });
  task.finishedAt = Date.now();
  store.upsert('aiTasks', task);
  if (task.currentExecutionId) {
    recorder.markFinished(task.currentExecutionId, terminalState, task.error);
    lock.releaseAllForExecution(task.currentExecutionId);
  }
  queue.markDone(task.id, terminalState);
  events.emit({ taskId: task.id, executionId: task.currentExecutionId, type: 'task.failed', payload: { error: task.error, escalate: !!opts.escalate } });
  // Phase 3.4 消费点：失败 → 更新 Profile 评分（恶化降级，不删除）
  try {
    const site = siteOfUrl(task.targetUrl);
    if (task.profileId && site) require('./intelligence/profile/profileAnalyzer').recordTaskOutcome(task.profileId, site, false);
  } catch (e) { /* 评分落库失败不影响任务结果 */ }
  return task;
}

// Phase 5.8：人工介入升级为显式终态（调度/观察层可区分 FAILED 与 HUMAN_ESCALATION）。
// 与 pauseForHuman 的区别：pauseForHuman 是等待人工，可 resume；escalate 是终态，不再自动 resume。
// Phase 12B §十四：持久化 escalationKind（credential/permission/payment/CRITICAL/verification/
// resolver/execution/recovery/timeout），填补此前 observability 缺口。
function inferEscalationKind(reason, errorMsg) {
  const s = `${reason || ''} ${errorMsg || ''}`.toLowerCase();
  if (s.includes('vil') || s.includes('verify') || s.includes('verification')) return 'verification';
  if (s.includes('critical') || s.includes('autopayment')) return 'CRITICAL';
  if (s.includes('payment') || s.includes('password')) return 'payment';
  if (s.includes('credential') || s.includes('approval') || s.includes('permission')) return 'credential';
  if (s.includes('element_not_found') || s.includes('resolver') || s.includes('relocat')) return 'resolver';
  if (s.includes('timeout') || s.includes('repair_timeout')) return 'timeout';
  if (s.includes('recover')) return 'recovery';
  if (s.includes('execut') || s.includes('action')) return 'execution';
  return 'verification';
}
function escalate(id, error, opts = {}) {
  const task = getTask(id);
  if (!task) throw new Error('任务不存在');
  const errMsg = String((error && error.message) || error || '需人工介入').slice(0, 500);
  _setTaskState(task, 'HUMAN_ESCALATION', { error: errMsg });
  task.finishedAt = Date.now();
  task.escalationKind = opts.kind || inferEscalationKind(opts.reason, errMsg);
  store.upsert('aiTasks', task);
  if (task.currentExecutionId) {
    recorder.markFinished(task.currentExecutionId, 'HUMAN_ESCALATION', task.error);
    lock.releaseAllForExecution(task.currentExecutionId);
  }
  queue.markDone(task.id, 'HUMAN_ESCALATION');
  events.emit({ taskId: task.id, executionId: task.currentExecutionId, type: 'task.escalated', payload: { error: task.error, reason: opts.reason || null, escalationKind: task.escalationKind } });
  return task;
}

module.exports = {
  createTask, getTask, listTasks, deleteTask, touch,
  start, pauseForHuman, resume, cancel, retry, complete, fail, escalate,
  attachPlan, revisePlan, approve, reject, modify, recover,
  setExecutor, isTaskTerminal,
};

function isTaskTerminal(s) { return tsm.isTaskTerminal(s); }
