'use strict';

// ============================================================================
// PHASE 17-C — Project Skill Schema（设计依据：.benchmark/PHASE17B_PROJECT_SKILL_ARCHITECTURE.md §5 / §6 / §16.3）
//
// 本模块是**纯函数层**：零副作用、零 I/O、零 LLM。
// 它回答一个问题：「这份 Skill 记录，允许落库吗？」
//
// 三条不可妥协的纪律（对应设计报告 §5.6 / §11.4 / §16.3）：
//   1. 持久化的是「意图 + 状态契约 + 验证契约 + 统计」；定位（selector/坐标）**绝不持久化**。
//   2. Skill 不产出成功裁决（无 success/verified 字段）—— Success Definition 完全不变。
//   3. 安全边界（挑战/风控/授权）由 SEC1–SEC8 八条检查在**落库前**强制。
//
// 设计报告与实现的**两处刻意偏差**（报告为设计稿，实现须对齐真实语义）：
//   [D1] SEC1 的扫描范围限定为「可执行体」（states + transitions），**不含 boundaries**。
//        原因：§16.1 强制 `boundaries.requiresHumanOn` 必须含 "SECURITY_CHALLENGE","MFA","3DS"，
//        而 SEC1 的关键词表本身包含 3ds/mfa —— 若全量扫描则**任何合法 Skill 都会被误拒**（设计稿自相矛盾）。
//        boundaries 是「要求交人」的**安全声明**，与「绕过」语义相反，理应排除在绕过检测之外。
//   [D2] SEC6 只拒绝**裁决型**成功断言（`"success":true` / `"verified"` / `"businessSuccess"`），
//        不拒绝 `samples.success` 这类**计数**字段（设计稿正则 `/"success"\s*:/` 会误伤统计基座
//        memoryRecord.createBase 的 samples 结构，使所有 Skill 无法落库）。
//        语义边界不变：Skill 仍然**结构上无法**声明业务成功。
// ============================================================================

const SCHEMA_VERSION = 1;

// ── 受控词表 ────────────────────────────────────────────────────────────────
const SKILL_STATUS = ['CANDIDATE', 'ACTIVE', 'STALE', 'REVALIDATING', 'DEPRECATED', 'ARCHIVED'];

const CAPABILITIES = [
  'SIGNUP', 'LOGIN', 'SEARCH', 'ADD_TO_CART', 'CHECKOUT', 'CREATE_PROJECT',
  'DOWNLOAD', 'CONTACT', 'SUBSCRIBE', 'NAVIGATE_GENERIC', 'OTHER',
];

const ACTION_TYPES = ['click', 'fill', 'select', 'press', 'submit', 'navigate', 'check', 'extract', 'inspect'];

// 状态可观察子句：**只允许存在性/文本/URL 类**，禁止任何定位器形态（B1/SEC7 强制）
// 口径与项目真实验证词表对齐（schema/action.js VERIFICATION_TYPES）：
//   url_contains 是 navigate 的**权威业务契约**（contract.deriveContract('navigate') 产出），
//   必须在此词表内 —— 否则所有导航步都会被判「无状态区分度」而整步丢弃（实现期已修正）。
const OBSERVABLE_TYPES = ['element_present', 'element_absent', 'url_contains', 'url_pattern', 'text_present', 'field_value'];
const OBSERVABLE_WEIGHTS = ['REQUIRED', 'SOFT'];
const CONTRACT_LOGIC = ['AND', 'OR'];

const TRANSITION_KINDS = ['SAME_ORIGIN', 'AUTHORIZED_ORIGIN_TRANSITION', 'EXTERNAL_ORIGIN', 'UNKNOWN'];
const LOGIN_STATES = ['ANONYMOUS', 'AUTHENTICATED', '*'];
const VALUE_SOURCES = ['NONE', 'LITERAL', 'CREDENTIAL_REF', 'FIELD_VALUE'];
const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH'];

// §16.1：固定不可配置 —— 遇到这些一律 PAUSE / HUMAN，Skill 无绕过分支
const REQUIRES_HUMAN_ON = ['SECURITY_CHALLENGE', 'MFA', '3DS'];

const AUTHORIZATION_CARRY_OVER = 'NONE'; // §5.5 固定值

