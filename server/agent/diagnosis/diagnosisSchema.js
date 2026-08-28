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

const INSTRUCTIONS = `输出 JSON 诊断（四层结构，禁止无证据的推测）：
{
  "category": "ELEMENT_CHANGED|ELEMENT_NOT_FOUND|...",
  "confidence": 0.0-1.0,
  "facts": ["事实1: 先前目标文本是 Continue"],
  "evidence": ["证据1: 当前页面包含 Proceed 按钮"],
  "inference": "推断: 页面按钮文案发生变化",
  "recommendation": "建议: 重新运行语义匹配"
}`;

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
  return {
    ok: true,
    plan: {
      category: raw.category,
      confidence: Math.round(Math.min(1, Math.max(0, raw.confidence)) * 100) / 100,
      facts: raw.facts.map(String).slice(0, 8),
      evidence: raw.evidence.map(String).slice(0, 8),
      inference: raw.inference.trim().slice(0, 500),
      recommendation: raw.recommendation.trim().slice(0, 300),
    },
  };
}

module.exports = { validate, INSTRUCTIONS, DIAGNOSIS_CATEGORIES };
