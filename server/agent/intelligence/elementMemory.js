'use strict';

// Element Memory：元素记忆（语义 → 站点历史 patterns → 直接命中，零语义推理）。
// 写入：resolveSelector 语义解析成功 + 工具动作成功后强化（tools 层），可带 context（场景条件）。
// 消费：tools.resolveSelector（记忆优先 → semanticResolver 兜底）。
// 规则：
//  - 记忆只提供候选（candidate），不直接执行动作；
//  - confidence < MIN_CONFIDENCE 自动降级回 semanticResolver；
//  - 旧经验不删除：pattern 只增不减，version 递增，低成功率自动 DEPRECATED。
//
// Phase 3.1+ 加固（落地前补齐，避免 Flow Memory 数据污染）：
//  1) context 条件：同一按钮在不同页面/场景 → 不同记忆（urlPattern / visibleKeywords / previousActions）；
//  2) hit 统计：stats.{hits,memoryHits,semanticFallback,falsePositive}，量化记忆价值；
//  3) conflict resolver：pattern 携带 per-pattern successRate，命中时按成功率排序，优先高成功率文本；
//  4) elementType：扩展记录 button/input/dropdown/checkbox/modal/table/menu，不止按钮；
//  5) export/import：经验包导出/导入（商业化：站点经验可迁移）。

const store = require('../store');
const semanticResolver = require('../semanticResolver');
const { createBase, recordOutcome, bumpStat } = require('./memoryRecord');

const MIN_CONFIDENCE = 0.8;
const PACK_FORMAT = 'ai-browser-operator@3.2';

// ---------- context（场景条件）----------

function normalizeUrlPattern(path) {
  if (!path) return '/';
  return String(path)
    .replace(/\?.*$/, '')
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    .replace(/\/+$/, '') || '/';
}

function contextOf(observation, prevActions) {
  const ctx = {};
  if (observation && observation.url) {
    try { ctx.urlPattern = normalizeUrlPattern(new URL(observation.url).pathname); } catch (e) {}
  }
  const elems = (observation && observation.elements) || [];
  const kws = elems.map((e) => String(e.text || '').trim()).filter(Boolean).slice(0, 6);
  if (kws.length) ctx.visibleKeywords = kws;
  if (prevActions && prevActions.length) ctx.previousActions = prevActions.slice(-5);
  return ctx;
}

function contextKey(ctx) {
  if (!ctx || !Object.keys(ctx).length) return '';
  // 仅用稳定场景维度（urlPattern / previousActions）做隔离 key；
  // visibleKeywords 不进入 key —— 否则按钮文案变化（Continue→Proceed）会碎片化记忆，丧失跨文案复用能力。
  const norm = {
    urlPattern: ctx.urlPattern || '',
    previousActions: (ctx.previousActions || []).slice().sort(),
  };
  if (!norm.urlPattern && !norm.previousActions.length) return '';
  return 'CTX:' + Buffer.from(JSON.stringify(norm)).toString('base64').slice(0, 24);
}

function keyOf(site, semantic, ctx) {
  const base = String(site) + '|' + String(semantic).toLowerCase().trim();
  const ck = contextKey(ctx);
  return ck ? base + '|' + ck : base;
}

// ---------- element 抽象 ----------

function elementTypeOf(el) {
  if (!el) return null;
  if (el.elementType) return el.elementType;
  if (el.role === 'button' || el.tag === 'button') return 'button';
  if (el.tag === 'input') {
    const t = String(el.inputType || el.type || '').toLowerCase();
    if (t === 'checkbox' || t === 'radio') return t;
    return 'input';
  }
  if (el.tag === 'select') return 'dropdown';
  if (el.role === 'dialog' || el.tag === 'dialog') return 'modal';
  if (el.tag === 'table') return 'table';
  if (el.role === 'menu' || el.tag === 'menu' || el.tag === 'nav') return 'menu';
  return el.tag || el.role || 'element';
}

