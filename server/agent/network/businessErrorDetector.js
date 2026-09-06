'use strict';

// STEP 2 —— Business Error Detector：从「网络 + 运行时 + 页面文本」识别真实业务失败。
//
// 核心命题（STEP 0 取证）：
//   真实网站最常见的失败形态不是 HTTP 500，而是 **HTTP 200 + 业务错误体**：
//     提交注册 → 200 + {"error":"email already registered"} → 页面多一行红字
//     登录     → 200 + {"error":"invalid_credentials"}      → 页面多一行红字
//   改造前系统只看 DOM，于是 DOM_CHANGED=true 被当成"动作产生了影响"，
//   而真正的失败原因（邮箱重复 / 密码错误 / 需要验证码）无人读取，
//   结果是零信息原样重试 —— phase68 中 51.3% 的 VERIFY_FAILED 属此类。
//
// 本模块是**纯函数诊断器**：只读输入，产出 findings，不判定成功、不改验证语义、
// 不触发任何动作。修复动作属于 STEP 4（Self-Healing）的职责。
//
// 红线：所有模式必须是**通用 Web 语义**，不得出现任何站点/品类/品牌相关词。
//       test_step2_network_intelligence.js 有源码红线扫描做护栏。
//
// 严重度：
//   blocking —— 继续重试同一动作不可能成功，必须先换策略（换凭据/过验证码/换路径）
//   warning  —— 可能是根因，需要结合其它证据
//   info     —— 仅作诊断线索

// ── HTTP 状态码 → 语义化失败 ────────────────────────────────────────────────
const STATUS_FINDINGS = {
  401: { code: 'HTTP_401_UNAUTHORIZED', severity: 'blocking', hint: '需要登录或凭据已失效，重试同一动作无意义' },
  403: { code: 'HTTP_403_FORBIDDEN', severity: 'blocking', hint: '无访问权限（权限/风控/IP 限制），重试同一动作无意义' },
  404: { code: 'HTTP_404_NOT_FOUND', severity: 'blocking', hint: '目标资源不存在，应重新定位入口而非重试' },
  409: { code: 'HTTP_409_CONFLICT', severity: 'blocking', hint: '资源冲突（通常意味着已存在/重复提交），应改用已存在资源' },
  410: { code: 'HTTP_410_GONE', severity: 'blocking', hint: '资源已永久移除' },
  419: { code: 'HTTP_419_SESSION_EXPIRED', severity: 'blocking', hint: '会话/CSRF Token 过期，需重新加载页面后再操作' },
  422: { code: 'HTTP_422_VALIDATION_FAILED', severity: 'blocking', hint: '服务端校验未通过，需修正输入内容而非重试' },
  429: { code: 'HTTP_429_RATE_LIMITED', severity: 'warning', hint: '触发限流，应退避等待后重试' },
};

