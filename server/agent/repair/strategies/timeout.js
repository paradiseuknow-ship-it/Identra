'use strict';

// 修复策略：TIMEOUT → WAIT_RETRY_RELOAD。
// 顺序：wait_more → retry → reload → retry → back+reload → retry。

function meta() {
  return {
    type: 'WAIT_RETRY_RELOAD',
    risk: 'LOW',
    steps: [
      { type: 'wait', description: '等待更久' },
      { type: 'retry', description: '重试' },
      { type: 'reload', description: '重载' },
      { type: 'back_reload', description: '返回后重载' },
    ],
    verification: { type: 'action_success' },
  };
}

async function execute({ task, step, ctx }) {
  const actions = [];
  const runRetry = async (label) => {
    const res = await ctx.runAction(step.action);
    actions.push({ tool: 'retry', label, ok: !!res.success });
    return res;
  };

  await ctx.runAction({ type: 'wait', target: { role: 'page' }, risk: 'LOW', verification: { type: 'none' }, timeoutMs: 1200 });
  actions.push({ tool: 'wait', ok: true });

  let res = await runRetry('after-wait');
  if (res.success) return { ok: true, actions };

  await ctx.runAction({ type: 'reload', target: { role: 'page' }, risk: 'LOW', verification: { type: 'none' }, timeoutMs: 10000 });
  actions.push({ tool: 'reload', ok: true });
  res = await runRetry('after-reload');
  if (res.success) return { ok: true, actions };

  await ctx.runAction({ type: 'back', target: { role: 'page' }, risk: 'LOW', verification: { type: 'none' }, timeoutMs: 10000 }).catch(() => {});
  await ctx.runAction({ type: 'reload', target: { role: 'page' }, risk: 'LOW', verification: { type: 'none' }, timeoutMs: 10000 }).catch(() => {});
  actions.push({ tool: 'back_reload', ok: true });
  res = await runRetry('after-back-reload');

  return { ok: !!res.success, actions };
}

module.exports = { meta, execute };
