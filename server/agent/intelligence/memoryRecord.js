'use strict';

// Memory Record 基座（Phase 3.1 Memory Infrastructure）。
// 所有记忆记录统一字段：id / version / status / confidence / samples / successRate / source / stats / createdAt / updatedAt。
// 来源可信度：human > ai_success > site_adapter > import；低样本置信度自动保守。
// stats：记忆价值量化（命中率 / 误报），用于判断某站点是否值得持续投入优化。

const SOURCE_TYPES = ['human', 'ai_success', 'import', 'site_adapter'];
const SOURCE_WEIGHT = { human: 1.1, ai_success: 1.0, site_adapter: 0.95, import: 0.9 };
const STATUS = ['ACTIVE', 'DEPRECATED', 'ARCHIVED'];

function uid(prefix) {
  return (prefix || 'mem') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 新记录：status=ACTIVE、version=1、confidence=0（需积累样本）
function createBase(overrides = {}) {
  return {
    id: overrides.id || uid(overrides.prefix),
    version: overrides.version || 1,
    status: 'ACTIVE',
    confidence: 0,
    samples: { success: 0, failed: 0, ...(overrides.samples || {}) },
    successRate: 0,
    source: { type: 'ai_success', ...(overrides.source || {}) },
    // 记忆价值统计：hits=总查询；memoryHits=命中记忆；semanticFallback=降级语义；falsePositive=记忆命中却失败
    stats: { hits: 0, memoryHits: 0, semanticFallback: 0, falsePositive: 0, ...(overrides.stats || {}) },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// 递增某条统计字段（hits 单独计，不在此处处理）
function bumpStat(rec, field) {
  if (!rec) return;
  rec.stats = rec.stats || { hits: 0, memoryHits: 0, semanticFallback: 0, falsePositive: 0 };
  rec.stats[field] = (rec.stats[field] || 0) + 1;
}

// 记录一次结果 → 更新 successRate / confidence / status
function recordOutcome(rec, ok) {
  if (ok) rec.samples.success = (rec.samples.success || 0) + 1;
  else rec.samples.failed = (rec.samples.failed || 0) + 1;
  const total = rec.samples.success + rec.samples.failed;
  rec.successRate = total ? Math.round((rec.samples.success / total) * 1000) / 1000 : 0;
  rec.confidence = computeConfidence(rec);
  rec.updatedAt = Date.now();
  // 长期低成功率 → 自动降级为 DEPRECATED（不删除旧经验，只是不再被消费）
  if (total >= 5 && rec.successRate < 0.4 && rec.status === 'ACTIVE') rec.status = 'DEPRECATED';
  return rec;
}

// 置信度 = successRate × 样本成熟度 × 来源权重
function computeConfidence(rec) {
  const rate = rec.successRate || 0;
  const total = (rec.samples.success || 0) + (rec.samples.failed || 0);
  const maturity = Math.min(1, total / 4); // 4+ 样本达到完全可信
  const src = SOURCE_WEIGHT[(rec.source && rec.source.type) || 'ai_success'] || 1;
  return Math.round(Math.min(1, Math.max(0, rate * (0.75 + 0.25 * maturity) * src)) * 1000) / 1000;
}

module.exports = { createBase, recordOutcome, computeConfidence, bumpStat, SOURCE_TYPES, SOURCE_WEIGHT, STATUS };
