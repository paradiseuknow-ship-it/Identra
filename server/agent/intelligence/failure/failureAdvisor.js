'use strict';

// Failure Advisor（Phase 3.3）：失败经验查询 → 建议。
// 仅「建议」，绝不直接执行。返回的 recommendation 仍经 repairPlanner → repairPolicy → executor → verification。
// 决策流（成本降低）：
//   Failure
//     ↓
//   FailureKnowledge 查询（本模块）
//     ↓
//   命中且可用 → 直接推荐历史修复策略（跳过 LLM Diagnosis）
//     ↓
//   未命中 / 不可用 → 走正常 Diagnosis Engine

const failureKnowledge = require('./failureKnowledge');
const failureMatcher = require('./failureMatcher');
const failureScoring = require('./failureScoring');
const { normalizeUrlPattern } = require('./schema');

function siteOf(url) {
  if (!url) return null;
  try { return new URL(url).hostname || null; } catch (e) { return null; }
}

// 构造标准化失败上下文
function buildContext({ site, url, errorType, action, pageState, observationHash }) {
  const s = site || siteOf(url);
  return {
    site: s,
    errorType,
    actionType: action || '?',
    urlPattern: url ? normalizeUrlPattern(url) : '/',
    pageState: pageState || '?',
    observationHash: observationHash || null,
  };
}

// 推荐：返回是否命中、是否可用、建议策略与原因
function recommend(input) {
  const failure = buildContext(input || {});
  if (!failure.site || !failure.errorType) return { matched: false, reason: '上下文不足' };

  const list = failureKnowledge.getForSite(failure.site);
  const m = failureMatcher.lookup(failure, list);
  if (!m.matched) return { matched: false, fromFailureMemory: false };

  const fk = m.knowledge;
  const conf = failureScoring.failureConfidence(fk);
  const total = (fk.samples.success || 0) + (fk.samples.failed || 0);
  const usable = failureScoring.isUsable(fk);

  if (!usable) {
    return {
      matched: true, usable: false, fromFailureMemory: true,
      knowledgeId: fk.id, score: m.score, confidence: conf,
      reason: `历史经验置信度 ${conf} < ${failureScoring.AUTO_THRESHOLD}，自动复用风险过高，转人工/正常诊断`,
    };
  }

  const reason = `过去该站点 ${fk.condition.urlPattern || '/'} 页面 ${failure.actionType} 动作下 ${fk.evidence.errorType} 出现 ${total} 次，其中 ${fk.samples.success} 次经 ${m.recommendedStrategy} 修复成功`;
  return {
    matched: true, usable: true, fromFailureMemory: true,
    knowledgeId: fk.id, score: m.score, confidence: conf,
    category: m.category,
    recommendation: { category: m.category, strategy: m.recommendedStrategy, steps: m.steps, confidence: conf },
    reason,
  };
}

// 供 repairManager 决策：是否可跳过 LLM Diagnosis 直接复用历史策略
// 返回 { useMemory:true, syntheticDiagnosis } 或 { useMemory:false }
function resolveDiagnosis(input) {
  const adv = recommend(input);
  if (!adv.matched || !adv.usable) return { useMemory: false };
  const rec = adv.recommendation;
  return {
    useMemory: true,
    knowledgeId: adv.knowledgeId,
    syntheticDiagnosis: {
      category: rec.category,
      confidence: rec.confidence,
      facts: ['命中历史失败经验 ' + adv.knowledgeId],
      evidence: ['failureKnowledge 匹配得分 ' + adv.score],
      inference: '历史失败经验匹配，建议复用已验证修复策略',
      recommendation: (rec.steps || []).join(' → '),
      fromFailureMemory: true,
    },
  };
}

module.exports = { recommend, resolveDiagnosis, buildContext, siteOf };
