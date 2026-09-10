'use strict';

/**
 * PHASE 17-A / P0-A —— Credential Action Authorization Gate（凭据动作授权闸）。
 *
 * 背景（真实站点 E2E 第 6 轮实证，域名见 .benchmark 取证，模块内刻意不写站点名）：
 *   任务目标为某 SaaS 注册流程；Agent 误点第三方授权入口 → 导航到第三方登录域
 *   （URL 形如 https://<third-party>/login?client_id=…&return_to=/login/oauth/authorize…）
 *   → planner 继续按原目标生成 fill，把环境凭据邮箱连续 4 次填进第三方登录框。
 *   这是**凭据外泄面**，不是普通失败：用户把邮箱/密码交给 Agent 是为了完成本站任务，
 *   不是为了让它们出现在任何第三方域。
 *
 * 为什么废弃 C106 F21 的「双向子域包含」判据：
 *   真实联盟链路的目标域与落地域经常是**两个毫不相干的品牌注册域**（互不为子串）。
 *   子域包含判据两头不讨好：既会把合法链路判成跨域（误杀），
 *   又没有任何一处能表达「用户是否真的授权了这个域」。字符串相似 ≠ 授权关系。
 *
 * 本模块的授权模型（Generic Authorization Context，无任何站点名）：
 *
 *   Task（用户指向的 targetUrl）
 *     → Authorized Flow（一次执行内的授权上下文）
 *       → Allowed Origins（显式授权：锚点域 + 任务显式声明；运行期授予只在当前域有效）
 *         → Credential Action（fill password / email / card / cvv / login …）
 *
 * 判定准则：
 *   1. 非凭据类动作不拦（不得误伤搜索框等普通输入）。
 *   2. 授权上下文缺失（无任务 / 无 targetUrl / 无法解析 origin）→ **fail closed** 拒绝。
 *   3. 当前页 origin ∈ 显式授权集合 → 放行（含站点自己的 OAuth 端点）。
 *   4. 当前页是**第三方授权/同意面**（OAuth/IdP 特征）且未被任务显式授权 → 拒绝。
 *      OAuth/IdP 一律**不继承**主站凭据授权。
 *   5. 其它未授权 origin → 拒绝（默认严格，fail closed）。
 *   6. 跨 origin iframe（元素所在文档 origin ≠ 页面 origin）→ 默认拒绝；同源 iframe 放行。
 *   7. 人机验证/反爬挑战页 → 拒绝（凭据绝不进挑战页）。
 *   8. 导航到新 origin 后，旧的**运行期授予**立即失效（旧上下文不得自动继承）。
 *
 * 红线：
 *   - 只做「拒绝 + 留痕 + 交人」，绝不产出任何绕过方案，绝不解题、绝不换环境重试。
 *   - 不判定成功、不改 verification 语义、不改 success definition。
 *   - 禁止任何域名白名单字面量（守护测试 P5.1 静态断言强制）。
 */

// 凭据/身份类字段：命中即视为高风险。
const CREDENTIAL_FIELDS = [
  'password', 'passwd', 'pwd', 'pass',
  'email', 'mail', 'username', 'login', 'userid', 'user_id',
  'card', 'cardnumber', 'card_number', 'cvv', 'cvv2', 'cvc', 'securitycode',
  'expiry', 'exp', 'ssn', 'secret', 'token', 'otp', 'code',
];

// 凭据类动作类型（不带具体 field 也算，例如 login / password_change）
const CREDENTIAL_ACTION_TYPES = ['login', 'password_change', 'payment', 'purchase'];

// 第三方授权/同意面的 URL 特征（通用协议特征，不含任何域名）
const OAUTH_PATH_RE = /\/(?:oauth2?|openid|authorize|consent)(?:\/|$|\?)/i;
const OAUTH_QUERY_KEYS = ['client_id', 'redirect_uri', 'response_type', 'scope', 'code_challenge'];

function hostOf(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const h = new URL(url).hostname;
    return h ? String(h).toLowerCase() : null;
  } catch (e) {
    return null; // 相对路径等非法绝对 URL：无 host 可判定
  }
}

