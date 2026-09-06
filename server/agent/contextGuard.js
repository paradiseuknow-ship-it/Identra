'use strict';

// Phase 6.2 — Action Context Guard（STEP 1 去站点化重写版）
//
// 性质：READ-ONLY 决策。不改状态、不自动判成功、不调用 RESULT.ok。
// 返回 { blocked, code, reason, evidence, guardMode }，由上层决定是否转 replan/escalation。
//
// ── 为什么重写（STEP 1）────────────────────────────────────────────────────
// 旧实现的判定核心是「期望站点类型 vs 当前页面状态」的错配矩阵，
// 站点类型由一个从 URL/语义里猜的枚举推导，并配有一套针对某个特定品类站点的
// 关键词证据函数（含 mock 压测站点独有的品牌词与后台词汇）。
// phase68 100-task 运行时取证（server/data/aiAttempts.json，4661 次 attempt）：
//     609 次 CONTEXT_WRONG_APP，其中 553 次的阻断理由字面完全相同 ——
//     「期望站点=<某品类> 但当前页面状态=GENERIC」。
// 这不是"守卫太严"，而是前提错了：本产品是通用 Web Operator，
// 真实互联网上不存在「站点类型」这个可判定的输入，GENERIC 也不是错误上下文。
// 该枚举、该矩阵与该函数已整体删除，不保留任何向后兼容别名（避免死灰复燃）。
//
// ── 新契约：动作前提校验（Page Capability Precondition）─────────────────────
// 不再问「这是不是该去的站点」，只问：
//   「当前页面观察到的能力，是否支持这个动作？」
// 能力标签由 pageStateClassifier 从 URL/title/DOM/文本结构中立推导
// （navigation/authentication/registration/search/form/upload/download/
//   listing/detail/cart/checkout/payment/confirmation/error/loading）。
//
// ── 保守原则（历史教训）────────────────────────────────────────────────────
// 过度阻断会直接导致任务死亡（阻断 → replan → 再阻断 → escalate）。
// 因此本守卫只在「有正向反证」时阻断，证据不足一律放行（fail-open）：
//   1. 只对 4 类高信号动作设前提（upload / purchase / checkout / payment）。
//   2. 能力集合为空（观察缺失）时绝不阻断。
//   3. 仅凭"缺少某能力"不足以阻断 upload；必须有 download 能力的正向反证。
//   4. 错误页 / 未就绪页不属于"站点错配"，而是真实的可诊断前提缺失，仍然阻断。

// ── 动作分类 ───────────────────────────────────────────────────────────────

// 需要目标元素才能执行（空白页/未就绪页上必然失败 → E2 未就绪）
const ELEMENT_ACTIONS = new Set([
  'fill', 'click', 'select', 'check', 'uncheck', 'upload', 'download',
  'submit', 'login', 'logout', 'delete', 'update_account_settings',
  'purchase', 'payment', 'password_change',
]);

// 页面转场动作：上下文由其「目标地址」定义，而非「当前页」。
// 导航恰恰是「脱离错误上下文」的手段，阻断它会导致任务永久无法进入正确页面。
const PAGE_TRANSITION_ACTIONS = new Set(['navigate', 'goto', 'open', 'goto_url']);

// 只读动作：不产生副作用，阻断观察会让 agent 彻底失去诊断与恢复能力。
const READ_ONLY_ACTIONS = new Set([
  'inspect', 'observe', 'read', 'extract', 'scrape', 'screenshot', 'wait', 'scroll',
]);

// ── 动作前提：该动作要求页面至少具备的能力之一 ───────────────────────────────
// 只登记「缺失时几乎必然失败且误判代价低」的动作。刻意不登记 login / fill / click，
// 因为登录入口常藏在下拉层里、表单常由自定义组件实现，
// 旧实现在这类动作上的误阻断是 609 次 CONTEXT_WRONG_APP 的主要来源。
const ACTION_CAPABILITY_REQUIREMENT = {
  upload: { any: ['upload'], contradict: ['download'] },
  purchase: { any: ['cart', 'checkout', 'payment'] },
  checkout: { any: ['cart', 'checkout', 'payment'] },
  payment: { any: ['payment', 'checkout'] },
};

