'use strict';

// 策略：元素缺失 → 同义候选动作探测（不依赖固定 selector）。
// 页面按钮文字变化（Continue→Proceed 等）通过语义变体重试命中。
//
// C105 F6（恢复词源接地）：变体生成后必须先对【当前现场观察】做可解析性过滤 ——
// semanticResolver.resolve(target, observation) 非空的变体才保留。旧实现凭 CLICK_FALLBACK
// 词典轮播英文词（continue/submit/next/...），在非英语页面上全部落进 role=button 0.4 兜底
// → 误点第一个按钮（法语站 Plateforme 实锤）。与 F1 兜底收紧联动：接地过滤后，
// 词典里页面上真实存在的词才会被探测，零证据词直接出局。
// 兼容边界：不传 observation 时行为与旧版完全一致（test_repair_variant_cap 契约锁定）。

const semanticResolver = require('../../semanticResolver');

const CLICK_FALLBACK = ['continue', 'next', 'submit', 'proceed', 'register', 'create account', 'sign up', 'done', 'save', 'ok', 'confirm'];
const FIELD_FALLBACK = ['email', 'password', 'username', 'name', 'first name', 'last name'];

function isClickLike(type) {
  return ['click', 'submit', 'login', 'logout', 'purchase', 'delete', 'press'].includes(type);
}

// 变体语义在观察中是否可解析。观察缺失/无元素/解析异常时返回 true（不做过滤，保持原行为）。
function variantResolvable(target, observation) {
  if (!observation || !Array.isArray(observation.elements) || !observation.elements.length) return true;
  try {
    const cands = semanticResolver.resolve(target || {}, observation);
    return !!(cands && cands.length);
  } catch (e) { return true; }
}

function buildElementVariants(action, observation) {
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
  // C105 F6：接地过滤 —— 原动作恒保留（第 0 位），变体须在当前观察中可解析。
  // 全部变体出局时只回原动作（重放原失败），由 runtime F5 anti-flapping 熔断收口。
  if (observation) {
    const filtered = variants.filter((v, i) => i === 0 || variantResolvable(v.target, observation));
    return filtered.length ? filtered : [action];
  }
  return variants;
}

// attempts = 已失败尝试次数；第 1 次恢复即试同义词（索引从 1 开始）。
// ctx.observation（recoveryManager.attempt 透传的现场观察）驱动 F6 接地过滤。
function getAction(step, attempts, ctx) {
  const observation = (ctx && ctx.observation) || null;
  const variants = buildElementVariants(step.action, observation);
  const idx = Math.min(attempts, variants.length - 1);
  return variants[idx];
}

module.exports = { getAction, buildElementVariants, variantResolvable };
