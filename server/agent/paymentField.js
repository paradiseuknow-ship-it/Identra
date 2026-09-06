'use strict';

// CAP-L1 —— 通用支付字段识别与取值。
//
// 为什么需要本模块（取证结论，见 PRODUCT_CORE_RUNTIME_AUDIT.md Q8）：
//   vault.js 从一开始就支持 card.{number,expMonth,expYear,cvv,name}，
//   secretManager.resolve() 也把它们解密出来了，但整条 AI 链路里
//   **没有任何一处**把「页面上的某个输入框」映射到「卡号的哪一部分」：
//     resolveFillValue 只认 email / password → 支付类任务必然卡在 fill。
//   支付是产品定位的核心卖点，这条链路是断的。
//
// 三条红线（改动前必读）：
//   1. **明文不出浏览器**。本模块只回答「该填什么值」，返回值只送到输入层
//      （humanType / locator.fill）。绝不写进 observation、action、事件、日志、trace。
//      填充后的 after-observation 由 observation.js 的敏感字段掩码兜底（见 SENSITIVE_TOKENS）。
//   2. **只认通用 Web 语义**。识别信号只有两类：
//        a) W3C HTML 标准的 autocomplete token（cc-number / cc-exp / cc-csc ...）
//           —— 这是站点自己声明的、跨站一致的字段语义，是唯一可判定且中立的信号；
//        b) 通用英文构词（cardnumber / cvv2 / expmonth ...）。
//      严禁出现站点名、品牌、品类、fixture、taskId 相关分支。test_step6_payment_capability.js
//      有源码红线扫描做护栏。
//   3. 不判定成功、不改验证语义、不绕过 3DS / 风控。

// ── 字段种类 ────────────────────────────────────────────────────────────────
const KIND = {
  CARD_NUMBER: 'cardNumber',
  CARD_NAME: 'cardName',
  EXPIRY: 'expiry',       // 组合字段（MM/YY）
  EXP_MONTH: 'expMonth',
  EXP_YEAR: 'expYear',
  CVV: 'cvv',
};

const PAYMENT_KINDS = new Set(Object.values(KIND));

// 全部支付字段都属于敏感字段：卡号 + 有效期 + CVV + 持卡人姓名合起来就是
// 「完整支付凭据」（用户红线：不把完整支付凭据暴露给 LLM / Memory / 日志 / trace）。
const SENSITIVE_KINDS = new Set(Object.values(KIND));

// ① autocomplete token（W3C HTML 规范，站点自声明，最可信）
const AUTOCOMPLETE_TOKENS = {
  'cc-number': KIND.CARD_NUMBER,
  'cc-name': KIND.CARD_NAME,
  'cc-exp': KIND.EXPIRY,
  'cc-exp-month': KIND.EXP_MONTH,
  'cc-exp-year': KIND.EXP_YEAR,
  'cc-csc': KIND.CVV,
};

