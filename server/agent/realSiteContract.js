'use strict';

// Phase 15.1-15.5 — Real-Site Generic Task Contract（纯函数，零 IO、零网络）
//
// 定位：
//   15.1 通用真实站点任务契约（校验 + URL 解析）
//   15.3 Task Preconditions（Task Readiness 四项门）
//   15.5 Real-Site Failure Classification（诊断结论 → 真实站点失败分类，纯映射）
//
// 红线：
//   - site 仅是 target metadata：本模块与任何执行路径都不得出现 if (site === X) 分支
//   - 终态复用现有 vocabulary（SUCCESS / CORRECT_FAIL / HUMAN_ESCALATION / BLOCKED_EXTERNAL /
//     CANCELLED / FAILED），不新增重复状态；BLOCKED_EXTERNAL 为 harness 级细分（记 evidence），
//     task 终态仍为 HUMAN_ESCALATION（与 challengeDetector.terminalStateFor 一致）
//   - 403 = observed external block，绝不等价于 environment_bad / IP reputation confirmed；
//     归因三层 observed / inferred / unknown 显式保留
//   - challenge / external block → 升级人工，绝不产出绕过方案

// ── 15.1 契约校验 ──

// 真实站点允许的终态词汇（复用现有 vocabulary；BLOCKED_EXTERNAL 为 harness 级细分）
const REAL_SITE_TERMINAL_STATES = ['SUCCESS', 'CORRECT_FAIL', 'HUMAN_ESCALATION', 'BLOCKED_EXTERNAL', 'CANCELLED', 'FAILED'];

const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

function validateRealSiteTask(t) {
  if (!t || typeof t !== 'object') return { ok: false, errors: ['task 必须是对象'] };
  const errors = [];
  if (!/^R\d{2}$/.test(String(t.taskId || ''))) errors.push('taskId 必须匹配 R\\d{2}');
  if (!t.name || typeof t.name !== 'string') errors.push('name 必填（字符串）');
  if (!t.objective || typeof t.objective !== 'string') errors.push('objective 必填（字符串）');
  if (typeof t.path !== 'string' || !t.path.startsWith('/')) errors.push('path 必须是以 / 开头的站点路径');
  if (!RISK_LEVELS.includes(t.riskLevel)) errors.push('riskLevel 必须是 LOW/MEDIUM/HIGH/CRITICAL');
  const ets = t.expectedTerminalStates || [];
  if (!Array.isArray(ets) || !ets.length) {
    errors.push('expectedTerminalStates 必须非空');
  } else {
    const bad = ets.filter((s) => !REAL_SITE_TERMINAL_STATES.includes(s));
    if (bad.length) errors.push('expectedTerminalStates 含未定义终态: ' + bad.join(','));
  }
  if (t.credentialsRequired && !t.credentialRef && !t.invalidCredentials) {
    // 定义期允许缺省 credentialRef（凭据由 harness 执行期从 credential workspace 注册注入）；
    // 执行期由 validateForExecution / computeTaskReadiness(CREDENTIAL_NOT_READY) fail-closed 拦截。
  }
  if (t.site != null && typeof t.site !== 'string') errors.push('site 仅允许字符串 metadata');
  return { ok: errors.length === 0, errors };
}

// 执行期校验：credentialsRequired 且非 invalidCredentials 的任务必须有已解析的 credentialRef
//（由 harness 执行前注入）。缺省 → 拒绝执行（fail-closed，STOP 语义）。
function validateForExecution(t) {
  const base = validateRealSiteTask(t);
  if (!base.ok) return base;
  const errors = [];
  if (t.credentialsRequired && !t.invalidCredentials && !t.credentialRef) {
    errors.push('执行期拒绝：credentialsRequired 任务缺少已解析的 credentialRef（STOP，不自动寻找替代凭据）');
  }
  return { ok: errors.length === 0, errors };
}

// path + baseUrl → 绝对 URL（site/path 仅作 target 参数化，绝不携带执行语义）
function resolveTaskUrl(t, baseUrl) {
  if (!t || !t.path) throw new Error('resolveTaskUrl: task.path 必填');
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) throw new Error('resolveTaskUrl: baseUrl 必须是 http(s) URL');
  return new URL(t.path, baseUrl).toString();
}

