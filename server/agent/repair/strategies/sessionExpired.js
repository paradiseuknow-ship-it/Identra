'use strict';

// 修复策略：SESSION_EXPIRED → REAUTH_OR_PAUSE。
// 安全边界：不自动输入密码重新登录。默认转人工；仅当任务已配置可复用登录流程时才自动。
// 此策略默认不可自动执行（risk HIGH，Repair Policy 会拦）。

function meta() {
  return {
    type: 'REAUTH_OR_PAUSE',
    risk: 'HIGH',
    steps: [
      { type: 'pause', description: '暂停人工处理（或复用已配置登录流程）' },
    ],
    verification: { type: 'action_success' },
  };
}

async function execute({ task, step, ctx }) {
  // 安全策略：不自动输入凭据。除非任务显式允许（policy.reauth === 'auto' 且已配置凭据）
  const allowAuto = task && task.policy && task.policy.reauth === 'auto';
  if (allowAuto && Array.isArray(task.secretRefs) && task.secretRefs.length) {
    const res = await ctx.runAction({ type: 'click', target: { semantic: 'login' }, risk: 'MEDIUM', verification: { type: 'none' } });
    return { ok: !!res.success, actions: [{ tool: 'click', target: 'login', ok: !!res.success }] };
  }
  return { ok: false, needsApproval: true, actions: [{ tool: 'pause', ok: false, error: '会话过期：需人工处理，不自动输入密码' }] };
}

module.exports = { meta, execute };