/** origin（scheme://host[:port]）；端口为协议默认端口时省略，保证语义一致。 */
function originOf(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (!u.hostname) return null;
    return u.origin && u.origin !== 'null' ? String(u.origin).toLowerCase() : null;
  } catch (e) {
    return null;
  }
}

/**
 * 是否属于「不承载 origin 的本地上下文」（about:blank / data: / blob: / file:）。
 *
 * 为什么必须与「origin 不可解析」区分开（C107 自测暴露的 P0-A B 类缺陷）：
 *   浏览器新页面的初始地址就是 about:blank，产品 launch 还会先打开一个 data: 欢迎页。
 *   这两类地址的 `location.origin` 恒为字符串 "null" —— 于是 originOf 返回 null，
 *   被旧实现归入 `PAGE_ORIGIN_UNKNOWN` → 拒绝。
 *   后果：**任何任务的第一步凭据 fill 都会被拒绝**（正常工作流直接死掉），
 *   而 R6 真实外泄场景（漂移到第三方 https 域）根本不经过这条分支。
 *   即：旧实现把「没有 origin」误当成「origin 未授权」，是纯粹的假阳性。
 *
 * 安全边界（为什么不等于放行）：
 *   这类上下文既不承载第三方站点、也不承载本站凭据输入 —— 页面上不存在任何
 *   「属于某个 site 的凭据框」。真正的风险动作发生的前提是「页面已在一个 http(s) origin 上」，
 *   因此这里**不放行凭据动作**，而是要求先完成导航：返回 false 让上层走
 *   `NO_ORIGIN_CONTEXT` 拒绝 + 留痕（fail closed，但归因正确、可恢复）。
 */
function isOriginlessLocalContext(url) {
  const s = String(url || '').trim();
  if (!s) return true; // 空 URL 视为尚未进入任何文档
  if (s === 'about:blank') return true;
  if (/^about:/i.test(s)) return true;
  if (/^data:/i.test(s)) return true;
  if (/^blob:/i.test(s)) return true;
  if (/^file:/i.test(s)) return true;
  return false;
}

/** 该动作是否属于「凭据类」：credentialRef、敏感 field，或凭据类动作类型。 */
function isCredentialAction(action) {
  const a = action || {};
  const t = a.target || {};
  if (t.credentialRef) return true;
  if (CREDENTIAL_ACTION_TYPES.indexOf(a.type) >= 0) return true;
  const field = String(t.field || '').toLowerCase().trim();
  if (field && CREDENTIAL_FIELDS.indexOf(field) >= 0) return true;
  // field 可能是复合键（如 "billing.card"）—— 取最后一段再判
  if (field && field.indexOf('.') >= 0) {
    const tail = field.split('.').pop();
    if (tail && CREDENTIAL_FIELDS.indexOf(tail) >= 0) return true;
  }
  // semantic 仅在**没有** field 时参与判定：避免把「点密码框旁边的按钮」误判成凭据动作
  if (!field) {
    const sem = String(t.semantic || '').toLowerCase().trim();
    if (sem && CREDENTIAL_FIELDS.indexOf(sem) >= 0) return true;
  }
  return false;
}

/**
 * 是否为第三方授权/同意面（OAuth / OIDC / IdP consent）。
 * 判据全部来自 URL 自身的协议特征，与域名无关。
 */
function isThirdPartyAuthSurface(opts) {
  const o = opts || {};
  let u = null;
  try { u = new URL(String(o.url || '')); } catch (e) { return false; }
  const p = String(u.pathname || '').toLowerCase();
  const q = String(u.search || '').toLowerCase();
  if (OAUTH_PATH_RE.test(p)) return true;
  if (p.indexOf('/oauth') >= 0) return true;
  const has = (k) => q.indexOf(k + '=') >= 0;
  if (has('client_id') && (has('redirect_uri') || has('response_type') || has('scope'))) return true;
  if (has('return_to') && /oauth|authorize|consent/i.test(q)) return true;
  if (has('code_challenge') || (has('prompt') && q.indexOf('consent') >= 0)) return true;
  return false;
}

