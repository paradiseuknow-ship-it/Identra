'use strict';

// Intelligence Router：第三阶段架构收口（Phase 3.5）。
// 唯一智能入口。不执行任何浏览器动作，只回答「完成这个任务，当前最佳策略是什么」。
//
// 决策顺序（经验优先，LLM 最后补充，由 advisorRegistry priority 保证）：
//   1. Profile Advisor   (priority 100) 选对该目标最好的环境
//   2. Site Memory       (priority 95)  站点成熟度 / 高频失败
//   3. Flow Memory       (priority 90)  复用已验证流程
//   4. Failure Knowledge (priority 80)  历史失败规避
//   5. Element Memory    (priority 70)  元素定位经验（仅标注可用，不取 selector）
//   6. Planner / LLM     (priority 10)  经验不足时生成计划
//
// 输出：{ decision:{ profile, flow, strategy, score }, reasons, warnings, fromCache }

const registry = require('./advisorRegistry');
const { buildContext, siteProfile } = require('./contextBuilder');
const { decisionScore } = require('./decisionScoring');
const { explain } = require('./explain');
const { validateDecision, sanitizeActions } = require('./decisionSchema');
const cache = require('./decisionCache');

const profileAdvisor = require('../profile/profileAdvisor');
const siteMemory = require('../siteMemory');
const flowMemory = require('../flowMemory');
const failureAdvisor = require('../failure/failureAdvisor');
const failureKnowledge = require('../failure/failureKnowledge');
const failureScoring = require('../failure/failureScoring');
const elementMemory = require('../elementMemory');

// ---------- 默认 advisor 注册（可扩展，不改 Router） ----------
function registerDefaults() {
  registry.register({
    name: 'profile', priority: 100,
    run: (ctx) => profileAdvisor.recommend({ site: ctx.site, url: ctx.url, task: ctx.objective, region: ctx.region, profileIdHint: ctx.profileIdHint }),
  });
  registry.register({
    name: 'site', priority: 95,
    run: (ctx) => siteProfile(ctx.site),
  });
  registry.register({
    name: 'flow', priority: 90,
    run: (ctx) => {
      if (!ctx.site || !ctx.objective) return null;
      const m = flowMemory.lookup(ctx.site, ctx.objective);
      if (!m) return null;
      return { matched: m.reused, flowId: m.flow && m.flow.id, confidence: m.confidence, fromFlow: m.reused };
    },
  });
  registry.register({
    name: 'failure', priority: 80,
    run: (ctx) => {
      if (!ctx.site) return null;
      // 预测性查询：该站点是否存在任何历史失败经验（用于 warning，而非精确匹配）。
      const list = failureKnowledge.getForSite(ctx.site);
      if (!list || !list.length) return { matched: false, fromFailureMemory: false };
      // 取最新的可用经验作为风险提示来源
      const recent = list.find((f) => f.status === 'ACTIVE') || list[0];
      return {
        matched: true,
        fromFailureMemory: true,
        knowledgeId: recent.id,
        category: recent.category,
        confidence: failureScoring.failureConfidence(recent),
        recommendation: recent.solution || null,
        sampleCount: list.length,
      };
    },
  });
  registry.register({
    name: 'element', priority: 70,
    run: (ctx) => {
      if (!ctx.site) return null;
      // 仅标注该站点是否有可用元素记忆（不取 selector，避免误用）。
      const el = elementMemory.listForSite ? elementMemory.listForSite(ctx.site) : null;
      const has = Array.isArray(el) && el.length > 0;
      return { hasElementMemory: has, count: has ? el.length : 0 };
    },
  });
  registry.register({
    name: 'planner', priority: 10,
    run: () => ({ deferred: true, note: '经验不足时由 Planner/LLM 生成' }),
  });
}

let defaultsRegistered = false;
function ensureDefaults() {
  if (!defaultsRegistered) { registerDefaults(); defaultsRegistered = true; }
}

