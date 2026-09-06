'use strict';

// CAP-L2 —— 支付结果五态分类器（纯函数，只读）。
//
// 背景（取证）：
//   businessErrorDetector 只有一个 `BUSINESS_PAYMENT_FAILED` 粗粒度桶 —— 支付被拒、
//   需要 3DS 挑战、异步处理中、彻底失败，四种截然不同的结局被压成同一个「失败」。
//   后果在 STEP 3/4 被放大：四者全部走 `escalate`，于是「支付还在处理中」也被判成
//   「继续尝试不可能成功」直接丢给人；而「已授权」则完全没有任何识别路径。
//
//   支付是产品定位的核心卖点，「付没付成」必须是可判定的，不能只有一个二进制失败位。
//
// 五态语义：
//   authorized  —— 已授权/已扣款/已完成（唯一可视为业务达成的一态）
//   declined    —— 发卡行/网关明确拒付（换支付方式才可能成功）
//   3ds_challenge —— 需要持卡人完成 3-D Secure / 风控挑战（**只能转人工**）
//   pending     —— 异步处理中（等待 + 重新观察，绝不重放支付动作）
//   failed      —— 处理失败但未给出拒付原因
//
// 红线（改动前必读）：
//   1. **绝不绕过 3DS / 风控**。3ds_challenge 唯一出口是 escalate（交给人），
//      本模块不产出也不允许产出任何「自动完成验证」的路径。
//   2. **pending 绝不重放动作**。重复提交支付 = 重复扣款，是资金损失级事故。
//      pending 的恢复只能是「等待 + 重新观察」（wait_only），
//      刻意**不包含 reload** —— 支付 POST 之后 reload 会触发浏览器
//      「确认重新提交表单」，一旦被自动确认就是第二次扣款。
//   3. 不判定成功、不改验证语义、不动 success definition。本模块只产出
//      「支付处于什么状态」这个事实，由 diagnosis 决定重试策略。
//   4. 所有模式必须是通用 Web 语义（Stripe/PayPal/Adyen 等网关的通用字段命名 +
//      中英文通用文案），严禁站点/品牌/品类相关分支。

// ── 状态 ────────────────────────────────────────────────────────────────────
const STATE = {
  AUTHORIZED: 'authorized',
  DECLINED: 'declined',
  THREE_DS: 'three_ds_challenge',
  PENDING: 'pending',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
};

