'use strict';

// Flow Planner：规划消费点（Phase 3.2）。
// 决策流：
//   用户目标
//     ↓
//   flowMemory.lookup(site, goal)   ← 置信度判断
//     ≥ 0.85 : 加载历史 flow（toPlan），不调用 LLM Planner
//     < 0.85 : 调用 LLM Planner 生成
// Flow 只提供状态建议，生成的 Plan 仍走 policy / verification / tools，绝不绕过。

const planner = require('../planner');
const flowMemory = require('./flowMemory');
const flowMatcher = require('./flowMatcher');

async function planWithMemory({ objective, target, executionMode, provider, ctx, ...rest }) {
  const site = flowMemory.siteOf(target);
  if (site) {
    const m = flowMemory.lookup(site, objective);
    if (m && m.reused) {
      const plan = flowMemory.toPlan(m.flow, target);
      return { ok: true, plan, fromFlow: true, flowId: m.flow.id, confidence: m.confidence };
    }
  }
  // 无高置信度历史 → LLM 规划（不自动执行）
  const pr = await planner.planObjective({ objective, target, executionMode, provider, ctx, ...rest });
  if (pr.ok) pr.fromFlow = false;
  return pr;
}

module.exports = { planWithMemory, LOAD_THRESHOLD: flowMatcher.LOAD_THRESHOLD };
