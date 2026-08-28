'use strict';

// Action Schema + 校验。
// AI 不允许直接输出任意 JS/Playwright 操作；只能输出结构化 Action。
// Browser Tool 层只接受通过本 Schema 校验 + Policy Engine 放行的 Action。

const { STATE_TYPES } = require('../verification/contract');

const ACTION_TYPES = [
  'navigate', 'inspect', 'wait', 'scroll', 'extract', 'screenshot', 'reload',
  'back', 'forward', 'getUrl', 'getTitle', 'click', 'fill', 'select', 'press',
  'check', 'uncheck', 'login', 'logout', 'submit', 'delete', 'update_account_settings',
  'purchase', 'payment', 'password_change',
];

const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

const VERIFICATION_TYPES = [
  'page_change', 'url_contains', 'text_present', 'text_absent',
  'element_present', 'element_absent', 'login_state', 'action_success', 'none',
];

// Action type → 最低风险级（Policy Engine 用于校准，不信 AI 自报）
const TYPE_RISK_FLOOR = {
  navigate: 'LOW', inspect: 'LOW', wait: 'LOW', scroll: 'LOW', extract: 'LOW',
  screenshot: 'LOW', reload: 'LOW', back: 'LOW', forward: 'LOW', getUrl: 'LOW', getTitle: 'LOW',
  click: 'MEDIUM', fill: 'MEDIUM', select: 'MEDIUM', press: 'MEDIUM', uncheck: 'MEDIUM',
  login: 'MEDIUM', logout: 'MEDIUM',
  submit: 'HIGH', delete: 'HIGH', update_account_settings: 'HIGH', purchase: 'HIGH',
  payment: 'CRITICAL', password_change: 'CRITICAL',
};

// 敏感字段：只允许 credentialRef，禁止 value 字面量
const SENSITIVE_FIELDS = ['password', 'passwordConfirm', 'cvv', 'cardNumber', 'otp', 'card', 'token', 'secret', 'apiKey'];