// 匹配顺序 = 优先级。3DS 排第一：它需要人立刻介入，且「requires_action」这类
// 网关字段常与 pending 文案共存，必须先被认出来，否则会被误判成「再等等」。
const PATTERNS = [
  {
    state: STATE.THREE_DS,
    re: /(\b3[\s_-]?d[\s_-]?secure\b|\b3ds2?\b|\bacs\b[\s_-]?(url|redirect|challenge)|(authentication|challenge)[\s_-]?(url|redirect|required)|requires[\s_-]?action|action[\s_-]?required|authenticate[\s_-]?(your|the)[\s_-]?(card|payment|identity)|verify[\s_-]?your[\s_-]?(card|identity|payment)|complete[\s_-]?(the[\s_-]?)?(payment[\s_-]?)?(authentication|verification)|3D验证|三维验证|持卡人(身份)?验证|支付验证|安全验证|请(完成|进行)(支付)?(身份|安全)?验证)/i,
  },
  {
    state: STATE.AUTHORIZED,
    re: (() => new RegExp([
      '\\b(payment|transaction|charge|order|invoice)[\\s_-]?(intent[\\s_-]?)?(status|state)?[\\s\\\'\\"]*[:=][\\s\\\'\\"]*(succeeded|successful|success|paid|approved|captured|authorized|settled|complete[d]?|charged)\\b',
      '\\b(status|state)[\\s\\\'\\"]*[:=][\\s\\\'\\"]*(succeeded|paid|approved|captured|authorized|complete[d]?)\\b',
      '\\b(payment|charge|transaction|order)[\\s_-]?(was|has[\\s_-]?been|is)?[\\s_-]?(successful|approved|completed|paid|authorized|captured|processed)\\b',
      '(thank[\\s_-]?you[\\s_-]?for[\\s_-]?your[\\s_-]?(order|purchase)|your[\\s_-]?(order|payment)[\\s_-]?(is|was|has[\\s_-]?been)[\\s_-]?(confirmed|placed|received|completed|successful))',
      '(支付成功|付款成功|扣款成功|交易成功|已支付|支付完成|付款完成|订单(已)?(支付|提交)成功|扣款完成)',
    ].join('|'), 'i'))(),
  },
  {
    state: STATE.DECLINED,
    re: (() => new RegExp([
      '\\b(card|payment|charge|transaction)[\\s_-]?(was|has[\\s_-]?been)?[\\s_-]?(declined|rejected|refused|not[\\s_-]?authorized|unauthorized)\\b',
      '\\bdo[\\s_-]?not[\\s_-]?honor\\b|\\binsufficient[\\s_-]?funds\\b|\\bexpired[\\s_-]?card\\b|\\bincorrect[\\s_-]?(card[\\s_-]?)?number\\b|\\binvalid[\\s_-]?(card|account)[\\s_-]?number\\b|\\b(lost|stolen)[\\s_-]?card\\b|\\bpick[\\s_-]?up[\\s_-]?card\\b',
      '\\b(card[\\s_-]?declined|payment[\\s_-]?declined|declined[\\s_-]?by[\\s_-]?(the[\\s_-]?)?(bank|issuer))\\b',
      '(银行(拒绝|拒付|退票|不予承兑)|发卡(行|银行)拒绝|余额不足|额度不足|卡号(无效|错误|已过期|不存在)|卡片(已)?(过期|失效|被拒)|支付被拒|付款被拒|拒绝交易)',
    ].join('|'), 'i'))(),
  },
  {
    state: STATE.FAILED,
    re: (() => new RegExp([
      '\\b(payment|charge|transaction|order)[\\s_-]?(has|had)?[\\s_-]?failed\\b',
      '\\bfailed[\\s_-]?to[\\s_-]?(charge|process|take|complete)[\\s_-]?(the[\\s_-]?)?(payment|card|order|transaction)?\\b',
      '\\bunable[\\s_-]?to[\\s_-]?(process|complete|charge)[\\s_-]?(the[\\s_-]?)?(payment|card|order|transaction)\\b',
      '\\bpayment[\\s_-]?(error|exception|failure)\\b',
      '(支付失败|付款失败|扣款失败|交易失败|支付异常|付款异常|未能完成(支付|付款)|支付未成功)',
    ].join('|'), 'i'))(),
  },
  {
    state: STATE.PENDING,
    re: (() => new RegExp([
      '\\b(payment|transaction|charge|order)[\\s_-]?(is|was)?[\\s_-]?(pending|processing|in[\\s_-]?progress|awaiting|being[\\s_-]?processed|queued|submitted)\\b',
      '\\b(status|state)[\\s\\\'\\"]*[:=][\\s\\\'\\"]*(requires[\\s_-]?(capture|confirmation)|pending|processing|in[\\s_-]?progress)\\b',
      '(支付中|付款中|扣款中|处理中|正在处理|交易处理中|等待(支付|付款|确认|银行)|请稍候.*(支付|付款))',
    ].join('|'), 'i'))(),
  },
];

// pending 的排除项：同一段文本里若已出现失败语义，就不是「还在处理中」。
// 例："payment processing failed" 既命中 pending 又命中 failed —— 必须判 failed，
// 否则系统会在一笔已经失败的支付上继续等待。
const FAIL_MARKER = /(fail(ed|ure)?|declin(ed|e)|reject(ed)?|refus(ed|e)|error|unable|can ?not|could ?not|失败|被拒|异常)/i;

// HTTP 402 Payment Required：语义上是「需要付款」而非「已付款」，
// 出现在支付提交之后只可能意味着这次支付没成功。
const PAYMENT_STATUS_CODES = { 402: STATE.FAILED };

