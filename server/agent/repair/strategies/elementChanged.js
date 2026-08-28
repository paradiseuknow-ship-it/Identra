'use strict';

// 修复策略：ELEMENT_CHANGED → SEMANTIC_RELOCATE。
// 重新加载后重新语义定位（含同义变体探测），再重试原动作。

const elementMissing = require('../../recovery/strategies/elementMissing');

function meta() {
  return {
    type: 'SEMANTIC_RELOCATE',
    risk: 'LOW',
    steps: [
      { type: 'reload', description: '重新加载页面' },
      { type: 'semantic_resolve', description: '重新语义定位目标（含同义词）' },
      { type: 'retry', description: '重试原动作' },
    ],
    verification: { type: 'action_success' },
  };
}

async function execute({ task, step, ctx }) {
  const actions = [];
  const variants = elementMissing.buildElementVariants(step.action);

  // 先 reload 一次（页面可能动态渲染/状态变化）
  try {
    const reload = await ctx.runAction({ type: 'reload', target: { role: 'page' }, risk: 'LOW', verification: { type: 'none' }, timeoutMs: 10000 });
    actions.push({ tool: 'reload', ok: !!reload.success });
  } catch (e) {
    actions.push({ tool: 'reload', ok: false });
  }

  for (const action of variants) {
    const res = await ctx.runAction(action);
    actions.push({
      tool: action.type,
      target: action.target && (action.target.semantic || action.target.field || action.target.url || ''),
      ok: !!res.success,
      reason: action.reason || null,
    });
    if (res.success) return { ok: true, actions };
  }
  return { ok: false, actions };
}

module.exports = { meta, execute };
