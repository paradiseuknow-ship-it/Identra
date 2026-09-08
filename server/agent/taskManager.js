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
    // STEP 1：constraints 此前被创建路径静默丢弃（grep 全仓 0 处写入），
    // 而 runtime.resolvePlan 与 planner 都会读 task.constraints —— 属于"契约编造"的结构性成因之一：
    // Planner 在 prompt 里渲染「约束：」却永远拿不到约束。这里补齐落库。
    constraints: Array.isArray(input.constraints) ? input.constraints : [],
    secretRefs: Array.isArray(input.secretRefs) ? input.secretRefs : [],
    dependsOn: Array.isArray(input.dependsOn) ? input.dependsOn : [], // Phase 12B §T16 任务依赖
    // CAP-K2：Router 决策摘要（profileId/flowId/expectedSuccess/warnings）随任务落库，
    // 由 contextBuilder.build 读出进 Planner 上下文。null = 未咨询 Router 或无有效决策。
    routerHints: input.routerHints || null,
    // CAP-O1 §10：资源归属（由服务端身份层盖章；直调 createTask 的旧路径为 null，不影响既有测试）
    workspaceId: input.workspaceId || null,
    createdBy: input.createdBy || null,
    // CAP-M1：来源定时计划（scheduleTrigger.fireSchedule 盖章；直调旧路径 null）
    scheduleId: input.scheduleId || null,
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

// C67b：attempt 清理原实现先删 steps 再用 store.find('aiSteps', a.stepId) 反查 —— 被删
// step 永远查不到（!st → 保留），过滤条件恒真 = 死逻辑；而 attempt 自 v0.2.2 起自带
// taskId 字段（runtime.js errorHistory 也按 taskId 消费）。改为删除前快照 stepIds：
// taskId 命中直接删；pre-v0.2.2 的 taskId=null 孤儿经 stepId 命中一并删。
function _purgeTaskEvidence(taskId) {
  const stepIds = new Set(store.read('aiSteps', []).filter((s) => s.taskId === taskId).map((s) => s.id));
  store.write('aiSteps', store.read('aiSteps', []).filter((s) => s.taskId !== taskId));
  store.write('aiAttempts', store.read('aiAttempts', []).filter((a) => a.taskId !== taskId && !stepIds.has(a.stepId)));
  return stepIds.size;
}