// 页面级强语义冲突：不依赖能力标签，仅凭页面形态即可判定（upload/download 是通用 Web 语义）
function semanticPageConflict(action, pageState) {
  const type = actionType(action);
  const state = pageState && pageState.state;
  if (type === 'upload' && state === 'DOWNLOAD_PAGE') {
    return {
      blocked: true,
      code: 'CONTEXT_WRONG_APP',
      reason: '上传动作落在资源下载页，当前页面不具备上传能力（E5）',
    };
  }
  if (type === 'download' && state === 'REGISTRATION') {
    return {
      blocked: true,
      code: 'CONTEXT_WRONG_APP',
      reason: '下载动作落在注册表单页，当前页面不具备下载目标（E5）',
    };
  }
  return null;
}

// 转场动作：判定「目标地址」与「动作目标」是否冲突（不是 bypass，守卫对象换了位置）
function destinationConflict(action, goal) {
  const url = String((action.target && action.target.url) || '').toLowerCase();
  if (!url) return null;
  if (goal === 'upload' && /\/download|download\.html|download=/.test(url)) {
    return {
      blocked: true,
      code: 'CONTEXT_WRONG_APP',
      reason: `上传动作导航至下载地址（${url.slice(0, 120)}），目标地址与动作目标冲突（E5）`,
    };
  }
  if (goal === 'download' && /\/upload|upload\.html|upload=/.test(url)) {
    return {
      blocked: true,
      code: 'CONTEXT_WRONG_APP',
      reason: `下载动作导航至上传地址（${url.slice(0, 120)}），目标地址与动作目标冲突（E5）`,
    };
  }
  return null;
}

function actionType(action) {
  return String((action && action.type) || '').toLowerCase();
}

function isPageTransition(action) {
  return PAGE_TRANSITION_ACTIONS.has(actionType(action));
}

function isReadOnly(action) {
  return READ_ONLY_ACTIONS.has(actionType(action));
}

// 从动作推导「目标」——通用 Web 语义，不是站点类型
// upload/download/payment/authentication/registration 是所有网站共有的动作语义。
function deriveActionGoal(action) {
  const type = actionType(action);
  const t = (action && action.target) || {};
  const url = String(t.url || '').toLowerCase();
  const sem = String(t.semantic || t.field || t.text || '').toLowerCase();

  if (type === 'upload' || /upload|上传|附件|选择文件/.test(url) || /upload|上传|附件|选择文件/.test(sem)) return 'upload';
  if (type === 'download' || /download|下载/.test(url) || /download|下载/.test(sem)) return 'download';
  if (['purchase', 'payment', 'checkout'].includes(type) || /checkout|payment|pay|结算|支付|付款/.test(url) || /结算|支付|付款|下单/.test(sem)) return 'payment';
  if (type === 'login' || /\/login|\/signin|\/auth/.test(url) || /登录|sign in|log in/.test(sem)) return 'authentication';
  if (type === 'register' || /register|signup|sign-up/.test(url) || /注册|sign up/.test(sem)) return 'registration';
  return null;
}

// 解析能力标签：优先取分类器输出；观察可得时兜底现算（分类器不依赖本模块，无循环依赖）
function resolveCapabilities(pageState, opts) {
  if (pageState && Array.isArray(pageState.capabilities) && pageState.capabilities.length) {
    return pageState.capabilities.slice();
  }
  const obs = opts && opts.observation;
  if (obs && typeof obs === 'object') {
    try {
      const classifier = require('./pageStateClassifier');
      if (typeof classifier.detectCapabilities === 'function') {
        const st = (pageState && pageState.state) || 'GENERIC';
        return classifier.detectCapabilities(obs, st);
      }
    } catch (e) { /* 兜底失败即视为无能力证据 */ }
  }
  return [];
}

/**
 * 动作上下文守卫。
 *
 * @param {object} action     待执行动作
 * @param {object} pageState  pageStateClassifier 输出 { state, confidence, signals, capabilities }
 * @param {object|string} [opts]  { observation?, capabilities? }；
 *        传入字符串视为旧版「期望站点」提示（已废弃，仅忽略，不阻断、不抛错）
 */
