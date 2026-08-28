'use strict';

// Repair Policy：决定 Repair Plan 是否可以自动执行。
// LOW（semantic retry / wait / reload）→ 自动；
// MEDIUM（关闭弹窗等）→ 需 confidence > 0.85；
// HIGH（会话重认证等）→ 人工审批。
// 与 Action Policy 分离，但同样不绕过 Runtime/Verification。

function canExecute({ plan, task }) {
  const risk = plan && plan.risk;
  const confidence = (plan && plan.confidence) || 0;
  const strategy = (plan && plan.strategy) || '';

  if (risk === 'CRITICAL') {
    return { allowed: false, requiresApproval: true, reason: `修复策略 ${strategy} 风险 CRITICAL，需人工审批` };
  }
  if (risk === 'HIGH') {
    return { allowed: false, requiresApproval: true, reason: `修复策略 ${strategy} 风险 HIGH（如重认证），需人工审批` };
  }
  if (risk === 'MEDIUM' && confidence < 0.85) {
    return { allowed: false, requiresApproval: true, reason: `修复置信度 ${confidence} < 0.85，需人工确认` };
  }
  return { allowed: true, requiresApproval: false, reason: `${strategy} 自动执行` };
}

module.exports = { canExecute };
