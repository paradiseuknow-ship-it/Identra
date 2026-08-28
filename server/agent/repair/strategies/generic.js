'use strict';

// 修复策略：未知错误 → GENERIC_RETRY。

function meta() {
  return {
    type: 'GENERIC_RETRY',
    risk: 'LOW',
    steps: [
      { type: 'retry', description: '原动作重试' },
    ],
    verification: { type: 'action_success' },
  };
}

async function execute({ task, step, ctx }) {
  const res = await ctx.runAction(step.action);
  return { ok: !!res.success, actions: [{ tool: 'retry', ok: !!res.success }] };
}

module.exports = { meta, execute };
