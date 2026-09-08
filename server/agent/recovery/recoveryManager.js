'use strict';

// Recovery Manager（Phase 2.1 确定性恢复，v2 使用策略文件）。
// ACTION_FAILED → errorClassifier → recovery/policy 解析策略 → strategies/* 执行。
// 只做确定性恢复；AI 诊断由 Phase 2.2 diagnosis/ 负责（本模块不调用 LLM）。

const { classify } = require('./errorClassifier');
const policy = require('./policy');
const diagnoser = require('../diagnosis/failureDiagnoser');
const elementMissing = require('./strategies/elementMissing');
const timeout = require('./strategies/timeout');
const navigation = require('./strategies/navigation');
const verify = require('./strategies/verify');
const generic = require('./strategies/generic');
const tools = require('../tools');
const events = require('../events');
const stepManager = require('../stepManager');
const taskManager = require('../taskManager');
const store = require('../store');
const checkpoint = require('../checkpoint');
const recorder = require('../recorder');
const lock = require('../lock');

const STRATEGY_MODS = {
  elementMissing,
  timeout,
  navigation,
  verify,
  generic,
};

// 执行"动作前恢复"策略序列（wait / waitLong / reload / back / back+reload）
//
// stateResetByRepair 跟踪（2026-08-31，分类纯度修复）：
// reload/back 会重置页面状态（清空未提交表单、重置 SPA 客户端状态）。此后重试动作产生的
// 页面错误文案（如空表单重新提交触发的「邮箱或密码错误」）是 repair 的次生结果，
// 不得作为业务性「不可重试」判定（否则工程失败被误升级为可信升级，污染 POLICY_BLOCK 口径）。
// 此处按 executionId::stepId 记录发生过状态重置型 repair 的 step，诊断时作为
// stateResetByRepair 信号传入 failureDiagnoser。Set 仅存 id 字符串、量级=step 数，
// 超上限整体清空（宁可漏判一次也不积累泄漏）。
const STATE_RESET_REPAIR_LIMIT = 5000;
const stateResetRepairs = new Set();

function resetRepairKey(task, step) {
  return String((task && (task.currentExecutionId || task.id)) || '?') + '::' + String((step && step.id) || '?');
}
function markStateResetRepair(task, step) {
  try {
    if (stateResetRepairs.size >= STATE_RESET_REPAIR_LIMIT) stateResetRepairs.clear();
    stateResetRepairs.add(resetRepairKey(task, step));
  } catch (e) {}
}
function hasStateResetRepair(task, step) {
  try { return stateResetRepairs.has(resetRepairKey(task, step)); } catch (e) { return false; }
}

async function runPreAction(task, step, attempts, sequence) {
  const seq = sequence[Math.min(Math.max(attempts - 1, 0), sequence.length - 1)];
  const exec = (type, extra = {}) => tools.execute({
    action: { type, target: { role: 'page' }, risk: 'LOW', verification: { type: 'none' }, timeoutMs: 8000, ...extra },
    taskId: task.id, executionId: task.currentExecutionId, stepId: step.id, attemptId: null,
  });
  if (seq === 'wait') { try { await exec('wait', { timeoutMs: 800 }); } catch (e) {} }
  // waitLong：限流/5xx/异步一致性场景下的实质等待（800ms 对 429 退避毫无意义）
  else if (seq === 'waitLong') { try { await exec('wait', { timeoutMs: 3000 }); } catch (e) {} }
  else if (seq === 'reload') {
    try { await exec('reload'); } catch (e) {}
    markStateResetRepair(task, step);
  }
  else if (seq === 'back') {
    try { await exec('back'); } catch (e) {}
    markStateResetRepair(task, step);
  }
  else if (seq === 'back+reload') {
    try { await exec('back'); } catch (e) {} try { await exec('reload'); } catch (e) {}
    markStateResetRepair(task, step);
  }
  events.emit({ taskId: task.id, executionId: task.currentExecutionId, stepId: step.id, type: 'agent.repairing', payload: { strategy: seq } });
}

