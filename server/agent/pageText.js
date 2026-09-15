'use strict';

// =============================================================================
// pageText.js — 页面文本通道的**唯一实现**（C127）
//
// ── 事故模式（本模块存在的理由）──────────────────────────────────────────────
// 页面文本有**三个消费方**在读**三种不同形状**：
//   - 验证/诊断子句判定（clause.js）      → 读 textSummary + visibleText（C126 已收口）
//   - pageReady.textOf                    → 优先读 `visibleTexts`（**复数**）
//   - pageStateClassifier.extractText     → 优先读 `visibleTexts`（**复数**）
// 而生产观测（observation.inspect，observation.js:486/493）产出的只有
//   `textSummary`(string) + `visibleText`(string) + `roleText`(string)，
// **从不产出 `visibleTexts`（复数）**。另外 failureSnapshot 曾为
// `Array.isArray(observation.textSummary)` 写了一个分支 —— 而 textSummary 是字符串，
// 该分支**永不可达**。这两个「不存在的形状」只活在测试 fixture 里
// （test_phase6.js 全用 `{visibleTexts:[...]}`；testAgentPhase22.js 用 `textSummary:[...]`）
// ⇒ 守护全绿，生产恒走窄口径回落。
//
// ── 收口规则 ────────────────────────────────────────────────────────────────
//   1. 判定/分类类消费方一律走 `pageText(obs)`：textSummary + visibleText 拼接归一化。
//   2. 取证/prompt 类消费方走 `pageTextLines(obs)`：**保留原始大小写**、按行去重限量。
//   3. `visibleTexts`（复数）作为**失败快照的历史形状**在此统一兼容，消费方不再各自处理。
//   4. `roleText` **不进入**文本通道：它是交互元素的角色名/aria-label（元素级证据，
//      由 element_present 的存在性索引负责）。混进文本通道会让「视觉上没有这段文字」
//      的属性命中 text_present —— 与 C123 的证据层级纪律、C126 的同一判断同源。
//
// 职责边界：纯函数，不读 store、不起浏览器、不调 LLM、不写状态。
// =============================================================================

const { normalizeText } = require('./existence');

// 单次取证的文本上限（行数 / 字符数）。observation.js 侧 visibleText 本身已截断 8000，
// 这里再兜一层，避免快照落库体积随页面膨胀。
const MAX_LINES = 200;
const MAX_CHARS = 8000;

// 把观察对象里所有**真实存在**的文本字段收集为原始片段（保留大小写）。
// 顺序即优先级：观测事实源（textSummary / visibleText）在前，历史快照形状（visibleTexts）随后，
// 最老的 `text` 兜底最后。空/非字符串一律跳过，绝不把 undefined 变成 "undefined"。
function collectParts(o) {
  const obs = o || {};
  const parts = [];
  if (typeof obs.textSummary === 'string' && obs.textSummary) parts.push(obs.textSummary);
  if (typeof obs.visibleText === 'string' && obs.visibleText) parts.push(obs.visibleText);
  if (Array.isArray(obs.visibleTexts)) {
    for (const x of obs.visibleTexts) if (typeof x === 'string' && x) parts.push(x);
  } else if (typeof obs.visibleTexts === 'string' && obs.visibleTexts) {
    parts.push(obs.visibleTexts);
  }
  if (!parts.length && typeof obs.text === 'string' && obs.text) parts.push(obs.text);
  return parts;
}

function collect(o) {
  return collectParts(o).join(' ');
}

/**
 * 判定/分类用文本：折叠空白 + 小写（与 existence.normalizeText 同口径，
 * 亦与 clause.js 的子句匹配口径一致 —— 子句 expect 也走同一归一化）。
 * @param {object|null} obs 观察对象（生产观测或失败快照均可）
 * @returns {string}
 */
function pageText(obs) {
  return normalizeText(collect(obs));
}

/**
 * 取证/prompt 用文本行：**保留原始大小写**（诊断 prompt 要展示给 LLM，小写会毁掉可读性），
 * 按行拆分、去空、去重、限量。
 * @param {object|null} obs 观察对象
 * @param {{maxLines?:number,maxChars?:number}} [opts]
 * @returns {string[]}
 */
function pageTextLines(obs, opts) {
  const o = opts || {};
  const maxLines = Number.isFinite(o.maxLines) && o.maxLines > 0 ? Math.floor(o.maxLines) : MAX_LINES;
  const maxChars = Number.isFinite(o.maxChars) && o.maxChars > 0 ? Math.floor(o.maxChars) : MAX_CHARS;
  const raw = collect(obs);
  const seen = new Set();
  const out = [];
  let used = 0;
  // 逐**来源片段**拆行（而不是先把片段拼起来再拆）—— 否则 textSummary 的最后一行
  // 会和 visibleText 的第一行被空格粘成一条不存在的行，且跨来源去重失效。
  for (const part of collectParts(obs)) {
    for (const line of part.split(/\r?\n/)) {
      const t = line.replace(/[ \t\u00a0]+/g, ' ').trim();
      if (!t || seen.has(t)) continue;
      if (used + t.length > maxChars) break;
      seen.add(t);
      out.push(t);
      used += t.length;
      if (out.length >= maxLines) break;
    }
    if (out.length >= maxLines) break;
  }
  // 无换行的单段文本（textSummary 常态）⇒ 回落到整段，保证不为空
  if (!out.length) {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (t) out.push(t.slice(0, maxChars));
  }
  return out;
}

module.exports = { pageText, pageTextLines, MAX_LINES, MAX_CHARS };
