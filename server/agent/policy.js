'use strict';

// Policy Engine：代码级权限控制，决定某个 Action 是否允许自动执行。
// 不依赖"AI 判断自己可以执行"。执行模式：
//   SIMULATION  —— 只观察/规划，禁止任何 ACT（点击/填写/提交/支付）
//   ASSIST      —— 低/中风险自动执行；高/关键风险需人工
//   AUTONOMOUS  —— 完全自动，但受 riskFloor 与 CRITICAL 审批边界约束
// 关键原则：CRITICAL（支付/密码修改/金融）默认必须人工审批，除非测试环境显式配置 autoPayment=true。
// 安全护栏：autoPayment 仅在测试环境（NODE_ENV==='test' 或 FPB_ALLOW_AUTOPAY==='1'）才允许绕过人工审批。
//   任何普通 API 调用者通过 task.policy.autoPayment=true 注入都无法在非测试环境生效——环境护栏在代码层强制。

const { TYPE_RISK_FLOOR } = require('./schema/action');
const events = require('./events');

// autoPayment 能否在代码层生效：仅在显式测试环境标记下。避免被任意 task.policy 注入绕过 CRITICAL 门。
function autoPaymentAllowed(policy) {
  if (!policy || policy.autoPayment !== true) return false;
  const env = process.env.NODE_ENV || '';
  if (env === 'test') return true;
  if (process.env.FPB_ALLOW_AUTOPAY === '1') return true;
  return false;
}

const RISK_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

// Action type 是否属于"执行动作"（SIMULATION 模式下禁止）
const ACT_TYPES = new Set([
  'click', 'fill', 'select', 'press', 'login', 'logout',
  'submit', 'delete', 'update_account_settings', 'purchase', 'payment', 'password_change',
]);

// 支付/金融动作（CRITICAL 子集，autoPayment 只对这些生效）
const PAYMENT_TYPES = new Set(['purchase', 'payment', 'password_change', 'delete']);

const DEFAULT_POLICY = {
  riskFloor: 'MEDIUM',     // 自动执行允许的最大风险级
  autoPayment: false,      // 测试环境专用：true 时 CRITICAL 支付类可自动执行
  maxActionRetries: 3,
  maxRepairAttempts: 3,
  maxReplans: 2,
  maxRecoveryTimeMs: 60000,
  taskTimeoutMs: 0,        // 任务级整体墙钟超时（0=关闭；置 >0 启用，Phase 12B §T13）
};

function effectiveRisk(action) {
  const floor = TYPE_RISK_FLOOR[action.type] || 'MEDIUM';
  const claimed = RISK_RANK[action.risk] !== undefined ? action.risk : floor;
  return RISK_RANK[claimed] > RISK_RANK[floor] ? claimed : floor; // 取两者更高者
}

// 返回 { allowed, requiresApproval, reason }
function allowsAction(action, task) {
  const mode = (task && task.executionMode) || 'ASSIST';
  const policy = { ...DEFAULT_POLICY, ...((task && task.policy) || {}) };
  const risk = effectiveRisk(action);
  const riskRank = RISK_RANK[risk];

  // SIMULATION：观察/导航类放行，动作类一律拒绝
  if (mode === 'SIMULATION') {
    if (ACT_TYPES.has(action.type)) {
      return { allowed: false, requiresApproval: false, reason: `SIMULATION 模式禁止 ${action.type}` };
    }
    return { allowed: true, requiresApproval: false, reason: 'SIMULATION 观察放行' };
  }

  // 已人工审批的动作直接放行
  if (isApproved(task, action)) {
    return { allowed: true, requiresApproval: false, reason: '已通过人工审批' };
  }

  // CRITICAL：默认必须人工审批；仅 autoPayment 在测试环境显式开启且属于支付类才自动
  if (risk === 'CRITICAL') {
    if (autoPaymentAllowed(policy) && PAYMENT_TYPES.has(action.type)) {
      events.emit({ type: 'ai.policy.autoPayment', payload: { actionType: action.type, reason: '测试环境 autoPayment 放行' } });
      return { allowed: true, requiresApproval: false, reason: `测试环境 autoPayment=true 放行 ${action.type}` };
    }
    return { allowed: false, requiresApproval: true, reason: `${action.type} 属于 CRITICAL，需人工审批` };
  }

  // 超过 riskFloor：需审批
  const floorRank = RISK_RANK[policy.riskFloor] !== undefined ? RISK_RANK[policy.riskFloor] : RISK_RANK.MEDIUM;
  if (riskRank > floorRank) {
    return { allowed: false, requiresApproval: true, reason: `${action.type} 风险 ${risk} 超过 riskFloor ${policy.riskFloor}` };
  }

  // ASSIST：HIGH 但未超 floor 时仍自动（如 riskFloor=HIGH），否则已在上一步拦截
  return { allowed: true, requiresApproval: false, reason: `${action.type} 风险 ${risk} 自动放行` };
}

// 已人工审批的动作（approve 写入 task.approvedActions），按 type+semantic 匹配放行
function isApproved(task, action) {
  const grants = task && Array.isArray(task.approvedActions) ? task.approvedActions : [];
  if (!grants.length) return false;
  const sem = action.target && (action.target.semantic || action.target.field || null);
  return grants.some((g) => g && g.type === action.type && (sem ? g.semantic === sem : true));
}

module.exports = { allowsAction, effectiveRisk, isApproved, DEFAULT_POLICY, RISK_RANK };
