'use strict';

// CAP-K2：把 Intelligence Router 决策接入任务创建链（此前只有 /chat 读 profileId，
// 失败经验 warnings 在任何路径都没进过执行链）。
// 原则：
//   - 只读、仅建议，绝不执行（沿用 Router 契约）；
//   - fail-open：Router 任何异常不阻断任务创建；
//   - 调用方显式指定的 profileId 永远优先，Router 只做「未指定时的补齐」。

const router = require('./intelligenceRouter');

// Router 完整结果 → 任务可携带的精简 hints（纯函数）
function toIntelligence(d) {
  if (!d || !d.decision) return null;
  const dec = d.decision;
  return {
    profileId: dec.profile ? dec.profile.id : null,
    flowId: dec.flow ? dec.flow.id : null,
    expectedSuccess: dec.strategy ? dec.strategy.expectedSuccess : null,
    warnings: Array.isArray(d.warnings) ? d.warnings : [],
    summary: d.explanation && d.explanation.summary ? d.explanation.summary : null,
  };
}

// 输入任务创建 body → { input, intelligence }。
// intelligence 非空时：input 补齐 profileId（仅当调用方未指定）并挂 routerHints。
function enhanceTaskInput(input) {
  input = input || {};
  let intelligence = null;
  if (input.objective || input.targetUrl) {
    try {
      const d = router.decide({
        objective: input.objective || '',
        targetUrl: input.targetUrl || '',
        region: input.region,
        constraints: Array.isArray(input.constraints) ? input.constraints : [],
        profileId: input.profileId || null,
      });
      intelligence = toIntelligence(d);
    } catch (e) { /* fail-open：Router 失败不阻断创建 */ }
  }
  const enhanced = Object.assign({}, input);
  if (!enhanced.profileId && intelligence && intelligence.profileId) {
    enhanced.profileId = intelligence.profileId;
  }
  if (intelligence) enhanced.routerHints = intelligence;
  return { input: enhanced, intelligence };
}

module.exports = { enhanceTaskInput, toIntelligence };
