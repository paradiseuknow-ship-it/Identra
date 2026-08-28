'use strict';

// Phase 6.4 — Page / Element Ready Detection (E2 页面未就绪 + E4 动态加载).
//
// 提供：
//   isPageReady(observation)       —— 纯函数：页面是否已渲染到可交互状态（非空白 SPA）。
//   waitForPageReady(page, opts)   —— 轮询观察直到页面就绪（E2）。
//   waitForElement(page, target, opts) —— 轮询观察直到目标元素出现（E4 动态加载）。
//
// 属允许范围（semantic ready wait）。不改动 verification 成功判定逻辑；仅作为执行前的「就绪等待」，
// 超时后交还既有路径（ELEMENT_NOT_FOUND / 重试）收口，绝不自动判成功。

const semanticResolver = require('./semanticResolver');

function textOf(obs) {
  if (!obs) return '';
  if (Array.isArray(obs.visibleTexts) && obs.visibleTexts.length) return obs.visibleTexts.join(' ');
  return obs.textSummary || obs.text || '';
}

// 页面是否就绪：可见文本非空（SPA 已挂载）或已渲染出可交互元素。
function isPageReady(obs) {
  if (!obs) return false;
  const text = textOf(obs).replace(/\s+/g, ' ').trim();
  const elements = obs.elements || [];
  if (text.length > 0) return true;       // 有可见文本 → 已渲染
  if (elements.length > 0) return true;    // 仅渲染出元素（如 canvas/SPA）也视为就绪
  return false;                            // 全空 → 空白页（E2 未就绪）
}

async function inspectPage(page, taskId) {
  const observation = require('./observation');
  try {
    const r = await observation.inspect(page, { taskId, skipCache: true });
    return (r && r.observation) || null;
  } catch (e) {
    return null;
  }
}

async function waitForPageReady(page, opts = {}) {
  const timeoutMs = opts.timeoutMs || 8000;
  const intervalMs = opts.intervalMs || 400;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await inspectPage(page, opts.taskId);
    if (isPageReady(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last; // 超时仍交还最后观察，由上层既有路径收口
}

async function waitForElement(page, target, opts = {}) {
  const timeoutMs = opts.timeoutMs || 4000;
  const intervalMs = opts.intervalMs || 400;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await inspectPage(page, opts.taskId);
    if (!isPageReady(last)) { await new Promise((r) => setTimeout(r, intervalMs)); continue; }
    const cands = semanticResolver.resolve(target, last);
    if (cands.length > 0) return last; // 元素已就绪
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null; // 超时：交还 null，由既有 ELEMENT_NOT_FOUND 路径收口
}

module.exports = { isPageReady, waitForPageReady, waitForElement, textOf };
