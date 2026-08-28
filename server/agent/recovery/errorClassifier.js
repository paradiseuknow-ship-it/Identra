'use strict';

// Error Classifier（v2）：错误 → { type, confidence, evidence[] }。
// 提供可信度供 AI Diagnosis 决策。只做分类，不做推理。

// 统一错误类别字典（分类层 single source of truth）。
// 该并集须覆盖 repairPlanner.STRATEGY_FOR_CATEGORY 与 diagnosisSchema.DIAGNOSIS_CATEGORIES
// 的全部 key，否则未覆盖 key 会被 repairPlanner 兜底为 GENERIC_RETRY（见 repairPlanner.js）。
const RECOVERY_CATEGORIES = [
  'ELEMENT_NOT_FOUND', 'ELEMENT_NOT_INTERACTABLE', 'TIMEOUT', 'NAVIGATION_FAILED',
  'NETWORK_ERROR', 'VERIFICATION_FAILED', 'PAGE_NOT_READY', 'CREDENTIAL_MISSING',
  'APPROVAL_REQUIRED', 'BROWSER_CRASH', 'SERVER_ERROR', 'UNKNOWN',
  // 以下类别由 diagnosis 层（含 observation 全文）升级产出，classifier 确定性层不产出，
  // 但在此登记以保持全局类别字典闭合：ELEMENT_CHANGED / OBSTRUCTION / SESSION_EXPIRED / HTTP_FORBIDDEN
  // Phase 2 P5：验证层（VIL）失败类型一并登记，使全局类别字典闭合（recovery routing 仍由 verifyFailed 按其 taxonomy 处理，
  // 不经 errorClassifier → STRATEGY_FOR_CATEGORY，故不触发自动 retry 策略变更）。
  'ASYNC_PENDING', 'SUBMIT_RESULT_UNKNOWN', 'DOM_CHANGED', 'EVENTUAL_CONSISTENCY',
  'OBSERVATION_DELAY', 'VERIFICATION_TOO_STRICT', 'STATE_UNKNOWN', 'ACTION_REAL_FAILURE',
];

const HIGH = 0.95, MED = 0.85, LOW = 0.7;

function classify(error, ctx = {}) {
  const code = error && error.code;
  const msg = String((error && error.message) || '').toLowerCase();
  const url = (ctx && ctx.url) || '';
  const evidence = [];
  const result = (type, confidence) => ({ type, confidence, evidence });

  if (code === 'ELEMENT_NOT_FOUND') { evidence.push('定位失败: 目标元素不存在'); return result('ELEMENT_NOT_FOUND', HIGH); }
  if (code === 'ELEMENT_NOT_INTERACTABLE') { evidence.push('元素存在但不可交互（遮挡/隐藏/禁用）'); return result('ELEMENT_NOT_INTERACTABLE', HIGH); }
  if (code === 'VERIFY_FAILED') { evidence.push('验证条件未满足'); return result('VERIFICATION_FAILED', HIGH); }
  if (code === 'NO_VALUE') { evidence.push('凭据引用无可用值'); return result('CREDENTIAL_MISSING', HIGH); }
  if (code === 'ACTION_REQUIRES_APPROVAL') { evidence.push('Policy 要求人工审批'); return result('APPROVAL_REQUIRED', HIGH); }
  if (code === 'PAGE_NOT_READY') { evidence.push('页面未就绪'); return result('PAGE_NOT_READY', HIGH); }
  if (code === 'BROWSER_CRASH' || code === 'BROWSER_CONTEXT_LOST' || /crash|killed|session closed|target closed|context lost|页面.*(关闭|崩溃)|渲染进程/i.test(msg)) {
    evidence.push('浏览器渲染进程/会话失效');
    return result('BROWSER_CRASH', HIGH);
  }

  if (/timeout|exceeded.*(ms|time)/i.test(msg)) {
    evidence.push('操作超过时限: ' + msg.slice(0, 80));
    return result('TIMEOUT', MED);
  }
  if (/net::err_(name_not_resolved|connection_refused|connection_reset|address_unreachable|connection_aborted|dns|timeout)/i.test(msg)) {
    evidence.push('网络层错误: ' + msg.slice(0, 80));
    return result('NETWORK_ERROR', MED);
  }
  if (/navigation|goto|failed to navigate/i.test(msg)) {
    evidence.push('导航失败: ' + msg.slice(0, 80));
    return result('NAVIGATION_FAILED', MED);
  }
  if (/403|forbidden|access denied/i.test(msg) || /403|forbidden/i.test(url)) {
    evidence.push('服务端返回禁止访问');
    return result('NAVIGATION_FAILED', LOW);
  }
  if (/500|502|503|504|bad gateway|internal server|server error/i.test(msg)) {
    evidence.push('服务端错误(5xx): ' + msg.slice(0, 80));
    return result('SERVER_ERROR', MED);
  }
  if (/not found|no element|locator.*not|missing element|unable to find/i.test(msg)) {
    evidence.push('元素缺失: ' + msg.slice(0, 80));
    return result('ELEMENT_NOT_FOUND', MED);
  }
  if (/not interactable|obscured|covered by|not visible|outside of/i.test(msg)) {
    evidence.push('元素被遮挡/不可交互');
    return result('ELEMENT_NOT_INTERACTABLE', MED);
  }

  evidence.push('未能匹配已知错误模式');
  return result('UNKNOWN', LOW);
}

// P5（Phase 2 ErrorClassifier 对齐）：VIL 验证层 failureType → 类别桥接纯函数。
// 仅做分类映射，不改动任何 retry / decision 语义；与 classify()（动作层 error.code 分类）互补。
// 置信度沿用 VIL analyze 的判定强度（仅作信息参考，不参与路由决策）。
const VIL_FAILURE_PROFILE = {
  ASYNC_PENDING:          { confidence: 0.8,  evidence: '异步处理中，业务结果尚未确定（非成功非失败）' },
  SUBMIT_RESULT_UNKNOWN:  { confidence: 0.75, evidence: '提交动作成功但结果落点未确认，需查询结果态' },
  DOM_CHANGED:            { confidence: 0.72, evidence: '动作后 DOM 显著变化，进入 Fresh Observation + Re-Verification' },
  EVENTUAL_CONSISTENCY:   { confidence: 0.8,  evidence: '异步一致性延迟，等待稳定后重观察' },
  OBSERVATION_DELAY:      { confidence: 0.78, evidence: '页面仍在加载，观察过早，建议重观察' },
  VERIFICATION_TOO_STRICT: { confidence: 0.68, evidence: '期望业务结果实际存在但验证规则未匹配' },
  STATE_UNKNOWN:          { confidence: 0.5,  evidence: '页面稳定、动作成功、目标未观察到、结构未变，证据不足' },
  ACTION_REAL_FAILURE:    { confidence: 0.9,  evidence: '动作执行返回失败' },
};

function classifyVerificationFailure(failureType, opts = {}) {
  const profile = VIL_FAILURE_PROFILE[failureType];
  if (!profile) {
    return { category: failureType || 'UNKNOWN', confidence: 0.4, evidence: ['未登记的验证层失败类型'], recognized: false };
  }
  const isSensitive = !!opts.isSensitive;
  return {
    category: failureType,
    confidence: profile.confidence,
    evidence: [profile.evidence + (isSensitive ? '（敏感动作：仅升级人工，不自动操作）' : '')],
    recognized: true,
    sensitive: isSensitive,
  };
}

module.exports = { classify, classifyVerificationFailure, RECOVERY_CATEGORIES };
