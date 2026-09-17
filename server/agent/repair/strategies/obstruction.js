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
    // C140 A 类修复（死路径）：原写 verification:{type:'none'} —— 而 click 属 schema/action.js
    // MUST_VERIFY（第 218/223-227 行），tools.execute 第 171-172 行对每个动作**再校验一次**
    // ⇒ 本循环 7 个 dismiss 语义全部被判 ACTION_INVALID，DISMISS_OVERLAY 的核心动作
    // 结构性不可达（实测 validateAction 直接 REJECT）。
    // 改为 page_change：关闭遮罩必然改变页面/DOM，是该动作的**真实效果**，非放宽——
    // 修复是否成功的真实门仍是 executor.js 第 4 步的 step.verification，本声明不参与放行。
    const res = await ctx.runAction({ type: 'click', target: { semantic: sem }, risk: 'LOW', verification: { type: 'page_change' } });
    actions.push({ tool: 'dismiss', target: sem, ok: !!res.success });
    if (res.success) break;
  }
  // 继续原动作
  const retry = await ctx.runAction(step.action);
  actions.push({ tool: 'retry', ok: !!retry.success });
  return { ok: !!retry.success, actions };
}

module.exports = { meta, execute };
