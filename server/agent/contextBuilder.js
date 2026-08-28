'use strict';

// Context Builder：构造 LLM 上下文（脱敏 + 限长）。
// 链路：Observation → ContextBuilder → Planner → Runtime。
// 本模块是 Planner 的唯一上下文来源（runtime.resolvePlan 会先 build 再交给 planner）。
// 输入：task / observation / steps(已完成步骤) / checkpoint(断点) / errorHistory(历史错误) / verification(验证态) / budget。
// 必须包含（产品契约）：objective、observation summary、previous steps、checkpoint、error history、verification state。
// 禁止 password/cookie/token/card 进入 Context。

const context = require('./context'); // 复用 redact/truncate 工具
const memory = require('./memory');
const sites = require('./sites');
const budget = require('./budget');

const MAX_TEXT = 4000;
const MAX_ELEMENTS = 30;
const MAX_HISTORY = 15;
const MAX_STEPS = 25;
const MAX_ERRORS = 10;

function build({ task, observation, steps, checkpoint, errorHistory, verification, execution, error, budgetCfg }) {
  const red = context.redactString;

  // 站点知识 + 历史成功策略建议
  let knowledge = null;
  try {
    if (observation && observation.url) {
      knowledge = sites.knowledgeFor(observation.url);
      const suggestion = memory.suggest(observation.url, error ? error.code : null);
      if (suggestion) knowledge.repairSuggestion = suggestion;
    }
  } catch (e) {}

  // 1) objective
  const taskCtx = task ? {
    id: task.id,
    objective: task.objective,
    targetUrl: task.targetUrl,
    executionMode: task.executionMode,
    status: task.status,
  } : null;

  // 2) observation summary（页面快照）
  const pageCtx = observation ? {
    url: observation.url || '',
    title: observation.title || '',
    textSummary: context.truncate(red(observation.textSummary || ''), MAX_TEXT),
    // Phase 9 P4-A — Planner 契约编造修复。
    // 缺陷：observation 采集 17 个字段，这里只映射了 7 个，**丢掉了 id 与 ariaLabel**。
    // 后果（phase68/phase9 20-task 回放实测）：
    //   失败 attempt 中 48.7% 是 CONTRACT_SELECTOR_MISMATCH —— Planner 写出的
    //   element_present 契约在页面上根本不存在。例如 scraping/list.html 的真实 id 是
    //   `list`，Planner 却编造出 `member-list`；saas/login.html 真实字段是 `email`，
    //   Planner 却写 `input[name='username']`。Planner 看不见 id，只能猜。
    // 修复：把 id / ariaLabel 回灌 Planner 上下文，使 element 类契约从「猜测」变为「读取」。
    // 红线：仅增加上下文可见性，不改任何验证阈值、不改判定、不绕过 Guard。
    elements: (observation.elements || []).slice(0, MAX_ELEMENTS).map((e) => ({
      role: e.role, tag: e.tag, type: e.type || null, name: e.name || null,
      id: e.id || null,
      text: context.truncate(red(e.text || ''), 120),
      placeholder: e.placeholder ? context.truncate(red(e.placeholder), 80) : null,
      label: e.label ? context.truncate(red(e.label), 80) : null,
      ariaLabel: e.ariaLabel ? context.truncate(red(e.ariaLabel), 80) : null,
    })),
    errors: (observation.errors || []).slice(0, 5),
  } : null;

  // 3) previous steps（已规划/已执行步骤，带状态）
  const stepsCtx = Array.isArray(steps) ? steps.slice(-MAX_STEPS).map((s) => ({
    id: s.id,
    type: s.type || (s.action && s.action.type) || null,
    status: s.status || null,
    description: s.description || (s.action && s.action.type) || null,
    outcome: s.outcome || (s.lastVerification || null),
  })) : [];

  // 4) checkpoint（断点续跑状态）
  const checkpointCtx = checkpoint ? {
    url: checkpoint.url || null,
    stepId: checkpoint.stepId || null,
    lastSuccessfulAction: checkpoint.lastSuccessfulAction || null,
    lastVerifiedState: checkpoint.lastVerifiedState || null,
  } : null;

  // 5) error history（历史错误数组，非单一 currentError）
  const errorHistoryCtx = Array.isArray(errorHistory)
    ? errorHistory.slice(-MAX_ERRORS).map((e) => ({
        code: e && e.code,
        message: e && e.message ? context.redactString(String(e.message)).slice(0, 200) : null,
        at: e && (e.at || e.ts) ? (e.at || e.ts) : null,
      }))
    : [];

  // 6) verification state（当前验证态）
  const verificationCtx = verification
    ? { type: verification.type || null, success: verification.success != null ? !!verification.success : null, confidence: verification.confidence != null ? verification.confidence : null }
    : null;

  // 兼容旧字段：execution.actions 形式的历史（runtime 执行轨迹）
  const historyCtx = execution ? (execution.actions || []).slice(-MAX_HISTORY).map((a) => ({
    tool: a.tool, status: a.status,
    summary: a.actionSummary ? { type: a.actionSummary.type, target: a.actionSummary.target } : null,
    error: a.error ? context.truncate(red(a.error), 200) : null,
  })) : [];

  const budgetCtx = budgetCfg ? (() => {
    const b = budget.get(budgetCfg.taskId);
    return b ? { usedTokens: b.usedTokens, maxTokens: b.maxTokens, usedCalls: b.usedCalls, maxLLMCalls: b.maxLLMCalls, usedCost: b.usedCost, maxCost: b.maxCost } : null;
  })() : null;

  return {
    task: taskCtx,                                  // objective
    page: pageCtx,                                  // observation summary
    steps: stepsCtx,                                // previous steps
    checkpoint: checkpointCtx,                      // checkpoint
    errorHistory: errorHistoryCtx,                  // error history
    verification: verificationCtx,                  // verification state
    history: historyCtx,                            // 兼容：执行轨迹
    budget: budgetCtx,
    siteKnowledge: knowledge,
    currentError: error ? { code: error.code, message: context.truncate(red(error.message), 300) } : null,
  };
}

module.exports = { build };
