'use strict';

// Decision Scoring：把各 Advisor 的产出汇成单一「预计成功率」（Phase 3.5）。
// 不简单拼接，按经验可信度加权：
//   profileScore * 0.35 + flowConfidence * 0.30 + failureRisk * 0.15 + siteConfidence * 0.10 + freshness * 0.10
// 经验越成熟权重越高；缺少经验的维度计 0（不惩罚，由 requireLLM 补偿）。

const WEIGHTS = {
  profile: 0.35,
  flow: 0.30,
  failure: 0.15,
  site: 0.10,
  freshness: 0.10,
};

// 把 0~100 的评分归一到 0~1
function norm(v) {
  if (v == null) return null;
  return Math.max(0, Math.min(1, v / 100));
}

// failureRisk：经验给出的「失败风险」→ 反向为安全分（0~1）。
// 输入 failure：{ matched, usable, confidence }。无经验 → null（不计入，权重转移）。
function failureSafety(failure) {
  if (!failure || !failure.matched) return null; // 无历史经验，不参与
  if (!failure.usable) return 0.2;              // 命中但不可靠 → 高风险
  return Math.max(0.3, Math.min(1, failure.confidence || 0.5));
}

// siteConfidence：站点整体成熟度（0~1）。
function siteConfidenceOf(site) {
  if (!site) return null;
  const sr = site.successRate != null ? site.successRate : (site.confidence != null ? site.confidence : null);
  return norm(sr);
}

// freshness：整体经验新鲜度（0~1）。由各 advisor 的最近更新时间派生，缺省 0.5。
function freshnessOf(parts) {
  const stamps = (parts || []).filter((x) => typeof x === 'number' && x > 0);
  if (!stamps.length) return 0.5;
  const newest = Math.max.apply(null, stamps);
  const ageDays = (Date.now() - newest) / 86400000;
  // 30 天内 1.0，衰减至 90 天 0.5
  return Math.max(0.5, Math.min(1, 1 - Math.max(0, ageDays - 30) / 120));
}

// 主函数：返回 { score(0~1), parts, breakdown[] }
function decisionScore({ profileScore, flowConfidence, failure, site, freshnessParts }) {
  const p = norm(profileScore);
  const f = norm(flowConfidence);
  const fr = failureSafety(failure);
  const s = siteConfidenceOf(site);
  const fr2 = freshnessOf(freshnessParts);

  // 有效维度计数（用于重新归一，避免缺经验时总分虚低）
  const terms = [
    { k: 'profile', v: p, w: WEIGHTS.profile },
    { k: 'flow', v: f, w: WEIGHTS.flow },
    { k: 'failure', v: fr, w: WEIGHTS.failure },
    { k: 'site', v: s, w: WEIGHTS.site },
    { k: 'freshness', v: fr2, w: WEIGHTS.freshness },
  ].filter((t) => t.v != null);

  const wsum = terms.reduce((a, t) => a + t.w, 0);
  const score = terms.reduce((a, t) => a + t.v * t.w, 0) / (wsum || 1);

  return {
    score: Math.round(score * 1000) / 1000,
    expectedSuccess: Math.round(score * 1000) / 1000,
    parts: { profileScore: p, flowConfidence: f, failureSafety: fr, siteConfidence: s, freshness: fr2 },
    breakdown: terms.map((t) => ({ dim: t.k, value: Math.round(t.v * 1000) / 1000, weight: t.w })),
  };
}

module.exports = { WEIGHTS, decisionScore, norm, failureSafety, siteConfidenceOf, freshnessOf };
