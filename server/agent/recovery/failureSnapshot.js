'use strict';

// FailureSnapshot：失败时的结构化证据（供 AI Diagnosis 使用，不直接看原始浏览器）。
// { taskId, stepId, url, title, errorType, confidence, lastAction, observationHash, visibleTexts, screenshotRef, timestamp }

const store = require('../store');
const evidence = require('../evidence');
const browserManager = require('../../browserManager');

async function create({ taskId, stepId, url, title, errorType, confidence, lastAction, observation, executionId }) {
  let screenshotRef = null;
  try {
    // Phase 9 P3 修复：同 runtime —— getPage 是 async，漏 await 会拿到 Promise，
    // 使证据快照（saveSnapshot）恒被跳过且无异常（Promise truthy → 进入分支 → 内部报错被 catch 吞掉）。
    const page = await browserManager.getPage((store.find('aiTasks', taskId) || {}).profileId);
    if (page) {
      const file = await evidence.saveSnapshot(page, taskId, stepId, 'verification_failed');
      screenshotRef = file || null;
    }
  } catch (e) {}

  const snap = {
    id: 'fs_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    taskId, stepId, executionId: executionId || null,
    url: url || '',
    title: title || '',
    errorType: errorType || 'UNKNOWN',
    confidence: confidence != null ? confidence : null,
    lastAction: lastAction || null,
    observationHash: observation && observation.hash ? observation.hash : null,
    visibleTexts: Array.isArray(observation && observation.textSummary) ? observation.textSummary : ((observation && observation.textSummary) ? [observation.textSummary.slice(0, 2000)] : []),
    screenshotRef,
    timestamp: Date.now(),
  };
  store.insert('aiFailureSnapshots', snap);
  store.trimCollection('aiFailureSnapshots', 1000);
  return snap;
}

function latestForTask(taskId) {
  const list = store.findWhere('aiFailureSnapshots', (x) => x.taskId === taskId);
  if (!list.length) return null;
  return list.sort((a, b) => b.timestamp - a.timestamp)[0];
}

function listForTask(taskId) {
  return store.findWhere('aiFailureSnapshots', (x) => x.taskId === taskId).sort((a, b) => a.timestamp - b.timestamp);
}

module.exports = { create, latestForTask, listForTask };
