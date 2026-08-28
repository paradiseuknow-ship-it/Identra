'use strict';

// Failure Matcher（Phase 3.3）。
// 输入失败上下文 → 在站点历史失败经验中加权匹配。
// 关键：不能「只按 errorType 匹配」。维度 = site(必中) + errorType + actionType + urlPattern + pageState 加权。
// 纯 errorType 命中（其余维度均不匹配）→ 得分过低被拒。

const { normalizeUrlPattern } = require('./schema');

const MATCH_THRESHOLD = 0.6; // 加权得分 ≥ 0.6 才算命中

// 单条加权匹配：site 不同直接 0（跨站隔离）。各维度权重和=1.0。
function matchScore(failure, fk) {
  if (!fk || !failure) return 0;
  if (fk.site !== failure.site) return 0; // 跨站隔离（Case4）
  const c = fk.condition || {};
  let score = 0;
  if (fk.evidence && fk.evidence.errorType === failure.errorType) score += 0.3;     // 错误类型
  if ((c.actionType || '?') === (failure.actionType || '?')) score += 0.25;          // 动作类型
  if (urlMatch(c.urlPattern, failure.urlPattern || failure.url)) score += 0.25;       // 页面路径
  if ((c.pageState || '?') === (failure.pageState || '?')) score += 0.2;              // 页面/流程状态
  return Math.round(score * 1000) / 1000;
}

function urlMatch(pattern, url) {
  if (!pattern && !url) return true;
  if (!pattern || !url) return false;
  try { return normalizeUrlPattern(url) === normalizeUrlPattern(pattern); } catch (e) { return false; }
}

// 在候选集中找最佳命中（不按 status 过滤：DEPRECATED 也参与匹配，
// 由上层 advisor 的 isUsable 决定「可用/仅观测」，提升可观测性）。
function lookup(failure, list) {
  if (!failure || !failure.site || !Array.isArray(list) || !list.length) return { matched: false };
  let best = null, bestScore = 0;
  for (const fk of list) {
    const s = matchScore(failure, fk);
    if (s > bestScore) { bestScore = s; best = fk; }
  }
  if (!best || bestScore < MATCH_THRESHOLD) return { matched: false, bestScore };
  // 推荐策略取 solution（由 failureScoring 复核最终可用置信度）
  return {
    matched: true,
    score: bestScore,
    knowledgeId: best.id,
    category: best.category,
    recommendedStrategy: best.solution && best.solution.strategy,
    steps: (best.solution && best.solution.steps) || [],
    knowledge: best,
  };
}

module.exports = { lookup, matchScore, MATCH_THRESHOLD };
