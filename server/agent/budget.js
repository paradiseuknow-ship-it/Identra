'use strict';

// AI Cost / Token 预算控制。
// 每个任务独立预算：maxTokens / maxLLMCalls / maxCost。超过任一上限 => 暂停（PAUSED 或告警）。
// 防 100 个环境同时跑时 LLM 成本爆炸。

const budgets = new Map(); // taskId -> { maxTokens, maxLLMCalls, maxCost, usedTokens, usedCalls, usedCost }

const DEFAULT_BUDGET = {
  maxTokens: 50000,
  maxLLMCalls: 50,
  maxCost: 0.2, // USD
};

function createBudget(taskId, cfg) {
  const b = { ...DEFAULT_BUDGET, ...(cfg || {}) };
  budgets.set(taskId, {
    maxTokens: b.maxTokens,
    maxLLMCalls: b.maxLLMCalls,
    maxCost: b.maxCost,
    usedTokens: 0,
    usedCalls: 0,
    usedCost: 0,
  });
  return budgets.get(taskId);
}

function spend(taskId, usage = {}) {
  const b = budgets.get(taskId);
  if (!b) return { ok: false, reason: '无预算记录' };
  b.usedTokens += usage.tokens || 0;
  b.usedCalls += usage.calls || 1;
  b.usedCost += usage.cost || 0;
  return check(taskId);
}

function check(taskId) {
  const b = budgets.get(taskId);
  if (!b) return { ok: true, exceeded: false, reason: '无预算记录', usage: null };
  const usage = { tokens: b.usedTokens, calls: b.usedCalls, cost: b.usedCost };
  if (b.usedTokens > b.maxTokens) {
    return { ok: false, exceeded: true, reason: `token 超限 ${b.usedTokens}/${b.maxTokens}`, usage };
  }
  if (b.usedCalls > b.maxLLMCalls) {
    return { ok: false, exceeded: true, reason: `LLM 调用超限 ${b.usedCalls}/${b.maxLLMCalls}`, usage };
  }
  if (b.usedCost > b.maxCost) {
    return { ok: false, exceeded: true, reason: `成本超限 $${b.usedCost}/${b.maxCost}`, usage };
  }
  return { ok: true, exceeded: false, reason: '预算内', usage };
}

function get(taskId) {
  return budgets.get(taskId) || null;
}

function remove(taskId) {
  budgets.delete(taskId);
}

module.exports = { createBudget, spend, check, get, remove, DEFAULT_BUDGET };
