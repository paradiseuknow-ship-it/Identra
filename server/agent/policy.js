'use strict';

// Policy Engine：代码级权限控制，决定某个 Action 是否允许自动执行。
// 不依赖"AI 判断自己可以执行"。执行模式：
//   SIMULATION  —— 只观察/规划，禁止任何 ACT（点击/填写/提交/支付）
//   ASSIST      —— 低/中风险自动执行；高/关键风险需人工
//   AUTONOMOUS  —— 完全自动，但受 riskFloor 与 CRITICAL 审批边界约束
// 关键原则：CRITICAL（支付/密码修改/金融）默认必须人工审批，除非测试环境显式配置 autoPayment=true。
// 安全护栏：autoPayment 仅在测试环境（NODE_ENV==='test' 或 FPB_ALLOW_AUTOPAY==='1'）才允许绕过人工审批。
//   任何普通 API 调用者通过 task.policy.autoPayment=true 注入都无法在非测试环境生效——环境护栏在代码层强制。

// riskFloorFor 而非 TYPE_RISK_FLOOR：后者看不到 dialog:accept 这类按 intent 细分的定级。
// Policy 拿到的永远是规范化后的 action，若这里仍读平表，schema 里做的 intent 细分就白做了。
const { riskFloorFor } = require('./schema/action');
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
// STEP 7：新登记动作在 SIMULATION 下的归属。
//   禁（有服务端副作用或不可逆）：upload / download / dialog / closeTab / drag
//   放行（等价于 navigate / 纯观察，不放行会导致多标签页面连"看"都看不到）：openTab / switchTab / hover
const ACT_TYPES = new Set([
  'click', 'fill', 'select', 'press', 'login', 'logout',
  'submit', 'delete', 'update_account_settings', 'purchase', 'payment', 'password_change',
  'upload', 'download', 'dialog', 'closeTab', 'drag',
]);

// STEP 1 §7：此前 PAYMENT_TYPES = ['purchase','payment','password_change','delete'] ——
//   名为「自动支付」的开关，实际授权范围却是「支付 + 改密码 + 删除账号」。
//   现在严格拆成三类，autoPayment **只能**影响 PAYMENT_TYPES。
//
//   ① PAYMENT          支付/购买能力 —— autoPayment 可放行
//   ② ACCOUNT_SECURITY 账号安全      —— 任何自动开关都不生效，必须逐次人工审批
//   ③ DESTRUCTIVE      破坏性动作    —— 任何自动开关都不生效，必须逐次人工审批
const PAYMENT_TYPES = new Set(['purchase', 'payment']);
// 注：checkout / subscription / upgrade 尚未登记为 action type，登记后需同步加入本集合。
const ACCOUNT_SECURITY_TYPES = new Set(['password_change', 'update_account_settings']);
const DESTRUCTIVE_TYPES = new Set(['delete']);

// 动作归属的能力类别（供事件与审计使用）
function capabilityOf(type) {
  if (PAYMENT_TYPES.has(type)) return 'PAYMENT';
  if (ACCOUNT_SECURITY_TYPES.has(type)) return 'ACCOUNT_SECURITY';
  if (DESTRUCTIVE_TYPES.has(type)) return 'DESTRUCTIVE';
  return 'GENERAL';
}

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
  const floor = riskFloorFor(action.type, action);
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

  // ① 支付能力：autoPayment 唯一能放行的集合（STEP 1 §7）
  if (PAYMENT_TYPES.has(action.type) && autoPaymentAllowed(policy)) {
    events.emit({
      type: 'ai.policy.autoPayment',
      payload: { actionType: action.type, capability: 'PAYMENT', reason: '已授权支付自动化放行' },
    });
    return { allowed: true, requiresApproval: false, reason: `autoPayment 授权放行支付动作 ${action.type}` };
  }

  // ② 账号安全 / ③ 破坏性：任何自动开关都不得放行，必须逐次人工审批
  const cap = capabilityOf(action.type);
  if (cap === 'ACCOUNT_SECURITY' || cap === 'DESTRUCTIVE') {
    events.emit({
      type: 'ai.policy.blocked',
      payload: { actionType: action.type, capability: cap, risk, reason: '账号安全/破坏性动作不接受自动授权' },
    });
    return {
      allowed: false,
      requiresApproval: true,
      reason: `${action.type} 属于 ${cap}，必须逐次人工审批；autoPayment / AUTONOMOUS 均不生效`,
    };
  }

  // CRITICAL：默认必须人工审批（支付类已在 ① 处理，其余一律拦下）
  if (risk === 'CRITICAL') {
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

module.exports = {
  allowsAction,
  effectiveRisk,
  isApproved,
  DEFAULT_POLICY,
  RISK_RANK,
  // 能力分类（供测试与审计断言：autoPayment 只能影响 PAYMENT）
  PAYMENT_TYPES,
  ACCOUNT_SECURITY_TYPES,
  DESTRUCTIVE_TYPES,
  capabilityOf,
};