// ── 业务错误语义（按严重度从高到低匹配，先命中先返回）────────────────────────
// 每个模式都必须是「任何网站都可能返回的通用语义」。
const BUSINESS_ERROR_PATTERNS = [
  {
    code: 'BUSINESS_DUPLICATE_EMAIL', severity: 'blocking',
    re: /(email[_\s-]?(address)?[_\s-]?(is[_\s-]?)?(already[_\s-]?(registered|exists|in[_\s-]?use|taken))|(mail|e-?mail)[^\n]{0,12}(already|duplicate)[^\n]{0,20}(registered|exists|taken)|该?邮箱[^\n]{0,6}(已被|已)?(注册|占用|存在)|邮箱重复|duplicate[_\s-]?(email|key|entry)|already\s+registered)/i,
    hint: '该邮箱已被注册，重试同一注册动作必然失败；应改用登录或更换邮箱',
  },
  {
    code: 'BUSINESS_DUPLICATE_RECORD', severity: 'blocking',
    re: /(record|entry|name|username|phone|mobile|code)[^\n]{0,12}(already[_\s-]?(exists|in[_\s-]?use|taken))|already\s+exists|duplicate\s+(record|entry|name|key)|已存在|重复(创建|提交|添加)?|该(名称|用户名|手机号|编码)已(存在|被占用)/i,
    hint: '目标记录已存在，应改用更新/查询而非新建',
  },
  {
    code: 'BUSINESS_INVALID_CREDENTIAL', severity: 'blocking',
    re: /((invalid|incorrect|wrong)[_\s-]?(e-?mail[_\s-]?(or[_\s-]?)?|username[_\s-]?(or[_\s-]?)?)?password|password[_\s-]?(is[_\s-]?)?(invalid|incorrect|wrong)|(邮箱|用户名|账号|密码)[或和与]?密码?错误|密码不正确|credential(s)?[_\s-]?(invalid|incorrect)|bad[_\s-]?credential)/i,
    hint: '凭据错误，重试同一密码必然失败；应更换凭据或触发找回流程',
  },
  {
    code: 'BUSINESS_SESSION_EXPIRED', severity: 'blocking',
    re: /(session[_\s-]?(expired|invalid|timeout)|token[_\s-]?(expired|invalid)|jwt[_\s-]?expired|登录(已)?(过期|失效|超时)|会话(已)?(过期|失效)|登录状态已失效|please[_\s-]?(log|sign)[_\s-]?in[_\s-]?again)/i,
    hint: '会话过期，需重新登录/刷新后再继续',
  },
  {
    code: 'BUSINESS_CAPTCHA_REQUIRED', severity: 'blocking',
    re: /(captcha|recaptcha|hcaptcha|turnstile|请完成(安全|人机|滑动)验证|人机验证|滑动验证|验证码(错误|不正确|已失效)|click[_\s-]?to[_\s-]?verify|robot[_\s-]?check)/i,
    hint: '遇到人机验证，需人工介入；系统绝不尝试绕过验证码',
  },
  {
    code: 'BUSINESS_OTP_REQUIRED', severity: 'blocking',
    re: /(\botp\b|one[_\s-]?time[_\s-]?(code|password)|two[_\s-]?factor|\b2fa\b|mfa|动态(码|口令)|短信验证码|邮箱验证码|verification[_\s-]?code)/i,
    hint: '需要二次验证码，需人工提供 OTP',
  },
  {
    code: 'BUSINESS_PAYMENT_FAILED', severity: 'blocking',
    re: /(card[_\s-]?(declined|expired|rejected)|payment[_\s-]?(failed|declined|rejected|error)|insufficient[_\s-]?funds|支付失败|付款失败|扣款失败|交易失败|余额不足|卡号(无效|已过期)|银行(拒绝|拒付))/i,
    hint: '支付被拒，需更换支付方式或确认额度；不得绕过 3DS/风控',
  },
  {
    code: 'BUSINESS_RATE_LIMITED', severity: 'warning',
    re: /(too[_\s-]?many[_\s-]?(requests|attempts)|rate[_\s-]?limit(ed)?|throttl(e|ed)|操作过于频繁|请求过于频繁|尝试次数过多|请稍后再试)/i,
    hint: '触发限流，应退避等待后重试',
  },
  {
    code: 'BUSINESS_VALIDATION_FAILED', severity: 'blocking',
    re: /((field|value|input|email|phone|mobile|date|amount)[^\n]{0,16}(is[_\s-]?required|is[_\s-]?invalid|must[_\s-]?be|not[_\s-]?valid)|is[_\s-]?required|invalid[_\s-]?format|格式(不正确|错误)|不能为空|必填|校验(失败|未通过)|请输入(正确|有效)的)/i,
    hint: '输入未通过校验，需修正字段内容而非原样重试',
  },
  {
    code: 'BUSINESS_PERMISSION_DENIED', severity: 'blocking',
    re: /(permission[_\s-]?denied|access[_\s-]?denied|not[_\s-]?authorized|forbidden|没有权限|无权(访问|操作)|权限不足)/i,
    hint: '权限不足，需换账号或申请权限',
  },
  {
    code: 'BUSINESS_SERVER_ERROR_MESSAGE', severity: 'warning',
    re: /(internal[_\s-]?(server[_\s-]?)?error|something[_\s-]?went[_\s-]?wrong|unexpected[_\s-]?error|服务器(错误|异常|开小差)|系统(错误|异常)|出错了)/i,
    hint: '服务端返回错误，可退避重试一次',
  },
];

