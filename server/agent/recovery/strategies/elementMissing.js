'use strict';

// 策略：元素缺失 → 同义候选动作探测（不依赖固定 selector）。
// 页面按钮文字变化（Continue→Proceed 等）通过语义变体重试命中。

const semanticResolver = require('../../semanticResolver');

const CLICK_FALLBACK = ['continue', 'next', 'submit', 'proceed', 'register', 'create account', 'sign up', 'done', 'save', 'ok', 'confirm'];
const FIELD_FALLBACK = ['email', 'password', 'username', 'name', 'first name', 'last name'];

function isClickLike(type) {
  return ['click', 'submit', 'login', 'logout', 'purchase', 'delete', 'press'].includes(type);
}

function buildElementVariants(action) {
  if (!action || !action.target) return [action];
  const t = action.target;
  const isField = !!t.field && !t.semantic;
  const semantic = (t.semantic || t.field || t.text || '').toLowerCase();
  if (!semantic) return [action];
  const inDict = !!semanticResolver.SYNONYMS[semantic];
  const syns = inDict ? semanticResolver.SYNONYMS[semantic] : (isClickLike(action.type) ? CLICK_FALLBACK : FIELD_FALLBACK);
  const seen = new Set([semantic]);
  const variants = [action];
  for (const s of syns) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const target = isField ? { ...t, field: s } : { ...t, semantic: s };
    variants.push({ ...action, target, reason: (action.reason ? action.reason + ' ' : '') + '确定性恢复: 尝试语义 ' + s });
  }
  return variants;
}

// attempts = 已失败尝试次数；第 1 次恢复即试同义词（索引从 1 开始）
function getAction(step, attempts) {
  const variants = buildElementVariants(step.action);
  const idx = Math.min(attempts, variants.length - 1);
  return variants[idx];
}

module.exports = { getAction, buildElementVariants };
