'use strict';

/**
 * PHASE 17-A / P0-B —— Diagnosis → Runtime Decision Contract（最小决策契约）。
 *
 * 实证（真实站点 E2E 第 3 轮）：LLM 诊断已经**正确**说出失败原因
 *   「注册流程可能分步，第一步只要工作邮箱，密码框尚未出现在页面上」（confidence 0.95），
 * 但 Runtime 完全没消费这句话 —— 仍按原计划 fill password：
 *     fill password → ELEMENT_NOT_FOUND → retry → repair → retry → … → 473s FAILED。
 * 根因不是「模型不知道」，而是**诊断只有一个消费口**（选修复策略），
 * runtime 的动作策略层（下一步做什么）从来不读诊断。
 *
 * 本模块只做三件事，不重新设计 Agent：
 *   1. 把诊断（确定性 failureDiagnoser 或 LLM diagnosisEngine）解析成结构化 Decision；
 *   2. 给出该 Decision 对应的 Runtime Action Policy（要不要 BLOCK 当前动作）；
 *   3. 由 runtime 在「执行动作之前」真正执行这个 policy。
 *
 * 红线：
 *   - Diagnosis 不是 Verification：只能改「下一步动作 / 动作策略」，
 *     绝不能直接产出 SUCCESS，绝不动 success definition 与 verification 语义。
 *   - 观察为空时**不产出**结论（C105 教训：空集 ≠ 不存在）。
 *   - 不做任何站点特例。
 */

const semanticResolver = require('./semanticResolver');
const credentialAuthorization = require('./credentialAuthorization');

// ── 决策状态（最小集合）──
const STATES = {
  TARGET_NOT_PRESENT_YET: 'TARGET_NOT_PRESENT_YET',
  MULTI_STEP_FORM: 'MULTI_STEP_FORM',
  NAVIGATION_IN_PROGRESS: 'NAVIGATION_IN_PROGRESS',
  CROSS_ORIGIN_DRIFT: 'CROSS_ORIGIN_DRIFT',
  SECURITY_CHALLENGE: 'SECURITY_CHALLENGE',
  TARGET_STALE: 'TARGET_STALE',
};

// ── 状态 → Runtime Action Policy ──
//   block      是否阻止「同一目标」的当前动作
//   require    Runtime 必须先完成的动作
//   allowAdvance 允许用「分步表单推进」（F15）去创造目标出现的条件
//   maxRepeats 同一 blockedKey 允许重复触发的上限（超过即停止重试/repair，交人）
//   escalate   直接升级人工（不再 repair）
//   noRepair   不进入修复编排
const POLICY = {
  TARGET_NOT_PRESENT_YET: { block: true, require: 'REOBSERVE_AFTER_SUBMIT', allowAdvance: true, maxRepeats: 1, escalate: false, noRepair: false },
  MULTI_STEP_FORM: { block: true, require: 'REOBSERVE_AFTER_SUBMIT', allowAdvance: true, maxRepeats: 1, escalate: false, noRepair: false },
  NAVIGATION_IN_PROGRESS: { block: true, require: 'WAIT_AND_REOBSERVE', allowAdvance: false, maxRepeats: 2, escalate: false, noRepair: false },
  CROSS_ORIGIN_DRIFT: { block: true, require: 'REAUTH_CONTEXT', allowAdvance: false, maxRepeats: 0, escalate: true, noRepair: true, credentialOnly: true },
  SECURITY_CHALLENGE: { block: true, require: 'HUMAN', allowAdvance: false, maxRepeats: 0, escalate: true, noRepair: true },
  TARGET_STALE: { block: false, require: 'FRESH_OBSERVE_AND_REGROUND', allowAdvance: true, maxRepeats: 2, escalate: false, noRepair: false },
};

const STATE_ALIASES = {
  target_not_present_yet: STATES.TARGET_NOT_PRESENT_YET,
  multi_step_form: STATES.MULTI_STEP_FORM,
  navigation_in_progress: STATES.NAVIGATION_IN_PROGRESS,
  cross_origin_drift: STATES.CROSS_ORIGIN_DRIFT,
  security_challenge: STATES.SECURITY_CHALLENGE,
  target_stale: STATES.TARGET_STALE,
};

function normalizeState(v) {
  if (!v || typeof v !== 'string') return null;
  const k = v.trim();
  if (STATES[k]) return STATES[k];
  const low = k.toLowerCase();
  if (STATE_ALIASES[low]) return STATE_ALIASES[low];
  return null;
}

