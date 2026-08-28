'use strict';

// Action Replay：按 executionId 输出完整动作执行链（人类可读 + 结构化）。
// 用途：debug / 训练 / 自愈追溯 —— "刚才 AI 做了什么"。

const recorder = require('../recorder');

// 兼容 error：旧格式为字符串，Phase 3 后为结构化 {code,message}。
// 统一渲染为 "CODE: message"，避免 [object Object]。
function fmtErr(e) {
  if (!e) return '';
  if (typeof e === 'string') return e;
  if (typeof e === 'object') return `${e.code || 'ERR'}: ${e.message || ''}`.trim();
  return String(e);
}

function buildChain(executionId) {
  const exe = recorder.get(executionId);
  if (!exe) return { executionId, found: false, chain: [], text: '' };
  const chain = (exe.actions || []).map((a, i) => ({
    step: i + 1,
    tool: a.tool,
    status: a.status,
    target: (a.actionSummary && a.actionSummary.target) || null,
    error: a.error || null,
    durationMs: a.durationMs || 0,
    timestamp: a.timestamp,
  }));
  const text = chain.map((a) => `Step${a.step} ${a.tool} → ${a.status}${a.error ? ' ✘ ' + fmtErr(a.error) : ''}${a.durationMs ? ' (' + a.durationMs + 'ms)' : ''}`).join('\n');
  return { executionId, found: true, chain, text };
}

function buildTaskReplay(task) {
  if (!task) return { found: false, text: '' };
  if (!task.currentExecutionId) return { taskId: task.id, found: false, text: '任务尚未产生执行记录', chain: [] };
  const r = buildChain(task.currentExecutionId);
  r.taskId = task.id;
  r.status = task.status;
  r.planVersion = task.planVersion || null;
  return r;
}

module.exports = { buildChain, buildTaskReplay };
