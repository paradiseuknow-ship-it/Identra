'use strict';

// ExpectedBusinessState contract — Phase 11.
//
// The single source of truth for "did the BUSINESS outcome complete".
// It verifies OUTCOME, not ACTION. An action (click/fill/submit) executing successfully
// is NOT sufficient; the page must reach the expected business state.
//
// This module is PURE: it does not import verification.js (avoids a circular require).
// The caller supplies a `clauseVerify(clause, after, before)` callback that delegates to the
// existing verification engine, so evidence clauses reuse text_present / element_present /
// url_contains / element_absent / login_state / page_change / etc.
//
// contract = {
//   stateType: string,                 // LOGIN_SUCCESS / SEARCH_SUCCESS / FORM_SUBMIT_SUCCESS / FIELD_FILLED / SELECTED / CHECKED / NAVIGATED / CONFIRMATION / DOWNLOAD / GENERIC_STATE / CUSTOM
//   expected: string,                  // human-readable outcome description (objective-derived)
//   requiredEvidence: [ {type, expect?, ...} ],   // each evaluated by clauseVerify
//   forbiddenEvidence: [ {type, expect?, ...} ],  // ANY match => hard fail
//   allowedAlternatives: [ {type, expect?, ...} ],// extra acceptable states (OR with required)
//   evidenceLogic: 'AND' | 'OR',       // how requiredEvidence is combined (default AND)
//   timeout: number,                   // ms budget for the observation window
//   confidence: number,                // confidence when success
// }

const STATE_TYPES = [
  'LOGIN_SUCCESS', 'LOGOUT_SUCCESS', 'SEARCH_SUCCESS', 'FORM_SUBMIT_SUCCESS',
  'FIELD_FILLED', 'SELECTED', 'CHECKED', 'NAVIGATED', 'CONFIRMATION', 'DOWNLOAD',
  'GENERIC_STATE', 'CUSTOM',
];

// Action type -> default outcome contract (the "Action -> Outcome Mapping", Phase 11 §十).
// Required-evidence clauses are intentionally multi-signal + OR so a correctly-reached
// business state is recognised even when the exact wording differs.
const ACTION_TO_STATE = {
  login: {
    stateType: 'LOGIN_SUCCESS', expected: 'authenticated (session established)',
    requiredEvidence: [
      { type: 'text_absent', expect: 'login' },
      { type: 'text_present', expect: 'logout' },
      { type: 'text_present', expect: 'dashboard' },
      { type: 'text_present', expect: 'welcome' },
      { type: 'text_present', expect: 'my account' },
      { type: 'text_present', expect: 'profile' },
    ],
    forbiddenEvidence: [
      { type: 'text_present', expect: 'invalid' },
      { type: 'text_present', expect: 'incorrect' },
      { type: 'text_present', expect: 'error' },
    ],
    evidenceLogic: 'OR', confidence: 0.9,
  },
  logout: {
    stateType: 'LOGOUT_SUCCESS', expected: 'logged out (returned to auth screen)',
    requiredEvidence: [
      { type: 'text_present', expect: 'login' },
      { type: 'text_present', expect: 'sign in' },
      { type: 'text_present', expect: 'register' },
    ],
    forbiddenEvidence: [
      { type: 'text_present', expect: 'logout' },
      { type: 'text_present', expect: 'my account' },
    ],
    evidenceLogic: 'OR', confidence: 0.9,
  },
  search: {
    stateType: 'SEARCH_SUCCESS', expected: 'search results visible',
    requiredEvidence: [
      { type: 'text_present', expect: 'result' },
      { type: 'element_present', expect: 'results' },
      { type: 'text_present', expect: 'found' },
    ],
    forbiddenEvidence: [
      { type: 'text_present', expect: 'no results' },
      { type: 'text_present', expect: 'not found' },
    ],
    evidenceLogic: 'OR', confidence: 0.85,
  },
  submit: {
    stateType: 'FORM_SUBMIT_SUCCESS', expected: 'submission acknowledged (confirmation text or navigation/state change)',
    // 真实提交常表现为：确认文案、或页面跳转/表单被替换（page_change）。
    // 但凡出现错误文案（error/invalid/required/failed）一律硬失败 —— 不放宽验证门槛。
    requiredEvidence: [
      { type: 'text_present', expect: 'success' },
      { type: 'text_present', expect: 'confirm' },
      { type: 'text_present', expect: 'thank' },
      { type: 'text_present', expect: 'received' },
      { type: 'text_present', expect: 'done' },
      { type: 'text_present', expect: 'submitted' },
      { type: 'page_change' },
    ],
    forbiddenEvidence: [
      { type: 'text_present', expect: 'error' },
      { type: 'text_present', expect: 'invalid' },
      { type: 'text_present', expect: 'required' },
      { type: 'text_present', expect: 'failed' },
    ],
    evidenceLogic: 'OR', confidence: 0.85,
  },
  fill: {
    stateType: 'FIELD_FILLED', expected: 'field contains the entered value',
    // B1：验证真实业务结果 —— 校验字段的真实 state.value（来自 observation），而非脆弱的 textSummary。
    // 敏感字段（密码）仅校验「是否已填写」(valueLength>0)，不比对明文，避免泄漏。
    requiredEvidence: [{ type: 'field_value', expect: '__VALUE__', target: '__TARGET__' }],
    forbiddenEvidence: [], evidenceLogic: 'AND', confidence: 0.8,
  },
  select: {
    stateType: 'SELECTED', expected: 'option selected',
    requiredEvidence: [{ type: 'field_value', expect: '__VALUE__', target: '__TARGET__' }],
    forbiddenEvidence: [], evidenceLogic: 'AND', confidence: 0.8,
  },
  check: {
    stateType: 'CHECKED', expected: 'checkbox checked',
    requiredEvidence: [{ type: 'field_checked', target: '__TARGET__', expect: 'checked' }],
    forbiddenEvidence: [], evidenceLogic: 'AND', confidence: 0.8,
  },
  uncheck: {
    stateType: 'UNCHECKED', expected: 'checkbox unchecked',
    requiredEvidence: [{ type: 'field_checked', target: '__TARGET__', expect: 'unchecked' }],
    forbiddenEvidence: [], evidenceLogic: 'AND', confidence: 0.8,
  },
  click: {
    stateType: 'GENERIC_STATE', expected: 'click produced an observable page/state change',
    // B1：点击必须产生可观测结果（页面/内容变化，或目标元素被消耗消失），禁止仅凭 action 执行成功认定业务完成。
    requiredEvidence: [
      { type: 'page_change' },
      { type: 'element_absent', expect: '__TARGET__' },
    ],
    forbiddenEvidence: [], evidenceLogic: 'OR', confidence: 0.7,
  },
  navigate: {
    stateType: 'NAVIGATED', expected: 'expected page loaded',
    requiredEvidence: [{ type: 'url_contains', expect: '__URL__' }],
    forbiddenEvidence: [], evidenceLogic: 'AND', confidence: 0.8,
  },
};

