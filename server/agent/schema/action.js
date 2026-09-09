'use strict';

// Action Schema + 校验。
// AI 不允许直接输出任意 JS/Playwright 操作；只能输出结构化 Action。
// Browser Tool 层只接受通过本 Schema 校验 + Policy Engine 放行的 Action。

const path = require('path');
const { STATE_TYPES } = require('../verification/contract');
// CAP-L1：通用支付/敏感字段识别（禁止 value 字面量的判定入口）
const paymentField = require('../paymentField');

// STEP 7 / CAP-F1：这六个动作在 tools.js 里早已完整实现，但从未登记进 ACTION_TYPES，
// 于是 schema 一律判 `type 非法` —— 代码写了、链路不通、模型也不可能在提示里看到它。
// 现补齐登记；hover / drag 是同批新增（CAP-F2），见 tools.js。
const ACTION_TYPES = [
  'navigate', 'inspect', 'wait', 'scroll', 'extract', 'screenshot', 'reload',
  'back', 'forward', 'getUrl', 'getTitle', 'click', 'hover', 'drag', 'fill', 'select', 'press',
  'check', 'uncheck', 'login', 'logout', 'submit', 'delete', 'update_account_settings',
  'purchase', 'payment', 'password_change',
  // 浏览器级动作（多标签 / 文件 / 原生对话框）：真实网站的日常操作，此前不可达
  'openTab', 'closeTab', 'switchTab', 'upload', 'download', 'dialog',
];

// upload 的文件暂存根目录。upload 是唯一"把本地文件内容送到远端"的动作，
// 不可逆且带外泄面 —— 因此不信任模型给的任何路径，只允许从本目录取文件。
const UPLOAD_ROOT = path.resolve(__dirname, '..', 'data', 'uploads');

const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

// STEP 22 (B 类一致性修复)：此白名单必须与 verification.js 的 VERIFICATION_TYPES 同步 ——
// 引擎（执行真值）支持而 schema 拒绝 = 合法证据类型永远无法经计划校验进入执行链。
// 此前缺 field_value/field_checked（B1 引入）与 url_pattern/storage（STEP 22 引入）。
const VERIFICATION_TYPES = [
  'page_change', 'url_contains', 'url_pattern', 'text_present', 'text_absent',
  'element_present', 'element_absent', 'login_state', 'action_success', 'none',
  'field_value', 'field_checked', 'storage',
];

// Action type → 最低风险级（Policy Engine 用于校准，不信 AI 自报）
// 定级口径统一为「不可逆性 + 外泄面 + 影响半径」：
//   可逆且不留痕 → LOW；会造成状态丢失或触发服务端动作 → MEDIUM；
//   不可逆 / 数据外流 → HIGH；金融与账号安全 → CRITICAL。
const TYPE_RISK_FLOOR = {
  navigate: 'LOW', inspect: 'LOW', wait: 'LOW', scroll: 'LOW', extract: 'LOW',
  screenshot: 'LOW', reload: 'LOW', back: 'LOW', forward: 'LOW', getUrl: 'LOW', getTitle: 'LOW',
  // check 原先漏配，静默退回默认 MEDIUM —— 值恰好相同所以从未暴露。
  // 显式登记，杜绝"漏配恰好等于默认值"这种靠运气的正确。
  click: 'MEDIUM', fill: 'MEDIUM', select: 'MEDIUM', press: 'MEDIUM', check: 'MEDIUM', uncheck: 'MEDIUM',
  login: 'MEDIUM', logout: 'MEDIUM',
  submit: 'HIGH', delete: 'HIGH', update_account_settings: 'HIGH', purchase: 'HIGH',
  payment: 'CRITICAL', password_change: 'CRITICAL',

  // STEP 7 新增 ——
  hover: 'LOW',        // 只改变悬浮态，不产生任何服务端副作用，完全可逆
  drag: 'MEDIUM',      // 与 click 同级：拖动可改顺序、移入回收站，但仍在页面语义内
  openTab: 'LOW',      // 开标签等价于 navigate，不提交数据
  switchTab: 'LOW',    // 切换标签完全可逆
  closeTab: 'MEDIUM',  // 关错标签 = 丢失该标签未保存的表单/状态，不可逆
  download: 'MEDIUM',  // 触发服务端导出动作（可能计配额/计费）并在本地落盘
  upload: 'HIGH',      // 本地文件内容离开本机的唯一动作：不可逆 + 有外泄面（另见 UPLOAD_ROOT 白名单）
  dialog: 'MEDIUM',    // dismiss 安全；accept 见 INTENT_RISK_FLOOR
};

