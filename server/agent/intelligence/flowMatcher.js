'use strict';

// Flow Matcher：用户目标 → 站点 → 最佳历史 flow（按置信度）。
// 与 flowMemory 单向依赖（不反向 require，避免循环）：由调用方传入候选 flows。
// 决策：confidence ≥ LOAD_THRESHOLD → 直接加载历史 flow（不调用 LLM Planner）；
//       否则 → 返回 reused:false，交由上游走 LLM 规划。

const { normalizeGoal } = require('./flowSchema');

const LOAD_THRESHOLD = 0.85;

// flows: 同一 (site) 下的 flow 记录数组
function lookup(site, goal, flows) {
  if (!site || !flows || !flows.length) return null;
  const ng = normalizeGoal(goal);
  const candidates = flows.filter((f) => f.site === site && f.goal === ng && (f.status || 'ACTIVE') === 'ACTIVE');
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const best = candidates[0];
  return {
    flow: best,
    confidence: best.confidence || 0,
    reused: (best.confidence || 0) >= LOAD_THRESHOLD,
  };
}

module.exports = { lookup, LOAD_THRESHOLD };
