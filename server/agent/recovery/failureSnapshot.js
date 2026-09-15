'use strict';

// FailureSnapshot：失败时的结构化证据（供 AI Diagnosis 使用，不直接看原始浏览器）。
// { taskId, stepId, url, title, errorType, confidence, lastAction, observationHash, visibleTexts, screenshotRef, timestamp }

const store = require('../store');
const evidence = require('../evidence');
const browserManager = require('../../browserManager');
const { pageTextLines } = require('../pageText');

// 快照落库的文本上限：aiFailureSnapshots 是 trimCollection 1000 的有界集合，
// 单条文本上限 × 1000 即该集合的最坏体积（4000 × 1000 ≈ 4 MB，与 observation.js 的
// visibleText 8000 上限相比减半，仍远超诊断/taxonomy 的信号需求）。
const MAX_SNAPSHOT_TEXT_CHARS = 4000;

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
    // ★ C127：此前是
    //   Array.isArray(observation && observation.textSummary)
    //     ? observation.textSummary
    //     : [observation.textSummary.slice(0, 2000)]
    // —— `observation.textSummary` 是**字符串**（observation.js:486 拼好并截断 5000），
    //   `Array.isArray(string)` 恒 false ⇒ 第一分支**永不可达**（该数组形状只存在于
    //   testAgentPhase22.js 的 fixture 里，生产与已落库记录中均无此形态）。
    //   实际内容 = textSummary 的**前 2000 字符**，即「前 120 个筛选元素」之上再叠一层截断。
    // 而字段名（visible**Texts**）与两个下游——diagnosisPrompt.js:37 按行 `slice(0,20).join(' · ')`
    // 展示给 LLM、executionFailureTaxonomy.js:63 按整段做 CAPTCHA 弱信号匹配——都按
    // 「全页可见文本行」消费 ⇒ 实际结果是：prompt 里只剩**一整块 1500 字符**（1 行而非 20 行），
    // 且落在 2000 字符窗口外的挑战控件/关键线索**静默漏检**。
    // 现改为从页面文本唯一通道取**真实行**（保留原始大小写），并在此兜住落库体积。
    visibleTexts: pageTextLines(observation, { maxLines: 200, maxChars: MAX_SNAPSHOT_TEXT_CHARS }),
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
