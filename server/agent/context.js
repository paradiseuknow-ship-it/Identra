'use strict';

// Context Manager：为 LLM 组装上下文，负责压缩/截断/脱敏。
// 原则：Profile Context 不允许包含 Proxy password / Cookie / Password / Card / API keys；
//       Observation 中的敏感输入值一律 REDACTED。

const MAX_TEXT = 8000;      // 可见文本截断
const MAX_ELEMENTS = 60;    // 元素列表上限
const MAX_ACTIONS = 30;     // 最近动作记录上限

function redactString(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/(password|passwd|pwd)\s*[=:]\s*\S+/gi, '$1=REDACTED')
    .replace(/authorization\s*:\s*\S+/gi, 'authorization: REDACTED')
    .replace(/api[_-]?key\s*[=:]\s*\S+/gi, 'apiKey=REDACTED')
    .replace(/cookie\s*[=:]\s*\S+/gi, 'cookie=REDACTED')
    .replace(/(otp|token)\s*[=:]\s*\S+/gi, '$1=REDACTED')
    .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, 'CARD_REDACTED')
    .replace(/\b\d{3,4}\b(?=\s*cvv\b)/gi, 'CVV_REDACTED');
}

function truncate(s, n) {
  if (typeof s !== 'string') return s;
  return s.length <= n ? s : s.slice(0, n) + '…[截断]';
}

// 组装 Task Context
function taskContext(task) {
  if (!task) return null;
  return {
    id: task.id,
    objective: task.objective,
    targetUrl: task.targetUrl,
    profileId: task.profileId,
    executionMode: task.executionMode,
    status: task.status,
    currentStepId: task.currentStepId,
    createdAt: task.createdAt,
  };
}

// 组装 Page Context（来自 observation.inspect 结果，已脱敏）
function pageContext(inspect) {
  if (!inspect) return { url: '', title: '', summary: '' };
  return {
    url: inspect.url || '',
    title: inspect.title || '',
    visibleText: truncate(redactString(inspect.visibleText || ''), MAX_TEXT),
    elements: (inspect.elements || []).slice(0, MAX_ELEMENTS).map((e) => ({
      id: e.id, role: e.role, text: truncate(redactString(e.text || ''), 120),
      type: e.type || null, visible: e.visible,
    })),
    errors: (inspect.errors || []).slice(0, 10).map((x) => truncate(redactString(x), 300)),
  };
}

// 组装 Execution Context（最近动作，脱敏）
function executionContext(execution) {
  if (!execution) return { actions: [] };
  return {
    actions: (execution.actions || []).slice(-MAX_ACTIONS).map((a) => ({
      stepId: a.stepId, tool: a.tool, status: a.status,
      actionSummary: a.actionSummary || {}, error: a.error ? truncate(a.error, 300) : null,
    })),
  };
}

// 组装 Repair Context（诊断输入）
function repairContext(diagnosis) {
  if (!diagnosis) return null;
  return {
    category: diagnosis.category,
    facts: (diagnosis.facts || []).map((f) => truncate(redactString(f), 300)),
    evidence: (diagnosis.evidence || []).map((f) => truncate(redactString(f), 300)),
    inference: truncate(redactString(diagnosis.inference || ''), 500),
    confidence: diagnosis.confidence,
  };
}

// 一键组装
function build({ task, inspect, execution, diagnosis, knowledge }) {
  return {
    task: taskContext(task),
    page: pageContext(inspect),
    execution: executionContext(execution),
    repair: repairContext(diagnosis),
    siteKnowledge: knowledge || null,
  };
}

module.exports = { build, taskContext, pageContext, executionContext, repairContext, redactString, truncate };
