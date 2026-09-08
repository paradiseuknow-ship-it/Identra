'use strict';

// Verification Intelligence Layer (VIL) — v0.2.1。
//
// 职责（Phase 10.3）：在 verification.js 判定失败后，回答四个问题：
//   1) 为什么失败（failureType 分类）？
//   2) 是否应该等待（WAIT）？
//   3) 是否需要重新观察（RETRY_VERIFY）？
//   4) 是否需要重新执行（RE_EXECUTE）？
//
// 设计红线：
//   - 不替代 verification.js。verification.js 保留最终判定权（标准不变）。
//   - VIL 只做「诊断 + 决策建议」，不自行宣布成功，不降低验证标准。
//   - 输出纯函数，无副作用，可单测、可回放。
//
// 输入：
//   { beforeObservation, afterObservation, expectedVerification, actionResult }
// 输出：
//   { decision, failureType, confidence, evidence }

const semanticResolver = require('../semanticResolver');

// failureType 枚举
const FAILURE_TYPES = {
  EVENTUAL_CONSISTENCY: 'EVENTUAL_CONSISTENCY', // 动作成功，页面异步状态延迟
  OBSERVATION_DELAY: 'OBSERVATION_DELAY',       // 观察过早，DOM/文本尚未出现
  VERIFICATION_TOO_STRICT: 'VERIFICATION_TOO_STRICT', // 条件无法匹配真实成功状态
  ACTION_REAL_FAILURE: 'ACTION_REAL_FAILURE',   // 动作本身失败
  STATE_UNKNOWN: 'STATE_UNKNOWN',               // 证据不足，无法判断
  DOM_CHANGED: 'DOM_CHANGED',                   // 原目标状态/结构变化
  SUBMIT_RESULT_UNKNOWN: 'SUBMIT_RESULT_UNKNOWN', // 提交动作成功但结果落点未确认（区别于泛化 STATE_UNKNOWN）
  ASYNC_PENDING: 'ASYNC_PENDING',               // 动作成功、页面稳定、验证未通过，但存在「异步处理中」证据（结果未定，非成功非失败）
};

// decision 枚举
const DECISIONS = {
  SUCCESS: 'SUCCESS',
  WAIT: 'WAIT',             // 等异步稳定后重观察（不重执行）
  RECHECK_OBSERVATION: 'RECHECK_OBSERVATION', // 重新观察（不重执行），用于证据不足时的再确认
  RETRY_VERIFY: 'RETRY_VERIFY', // 重新观察 + 重新验证（不重执行）
  RE_EXECUTE: 'RE_EXECUTE', // 重新执行原动作
  HUMAN_ESCALATE: 'HUMAN_ESCALATE',
};

// 哪些 decision 会进入「重观察 + 重验证」窗口（WAIT / RECHECK / RETRY_VERIFY 都不重执行原动作）。
// 用于 runtime 判断：是否运行 Observation Window 尝试时序/观察恢复。
function isReobservableDecision(decision) {
  return decision === DECISIONS.WAIT ||
    decision === DECISIONS.RECHECK_OBSERVATION ||
    decision === DECISIONS.RETRY_VERIFY;
}

