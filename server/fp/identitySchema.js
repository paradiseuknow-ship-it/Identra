'use strict';

// Phase 16-B1 前置 — Identity Schema & Fail-Fast Validator（Node 侧）
//
// 架构边界（Phase 16-A IDENTITY_SCHEMA / 16-B 规格 §7 §8）：
//   Profile → identity.json → BrowserManager → IdentityConfig → Native Chromium
// 本模块 = IdentityConfig 的 Node 侧校验层：完整 schema 在这里 fail-fast；
// Native 侧（16-B1 POC 落地后）只做最小防御（解析失败/缺 identityId/seed → 拒绝启动）。
//
// 硬性原则（继承 Phase 14 纪律）：
//   - 全部 invalid identity → fail-fast（IDENTITY_* 错误码），禁止 random fallback
//   - schema 纯函数、确定性：同输入 → 同输出，无时间戳、无随机
//   - identity.json 不携带任何秘密（credentials/cookies/tokens → 拒绝）
//
// V 语义（继承 Phase 14 Invalid-Identity 家族）：
//   V1 IDENTITY_UNKNOWN_OS / V2 IDENTITY_UNKNOWN_BROWSER —— 值域外
//   V3 IDENTITY_UNAVAILABLE_COMBINATION —— 组合在 UA 模板池不存在
//   V4 IDENTITY_INVALID_VERSION —— 版本格式非法
//   V5 IDENTITY_MALFORMED —— 非对象/类型错误
//   V6 IDENTITY_MISSING_FIELD —— 必填键缺失
//   +  IDENTITY_FORBIDDEN_SECRET —— 携带疑似秘密字段

const D = require('./data');
const { OS_CANONICAL, BROWSER_CANONICAL } = require('./inputNormalize');

class IdentityError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
  }
}

// 必填字符串字段（非空 string）
const REQUIRED_STRING_FIELDS = [
  'identityId', 'seed', 'os', 'osVersion', 'browser', 'browserVersion', 'locale', 'timezone',
];
// 必填字符串数组字段（非空数组，元素为非空 string）
const REQUIRED_ARRAY_FIELDS = ['languages'];
// 必须存在键、值为 object 或 null 的子 profile 字段（16-B 阶段允许 null，后续 POC 逐个填充）
const PROFILE_FIELDS = [
  'cpuProfile', 'memoryProfile', 'gpuProfile', 'displayProfile', 'fontProfile',
  'networkProfile', 'renderingProfile', 'audioProfile', 'webrtcProfile',
];
const ALL_FIELDS = REQUIRED_STRING_FIELDS.concat(REQUIRED_ARRAY_FIELDS, PROFILE_FIELDS);

const VERSION_RE = /^\d{1,10}(\.\d{1,10}){0,3}$/;

// 秘密字段名黑名单（大小写不敏感、覆盖顶层与嵌套 profile 内的键）
const FORBIDDEN_KEY_RE = /pass(word)?|secret|token|cookie|credential|authoriz|api[-_]?key|private[-_]?key|session[-_]?id/i;

function collectForbiddenKeys(value, base, out) {
  if (value === null || typeof value !== 'object') return out;
  for (const key of Object.keys(value)) {
    const p = base ? base + '.' + key : key;
    if (FORBIDDEN_KEY_RE.test(key)) out.push(p);
    collectForbiddenKeys(value[key], p, out);
  }
  return out;
}

