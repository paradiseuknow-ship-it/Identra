'use strict';

// Context Builder：从用户目标 / URL / region / constraints 组装 Router 所需的统一上下文（Phase 3.5）。
// 把分散在 chat / planner 的解析结果归一化，供 advisorRegistry 中各 advisor 消费。

const profileAdvisor = require('../profile/profileAdvisor');
const siteMemory = require('../siteMemory');
const flowMemory = require('../flowMemory');
const failureAdvisor = require('../failure/failureAdvisor');

function siteOfUrl(url) {
  if (!url) return null;
  try { return new URL(url).hostname || null; } catch (e) { return null; }
}

// 把 chat 的 parser 输出 + 当前 profileId 统一成 Router 上下文。
function buildContext({ objective, targetUrl, region, constraints, profileId }) {
  const site = siteOfUrl(targetUrl);
  const goal = (objective || '').trim();
  return {
    objective: goal,
    site,
    url: targetUrl || null,
    region: region || null,
    constraints: constraints || {},
    profileIdHint: profileId || null,
    // 直接可用的原始记忆句柄（advisor 内部按需查，避免重复加载）
    _raw: {
      profileAdvisor, siteMemory, flowMemory, failureAdvisor,
    },
  };
}

// 站点画像（供 scoring / explanation）
function siteProfile(site) {
  if (!site) return null;
  return siteMemory.getSite(site);
}

module.exports = { buildContext, siteOfUrl, siteProfile };
