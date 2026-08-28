'use strict';

// Failure Knowledge 存储层（Phase 3.3）。
// 集合：aiFailureKnowledge。落库/演化/Outcome 回写。
// failureContextKey：site + errorType + actionType + urlPattern + pageState —— 防止「只按 errorType 匹配」。

const store = require('../../store');
const { createBase, recordOutcome: recordOutcomeBase } = require('../memoryRecord');
const { validate, normalizeUrlPattern } = require('./schema');
const { failureConfidence } = require('./failureScoring');

const COLLECTION = 'aiFailureKnowledge';

function contextKey(f) {
  const url = normalizeUrlPattern(f.urlPattern || f.url || '/');
  return [
    String(f.site || '?'),
    String(f.errorType || '?'),
    String(f.actionType || '?'),
    url,
    String(f.pageState || '?'),
  ].join('|');
}

function getByKey(key) {
  // 注意：按 key 匹配「不限制 status」——DEPRECATED 记录仍需被演化（强化统计），
  // 仅消费侧（advisor/matcher）过滤 ACTIVE，避免重复创建。
  return store.findWhere(COLLECTION, (r) => r.key === key)
    .sort((a, b) => (b.version || 1) - (a.version || 1))[0] || null;
}

function getById(id) {
  return store.find(COLLECTION, id);
}

function getForSite(site) {
  return store.findWhere(COLLECTION, (r) => r.site === site).sort((a, b) => b.updatedAt - a.updatedAt);
}

function listAll() {
  return store.read(COLLECTION, []);
}

// 落库一条失败经验（新建或演化既有）。condition 决定 key。
// opts.source 默认 repair_success；category 受保护类别强制 REAUTH_OR_PAUSE。
function record(site, category, condition, evidence, solution, opts) {
  opts = opts || {};
  const fk = {
    site,
    category,
    condition: condition || {},
    symptoms: opts.symptoms || [],
    evidence: evidence || {},
    solution, // { strategy, steps[] }
  };
  const v = validate(fk);
  if (!v.ok) return { ok: false, error: v.errors.join('; ') };

  const key = contextKey({ site, errorType: evidence && evidence.errorType, actionType: condition && condition.actionType, urlPattern: condition && condition.urlPattern, pageState: condition && condition.pageState });
  let rec = getByKey(key);
  if (rec) {
    rec.version = (rec.version || 1) + 1; // 演化：版本递增，旧经验不删
    rec.symptoms = Array.from(new Set([...(rec.symptoms || []), ...(opts.symptoms || [])])).slice(0, 8);
    rec.updatedAt = Date.now();
  } else {
    rec = createBase({
      prefix: 'fk', key, site,
      category, condition: fk.condition, symptoms: fk.symptoms,
      evidence: fk.evidence, solution: fk.solution,
      source: opts.source || { type: 'repair_success' },
    });
  }
  rec.confidence = failureConfidence(rec);
  store.upsert(COLLECTION, rec);
  return { ok: true, fk: rec, created: !rec.version || rec.version === 1 };
}

// 回写一次修复结果 → 更新 successRate / confidence / status
function recordOutcome(fkId, ok) {
  const rec = store.find(COLLECTION, fkId);
  if (!rec) return null;
  recordOutcomeBase(rec, ok);
  rec.confidence = failureConfidence(rec);
  // 长期低成功率 → 自动降级为 DEPRECATED（不再被消费，但保留供审计）；
  // 若后续成功率回升（≥0.4）则复活为 ACTIVE，避免「曾经差但已变好」的经验被永久忽略。
  const total = (rec.samples.success || 0) + (rec.samples.failed || 0);
  if (total >= 5 && rec.successRate < 0.4 && rec.status === 'ACTIVE') rec.status = 'DEPRECATED';
  else if (total >= 5 && rec.successRate >= 0.4 && rec.status === 'DEPRECATED') rec.status = 'ACTIVE';
  store.upsert(COLLECTION, rec);
  return rec;
}

// 经验包导出 / 导入（商业化：站点经验整体迁移，含 Element + Site + Flow + Failure）
function exportPack(site) {
  return store.findWhere(COLLECTION, (r) => r.site === site);
}
function importPack(arr) {
  let imported = 0, skipped = 0;
  for (const r of arr || []) {
    const ex = store.find(COLLECTION, r.id);
    if (!ex || (ex.version || 1) < (r.version || 1)) { store.upsert(COLLECTION, r); imported++; }
    else skipped++;
  }
  return { imported, skipped };
}

module.exports = {
  record, recordOutcome, getByKey, getById, getForSite, listAll, contextKey,
  exportPack, importPack, COLLECTION,
};
