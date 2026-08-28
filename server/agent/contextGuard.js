'use strict';

// Phase 6.2 — Action Context Guard (READ-ONLY decision; does NOT mutate state, does NOT auto-judge success).
//
// 纯函数：给定「待执行动作」+「当前页面状态（来自 pageStateClassifier）」+「期望站点（可选提示）」，
// 返回 { blocked, code, reason }。调用方据此决定是否阻止动作执行（阻止时由上层转 replan/escalation）。
//
// 设计约束：
//   - 仅阻止「明显错误」的上下文执行（高置信度），避免过度拦截合法动作。
//   - 绝不调用 RESULT.ok / 绝不自动判定任务成功（与 Phase 6.2 要求一致）。
//   - 不对页面状态做写操作。
//
// Phase 9 P0 修正（数据驱动，来自 phase68 100-task）：
//   224 次 CONTEXT_WRONG_APP 中 196 次发生在 `navigate` 动作上，且目标地址恒为
//   http://127.0.0.1:<port>/saas/login.html。原因是守卫把「导航前的当前页状态」
//   当作动作上下文来判定站点矛盾 —— 而 navigate 的上下文由其「目标地址」定义。
//   导航恰恰是「离开错误上下文」的手段，阻断它会导致任务永久无法进入正确页面。
//   修正：转场动作改判「目标地址」，不再用当前页状态；GENERIC 不再是无条件阻断。
//   安全边界保持不变：E5 语义保留、真实错误上下文仍阻断、无 catch-all 放行、
//   不把 verification 失败变成功。

// 需要目标元素（失败于 BLANK 页即属 E2 未就绪）的动作类型
const ELEMENT_ACTIONS = new Set([
  'fill', 'click', 'select', 'check', 'uncheck', 'upload', 'download',
  'submit', 'login', 'logout', 'delete', 'update_account_settings',
  'purchase', 'payment', 'password_change',
]);

// Phase 9 P0：页面转场动作。其上下文由「目标地址」定义，而非「当前页」。
// 当前页状态对这些动作不构成站点矛盾（导航本身就是修正上下文的手段）。
const PAGE_TRANSITION_ACTIONS = new Set(['navigate', 'goto', 'open', 'goto_url']);

// Phase 9 P0：只读动作。观察类动作不会产生错误上下文的副作用，
// 且阻断观察会让 agent 失去诊断与恢复能力，因此不参与「页面语义矛盾」判定。
const READ_ONLY_ACTIONS = new Set([
  'inspect', 'observe', 'read', 'extract', 'scrape', 'screenshot', 'wait', 'scroll',
]);

function actionType(action) {
  return String((action && action.type) || '').toLowerCase();
}

function isPageTransition(action) {
  return PAGE_TRANSITION_ACTIONS.has(actionType(action));
}

function isReadOnly(action) {
  return READ_ONLY_ACTIONS.has(actionType(action));
}

// 从动作推导「期望站点」提示（仅作高置信矛盾判定，缺失则不参与 site 矛盾判定）
function deriveExpectedSite(action) {
  const t = (action && action.target) || {};
  const url = String(t.url || '').toLowerCase();
  const sem = String(t.semantic || t.field || t.text || '').toLowerCase();
  if (/saas|控制台|cloud/.test(url) || /saas/.test(sem)) return 'saas';
  if (/upload|上传/.test(url) || /upload|上传|文件/.test(sem)) return 'upload';
  if (/download|下载/.test(url) || /download|下载/.test(sem)) return 'download';
  if (/shop|mall|商城|商品|订单|库存/.test(url) || /订单|商品|商城/.test(sem)) return 'shop';
  return null;
}

// 站点矛盾矩阵：期望站点 vs 当前页面状态 → 是否构成明显错配（E5）
const SITE_CONFLICT = {
  saas: ['PRODUCT_LISTING', 'SHOP_SEARCH_EMPTY', 'DOWNLOAD_PAGE', 'REGISTRATION', 'GENERIC'],
  upload: ['DOWNLOAD_PAGE', 'SHOP_SEARCH_EMPTY', 'PRODUCT_LISTING', 'GENERIC'],
};

