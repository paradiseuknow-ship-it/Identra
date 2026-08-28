'use strict';

// Explain：把 Router 的决策翻译成可解释文本（Phase 3.5）。
// 产品价值：未来卖给用户时必须能解释「为什么选这个方案」。

// 生成 human-readable 的解释对象：{ summary, reasons[], warnings[] }
function explain(decision, ctx) {
  const reasons = [];
  const warnings = [];
  const parts = [];

  const prof = decision.profile;
  if (prof && prof.id) {
    reasons.push(`选用环境 ${prof.name || prof.id}（评分 ${Math.round(prof.score)}）${prof.reason ? '：' + prof.reason : ''}`);
  }
  const flow = decision.flow;
  if (flow && flow.id) {
    reasons.push(`复用已学习流程 ${flow.id}（置信度 ${flow.confidence}）`);
  } else {
    reasons.push('该目标暂无高置信流程经验，将由 Planner / LLM 生成计划');
  }

  const strat = decision.strategy || {};
  if (strat.useMemory) reasons.push('将优先使用经验记忆（Profile/Flow/Element/Failure）而非重复推理');
  if (strat.requireLLM) reasons.push('因经验不足，需调用 LLM 规划');

  // 来自 failure advisor 的风险提示转为 warning
  if (decision._failure && decision._failure.matched) {
    const fk = decision._failure;
    if (fk.category) {
      const strat = fk.recommendation && fk.recommendation.strategy ? `，建议准备 ${fk.recommendation.strategy}` : '';
      warnings.push(`历史提示：该站点存在 ${fk.category} 类失败经验（${fk.sampleCount || 1} 条）${strat}`);
    }
  }

  // 来自 site memory 的高频失败提示
  if (decision._site && decision._site.frequentFailures && decision._site.frequentFailures.length) {
    warnings.push(`该站点历史高频失败：${decision._site.frequentFailures.join('、')}`);
  }
  if (decision._site && decision._site.failureProfile && decision._site.failureProfile.commonFailures) {
    const cf = decision._site.failureProfile.commonFailures.filter((x) => x.successRate != null && x.successRate < 0.5);
    if (cf.length) warnings.push(`该站点经验中成功率偏低的风险类型：${cf.map((x) => x.type).join('、')}`);
  }

  const es = strat.expectedSuccess != null ? Math.round(strat.expectedSuccess * 100) : null;
  const summary = [
    prof ? `环境 ${prof.name || prof.id}` : '默认环境',
    flow && flow.id ? '复用流程经验' : '重新规划',
    es != null ? `预计成功率 ${es}%` : '',
  ].filter(Boolean).join(' · ');

  return { summary, reasons, warnings };
}

module.exports = { explain };
