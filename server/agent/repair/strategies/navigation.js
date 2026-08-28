'use strict';

// 修复策略：NAVIGATION_FAILED → RELOAD_OR_BACK。
// 顺序：reload → retry → back+reload → retry。

function meta() {
  return {
    type: 'RELOAD_OR_BACK',
    risk: 'LOW',
    steps: [
      { type: 'reload', description: '重载页面' },
      { type: 'retry', description: '重试' },
      { type: 'back_reload', description: '返回后重载' },
    ],
    verification: { type: 'action_success' },
  };
}

async function execute({ task, step, ctx }) {
  const actions = [];
  await ctx.runAction({ type: 'reload', target: { role: 'page' }, risk: 'LOW', verification: { type: 'none' }, timeoutMs: 10000 }).catch(() => {});
  actions.push({ tool: 'reload', ok: true });
  let res = await ctx.runAction(step.action);
  actions.push({ tool: 'retry', ok: !!res.success });
  if (res.success) return { ok: true, actions };

  await ctx.runAction({ type: 'back', target: { role: 'page' }, risk: 'LOW', verification: { type: 'none' }, timeoutMs: 10000 }).catch(() => {});
  await ctx.runAction({ type: 'reload', target: { role: 'page' }, risk: 'LOW', verification: { type: 'none' }, timeoutMs: 10000 }).catch(() => {});
  actions.push({ tool: 'back_reload', ok: true });
  res = await ctx.runAction(step.action);
  actions.push({ tool: 'retry', ok: !!res.success });
  return { ok: !!res.success, actions };
}

module.exports = { meta, execute };