// 同一 type 内按 intent 细分风险下限。
// dialog 是必须细分的典型：accept 可能确认「删除账号 / 确认支付 / 放弃未保存的更改」，
// 实际等价于 delete；dismiss 只是关掉弹窗。用一个平坦下限只能二选一，
// 要么把 accept 放得太松，要么把 dismiss 卡得太死。
const INTENT_RISK_FLOOR = {
  'dialog:accept': 'HIGH',
};

// 取某 action 的风险下限：先看 type:intent 细分，再退回 type 下限。
// Policy 侧只拿得到规范化后的 action，因此这里也接受 {type, target} 形态。
function riskFloorFor(type, raw) {
  const intent = raw && raw.target && raw.target.intent;
  if (intent) {
    const scoped = INTENT_RISK_FLOOR[type + ':' + intent];
    if (scoped) return scoped;
  }
  return TYPE_RISK_FLOOR[type] || 'MEDIUM';
}

// 敏感字段：只允许 credentialRef，禁止 value 字面量
const SENSITIVE_FIELDS = ['password', 'passwordConfirm', 'cvv', 'cardNumber', 'otp', 'card', 'token', 'secret', 'apiKey'];

// intent 是 dialog 的「接受还是关闭」，属动作修饰而非元素定位，
// 但必须留在 TARGET_KEYS 里 —— 规范化阶段只拷贝 TARGET_KEYS 列出的键，
// 漏了它 intent 会在 validate 之后被静默丢弃。
const TARGET_KEYS = ['semantic', 'role', 'field', 'text', 'selector', 'index', 'url', 'intent'];