// P3（Phase 2 Evidence Aggregation）：纯函数证据聚合层。
//
// 职责：把「前后两次观察 + 可选验证窗口」转成一份可解释加分（evidenceScore）。
// 严格限制：
//   - 不判定 SUCCESS，不修改任何既有 failureType / decision / repairAction。
//   - 只读取观察事实字段（previousObservationDiff / capturedAt / url），不引入 mock。
//   - 加权规则完全可解释（见下方 add 权重），仅做「证据多寡」的量化，供未来验证层使用。
//
// 输入：
//   beforeObservation, afterObservation：观察快照（含 previousObservationDiff / capturedAt / url）
//   verificationWindow（可选）：调用方传入的窗口重观察标记 { reobserved | observed | reObserve | verified }
// 输出：
//   { evidenceScore:number, evidenceReasons:[], evidenceSignals:{} }
function aggregateEvidence(beforeObservation, afterObservation, verificationWindow) {
  const before = beforeObservation || {};
  const after = afterObservation || {};
  const diff = after.previousObservationDiff || {};

  const toTs = (v) => {
    if (!v) return 0;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  };
  const beforeTs = toTs(before.capturedAt);
  const afterTs = toTs(after.capturedAt);

  // 信号（仅基于观察事实，不臆测 success）
  const urlChanged = !!(diff.urlChanged || (before.url && after.url && before.url !== after.url));
  const keyTextChanged = !!(diff.keyTextChanged || diff.textChanged);
  const elementStateChanged = !!diff.elementStateChanged;
  const pageStructureChanged = !!diff.pageStructureChanged;
  // freshObservation：after 观察较 before 更新（或 before 无时间戳），即是一份较新的观察。
  const freshObservation = !!(afterTs && (!beforeTs || afterTs > beforeTs));
  const observationAge = afterTs ? Math.max(0, Date.now() - afterTs) : null;
  // verificationWindowObserved：调用方传入的窗口重观察标记（可选；当前 runtime 尚未接入）。
  let verificationWindowObserved = false;
  if (verificationWindow) {
    verificationWindowObserved = !!(
      verificationWindow.reobserved ||
      verificationWindow.observed ||
      verificationWindow.reObserve ||
      verificationWindow.verified
    );
  }

  const signals = {
    urlChanged,
    keyTextChanged,
    elementStateChanged,
    pageStructureChanged,
    freshObservation,
    observationAge,
    verificationWindowObserved,
  };

  // 可解释加权：每个信号独立加分，不硬编码 SUCCESS。权重总和 1.00，仅防御性 clamp 到 [0,1]。
  const reasons = [];
  let score = 0;
  const add = (cond, w, reason) => {
    if (cond) { score += w; reasons.push(reason); }
  };
  add(keyTextChanged, 0.35, '关键文本出现/变化（+0.35）');
  add(urlChanged, 0.25, 'URL 进入变化/目标态（+0.25）');
  add(elementStateChanged, 0.15, '关键元素状态变化（+0.15）');
  add(pageStructureChanged, 0.10, '页面结构变化（+0.10）');
  add(freshObservation, 0.10, 'Fresh Observation（较新观察，+0.10）');
  add(verificationWindowObserved, 0.05, 'Verification Window 重新观察（+0.05）');
  if (score > 1) score = 1;
  if (score < 0) score = 0;

  return {
    evidenceScore: score,
    evidenceReasons: reasons,
    evidenceSignals: signals,
  };
}

// P4（Phase 2 ASYNC_PENDING）：纯函数，仅读 observation，识别「异步处理中」信号。
// 严格限制：不访问网络、不调用浏览器、不判定成功、不引入 mock。
// 最小关键词库，仅基于已有观察字段（visibleText / textSummary / url / elements）。
const ASYNC_TEXT_KEYWORDS = ['processing', 'pending', 'waiting', 'verifying', 'under review', 'generating', 'uploading'];
const ASYNC_URL_SEGMENTS = ['/processing', '/wait', '/pending'];

function detectAsyncPending(beforeObservation, afterObservation) {
  const after = afterObservation || {};
  const signals = [];
  const text = ((after.visibleText || '') + ' ' + (after.textSummary || '')).toLowerCase();
  const url = (after.url || '').toLowerCase();
  const elements = after.elements || [];

  // 文本信号：出现处理中/等待中等关键词
  const hitText = ASYNC_TEXT_KEYWORDS.filter((k) => text.includes(k));
  if (hitText.length) signals.push('processing_text:' + hitText.join('|'));

  // URL 信号：处于处理/等待类路径
  const hitUrl = ASYNC_URL_SEGMENTS.some((s) => url.includes(s));
  if (hitUrl) signals.push('pending_url');

  // 状态信号：disabled submit button / loading spinner / progress indicator
  const statusHit = elements.some((e) => {
    const et = ((e.text || '') + ' ' + (e.semantic || '') + ' ' + (e.role || '')).toLowerCase();
    const disabled = !!(e.state && e.state.disabled);
    const isSubmit = /submit|confirm|pay|登录|提交/.test(et);
    const looksLoading = /loading|spinner|progress|loader|加载|处理中/.test(et);
    if (disabled && isSubmit) return true; // disabled submit button
    if (looksLoading) return true;        // loading spinner / progress indicator
    return false;
  });
  if (statusHit) signals.push('loading_indicator');

  if (!signals.length) {
    return { pending: false, signals: [], confidence: 0 };
  }
  // 可解释置信度：文本命中 0.6 基线，URL/状态各 +0.15，封顶 0.95。
  let confidence = 0.6;
  if (hitUrl) confidence += 0.15;
  if (statusHit) confidence += 0.15;
  if (confidence > 0.95) confidence = 0.95;
  return { pending: true, signals, confidence };
}

