'use strict';

// Phase 14.6 — Environment Readiness（三维度就绪框架）
//
// 边界（Phase 14 规格 §七）：
//   ✅ Environment Integrity：真实计算（复用 environmentIntegrity）
//   ✅ Payment Readiness / Recovery Confidence：框架与内部就绪项（credential availability、
//      billing metadata、checkpoint、retry budget——全部是系统内部状态，可真实判定）
//   ❌ 不给第三方风险做预测：禁止输出「Stripe Risk Score = 83」「WAF Acceptance = 91」。
//      3DS capability = UNKNOWN（诚实标注系统不知道的事），human approval = REQUIRED（设计边界）。

const { checkEnvironmentIntegrity } = require('./environmentIntegrity');

function environmentReadiness(snapshot) {
  const integrity = checkEnvironmentIntegrity(snapshot);
  return {
    dimension: 'ENVIRONMENT_INTEGRITY',
    status: integrity.status,
    checks: integrity.checks,
    reasons: integrity.reasons,
  };
}

// Payment Readiness：只盘点系统内部就绪项；3DS/风控=UNKNOWN，人工审批=REQUIRED（不可配置掉）
function paymentReadiness({ credentialRefs = [], billingMetadata = null } = {}) {
  return {
    dimension: 'PAYMENT_READINESS',
    credentialAvailability: credentialRefs.length ? 'READY' : 'MISSING',
    billingMetadata: billingMetadata ? 'READY' : 'MISSING',
    threeDSCapability: 'UNKNOWN', // 第三方风控行为系统不可预知——诚实标注
    humanApproval: 'REQUIRED',   // 设计边界：真实支付确认永不自动化
  };
}

// Recovery Confidence：恢复链路内部组件就绪盘点
function recoveryConfidence({ checkpointReady = false, credentialRefReady = false, retryBudget = 0 } = {}) {
  const s = (ok) => (ok ? 'READY' : 'MISSING');
  return {
    dimension: 'RECOVERY_CONFIDENCE',
    checkpoint: s(checkpointReady),
    credentialRef: s(credentialRefReady),
    retryBudget: retryBudget > 0 ? 'READY' : 'EXHAUSTED',
  };
}

// 汇总：三维度并列输出（规格 §七 的输出形态）
function environmentReadinessReport(snapshot, opts = {}) {
  return {
    environmentIntegrity: environmentReadiness(snapshot),
    paymentReadiness: paymentReadiness(opts.payment || {}),
    recoveryConfidence: recoveryConfidence(opts.recovery || {}),
    generatedAt: Date.now(),
    disclaimer: '本报告仅描述系统内部状态一致性；不对任何第三方（WAF/支付网关/风控）行为做预测。',
  };
}

module.exports = { environmentReadiness, paymentReadiness, recoveryConfidence, environmentReadinessReport };
