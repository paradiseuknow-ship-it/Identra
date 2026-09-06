'use strict';

// 策略：未知错误 → 原动作重试。
//
// 与 verify.js 共用同一张「retryPolicy → 前置动作」表：UNKNOWN 只是说明
// errorClassifier 没认出错误码，不代表没有证据 —— 网络层往往已经给出根因
// （例如 401 / 429 / 重复记录）。有诊断就按诊断走，没有诊断才退回原样重试。

const { PRE_ACTIONS_BY_POLICY } = require('../../diagnosis/failureDiagnoser');

function getPreActions(attempts, ctx = {}) {
  const d = ctx.diagnosis;
  const policy = d && d.retryPolicy;
  if (!policy) return [];
  return PRE_ACTIONS_BY_POLICY[policy] || [];
}

module.exports = { getPreActions };