// Action types whose OUTCOME can be auto-derived into a contract when the planner omits one.
const DERIVABLE = Object.keys(ACTION_TO_STATE);

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function substitute(contract, action) {
  const c = clone(contract);
  const val = action && action.value != null ? String(action.value) : '';
  const url = action && action.target && action.target.url ? String(action.target.url) : '';
  const t = action && action.target;
  const target = t ? (t.semantic || t.field || t.text || (typeof t === 'string' ? t : '')) : '';
  const walk = (node) => {
    if (typeof node === 'string') return node.replace('__VALUE__', val).replace('__URL__', url).replace('__TARGET__', target);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') { for (const k of Object.keys(node)) node[k] = walk(node[k]); }
    return node;
  };
  return walk(c);
}

// Derive a default expected-business-state contract from an action type.
// Returns null for actions whose outcome cannot be auto-inferred (e.g. generic click).
function deriveContract(action) {
  if (!action || !action.type) return null;
  const base = ACTION_TO_STATE[action.type];
  if (!base) return null;
  return substitute(base, action);
}

// Objective keyword -> stateType（objective 直接映射到业务结果态，Phase 11 §六/§十）。
const STATE_BY_OBJECTIVE = [
  { re: /(登录|登陆|log ?in|sign ?in|auth)/i, stateType: 'LOGIN_SUCCESS' },
  { re: /(登出|退出|log ?out|sign ?out)/i, stateType: 'LOGOUT_SUCCESS' },
  { re: /(搜索|查找|search|query)/i, stateType: 'SEARCH_SUCCESS' },
  { re: /(提交|下单|报名|submit|place order|checkout|purchase)/i, stateType: 'FORM_SUBMIT_SUCCESS' },
  { re: /(填写|录入|填表|fill|enter|input)/i, stateType: 'FIELD_FILLED' },
  { re: /(选择|选中|select|pick)/i, stateType: 'SELECTED' },
  { re: /(勾选|复选|check|tick)/i, stateType: 'CHECKED' },
  { re: /(下载|download)/i, stateType: 'DOWNLOAD' },
  { re: /(导航|跳转|打开页面|navigate|go to|open)/i, stateType: 'NAVIGATED' },
];

// 由 objective + action 推导业务完成契约：objective 优先，否则回退 action 类型推导。
function contractFromObjective(objective, action) {
  const obj = objective || '';
  for (const m of STATE_BY_OBJECTIVE) if (m.re.test(obj)) {
    const base = Object.values(ACTION_TO_STATE).find((b) => b.stateType === m.stateType);
    if (base) return substitute(base, action || {});
  }
  return deriveContract(action);
}

// Convert a legacy {type, expect} verification into a single-clause contract.
function legacyToContract(v) {
  if (!v || !v.type || v.type === 'none') return null;
  return {
    stateType: 'GENERIC_STATE',
    expected: v.expect || v.type,
    requiredEvidence: [{ type: v.type, expect: v.expect }],
    forbiddenEvidence: [],
    evidenceLogic: 'AND',
    confidence: 0.75,
  };
}

