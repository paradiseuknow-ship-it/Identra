'use strict';

// Profile Matcher（Phase 3.4）：把「目标站点 / 任务 / 地区」映射到最佳 Profile。
// 设计要点（用户强调）：
//   1) 选「对这个目标最好的环境」，不是「总体最好的环境」——站点专属分优先。
//   2) 跨站隔离：某站成功的环境，不能因其它站的高分被自动推荐到无关站点。
//      → 仅当 siteScores[site] 存在时才使用该站专属分；否则走「纯环境质量」评估（不借用其它站成绩）。
//   3) 地区偏好：profile.region 与请求 region 匹配加分，不符减分（未知则中性）。
//   4) 生命周期修正：WARNING/DEGRADED 仍可考虑但扣分并标注；DISABLED 直接跳过。
//   5) 仅输出建议，不执行（决策仍经 Policy → Runtime）。

const scoring = require('./profileScore');

// 纯环境质量（无站点历史时的兜底评估）：fingerprint/network/storage 三者均值
function envComposite(rec) {
  const d = rec.dimensions || {};
  return Math.round(((d.fingerprint || 0) + (d.network || 0) + (d.storage || 0)) / 3);
}

const PROVEN_BONUS = 12;  // 有该站专属历史 → 加点（证明可用，避免被「总体好环境但本站未知」反超）
const REGION_MATCH = 5;   // 地区匹配加分
const REGION_MISMATCH = -15; // 地区不符减分
const LIFE_PENALTY = { WARNING: -5, DEGRADED: -15 };

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

// records: analyzer.listRecords() 的结果数组
// input: { site, task, region }
function match(records, input) {
  input = input || {};
  const site = input.site || null;
  const region = input.region ? String(input.region).toUpperCase() : null;
  if (!records || !records.length) return { matched: false, reason: '无可用 Profile' };

  const ranked = [];
  for (const rec of records) {
    if ((rec.status || 'ACTIVE') === 'DISABLED') continue; // 人工禁用跳过
    const ss = site ? (rec.siteScores && rec.siteScores[site]) : null;
    const hasSite = ss && (typeof ss === 'number' || (ss.samples || 0) >= 1);

    let base, specificity, confidence, reasons = [];
    if (hasSite) {
      const siteScore = typeof ss === 'number' ? ss : (ss.score || 0);
      const siteConf = typeof ss === 'number' ? 0.3 : (ss.confidence != null ? ss.confidence : 0.3);
      base = 0.75 * siteScore + 0.25 * (rec.score || 0);
      specificity = 'site';
      confidence = siteConf;
      const tot = (typeof ss === 'number' ? 0 : ((ss.success || 0) + (ss.failed || 0))) || 0;
      reasons.push(`该站历史样本 ${tot} 次，站点评分 ${Math.round(siteScore)}`);
    } else {
      const env = envComposite(rec);
      base = 0.7 * env + 0.3 * (rec.score || 0);
      specificity = 'environment';
      confidence = 0.2; // 无站点历史，置信度低
      reasons.push('该站无历史，按环境质量评估（指纹/网络/存储）');
    }

    let adj = 0;
    // 站点专属加分
    if (specificity === 'site') { adj += PROVEN_BONUS; reasons.push('有该站验证经验'); }

    // 地区修正
    const pr = rec.region ? String(rec.region).toUpperCase() : null;
    if (region && pr) {
      if (pr === region) { adj += REGION_MATCH; reasons.push('地区匹配 ' + region); }
      else { adj += REGION_MISMATCH; reasons.push('地区不符(' + pr + '≠' + region + ')'); }
    } else if (region && !pr) {
      reasons.push('地区未知，未参与地区判定');
    }

    // 生命周期修正
    const life = LIFE_PENALTY[rec.status];
    if (life) { adj += life; reasons.push('环境状态 ' + rec.status); }

    const finalScore = clamp(Math.round(base + adj), 0, 100);
    ranked.push({
      profileId: rec.profileId, name: rec.name, score: finalScore, baseScore: Math.round(base),
      specificity, confidence, status: rec.status, region: rec.region || null, reasons,
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  if (!ranked.length) return { matched: false, reason: '无可用 Profile（可能全部 DISABLED）' };
  const best = ranked[0];
  return {
    matched: true,
    recommendation: best,
    ranking: ranked.slice(0, 3),
    reason: best.reasons.join('；'),
  };
}

module.exports = { match, envComposite, PROVEN_BONUS, REGION_MATCH, REGION_MISMATCH, LIFE_PENALTY };