function guard(action, pageState, opts) {
  if (!action || !pageState) return { blocked: false, code: null, reason: null, evidence: null };

  // 兼容旧调用签名（第三参数为站点字符串）：记录下来但完全不参与判定
  const legacySiteHint = typeof opts === 'string' ? opts : null;
  const options = (opts && typeof opts === 'object') ? opts : {};
  const state = pageState.state;
  const goal = deriveActionGoal(action);
  const capabilities = (Array.isArray(options.capabilities) && options.capabilities.length)
    ? options.capabilities.slice()
    : resolveCapabilities(pageState, options);

  const pass = (guardMode, evidence) => ({
    blocked: false, code: null, reason: null,
    evidence: evidence || null,
    guardMode,
    goal,
    capabilities,
    ...(legacySiteHint ? { legacySiteHintIgnored: legacySiteHint } : {}),
  });

  const block = (code, reason, guardMode, evidence) => ({
    blocked: true, code, reason,
    evidence: evidence || null,
    guardMode: guardMode || 'blocked',
    goal,
    capabilities,
    ...(legacySiteHint ? { legacySiteHintIgnored: legacySiteHint } : {}),
  });

  const type = actionType(action);
  const mutating = !isReadOnly(action) && !isPageTransition(action);

  // 规则 0：只读动作不参与上下文阻断（观察不产生副作用，阻断它等于削弱自愈能力）
  if (isReadOnly(action)) return pass('read_only');

  // 规则 1：转场动作 —— 判定「目标地址」，不判定「当前页」
  if (isPageTransition(action)) {
    const dc = destinationConflict(action, goal);
    if (dc) return block(dc.code, dc.reason, 'destination_conflict');
    return pass('destination');
  }

  // 规则 2（E2）：需要目标元素的动作落在未就绪页 → 阻止
  if (ELEMENT_ACTIONS.has(type) && (state === 'BLANK' || state === 'LOADING')) {
    return block(
      'CONTEXT_NOT_READY',
      `页面未就绪（${state === 'BLANK' ? '空白页/SPA 未挂载' : '加载中'}），动作 ${type} 需目标元素，阻止执行（E2）`,
      'not_ready'
    );
  }

  // 规则 3（错误页）：错误页上执行会改变状态的动作没有意义 → 阻止并给出可诊断理由
  if (state === 'ERROR' && mutating && (pageState.confidence == null || pageState.confidence >= 0.7)) {
    return block('CONTEXT_WRONG_APP', `当前页面为错误页（signals=${(pageState.signals || []).join(',') || 'n/a'}），无法执行 ${type}，需先导航或重试（E5）`, 'error_page');
  }

  // 规则 4（E5）：页面形态与动作语义直接冲突
  const sp = semanticPageConflict(action, pageState);
  if (sp) return block(sp.code, sp.reason, 'semantic_conflict');

  // 规则 5（前提校验）：动作要求的能力在当前页面无证据，且有正向反证 → 阻止
  // 证据不足（capabilities 为空）时一律放行 —— 这是避免过度阻断的关键闸门。
  const req = ACTION_CAPABILITY_REQUIREMENT[type];
  if (req && capabilities.length) {
    const hasAny = req.any.some((c) => capabilities.includes(c));
    if (!hasAny) {
      const hasContradiction = Array.isArray(req.contradict)
        ? req.contradict.some((c) => capabilities.includes(c))
        : false;
      // upload：必须看到 download 的正向反证才阻断；支付类：能力集合非空即视为有反证
      if (hasContradiction || !req.contradict) {
        return block(
          'CONTEXT_WRONG_APP',
          `动作 ${type} 需要页面具备 [${req.any.join('|')}] 能力，当前页面能力=[${capabilities.join(',')}]，前提不成立（E5）`,
          'capability_missing',
          { required: req.any, present: capabilities, contradict: hasContradiction }
        );
      }
    }
  }

  return pass('pass');
}

module.exports = {
  guard,
  deriveActionGoal,
  ACTION_CAPABILITY_REQUIREMENT,
  ELEMENT_ACTIONS,
  PAGE_TRANSITION_ACTIONS,
  READ_ONLY_ACTIONS,
  semanticPageConflict,
  destinationConflict,
  isPageTransition,
  isReadOnly,
};