// 动作语义 vs 页面状态 的直接矛盾（不依赖 expectedSite）
function semanticPageConflict(action, pageState) {
  const t = (action && action.target) || {};
  const sem = String(t.semantic || t.field || t.text || '').toLowerCase();
  const isUpload = /upload|上传|文件/.test(sem);
  if (isUpload && pageState.state === 'DOWNLOAD_PAGE') {
    return { blocked: true, code: 'CONTEXT_WRONG_APP', reason: '上传任务落在资源下载页，上下文明显错误（E5）' };
  }
  return null;
}

// Phase 9 P0：转场动作的「目标地址」矛盾判定。
// 守卫对象从「当前页」迁移到「目的地」，语义未削弱：
// 目标地址本身与期望站点冲突时仍然阻断（不是 bypass）。
function destinationConflict(action, expectedSite) {
  const url = String((action.target && action.target.url) || '').toLowerCase();
  if (!url) return null;
  if (expectedSite === 'upload' && /\/download|download\.html|download=/.test(url)) {
    return {
      blocked: true,
      code: 'CONTEXT_WRONG_APP',
      reason: `上传任务导航至下载页地址（${url.slice(0, 120)}），目标地址与期望站点冲突（E5）`,
    };
  }
  if (expectedSite === 'download' && /\/upload|upload\.html|upload=/.test(url)) {
    return {
      blocked: true,
      code: 'CONTEXT_WRONG_APP',
      reason: `下载任务导航至上传页地址（${url.slice(0, 120)}），目标地址与期望站点冲突（E5）`,
    };
  }
  if (expectedSite === 'saas' && /\/download\.html|\/download\//.test(url)) {
    return {
      blocked: true,
      code: 'CONTEXT_WRONG_APP',
      reason: `SaaS 任务导航至资源下载页地址（${url.slice(0, 120)}），目标地址与期望站点冲突（E5）`,
    };
  }
  return null;
}

// Phase 9 P0 — SaaS 页面证据评估（纯确定性规则，无 AI 判断，无 fallback）。
//
// 用途：pageStateClassifier 的 GENERIC 是「无明确应用特征」的兜底态，
// 并不等于「明确错误上下文」。因此当 expectedSite=saas 且页面为 GENERIC 时，
// 以证据决定放行/阻断：
//   - 结构性身份（URL 或 title 表明 SaaS）+ 至少 1 条佐证 → 放行
//   - 证据不足 → 仍然阻断（不 silent allow，不把 GENERIC 无条件映射为 SaaS）
//
// 严禁：GENERIC → always SaaS；严禁 catch-all 放行。
const SAAS_URL_RE = /(\/|=|\.)(saas|console|dashboard|admin|cloud|workspace|workbench)(\/|\.|\?|&|$)/i;
const SAAS_TITLE_RE = /(saas|cloud|cloudsaas|控制台|工作台|管理后台|dashboard|console)/i;
const SAAS_TEXT_RE = /(控制台|工作台|数据看板|订阅|工作区|租户|组织设置|团队成员|邀请成员|导出报表|活跃用户|企业邮箱)/;

function elementHaystack(el) {
  if (!el) return '';
  return String(
    [el.name, el.type, el.id, el.text, el.ariaLabel, el.placeholder, el.label, el.roleText].filter(Boolean).join(' ')
  ).toLowerCase();
}

function saasEvidence(obs) {
  const empty = { score: 0, signals: [], allow: false, structural: false };
  if (!obs || typeof obs !== 'object') return empty;

  const url = String(obs.url || '');
  const title = String(obs.title || '');
  const text = String(obs.textSummary || obs.visibleText || '').slice(0, 6000);
  const els = Array.isArray(obs.elements) ? obs.elements : [];

  const signals = [];
  let structural = false;

  if (SAAS_URL_RE.test(url)) { signals.push('url:saas_path'); structural = true; }
  if (SAAS_TITLE_RE.test(title)) { signals.push('title:saas_marker'); structural = true; }
  if (SAAS_TEXT_RE.test(text)) signals.push('text:saas_semantics');

  const hasEmailish = els.some((e) => /email|邮箱|username|用户名|企业邮箱|账号/.test(elementHaystack(e)));
  const hasPassword = els.some((e) =>
    String(e.type || '').toLowerCase() === 'password' || /password|密码/.test(elementHaystack(e))
  );
  if (hasEmailish && hasPassword) signals.push('dom:email_password_form');

  const hasSubmitish = els.some((e) => {
    const t = actionTypeOf(e);
    return (t === 'button' || String(e.role || '') === 'button') && /登录|sign in|log in|进入|提交|导出|邀请/.test(elementHaystack(e));
  });
  if (hasSubmitish) signals.push('dom:saas_action_button');

  const score = signals.length;
  // 放行条件：结构性身份（URL/title 至少其一）成立，且总证据数 >= 2。
  // 仅凭可见文本关键词不足以放行（避免任意页面被误判为 SaaS）。
  const allow = structural && score >= 2;
  return { score, signals, allow, structural };
}