// ② 归一化标识 → 种类的精确表。
//    归一化规则：小写 + 去掉所有非字母数字（card-number / card_number / Card Number → cardnumber）。
const EXACT = {
  // 卡号
  cardnumber: KIND.CARD_NUMBER,
  cardnum: KIND.CARD_NUMBER,
  cardno: KIND.CARD_NUMBER,
  ccnumber: KIND.CARD_NUMBER,
  ccnum: KIND.CARD_NUMBER,
  ccn: KIND.CARD_NUMBER,
  creditcard: KIND.CARD_NUMBER,
  creditcardnumber: KIND.CARD_NUMBER,
  creditcardno: KIND.CARD_NUMBER,
  debitcardnumber: KIND.CARD_NUMBER,
  cardpan: KIND.CARD_NUMBER,
  pan: KIND.CARD_NUMBER,
  accountnumber: null, // 银行账户号不是卡号，显式排除，避免误填

  // CVV / CVC / CSC
  cvv: KIND.CVV,
  cvv2: KIND.CVV,
  cvc: KIND.CVV,
  cvn: KIND.CVV,
  csc: KIND.CVV,
  // 刻意不含 'cid'：Amex 用它表示卡片校验码，但它在业务系统里更常是
  // customer id / category id，误判代价比漏判高得多（会把普通输入框的
  // 内容从 LLM 视野里抹掉）。'csc' 的碰撞面小得多，保留。
  securitycode: KIND.CVV,
  cardsecuritycode: KIND.CVV,
  cardcode: KIND.CVV,
  cardverificationvalue: KIND.CVV,
  cardverificationcode: KIND.CVV,
  cardverificationdata: KIND.CVV,
  securitynumber: KIND.CVV,

  // 有效期（月年合一）
  expiry: KIND.EXPIRY,
  expirydate: KIND.EXPIRY,
  expdate: KIND.EXPIRY,
  expiration: KIND.EXPIRY,
  expirationdate: KIND.EXPIRY,
  cardexpiry: KIND.EXPIRY,
  cardexpiration: KIND.EXPIRY,
  cardexp: KIND.EXPIRY,
  exp: KIND.EXPIRY,
  mmyy: KIND.EXPIRY,
  mmyyyy: KIND.EXPIRY,

  // 有效期（月 / 年分开）
  expmonth: KIND.EXP_MONTH,
  expirymonth: KIND.EXP_MONTH,
  expirationmonth: KIND.EXP_MONTH,
  cardexpmonth: KIND.EXP_MONTH,
  expmon: KIND.EXP_MONTH,
  expmo: KIND.EXP_MONTH,
  ccmonth: KIND.EXP_MONTH,
  cardmonth: KIND.EXP_MONTH,
  expyear: KIND.EXP_YEAR,
  expiryyear: KIND.EXP_YEAR,
  expirationyear: KIND.EXP_YEAR,
  cardexpyear: KIND.EXP_YEAR,
  expyr: KIND.EXP_YEAR,
  ccyear: KIND.EXP_YEAR,
  cardyear: KIND.EXP_YEAR,

  // 持卡人姓名
  cardname: KIND.CARD_NAME,
  nameoncard: KIND.CARD_NAME,
  cardholdername: KIND.CARD_NAME,
  cardholder: KIND.CARD_NAME,
  ccname: KIND.CARD_NAME,
  holdername: KIND.CARD_NAME,
  cardownername: KIND.CARD_NAME,
};

// ③ 弱别名：单独出现时含义不清（number/month/year/name 在任何表单里都有），
//    必须配合「卡/支付上下文」才成立。刻意不放宽到 checkout 这类弱语境之外。
const WEAK = {
  number: KIND.CARD_NUMBER,
  month: KIND.EXP_MONTH,
  year: KIND.EXP_YEAR,
  mm: KIND.EXP_MONTH,
  yy: KIND.EXP_YEAR,
  yyyy: KIND.EXP_YEAR,
  code: KIND.CVV,
  name: KIND.CARD_NAME,
};

// 强上下文：明确指涉「卡」的词（含卡组织，属支付领域的通用词汇，非站点品牌）
const CARD_CONTEXT_STRONG = /(card|credit|debit|\bcc\b|csc|cvv|cvc|visa|master ?card|amex|american express|jcb|discover|union ?pay|银联|信用卡|银行卡)/i;
// 宽上下文：支付/结账场景词（用于 number/month/year/code）
const CARD_CONTEXT_WIDE = /(payment|pay|checkout|billing|支付|付款|结账|结算|扣款)/i;

// 页内脱敏用的「精确命中」键集 = EXACT 表里所有真正映射到支付字段的键。
// observation.js 以 JSON 注入进页内脚本，与子串令牌 SENSITIVE_TOKENS 互补：
//   精确命中 —— name/id/placeholder/aria/autocomplete 归一化后**整体相等**
//               （'exp' / 'pan' / 'mmyy' 这类短词，子串匹配会误伤 panel / expand）
//   子串命中 —— 复合词（cardholdername 含 cardholder）
// 两者都从本文件导出，页内脚本不可能与 Node 侧漂移（SEC-E7 教训）。
const SENS_EXACT_KEYS = Object.keys(EXACT).filter((k) => EXACT[k] !== null);