// ── 15.3 Task Preconditions（Task Readiness）──

// 四项前置门 + 已检测 challenge 门。任一 blocker → 不执行。
//   integrity      environmentIntegrity.checkEnvironmentIntegrity 输出
//   credentialReady boolean（credentialsRequired 时必须为 true）
//   challenge      challengeDetector.detectChallenge 输出（可空 = 未知，不据此拦截）
//   policyDecision { decision: 'ALLOW'|'BLOCK', ... }
function computeTaskReadiness({ integrity = null, credentialReady = false, credentialsRequired = false, challenge = null, policyDecision = null } = {}) {
  const blockers = [];
  if (!integrity || integrity.status !== 'PASS') {
    blockers.push({ code: 'ENVIRONMENT_INTEGRITY_FAIL', reason: 'Environment Integrity 未通过（' + ((integrity && integrity.status) || 'MISSING') + '），不执行' });
  }
  if (credentialsRequired && !credentialReady) {
    blockers.push({ code: 'CREDENTIAL_NOT_READY', reason: '任务需要凭据但 credential workspace 无可用授权凭据，STOP（不自动寻找替代凭据）' });
  }
  if (challenge && challenge.challenge) {
    blockers.push({ code: 'EXTERNAL_CHALLENGE_PRESENT', reason: '已检测到外部挑战/阻断（kind=' + (challenge.kind || 'unknown') + '），不继续自动操作' });
  }
  if (policyDecision && policyDecision.decision && policyDecision.decision !== 'ALLOW') {
    blockers.push({ code: 'POLICY_NOT_ALLOWED', reason: 'Policy decision 非 ALLOW（' + String(policyDecision.decision) + '）' });
  }
  return {
    decision: blockers.length ? 'BLOCK' : 'ALLOW',
    blockers,
    checkedAt: Date.now(),
    // readiness 快照（报告用）
    readiness: {
      environmentIntegrity: (integrity && integrity.status) || 'MISSING',
      credential: credentialsRequired ? (credentialReady ? 'READY' : 'MISSING') : 'NOT_REQUIRED',
      riskPolicy: (policyDecision && policyDecision.decision) || 'ALLOW',
      challenge: challenge && challenge.challenge ? (challenge.kind || 'detected') : 'none',
    },
  };
}

// ── 15.5 Real-Site Failure Classification ──
//
// 输入：failureDiagnoser 产出的 Diagnosis（rootCause / category / findings）+ challenge 检测结果。
// 输出：{ classification, evidenceTier }
//   classification ∈ AUTH_INVALID_CREDENTIAL / ELEMENT_NOT_FOUND / PAGE_NOT_READY /
//     NAVIGATION_FAILURE / EXTERNAL_BLOCK / INTERACTIVE_CHALLENGE / TIMEOUT /
//     VERIFICATION_FAILED / UNKNOWN
//   evidenceTier ∈ observed（页面/网络实测）/ inferred（由错误码/文案推断）/ unknown
// 规则：HTTP 403 → EXTERNAL_BLOCK（tier 由 challenge 特征决定；无特征 = inferred，
//       保留「外部阻断但原因未知」的三层证据，绝不升级为 IP 归因结论）。
const FAILURE_CLASSIFICATION_MAP = {
  // 外部阻断 / 交互式挑战
  EXTERNAL_BLOCK: 'EXTERNAL_BLOCK',
  HTTP_403_FORBIDDEN: 'EXTERNAL_BLOCK',
  HTTP_429_RATE_LIMITED: 'EXTERNAL_BLOCK',
  INTERACTIVE_CHALLENGE: 'INTERACTIVE_CHALLENGE',
  BUSINESS_CAPTCHA_REQUIRED: 'INTERACTIVE_CHALLENGE',
  BUSINESS_OTP_REQUIRED: 'INTERACTIVE_CHALLENGE',
  // 认证
  BUSINESS_INVALID_CREDENTIAL: 'AUTH_INVALID_CREDENTIAL',
  HTTP_401_UNAUTHORIZED: 'AUTH_INVALID_CREDENTIAL',
  // 元素 / 页面就绪
  ELEMENT_NOT_FOUND: 'ELEMENT_NOT_FOUND',
  ELEMENT_NOT_INTERACTABLE: 'ELEMENT_NOT_FOUND',
  ELEMENT_CHANGED: 'ELEMENT_NOT_FOUND',
  PAGE_NOT_READY: 'PAGE_NOT_READY',
  OBSERVATION_DELAY: 'PAGE_NOT_READY',
  // 导航
  NAVIGATION_FAILED: 'NAVIGATION_FAILURE',
  HTTP_404_NOT_FOUND: 'NAVIGATION_FAILURE',
  // 超时 / 验证
  TIMEOUT: 'TIMEOUT',
  STEP_TIMEOUT: 'TIMEOUT',
  VERIFY_FAILED: 'VERIFICATION_FAILED',
  VERIFICATION_TOO_STRICT: 'VERIFICATION_FAILED',
  // 证据契约家族：VIL 判定「无法确认预期状态」—— 分类为验证失败族（真实站点实证：
  // 中/英语义错配或页面内容不符时终态 HUMAN_ESCALATION，归因应落在验证层）
  STATE_UNKNOWN: 'VERIFICATION_FAILED',
};