function policyOf(state) {
  return POLICY[state] || null;
}

/** 动作阻塞键：`type:target`，target 取 field > semantic > selector（与 F13 同口径）。 */
function blockKeyOf(action) {
  const a = action || {};
  const t = a.target || {};
  const target = String(t.field || t.semantic || t.selector || t.role || '');
  return String(a.type || '?').toLowerCase() + ':' + target.toLowerCase();
}

function hostOf(url) {
  if (!url || typeof url !== 'string') return null;
  try { return new URL(url).hostname.toLowerCase(); } catch (e) { return null; }
}

// ⚠️ 字段口径必须对齐真实 observation（COLLECT_JS 输出的元素结构）：
//   { id, role, tag, type, name, ..., visible, bbox, boundingBox, ... }
// C107 B 类缺陷实证（两处同时踩坑，导致诊断「永远不下结论」）：
//   ① 初版读 el.rect   → 真实结构是 bbox/boundingBox（见 geomOf）
//   ② 初版读 el.tagName → 真实结构是 el.tag
// 两者叠加的后果：真实页面上 inputs 恒为 0 → derive 判定「观察太贫瘠」直接 return null
// → Runtime 拿不到任何决策 → 照样机械重放 fill password。**契约对齐是这里唯一的正确解**，
// 不能靠放宽守卫（放宽会引入误判风险）。

/** 元素 tag（兼容 tagName，二者取其一）。 */
function tagOf(el) {
  const e = el || {};
  return String(e.tag || e.tagName || '').toLowerCase();
}

function isInputLike(el) {
  const tag = tagOf(el);
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  const role = String((el && el.role) || '').toLowerCase();
  return role === 'textbox' || role === 'combobox';
}

// 推进控件（结构过滤，与 F15 同口径：只有可点的控件才算，输入框/文本域一律不算）
function isAdvanceLike(el) {
  const tag = tagOf(el);
  const role = String((el && el.role) || '').toLowerCase();
  if (tag === 'input') {
    const type = String((el && el.type) || '').toLowerCase();
    return type === 'submit' || type === 'button' || type === 'image';
  }
  return tag === 'button' || tag === 'a' || role === 'button' || role === 'link';
}

// 元素几何：真实 observation（COLLECT_JS）暴露的是 `bbox` / `boundingBox`（{x,y,w,h}），
// **不是** `rect`。C107 B 类缺陷实证：初版只读 el.rect → 真实页面上所有元素都判为「不可见」
// → derive 的「页面连一个输入框都没有」守卫恒真 → 诊断永远不下结论
// → Runtime 得不到决策 → 机械重放 fill password（4 次实证）。
// 字段口径与 semanticResolver 的可操作性守卫（F7 零面积）严格对齐，避免两处判据漂移。
function geomOf(el) {
  const e = el || {};
  return e.bbox || e.boundingBox || e.rect || null;
}

function isVisibleEnough(el) {
  const g = geomOf(el);
  if (!g) return false;
  const w = Number(g.w != null ? g.w : g.width);
  const h = Number(g.h != null ? g.h : g.height);
  return w > 0 && h > 0;
}

/**
 * 从 LLM 诊断（diagnosisSchema 扩展字段）解析 Decision。
 * 兼容：老格式无 state 字段时返回 null（不制造结论）。
 */
function fromLLM(diagnosis) {
  if (!diagnosis || typeof diagnosis !== 'object') return null;
  const state = normalizeState(diagnosis.state || diagnosis.decisionState || diagnosis.decision);
  if (!state) return null;
  const blocked = Array.isArray(diagnosis.blockedActions) ? diagnosis.blockedActions : null;
  const decision = {
    state,
    blockedActions: (blocked || []).map((x) => String(x || '').toLowerCase()).filter(Boolean),
    currentStep: diagnosis.currentStep ? String(diagnosis.currentStep) : null,
    required: diagnosis.required ? String(diagnosis.required) : (policyOf(state) || {}).require || null,
    confidence: typeof diagnosis.confidence === 'number' ? diagnosis.confidence : null,
    source: 'llm',
    evidence: Array.isArray(diagnosis.evidence) ? diagnosis.evidence.slice(0, 5) : [],
    at: Date.now(),
  };
  return decision;
}