// 返回 { ok, errors: [{ code, field, message }] }；不 throw，供聚合校验与测试用。
function validateIdentity(identity) {
  const errors = [];
  const add = (code, field, message) => errors.push({ code, field, message });

  if (identity === null || typeof identity !== 'object' || Array.isArray(identity)) {
    add('IDENTITY_MALFORMED', null, 'identity 必须是 JSON 对象');
    return { ok: false, errors };
  }

  for (const f of REQUIRED_STRING_FIELDS) {
    if (!(f in identity) || identity[f] === undefined) add('IDENTITY_MISSING_FIELD', f, '缺少必填字段 ' + f);
    else if (typeof identity[f] !== 'string' || !identity[f].trim()) add('IDENTITY_MALFORMED', f, f + ' 必须是非空 string');
  }
  for (const f of REQUIRED_ARRAY_FIELDS) {
    if (!(f in identity) || identity[f] === undefined) add('IDENTITY_MISSING_FIELD', f, '缺少必填字段 ' + f);
    else if (!Array.isArray(identity[f]) || !identity[f].length
      || !identity[f].every((x) => typeof x === 'string' && !!x.trim())) {
      add('IDENTITY_MALFORMED', f, f + ' 必须是非空 string 数组');
    }
  }
  for (const f of PROFILE_FIELDS) {
    if (!(f in identity) || identity[f] === undefined) add('IDENTITY_MISSING_FIELD', f, '缺少必填字段 ' + f);
    else {
      const v = identity[f];
      if (v !== null && (typeof v !== 'object' || Array.isArray(v))) add('IDENTITY_MALFORMED', f, f + ' 必须是 object 或 null');
    }
  }
  if (errors.length) return { ok: false, errors };

  // V1/V2：canonical 值域（与 fp/inputNormalize + 模板池一致）
  if (!OS_CANONICAL.includes(identity.os)) add('IDENTITY_UNKNOWN_OS', 'os', '未知 os "' + identity.os + '"（值域: ' + OS_CANONICAL.join('/') + '）');
  if (!BROWSER_CANONICAL.includes(identity.browser)) add('IDENTITY_UNKNOWN_BROWSER', 'browser', '未知 browser "' + identity.browser + '"（值域: ' + BROWSER_CANONICAL.join('/') + '）');

  // V4：版本格式（browserVersion 必须形如 N(.N){0,3}；osVersion 同规则 —— 16-B4 platformVersion 派生源）
  if (!VERSION_RE.test(identity.browserVersion)) add('IDENTITY_INVALID_VERSION', 'browserVersion', 'browserVersion "' + identity.browserVersion + '" 非法（期望 N(.N){0,3}）');
  if (!VERSION_RE.test(identity.osVersion)) add('IDENTITY_INVALID_VERSION', 'osVersion', 'osVersion "' + identity.osVersion + '" 非法（期望 N(.N){0,3}）');

  // V3：组合必须在 UA 模板池存在（单一事实源 = data.USER_AGENTS）
  const comboAvailable = D.USER_AGENTS.some((u) => u.os === identity.os && u.browser === identity.browser);
  if (!comboAvailable) add('IDENTITY_UNAVAILABLE_COMBINATION', 'os/browser', '组合 ' + identity.os + '+' + identity.browser + ' 在 UA 模板池无可用模板');

  // 秘密扫描（顶层 + 嵌套键名）
  const forbidden = collectForbiddenKeys(identity, '', []);
  if (forbidden.length) add('IDENTITY_FORBIDDEN_SECRET', forbidden.join(','), 'identity 携带疑似秘密字段名');

  return { ok: !errors.length, errors };
}

// fail-fast 断言：任何 invalid → throw IdentityError（第一个错误）
function assertValidIdentity(identity) {
  const r = validateIdentity(identity);
  if (!r.ok) {
    const e = r.errors[0];
    throw new IdentityError('[fp.identity] ' + e.code + (e.field ? ' @' + e.field : '') + ': ' + e.message, e.code);
  }
  return true;
}

// 确定性序列化：键递归排序 → 同一 identity 任意次序列化字节相同（落盘稳定、diff 友好）
function canonicalIdentityString(identity) {
  if (identity === null || typeof identity !== 'object') return JSON.stringify(identity);
  if (Array.isArray(identity)) return '[' + identity.map(canonicalIdentityString).join(',') + ']';
  const keys = Object.keys(identity).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalIdentityString(identity[k])).join(',') + '}';
}

module.exports = {
  IdentityError,
  REQUIRED_STRING_FIELDS,
  REQUIRED_ARRAY_FIELDS,
  PROFILE_FIELDS,
  ALL_FIELDS,
  validateIdentity,
  assertValidIdentity,
  canonicalIdentityString,
};
