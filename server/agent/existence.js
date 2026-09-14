'use strict';

// C124：元素级「存在性裁决」的**唯一实现**。
//
// 背景（C123 的余波）：observation.elements[] 是 semanticResolver 的唯一候选池，但它刻意
// 不收 div/span/p（observation.js 的容量取舍：数量大，会挤爆上限并稀释动作目标排序）。
// C123 在 verification.js 里补了 contentLeaves 存在性索引，修掉了 element_present 的假阴性。
// 但**同一份存在性语义在 diagnosis 层还有第二份实现** —— verificationIntelligence.js 的
// clausePresent / expectedActuallyPresent 既没有 contentLeaves 回落、也缺 element_present
// 分支。两份同义实现的分歧正是 L6「同文件/跨文件的同后果面不对称」：verification 说存在，
// intelligence 说不存在；element_absent 一边承认 div/span 存在、另一边不承认。
//
// 因此这里把它抽成共用原语，语义分层由**调用方显式选择**，而不是各实现自行猜测：
//   strict（成功/失败裁决用）= 候选解析器(resolver) OR 存在性索引(contentLeaves)
//   loose（仅「验证是否过严」的启发式猜想用）= strict OR 单元素字段子串
// loose **绝不参与** success 判定 —— 它回答的是「页面上有无关的字面痕迹吗」，语义更宽，
// 若混入成功裁决会把「沾边即存在」变成假阳性成功。
//
// 不变量：【从不因「证据缺失」翻转结论】。本模块只在**拿到正面存在证据**时才认定存在；
// 证据不足一律返回 found:false。修 bug 不能靠放宽另一条路径来实现。

/** 文本归一化：空白折叠 + 小写。存在性比对的唯一口径（此前两处实现各自微调过去空格/大小写细节）。 */
function normalizeText(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * C123 存在性索引（observation.contentLeaves）匹配。
 * @returns {object|null} 命中的叶子 {tag, cls, id, text} 或 null
 */
function matchContentLeaf(after, expect) {
  const e = String(expect == null ? '' : expect).replace(/\s+/g, ' ').trim().toLowerCase();
  if (e.length < 2) return null;
  const leaves = (after && after.contentLeaves) || [];
  for (const lf of leaves) {
    const t = String((lf && lf.text) || '').replace(/\s+/g, ' ').toLowerCase();
    if (t && t.includes(e)) return lf;
  }
  return null;
}

/**
 * loose 档：单元素字段子串匹配。
 * 旧实现把整页 elements 的所有字段串成一条字符串再逐字 includes —— 语义作用域被抬高到
 * 「整页面」，且不做空白折叠。这里改为按**单个元素**各自拼接并统一折叠空白。
 * 核查结论（如实记录）：元素间接缝恒含 ≥6 个空白，跨元素误命中现实不可达，
 * 故这不是「跨元素假阳性修复」，只是把作用域收回到元素本身。
 * @returns {object|null} 命中的元素描述对象
 */
function matchElementFieldSubstring(after, expect) {
  const e = normalizeText(expect);
  if (e.length < 2) return null;
  const els = (after && after.elements) || [];
  for (const el of els) {
    if (!el) continue;
    const pool = normalizeText([el.text, el.placeholder, el.ariaLabel, el.label, el.innerText, el.roleText].filter(Boolean).join(' '));
    if (pool && pool.includes(e)) return el;
  }
  return null;
}

/**
 * 元素级存在性裁决（strict/loose 二档）。
 *
 * @param {object} after       动作后的 observation
 * @param {string} expect      期望目标（语义描述或 CSS 选择器）
 * @param {Function} resolver  semanticResolver.resolve —— 依赖注入而非硬 require，避免
 *                             观察层与语义层之间出现循环引用。
 * @param {object} [opts]      { requireActionable?: boolean, loose?: boolean }
 * @returns {{found:boolean, via:string|null, cands:Array, leaf:object|null, el:object|null}}
 */
function elementExists(after, expect, resolver, opts) {
  const o = opts || {};
  const empty = { found: false, via: null, cands: [], leaf: null, el: null };
  if (!expect) return empty;
  let cands = [];
  try {
    if (typeof resolver === 'function') {
      cands = resolver(String(expect), after, o.requireActionable === false ? { requireActionable: false } : undefined) || [];
    }
  } catch (e) {
    // 解析异常不是「不存在」，是不知情 —— 按不变量一律返回未找到，由上层保留既有收口。
    cands = [];
  }
  if (cands && cands.length) return { found: true, via: 'resolver', cands, leaf: null, el: null };
  const leaf = matchContentLeaf(after, expect);
  if (leaf) return { found: true, via: 'contentLeaf', cands: [], leaf, el: null };
  if (o.loose) {
    const el = matchElementFieldSubstring(after, expect);
    if (el) return { found: true, via: 'elementSubstring', cands: [], leaf: null, el };
  }
  return empty;
}

module.exports = { normalizeText, matchContentLeaf, matchElementFieldSubstring, elementExists };