/**
 * 确定性推导 Decision（失败现场 → 结论）。
 * 只在证据充分时产出结论；证据不足返回 null（宁可让既有链路按原样重试）。
 *
 * @param {object} opts { error, observation, action, pageUrl, targetUrl, challenge, step }
 */
function derive(opts) {
  const o = opts || {};
  const observation = o.observation;
  const action = o.action || (o.step && o.step.action) || null;
  const errCode = String((o.error && o.error.code) || '');

  // 挑战页：STOP（不 repair / 不 retry / 不 reload loop）
  if (o.challenge && (o.challenge.blocked || o.challenge.challenge)) {
    return {
      state: STATES.SECURITY_CHALLENGE, blockedActions: action ? [blockKeyOf(action)] : [],
      currentStep: null, required: 'HUMAN', confidence: 0.9, source: 'deterministic',
      evidence: ['页面判定为人机验证/反爬挑战；不解题、不绕过'], at: Date.now(),
    };
  }

  // 跨域漂移：页面已不在目标 host。
  // 只阻塞**凭据类**动作：联盟/跳转链路里 host 漂移是常态，普通动作照常执行 ——
  // 把普通动作一起挡住会让合法流程直接死掉（这不是安全边界，是误伤）。
  const ph = hostOf(o.pageUrl || (observation && observation.url));
  const th = hostOf(o.targetUrl);
  if (ph && th && ph !== th) {
    const cred = credentialAuthorization.isCredentialAction(action);
    return {
      state: STATES.CROSS_ORIGIN_DRIFT,
      blockedActions: cred && action ? [blockKeyOf(action)] : [],
      credentialOnly: true,
      currentStep: null,
      required: 'REAUTH_CONTEXT', confidence: 0.8, source: 'deterministic',
      evidence: ['页面 host=' + ph + ' 与任务目标 host=' + th + ' 不一致'
        + (cred ? '；凭据类动作需重新检查授权上下文' : '；非凭据动作不受影响')],
      at: Date.now(),
    };
  }

  const isNotFound = errCode === 'ELEMENT_NOT_FOUND' || errCode === 'ELEMENT_NOT_INTERACTABLE';
  const isStale = errCode === 'ELEMENT_CHANGED' || errCode === 'SELECTOR_STALE' || errCode === 'OBSERVATION_FAILED';

  // 空观察/观察失败：不产出任何结论（C105 教训：空集 ≠ 不存在）
  if (!observation || !Array.isArray(observation.elements) || !observation.elements.length) return null;

  // 导航进行中：等待 + 重新观察，禁止继续 fill/click。
  // 刻意只在「确实没找到元素」时成立 —— 网络 pending 是常态，凭它单独拦动作会误伤正常流程。
  if (isNotFound && observation.networkState === 'pending') {
    return {
      state: STATES.NAVIGATION_IN_PROGRESS, blockedActions: action ? [blockKeyOf(action)] : [],
      currentStep: null, required: 'WAIT_AND_REOBSERVE', confidence: 0.7, source: 'deterministic',
      evidence: ['网络仍有阻塞请求未完成'], at: Date.now(),
    };
  }

  if (isStale && action) {
    return {
      state: STATES.TARGET_STALE, blockedActions: [], currentStep: null,
      required: 'FRESH_OBSERVE_AND_REGROUND', confidence: 0.6, source: 'deterministic',
      evidence: ['目标定位已失效（' + errCode + '），需重新观察并重新接地'], at: Date.now(),
    };
  }

  if (!isNotFound || !action || !action.target) return null;

  // 目标在当前观察中真的不可解析？
  let resolvable = null;
  try {
    const cands = semanticResolver.resolve(action.target, observation);
    resolvable = !!(cands && cands.length);
  } catch (e) {
    return null; // 解析异常：不下结论
  }
  if (resolvable) return null; // 页面上能定位到 → 不是「尚未出现」，交给既有链路

  const els = observation.elements;
  const inputs = els.filter((el) => isInputLike(el) && isVisibleEnough(el));
  if (!inputs.length) return null; // 页面连一个输入框都没有：观察太贫瘠，不下结论

  const advances = els.filter((el) => isAdvanceLike(el) && isVisibleEnough(el));
  const targetKey = String(action.target.field || action.target.semantic || '').toLowerCase();
  const looksLaterStep = /password|passwd|pwd|confirm|card|cvv/.test(targetKey);
  const multiStep = advances.length > 0 || (looksLaterStep && inputs.length > 0);

  return {
    state: multiStep ? STATES.MULTI_STEP_FORM : STATES.TARGET_NOT_PRESENT_YET,
    blockedActions: [blockKeyOf(action)],
    currentStep: null,
    required: 'REOBSERVE_AFTER_SUBMIT',
    confidence: multiStep ? 0.75 : 0.6,
    source: 'deterministic',
    evidence: [
      '错误码=' + errCode,
      '目标 ' + (action.target.field || action.target.semantic || '?') + ' 在当前观察中不可定位',
      '页面存在可见输入框 ' + inputs.length + ' 个' + (advances.length ? '，存在推进控件 ' + advances.length + ' 个' : ''),
    ],
    at: Date.now(),
  };
}