// ---------- 主决策入口 ----------
// input: { objective, targetUrl, region, constraints, profileId, useCache=true }
// 返回：{ decision, reasons, warnings, explanation, fromCache, advisors }
function decide(input) {
  input = input || {};
  ensureDefaults();

  const ctx = buildContext(input);
  if (!ctx.objective && !ctx.site) {
    return { error: '缺少目标（objective 或 targetUrl）', decision: null };
  }

  // 1) Decision Cache（TTL 24h）
  const cacheKey = cache.key(ctx);
  if (input.useCache !== false) {
    const hit = cache.get(cacheKey);
    if (hit) {
      return Object.assign({}, hit, { fromCache: true });
    }
  }

  // 2) 顺序执行 advisor（registry 已按 priority 排序）
  const advisorResults = registry.runAll(ctx);
  const byName = {};
  for (const r of advisorResults) byName[r.name] = r.result;

  // 3) 汇总各 advisor 结果
  const profileR = byName.profile;
  const siteR = byName.site;
  const flowR = byName.flow;
  const failureR = byName.failure;
  const elementR = byName.element;

  // 3.1 Profile 决策
  const chosenProfile = (profileR && profileR.matched)
    ? {
        id: profileR.recommendation.profileId,
        name: profileR.recommendation.name,
        score: Math.round((profileR.recommendation.confidence || 0.5) * 100),
        specificity: profileR.recommendation.specificity,
        confidence: profileR.recommendation.confidence,
        reason: profileR.recommendation.reason,
      }
    : null;

  // 3.2 Flow 决策
  const chosenFlow = (flowR && flowR.matched)
    ? { id: flowR.flowId, confidence: flowR.confidence }
    : null;

  // 3.3 Failure 风险（用于 warning + scoring）
  const failureForScore = (failureR && failureR.matched)
    ? { matched: true, usable: true, confidence: failureR.confidence || 0 }
    : { matched: false };

  // 3.4 策略组装
  const hasMemory = !!(chosenProfile || chosenFlow);
  const requireLLM = !chosenFlow; // 无高置信流程 → 需 LLM 规划
  const useMemory = hasMemory;

  // 安全边界：永远不输出被禁止的动作
  const sanitized = sanitizeActions([]); // 当前 Router 原生不产出任何禁止动作
  const strategy = {
    useMemory,
    requireLLM,
    expectedSuccess: 0, // 由 scoring 回填
    actions: sanitized.actions,
    memoryLayers: {
      profile: !!chosenProfile,
      flow: !!chosenFlow,
      failure: !!(failureR && failureR.matched),
      element: !!(elementR && elementR.hasElementMemory),
      site: !!siteR,
    },
  };

  // 3.5 评分
  const score = decisionScore({
    profileScore: chosenProfile ? chosenProfile.score : null,
    flowConfidence: chosenFlow ? Math.round((chosenFlow.confidence || 0.5) * 100) : null,
    failure: failureForScore,
    site: siteR,
    freshnessParts: [
      chosenProfile && chosenProfile.confidence ? Date.now() : null,
      siteR && siteR.updatedAt,
      flowR && flowR.matched ? Date.now() : null,
    ],
  });
  strategy.expectedSuccess = score.expectedSuccess;

  const decision = { profile: chosenProfile, flow: chosenFlow, strategy };

  // 4) 解释
  const explanation = explain(
    { profile: chosenProfile, flow: chosenFlow, strategy, _failure: failureR, _site: siteR },
    ctx,
  );

  // 5) 结构校验（安全红线）
  const v = validateDecision({ decision });
  if (!v.ok) {
    return { error: 'decision 校验失败: ' + v.errors.join('; '), decision: null };
  }

  const result = {
    decision,
    reasons: explanation.reasons,
    warnings: explanation.warnings,
    explanation,
    fromCache: false,
    advisors: advisorResults,
  };

  // 6) 写入缓存
  if (input.useCache !== false) cache.set(cacheKey, result);
  return result;
}

// 仅取推荐 profileId（供 chat 集成）
function recommendProfileId(input) {
  const r = decide(input);
  return (r.decision && r.decision.profile) ? r.decision.profile.id : null;
}

module.exports = { decide, recommendProfileId, registerDefaults, ensureDefaults, registry };