function normalizeContract(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {
    stateType: STATE_TYPES.includes(raw.stateType) ? raw.stateType : 'GENERIC_STATE',
    expected: typeof raw.expected === 'string' ? raw.expected : '',
    requiredEvidence: Array.isArray(raw.requiredEvidence) ? raw.requiredEvidence.filter((c) => c && c.type) : [],
    forbiddenEvidence: Array.isArray(raw.forbiddenEvidence) ? raw.forbiddenEvidence.filter((c) => c && c.type) : [],
    // allowedAlternatives 是「契约数组」（每个含 stateType + requiredEvidence），
    // 需递归 normalize 为契约，而非按 clause 的 .type 过滤（契约用 stateType 不用 type）。
    // 兼容旧键名 allowedAlternativeStates（部分 planner / 测试沿用）。
    // 裸 clause（含 type/expect，无 requiredEvidence/stateType）先用 legacyToContract 包成单子句契约，
    // 否则 clause 被归一化为空 requiredEvidence，会被下方 filter 丢弃，导致替代态永久失效。
    allowedAlternatives: (() => {
      const rawAlts = raw.allowedAlternatives || raw.allowedAlternativeStates;
      if (!Array.isArray(rawAlts)) return [];
      return rawAlts
        .map((a) => {
          const norm = (a && (a.requiredEvidence || a.stateType)) ? a : legacyToContract(a);
          return normalizeContract(norm);
        })
        .filter((c) => c && c.requiredEvidence && c.requiredEvidence.length);
    })(),
    evidenceLogic: raw.evidenceLogic === 'OR' ? 'OR' : 'AND',
    timeout: Number.isFinite(raw.timeout) && raw.timeout > 0 ? Math.min(raw.timeout, 60000) : 5000,
    confidence: Number.isFinite(raw.confidence) ? raw.confidence : 0.85,
  };
  return out;
}

function validateContract(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['contract 必须是对象'] };
  if (!STATE_TYPES.includes(raw.stateType)) errors.push('stateType 非法: ' + String(raw.stateType));
  if (!Array.isArray(raw.requiredEvidence) || !raw.requiredEvidence.length) errors.push('requiredEvidence 不能为空');
  for (const c of (raw.requiredEvidence || [])) {
    if (!c || !c.type) errors.push('requiredEvidence 子句缺少 type');
  }
  return errors.length ? { ok: false, errors } : { ok: true, contract: normalizeContract(raw) };
}

// Evaluate a contract against an observation.
// clauseVerify(clause, after, before) -> { success, confidence, evidence[] }
// Returns { success, confidence, evidence[], logic, passed, total, forbiddenHit, alternativesMatched }.
function evaluateContract(contract, after, before, clauseVerify) {
  const c = normalizeContract(contract);
  if (!c) return { success: false, confidence: 0.3, evidence: ['contract 非法或为空'], logic: 'AND', passed: 0, total: 0 };
  const evidence = [];

  // 1) Forbidden evidence: ANY match => hard fail (never override).
  for (const f of c.forbiddenEvidence) {
    const r = clauseVerify(f, after, before);
    if (r.success) {
      evidence.push('forbidden evidence present: ' + (f.expect ? (f.type + '="' + f.expect + '"') : f.type) + ' → ' + r.evidence.join('; '));
      return { success: false, confidence: 0.95, evidence, logic: c.evidenceLogic, passed: 0, total: c.requiredEvidence.length, forbiddenHit: f };
    }
  }

  // 2) Required evidence combined by logic.
  const clauses = c.requiredEvidence;
  let passed = 0;
  const clauseResults = [];
  for (const cl of clauses) {
    const r = clauseVerify(cl, after, before);
    clauseResults.push({ clause: cl, ok: r.success, evidence: r.evidence });
    if (r.success) passed++;
    else evidence.push('required unmet: ' + (cl.expect ? (cl.type + '="' + cl.expect + '"') : cl.type) + ' → ' + r.evidence.join('; '));
  }
  let ok = c.evidenceLogic === 'OR' ? passed > 0 : passed === clauses.length;

  // 3) Allowed alternatives: if required failed, try OR-ing with alternatives.
  //    每个 alternative 是「完整契约」，需用 evaluateContract 递归评估（而非 clauseVerify，否则会被 none 守卫误判为成功）。
  let altMatched = null;
  if (!ok && c.allowedAlternatives.length) {
    for (const a of c.allowedAlternatives) {
      const r = evaluateContract(a, after, before, clauseVerify);
      if (r.success) { ok = true; altMatched = a; evidence.push('alternative state matched: ' + (a.stateType || (a.requiredEvidence && a.requiredEvidence[0] && a.requiredEvidence[0].expect) || 'alt')); break; }
    }
  }

  const conf = ok ? (c.confidence || 0.85) : 0.5;
  return { success: ok, confidence: conf, evidence, logic: c.evidenceLogic, passed, total: clauses.length, forbiddenHit: null, alternativesMatched: altMatched };
}

module.exports = {
  STATE_TYPES, ACTION_TO_STATE, DERIVABLE, STATE_BY_OBJECTIVE,
  deriveContract, contractFromObjective, legacyToContract, normalizeContract, validateContract, evaluateContract,
};