const TARGET_KEYS = ['semantic', 'role', 'field', 'text', 'selector', 'index', 'url'];

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// 校验并规范化 Action。返回 { ok, errors?, action? }
function validateAction(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['Action 必须是对象'] };
  }

  // type
  const type = raw.type;
  if (!ACTION_TYPES.includes(type)) {
    errors.push(`type 非法: ${String(type)}（允许: ${ACTION_TYPES.join('/')}）`);
  }

  // target
  const t = raw.target || {};
  const hasTarget = TARGET_KEYS.some((k) => t[k] !== undefined && t[k] !== null && t[k] !== '');
  // 导航历史动作（back/forward）不依赖页面元素定位，允许无 target
  const NAV_HISTORY = ['back', 'forward'];
  if (!hasTarget && !NAV_HISTORY.includes(type)) {
    errors.push('target 缺失（至少提供 semantic/role/field/text/selector/index 之一）');
  }
  if (t.semantic !== undefined && !isNonEmptyString(t.semantic)) errors.push('target.semantic 非法');
  if (t.role !== undefined && !isNonEmptyString(t.role)) errors.push('target.role 非法');
  // Phase 8.1 A1：field 为可选信号。DeepSeek 常送 field:null / field:"" 表示「未指定字段名，仅靠 semantic 定位」。
  // 将 null / 空串视为「未提供」，跳过字符串校验；仅当 field 为「有值的非字符串」（如数字）才判非法。
  // 不降低安全校验：verification 强校验、敏感字段校验、value/credentialRef 校验均保持。
  if (t.field && !isNonEmptyString(t.field)) errors.push('target.field 非法');
  if (t.text !== undefined && !isNonEmptyString(t.text)) errors.push('target.text 非法');
  if (t.selector !== undefined && !isNonEmptyString(t.selector)) errors.push('target.selector 非法');
  if (t.index !== undefined && !Number.isInteger(t.index)) errors.push('target.index 必须为整数');

  // risk
  if (raw.risk !== undefined && !RISK_LEVELS.includes(raw.risk)) {
    errors.push(`risk 非法: ${String(raw.risk)}`);
  }

  // verification
  if (raw.verification !== undefined && raw.verification !== null) {
    if (typeof raw.verification !== 'object') {
      errors.push('verification 必须为对象');
    } else if (!VERIFICATION_TYPES.includes(raw.verification.type)) {
      errors.push(`verification.type 非法: ${String(raw.verification.type)}`);
    }
  }

  // Phase 11：expectedBusinessState（业务完成契约）—— 验证「业务结果」而非「动作执行」。
  // 允许作为 verification 的替代/补充；关键业务动作必须有其一。
  let hasBusinessState = false;
  if (raw.expectedBusinessState !== undefined && raw.expectedBusinessState !== null) {
    if (typeof raw.expectedBusinessState !== 'object') {
      errors.push('expectedBusinessState 必须为对象');
    } else if (!STATE_TYPES.includes(raw.expectedBusinessState.stateType)) {
      errors.push(`expectedBusinessState.stateType 非法: ${String(raw.expectedBusinessState.stateType)}（允许: ${STATE_TYPES.join('/')}）`);
    } else if (!Array.isArray(raw.expectedBusinessState.requiredEvidence) || !raw.expectedBusinessState.requiredEvidence.length) {
      errors.push('expectedBusinessState.requiredEvidence 不能为空（至少一条 outcome 证据）');
    } else {
      hasBusinessState = true;
    }
  }

  // fill / select / press 必须有 value 或 credentialRef
  if (type === 'fill' || type === 'press') {
    const hasVal = raw.value !== undefined || isNonEmptyString(raw.credentialRef);
    if (!hasVal) errors.push(`${type} 必须提供 value 或 credentialRef`);
  }

  // 敏感字段：禁止 value 字面量
  if (type === 'fill') {
    const field = (raw.target && raw.target.field) || '';
    if (SENSITIVE_FIELDS.includes(field.toLowerCase()) && raw.value !== undefined && !raw.credentialRef) {
      errors.push(`字段 ${field} 是敏感字段，必须用 credentialRef 注入，禁止 value 字面量`);
    }
  }

  // 高风险/不可逆动作必须提供有意义的 verification（防止盲执行）
  // Phase 7 Step 2-B：扩展至 click/fill/submit —— 每个交互动作都需可验证结果，
  // 杜绝「无验证执行」导致失败只能等重试耗尽才升级（Phase 6 中 96.7% 步骤 verification=none 的根因）。
  // Phase 11：验证形式二选一（满足其一即可）—— 既有 verification(type≠none) 或 expectedBusinessState 合约。
  const MUST_VERIFY = ['click', 'fill', 'select', 'check', 'submit', 'purchase', 'payment', 'login', 'logout', 'password_change', 'delete', 'update_account_settings'];
  if (MUST_VERIFY.includes(type)) {
    const vtype = raw.verification && raw.verification.type;
    if ((!vtype || vtype === 'none') && !hasBusinessState) {
      errors.push(`${type} 必须提供有意义的验证：verification(type≠none) 或 expectedBusinessState 业务完成契约（禁止仅以 action_success 作为完成证据）`);
    }
    // P0：关键业务动作禁止把 action_success 当作唯一业务完成证据
    if (vtype === 'action_success' && !hasBusinessState) {
      errors.push(`${type} 禁止仅用 action_success 作为完成证据；必须补充 expectedBusinessState 业务完成契约`);
    }
  }

  if (errors.length) return { ok: false, errors };

  // 规范化
  const action = {
    type,
    target: {},
    value: raw.value !== undefined ? raw.value : null,
    credentialRef: isNonEmptyString(raw.credentialRef) ? raw.credentialRef : null,
    reason: isNonEmptyString(raw.reason) ? raw.reason.slice(0, 300) : '',
    risk: raw.risk || TYPE_RISK_FLOOR[type] || 'MEDIUM',
    verification: raw.verification && raw.verification.type && raw.verification.type !== 'none' ? raw.verification : { type: 'none' },
    expectedBusinessState: hasBusinessState ? raw.expectedBusinessState : null,
    timeoutMs: Number.isInteger(raw.timeoutMs) && raw.timeoutMs > 0 ? Math.min(raw.timeoutMs, 60000) : 15000,
    retryable: raw.retryable !== false,
  };
  for (const k of TARGET_KEYS) {
    if (t[k] !== undefined && t[k] !== null && t[k] !== '') action.target[k] = t[k];
  }
  return { ok: true, action };
}

module.exports = {
  ACTION_TYPES, RISK_LEVELS, VERIFICATION_TYPES, TYPE_RISK_FLOOR, SENSITIVE_FIELDS,
  validateAction,
};
