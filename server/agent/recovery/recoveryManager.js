'use strict';

// Recovery Manager（Phase 2.1 确定性恢复，v2 使用策略文件）。
// ACTION_FAILED → errorClassifier → recovery/policy 解析策略 → strategies/* 执行。
// 只做确定性恢复；AI 诊断由 Phase 2.2 diagnosis/ 负责（本模块不调用 LLM）。

const { classify } = require('./errorClassifier');
const policy = require('./policy');
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

// 执行"动作前恢复"策略序列（wait / reload / back）
async function runPreAction(task, step, attempts, sequence) {
  const seq = sequence[Math.min(Math.max(attempts - 1, 0), sequence.length - 1)];
  const exec = (type, extra = {}) => tools.execute({
    action: { type, target: { role: 'page' }, risk: 'LOW', verification: { type: 'none' }, timeoutMs: 8000, ...extra },
    taskId: task.id, executionId: task.currentExecutionId, stepId: step.id, attemptId: null,
  });
  if (seq === 'wait') { try { await exec('wait', { timeoutMs: 800 }); } catch (e) {} }
  else if (seq === 'reload') { try { await exec('reload'); } catch (e) {} }
  else if (seq === 'back') { try { await exec('back'); } catch (e) {} }
  else if (seq === 'back+reload') { try { await exec('back'); } catch (e) {} try { await exec('reload'); } catch (e) {} }
  events.emit({ taskId: task.id, executionId: task.currentExecutionId, stepId: step.id, type: 'agent.repairing', payload: { strategy: seq } });
}

// 一次恢复尝试：返回 { category, confidence, evidence, action?, crash?, recoverable? }
async function attempt(task, step, error, ctx) {
  const c = classify(error, ctx);
  const category = c.type;
  const attempts = stepManager.listAttempts(step.id).length; // 已失败尝试次数
  const strategyName = policy.resolve(category);
  events.emit({ taskId: task.id, executionId: ctx.executionId, stepId: step.id, type: 'agent.diagnosing', payload: { category, confidence: c.confidence } });

  // 不可自动恢复
  if (!strategyName) {
    const nonRecoverable = ['CREDENTIAL_MISSING', 'APPROVAL_REQUIRED'];
    return { category, confidence: c.confidence, evidence: c.evidence, action: null, recoverable: !nonRecoverable.includes(category) };
  }

  if (category === 'BROWSER_CRASH') {
    return { category, confidence: c.confidence, evidence: c.evidence, action: null, crash: true };
  }

  const mod = STRATEGY_MODS[strategyName] || generic;
  let action = step.action;
  if (mod.getAction) {
    action = mod.getAction(step, attempts);
  }
  const preSeq = mod.getPreActions ? mod.getPreActions(attempts) : [];
  if (preSeq.length) await runPreAction(task, step, attempts, preSeq);

  return { category, confidence: c.confidence, evidence: c.evidence, action, recoverable: true };
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
    if (t.status === 'RUNNING' && age <= ms) continue; // 双保险（已在上面判断）
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

module.exports = { attempt, classify, recoverInterruptedTasks, scanStaleTasks };