// 页内脱敏令牌（observation.js 的 COLLECT_JS 通过 JSON 注入消费，单一真源）。
// 这些是「出现在 input 的 name/id/placeholder/aria-label/autocomplete 里就必须屏蔽 value」的词。
// 与 EXACT 表的差别：这是**子串**匹配（cardholdername 含 cardholder），且刻意保留历史令牌
// 以避免收窄既有脱敏覆盖（password / token / ssn 等）。
const SENSITIVE_TOKENS = [
  // 凭据类（历史既有，保持不动）
  'password', 'passwd', 'pwd', 'secret', 'token', 'otp', 'ssn', 'social',
  // CVV / 安全码
  'cvc', 'cvv', 'cvv2', 'csc', 'cvcode', 'securitycode', 'cardcode', 'cardsecurity',
  'cardverification', 'verificationcode', 'securitynumber',
  // 卡号
  'cardnumber', 'cardno', 'ccnumber', 'ccnum', 'creditcard', 'debitcard', 'cardpan',
  // 有效期
  'expiry', 'expdate', 'expiration', 'cardexp', 'expmonth', 'expyear', 'mmyy',
  // 持卡人
  'cardholder', 'nameoncard', 'cardname', 'holdername',
];

function normalize(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function tokensOf(s) {
  // autocomplete 可以是空格分隔的 token 列表（HTML 规范允许 section-* / shipping / billing 前缀）
  return String(s == null ? '' : s).toLowerCase().trim().split(/[\s,]+/).filter(Boolean);
}

/**
 * 判定一个输入元素属于哪种支付字段。
 *
 * @param {object} signals { autocomplete, name, id, placeholder, ariaLabel, label, text, type, field }
 * @returns {{ kind: string, via: string, confidence: number } | null}
 */
function classify(signals) {
  const s = signals || {};

  // ① autocomplete（站点自声明，最可信）
  for (const tok of tokensOf(s.autocomplete)) {
    const k = AUTOCOMPLETE_TOKENS[tok];
    if (k) return { kind: k, via: 'autocomplete:' + tok, confidence: 0.98 };
  }

  // ② name / id（精确表）
  const nName = normalize(s.name);
  const nId = normalize(s.id);
  if (nName && Object.prototype.hasOwnProperty.call(EXACT, nName)) {
    const k = EXACT[nName];
    if (k) return { kind: k, via: 'name:' + nName, confidence: 0.92 };
    // 显式排除项（如 accountnumber）→ 明确不是支付字段，直接返回 null，不再往下猜
    return null;
  }
  if (nId && Object.prototype.hasOwnProperty.call(EXACT, nId)) {
    const k = EXACT[nId];
    if (k) return { kind: k, via: 'id:' + nId, confidence: 0.9 };
    return null;
  }

  // ③ 可见文案（placeholder / aria-label / label / 语义文本 / target.field）
  const textKeys = ['placeholder', 'ariaLabel', 'label', 'text', 'field'];
  for (const key of textKeys) {
    const raw = s[key];
    if (!raw) continue;
    // 文本里可能带空格与标点："Card number" → cardnumber；"MM / YY" → mmyy
    const n = normalize(raw);
    if (n && Object.prototype.hasOwnProperty.call(EXACT, n)) {
      const k = EXACT[n];
      if (k) return { kind: k, via: key + ':' + n, confidence: 0.8 };
      return null;
    }
  }

  // ④ 弱别名 + 上下文。上下文只取「页面自己的词」：label / nearby / placeholder / aria，
  //    绝不引入站点知识。
  const ctxText = [s.label, s.placeholder, s.ariaLabel, s.text, s.nearbyText, s.containerText, s.field]
    .filter(Boolean).join(' ');
  if (ctxText) {
    for (const key of ['name', 'id']) {
      const n = normalize(s[key]);
      if (n && Object.prototype.hasOwnProperty.call(WEAK, n)) {
        const kind = WEAK[n];
        const needStrong = kind === KIND.CARD_NAME; // name 太宽泛，只认强上下文
        const hit = needStrong
          ? CARD_CONTEXT_STRONG.test(ctxText)
          : (CARD_CONTEXT_STRONG.test(ctxText) || CARD_CONTEXT_WIDE.test(ctxText));
        if (hit) return { kind, via: 'weak:' + key + ':' + n, confidence: 0.62 };
      }
    }
  }

  return null;
}

// 卡的「元数据」而非凭据本体：卡组织/卡种选择框。它们常叫 cardType / cardBrand，
// 命中历史子串规则 'card'，但填 'visa' 并不泄露任何凭据 —— 挡住它只会让正常任务失败。
const NON_SECRET_EXACT = new Set(['cardtype', 'cardbrand', 'cardissuer', 'cards', 'cardlist', 'cardnetwork']);

// 仅凭字段名（schema 校验场景，拿不到页面元素）判断是否为敏感字段。
//
// 为什么要重写：schema/action.js 原判定是 `SENSITIVE_FIELDS.includes(field.toLowerCase())`，
// 而 SENSITIVE_FIELDS 里写的是驼峰 'cardNumber' / 'apiKey' / 'passwordConfirm' ——
// 先 toLowerCase() 再比对一个驼峰列表，这三项**永远不可能命中**。
// 真实站点字段叫 cardnumber / cc-number / cvv2 / exp-month，同样一个都不命中。
// 结果：这条护栏在支付场景里形同虚设（模型可以合法地用 value 字面量带整串卡号）。
function isSensitiveFieldName(field) {
  const raw = String(field == null ? '' : field);
  if (!raw.trim()) return false;
  const n = normalize(raw);
  if (NON_SECRET_EXACT.has(n)) return false;
  const c = classify({ field: raw, name: raw });
  if (c && SENSITIVE_KINDS.has(c.kind)) return true;
  // 历史列表兜底（已全部小写化，修掉上面那个「驼峰永远命中不了」的 bug）
  return ['password', 'passwordconfirm', 'cvv', 'cvc', 'cardnumber', 'otp', 'card', 'token', 'secret', 'apikey']
    .some((t) => n.indexOf(t) >= 0);
}

// ── 取值格式化 ──────────────────────────────────────────────────────────────
const digits = (v) => String(v == null ? '' : v).replace(/\D+/g, '');
const pad2 = (v) => { const d = digits(v); return d ? d.slice(-2).padStart(2, '0') : ''; };

/**
 * 把 vault 里的卡信息格式化成「填进这个输入框的字符串」。
 * 返回 null 表示「凭据里没有这个字段」→ 上层走 NO_VALUE / CREDENTIAL_UNAVAILABLE，
 * 绝不静默填空串（静默填空串会让验证看到一个"填过了"的假象）。
 *
 * @param {string} kind     classify() 产出的种类
 * @param {object} card     vault 解密后的 { number, expMonth, expYear, cvv, name }
 * @param {object} opts     { maxlength } 元素上限长度（决定 MM/YY 还是 MM/YYYY）
 */
function formatValue(kind, card, opts) {
  const c = card || {};
  const o = opts || {};
  const maxlen = Number.isInteger(o.maxlength) && o.maxlength > 0 ? o.maxlength : null;

  if (kind === KIND.CARD_NUMBER) {
    const d = digits(c.number);
    return d || null;
  }
  if (kind === KIND.CVV) {
    const d = digits(c.cvv);
    return d || null;
  }
  if (kind === KIND.EXP_MONTH) {
    return pad2(c.expMonth) || null;
  }
  if (kind === KIND.EXP_YEAR) {
    const y = digits(c.expYear);
    if (!y) return null;
    // 无法凭空补世纪：存的是两位就原样给两位
    if (maxlen && maxlen <= 2) return y.slice(-2);
    return y.length >= 4 ? y.slice(-4) : y;
  }
  if (kind === KIND.EXPIRY) {
    const mm = pad2(c.expMonth);
    if (!mm) return null;
    const y = digits(c.expYear);
    if (!y) return null;
    const yy = (maxlen && maxlen >= 7) ? (y.length >= 4 ? y.slice(-4) : y) : y.slice(-2);
    // 站点输入掩码普遍会剥掉非数字，'/' 是最通用的分隔符形态
    return (maxlen && maxlen <= 4) ? (mm + yy) : (mm + '/' + yy);
  }
  if (kind === KIND.CARD_NAME) {
    const n = String(c.name == null ? '' : c.name).trim();
    return n || null;
  }
  return null;
}

module.exports = {
  KIND,
  PAYMENT_KINDS,
  SENSITIVE_KINDS,
  AUTOCOMPLETE_TOKENS,
  EXACT,
  WEAK,
  SENSITIVE_TOKENS,
  SENS_EXACT_KEYS,
  NON_SECRET_EXACT,
  normalize,
  classify,
  isSensitiveFieldName,
  formatValue,
  digits,
};
