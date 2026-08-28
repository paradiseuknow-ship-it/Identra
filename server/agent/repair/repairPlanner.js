'use strict';

// Repair Planner：将 Diagnosis 结果转换为受控 Repair Plan。
// 策略固定（不让 AI 发明），AI 只提供诊断类别/置信度。
// 输出必须通过 repairSchema 校验。

const repairSchema = require('./repairSchema');

const STRATEGY_FOR_CATEGORY = {
  // 元素
  ELEMENT_CHANGED: { strategy: 'SEMANTIC_RELOCATE', module: 'elementChanged', risk: 'LOW' },
  ELEMENT_NOT_FOUND: { strategy: 'SEMANTIC_RELOCATE', module: 'elementChanged', risk: 'LOW' },
  ELEMENT_NOT_INTERACTABLE: { strategy: 'SEMANTIC_RELOCATE', module: 'elementChanged', risk: 'LOW' },
  // 超时/未就绪/网络
  TIMEOUT: { strategy: 'WAIT_RETRY_RELOAD', module: 'timeout', risk: 'LOW' },
  PAGE_NOT_READY: { strategy: 'WAIT_RETRY_RELOAD', module: 'timeout', risk: 'LOW' },
  NETWORK_ERROR: { strategy: 'WAIT_RETRY_RELOAD', module: 'timeout', risk: 'LOW' },
  // 导航/服务端错误
  NAVIGATION_FAILED: { strategy: 'RELOAD_OR_BACK', module: 'navigation', risk: 'LOW' },
  SERVER_ERROR: { strategy: 'RELOAD_OR_BACK', module: 'navigation', risk: 'LOW' },
  // 验证失败：Phase 7 Step 5 改为 WAIT_STABLE→RECHECK_OBSERVATION→RETRY_VERIFY→SEMANTIC_RELOCATE 序列
  // （原 RELOAD_OR_BACK 对「验证期望未满足/异步渲染竞态」无效）。验证标准不变，仍由 executor 统一校验。
  VERIFICATION_FAILED: { strategy: 'VERIFY_RETRY', module: 'verifyFailed', risk: 'LOW' },
  // 弹窗/遮挡
  OBSTRUCTION: { strategy: 'DISMISS_OVERLAY', module: 'obstruction', risk: 'MEDIUM' },
  // 会话/权限（保守：人工或既有登录流程，不自动输入密码）
  SESSION_EXPIRED: { strategy: 'REAUTH_OR_PAUSE', module: 'sessionExpired', risk: 'HIGH' },
  HTTP_FORBIDDEN: { strategy: 'REAUTH_OR_PAUSE', module: 'sessionExpired', risk: 'HIGH' },
  CREDENTIAL_MISSING: { strategy: 'REAUTH_OR_PAUSE', module: 'sessionExpired', risk: 'HIGH' },
  APPROVAL_REQUIRED: { strategy: 'REAUTH_OR_PAUSE', module: 'sessionExpired', risk: 'HIGH' },
  // 浏览器
  BROWSER_CRASH: { strategy: 'GENERIC_RETRY', module: 'generic', risk: 'MEDIUM' },
  // 兜底
  UNKNOWN: { strategy: 'GENERIC_RETRY', module: 'generic', risk: 'LOW' },
};

// 类别字典闭合（C.4）：本数组须覆盖 errorClassifier.RECOVERY_CATEGORIES 与
// diagnosisSchema.DIAGNOSIS_CATEGORIES 的全部 key，确保任一分类都能映射到修复策略，
// 不被遗漏成"无需自动修复"而直接 escalate。新增错误类别时必须在此登记。
const CLOSED_ERROR_CATEGORIES = Object.keys(STRATEGY_FOR_CATEGORY);

module.exports = { planFromDiagnosis, STRATEGY_FOR_CATEGORY, CLOSED_ERROR_CATEGORIES };

function planFromDiagnosis({ task, step, diagnosis, classifier, failureSnapshot }) {
  const category = (diagnosis && diagnosis.category) || (classifier && classifier.type) || 'UNKNOWN';
  let mapping = STRATEGY_FOR_CATEGORY[category];
  if (!mapping) {
    // 类别字典闭合防御（C.4）：未登记的类别不静默放弃，降级为 GENERIC_RETRY，
    // 避免"无需自动修复"误判导致任务直接 escalate。APPROVAL_REQUIRED/CREDENTIAL_MISSING
    // 等不可自动修复类别由 repairPolicy 在 execute 阶段拦截，不在 plan 层拒绝。
    mapping = STRATEGY_FOR_CATEGORY.UNKNOWN;
  }
  let mod;
  try { mod = require('./strategies/' + mapping.module); } catch (e) { mod = require('./strategies/generic'); }
  const meta = (mod.meta && mod.meta()) || { steps: [], verification: { type: 'action_success' } };

  const raw = {
    diagnosisId: (failureSnapshot && failureSnapshot.id) || null,
    strategy: mapping.strategy,
    strategyType: mapping.module,
    confidence: (diagnosis && diagnosis.confidence) || 0.6,
    risk: mapping.risk,
    steps: meta.steps || [],
    verification: meta.verification || { type: 'action_success' },
    maxAttempts: 3,
  };
  const vr = repairSchema.validate(raw);
  if (!vr.ok) return { ok: false, error: 'Repair Plan Schema 校验失败: ' + vr.errors.join('; ') };
  return { ok: true, plan: vr.plan };
}

module.exports = { planFromDiagnosis, STRATEGY_FOR_CATEGORY, CLOSED_ERROR_CATEGORIES };