// 从观察元素/已有 pattern 提取指纹（text/role/tag/aria）。pattern 比对只看这四项。
function patternOf(el) {
  const p = {};
  if (el && el.text) p.text = String(el.text).trim().slice(0, 40);
  if (el && el.role) p.role = el.role;
  if (el && el.tag) p.tag = el.tag;
  if (el && el.ariaLabel) p.aria = String(el.ariaLabel).trim().slice(0, 40);
  return p;
}

function patternEquals(a, b) {
  return JSON.stringify(patternOf(a)) === JSON.stringify(patternOf(b));
}

function matchPattern(pattern, el) {
  if (!el) return false;
  if (pattern.text) {
    const t = String(el.text || '').trim();
    const p = String(pattern.text).trim();
    if (t !== p && !t.toLowerCase().includes(p.toLowerCase())) return false;
  }
  if (pattern.role && el.role && pattern.role !== el.role) return false;
  if (pattern.tag && el.tag && pattern.tag !== el.tag) return false;
  if (pattern.aria && el.ariaLabel && !String(el.ariaLabel).toLowerCase().includes(String(pattern.aria).toLowerCase())) return false;
  return true;
}

// per-pattern 成功率
function recomputePattern(p) {
  const total = (p.success || 0) + (p.failed || 0);
  p.successRate = total ? Math.round((p.success / total) * 1000) / 1000 : 0;
  return p;
}

function newPattern(pat) {
  return { ...pat, success: 0, failed: 0, successRate: 0, selected: 0 };
}

// ---------- 查询 ----------

function getRecord(site, semantic, ctx) {
  const base = String(site) + '|' + String(semantic).toLowerCase().trim();
  const ck = contextKey(ctx);
  // 1) 精确 context 匹配（解析时提供场景条件 → 同按钮不同场景记忆隔离）
  if (ck) {
    const exact = store.findWhere('aiElementMemory', (r) => r.key === base + '|' + ck && r.status === 'ACTIVE')
      .sort((a, b) => b.version - a.version)[0];
    if (exact) return exact;
  }
  // 2) 无 context 查询（统计/测试/通用读取）→ 返回最佳 ACTIVE 记录（含 context 专属），保证可读
  // C75 D1：前缀匹配必须落在 key 分隔符边界上 —— 否则 semantic 'search'（base='site|search'）
  // 会前缀命中 'searchbox'/'searchbar'（'site|searchbox|CTX...'）等更长语义的记忆，
  // 跨语义污染候选池（pattern 把关是宽松 includes，挡不住同文本元素）。
  if (!ck) {
    return store.findWhere('aiElementMemory', (r) => (r.key === base || r.key.indexOf(base + '|') === 0) && r.status === 'ACTIVE')
      .sort((a, b) => b.version - a.version)[0] || null;
  }
  // 3) 有 context 但未精确命中 → 回退 context-less 记录
  return store.findWhere('aiElementMemory', (r) => r.key === base && r.status === 'ACTIVE')
    .sort((a, b) => b.version - a.version)[0] || null;
}

