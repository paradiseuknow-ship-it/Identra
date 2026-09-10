'use strict';

// Diagnosis Schema：LLM 诊断输出结构，非法即拒绝重试。
// 四层结构：FACT（事实） / EVIDENCE（证据） / INFERENCE（推断） / RECOMMENDATION（建议）。
// 禁止无证据断言（如"IP 被封""被风控""账号异常"）。

const DIAGNOSIS_CATEGORIES = [
  // 元素/页面
  'ELEMENT_CHANGED', 'ELEMENT_NOT_FOUND', 'ELEMENT_NOT_INTERACTABLE',
  'PAGE_NOT_READY', 'OBSTRUCTION',
  // 网络/服务端
  'TIMEOUT', 'NAVIGATION_FAILED', 'NETWORK_ERROR', 'HTTP_FORBIDDEN', 'SERVER_ERROR',
  // 会话/权限
  'SESSION_EXPIRED', 'CREDENTIAL_MISSING', 'APPROVAL_REQUIRED',
  // 浏览器
  'BROWSER_CRASH',
  'UNKNOWN',
];

// PHASE 17-A P0-B：诊断的**决策扩展字段**（可选）。
// 诊断此前只能被「选修复策略」消费，Runtime 的动作策略层从不读它（R3 473s 实证）。
// 这里只是把结论结构化地暴露出来 —— 是否 BLOCK 动作由 diagnosisDecision 的 policy 决定，
// 诊断本身**永远不能**直接产出 SUCCESS，也不改变 verification / success definition。
const DECISION_STATES = [
  'TARGET_NOT_PRESENT_YET',   // 目标尚未出现，但当前页可能是合法中间态（分步表单）
  'MULTI_STEP_FORM',          // 分步表单：禁止提前执行后续字段
  'NAVIGATION_IN_PROGRESS',   // 导航/提交未完成：禁止继续 fill/click，等待后重观察
  'CROSS_ORIGIN_DRIFT',       // 漂移到第三方域：立即停止凭据动作，重新检查授权
  'SECURITY_CHALLENGE',       // 人机验证/风控挑战：STOP（不 repair / 不 retry / 不绕过）
  'TARGET_STALE',             // 目标定位已失效：丢弃 stale target，重新观察并重新接地
];

const INSTRUCTIONS = `输出 JSON 诊断（四层结构，禁止无证据的推测）：
{
  "category": "ELEMENT_CHANGED|ELEMENT_NOT_FOUND|...",
  "confidence": 0.0-1.0,
  "facts": ["事实1: 先前目标文本是 Continue"],
  "evidence": ["证据1: 当前页面包含 Proceed 按钮"],
  "inference": "推断: 页面按钮文案发生变化",
  "recommendation": "建议: 重新运行语义匹配",
  "state": "TARGET_NOT_PRESENT_YET|MULTI_STEP_FORM|NAVIGATION_IN_PROGRESS|CROSS_ORIGIN_DRIFT|SECURITY_CHALLENGE|TARGET_STALE",
  "blockedActions": ["fill:password"],
  "required": "REOBSERVE_AFTER_SUBMIT"
}
state / blockedActions / required 为可选决策字段：只在证据充分时给出，
用于让 Runtime 停止执行已知不可能成功的动作（诊断绝不判定成功）。`;

function validate(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['诊断必须是对象'] };
  if (typeof raw.category !== 'string' || !raw.category.trim()) errors.push('category 缺失');
  else if (!DIAGNOSIS_CATEGORIES.includes(raw.category)) errors.push(`category 非法: ${raw.category}`);
  if (typeof raw.confidence !== 'number' || raw.confidence < 0 || raw.confidence > 1) errors.push('confidence 必须为 0~1');
  if (!Array.isArray(raw.facts)) errors.push('facts 必须为数组');
  else if (raw.facts.some((f) => typeof f !== 'string')) errors.push('facts 元素必须为字符串');
  if (!Array.isArray(raw.evidence)) errors.push('evidence 必须为数组');
  else if (raw.evidence.some((f) => typeof f !== 'string')) errors.push('evidence 元素必须为字符串');
  if (typeof raw.inference !== 'string' || !raw.inference.trim()) errors.push('inference 缺失');
  if (typeof raw.recommendation !== 'string' || !raw.recommendation.trim()) errors.push('recommendation 缺失');

  if (errors.length) return { ok: false, errors, instructions: INSTRUCTIONS };

  const plan = {
    category: raw.category,
    confidence: Math.round(Math.min(1, Math.max(0, raw.confidence)) * 100) / 100,
    facts: raw.facts.map(String).slice(0, 8),
    evidence: raw.evidence.map(String).slice(0, 8),
    inference: raw.inference.trim().slice(0, 500),
    recommendation: raw.recommendation.trim().slice(0, 300),
  };

  // 决策字段：非法/未知一律**丢弃**而非拒绝整份诊断 ——
  // 诊断是增强能力，绝不能因为可选字段写错就把整次失败归因打回重来（成本与延迟都不可接受）。
  if (typeof raw.state === 'string' && DECISION_STATES.indexOf(raw.state.trim()) >= 0) {
    plan.state = raw.state.trim();
  }
  if (raw.state && !plan.state) {
    const low = String(raw.state).trim().toLowerCase();
    const hit = DECISION_STATES.filter((s) => s.toLowerCase() === low)[0];
    if (hit) plan.state = hit;
  }
  if (Array.isArray(raw.blockedActions)) {
    const ba = raw.blockedActions.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 80));
    if (ba.length) plan.blockedActions = ba.slice(0, 8);
  }
  if (typeof raw.required === 'string' && raw.required.trim()) {
    plan.required = raw.required.trim().slice(0, 60);
  }
  if (typeof raw.currentStep === 'string' && raw.currentStep.trim()) {
    plan.currentStep = raw.currentStep.trim().slice(0, 60);
  }

  return { ok: true, plan };
}

module.exports = { validate, INSTRUCTIONS, DIAGNOSIS_CATEGORIES, DECISION_STATES };
