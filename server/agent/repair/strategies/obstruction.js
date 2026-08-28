'use strict';

// 修复策略：OBSTRUCTION → DISMISS_OVERLAY。
// 检测遮挡元素 → 尝试关闭（accept/close/reject/ok/agree）→ 继续原动作。

function meta() {
  return {
    type: 'DISMISS_OVERLAY',
    risk: 'MEDIUM',
    steps: [
      { type: 'detect_overlay', description: '检测遮挡/弹窗' },
      { type: 'dismiss', description: '关闭弹窗（accept/close/reject/ok）' },
      { type: 'retry', description: '继续原动作' },
    ],
    verification: { type: 'action_success' },
  };
}

const DISMISS_SEMANTICS = ['accept', 'close', 'reject', 'ok', 'agree', 'got it', 'dismiss'];

async function execute({ task, step, ctx }) {
  const actions = [];
  // 先点击潜在遮挡元素（accept/close/reject...），命中即停
  for (const sem of DISMISS_SEMANTICS) {
    const res = await ctx.runAction({ type: 'click', target: { semantic: sem }, risk: 'LOW', verification: { type: 'none' } });
    actions.push({ tool: 'dismiss', target: sem, ok: !!res.success });
    if (res.success) break;
  }
  // 继续原动作
  const retry = await ctx.runAction(step.action);
  actions.push({ tool: 'retry', ok: !!retry.success });
  return { ok: !!retry.success, actions };
}

module.exports = { meta, execute };