function deleteTask(id) {
  const t = getTask(id);
  if (!t) return null;
  if (t.status === 'RUNNING' || t.status === 'PREPARING') {
    throw new Error('任务运行中，请先取消');
  }
  if (t.currentExecutionId) lock.releaseAllForExecution(t.currentExecutionId);
  store.remove('aiTasks', id);
  _purgeTaskEvidence(id); // C67b：此前只删 steps，aiAttempts 永久孤儿残留
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
    // C67b：acquire 返回值此前未检查（start() 有完整失败处理，recover() 没有）——
    // 崩溃后用户在同一 profile 上启动了新任务时，锁被新 execution 持有，recover 静默
    // 继续会双开同一 profile（C64 同族）且留下孤儿 RUNNING execution 记录。
    const res = lock.acquire(lock.resourceKeyForProfile(task.profileId), { executionId: execution.id, taskId: task.id });
    if (!res.ok) {
      recorder.markFinished(execution.id, 'FAILED', res.reason);
      try { _setTaskState(task, 'FAILED', { error: '恢复失败(资源锁): ' + res.reason }); } catch (_) {}
      task.finishedAt = Date.now();
      store.upsert('aiTasks', task);
      queue.markDone(task.id, 'FAILED');
      events.emit({ taskId: task.id, executionId: execution.id, type: 'task.failed', payload: { error: task.error, stage: 'recover_lock' } });
      throw new Error(`恢复失败: ${res.reason}`);
    }
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

function cancel(id, reason) {
  const task = getTask(id);
  if (!task) throw new Error('任务不存在');
  // B 类口径修复（2026-08-31）：deadline 取消与用户取消必须在 error 文案上可区分，
  // 否则统计把 harness 超时取消错记为「用户取消」。可选 reason，缺省保持旧语义。
  const cancelReason = String(reason || '用户取消').slice(0, 200);
  // 终态幂等（CAP-K3 对齐：旧守卫漏了 HUMAN_ESCALATION —— 对升级终态再 cancel 会撞非法转换抛错）
  if (tsm.isTaskTerminal(task.status)) return task;
  // A 类 cancel deadline（2026-08-31）：cancel 自身同步链可能被事件循环级卡死拖住
  // （headless 假死占死线程时，同进程内任何调用都无法执行——进程内定时器同样失效，
  // 该场景的唯一防线是进程级隔离 + 外部 hard deadline 树杀，见 phase12_task_worker / watchdog）。
  // 进程内能保证的是：cancel 的收尾步骤逐段 fail-open —— 任一下游（recorder/lock/queue/events）
  // 抛错都不阻断终态落地，且留下 cancel_timeout 事件供外部看门狗/审计归因。
  const cancelDeadlineMs = 5000;
  const deadline = setTimeout(() => {
    try {
      events.emit({ taskId: task.id, executionId: task.currentExecutionId, type: 'task.cancel_timeout', payload: { deadlineMs: cancelDeadlineMs } });
    } catch (e) { /* 事件通道失效时无处可报，仅保底不抛 */ }
  }, cancelDeadlineMs);
  try { deadline.unref(); } catch (e) {}
  try {
    _setTaskState(task, 'CANCELLED', { error: cancelReason });
    task.finishedAt = Date.now();
    task.cancelledAt = Date.now();
    store.upsert('aiTasks', task);
  } catch (e) {
    try { events.emit({ taskId: task.id, type: 'task.cancel_timeout', payload: { stage: 'state_write', error: String(e.message || e).slice(0, 200) } }); } catch (_) {}
    throw e;
  }
  if (task.currentExecutionId) {
    try { recorder.markFinished(task.currentExecutionId, 'CANCELLED', cancelReason); } catch (e) {
      try { events.emit({ taskId: task.id, type: 'task.cancel_timeout', payload: { stage: 'recorder_markFinished', error: String(e.message || e).slice(0, 200) } }); } catch (_) {}
    }
    try { lock.releaseAllForExecution(task.currentExecutionId); } catch (e) {
      try { events.emit({ taskId: task.id, type: 'task.cancel_timeout', payload: { stage: 'lock_release', error: String(e.message || e).slice(0, 200) } }); } catch (_) {}
    }
  }
  try { queue.markDone(task.id, 'CANCELLED'); } catch (e) {
    try { events.emit({ taskId: task.id, type: 'task.cancel_timeout', payload: { stage: 'queue_markDone', error: String(e.message || e).slice(0, 200) } }); } catch (_) {}
  }
  try { events.emit({ taskId: task.id, executionId: task.currentExecutionId, type: 'task.cancelled', payload: {} }); } catch (e) {
    // task.cancelled 广播失败不影响终态（任务已 CANCELLED 落库）；记录超时事件供审计
    try { events.emit({ taskId: task.id, type: 'task.cancel_timeout', payload: { stage: 'cancelled_emit', error: String(e.message || e).slice(0, 200) } }); } catch (_) {}
  }
  clearTimeout(deadline);
  return task;
}

function retry(id) {
  const task = getTask(id);
  if (!task) throw new Error('任务不存在');
  if (!['FAILED', 'CANCELLED'].includes(task.status)) {
    throw new Error(`任务状态 ${task.status} 不允许重试`);
  }
  // 清理旧计划/尝试，回退到 PLANNING（FAILED→PLANNING 合法），再走一次 start
  _purgeTaskEvidence(id); // C67b：旧实现引用刚删除的 steps 反查，attempt 清理恒不生效
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
  // CAP-K3 幂等守卫：状态机对「同状态转换」直接放行（transitionTask 的 next===current 短路），
  // 若不挡，complete 对已 SUCCESS 任务重入会整函数体重跑 —— 事件重发 + flowMemory/profileAnalyzer/
  // siteMemory 全部双计。终态重入一律原样返回（与 cancel 的既有守卫同语义）。
  if (tsm.isTaskTerminal(task.status)) return task;
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
  // CAP-K3 消费点：Site Memory 成功侧回写（此前 recordTaskResult 生产链零调用，只有 Phase 3.1 测试在调）。
  // 成功依据 = 系统已认可的业务结果：runtime 只在全部 step 通过业务验证（B.4 守卫挡 silent-pass）后才调
  // complete —— 这里绝不吃 action_success。flowName 取任务目标（与 flowMemory 的 goal 同源），avgSteps 取
  // 真实完成步数；均缺失则退化为纯 ok 计数，绝不臆造。
  try {
    const site = siteOfUrl(task.targetUrl);
    if (site) {
      require('./intelligence/siteMemory').recordTaskResult(site, {
        ok: true,
        flowName: task.planGoal || task.objective || null,
        avgSteps: (task.result && task.result.completedSteps) || undefined,
      });
    }
  } catch (e) { /* 经验落库失败不影响任务结果 */ }
  return task;
}

// 从 URL 提取 site（hostname），用于经验落库
function siteOfUrl(url) {
  if (!url) return null;
  try { return new URL(url).hostname || null; } catch (e) { return null; }
}

// CAP-K1：runtime.resolvePlan 命中高置信度历史 flow 时，把 flowId 记到任务上，
// 供 fail/escalate 做失败反馈（降置信度 → 下次同目标降级 LLM 规划）。
function markFlowUsed(id, flowId, confidence) {
  const task = getTask(id);
  if (!task) return null;
  task.flowUsedId = flowId || null;
  task.flowConfidence = typeof confidence === 'number' ? confidence : null;
  store.upsert('aiTasks', task);
  return task;
}

// CAP-K1 失败反馈：若本次执行复用了历史 flow，记录一次失败。
// 修复「recordOutcomeFlow 生产链零调用、置信度只涨不跌」的结构性缺陷 ——
// 没有这一环，过期 flow（站点改版）会被永久重放；有了它，一次失败即跌破 0.85 阈值降级 LLM。
function recordFlowFailure(task) {
  try {
    if (task && task.flowUsedId) require('./intelligence/flowMemory').recordOutcomeFlow(task.flowUsedId, false);
  } catch (e) { /* 经验反馈失败不影响任务结果 */ }
}

function fail(id, error, opts = {}) {
  const task = getTask(id);
  if (!task) throw new Error('任务不存在');
  // CAP-K3 幂等守卫（与 complete 同因：同状态重入会整函数体重跑、双计经验反馈）
  if (tsm.isTaskTerminal(task.status)) return task;
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
  recordFlowFailure(task); // CAP-K1：复用的 flow 也吃一次失败反馈
  // Phase 3.4 消费点：失败 → 更新 Profile 评分（恶化降级，不删除）
  try {
    const site = siteOfUrl(task.targetUrl);
    if (task.profileId && site) require('./intelligence/profile/profileAnalyzer').recordTaskOutcome(task.profileId, site, false);
  } catch (e) { /* 评分落库失败不影响任务结果 */ }
  // CAP-K3 消费点：Site Memory 失败侧回写（现有契约 { ok:false, flowName, failureType }，不新增第二套 schema）。
  // flowName 与成功侧同源（任务目标）—— 否则成功率聚合只吃成功不吃失败，永远虚高。
  // failureType 只取调用方显式原因码（如 CREDENTIAL_UNAVAILABLE / VIL:VERIFY_FAILED），绝不从自由错误
  // 文本臆造类别 —— 没有显式原因就少记，宁可缺不污染。escalate()/cancel() 不回写：升级与取消不是
  // 「已证实的失败结果」，宁可少记不误记（成功侧红线同理）。
  try {
    const site = siteOfUrl(task.targetUrl);
    if (site) {
      require('./intelligence/siteMemory').recordTaskResult(site, {
        ok: false,
        flowName: task.planGoal || task.objective || null,
        failureType: opts.reason || null,
      });
    }
  } catch (e) { /* 经验落库失败不影响任务结果 */ }
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
  // CAP-K3 幂等守卫：终态重入原样返回（否则 recordFlowFailure/事件会被双计）
  if (tsm.isTaskTerminal(task.status)) return task;
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
  recordFlowFailure(task); // CAP-K1：升级同视为未完成目标，复用的 flow 也吃失败反馈（置信度有界自我修正）
  return task;
}

module.exports = {
  createTask, getTask, listTasks, deleteTask, touch,
  start, pauseForHuman, resume, cancel, retry, complete, fail, escalate,
  attachPlan, revisePlan, approve, reject, modify, recover,
  setExecutor, isTaskTerminal, markFlowUsed,
};

function isTaskTerminal(s) { return tsm.isTaskTerminal(s); }