// 禁止持久化的字段（与 flowSchema.FORBIDDEN_KEYS 同源，此处对 Skill 生效）
const FORBIDDEN_KEYS = ['selector', 'selectors', 'xpath', 'coordinates', 'coords', 'coordinate', 'pixel', 'offsetX', 'offsetY'];
const FORBIDDEN_VALUE_HINTS = ['xpath=', 'css=', 'document.querySelector'];

// §16.3 SEC1–SEC8
// 说明：SEC1 只作用于可执行体（见文件头 [D1]）；SEC3/SEC7 等其余检查作用于全量 blob。
const EXECUTABLE_BYPASS_RE = /captcha|px[-_]?challenge|perimeterx|3ds|mfa|otp[-_]?bypass|solve[-_]?challenge|bypass/i;

const SECURITY_CHECKS = [
  {
    id: 'SEC1',
    rule: 'no bypass semantics（仅扫可执行体，不含 boundaries 安全声明）',
    run: (skill) => (EXECUTABLE_BYPASS_RE.test(executableBlob(skill))
      ? '可执行体（states/transitions）中出现安全绕过语义（captcha/px/3ds/mfa/bypass/solve）'
      : null),
  },
  {
    id: 'SEC2',
    rule: 'no authorized-origin list（授权关系不得由 Skill 自行声明）',
    run: (skill) => (/authorizedOrigins|allowedOrigins|whitelist/i.test(fullBlob(skill))
      ? 'Skill 中不得出现授权 origin 列表（授权裁决属 Phase 17-A 闸门，非 Skill）'
      : null),
  },
  {
    id: 'SEC3',
    rule: 'no domain matching predicates（字符串相似 != 授权关系）',
    run: (skill) => (/\.includes\(|isSameSite|endsWith\('\.'\)/.test(fullBlob(skill))
      ? 'Skill 中不得出现域名匹配谓词（.includes( / isSameSite / endsWith(\'.\')）'
      : null),
  },
  {
    id: 'SEC4',
    rule: 'external origin ⇒ no authorization carry（跨域一律不继承凭据授权）',
    run: (skill) => {
      const bad = collectTransitions(skill).find((t) => t
        && t.kind === 'EXTERNAL_ORIGIN'
        && t.authorizationCarryOver !== AUTHORIZATION_CARRY_OVER);
      return bad
        ? 'EXTERNAL_ORIGIN 迁移的 authorizationCarryOver 必须为 "NONE"（拒绝自动继承主站凭据授权）'
        : null;
    },
  },
  {
    id: 'SEC5',
    rule: 'no credential plaintext（永不明文）',
    run: (skill) => {
      const at = findPlaintextCredential(skill);
      return at ? '敏感字段出现明文值或非法凭据引用（须为 vault:/secret: 引用）：' + at : null;
    },
  },
  {
    id: 'SEC6',
    rule: 'no success verdict（Skill 结构上不得产出成功裁决，见 [D2]）',
    run: (skill) => {
      const blob = fullBlob(skill);
      // 裁决型断言：布尔 true / 独立的 verified / businessSuccess 键
      if (/"success"\s*:\s*true/.test(blob)
        || /"verified"\s*:/.test(blob)
        || /"businessSuccess"\s*:/.test(blob)) {
        return 'Skill 不得包含成功裁决字段（success:true / verified / businessSuccess）——业务成功裁决只属 Verification';
      }
      return null;
    },
  },
  {
    id: 'SEC7',
    rule: 'no locator（selector/xpath/坐标绝不持久化）',
    run: (skill) => {
      // 注意：比较前**两侧都小写**。既有 flowSchema.js:25/29 只把 blob 小写、提示串保留
      // 大写 S，导致 'document.querySelector' 这条护栏**恒不触发**（真实死护栏）。
      // 取证：server/data/aiFlowMemory.json 现存数据零命中，故此处修正为双向小写属**纯收紧**，
      // 不会改变任何已落库记录的判定（同一缺陷已在 flowSchema.js 同步修复）。
      const blob = fullBlob(skill).toLowerCase();
      for (const k of FORBIDDEN_KEYS) {
        if (blob.includes('"' + k.toLowerCase() + '"')) return '禁止持久化定位字段 ' + k;
      }
      for (const h of FORBIDDEN_VALUE_HINTS) {
        if (blob.includes(h.toLowerCase())) return '禁止持久化定位值形态 ' + h;
      }
      return null;
    },
  },
  {
    id: 'SEC8',
    rule: 'no site-name literal（通用模型，零站点字面量，复用 17-A 守护 S1）',
    run: (skill) => (/webflow|github\.com|google\.com|apple\.com/i.test(fullBlob(skill))
      ? 'Skill 中不得出现站点名字面量（webflow/github.com/google.com/apple.com）'
      : null),
  },
];

// ── 序列化辅助 ──────────────────────────────────────────────────────────────
function fullBlob(skill) {
  try { return JSON.stringify(skill || {}); } catch (e) { return ''; }
}

// 可执行体 = 真正会被「照着做」的部分（states 内的动作与状态契约 + 迁移）
function executableBlob(skill) {
  const s = skill || {};
  const states = Array.isArray(s.states) ? s.states : [];
  try {
    return JSON.stringify({
      states: states.map((st) => ({
        id: st && st.id,
        name: st && st.name,
        stateContract: st && st.stateContract,
        actions: st && st.actions,
      })),
      transitions: collectTransitions(skill),
    });
  } catch (e) { return ''; }
}

// 迁移来源：Action.expectedTransition（§5.3）与顶层 transitions（§5.5）二者的并集
function collectTransitions(skill) {
  const out = [];
  const s = skill || {};
  const push = (t) => { if (t && typeof t === 'object') out.push(t); };
  if (Array.isArray(s.transitions)) s.transitions.forEach(push);
  for (const st of (Array.isArray(s.states) ? s.states : [])) {
    for (const a of (st && Array.isArray(st.actions) ? st.actions : [])) {
      if (a && a.expectedTransition) push(a.expectedTransition);
    }
  }
  return out;
}

// 敏感明文 / 非法凭据引用检测（逐节点下钻，返回首个违规路径）
//
// 判定必须同时覆盖**两种真实形状**（Skill Schema 把 field 放在 targetSemantic 里、把 value 放在 Action 上）：
//   ① 扁平：{ field: 'password', value: 'xxx' }
//   ② 嵌套：{ targetSemantic: { field: 'password' }, value: 'xxx' }
// 只查 ① 会漏掉 ② —— 而 ② 正是本项目 Action 的实际形状（曾被 SEC5 漏检，已录入守护测试 T5）。
const SENSITIVE_FIELD_RE = /pass|pwd|cvv|cvc|card|otp|token|secret|pin|密码|卡号|验证码/i;

function findPlaintextCredential(root) {
  let hit = null;
  const visit = (node, path) => {
    if (hit || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((n, i) => visit(n, path + '[' + i + ']')); return; }

    // 字段名来源：本节点的 targetSemantic.field / target.field / field / name
    const nested = (node.targetSemantic && typeof node.targetSemantic === 'object') ? node.targetSemantic
      : ((node.target && typeof node.target === 'object') ? node.target : null);
    let fieldKey = null;
    if (nested && typeof nested.field === 'string') fieldKey = nested.field;
    else if (typeof node.field === 'string') fieldKey = node.field;
    else if (typeof node.name === 'string') fieldKey = node.name;

    const rawValue = node.value !== undefined ? node.value : node.valueLiteral;
    if (fieldKey && SENSITIVE_FIELD_RE.test(fieldKey) && typeof rawValue === 'string' && rawValue.trim()) {
      hit = path + '.value';
      return;
    }
    if (node.credentialRef !== undefined && node.credentialRef !== null && node.credentialRef !== '') {
      if (!/^(vault|secret):/.test(String(node.credentialRef))) {
        hit = path + '.credentialRef';
        return;
      }
    }
    for (const k of Object.keys(node)) visit(node[k], path ? path + '.' + k : k);
  };
  visit(root, '');
  return hit;
}

// ── 结构校验 ────────────────────────────────────────────────────────────────
function isResolvableOrigin(v) {
  if (typeof v !== 'string' || !v.trim()) return false;
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.host;
  } catch (e) { return false; }
}

