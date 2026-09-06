'use strict';
// test_step2_network_intelligence.js — STEP 2 网络智能层专项测试
//
// 背景（STEP 0 运行时取证）：
//   改造前系统对网络完全瞎：只有一个 pending 计数器，没有 status、没有响应体、
//   没有 console、没有 pageerror。业务失败在 HTTP 200 里发生时系统看不见，
//   于是 51.3% 的 VERIFY_FAILED 走的是「零信息原样重试」。
//
// 本测试锁定三件事：
//   1. networkObserver 真的采到了 request/response/console/pageerror（不是空壳）
//   2. businessErrorDetector 能从「HTTP 200 + 业务错误体」里读出真正的失败原因
//   3. 红线：采集到的任何文本都不得含明文凭据 / 卡号 / CVV；检测器不得含站点特定词

const { EventEmitter } = require('events');
const networkObserver = require('../agent/network/networkObserver');
const detector = require('../agent/network/businessErrorDetector');
const secRedact = require('../security/redact');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  << ' + extra : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

// ── 假 page（Playwright Page 的最小可测子集）─────────────────────────────────
function makeReq(over = {}) {
  return Object.assign({
    url: () => 'https://api.example.com/v1/users',
    method: () => 'POST',
    resourceType: () => 'fetch',
    postData: () => null,
    response: () => null,
    failure: () => null,
  }, over);
}
function makeRes(over = {}) {
  return Object.assign({
    url: () => 'https://api.example.com/v1/users',
    status: () => 200,
    headers: () => ({ 'content-type': 'application/json' }),
    text: async () => '{"ok":true}',
    request: () => makeReq(),
  }, over);
}
function makePage() {
  const p = new EventEmitter();
  p.__isFake = true;
  return p;
}
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  // ───────────────────────────────────────────────────────
  section('Case 1  networkObserver.attach：真实采集四类事件');
  {
    const page = makePage();
    ok('1.1 attach 成功', networkObserver.attach(page) === true);
    ok('1.2 attach 幂等（重复调用返回 false）', networkObserver.attach(page) === false);

    page.emit('request', makeReq());
    page.emit('requestfinished', makeReq({ response: () => makeRes({ status: () => 201 }) }));
    page.emit('console', { type: () => 'error', text: () => 'Uncaught TypeError: x is not a function' });
    page.emit('pageerror', { message: 'boom', stack: 'Error: boom\n  at f (a.js:1:1)' });
    await tick();

    const snap = networkObserver.snapshot(page);
    ok('1.3 采集到请求', snap.counts.requests === 1, JSON.stringify(snap.counts));
    ok('1.4 采集到完成状态 201', snap.failures.length === 0 && snap.apiResponses.length === 1,
      JSON.stringify(snap.apiResponses.map((r) => r.status)));
    ok('1.5 采集到 console error', snap.counts.consoleErrors === 1, JSON.stringify(snap.counts));
    ok('1.6 采集到 pageerror', snap.counts.pageErrors === 1, JSON.stringify(snap.pageErrors));
    ok('1.7 pending 归零', snap.pending === 0, 'pending=' + snap.pending);
  }

  // ───────────────────────────────────────────────────────
  section('Case 2  失败请求 / 4xx / 5xx 被正确归类');
  {
    const page = makePage();
    networkObserver.attach(page);
    page.emit('request', makeReq({ url: () => 'https://api.example.com/v1/orders' }));
    page.emit('requestfailed', makeReq({
      url: () => 'https://api.example.com/v1/orders',
      failure: () => ({ errorText: 'net::ERR_CONNECTION_REFUSED' }),
    }));
    page.emit('request', makeReq({ url: () => 'https://api.example.com/v1/a' }));
    page.emit('requestfinished', makeReq({ url: () => 'https://api.example.com/v1/a', response: () => makeRes({ status: () => 500 }) }));
    await tick();

    const snap = networkObserver.snapshot(page);
    ok('2.1 failures 含传输层失败', snap.failures.some((r) => r.failed && /ERR_CONNECTION_REFUSED/.test(String(r.failureText))),
      JSON.stringify(snap.failures));
    ok('2.2 统计到 5xx', snap.counts.status5xx === 1, JSON.stringify(snap.counts));
    ok('2.3 统计到失败数 2', snap.counts.failures === 2, JSON.stringify(snap.counts));
  }

  // ───────────────────────────────────────────────────────
  section('Case 3  响应体采集：只取 XHR/Fetch 的文本型响应');
  {
    const page = makePage();
    networkObserver.attach(page);
    // 文本型 XHR → 采响应体
    page.emit('request', makeReq({ url: () => 'https://api.example.com/v1/register' }));
    page.emit('response', makeRes({
      url: () => 'https://api.example.com/v1/register',
      text: async () => '{"ok":false,"error":"email already registered"}',
    }));
    // 图片响应 → 不得读体
    let imageBodyRead = false;
    page.emit('response', makeRes({
      url: () => 'https://cdn.example.com/a.png',
      status: () => 200,
      headers: () => ({ 'content-type': 'image/png' }),
      request: () => makeReq({ resourceType: () => 'image' }),
      text: async () => { imageBodyRead = true; return 'BINARY'; },
    }));
    await tick(); await tick();

    const snap = networkObserver.snapshot(page);
    const api = snap.apiResponses.find((r) => /register/.test(r.url));
    ok('3.1 采到 XHR 响应体', !!(api && /email already registered/.test(String(api.bodyPreview))), JSON.stringify(api));
    ok('3.2 图片响应未被读体（避免把二进制读进内存）', imageBodyRead === false);
    ok('3.3 响应体有长度上限（防 OOM）', String(api && api.bodyPreview || '').length <= 700);
  }

  // ───────────────────────────────────────────────────────
  section('Case 4  [红线] 采集文本一律脱敏：凭据/卡号/CVV 永不明文落库');
  {
    const page = makePage();
    networkObserver.attach(page);
    page.emit('request', makeReq({
      url: () => 'https://api.example.com/pay?token=abc123SECRET&amount=100',
      postData: () => '{"card":"4111111111111111","cvv":"123","password":"P@ssw0rd!"}',
    }));
    page.emit('response', makeRes({
      url: () => 'https://api.example.com/pay?token=REDACTED&amount=100',
      text: async () => 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig cvv=987',
    }));
    page.emit('console', { type: () => 'log', text: () => 'session=abc999 sessionid=zzz888' });
    await tick(); await tick();

    const snap = networkObserver.snapshot(page);
    const blob = JSON.stringify(snap);
    ok('4.1 URL 中的 token 查询参数被脱敏', /token=REDACTED/.test(blob) && !/abc123SECRET/.test(blob), blob.slice(0, 300));
    ok('4.2 请求体中的卡号被脱敏', !/4111111111111111/.test(blob));
    ok('4.3 请求体中的密码被脱敏', !/P@ssw0rd!/.test(blob));
    ok('4.4 响应体中的 Bearer 被脱敏', !/eyJhbGciOiJIUzI1NiJ9/.test(blob) && /Bearer REDACTED/.test(blob));
    ok('4.5 CVV 值被脱敏', !/cvv=987/.test(blob) && !/"cvv":"123"/.test(blob), blob.slice(0, 400));
    ok('4.6 console 中的 session 被脱敏', !/abc999/.test(blob) && !/zzz888/.test(blob));
  }

  // ───────────────────────────────────────────────────────
  section('Case 5  环形缓冲：长时间任务不得无限增长');
  {
    const page = makePage();
    networkObserver.attach(page);
    for (let i = 0; i < 400; i++) page.emit('request', makeReq({ url: () => 'https://api.example.com/x/' + i }));
    for (let i = 0; i < 300; i++) page.emit('console', { type: () => 'log', text: () => 'msg' + i });
    for (let i = 0; i < 200; i++) page.emit('pageerror', { message: 'e' + i, stack: null });
    await tick();

    const st = page.__fpbNetwork;
    ok('5.1 请求缓冲不超上限', st.requests.length <= networkObserver.LIMITS.requests, 'len=' + st.requests.length);
    ok('5.2 console 缓冲不超上限', st.console.length <= networkObserver.LIMITS.console, 'len=' + st.console.length);
    ok('5.3 pageerror 缓冲不超上限', st.pageErrors.length <= networkObserver.LIMITS.pageErrors, 'len=' + st.pageErrors.length);
    ok('5.4 保留的是最近的条目', /x\/399$/.test(st.requests[st.requests.length - 1].url), st.requests[st.requests.length - 1].url);
    ok('5.5 reset 可清空（步骤边界不串味）', networkObserver.reset(page) === true && page.__fpbNetwork.requests.length === 0);
  }

  // ───────────────────────────────────────────────────────
  section('Case 6  [核心] 从 HTTP 200 里读出业务失败原因');
  {
    const mkNetwork = (body, status) => ({
      attached: true, pending: 0,
      counts: { requests: 1, completed: 1, failures: status >= 400 ? 1 : 0, api: 1, status4xx: 0, status5xx: 0, consoleErrors: 0, consoleWarnings: 0, pageErrors: 0 },
      failures: status >= 400 ? [{ method: 'POST', url: 'https://api.example.com/v1/register', status, bodyPreview: body, resourceType: 'fetch' }] : [],
      apiResponses: [{ method: 'POST', url: 'https://api.example.com/v1/register', status, bodyPreview: body, resourceType: 'fetch' }],
      console: [], pageErrors: [],
    });

    const r1 = detector.detect({ network: mkNetwork('{"ok":false,"error":"email already registered"}', 200), attempted: true });
    ok('6.1 HTTP 200 + email already registered → DUPLICATE_EMAIL',
      r1.primary && r1.primary.code === 'BUSINESS_DUPLICATE_EMAIL', JSON.stringify(r1.primary));
    ok('6.2 该失败被判定为 blocking（原样重试不可能成功）', r1.hasBlockingError === true);

    const r2 = detector.detect({ network: mkNetwork('{"error":"invalid password"}', 200), attempted: true });
    ok('6.3 HTTP 200 + invalid password → INVALID_CREDENTIAL',
      r2.primary && r2.primary.code === 'BUSINESS_INVALID_CREDENTIAL', JSON.stringify(r2.primary));

    const r3 = detector.detect({ network: mkNetwork('{"message":"该邮箱已被注册"}', 200), attempted: true });
    ok('6.4 中文业务错误体同样识别', r3.primary && r3.primary.code === 'BUSINESS_DUPLICATE_EMAIL', JSON.stringify(r3.primary));

    const r4 = detector.detect({ network: mkNetwork('{"error":"captcha required"}', 200), attempted: true });
    ok('6.5 验证码 → CAPTCHA_REQUIRED，且提示不得绕过',
      r4.primary && r4.primary.code === 'BUSINESS_CAPTCHA_REQUIRED' && /不.*绕过|人工/.test(r4.primary.hint),
      JSON.stringify(r4.primary));

    const r5 = detector.detect({ network: mkNetwork('{"error":"card declined"}', 200), attempted: true });
    ok('6.6 支付被拒 → PAYMENT_FAILED，提示不得绕过 3DS/风控',
      r5.primary && r5.primary.code === 'BUSINESS_PAYMENT_FAILED' && /3DS|风控|更换/.test(r5.primary.hint),
      JSON.stringify(r5.primary));

    const r6 = detector.detect({ network: mkNetwork('', 401), attempted: true });
    ok('6.7 HTTP 401 → HTTP_401_UNAUTHORIZED', r6.primary && r6.primary.code === 'HTTP_401_UNAUTHORIZED', JSON.stringify(r6.primary));
    const r7 = detector.detect({ network: mkNetwork('', 429), attempted: true });
    ok('6.8 HTTP 429 → 限流（warning，可退避重试）',
      r7.primary && r7.primary.code === 'HTTP_429_RATE_LIMITED' && r7.primary.severity === 'warning', JSON.stringify(r7.primary));
    const r8 = detector.detect({ network: mkNetwork('', 503), attempted: true });
    ok('6.9 HTTP 503 → 5xx（warning）', r8.primary && r8.primary.code === 'HTTP_5XX_SERVER_ERROR', JSON.stringify(r8.primary));

    const r9 = detector.detect({ network: mkNetwork('{"ok":true,"id":"u_1"}', 200), attempted: true });
    ok('6.10 正常成功响应 → 不产生失败信号', r9.findings.length === 0 && r9.primary === null, JSON.stringify(r9.findings));
  }

  // ───────────────────────────────────────────────────────
  section('Case 7  页面文本兜底 + 静默失败识别');
  {
    // 没有网络证据时（纯前端表单），从页面文本读失败原因
    const r1 = detector.detect({ network: null, pageText: '注册 邮箱 密码 该邮箱已被注册，请直接登录', attempted: true });
    ok('7.1 页面文本识别出邮箱重复', r1.primary && r1.primary.code === 'BUSINESS_DUPLICATE_EMAIL', JSON.stringify(r1.primary));

    // 未执行动作时不得把静态文案当错误（防误报）
    const r2 = detector.detect({ network: null, pageText: '注册 邮箱 密码 该邮箱已被注册，请直接登录', attempted: false });
    ok('7.2 attempted=false 时不扫描页面文本（避免把静态文案误判为错误）', r2.findings.length === 0, JSON.stringify(r2.findings));

    // 静默失败：动作执行了但既无网络活动也无 DOM 变化
    const r3 = detector.detect({
      network: { attached: true, pending: 0, counts: { requests: 0, completed: 0, failures: 0, api: 0, status4xx: 0, status5xx: 0, consoleErrors: 0, consoleWarnings: 0, pageErrors: 0 }, failures: [], apiResponses: [], console: [], pageErrors: [], lastRequestAt: null, lastResponseAt: null },
      diff: { domChanged: false, textChanged: false, elementStateChanged: false, keyTextChanged: false, pageStructureChanged: false, urlChanged: false },
      attempted: true,
    });
    ok('7.3 无网络 + 无 DOM 变化 → NO_OBSERVABLE_EFFECT（点击打在空气上）',
      r3.silentFailure === true && r3.findings.some((f) => f.code === 'NO_OBSERVABLE_EFFECT'), JSON.stringify(r3.findings));

    const r4 = detector.detect({
      network: { attached: true, pending: 0, counts: { requests: 0, completed: 0, failures: 0, api: 0, status4xx: 0, status5xx: 0, consoleErrors: 0, consoleWarnings: 0, pageErrors: 0 }, failures: [], apiResponses: [], console: [], pageErrors: [], lastRequestAt: null, lastResponseAt: null },
      diff: { domChanged: true, textChanged: true, elementStateChanged: true, keyTextChanged: true, pageStructureChanged: false, urlChanged: false },
      attempted: true,
    });
    ok('7.4 DOM 有变化时不误判为静默失败', r4.silentFailure === false);
  }

  // ───────────────────────────────────────────────────────
  section('Case 8  脱敏规则一致性（与 observation.js 内 redact 同规则）');
  {
    const cases = [
      ['password=abc123', 'abc123'],
      ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.xxx.yyy', 'eyJhbGciOiJIUzI1NiJ9'],
      ['card=4111111111111111', '4111111111111111'],
      ['378282246310005', '378282246310005'],
      ['cookie=session_abc', 'session_abc'],
    ];
    for (const [input, secret] of cases) {
      ok('8.x 脱敏：' + input.slice(0, 24), !secRedact.redactSecrets(input).includes(secret), secRedact.redactSecrets(input));
    }
    ok('8.6 正常中文文本不被误伤', secRedact.redactSecrets('欢迎来到我们的商店，今日共 128 件商品') === '欢迎来到我们的商店，今日共 128 件商品');
    ok('8.7 正常价格文本不被误伤', secRedact.redactSecrets('Order total 89.50 USD') === 'Order total 89.50 USD');
  }

  // ───────────────────────────────────────────────────────
  section('Case 9  [红线] 检测器不得含任何站点/品类特定词');
  {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'network', 'businessErrorDetector.js'), 'utf8');
    const banned = [['saas', /saas/i], ['cloudsaas', /cloudsaas/i], ['mock 品牌 戴尔', /戴尔/], ['mock 品牌 飞利浦', /飞利浦/], ['mock 品牌 华硕', /华硕/]];
    for (const [name, re] of banned) {
      ok('9.x 检测器源码不含 ' + name, !re.test(src), '命中：' + (src.match(re) || [])[0]);
    }
    // 观察层不得因网络采集失败而崩溃
    const obsSrc = fs.readFileSync(path.join(__dirname, '..', 'agent', 'observation.js'), 'utf8');
    ok('9.6 observation 接入 networkObserver', /require\('\.\/network\/networkObserver'\)/.test(obsSrc));
    ok('9.7 网络快照失败被吞掉（观测能力缺失不得影响主流程）',
      /networkObserver\.snapshot\([\s\S]{0,80}\} catch \(e\)/.test(obsSrc) || /try \{\s*cached\.network = networkObserver\.snapshot/.test(obsSrc));
  }

  console.log('\n────────────────────────────');
  console.log(`PASS=${pass}  FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
