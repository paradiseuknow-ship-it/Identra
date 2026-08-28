'use strict';

// Profile Advisor（Phase 3.4）：对外「建议选哪个环境」。
// 关键约束：只建议，绝不执行。返回 recommendation 仍经 Chat→Planner→Policy→Runtime。
//   - 用户未指定 profileId：自动评估所有 Profile，选对「该目标」成功概率最高的环境。
//   - 用户已指定 profileId：尊重用户选择，仅回显其评分与理由（不覆盖）。
//
// 决策流（用户目标 → AI 选环境）：
//   用户目标
//     ↓
//   Profile Advisor（本模块）
//     ↓
//   选择成功概率最高的环境（建议）
//     ↓
//   Planner → Policy → Runtime（仍由人确认 / 策略门禁）

const analyzer = require('./profileAnalyzer');
const matcher = require('./profileMatcher');

// 从 URL 取 site（hostname）
function siteOf(url) {
  if (!url) return null;
  try { return new URL(url).hostname || null; } catch (e) { return null; }
}

// 建议：返回 { recommendation: { profileId, confidence, reason, specificity, ranking } }
// input: { site, task, region, profileIdHint }
function recommend(input) {
  input = input || {};
  const site = input.site || siteOf(input.url);
  const records = analyzer.listRecords();
  if (!records.length) return { matched: false, reason: '暂无 Profile 评分数据' };

  // 用户已显式指定环境 → 尊重，不覆盖
  if (input.profileIdHint) {
    const rec = analyzer.getRecord(input.profileIdHint);
    if (!rec) return { matched: false, reason: '指定 Profile 无评分记录: ' + input.profileIdHint };
    const ss = site ? (rec.siteScores && rec.siteScores[site]) : null;
    const siteScore = ss ? (typeof ss === 'number' ? ss : (ss.score || 0)) : null;
    return {
      matched: true,
      respectingUserChoice: true,
      recommendation: {
        profileId: rec.profileId, name: rec.name,
        confidence: ss ? (typeof ss === 'number' ? 0.3 : (ss.confidence != null ? ss.confidence : 0.3)) : 0.2,
        specificity: siteScore != null ? 'site' : 'environment',
        status: rec.status,
        reason: siteScore != null
          ? `沿用用户指定环境；该站评分 ${Math.round(siteScore)}`
          : `沿用用户指定环境；该站无历史，按环境质量评估`,
      },
    };
  }

  if (!site) return { matched: false, reason: '缺少目标站点（site/url）' };

  const m = matcher.match(records, { site, task: input.task, region: input.region });
  if (!m.matched) return { matched: false, reason: m.reason };
  return {
    matched: true,
    recommendation: {
      profileId: m.recommendation.profileId,
      name: m.recommendation.name,
      confidence: m.recommendation.confidence,
      specificity: m.recommendation.specificity,
      status: m.recommendation.status,
      reason: m.reason,
    },
    ranking: m.ranking,
  };
}

// 供 Chat/Planner 集成：返回建议的 profileId（无则用 null，沿用既有逻辑）
function recommendProfileId(input) {
  const r = recommend(input);
  return r.matched ? r.recommendation.profileId : null;
}

module.exports = { recommend, recommendProfileId, siteOf };