function haystack(network) {
  const parts = [];
  const push = (list) => {
    for (const r of list || []) {
      if (r && r.bodyPreview) parts.push(String(r.bodyPreview));
      if (r && r.url) parts.push(String(r.url));
    }
  };
  push(network && network.apiResponses);
  push(network && network.failures);
  return parts.join('\n');
}

/**
 * 判定支付状态。
 *
 * @param {object} input
 *   network   networkObserver.snapshot 输出（含 apiResponses / failures）
 *   pageText  页面可见文本（textSummary / visibleText）
 * @returns {{ state, confidence, evidence, hint, source }}
 */
function classify(input = {}) {
  const network = input.network || null;
  const pageText = String(input.pageText || '');
  const unknown = {
    state: STATE.UNKNOWN, confidence: 0, evidence: null, hint: '未检测到支付结果信号', source: null,
  };

  // ① 网络响应体（最客观：网关的 status 字段是机器语义，不受文案措辞影响）
  const body = haystack(network);
  if (body) {
    const hit = matchIn(body);
    if (hit) {
      return {
        state: hit.state,
        confidence: 0.92,
        evidence: { source: 'network.body', matched: hit.matched },
        source: 'network.body',
        hint: HINTS[hit.state],
      };
    }
  }

  // ② HTTP 状态码
  for (const r of [].concat((network && network.apiResponses) || [], (network && network.failures) || [])) {
    if (!r || typeof r.status !== 'number') continue;
    const st = PAYMENT_STATUS_CODES[r.status];
    if (st) {
      return {
        state: st, confidence: 0.8,
        evidence: { source: 'network.status', status: r.status, url: r.url },
        source: 'network.status', hint: HINTS[st],
      };
    }
  }

  // ③ 页面文本（最不客观：可能只是表单标签，因此置信度最低）
  if (pageText) {
    const hit = matchIn(pageText);
    if (hit) {
      return {
        state: hit.state,
        confidence: 0.6,
        evidence: { source: 'page.text', matched: hit.matched },
        source: 'page.text', hint: HINTS[hit.state],
      };
    }
  }

  return unknown;
}

function matchIn(text) {
  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (!m) continue;
    // pending 的失败排除：命中 pending 但同一段文本有失败语义 → 判 failed
    if (p.state === STATE.PENDING && FAIL_MARKER.test(text)) {
      return { state: STATE.FAILED, matched: String(m[0]).slice(0, 160) };
    }
    return { state: p.state, matched: String(m[0]).slice(0, 160) };
  }
  return null;
}

const HINTS = {
  [STATE.AUTHORIZED]: '支付已授权/完成 —— 无需重试，任何重试都可能导致重复扣款',
  [STATE.DECLINED]: '发卡行/网关明确拒付 —— 需更换支付方式或确认额度',
  [STATE.THREE_DS]: '需要持卡人完成 3-D Secure / 风控验证 —— 必须转人工，系统绝不尝试绕过',
  [STATE.PENDING]: '支付异步处理中 —— 只能等待后重新观察，绝不重放支付动作（防重复扣款）',
  [STATE.FAILED]: '支付处理失败且未给出拒付原因 —— 转人工确认资金状态后再决定',
  [STATE.UNKNOWN]: '未检测到支付结果信号',
};

// 状态 → 重试策略（failureDiagnoser 消费）
// ⚠️ 'wait_only' 是 CAP-L2 新增的策略：只允许「等待 + 重新观察」，
//    刻意不含 reload / back，因为支付提交后的重复提交等于重复扣款。
const RETRY_POLICY_BY_PAYMENT_STATE = {
  [STATE.AUTHORIZED]: 'none',
  [STATE.DECLINED]: 'escalate',
  [STATE.THREE_DS]: 'escalate',
  [STATE.PENDING]: 'wait_only',
  [STATE.FAILED]: 'escalate',
  [STATE.UNKNOWN]: null,
};

// 状态码（failureDiagnoser 的 rootCause 命名）
const codeOf = (state) => 'PAYMENT_' + String(state).toUpperCase();

module.exports = {
  STATE,
  PATTERNS,
  HINTS,
  RETRY_POLICY_BY_PAYMENT_STATE,
  classify,
  codeOf,
};