/** 任务级显式授权声明归一化（非法/缺失一律返回 null → 严格默认）。 */
function normalize(input) {
  if (!input || typeof input !== 'object') return null;
  const origins = [];
  const pushOrigin = (v) => {
    const o = originOf(v);
    if (o && origins.indexOf(o) < 0) origins.push(o);
  };
  if (Array.isArray(input.authorizedOrigins)) input.authorizedOrigins.forEach(pushOrigin);
  const oauth = [];
  if (Array.isArray(input.allowedOAuthProviders)) {
    input.allowedOAuthProviders.forEach((v) => {
      // provider 可写成 URL 或裸 host（"https://idp.example/login" 与 "idp.example" 都收）
      const h = hostOf(v) || (/^[a-z0-9.-]+$/i.test(String(v || '').trim()) ? String(v).trim().toLowerCase() : null);
      if (h && oauth.indexOf(h) < 0) oauth.push(h);
    });
  }
  return {
    authorizedOrigins: origins,
    allowedOAuthProviders: oauth,
    // 运行期自动授予「流程跳转到的新域」——默认关闭（fail closed）。
    authorizeFlowTransitions: input.authorizeFlowTransitions === true,
  };
}

/**
 * 建立授权上下文（每执行一个）。
 * @param {object} opts { task, executionId }
 */
function createContext(opts) {
  const o = opts || {};
  const task = o.task || null;
  const anchor = originOf(task && task.targetUrl);
  const decl = normalize(task && task.credentialAuthorization);
  const explicit = [];
  if (anchor && explicit.indexOf(anchor) < 0) explicit.push(anchor);
  if (decl) decl.authorizedOrigins.forEach((x) => { if (explicit.indexOf(x) < 0) explicit.push(x); });
  return {
    flowId: String((task && task.id) || '?') + '::' + String(o.executionId || '?'),
    anchorOrigin: anchor,
    explicitOrigins: explicit,
    allowedOAuthProviders: decl ? decl.allowedOAuthProviders.slice() : [],
    authorizeFlowTransitions: !!(decl && decl.authorizeFlowTransitions),
    // 运行期授予：只在**授予时的那个 origin** 有效，导航即清空（A6）。
    runtimeGrants: [],
    flowOrigin: null,
    transitions: [],
  };
}

/**
 * 导航记账：origin 变化即清空运行期授予 —— 旧授权上下文不得自动继承（A6）。
 * @returns {boolean} 是否发生了跨 origin 跳转
 */
function noteNavigation(ctx, pageUrl) {
  if (!ctx) return false;
  const o = originOf(pageUrl);
  if (!o) return false;
  const changed = ctx.flowOrigin && ctx.flowOrigin !== o;
  ctx.flowOrigin = o;
  if (changed && ctx.runtimeGrants.length) {
    ctx.transitions.push({ from: ctx.flowOrigin, to: o, clearedGrants: ctx.runtimeGrants.slice(), at: Date.now() });
    ctx.runtimeGrants = [];
  }
  return !!changed;
}

/** 显式授予某个 origin（人工批准 / 任务显式开启流程跳转授权时调用）。 */
function grantOrigin(ctx, origin, reason) {
  if (!ctx || !origin) return false;
  if (ctx.runtimeGrants.indexOf(origin) < 0) ctx.runtimeGrants.push(origin);
  ctx.transitions.push({ grant: origin, reason: reason || null, at: Date.now() });
  return true;
}

/**
 * 凭据动作授权判定。
 *
 * @param {object} opts
 *   context        createContext 产出（缺失 = 授权上下文缺失 → fail closed）
 *   pageUrl        当前主文档 URL
 *   elementOrigin  目标元素所在文档 origin（iframe 场景；与 pageUrl 同源可省略）
 *   action         待执行动作
 *   challenge      { blocked:boolean } 挑战页判定（可空）
 * @returns {{allowed:boolean, reason:string|null, pageOrigin:string|null, anchorOrigin:string|null, evidence:string[]}}
 */
