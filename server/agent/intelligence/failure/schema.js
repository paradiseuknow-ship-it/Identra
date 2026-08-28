'use strict';

// Failure Knowledge Schema（Phase 3.3）。
// 失败经验结构：id / site / category / condition / symptoms / evidence / solution / stats / confidence / source / status。
// 与 Flow Memory 同理：禁止保存固定 selector / 坐标 / xpath（避免页面变化即失效）。
// 失败经验比成功经验更危险，故校验更严：solution 必须指向既有受控策略，禁止自由文本执行脚本。

const FORBIDDEN_KEYS = ['selector', 'selectors', 'xpath', 'coordinates', 'coords', 'coordinate', 'pixel', 'offsetX', 'offsetY'];
const FORBIDDEN_VALUE_HINTS = ['xpath=', 'css=', 'document.querySelector', 'page.click', 'page.fill'];

// 受控修复策略集合（与 repairPlanner.STRATEGY_FOR_CATEGORY 对应，禁止 AI 发明）
const ALLOWED_STRATEGIES = [
  'SEMANTIC_RELOCATE', 'WAIT_RETRY_RELOAD', 'RELOAD_OR_BACK',
  'DISMISS_OVERLAY', 'REAUTH_OR_PAUSE', 'GENERIC_RETRY', 'VERIFY_RETRY',
];

const CATEGORIES = [
  'ELEMENT_CHANGED', 'ELEMENT_NOT_FOUND', 'ELEMENT_NOT_INTERACTABLE',
  'TIMEOUT', 'NAVIGATION_FAILED', 'NETWORK_ERROR', 'OBSTRUCTION',
  'SESSION_EXPIRED', 'HTTP_FORBIDDEN', 'CREDENTIAL_MISSING',
  'BROWSER_CRASH', 'UNKNOWN',
];

// 安全红线：这些类别只能建议「等待 / 换环境 / 人工」，禁止任何自动绕过/撞库/自动支付
const PROTECTED_CATEGORIES = ['HTTP_FORBIDDEN', 'SESSION_EXPIRED', 'CREDENTIAL_MISSING'];

function normalizeUrlPattern(path) {
  if (!path) return '/';
  return String(path)
    .replace(/\?.*$/, '')
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    .replace(/\/+$/, '') || '/';
}

function validate(fk) {
  const errors = [];
  if (!fk || typeof fk !== 'object') return { ok: false, errors: ['必须是对象'] };
  if (!fk.site) errors.push('site 缺失');
  if (!fk.category) errors.push('category 缺失');
  else if (!CATEGORIES.includes(fk.category)) errors.push('category 非法: ' + fk.category);

  if (!fk.condition || typeof fk.condition !== 'object') errors.push('condition 缺失');
  if (!fk.evidence || typeof fk.evidence !== 'object') errors.push('evidence 缺失');
  else if (!fk.evidence.errorType) errors.push('evidence.errorType 缺失');

  if (!fk.solution || typeof fk.solution !== 'object') errors.push('solution 缺失');
  else {
    if (!ALLOWED_STRATEGIES.includes(fk.solution.strategy)) errors.push('solution.strategy 非法或不受控: ' + fk.solution.strategy);
    if (!Array.isArray(fk.solution.steps)) errors.push('solution.steps 必须为数组');
    const blob = JSON.stringify(fk.solution).toLowerCase();
    for (const k of FORBIDDEN_KEYS) if (blob.includes('"' + k + '"')) errors.push('solution 禁止包含字段 ' + k);
    for (const h of FORBIDDEN_VALUE_HINTS) if (blob.includes(h)) errors.push('solution 禁止包含 ' + h);
    // 安全红线：受保护类别只能指向 REAUTH_OR_PAUSE（等待/换环境/人工），禁止其它策略
    if (PROTECTED_CATEGORIES.includes(fk.category) && fk.solution.strategy !== 'REAUTH_OR_PAUSE') {
      errors.push('受保护类别 ' + fk.category + ' 只能使用 REAUTH_OR_PAUSE（等待/换环境/人工）');
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, plan: fk };
}

module.exports = {
  validate, normalizeUrlPattern, ALLOWED_STRATEGIES, CATEGORIES, PROTECTED_CATEGORIES, FORBIDDEN_KEYS,
};