/** 该动作是否被这条 Decision 明确阻塞。支持 `type:target` / `type:*` / `*:target` 三种写法。 */
function isActionBlocked(decision, action) {
  if (!decision || !action) return false;
  const pol = policyOf(decision.state);
  if (!pol || !pol.block) return false;
  // 只对凭据类动作生效的决策（跨域漂移）：非凭据动作不拦
  if (decision.credentialOnly && !credentialAuthorization.isCredentialAction(action)) return false;
  const blocked = Array.isArray(decision.blockedActions) ? decision.blockedActions : [];
  if (!blocked.length) return true; // 未列具体目标 = 阻塞当前全部动作
  const key = blockKeyOf(action);
  const type = String(action.type || '?').toLowerCase();
  const target = key.slice(type.length + 1);
  return blocked.some((b) => {
    if (b === key) return true;
    if (b === type + ':*') return true;
    if (b === '*:' + target && target) return true;
    return false;
  });
}

/**
 * 求 Runtime Action Policy。
 * @param {object} opts { decision, action }
 * @returns {{blocked:boolean, state:string|null, require:string|null, escalate:boolean, noRepair:boolean, allowAdvance:boolean, maxRepeats:number, reason:string}}
 */
function evaluate(opts) {
  const o = opts || {};
  const decision = o.decision || null;
  const action = o.action || null;
  if (!decision) {
    return { blocked: false, state: null, require: null, escalate: false, noRepair: false, allowAdvance: true, maxRepeats: 99, reason: 'no_decision' };
  }
  const pol = policyOf(decision.state) || { block: false, require: null, allowAdvance: true, maxRepeats: 99, escalate: false, noRepair: false };
  const blocked = isActionBlocked(decision, action);
  // CROSS_ORIGIN_DRIFT 只对凭据类动作升级人工（普通漂移不该把任务打死）
  let escalate = !!pol.escalate && blocked;
  if (escalate && pol.credentialOnly) {
    try {
      const cred = require('./credentialAuthorization');
      escalate = cred.isCredentialAction(action);
    } catch (e) { escalate = false; }
  }
  return {
    blocked,
    state: decision.state,
    require: pol.require,
    escalate,
    noRepair: !!pol.noRepair && blocked,
    allowAdvance: !!pol.allowAdvance,
    maxRepeats: typeof pol.maxRepeats === 'number' ? pol.maxRepeats : 99,
    reason: blocked ? ('diagnosis_' + String(decision.state).toLowerCase()) : 'not_blocked',
    confidence: decision.confidence == null ? null : decision.confidence,
    evidence: decision.evidence || [],
  };
}

/** 目标在当前观察中是否可解析（供 Runtime 做「重新观察后目标是否已出现」的判定）。 */
function targetResolvable(action, observation) {
  if (!action || !action.target) return false;
  if (!observation || !Array.isArray(observation.elements) || !observation.elements.length) return false;
  try {
    const cands = semanticResolver.resolve(action.target, observation);
    return !!(cands && cands.length);
  } catch (e) {
    return false;
  }
}

/** 同一决策状态下「同一动作被重复阻塞」是否已达上限。 */
function repeatsExhausted(count, policy) {
  const max = policy && typeof policy.maxRepeats === 'number' ? policy.maxRepeats : 99;
  return (count || 0) > max;
}

module.exports = {
  STATES,
  POLICY,
  normalizeState,
  policyOf,
  blockKeyOf,
  fromLLM,
  derive,
  isActionBlocked,
  targetResolvable,
  evaluate,
  repeatsExhausted,
};