function validateStructure(skill) {
  const errors = [];
  const push = (id, message) => errors.push({ id, message });
  if (!skill || typeof skill !== 'object') { push('STRUCT', 'Skill 必须是对象'); return errors; }

  if (typeof skill.id !== 'string' || !/^skill_/.test(skill.id)) push('STRUCT_ID', '缺少合法 id（前缀 skill_）');
  if (skill.schemaVersion !== SCHEMA_VERSION) push('STRUCT_SCHEMA', 'schemaVersion 必须为 ' + SCHEMA_VERSION);
  if (!(Number.isInteger(skill.version) && skill.version >= 1)) push('STRUCT_VERSION', 'version 必须为正整数');
  if (!SKILL_STATUS.includes(skill.status)) push('STRUCT_STATUS', 'status 非法: ' + String(skill.status));
  if (!CAPABILITIES.includes(skill.capability)) push('STRUCT_CAPABILITY', 'capability 不在受控词表: ' + String(skill.capability));
  if (typeof skill.intent !== 'string' || !skill.intent.trim()) push('STRUCT_INTENT', 'intent 缺失');

  // 环境作用域：originAnchor 必须可解析（它是授权锚点，不是白名单）
  const env = skill.environmentScope || {};
  if (!isResolvableOrigin(env.originAnchor)) push('STRUCT_ORIGIN', 'environmentScope.originAnchor 不可解析为 http(s) origin');
  if (env.locale !== '*' && !Array.isArray(env.locale)) push('STRUCT_LOCALE', 'locale 必须为数组或 "*"');
  if (env.loginState && !LOGIN_STATES.includes(env.loginState)) push('STRUCT_LOGIN', 'loginState 非法: ' + String(env.loginState));

  // 能力边界：requiresHumanOn 固定包含三类挑战（§16.1 不可配置）
  const b = skill.boundaries || {};
  const rho = Array.isArray(b.requiresHumanOn) ? b.requiresHumanOn : [];
  for (const must of REQUIRES_HUMAN_ON) {
    if (!rho.includes(must)) push('STRUCT_HUMAN_ON', 'boundaries.requiresHumanOn 必须固定包含 ' + must);
  }
  if (typeof b.excludesPayment !== 'boolean') push('STRUCT_BOUNDARY', 'boundaries.excludesPayment 必须为布尔');
  if (typeof b.involvesCredentials !== 'boolean') push('STRUCT_BOUNDARY', 'boundaries.involvesCredentials 必须为布尔');

  // 状态机
  const states = Array.isArray(skill.states) ? skill.states : [];
  if (!states.length) { push('STRUCT_STATES', 'states 必须非空'); return errors; }
  const ids = new Set();
  states.forEach((st, i) => {
    const at = 'states[' + i + ']';
    if (!st || typeof st !== 'object') { push('STRUCT_STATE', at + ' 不是对象'); return; }
    if (typeof st.id !== 'string' || !st.id.trim()) push('STRUCT_STATE', at + ' 缺少 id');
    else if (ids.has(st.id)) push('STRUCT_STATE', at + ' id 重复: ' + st.id);
    else ids.add(st.id);
    if (typeof st.name !== 'string' || !st.name.trim()) push('STRUCT_STATE', at + ' 缺少 name');
    const sc = st.stateContract;
    if (!sc || typeof sc !== 'object') { push('STRUCT_CONTRACT', at + ' 缺少 stateContract'); return; }
    const obs = Array.isArray(sc.observable) ? sc.observable : [];
    if (!obs.length) push('STRUCT_CONTRACT', at + '.stateContract.observable 必须非空');
    if (!CONTRACT_LOGIC.includes(sc.logic)) push('STRUCT_CONTRACT', at + '.stateContract.logic 非法: ' + String(sc.logic));
    obs.forEach((c, j) => {
      const cat = at + '.stateContract.observable[' + j + ']';
      if (!c || typeof c !== 'object') { push('STRUCT_CLAUSE', cat + ' 不是对象'); return; }
      if (!OBSERVABLE_TYPES.includes(c.type)) push('STRUCT_CLAUSE', cat + '.type 非法（只允许存在性/文本/URL 类）: ' + String(c.type));
      if (!OBSERVABLE_WEIGHTS.includes(c.weight)) push('STRUCT_CLAUSE', cat + '.weight 必须为 REQUIRED|SOFT: ' + String(c.weight));
      if (c.target == null && c.expect == null) push('STRUCT_CLAUSE', cat + ' 必须提供 target 或 expect');
    });
    const actions = Array.isArray(st.actions) ? st.actions : [];
    actions.forEach((a, j) => {
      const cat = at + '.actions[' + j + ']';
      if (!a || typeof a !== 'object') { push('STRUCT_ACTION', cat + ' 不是对象'); return; }
      if (typeof a.id !== 'string' || !a.id.trim()) push('STRUCT_ACTION', cat + ' 缺少 id');
      if (!ACTION_TYPES.includes(a.type)) push('STRUCT_ACTION', cat + '.type 非法: ' + String(a.type));
      if (!a.targetSemantic || typeof a.targetSemantic !== 'object') push('STRUCT_ACTION', cat + ' 缺少 targetSemantic');
      // §11.4 硬门禁：无真实通过的 verification 契约 → 该步不入 Skill
      const v = a.verification;
      if (!v || typeof v !== 'object' || !OBSERVABLE_TYPES.includes(v.type)) {
        push('STRUCT_VERIFICATION', cat + ' 缺少真实验证契约（无 verification 的步骤不得入 Skill）');
      }
      if (a.valueSource !== undefined && !VALUE_SOURCES.includes(a.valueSource)) {
        push('STRUCT_VALUE_SOURCE', cat + '.valueSource 非法: ' + String(a.valueSource));
      }
      if (a.risk !== undefined && !RISK_LEVELS.includes(a.risk)) {
        push('STRUCT_RISK', cat + '.risk 非法: ' + String(a.risk));
      }
      const t = a.expectedTransition;
      if (!t || typeof t !== 'object') push('STRUCT_TRANSITION', cat + ' 缺少 expectedTransition');
      else {
        if (!ids.has(t.from) && t.from !== 'LANDING') push('STRUCT_TRANSITION', cat + '.expectedTransition.from 指向不存在的状态: ' + String(t.from));
        if (!ids.has(t.to) && t.to !== 'CONFIRMED') push('STRUCT_TRANSITION', cat + '.expectedTransition.to 指向不存在的状态: ' + String(t.to));
        if (t.kind !== undefined && !TRANSITION_KINDS.includes(t.kind)) push('STRUCT_TRANSITION', cat + '.expectedTransition.kind 非法: ' + String(t.kind));
      }
    });
  });

  if (!ids.has(skill.entryState)) push('STRUCT_ENTRY', 'entryState 指向不存在的状态: ' + String(skill.entryState));
  const term = Array.isArray(skill.terminalStates) ? skill.terminalStates : [];
  if (!term.length) push('STRUCT_TERMINAL', 'terminalStates 必须非空');
  term.forEach((t) => { if (!ids.has(t)) push('STRUCT_TERMINAL', 'terminalStates 含不存在的状态: ' + String(t)); });

  // 证据链引用必须存在（§11.4：无证据禁止晋升）
  if (typeof skill.evidenceChainRef !== 'string' || !skill.evidenceChainRef.trim()) {
    push('STRUCT_EVIDENCE', '缺少 evidenceChainRef（无证据链的 Skill 不得落库）');
  }
  return errors;
}

