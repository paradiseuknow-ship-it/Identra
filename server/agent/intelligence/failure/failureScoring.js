'use strict';

// Failure Scoring（Phase 3.3）：失败经验专用「更保守」置信度。
// 失败经验比成功经验危险，所以比 Flow/Element 信任曲线更保守：
//   confidence = successRate × sampleFactor × freshness × sourceWeight
// 来源权重：human_confirmed 1.2 / repair_success 1.0 / ai_success 0.9 / import 0.7
//   （错误经验一旦被轻信，可能反复执行错误修复，故 import 权重最低）
// 自动可用阈值 AUTO_THRESHOLD = 0.5：低于此值只记录、不自动建议复用。

const SOURCE_WEIGHT = {
  human_confirmed: 1.2,
  repair_success: 1.0,
  ai_success: 0.9,
  import: 0.7,
};

const AUTO_THRESHOLD = 0.5;
const DAY_MS = 1000 * 60 * 60 * 24;

function failureConfidence(rec) {
  const rate = rec.successRate || 0;
  const total = (rec.samples.success || 0) + (rec.samples.failed || 0);
  // 样本成熟度：5+ 样本才完全可信（比元素记忆 4 更保守）
  const sampleFactor = Math.min(1, total / 5);
  // 新鲜度：30 天线性衰减至 0.5 下限（老失败经验可能已失效）
  const ageMs = Date.now() - (rec.updatedAt || Date.now());
  const ageDays = Math.max(0, ageMs / DAY_MS);
  const freshness = Math.max(0.5, 1 - ageDays / 30);
  const src = SOURCE_WEIGHT[(rec.source && rec.source.type) || 'repair_success'] || 1;
  const c = rate * (0.6 + 0.4 * sampleFactor) * freshness * src;
  return Math.round(Math.min(1, Math.max(0, c)) * 1000) / 1000;
}

// 是否可用于「自动建议复用」（仍需走 Policy 门禁）
function isUsable(rec) {
  if (!rec || (rec.status || 'ACTIVE') !== 'ACTIVE') return false;
  return failureConfidence(rec) >= AUTO_THRESHOLD;
}

module.exports = { failureConfidence, isUsable, SOURCE_WEIGHT, AUTO_THRESHOLD };