// 候选：仅当 置信度≥阈值 且 pattern 命中观察 → 返回最佳（按 pattern 成功率排序）。
// opts.prefer（Phase 9 P2）：调用方对「该动作必须落在哪类控件上」的约束（如 submit 必须是可触发控件）。
//   记忆只提供候选，不越过约束：若没有任何已匹配候选满足 prefer，则本记忆不采用（返回 null），
//   由调用方继续走 semanticResolver。命中统计只在实际采用后累加，避免把「被拒绝的记忆」算成命中。
//   背景：真实 benchmark 中 127.0.0.1|搜索表单 的记忆是 tag=input（搜索输入框），success=208/failed=0 ——
//   因为「点击输入框」这个动作本身机械成功了，真正的业务失败发生在验证层，记忆却记成 208 次成功。
//   结论：element-level success ≠ business success，记忆不能对动作目标拥有否决权。
function getCandidate(site, semantic, observation, context, opts) {
  const ctx = context || contextOf(observation);
  const rec = getRecord(site, semantic, ctx);
  if (!rec || rec.confidence < MIN_CONFIDENCE) return null;
  const elems = (observation && observation.elements) || [];
  const matched = [];
  for (const p of rec.patterns || []) {
    const i = elems.findIndex((e) => matchPattern(p, e));
    if (i >= 0) matched.push({ p, el: elems[i], idx: i });
  }
  if (!matched.length) return null;
  const prefer = (opts && typeof opts.prefer === 'function') ? opts.prefer : null;
  let pool = matched;
  if (prefer) {
    pool = matched.filter((m) => prefer(m.el));
    if (!pool.length) return null; // 记忆候选不满足动作约束 → 不采用，交回语义解析
  }
  // conflict resolver：优先高 per-pattern 成功率 → 高样本 → 高记录置信度
  pool.sort((a, b) => {
    if ((b.p.successRate || 0) !== (a.p.successRate || 0)) return (b.p.successRate || 0) - (a.p.successRate || 0);
    const sa = (a.p.success || 0) + (a.p.failed || 0), sb = (b.p.success || 0) + (b.p.failed || 0);
    if (sb !== sa) return sb - sa;
    return (b.rec_conf || rec.confidence) - (a.rec_conf || rec.confidence);
  });
  const best = pool[0];
  best.p.selected = (best.p.selected || 0) + 1;
  recomputePattern(best.p);
  // 命中统计
  rec.stats = rec.stats || { hits: 0, memoryHits: 0, semanticFallback: 0, falsePositive: 0 };
  rec.stats.hits = (rec.stats.hits || 0) + 1;
  rec.stats.memoryHits = (rec.stats.memoryHits || 0) + 1;
  store.upsert('aiElementMemory', rec);
  return { record: rec, pattern: best.p, el: best.el, selector: semanticResolver.selectorFor(best.el, best.idx), confidence: rec.confidence, fromMemory: true };
}

// 语义降级时统计（归到 context-less 最佳记录，无记录则跳过）
function noteSemanticFallback(site, semantic) {
  const rec = getRecord(site, semantic, null);
  if (!rec) return;
  rec.stats = rec.stats || { hits: 0, memoryHits: 0, semanticFallback: 0, falsePositive: 0 };
  rec.stats.hits = (rec.stats.hits || 0) + 1;
  rec.stats.semanticFallback = (rec.stats.semanticFallback || 0) + 1;
  store.upsert('aiElementMemory', rec);
}

// ---------- 写入 ----------

// 动作成功后强化：无记录则创建；有记录则 pattern 演化（version++，旧 pattern 保留）+ 成功计数 + per-pattern 成功率。
// Phase 9 P3：确认一次「挂起的成功记忆」。
// 由 runtime 在业务验证通过后调用（tools.execute 只挂起、不再立即强化）。
// 返回实际写入的 record；conf 为空则直接返回 null（未产生定位结果，无可记忆内容）。
function confirmPendingSuccess(conf) {
  if (!conf || !conf.site || !conf.semantic || !conf.element) return null;
  try {
    return recordSuccess(conf.site, conf.semantic, conf.element, conf.meta || { type: 'ai_success' }, conf.context);
  } catch (e) { return null; }
}