// 页面文本专用子集：只保留「几乎不会作为静态文案出现在正常页面上」的强信号，
// 避免把字段标签/占位符误判成错误。且仅在「确实执行过动作」时才扫描页面文本。
const PAGE_TEXT_STRONG_PATTERNS = BUSINESS_ERROR_PATTERNS.filter((p) => [
  'BUSINESS_DUPLICATE_EMAIL',
  'BUSINESS_INVALID_CREDENTIAL',
  'BUSINESS_SESSION_EXPIRED',
  'BUSINESS_CAPTCHA_REQUIRED',
  'BUSINESS_PAYMENT_FAILED',
  'BUSINESS_PERMISSION_DENIED',
  'BUSINESS_SERVER_ERROR_MESSAGE',
].includes(p.code));

// OTP 的页面文本专用规则。
// 为什么不能直接用 BUSINESS_OTP_REQUIRED 的宽松正则：在真实页面上，
// 「验证码 / 发送验证码 / 使用验证码登录」大量作为**按钮标签与登录方式入口**存在，
// 宽松匹配会把正常页面误判成「需要 OTP」→ 误升级。因此页面文本只认
// 「被要求输入 / 已发送 / 已过期 / 不正确」这类祈使句或结果句式。
const PAGE_TEXT_OTP_PATTERNS = [
  {
    code: 'BUSINESS_OTP_REQUIRED', severity: 'blocking',
    re: /(请(输入|填写|填入)[^\n]{0,10}(短信|邮箱|手机|动态)?验证码|验证码(已发送|已过期|已失效|错误|不正确|无效)|(enter|input|provide|type)[^\n]{0,20}(verification|one[_\s-]?time|security)[^\n]{0,10}code|(verification|one[_\s-]?time|security)[^\n]{0,10}code[^\n]{0,20}(required|invalid|incorrect|expired|wrong))/i,
    hint: '需要二次验证码，需人工提供 OTP',
  },
];

function haystackOf(network) {
  const parts = [];
  const api = (network && network.apiResponses) || [];
  for (const r of api) {
    if (r && r.bodyPreview) parts.push(String(r.bodyPreview));
  }
  const failures = (network && network.failures) || [];
  for (const r of failures) {
    if (r && r.bodyPreview) parts.push(String(r.bodyPreview));
  }
  return parts.join('\n');
}

function statusFindings(network) {
  const out = [];
  const seen = new Set();
  const scan = (list) => {
    for (const r of list || []) {
      if (!r || typeof r.status !== 'number') continue;
      const spec = STATUS_FINDINGS[r.status] || (r.status >= 500
        ? { code: 'HTTP_5XX_SERVER_ERROR', severity: 'warning', hint: '服务端错误，可退避重试一次' }
        : null);
      if (!spec || seen.has(spec.code)) continue;
      seen.add(spec.code);
      out.push({
        code: spec.code,
        severity: spec.severity,
        source: 'network.status',
        evidence: { status: r.status, url: r.url, method: r.method, resourceType: r.resourceType },
        hint: spec.hint,
      });
    }
  };
  scan(network && network.apiResponses);
  scan(network && network.failures);
  return out;
}

function businessFindings(network) {
  const text = haystackOf(network);
  if (!text) return [];
  const out = [];
  for (const p of BUSINESS_ERROR_PATTERNS) {
    const m = text.match(p.re);
    if (!m) continue;
    out.push({
      code: p.code,
      severity: p.severity,
      source: 'network.body',
      evidence: { matched: String(m[0]).slice(0, 160) },
      hint: p.hint,
    });
  }
  return out;
}