// 轻量：从观察结果判断「期望验证目标」是否真实存在（用于区分 TOO_STRICT vs UNKNOWN）
function expectedActuallyPresent(expectedVerification, afterObservation) {
  if (!expectedVerification || !afterObservation) return false;
  const type = expectedVerification.type;
  const expect = expectedVerification.expect;
  const text = (afterObservation.visibleText || afterObservation.textSummary || '').toLowerCase();
  const url = (afterObservation.url || '').toLowerCase();
  if (type === 'text_present' && expect) {
    return text.includes(String(expect).toLowerCase());
  }
  if (type === 'url_contains' && expect) {
    return url.includes(String(expect).toLowerCase());
  }
  if (type === 'element_present' && expect) {
    const pool = (afterObservation.elements || []).map((e) => [e.text, e.placeholder, e.ariaLabel, e.label, e.innerText, e.roleText].join(' ')).join(' ').toLowerCase();
    return pool.includes(String(expect).toLowerCase());
  }
  // businessState 契约：委托 businessStatePresent 做精准判定（B2 真实归因）
  if (expectedVerification.businessState) {
    return businessStatePresent(expectedVerification.businessState, afterObservation, null);
  }
  // 其它类型（login_state/page_change/action_success）不直接判断"存在性"
  return false;
}

// 判定单个业务态 clause 在 after 中是否真实存在（B2：精准归因 VERIFICATION_TOO_STRICT）。
function clausePresent(cl, after, before) {
  if (!cl || !cl.type) return false;
  const text = ((after.visibleText || after.textSummary || '') + ' ' + (after.roleText || '')).toLowerCase();
  const url = (after.url || '').toLowerCase();
  const els = after.elements || [];
  switch (cl.type) {
    case 'text_present': return !!cl.expect && text.includes(String(cl.expect).toLowerCase());
    case 'text_absent': return !cl.expect || !text.includes(String(cl.expect).toLowerCase());
    case 'url_contains': return !!cl.expect && url.includes(String(cl.expect).toLowerCase());
    case 'page_change': {
      const b = before || {};
      const bText = (b.visibleText || b.textSummary || '').toLowerCase();
      return (b.url && b.url !== url) || (bText && bText !== text);
    }
    case 'element_absent': {
      const t = cl.expect || '';
      return t ? semanticResolver.resolve(t, after).length === 0 : false;
    }
    case 'field_value': {
      const tgt = cl.target || cl.expect || '';
      const cands = tgt ? semanticResolver.resolve(tgt, after) : [];
      if (!cands.length) return false;
      const st = cands[0].el.state || {};
      if (st.sensitive) return Number(st.valueLength || 0) > 0;
      // C73 D3（vault 注入修正，与 verification.js 同语义）：空期望 = 期望值未知（凭据执行时
      // 注入）→ 退化为「已填写」验证；includes('') 恒真（假阳性）与硬 fail-closed（误杀 vault）
      // 都不对。期望未知时验证「写入发生」。
      const want = String(cl.expect || '').trim();
      const actual = String(st.value || '').trim();
      if (!want) return actual.length > 0;
      return actual.toLowerCase().includes(want.toLowerCase());
    }
    case 'field_checked': {
      const tgt = cl.target || cl.expect || '';
      const cands = tgt ? semanticResolver.resolve(tgt, after) : [];
      if (!cands.length) return false;
      const st = cands[0].el.state || {};
      const want = String(cl.expect || 'checked');
      const checked = !!st.checked;
      return (want === 'unchecked') ? !checked : checked;
    }
    default: return false;
  }
}

// 业务态契约是否在 after 中真实达成（按 evidenceLogic OR/AND 组合 requiredEvidence）。
function businessStatePresent(contract, after, before) {
  if (!contract || !after) return false;
  const clauses = contract.requiredEvidence || [];
  if (!clauses.length) return false;
  const logic = contract.evidenceLogic === 'OR' ? 'OR' : 'AND';
  let matched = 0;
  for (const cl of clauses) if (clausePresent(cl, after, before)) matched++;
  return logic === 'OR' ? matched > 0 : matched === clauses.length;
}

// B2：动作成功但目标字段为空（值未真正写入）→ 真实动作失败，应 RE_EXECUTE 而非 RECHECK。
function fieldExistsButEmpty(contract, after, action) {
  if (!contract || !action) return false;
  if (!['fill', 'select'].includes(action.type)) return false;
  const t = action.target || {};
  const tgt = t.semantic || t.field || t.text || '';
  if (!tgt) return false;
  const cands = semanticResolver.resolve(tgt, after);
  if (!cands.length) return false; // 元素都找不到 → 归 DOM_CHANGED 更合适
  const st = cands[0].el.state || {};
  if (st.sensitive) return Number(st.valueLength || 0) === 0;
  return !st.value || String(st.value).trim().length === 0;
}

