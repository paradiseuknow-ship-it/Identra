'use strict';

// Execution Recorder：记录每次执行的动作、结果、耗时、错误。
// 数据用于 Execution Timeline / Diagnosis / Metrics。

const store = require('./store');

function createExecution(taskId, profileId, meta = {}) {
  const exe = {
    id: 'exe_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    taskId,
    profileId,
    status: 'PREPARING',   // 执行级状态：PREPARING/RUNNING/HEALING/PAUSED_FOR_HUMAN/SUCCESS/FAILED/CANCELLED
    actions: [],
    stats: { actionCount: 0, repairCount: 0, recoveryCount: 0 },
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    ...meta,
  };
  store.insert('aiExecutions', exe);
  return exe;
}

function get(id) {
  return store.find('aiExecutions', id);
}

function update(id, patch) {
  const exe = get(id);
  if (!exe) return null;
  store.upsert('aiExecutions', { ...exe, ...patch });
  return get(id);
}

// 记录一次动作执行（含脱敏：只记录动作摘要，不含 value 明文；credentialRef 记录引用）
function recordAction(exeId, entry) {
  const exe = get(exeId);
  if (!exe) return null;
  const rec = {
    stepId: entry.stepId || null,
    attemptId: entry.attemptId || null,
    tool: entry.tool || entry.action?.type || 'unknown',
    actionSummary: sanitizeAction(entry.action),
    status: entry.status || 'RUNNING',   // RUNNING/SUCCESS/FAILED
    error: entry.error ? sanitizeError(entry.error) : null,
    durationMs: entry.durationMs || 0,
    timestamp: Date.now(),
  };
  exe.actions.push(rec);
  exe.stats.actionCount += 1;
  if (entry.status === 'FAILED') exe.stats.repairCount += 1;
  store.upsert('aiExecutions', exe);
  return rec;
}

// 动作脱敏：value 只保留长度标记；敏感字段值一律 REDACTED
function sanitizeAction(action) {
  if (!action || typeof action !== 'object') return action;
  const a = { ...action };
  if (a.value !== undefined && a.value !== null) {
    const field = (a.target && a.target.field) || '';
    const sensitive = ['password', 'cvv', 'cardnumber', 'otp', 'token', 'card', 'secret', 'apikey'].includes(String(field).toLowerCase());
    a.value = sensitive ? 'REDACTED' : `[len=${String(a.value).length}]`;
  }
  if (a.credentialRef) a.credentialRef = a.credentialRef;
  if (a.reason) a.reason = a.reason;
  return a;
}

// 错误脱敏：禁止日志出现密码/卡号/OTP/Cookie/Auth/API Key
const SECRET_PATTERNS = [
  /\b(\d{4}[ -]?){4}\b/g,          // 卡号
  /\b\d{3,4}\b(?=\s*CVV|cvv)/gi,   // CVV
  /password\s*[=:]\s*\S+/gi,
  /Authorization\s*:\s*\S+/gi,
  /api[_-]?key\s*[=:]\s*\S+/gi,
  /otp\s*[=:]\s*\S+/gi,
  /token\s*[=:]\s*\S+/gi,
];
function sanitizeError(err) {
  let s = typeof err === 'string' ? err : String((err && err.message) || err || '');
  for (const re of SECRET_PATTERNS) s = s.replace(re, 'REDACTED');
  return s.slice(0, 500);
}

function markFinished(exeId, status, error) {
  return update(exeId, { status, finishedAt: Date.now(), error: error ? sanitizeError(error) : null });
}

// 记录一次 LLM 调用（provider/model/tokens/duration/success），供成本与诊断分析
function recordLLMCall(exeId, info) {
  const exe = get(exeId);
  if (!exe) return null;
  exe.llmCalls = exe.llmCalls || [];
  exe.llmCalls.push({
    type: info.type || 'chat',
    provider: info.provider || '?',
    model: info.model || null,
    tokens: info.tokens || 0,
    promptTokens: info.promptTokens || 0,
    completionTokens: info.completionTokens || 0,
    durationMs: info.durationMs || 0,
    cost: info.cost || 0,
    success: !!info.success,
    timestamp: Date.now(),
  });
  store.upsert('aiExecutions', exe);
  return info;
}

module.exports = {
  createExecution, get, update, recordAction, markFinished, recordLLMCall, sanitizeAction, sanitizeError,
};
