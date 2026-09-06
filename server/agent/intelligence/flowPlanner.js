'use strict';

// Flow Planner：规划消费点（Phase 3.2 / CAP-K1）。
// 决策流：
//   用户目标
//     ↓
//   flowMemory.lookup(site, goal)   ← 置信度判断
//     ≥ 0.85 : 加载历史 flow（toPlan），不调用 LLM Planner
//     < 0.85 : 调用 LLM Planner 生成
// Flow 只提供状态建议，生成的 Plan 仍走 policy / verification / tools，绝不绕过。
//
// CAP-K1（2026-08-29）：
//   - 新增 tryFlowPlan 作为【唯一】读侧入口：先过 schema/plan.validatePlan，
//     校验不过（如旧格式缺 verification）→ 返回 null 降级 LLM，绝不带病重放。
//   - runtime.resolvePlan（生产执行路径）与 index.js /chat（任务创建路径）都复用此入口，
//     修复「写侧在 complete、读侧只在 /chat，两条路径永不相遇」的结构性断裂。
//   - 失败反馈闭环在 taskManager.fail / escalate（此前 recordOutcomeFlow 生产链零调用，
//     置信度只涨不跌，过期 flow 会被永久重放 —— 接读侧前必须先补这一环）。

const planner = require('../planner');
const flowMemory = require('./flowMemory');
const flowMatcher = require('./flowMatcher');
const { validatePlan } = require('../schema/plan');

// 高置信度历史 flow → 校验通过的 Plan；任何一环不满足返回 null（调用方降级 LLM）。
function tryFlowPlan(targetUrl, objective) {
  const site = flowMemory.siteOf(targetUrl);
  if (!site) return null;
  const m = flowMemory.lookup(site, objective);
  if (!m || !m.reused) return null;
  const v = validatePlan(flowMemory.toPlan(m.flow, targetUrl));
  if (!v.ok) return null;
  v.plan.fromFlow = true;
  return { plan: v.plan, flowId: m.flow.id, confidence: m.confidence };
}

async function planWithMemory({ objective, target, executionMode, provider, ctx, ...rest }) {
  const hit = tryFlowPlan(target, objective);
  if (hit) return { ok: true, ...hit, fromFlow: true };
  // 无高置信度历史 → LLM 规划（不自动执行）
  const pr = await planner.planObjective({ objective, target, executionMode, provider, ctx, ...rest });
  if (pr.ok) pr.fromFlow = false;
  return pr;
}

module.exports = { planWithMemory, tryFlowPlan, LOAD_THRESHOLD: flowMatcher.LOAD_THRESHOLD };