function authorize(opts) {
  const o = opts || {};
  const action = o.action || {};
  const pageOrigin = originOf(o.pageUrl);
  const ctx = o.context || null;
  const evidence = [];

  // 1) 非凭据类动作：不拦（不得误伤普通浏览）
  if (!isCredentialAction(action)) {
    return { allowed: true, reason: null, pageOrigin, anchorOrigin: ctx ? ctx.anchorOrigin : null, evidence: ['not_credential_action'] };
  }

  // 2) 授权上下文缺失 → fail closed（A7）
  if (!ctx || !ctx.anchorOrigin) {
    return {
      allowed: false, reason: 'AUTHORIZATION_CONTEXT_MISSING', pageOrigin,
      anchorOrigin: ctx ? ctx.anchorOrigin : null,
      evidence: ['凭据类动作缺少授权上下文（任务缺失或 targetUrl 不可解析），默认拒绝'],
    };
  }
  // 3) 当前处于「不承载 origin 的本地上下文」（about:blank / data: / blob: / file:）
  //    → fail closed，但归因与「origin 未授权」严格区分（C107 B 类缺陷修复）。
  //    归因正确的意义：缺失的是「页面尚未进入任何一个站点」这一事实，
  //    正确的恢复是「先导航到授权 origin」，而不是「该域未获授权」。
  if (!pageOrigin && isOriginlessLocalContext(o.pageUrl)) {
    return {
      allowed: false, reason: 'NO_ORIGIN_CONTEXT', pageOrigin: null, anchorOrigin: ctx.anchorOrigin,
      evidence: ['当前页为不承载 origin 的本地上下文（about:blank/data:），尚未进入任何站点；'
        + '凭据动作需先在已授权 origin 上执行'],
    };
  }
  // 3b) 当前页 origin 不可判定 → fail closed（无法证明授权）
  if (!pageOrigin) {
    return {
      allowed: false, reason: 'PAGE_ORIGIN_UNKNOWN', pageOrigin: null, anchorOrigin: ctx.anchorOrigin,
      evidence: ['当前页 origin 不可解析，无法证明授权，默认拒绝'],
    };
  }

  // 4) 挑战页：凭据绝不进人机验证页（A8）
  if (o.challenge && o.challenge.blocked) {
    return {
      allowed: false, reason: 'SECURITY_CHALLENGE', pageOrigin, anchorOrigin: ctx.anchorOrigin,
      evidence: ['当前页判定为人机验证/反爬挑战页，拒绝凭据类输入（不解题、不绕过）'],
    };
  }

  // 5) 元素所在文档 origin（iframe）：跨 origin 默认拒绝（A5）；同源放行（A4）
  const elOrigin = originOf(o.elementOrigin);
  if (elOrigin && elOrigin !== pageOrigin) {
    if (ctx.explicitOrigins.indexOf(elOrigin) >= 0 && ctx.explicitOrigins.indexOf(pageOrigin) >= 0) {
      evidence.push('cross_origin_frame_both_authorized');
    } else {
      return {
        allowed: false, reason: 'CROSS_ORIGIN_FRAME', pageOrigin, anchorOrigin: ctx.anchorOrigin,
        elementOrigin: elOrigin,
        evidence: ['目标元素位于跨 origin 文档 ' + elOrigin + '，凭据类输入默认拒绝'],
      };
    }
  }

  noteNavigation(ctx, o.pageUrl);

  // 6) 显式授权 → 放行（含站点自身的授权端点，A1）
  if (ctx.explicitOrigins.indexOf(pageOrigin) >= 0) {
    return { allowed: true, reason: null, pageOrigin, anchorOrigin: ctx.anchorOrigin, evidence: ['origin_explicitly_authorized'] };
  }

  // 7) 第三方授权/同意面：除非任务显式授权该 provider，否则凭据一律不得进（A3）
  if (isThirdPartyAuthSurface({ url: o.pageUrl })) {
    const providerAllowed = ctx.allowedOAuthProviders.indexOf(hostOf(o.pageUrl)) >= 0;
    if (!providerAllowed) {
      return {
        allowed: false, reason: 'THIRD_PARTY_AUTH_SURFACE_UNAUTHORIZED', pageOrigin, anchorOrigin: ctx.anchorOrigin,
        evidence: ['当前页为第三方授权/同意面（OAuth 特征），不继承主站凭据授权'],
      };
    }
    evidence.push('oauth_provider_explicitly_authorized');
    return { allowed: true, reason: null, pageOrigin, anchorOrigin: ctx.anchorOrigin, evidence };
  }

  // 8) 运行期授予（origin 作用域，导航已清空）
  if (ctx.runtimeGrants.indexOf(pageOrigin) >= 0) {
    return { allowed: true, reason: null, pageOrigin, anchorOrigin: ctx.anchorOrigin, evidence: ['origin_runtime_granted'] };
  }

  // 9) 任务显式开启「流程跳转自动授权」且非授权面 → 授予当前域（opt-in，默认关闭）
  if (ctx.authorizeFlowTransitions) {
    grantOrigin(ctx, pageOrigin, 'flow_transition_authorized_by_task');
    return { allowed: true, reason: null, pageOrigin, anchorOrigin: ctx.anchorOrigin, evidence: ['flow_transition_auto_granted'] };
  }

  // 10) 其余一律拒绝（A2：不同注册域之间的跳转不继承授权）
  return {
    allowed: false, reason: 'ORIGIN_NOT_AUTHORIZED', pageOrigin, anchorOrigin: ctx.anchorOrigin,
    evidence: ['当前 origin 不在授权上下文中；跨注册域跳转不继承凭据授权'],
  };
}

