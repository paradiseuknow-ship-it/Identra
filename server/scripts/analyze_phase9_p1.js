'use strict';
// analyze_phase9_p1.js — Phase 9 P1 分层归因（纯只读，不修改任何源码/数据）
//
// Phase 8 遗留问题：store 无 resolver telemetry，10 个细分类全标 UNOBSERVABLE。
// 本分析绕开该缺口，改用「确定性比对」：
//   把 planner 产出的 verification.expect / action.target 与 fixture 真实 DOM 比对。
//   不需要 resolver 内部数据即可区分：
//     - TARGET_CONTRACT_GAP：目标在 fixture DOM 中根本不存在（planner 凭空构造）
//     - DOM 存在但验证仍失败 → 下游问题（发现/排序/解析/可操作性/稳定性/观测）
//
// 输出：server/scripts/../.benchmark/phase9_p1_attribution.json + 控制台摘要

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const POOL = (() => { const p = require(path.join(ROOT, 'phase12_pool.json')); return Array.isArray(p) ? p : (p.tasks || []); })();
const TAX = require(path.join(ROOT, '.benchmark/phase68_taxonomy.json'));
const ATT = require(path.join(ROOT, '.benchmark/phase68_100task_store/aiAttempts.json'));
const TASKS = require(path.join(ROOT, '.benchmark/phase68_100task_store/aiTasks.json'));
const STEPS = require(path.join(ROOT, '.benchmark/phase68_100task_store/aiSteps.json'));

const A = Array.isArray(ATT) ? ATT : Object.values(ATT);
const T = Array.isArray(TASKS) ? TASKS : Object.values(TASKS);
const S = Array.isArray(STEPS) ? STEPS : Object.values(STEPS);

