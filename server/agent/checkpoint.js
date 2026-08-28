'use strict';

// Checkpoint Manager：保存关键步骤后的状态快照，供崩溃恢复使用。
// 不只是 URL，还包含 lastVerifiedState / lastSuccessfulAction / profileId / executionId。

const store = require('./store');

function save(taskId, data) {
  const cp = {
    id: 'cp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    taskId,
    executionId: data.executionId || null,
    stepId: data.stepId || null,
    attemptId: data.attemptId || null,
    profileId: data.profileId || null,
    url: data.url || null,
    lastVerifiedState: data.lastVerifiedState || {},
    lastSuccessfulAction: data.lastSuccessfulAction || null,
    extra: data.extra || {},
    timestamp: Date.now(),
  };
  store.insert('aiCheckpoints', cp);
  return cp;
}

function latest(taskId) {
  const list = store.findWhere('aiCheckpoints', (x) => x.taskId === taskId);
  if (!list.length) return null;
  return list.sort((a, b) => b.timestamp - a.timestamp)[0];
}

// restore：从最新 checkpoint 重建恢复状态（B.13）。
// 返回结构化恢复包（不仅是 url），供 runtime recover 回放，避免重复已成功动作。
// 无 checkpoint 返回 null（调用方回落到 task.targetUrl）。
function restore(taskId) {
  const cp = latest(taskId);
  if (!cp) return null;
  return {
    url: cp.url || null,
    stepId: cp.stepId || null,
    profileId: cp.profileId || null,
    executionId: cp.executionId || null,
    lastVerifiedState: cp.lastVerifiedState || {},
    lastSuccessfulAction: cp.lastSuccessfulAction || null,
    timestamp: cp.timestamp,
  };
}

function listForTask(taskId) {
  return store.findWhere('aiCheckpoints', (x) => x.taskId === taskId)
    .sort((a, b) => a.timestamp - b.timestamp);
}

module.exports = { save, latest, restore, listForTask };
