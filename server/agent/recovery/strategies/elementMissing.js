'use strict';

// 策略：元素缺失 → 同义候选动作探测（不依赖固定 selector）。
// 页面按钮文字变化（Continue→Proceed 等）通过语义变体重试命中。
//
// C105 F6（恢复词源接地）：变体生成后必须先对【当前现场观察】做可解析性过滤 ——
// semanticResolver.resolve(target, observation) 非空的变体才保留。旧实现凭 CLICK_FALLBACK
// 词典轮播英文词（continue/submit/next/...），在非英语页面上全部落进 role=button 0.4 兜底
// → 误点第一个按钮（法语站 Plateforme 实锤）。与 F1 兜底收紧联动：接地过滤后，
// 词典里页面上真实存在的词才会被探测，零证据词直接出局。
//
// C150（真实站点可用性）：词表本身「接地」还不够 —— 还必须是**真实站点上真的会出现**的文案。
// 实证（真 chromium 打开用户实例的联盟站点首页）：该站真实注册入口文案是 `Start Free Trial` /
// `Try Free`，而旧词表（11 个通用短动词 continue/next/submit/...）一个都不在页面上 ⇒ 接地过滤后
// 变体全部出局 ⇒ 恢复链 100% 失效（用户主诉「连注册按钮都找不到」）。
// 修法：**具体长短语在前、通用短动词在后**。理由：
//   - 具体短语（start free trial / create account / ...）语义唯一，误点代价低；
//   - 通用短动词（submit/ok/confirm）语义宽泛，在目录类站点上会命中同名但语义无关的控件
//     （实证：该站首页的 `Submit Tool` 是「提交工具到目录」，不是「注册」）；
//   - 探测预算有限（elementChanged live 阶段 ≤3 变体），排在最前的词才有机会被真的试到。
// ★ 与 clauseresolver 的分工边界：本表只在**当前页面已有该文案时**才会被探测（F6 接地过滤），
//   绝不进入 resolve() 的评分，也不构成「跨语言翻译表」——F1.4 的语言中立边界不变。

const semanticResolver = require('../../semanticResolver');

// 具体意图短语（注册 / 开通 / 试用 / 购买）。顺序即探测优先级。
const CTA_SPECIFIC = [
  'start free trial', 'start trial', 'try free', 'try it free', 'free trial',
  'sign up free', 'sign up now', 'register now', 'create account', 'create an account',
  'sign up', 'register', 'get started', 'join now', 'start now',
  'subscribe now', 'subscribe',
  'buy now', 'add to cart', 'add to basket', 'proceed to checkout', 'checkout', 'place order',
  '立即注册', '免费注册', '免费试用', '开始使用', '立即购买', '加入购物车', '去结算',
];
// 通用短动词：语义宽泛、易命中同名无关控件，故后置。
const CTA_GENERIC = ['continue', 'next', 'proceed', 'submit', 'confirm', 'done', 'save', 'ok'];

const CLICK_FALLBACK = CTA_SPECIFIC.concat(CTA_GENERIC);
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

// C150：词表导出为公开契约 —— 守护测试必须从词表**导出**不变量（变体数 / 探测顺序），
// 而不是把数字与顺序写成字面快照（词表演进时不应需要改测试，只应重算不变量）。
module.exports = {
  getAction, buildElementVariants, variantResolvable,
  CLICK_FALLBACK, FIELD_FALLBACK, CTA_SPECIFIC, CTA_GENERIC,
};