function recordSuccess(site, semantic, elOrPattern, source, context) {
  const pat = newPattern(patternOf(elOrPattern));
  if (!Object.keys(patternOf(elOrPattern)).length) return null;
  const ctx = context || (elOrPattern && elOrPattern.observation ? contextOf(elOrPattern.observation) : null);
  const key = keyOf(site, semantic, ctx);
  const wasNew = !getRecord(site, semantic, ctx);
  let rec = getRecord(site, semantic, ctx);
  if (!rec) {
    rec = createBase({
      prefix: 'elem', key, site, semantic: String(semantic).trim(), purpose: String(semantic).trim(),
      patterns: [], elementType: elementTypeOf(elOrPattern), ...(source ? { source } : {}),
    });
  }
  const existing = (rec.patterns || []).find((p) => patternEquals(p, pat));
  if (existing) {
    existing.success = (existing.success || 0) + 1;
    recomputePattern(existing);
  } else {
    pat.success = 1; pat.successRate = 1;
    rec.patterns.push(pat);
    if (!wasNew) rec.version = (rec.version || 1) + 1; // 仅既有记录的模式演化递增版本
  }
  if (!rec.elementType) rec.elementType = elementTypeOf(elOrPattern);
  recordOutcome(rec, true);
  store.upsert('aiElementMemory', rec);
  return rec;
}

// 动作失败：降低置信度（仅对已有记忆生效；错误经验自动衰减）+ 误报统计 + per-pattern 失败。
function recordFailure(site, semantic, context, failedPattern) {
  const rec = getRecord(site, semantic, context);
  if (!rec) return null;
  recordOutcome(rec, false);
  if (failedPattern) {
    const m = (rec.patterns || []).find((p) => patternEquals(p, failedPattern));
    if (m) { m.failed = (m.failed || 0) + 1; recomputePattern(m); }
  }
  rec.stats = rec.stats || { hits: 0, memoryHits: 0, semanticFallback: 0, falsePositive: 0 };
  rec.stats.falsePositive = (rec.stats.falsePositive || 0) + 1;
  store.upsert('aiElementMemory', rec);
  return rec;
}

function listForSite(site) {
  return store.findWhere('aiElementMemory', (r) => r.site === site).sort((a, b) => b.updatedAt - a.updatedAt);
}

function listAll() {
  return store.read('aiElementMemory', []);
}

// ---------- 经验包导出 / 导入（商业化：站点经验可迁移）----------

function exportPack(site, opts) {
  opts = opts || {};
  const elements = store.findWhere('aiElementMemory', (r) => r.site === site);
  const sites = store.findWhere('aiSiteMemory', (r) => r.site === site);
  return {
    pack: {
      name: opts.name || (site + ' Experience Pack'),
      type: 'experience',
      format: PACK_FORMAT,
      version: 1,
      site,
      exportedAt: Date.now(),
      elementMemory: elements,
      siteMemory: sites,
    },
  };
}

function importPack(packObj) {
  const pack = packObj && packObj.pack ? packObj.pack : packObj;
  if (!pack || pack.format !== PACK_FORMAT) return { ok: false, error: '格式不支持', imported: 0, skipped: 0 };
  let imported = 0, skipped = 0;
  // C75 D2：导入记录的 site 必须与 pack.site 一致 —— 经验包内的 site 字段可被篡改/错误，
  // 直接 upsert 会绕过「跨站隔离」把记忆注入任意站点（matcher 的 site 硬隔离只防查询，
  // 防不了写入侧污染）。不一致记录计入 skipped，不静默改写。
  for (const r of pack.elementMemory || []) {
    if (r.site !== pack.site) { skipped++; continue; }
    const ex = store.find('aiElementMemory', r.id);
    if (!ex || (ex.version || 1) < (r.version || 1)) { store.upsert('aiElementMemory', r); imported++; }
    else skipped++;
  }
  for (const s of pack.siteMemory || []) {
    if (s.site !== pack.site) { skipped++; continue; }
    const ex = store.find('aiSiteMemory', s.id);
    if (!ex || (ex.version || 1) < (s.version || 1)) { store.upsert('aiSiteMemory', s); imported++; }
    else skipped++;
  }
  return { ok: true, imported, skipped };
}

module.exports = {
  getRecord, getCandidate, recordSuccess, recordFailure, confirmPendingSuccess, listForSite, listAll,
  contextOf, contextKey, patternOf, matchPattern, elementTypeOf, noteSemanticFallback,
  exportPack, importPack, MIN_CONFIDENCE, PACK_FORMAT,
};