function pageTextFindings(pageText) {
  if (!pageText) return [];
  const out = [];
  for (const p of PAGE_TEXT_STRONG_PATTERNS.concat(PAGE_TEXT_OTP_PATTERNS)) {
    const m = pageText.match(p.re);
    if (!m) continue;
    out.push({
      code: p.code,
      severity: p.severity,
      source: 'page.text',
      evidence: { matched: String(m[0]).slice(0, 160) },
      hint: p.hint,
    });
  }
  return out;
}

function jsFindings(network, sinceTs) {
  const errs = ((network && network.pageErrors) || []).filter((e) => !sinceTs || e.at >= sinceTs);
  if (!errs.length) return [];
  return [{
    code: 'JS_RUNTIME_ERROR',
    severity: 'warning',
    source: 'page.pageerror',
    evidence: { count: errs.length, sample: errs.slice(0, 3).map((e) => e.message) },
    hint: '页面存在未捕获 JS 异常，可能导致交互无响应',
  }];
}

function networkFailFindings(network) {
  const failed = ((network && network.failures) || []).filter((r) => r && r.failed);
  if (!failed.length) return [];
  return [{
    code: 'NETWORK_REQUEST_FAILED',
    severity: 'warning',
    source: 'network.failed',
    evidence: { count: failed.length, sample: failed.slice(0, 3).map((r) => ({ url: r.url, reason: r.failureText })) },
    hint: '请求在传输层失败（超时/连接被拒/代理问题），应检查网络与代理',
  }];
}

const SEVERITY_RANK = { blocking: 0, warning: 1, info: 2 };

/**
 * 综合诊断。
 *
 * @param {object} input
 *   network      networkObserver.snapshot 输出
 *   pageText     页面可见文本（textSummary / visibleText）
 *   attempted    是否刚执行过一个动作（页面文本扫描的前置条件，避免误把静态文案当错误）
 *   sinceTs      只看该时间戳之后的证据（默认 0 = 全部）
 *   diff         previousObservationDiff（用于判断"动作是否真的产生了任何影响"）
 * @returns {{ findings: Array, primary: object|null, hasBlockingError: boolean, silentFailure: boolean, summary: string }}
 */
function detect(input = {}) {
  const network = input.network || null;
  const pageText = String(input.pageText || '');
  const attempted = input.attempted !== false;
  const sinceTs = Number(input.sinceTs) || 0;
  const diff = input.diff || null;

  const findings = [];
  if (network) {
    findings.push(...statusFindings(network));
    findings.push(...businessFindings(network));
    findings.push(...networkFailFindings(network));
    findings.push(...jsFindings(network, sinceTs));
  }
  if (attempted && pageText) findings.push(...pageTextFindings(pageText));

  // 静默失败：动作执行了，但网络无活动、DOM/文本/元素状态全无变化 → 点击打在了空气上
  let silentFailure = false;
  if (attempted && network) {
    const noNetwork = (network.counts.requests === 0)
      && (!network.lastRequestAt || network.lastRequestAt < sinceTs);
    const noDomChange = !diff || (
      !diff.domChanged && !diff.textChanged && !diff.elementStateChanged
      && !diff.keyTextChanged && !diff.pageStructureChanged && !diff.urlChanged
    );
    if (noNetwork && noDomChange) {
      silentFailure = true;
      findings.push({
        code: 'NO_OBSERVABLE_EFFECT',
        severity: 'warning',
        source: 'observation.diff',
        evidence: { requests: network.counts.requests, diff: diff || null },
        hint: '动作执行后既无网络活动也无任何页面变化 —— 大概率目标元素不是真正的可交互控件',
      });
    }
  }

  findings.sort((a, b) => (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]));
  const primary = findings.length ? findings[0] : null;
  const hasBlockingError = findings.some((f) => f.severity === 'blocking');

  return {
    findings,
    primary,
    hasBlockingError,
    silentFailure,
    summary: primary ? `${primary.code}（${primary.severity}）：${primary.hint}` : '未检测到明确失败信号',
  };
}

module.exports = {
  detect,
  BUSINESS_ERROR_PATTERNS,
  PAGE_TEXT_STRONG_PATTERNS,
  PAGE_TEXT_OTP_PATTERNS,
  STATUS_FINDINGS,
};