// 不依赖页面元素定位的动作：导航历史（back/forward）与原生对话框。
// dialog 作用于浏览器级模态框，它根本不在 DOM 里，要求它提供元素 target 是无意义的。
const NO_TARGET_TYPES = ['back', 'forward', 'dialog'];

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// upload 文件路径白名单校验：只允许 UPLOAD_ROOT 内的文件。
// 没有这条，模型可以构造 {type:'upload', target:{url:'C:/Users/xxx/.ssh/id_rsa'}}，
// 把本机任意文件提交到任意站点 —— 这是本产品里唯一一条「数据出本机」的通路，
// 必须默认关死，只留一个用户主动放置文件的暂存目录。
function resolveUploadPath(p) {
  if (!isNonEmptyString(p)) return { ok: false, error: 'upload 缺少文件路径（target.url 或 value）' };
  const abs = path.resolve(UPLOAD_ROOT, String(p).trim());
  const rel = path.relative(UPLOAD_ROOT, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: `upload 文件路径越界：只允许 ${UPLOAD_ROOT} 内的相对路径` };
  }
  return { ok: true, abs, rel };
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
  if (!hasTarget && !NO_TARGET_TYPES.includes(type)) {
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

  // STEP 7：新登记动作的参数校验。登记进 ACTION_TYPES 只是让模型"看得见"，
  // 参数契约不在 schema 里说清楚，模型照样会产出非法结构（5.9-E 的教训）。
  if (type === 'dialog') {
    const intent = (raw.target && raw.target.intent) || 'dismiss';
    if (intent !== 'accept' && intent !== 'dismiss') {
      errors.push(`dialog 的 target.intent 仅允许 accept/dismiss，收到: ${String(intent)}`);
    }
  }
  if (type === 'drag') {
    // 拖拽有两个端点：起点走 target（语义/选择器），终点走 value。
    // 没有终点的拖拽无从执行，且拖拽本身是状态变更，不能缺省。
    if (!isNonEmptyString(raw.value)) {
      errors.push('drag 必须提供 value 作为放置目标（CSS 选择器或语义描述）');
    }
  }
  if (type === 'upload') {
    const up = resolveUploadPath((raw.target && raw.target.url) || raw.value);
    if (!up.ok) errors.push(up.error);
  }

  // 敏感字段：禁止 value 字面量
  //
  // CAP-L1 修复：原判定 `SENSITIVE_FIELDS.includes(field.toLowerCase())` 有两个致命问题 ——
  //   1) 列表里写的是驼峰 'cardNumber' / 'apiKey' / 'passwordConfirm'，却先 toLowerCase()
  //      再比对 → 这三项**永远不可能命中**（死护栏）；
  //   2) 真实站点的字段叫 cardnumber / card_number / cc-number / cvv2 / exp-month，
  //      精确匹配一个英文列表，同样一个都不命中。
  // 结果：模型完全可以合法地用 value 字面量带整串卡号 —— 这正是用户红线
  // （「不把完整支付凭据暴露给 LLM / 日志 / trace」）要拦的形态。
  // 现改用 paymentField 的通用识别：autocomplete 语义 + 通用构词 + 历史列表兜底。
  if (type === 'fill') {
    const field = (raw.target && raw.target.field) || '';
    if (field && raw.value !== undefined && !raw.credentialRef && paymentField.isSensitiveFieldName(field)) {
      errors.push(`字段 ${field} 是敏感字段，必须用 credentialRef 注入，禁止 value 字面量`);
    }
  }

  // 高风险/不可逆动作必须提供有意义的 verification（防止盲执行）
  // Phase 7 Step 2-B：扩展至 click/fill/submit —— 每个交互动作都需可验证结果，
  // 杜绝「无验证执行」导致失败只能等重试耗尽才升级（Phase 6 中 96.7% 步骤 verification=none 的根因）。
  // Phase 11：验证形式二选一（满足其一即可）—— 既有 verification(type≠none) 或 expectedBusinessState 合约。
  const MUST_VERIFY = ['click', 'fill', 'select', 'check', 'submit', 'purchase', 'payment', 'login', 'logout', 'password_change', 'delete', 'update_account_settings',
    // STEP 7：upload / drag 会改变业务状态，同样禁止盲执行。
    // hover 不在此列 —— 它只揭示 UI、不产生服务端副作用，强制它给验证条件只会逼模型编造预期。
    // dialog 也不在此列 —— 原生对话框不在 DOM 里，DOM 类验证对它永远不成立。
    'upload', 'drag'];
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

  // C100：导航族动作默认超时与交互动作分离。此前统一兜底 15000 —— tools.js navigate 的
  // 30s 默认被 schema 默认值静默压到 15s，慢站点（重定向链/首载 >15s，e2e 实证
  // try.webflow.com 每次导航 STEP_TIMEOUT）必死且自愈无法恢复（每次重试同预算）。
  // 导航/等待族 30s；交互（点击/输入/悬停等）维持 15s。显式传入仍受 60000 上限约束。
  const NAV_FAMILY_DEFAULT_MS = 30000;
  const isNavFamily = type === 'navigate' || type === 'reload' || type === 'back' || type === 'wait';
  const defaultTimeoutMs = isNavFamily ? NAV_FAMILY_DEFAULT_MS : 15000;
  const action = {
    type,
    target: {},
    value: raw.value !== undefined ? raw.value : null,
    credentialRef: isNonEmptyString(raw.credentialRef) ? raw.credentialRef : null,
    reason: isNonEmptyString(raw.reason) ? raw.reason.slice(0, 300) : '',
    // riskFloorFor 而非 TYPE_RISK_FLOOR：让 dialog:accept 这类 intent 细分的定级真正生效
    risk: raw.risk || riskFloorFor(type, raw),
    verification: raw.verification && raw.verification.type && raw.verification.type !== 'none' ? raw.verification : { type: 'none' },
    expectedBusinessState: hasBusinessState ? raw.expectedBusinessState : null,
    timeoutMs: Number.isInteger(raw.timeoutMs) && raw.timeoutMs > 0 ? Math.min(raw.timeoutMs, 60000) : defaultTimeoutMs,
    retryable: raw.retryable !== false,
  };
  for (const k of TARGET_KEYS) {
    if (t[k] !== undefined && t[k] !== null && t[k] !== '') action.target[k] = t[k];
  }
  return { ok: true, action };
}

module.exports = {
  ACTION_TYPES, RISK_LEVELS, VERIFICATION_TYPES, TYPE_RISK_FLOOR, SENSITIVE_FIELDS,
  TARGET_KEYS, NO_TARGET_TYPES, INTENT_RISK_FLOOR, riskFloorFor,
  UPLOAD_ROOT, resolveUploadPath,
  validateAction,
};