// ── 授权上下文缓存（每 task::execution 一份）────────────────────────────
// 运行期状态（运行期授予 / 已见 origin）只在进程内、只在当前执行内有效，
// 绝不随任务持久化 —— 下一次执行必须重新证明授权。
const CONTEXT_CACHE_LIMIT = 2000;
const contexts = new Map();

function flowKey(task, executionId) {
  return String((task && task.id) || '?') + '::' + String(executionId || '?');
}

/**
 * 取（或建）当前执行的授权上下文。
 * 每次调用都按任务当前声明刷新「显式授权集合」，使人工批准后新增的授权立即生效。
 */
function contextFor(task, executionId) {
  const key = flowKey(task, executionId);
  let ctx = contexts.get(key);
  if (!ctx) {
    if (contexts.size >= CONTEXT_CACHE_LIMIT) contexts.clear();
    ctx = createContext({ task, executionId });
    contexts.set(key, ctx);
    return ctx;
  }
  const decl = normalize(task && task.credentialAuthorization);
  const anchor = originOf(task && task.targetUrl);
  const explicit = [];
  if (anchor) explicit.push(anchor);
  if (decl) decl.authorizedOrigins.forEach((x) => { if (explicit.indexOf(x) < 0) explicit.push(x); });
  ctx.anchorOrigin = anchor;
  ctx.explicitOrigins = explicit;
  ctx.allowedOAuthProviders = decl ? decl.allowedOAuthProviders.slice() : [];
  ctx.authorizeFlowTransitions = !!(decl && decl.authorizeFlowTransitions);
  return ctx;
}

/** 释放某执行（或全部）上下文 —— 测试与任务终态清理用。 */
function resetContexts(task, executionId) {
  if (!task) { contexts.clear(); return; }
  contexts.delete(flowKey(task, executionId));
}

module.exports = {
  contextFor,
  resetContexts,
  CREDENTIAL_FIELDS,
  CREDENTIAL_ACTION_TYPES,
  hostOf,
  originOf,
  isOriginlessLocalContext,
  isCredentialAction,
  isThirdPartyAuthSurface,
  normalize,
  createContext,
  noteNavigation,
  grantOrigin,
  authorize,
};