// ── 对外主入口 ──────────────────────────────────────────────────────────────
// 返回 { ok, errors: [{id, message}] }；errors 含 SEC1–SEC8 与结构错误。
function validateSkill(skill) {
  const errors = validateStructure(skill);
  for (const chk of SECURITY_CHECKS) {
    let msg = null;
    try { msg = chk.run(skill); } catch (e) { msg = '安全检查异常: ' + String((e && e.message) || e); }
    if (msg) errors.push({ id: chk.id, message: msg });
  }
  return { ok: errors.length === 0, errors };
}

function securityCheckIds() {
  return SECURITY_CHECKS.map((c) => c.id);
}

module.exports = {
  // 常量
  SCHEMA_VERSION, SKILL_STATUS, CAPABILITIES, ACTION_TYPES, OBSERVABLE_TYPES, OBSERVABLE_WEIGHTS,
  CONTRACT_LOGIC, TRANSITION_KINDS, LOGIN_STATES, VALUE_SOURCES, RISK_LEVELS,
  REQUIRES_HUMAN_ON, AUTHORIZATION_CARRY_OVER, FORBIDDEN_KEYS, FORBIDDEN_VALUE_HINTS,
  // 校验
  validateSkill, validateStructure, securityCheckIds, SECURITY_CHECKS,
  // 工具（供 Builder / 测试复用）
  collectTransitions, findPlaintextCredential, isResolvableOrigin, executableBlob, fullBlob,
};