function classifyRealSiteFailure({ diagnosis = null, error = null, challenge = null, observation = null } = {}) {
  const rootCause = (diagnosis && diagnosis.rootCause) || (error && (error.failureType || error.code)) || null;
  const category = (diagnosis && diagnosis.category) || (error && error.category) || null;
  const mapped = FAILURE_CLASSIFICATION_MAP[rootCause] || FAILURE_CLASSIFICATION_MAP[category] || null;

  // challenge 显式接管：外部阻断 / 交互式挑战是 observed 级证据（页面 + 网络实测）
  if (challenge && challenge.challenge) {
    const cls = challenge.externalBlock && !challenge.interactive ? 'EXTERNAL_BLOCK' : 'INTERACTIVE_CHALLENGE';
    return { classification: cls, evidenceTier: 'observed', rootCause: rootCause || cls };
  }

  let classification = mapped || 'UNKNOWN';
  // 403 但无 challenge 特征：仍是 EXTERNAL_BLOCK（状态码是客观证据），但 tier=inferred
  //（无 WAF/厂商特征佐证，不伪称完全归因）
  let tier;
  if (classification === 'EXTERNAL_BLOCK' && rootCause !== 'EXTERNAL_BLOCK') {
    tier = 'inferred';
  } else if (diagnosis && Array.isArray(diagnosis.findings) && diagnosis.findings.some((f) => f.source && f.source.startsWith('network'))) {
    tier = 'observed';
  } else if (observation && observation.challenge && observation.challenge.challenge) {
    tier = 'observed';
  } else if (classification === 'UNKNOWN') {
    tier = 'unknown';
  } else {
    tier = 'inferred';
  }
  return { classification, evidenceTier: tier, rootCause: rootCause || category || null };
}

// ── R09 期望失败判定 ──
// expectedFailure 任务：AUTH_INVALID_CREDENTIAL → CORRECT_FAIL（正确失败）；
// 外部阻断/挑战 → BLOCKED_EXTERNAL / HUMAN_ESCALATION（同样是有效结果）；其余 → null（意外，需人工审查）。
function expectedFailureOutcome({ expectedFailure = false, classification = null } = {}) {
  if (!expectedFailure) return null;
  if (classification === 'AUTH_INVALID_CREDENTIAL') return { terminal: 'CORRECT_FAIL', note: '无效凭据被正确诊断，未进入无限修复' };
  if (classification === 'EXTERNAL_BLOCK') return { terminal: 'BLOCKED_EXTERNAL', note: '登录页被外部阻断，未发送任何凭据' };
  if (classification === 'INTERACTIVE_CHALLENGE') return { terminal: 'HUMAN_ESCALATION', note: '登录页出现交互式挑战，升级人工' };
  return null;
}

module.exports = {
  REAL_SITE_TERMINAL_STATES,
  RISK_LEVELS,
  validateRealSiteTask,
  validateForExecution,
  resolveTaskUrl,
  computeTaskReadiness,
  classifyRealSiteFailure,
  expectedFailureOutcome,
  FAILURE_CLASSIFICATION_MAP,
};