// 支付/金融类动作（CRITICAL 子集，与 policy.js 保持一致）。验证失败时优先升级人工而非自主重试。
const SENSITIVE_TYPES = new Set(['purchase', 'payment', 'password_change', 'delete', 'update_account_settings', 'submit', 'login', 'logout']);

// 主分析函数（内部实现，外部统一经 analyze 包装以附加 verificationEvidence）
function _analyze({ beforeObservation, afterObservation, expectedVerification, actionResult, action } = {}) {
  const after = afterObservation || {};
  const before = beforeObservation || {};
  const actionOk = !!(actionResult && actionResult.success);
  const evidence = [];
  const loading = after.loadingState; // 'complete' | 'interactive' | 'loading' | undefined
  const net = after.networkState;     // 'idle' | 'pending' | undefined
  const diff = after.previousObservationDiff || {};
  const domChanged = !!diff.domChanged;
  // 敏感动作：CRITICAL 风险或命中敏感类型，验证失败时优先升级人工（避免自主重执行高风险动作）。
  const isSensitive = !!(action && (action.risk === 'CRITICAL' || SENSITIVE_TYPES.has(action.type)));

  // 1) 动作本身失败 → 真实失败
  if (!actionOk) {
    evidence.push('动作执行返回失败（actionResult.success=false），判定为真实动作失败');
    return {
      decision: DECISIONS.RE_EXECUTE,
      failureType: FAILURE_TYPES.ACTION_REAL_FAILURE,
      confidence: 0.9,
      evidence,
    };
  }

  // 2) 网络仍在进行 → 最终一致性（等）
  if (net === 'pending') {
    evidence.push('观察时刻仍有未完成网络请求（networkState=pending），判定为异步一致性延迟');
    return {
      decision: DECISIONS.WAIT,
      failureType: FAILURE_TYPES.EVENTUAL_CONSISTENCY,
      confidence: 0.8,
      evidence,
    };
  }

  // 3) 页面仍在加载 → 观察过早
  if (loading && loading !== 'complete') {
    evidence.push('页面加载状态=' + loading + '（非 complete），观察可能过早，建议重观察');
    return {
      decision: DECISIONS.RETRY_VERIFY,
      failureType: FAILURE_TYPES.OBSERVATION_DELAY,
      confidence: 0.78,
      evidence,
    };
  }

  // 4) 页面已稳定，动作成功，但验证失败 → 进入「结构/验证」判别
  // 4a) DOM 结构相比动作前发生显著变化 → 结构变化
  // 专项 §四：DOM_CHANGED 绝不≡SUCCESS，只表示「页面已变化」。正确闭环是
  // ACTION → DOM_CHANGED → Fresh Observation → Verification Contract → Re-evaluate，
  // 而非「直接重执行原动作 / 直接判 VERIFY_FAILED」。故此处返回 RECHECK/RETRY 类决策，
  // 让 runtime 进入内联 Observation Window（真实重新 capture observation + 重新验证，不重执行原动作）。
  // 仅当窗口内的 Fresh Observation 仍验证失败，才由上层 repair 兜底（含语义重定位）。
  if (domChanged) {
    evidence.push('动作后 DOM 指纹相对动作前发生显著变化（domChanged=true）→ 进入 Fresh Observation + Re-Verification（不重执行原动作）');
    return {
      decision: DECISIONS.RETRY_VERIFY,
      failureType: FAILURE_TYPES.DOM_CHANGED,
      confidence: 0.72,
      evidence,
    };
  }

  // 4b) 期望目标其实存在（只是验证规则未匹配）→ 验证过严
  const targetPresent = expectedVerification && expectedVerification.businessState
    ? businessStatePresent(expectedVerification.businessState, after, before)
    : expectedActuallyPresent(expectedVerification, after);
  if (targetPresent) {
    evidence.push('期望业务结果在观察中实际存在，但 verification 规则未匹配，判定为验证过严（可尝试替代状态判定）');
    return {
      decision: DECISIONS.RETRY_VERIFY,
      failureType: FAILURE_TYPES.VERIFICATION_TOO_STRICT,
      confidence: 0.68,
      evidence,
    };
  }

  // 4c) 稳定、动作成功、目标不存在、结构未变 → 证据不足，交由人工
  //     特殊：login_state 这类脆弱正则易误判，归为 TOO_STRICT 给 repair 一次替代机会，而非直接升级。
  if (expectedVerification && expectedVerification.type === 'login_state') {
    evidence.push('login_state 正则脆弱且未匹配，归为验证过严，交由 repair 替代态判定');
    return {
      decision: DECISIONS.RETRY_VERIFY,
      failureType: FAILURE_TYPES.VERIFICATION_TOO_STRICT,
      confidence: 0.6,
      evidence,
    };
  }

  evidence.push('页面稳定、动作成功、目标未观察到、结构未变 —— 证据不足以判定成功');

  // P4（Phase 2 ASYNC_PENDING）：页面稳定、动作成功、验证未通过，但存在「异步处理中」证据 →
  // 标记为 ASYNC_PENDING（业务结果尚未确定，但非失败、非成功）。不改变既有 SUCCESS/FAILURE 优先级，
  // 仅在「无成功、无真实失败」之后、UNKNOWN 之前插入此中间态，用于提高验证解释能力。
  // 安全：敏感动作（payment/financial/security）即使检测到 pending 也只升级人工（HUMAN_ESCALATE），
  // 绝不自动继续操作 / 重提交 / 付款。
  const asyncPending = detectAsyncPending(before, after);
  if (asyncPending.pending) {
    evidence.push('观察到异步处理中证据（' + asyncPending.signals.join('、') + '）—— 业务结果尚未确定，标记 ASYNC_PENDING');
    if (isSensitive) {
      return { decision: DECISIONS.HUMAN_ESCALATE, failureType: FAILURE_TYPES.ASYNC_PENDING, confidence: asyncPending.confidence, evidence };
    }
    return { decision: DECISIONS.RECHECK_OBSERVATION, failureType: FAILURE_TYPES.ASYNC_PENDING, confidence: asyncPending.confidence, evidence };
  }

  // 提交类动作：动作成功、页面稳定、业务态未确认、结构未变 → 标记为「提交结果未知」（SUBMIT_RESULT_UNKNOWN），
  // 区别于泛化 STATE_UNKNOWN。交由 repair / 升级层「查询结果落点」（URL/文本/后端态）而非盲目重提交。
  // 安全：敏感动作仍走 HUMAN_ESCALATE（不自主重提交），仅 failureType 更精确。
  if (action && action.type === 'submit') {
    evidence.push('提交动作成功、页面稳定、业务态未确认 —— 提交结果未知，需查询结果落点（URL/文本/后端态）');
    if (isSensitive) {
      return { decision: DECISIONS.HUMAN_ESCALATE, failureType: FAILURE_TYPES.SUBMIT_RESULT_UNKNOWN, confidence: 0.55, evidence };
    }
    return { decision: DECISIONS.RECHECK_OBSERVATION, failureType: FAILURE_TYPES.SUBMIT_RESULT_UNKNOWN, confidence: 0.5, evidence };
  }

  // B2：动作成功但目标字段为空（值未真正写入）→ 真实动作失败，应重执行而非重观察
  if (fieldExistsButEmpty(expectedVerification && expectedVerification.businessState, after, action)) {
    evidence.push('动作成功但目标字段为空（值未真正写入），判定为真实动作失败（需重执行）');
    return {
      decision: DECISIONS.RE_EXECUTE,
      failureType: FAILURE_TYPES.ACTION_REAL_FAILURE,
      confidence: 0.8,
      evidence,
    };
  }
  // 敏感/关键动作：不自主重试，直接升级人工（由人工判断是否重执行）。
  if (isSensitive) {
    evidence.push('动作属于敏感/关键类型，验证失败且证据不足，升级人工而非自主重执行');
    return {
      decision: DECISIONS.HUMAN_ESCALATE,
      failureType: FAILURE_TYPES.STATE_UNKNOWN,
      confidence: 0.55,
      evidence,
    };
  }
  // 设计红线（Phase 10.7）：STATE_UNKNOWN ≠ ACTION_REAL_FAILURE，不能直接放弃。
  // 先 RECHECK_OBSERVATION（重观察 + 重验证，不重执行），若窗口内仍无证据，再由上层升级人工。
  return {
    decision: DECISIONS.RECHECK_OBSERVATION,
    failureType: FAILURE_TYPES.STATE_UNKNOWN,
    confidence: 0.5,
    evidence,
  };
}

// 对外统一入口：在既有 _analyze 决策（failureType/decision 完全不变）之上，
// 仅附加 verificationEvidence（证据聚合），不修改任何既有返回字段。
function analyze(opts) {
  const result = _analyze(opts || {});
  result.verificationEvidence = aggregateEvidence(
    (opts || {}).beforeObservation,
    (opts || {}).afterObservation,
    (opts || {}).verificationWindow
  );
  return result;
}

module.exports = { analyze, aggregateEvidence, detectAsyncPending, FAILURE_TYPES, DECISIONS, isReobservableDecision };