function actionTypeOf(el) {
  return String((el && el.tag) || (el && el.type) || '').toLowerCase();
}

function guard(action, pageState, expectedSite, opts) {
  if (!action || !pageState) return { blocked: false, code: null, reason: null, evidence: null };
  const state = pageState.state;
  const site = expectedSite || deriveExpectedSite(action);
  const observation = (opts && opts.observation) || null;

  // 规则 1（E2）：需要目标元素的动作在空白页（SPA 未挂载/未就绪）上执行 → 阻止
  // 转场动作不适用：navigate 到目标地址正是脱离空白页的手段。
  if (ELEMENT_ACTIONS.has(action.type) && state === 'BLANK') {
    return {
      blocked: true,
      code: 'CONTEXT_NOT_READY',
      reason: `页面未就绪（空白页/SPA 未挂载），动作 ${action.type} 需目标元素，阻止执行（E2）`,
      evidence: null,
    };
  }

  // Phase 9 P0：只读/观察动作不参与上下文阻断。
  // 理由：观察不产生任何副作用，不会在错误上下文里改变业务状态；而阻断观察会让
  // agent 彻底失去诊断与恢复能力（phase68 中 28 次 inspect 被阻断即属此类）。
  // 真实错误上下文的阻断只对「会改变页面/业务状态」的动作生效，E5 语义未被削弱。
  if (isReadOnly(action)) {
    return { blocked: false, code: null, reason: null, evidence: null, guardMode: 'read_only' };
  }

  // Phase 9 P0：转场动作 —— 判定「目标地址」，不判定「当前页」。
  if (isPageTransition(action)) {
    const dc = destinationConflict(action, site);
    if (dc) return { ...dc, evidence: null };
    return { blocked: false, code: null, reason: null, evidence: null, guardMode: 'destination' };
  }

  // 规则 2（E5）：动作语义与页面状态直接矛盾（如上传任务落在下载页）
  const sp = semanticPageConflict(action, pageState);
  if (sp) return { ...sp, evidence: null };

  // 规则 3（E5）：期望站点与当前页面状态构成明显错配
  if (site && SITE_CONFLICT[site] && SITE_CONFLICT[site].includes(state)) {
    // Phase 9 P0：GENERIC 是「无明确特征」的兜底态，不等于「明确错误上下文」。
    // expectedSite=saas 时以证据裁决：强 SaaS 证据 → 放行；证据不足 → 仍阻断。
    if (site === 'saas' && state === 'GENERIC') {
      const ev = saasEvidence(observation);
      if (ev.allow) {
        return { blocked: false, code: null, reason: null, evidence: ev, guardMode: 'saas_evidence' };
      }
      return {
        blocked: true,
        code: 'CONTEXT_WRONG_APP',
        reason: `期望站点=saas 但当前页面无 SaaS 证据（signals=${ev.signals.join(',') || 'none'}），上下文可能错误（E5）`,
        evidence: ev,
      };
    }
    return {
      blocked: true,
      code: 'CONTEXT_WRONG_APP',
      reason: `期望站点=${site} 但当前页面状态=${state}，上下文明显错误（E5）`,
      evidence: null,
    };
  }

  return { blocked: false, code: null, reason: null, evidence: null };
}

module.exports = {
  guard,
  deriveExpectedSite,
  ELEMENT_ACTIONS,
  PAGE_TRANSITION_ACTIONS,
  READ_ONLY_ACTIONS,
  SITE_CONFLICT,
  semanticPageConflict,
  destinationConflict,
  saasEvidence,
  isPageTransition,
  isReadOnly,
};
