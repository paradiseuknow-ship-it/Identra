'use strict';

// Observation Cache：页面无变化时不重复发送完整 DOM/摘要给 LLM，省 token。
// key = taskId + url + contentHash（可见文本/元素结构哈希）。
// 若页面内容哈希未变，直接复用上次观察结果。

const crypto = require('crypto');

const cache = new Map(); // taskId -> { url, contentHash, summary, timestamp, prevSummary }

function hashContent(visibleText, elements) {
  const raw = JSON.stringify({ t: visibleText || '', e: (elements || []).map((x) => x.id + ':' + x.role + ':' + x.text) });
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

// 尝试命中缓存。命中返回 { hit: true, summary }；未命中返回 { hit: false }
function get(taskId, url, visibleText, elements) {
  const h = hashContent(visibleText, elements);
  const cur = cache.get(taskId);
  if (cur && cur.url === url && cur.contentHash === h) {
    return { hit: true, summary: cur.summary, contentHash: h };
  }
  return { hit: false, contentHash: h };
}

// v0.2.2：返回同一 task 「上一次（最近一次）设置的观察摘要」—— 即紧邻本次观察之前的那一条，
// 供 previousObservationDiff / parentObservationId 血缘使用（Business Loop 专项 §七）。
// 注意：必须返回 cur.summary（最近一次 set 进来的观察），而非 cur.prevSummary（那是再上一条，
// 会让 DOM_CHANGED 比对基线错位、parentObservationId 在第二调用即变 null）。
function last(taskId) {
  const cur = cache.get(taskId);
  return (cur && cur.summary) || null;
}

function set(taskId, url, contentHash, summary) {
  const cur = cache.get(taskId);
  cache.set(taskId, {
    url, contentHash, summary, timestamp: Date.now(),
    prevSummary: cur ? cur.summary : null,
  });
}

function invalidate(taskId) {
  cache.delete(taskId);
}

function invalidateOnNavigation(taskId, url) {
  const cur = cache.get(taskId);
  if (cur && cur.url !== url) cache.delete(taskId);
}

module.exports = { get, set, last, invalidate, invalidateOnNavigation, hashContent };