// 一次恢复尝试：返回 { category, confidence, evidence, action?, crash?, recoverable?, escalate?, diagnosis }
//
// STEP 3：每次恢复前先跑统一诊断，把散落在 5 处的证据（错误码 / VIL 失败类型 / 网络响应 /
// 页面文本 / 观察 diff / 页面能力）收敛成一个 Diagnosis，再交给策略决定做什么。
async function attempt(task, step, error, ctx) {
  const c = classify(error, ctx || {});
  const category = c.type;
  const attempts = stepManager.listAttempts(step.id).length; // 已失败尝试次数
  const strategyName = policy.resolve(category);
  events.emit({ taskId: task.id, executionId: ctx && ctx.executionId, stepId: step.id, type: 'agent.diagnosing', payload: { category, confidence: c.confidence } });

  // ── 统一诊断（STEP 3）──
  // 输入取自调用方传来的现场观察（runtime 传入 r.observation）；缺失时诊断降级为
  // 仅凭错误码的保守推断，绝不抛异常、绝不阻塞恢复链路。
  let diagnosis = null;
  try {
    diagnosis = diagnoser.fromObservation(error, category, ctx && ctx.observation, {
      vilFailureType: (ctx && ctx.vilFailureType) || (error && error.failureType) || null,
      pageState: (ctx && ctx.pageState) || null,
      diff: (ctx && ctx.diff) || null,
      attempted: ctx && ctx.attempted !== false,
      sinceTs: (ctx && ctx.sinceTs) || 0,
      stateResetByRepair: hasStateResetRepair(task, step),
      // 动作上下文守卫：凭据类 page.text 证据需与本步动作一致（run5 rw.026 误标实证）
      currentAction: (step && step.action) || null,
    });
  } catch (e) {
    diagnosis = null;
  }
  if (diagnosis) {
    events.emit({
      taskId: task.id, executionId: ctx && ctx.executionId, stepId: step.id,
      type: 'agent.diagnosed',
      payload: {
        rootCause: diagnosis.rootCause, retryPolicy: diagnosis.retryPolicy,
        confidence: diagnosis.confidence, silentFailure: diagnosis.silentFailure,
        findings: (diagnosis.findings || []).slice(0, 3).map((f) => f.code),
      },
    });
  }

  // ── 统一升级门（STEP 4）──
  // 诊断判定「继续重试不可能成功」时，任何策略都不再做前置动作、不产出候选动作，
  // 由 runtime 收口升级（带根因）。验证码 / OTP / 权限 / 支付被拒 / 凭据错误 / 记录重复
  // 都属于此类 —— 重试 3 次只会把同一个必然失败的请求再发 3 遍，并可能放大风控风险。
  if (diagnosis && diagnosis.retryPolicy === 'escalate') {
    return {
      category, confidence: c.confidence,
      evidence: c.evidence.concat(diagnosis.evidence),
      action: null, recoverable: false, escalate: true, diagnosis,
    };
  }

  // 不可自动恢复
  if (!strategyName) {
    const nonRecoverable = ['CREDENTIAL_MISSING', 'APPROVAL_REQUIRED'];
    return { category, confidence: c.confidence, evidence: c.evidence, action: null, recoverable: !nonRecoverable.includes(category), diagnosis };
  }

  if (category === 'BROWSER_CRASH') {
    return { category, confidence: c.confidence, evidence: c.evidence, action: null, crash: true, diagnosis };
  }

  const mod = STRATEGY_MODS[strategyName] || generic;
  const strategyCtx = { diagnosis };
  let action = step.action;
  if (mod.getAction) {
    action = mod.getAction(step, attempts, strategyCtx) || step.action;
  }
  const preSeq = mod.getPreActions ? mod.getPreActions(attempts, strategyCtx) : [];
  if (preSeq.length) await runPreAction(task, step, attempts, preSeq);

  return { category, confidence: c.confidence, evidence: c.evidence, action, recoverable: true, diagnosis };
}

// ---- 启动恢复：扫描被中断任务 → taskManager.recover ----
function recoverInterruptedTasks() {
  const tasks = store.read('aiTasks', []);
  const recovered = [];
  for (const t of tasks) {
    if (['RUNNING', 'HEALING', 'RECOVERING'].includes(t.status)) {
      try {
        taskManager.recover(t.id);
        recovered.push(t.id);
      } catch (e) {
        console.warn('[recovery] 恢复失败:', t.id, String(e.message || e).slice(0, 120));
      }
    }
  }
  if (recovered.length) console.log('[recovery] 已恢复被中断任务:', recovered.join(', '));
  return recovered;
}

// ---- Phase 12B §I7：周期 stale-task 扫描（仅恢复真正卡死的任务，不触碰健康 RUNNING）----
// 判定：HEALING/RECOVERING 超过 staleMs，或 RUNNING 超过 staleMs 且无近期活动（lastActivityAt 心跳）。
function scanStaleTasks(staleMs) {
  const ms = staleMs || (30 * 60 * 1000);
  const now = Date.now();
  const tasks = store.read('aiTasks', []);
  const recovered = [];
  for (const t of tasks) {
    if (!['RUNNING', 'HEALING', 'RECOVERING'].includes(t.status)) continue;
    const last = t.lastActivityAt || t.startedAt || t.createdAt || 0;
    const age = now - last;
    if (age <= ms) continue;
    try {
      taskManager.recover(t.id);
      recovered.push({ id: t.id, status: t.status, ageMs: age });
    } catch (e) {
      console.warn('[recovery] stale 恢复失败:', t.id, String(e.message || e).slice(0, 120));
    }
  }
  if (recovered.length) console.log('[recovery] 已恢复 stale 任务:', JSON.stringify(recovered));
  return recovered;
}

// hasStateResetRepair 供测试与审计断言「真正会执行的那份东西」；
// runPreAction 导出供针对性故障注入测试；_stateResetRepairs 仅测试用（下划线前缀，非公开契约）。
module.exports = { attempt, classify, recoverInterruptedTasks, scanStaleTasks, hasStateResetRepair, runPreAction, _stateResetRepairs: stateResetRepairs };