// ────────────────────────────────────────────────────────────
// fixture DOM 建模（轻量正则解析，无外部依赖）
// ────────────────────────────────────────────────────────────
function attr(tagText, name) {
  const m = tagText.match(new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i'))
    || tagText.match(new RegExp(name + "\\s*=\\s*'([^']*)'", 'i'))
    || tagText.match(new RegExp(name + '\\s*=\\s*([^\\s>]+)', 'i'));
  return m ? m[1] : null;
}

function parseFixture(html) {
  const els = [];
  const tagRe = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const tag = m[1].toLowerCase();
    if (!['input', 'button', 'select', 'textarea', 'a', 'form', 'label', 'h1', 'h2', 'h3', 'span', 'div', 'p', 'td', 'th', 'li', 'option'].includes(tag)) continue;
    const attrs = m[2] || '';
    const el = {
      tag,
      id: attr(attrs, 'id'),
      name: attr(attrs, 'name'),
      type: attr(attrs, 'type'),
      value: attr(attrs, 'value'),
      placeholder: attr(attrs, 'placeholder'),
      aria: attr(attrs, 'aria-label'),
      cls: attr(attrs, 'class'),
      role: attr(attrs, 'role'),
    };
    // 标签后随文本（用于 text_present）
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 300);
    const tm = after.match(/^([^<]{1,200})/);
    el.text = tm ? tm[1].trim() : '';
    els.push(el);
  }
  // 纯文本（含 script 内动态渲染的字符串常量）
  const textAll = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
  const scriptStrings = [];
  const sRe = /<script[\s\S]*?<\/script>/gi;
  let sm;
  while ((sm = sRe.exec(html))) {
    const body = sm[0];
    const q = body.match(/(['"`])([^'"`\n]{2,80})\1/g) || [];
    for (const s of q) scriptStrings.push(s.slice(1, -1));
  }
  return { els, textAll, scriptStrings, raw: html };
}

// ────────────────────────────────────────────────────────────
// 目标契约判定：expect / target 是否能在 fixture 中被找到
// ────────────────────────────────────────────────────────────
const CSS_HINT = /^[.#]?[a-zA-Z][\w-]*(\[|\.|#|:|>| )/;

function looksLikeCss(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (/^[.#]/.test(t)) return true;
  if (/^[a-zA-Z][\w-]*\[[^\]]+\]/.test(t)) return true;
  if (/^[a-zA-Z][\w-]*#[^\s]+$/.test(t)) return true;
  if (/^[a-zA-Z][\w-]*\.[^\s]+$/.test(t)) return true;
  return false;
}

// 极简 CSS 属性选择器匹配（覆盖 benchmark 中出现过的形态）
function matchSimpleCss(sel, els) {
  // 逗号分隔的选择器列表：任一命中即命中（如 "input[type='search'], input[name='search'], input[placeholder*='搜索']"）
  const parts = String(sel || '').split(',').map((s) => s.trim()).filter(Boolean);
  const list = parts.length ? parts : [String(sel || '').trim()];
  for (const t0 of list) { const hit = matchOneCss(t0, els); if (hit) return hit; }
  return null;
}

function matchOneCss(t, els) {
  t = String(t || '').trim();
  const tagM = t.match(/^([a-zA-Z][\w-]*)/);
  const tag = tagM ? tagM[1].toLowerCase() : null;
  const idM = t.match(/#([^\s.\[]+)/);
  const clsM = t.match(/\.([^\s.\[#]+)/);
  const attrMs = [...t.matchAll(/\[\s*([a-zA-Z-]+)\s*(?:([*^$~]?=)\s*["']?([^\]"']*)["']?)?\s*\]/g)];

  return els.find((el) => {
    if (tag && el.tag !== tag) return false;
    if (idM && el.id !== idM[1]) return false;
    if (clsM && !(el.cls || '').split(/\s+/).includes(clsM[1])) return false;
    for (const am of attrMs) {
      const [, an, op, av] = am;
      const key = an.toLowerCase();
      const val = key === 'value' ? el.value : key === 'type' ? el.type : key === 'name' ? el.name
        : key === 'id' ? el.id : key === 'placeholder' ? el.placeholder : key === 'value*' ? el.value : null;
      if (val == null) return false;
      if (op === '=' && String(val) !== av) return false;
      if (op === '*=' && !String(val).includes(av)) return false;
      if (op === '^=' && !String(val).startsWith(av)) return false;
      if (op === '$=' && !String(val).endsWith(av)) return false;
      if (!op) { /* 存在性 */ }
    }
    return true;
  });
}

// 语义/文本匹配：id/name/placeholder/aria/text/value 任一包含（或被包含）
function matchSemantic(q, els, dom) {
  const t = String(q || '').trim().toLowerCase();
  if (!t) return null;
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
  const nq = norm(t);
  if (!nq) return null;
  // 仅保留「元素属性文本 包含 目标词」方向。
  // 反向（目标词包含元素属性）会造成大量误判：
  //   例：目标 "member-list" 会因页面存在 id="list" 的元素而被误判为「存在」。
  const hit = els.find((el) => {
    const hay = norm([el.id, el.name, el.placeholder, el.aria, el.value, el.text, el.cls].filter(Boolean).join('|'));
    if (!hay || hay.length < 2) return false;
    return hay.includes(nq);
  });
  if (hit) return { el: hit, how: 'element_attrs' };
  if (dom.textAll && norm(dom.textAll).includes(nq)) return { el: null, how: 'static_text' };
  // 动态串同样只保留「脚本串 包含 目标词」方向，避免反向误判。
  if ((dom.scriptStrings || []).some((s) => norm(s).includes(nq))) {
    return { el: null, how: 'dynamic_text' };
  }
  return null;
}

// 从 CSS / 语义目标中提取「语义关键词」，用于判断 fixture 里是否存在语义相近元素
function keywordsOf(expect) {
  const t = String(expect || '');
  const toks = new Set();
  // 中文词（连续 >=2 个汉字）
  for (const m of t.match(/[\u4e00-\u9fa5]{2,}/g) || []) toks.add(m);
  // 选择器属性里的值（name/placeholder/aria/value/id）
  for (const m of t.matchAll(/\[\s*[a-zA-Z*-]+\s*(?:[*^$~]?=)\s*["']?([^\]"']+)["']?\s*\]/g)) {
    const v = String(m[1] || '').trim();
    for (const c of v.match(/[\u4e00-\u9fa5]{2,}/g) || []) toks.add(c);
    for (const w of v.match(/[a-zA-Z]{3,}/g) || []) toks.add(w.toLowerCase());
  }
  // 裸 id / 英文词
  for (const m of t.match(/[a-zA-Z]{3,}/g) || []) {
    const w = m.toLowerCase();
    if (!['input', 'button', 'select', 'textarea', 'form', 'div', 'span', 'text', 'type', 'name', 'value', 'placeholder', 'present'].includes(w)) toks.add(w);
  }
  // 中文二元切分（兜底：把「订单列表中的详情入口」切成可比对片段）
  const zh = (t.match(/[\u4e00-\u9fa5]+/g) || []).join('');
  for (let i = 0; i + 2 <= zh.length; i++) toks.add(zh.slice(i, i + 2));
  return [...toks];
}

// fixture 中是否存在「语义相近」的元素 → 决定该缺口能否由解析层修复
function semanticNeighbors(expect, dom) {
  if (!dom) return { count: 0, hits: [] };
  const kws = keywordsOf(expect);
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
  const hits = [];
  for (const el of dom.els) {
    const hay = norm([el.tag, el.id, el.name, el.placeholder, el.aria, el.value, el.text, el.cls].filter(Boolean).join('|'));
    if (!hay) continue;
    const matched = kws.filter((k) => k.length >= 2 && hay.includes(norm(k)));
    if (matched.length) hits.push({ el: `${el.tag}${el.id ? '#' + el.id : ''}${el.name ? '[name=' + el.name + ']' : ''}`, matched: matched.slice(0, 4) });
  }
  // 动态渲染字符串也算（script 里能产出该语义 → 属时序/稳定性问题，非能力缺失）
  const dyn = (dom.scriptStrings || []).filter((s) => kws.some((k) => k.length >= 2 && norm(s).includes(norm(k))));
  return { count: hits.length + dyn.length, hits: hits.slice(0, 5), dyn: dyn.slice(0, 5) };
}

function resolveExpect(expect, dom, vtype) {
  const t = String(expect || '').trim();
  if (!t) return { kind: 'EMPTY' };
  // url_contains 判定的是 URL，不是 DOM 元素 → 单独归类，不参与目标契约比对
  if (vtype === 'url_contains') return { kind: 'URL_CHECK' };
  if (looksLikeCss(t)) {
    const el = matchSimpleCss(t, dom.els);
    return { kind: 'CSS', found: !!el, el: el || null };
  }
  const sem = matchSemantic(t, dom.els, dom);
  return { kind: 'SEMANTIC', found: !!sem, how: sem ? sem.how : null, el: sem ? sem.el : null };
}

// ────────────────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────────────────
const name2taskIds = {};
for (const t of T) {
  const n = String(t.name || '').replace(/^P9 /, '');
  (name2taskIds[n] = name2taskIds[n] || []).push(t.id);
}
const poolByName = {};
for (const p of POOL) poolByName[String(p.name)] = p;

const fixtureCache = {};
function domOf(fixture) {
  if (!fixture) return null;
  if (fixtureCache[fixture]) return fixtureCache[fixture];
  const p = path.join(ROOT, 'mock-site', fixture);
  if (!fs.existsSync(p)) { fixtureCache[fixture] = null; return null; }
  fixtureCache[fixture] = parseFixture(fs.readFileSync(p, 'utf8'));
  return fixtureCache[fixture];
}

const rows = [];
for (const x of TAX) {
  const pool = poolByName[x.name];
  const dom = pool ? domOf(pool.fixture) : null;
  const taskIds = name2taskIds[x.name] || [];
  const attempts = A.filter((a) => taskIds.includes(a.taskId));

  const per = {
    id: x.id, name: x.name, cat: x.cat, fixture: pool ? pool.fixture : null,
    status: x.status, node: x.node, domLoaded: !!dom,
    verifyFailed: 0, elementNotFound: 0, otherErr: 0, successAttempts: 0,
    expectations: [],
  };
  const seen = new Set();
  for (const a of attempts) {
    if (a.status === 'SUCCESS') { per.successAttempts++; continue; }
    const code = a.error && a.error.code;
    if (code === 'VERIFY_FAILED') per.verifyFailed++;
    else if (code === 'ELEMENT_NOT_FOUND') per.elementNotFound++;
    else if (code) per.otherErr++;
    const v = (a.action && a.action.verification) || {};
    const key = (v.type || '?') + '::' + String(v.expect || '');
    if (!seen.has(key) && code === 'VERIFY_FAILED') {
      seen.add(key);
      per.expectations.push({
        type: v.type, expect: String(v.expect || ''),
        resolution: dom ? resolveExpect(v.expect, dom, v.type) : { kind: 'NO_DOM' },
        neighbors: dom ? semanticNeighbors(v.expect, dom) : null,
      });
    }
  }
  rows.push(per);
}

// ── 聚合 ──
const agg = {
  total: rows.length,
  byNode: {}, byCat: {},
  verifyFailedTasks: 0,
  // 目标契约分层
  contract: {
    CSS_IN_DOM: 0, CSS_NOT_IN_DOM: 0,
    SEMANTIC_IN_DOM: 0, SEMANTIC_DYNAMIC: 0, SEMANTIC_NOT_IN_DOM: 0,
    NO_DOM: 0, EMPTY: 0, URL_CHECK: 0,
    // 缺口二分
    GAP_RESOLVABLE: 0, GAP_FIXTURE_MISSING: 0,
  },
  gapDetail: [],
};
for (const r of rows) {
  agg.byNode[r.node] = (agg.byNode[r.node] || 0) + 1;
  agg.byCat[r.cat] = (agg.byCat[r.cat] || 0) + 1;
  if (r.verifyFailed > 0) agg.verifyFailedTasks++;
  for (const e of r.expectations) {
    const res = e.resolution;
    if (res.kind === 'EMPTY') agg.contract.EMPTY++;
    else if (res.kind === 'NO_DOM') agg.contract.NO_DOM++;
    else if (res.kind === 'URL_CHECK') agg.contract.URL_CHECK++;
    else if (res.kind === 'CSS') {
      agg.contract[res.found ? 'CSS_IN_DOM' : 'CSS_NOT_IN_DOM']++;
      if (!res.found) classifyGap(r, e);
    } else if (res.kind === 'SEMANTIC') {
      if (!res.found) { agg.contract.SEMANTIC_NOT_IN_DOM++; classifyGap(r, e); }
      else if (res.how === 'dynamic_text') agg.contract.SEMANTIC_DYNAMIC++;
      else agg.contract.SEMANTIC_IN_DOM++;
    }
  }
}

// 缺口二分：语义相近元素存在 → 解析层可修（在红线内）；完全不存在 → fixture 能力缺失（改 fixture/池属红线）
function classifyGap(r, e) {
  const nb = e.neighbors || { count: 0 };
  const isResolvable = nb.count > 0;
  agg.contract[isResolvable ? 'GAP_RESOLVABLE' : 'GAP_FIXTURE_MISSING']++;
  agg.gapDetail.push({
    id: r.id, cat: r.cat, fixture: r.fixture, type: e.type, expect: e.expect,
    verdict: isResolvable ? 'GAP_RESOLVABLE' : 'GAP_FIXTURE_MISSING',
    neighbors: nb.hits || [], dyn: nb.dyn || [],
  });
}

// ── 输出 ──
console.log('===== Phase 9 P1 · 目标契约 vs fixture DOM 归因（只读）=====');
console.log('任务数:', agg.total);
console.log('  节点分布:', agg.byNode);
console.log('  类别分布:', agg.byCat);
console.log('  出现 VERIFY_FAILED 的任务数:', agg.verifyFailedTasks);
console.log('\n--- 验证目标与 fixture DOM 的匹配结果 ---');
for (const [k, v] of Object.entries(agg.contract)) {
  const label = {
    CSS_IN_DOM: 'CSS 选择器 → DOM 中存在（下游问题：发现/排序/解析/观测）',
    CSS_NOT_IN_DOM: 'CSS 选择器 → DOM 中不存在（TARGET_CONTRACT_GAP）',
    SEMANTIC_IN_DOM: '语义目标 → DOM 中存在（下游问题）',
    SEMANTIC_DYNAMIC: '语义目标 → 仅存在于 script 动态串（PAGE_STABILITY/时序敏感）',
    SEMANTIC_NOT_IN_DOM: '语义目标 → DOM 中不存在（TARGET_CONTRACT_GAP）',
    NO_DOM: 'fixture 缺失，无法判定',
    EMPTY: 'expectation 为空',
    URL_CHECK: 'url_contains（判定对象是 URL，不参与 DOM 契约比对）',
    GAP_RESOLVABLE: '缺口·语义可救：fixture 存在语义相近元素 → 解析层可修（红线内）',
    GAP_FIXTURE_MISSING: '缺口·fixture 能力缺失：无任何语义相近元素 → 需改 fixture/池（红线）',
  }[k];
  if (label === undefined) return;
  console.log(`  ${String(v).padStart(4)}  ${k.padEnd(22)} ${label}`);
}

console.log('\n--- 缺口二分：GAP_RESOLVABLE（解析层可修，在红线内）---');
for (const g of agg.gapDetail.filter((x) => x.verdict === 'GAP_RESOLVABLE')) {
  console.log(`  ${g.id} [${g.cat}] ${g.fixture} | expect="${g.expect}"`);
  console.log(`        相近元素: ${JSON.stringify(g.neighbors).slice(0, 220)}`);
}
console.log('\n--- 缺口二分：GAP_FIXTURE_MISSING（需改 fixture/池 → 红线，只报告不改）---');
for (const g of agg.gapDetail.filter((x) => x.verdict === 'GAP_FIXTURE_MISSING')) {
  console.log(`  ${g.id} [${g.cat}] ${g.fixture} | ${g.type} | expect="${g.expect}"`);
}

console.log('\n--- TARGET_CONTRACT_GAP 明细（目标在 fixture 中根本不存在）---');
let n = 0;
for (const r of rows) {
  for (const e of r.expectations) {
    const res = e.resolution;
    const gap = (res.kind === 'CSS' && !res.found) || (res.kind === 'SEMANTIC' && !res.found);
    if (!gap) continue;
    n++;
    console.log(`  ${r.id} [${r.cat}] ${r.fixture} | ${e.type} | expect="${e.expect}"`);
  }
}
console.log('  合计:', n);

console.log('\n--- 目标在 DOM 中存在但 VERIFY_FAILED 的明细（下游断裂）---');
let m2 = 0;
for (const r of rows) {
  for (const e of r.expectations) {
    const res = e.resolution;
    if (!((res.kind === 'CSS' && res.found) || (res.kind === 'SEMANTIC' && res.found))) continue;
    m2++;
    console.log(`  ${r.id} [${r.cat}] ${r.fixture} | ${e.type} | expect="${e.expect}" | how=${res.how || 'css'}`);
  }
}
console.log('  合计:', m2);

const outPath = path.join(ROOT, '.benchmark/phase9_p1_attribution.json');
fs.writeFileSync(outPath, JSON.stringify({ agg, rows }, null, 2), 'utf8');
console.log('\n已写出:', outPath);
