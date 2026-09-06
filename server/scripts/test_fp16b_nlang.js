'use strict';

// Phase 16-B C7-CONFIG — navigator.languages / navigator.language 行为验证矩阵
//（N-LANG-01..11，PHASE16B_C7_ARCHAEOLOGY_REPORT.md §8 设计稿 + C7-CONFIG 任务书 §九）。
//
// 被测对象：browserManager.js C7-CONFIG 接线（三件套，全部 CONFIG 层、零 patch）——
//   ① CDP Emulation.setUserAgentOverride.acceptLanguage = fp.languages.join(',')
//     （原手工 q 串 buildAcceptLanguage 已删除；q 因子由 Chromium 原生
//     net::HttpUtil::GenerateAcceptLanguageHeader 生成）；
//   ② injectAcceptLanguagesPref：launch 前 profile Preferences 注入
//     intl.accept_languages（WorkerNavigator 语言链 =
//     renderer_preferences_.accept_languages ← WebWorkerFetchContext ← profile pref；
//     CDP page-session override 不达 Worker —— c7_worker_probe.js V2-V7 实证）；
//   ③ extraHTTPHeaders.Accept-Language 移除（消除第三写；HTTP 由 pref 链 + CDP 驱动）。
//
// 测试值纪律（任务书 §十）：判别性列表 ['de-DE','de','en-US','en']（真实生成器
//   generateFingerprint(seed,{language:'de-DE'}) 产出并锚定），不创造新 schema。
//   HTTP 期望值锚定 net/http/http_util_unittest.cc GenerateAcceptLanguageHeader
//   权威形状（首项无 q，其后 q=0.9/0.8/0.7 递减）。
//
// N-LANG-01 缺省 stock（无 pref 注入/无 CDP）：三端 = 机器 pref 链原生同源
// N-LANG-02 CONFIG source correctness：window(inject)/window-native/Worker == identity 列表
// N-LANG-03 Worker === Window 无 q-factor 污染（B 类缺陷修复实证）
// N-LANG-04 HTTP：生产形态 navigation == GenerateAcceptLanguageHeader(列表)；
//           无 locale 对照全请求面（navigation+subresource+XHR）== 原生 q
// N-LANG-05 iframe 同值（addInitScript 覆盖子 frame）
// N-LANG-06 CDP override > pref 链（window-native/HTTP 走 CDP 值；Worker 走 pref 值）
// N-LANG-07 畸形输入 stock 语义锁定：q 串逐字保留（B 类缺陷机制负控）、空 token 跳过、
//           空白剥离、全空 → DefaultLanguage()
// N-LANG-08 单复数联动：language ≡ languages[0]（cc:39-41 同函数派生）
// N-LANG-09 ParseAndSanitize 下划线转换：'de_DE' → 'de-DE'
// N-LANG-10 kReduceAcceptLanguage 默认态哨兵：4 值列表不被收缩
// N-LANG-11 FrozenArray 稳定：window-native 与 Worker 原生对象同一性 ===；
//           inject 场景 window 对象同一性 NOT APPLICABLE（FP.languages.slice()
//           每次新数组，JS_OWNED 架构边界），仅断言值稳定。
//
// 时序纪律（test_fp16b_npv.js 实证复用）：CDP override 必须在首个真实导航后发送
//   （初始 target 上发送会被首次 commit 重置）；session 引用保持至 context 关闭。
// 端口段 21431（C7 专用段；npv 18231/nnav 18331/nhc 18431/ndm 19431/nmt 20431 之外）。
// 临时 profile 落 os.tmpdir()（宿主 safe-delete 纪律：绝不触碰 data/profiles）。

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { generateFingerprint } = require('../fp/generate');
const { buildInjectionScript } = require('../fp/inject');

const STOCK_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const NATIVE = process.env.FPB_NATIVE_CHROME || null;
const BIN = NATIVE || STOCK_CHROME;

const TEST_SEED = 'fp16b-nlang-c7-config';
const TEST_LANG = 'de-DE';
const EXPECT_LANGS = ['de-DE', 'de', 'en-US', 'en'];
const EXPECT_FEED = 'de-DE,de,en-US,en';
const EXPECT_HTTP_AL = 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7';
const OTHER_FEED = 'fr-FR,fr'; // N-LANG-06 判别用：与 pref 值不同的 CDP 显式列表

// 生产 browserManager 主路径 CDP override 形状（applyClientHints 同构；platformVersion
// '15.0.0' 为 C2 inactive 形态既有值，本测试不探测 UA-CH 面，仅保证 override 形状忠实）。
const PROD_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const PROD_METADATA = {
  brands: [{ brand: 'Google Chrome', version: '152' }],
  fullVersionList: [{ brand: 'Google Chrome', version: '152.0.0.0' }],
  platform: 'Windows',
  platformVersion: '15.0.0',
  architecture: 'x86',
  bitness: '64',
  model: '',
  mobile: false,
  wow64: false,
};

let pass = 0; let fail = 0; const failures = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + (detail !== undefined ? ' :: ' + String(detail).slice(0, 300) : '')); console.log('  FAIL ' + name); }
}
function markNotApplicable(name, reason) { console.log('  NOT-APPLICABLE ' + name + ' (' + reason + ')'); }

function isCleanToken(t) {
  return typeof t === 'string' && t.length > 0 && t.indexOf('q=') === -1 &&
    t.indexOf(';') === -1 && t.trim() === t;
}
function isCleanList(arr) { return Array.isArray(arr) && arr.length > 0 && arr.every(isCleanToken); }
const jsonOf = (arr) => JSON.stringify(arr);

// 生产 injectAcceptLanguagesPref 同形 replicate（Default/Preferences merge intl.accept_languages）
function writePrefs(userDataDir, acceptLanguages) {
  const defDir = path.join(userDataDir, 'Default');
  const prefsPath = path.join(defDir, 'Preferences');
  let prefs;
  if (fs.existsSync(prefsPath)) {
    try { prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8')); } catch (e) { return; }
  } else {
    fs.mkdirSync(defDir, { recursive: true });
    prefs = {};
  }
  if (!prefs || typeof prefs !== 'object') return;
  prefs.intl = Object.assign({}, prefs.intl, { accept_languages: acceptLanguages });
  fs.writeFileSync(prefsPath, JSON.stringify(prefs));
}

// —— 本地捕获服务：记录 (path, Accept-Language)；'/' 内嵌同源 iframe ——
function startCaptureServer() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ path: req.url, al: req.headers['accept-language'] || '' });
    if (req.url === '/xhr') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('xhr-ok');
      return;
    }
    if (req.url === '/iframe') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>nlang-iframe</body></html>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>nlang-main<iframe src="/iframe"></iframe></body></html>');
  });
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = () => {
      const port = 21431 + attempt;
      srv.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && attempt < 20) { attempt++; tryListen(); }
        else reject(e);
      });
      srv.listen(port, '127.0.0.1', () => resolve({ srv, port, seen }));
    };
    tryListen();
  });
}

// —— probes ——
async function probePage(page) {
  return page.evaluate(() => {
    const a1 = navigator.languages;
    const a2 = navigator.languages;
    return {
      langs: Array.from(a1),
      lang: navigator.language,
      identity: a1 === a2,
      stable: JSON.stringify(a1) === JSON.stringify(a2),
    };
  });
}
// Worker probe：blob URL dedicated worker（inject 不可达 = 原生 WorkerNavigator 路径）
async function probeWorker(page) {
  return page.evaluate(() => {
    const code = 'self.onmessage = () => { const a1 = self.navigator.languages; const a2 = self.navigator.languages; self.postMessage({ langs: Array.from(a1), lang: self.navigator.language, identity: a1 === a2, stable: JSON.stringify(a1) === JSON.stringify(a2) }); };';
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    const w = new Worker(url);
    return new Promise((res) => { w.onmessage = (e) => res(e.data); w.postMessage('go'); });
  });
}
// 生产时序：首导航 → CDP override（session 引用保持）→ 次导航生效
async function applyOverride(ctx, page, overrideObj) {
  const client = await ctx.newCDPSession(page);
  await client.send('Emulation.setUserAgentOverride', overrideObj);
  return client;
}
function tmpProfileDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'fp16b-nlang-')); }
function rmTmp(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }

(async () => {
  if (!fs.existsSync(BIN)) { console.error('FATAL binary not found: ' + BIN); process.exit(2); }
  const MODE = NATIVE ? 'PATCHED' : 'STOCK';
  console.log('mode=' + MODE + ' bin=' + BIN);

  // 真实生成器 + 判别性列表锚定（与生产 fp.languages 同一事实源）
  const fp = generateFingerprint(TEST_SEED, { language: TEST_LANG });
  const feed = fp.languages.join(',');
  console.log('  INFO fp.languages=' + jsonOf(fp.languages) + ' feed=' + feed);
  assert('TEST-VALUE 生成器输出锚定判别列表 + CDP 喂值形状（生产同式 join）',
    jsonOf(fp.languages) === jsonOf(EXPECT_LANGS) && feed === EXPECT_FEED && fp.language === TEST_LANG,
    jsonOf(fp.languages) + ' feed=' + feed + ' lang=' + fp.language);

  const injectScript = buildInjectionScript(fp);
  const { srv, port, seen } = await startCaptureServer();
  const URL_BASE = 'http://127.0.0.1:' + port + '/';

  // ================= 普通浏览器（launch，非 persistent）：CDP 通道组 =================
  const plainBrowser = await chromium.launch({
    executablePath: BIN, headless: true,
    args: ['--no-first-run', '--no-default-browser-check'],
  });

  // ---- N-LANG-01：缺省 stock（无 pref 注入/无 locale/无 CDP/无 inject）----
  {
    const ctx = await plainBrowser.newContext();
    const p = await ctx.newPage();
    const mark = seen.length;
    await p.goto(URL_BASE, { waitUntil: 'load' });
    const win = await probePage(p);
    const wk = await probeWorker(p);
    const navAls = seen.slice(mark).map((r) => r.al).filter(Boolean);
    const firstLang = (v) => String(v || '').split(',')[0].trim();
    assert('N-LANG-01a 缺省 → window-native == Worker == 机器 pref 链（三端原生同源）',
      jsonOf(win.langs) === jsonOf(wk.langs) && isCleanList(win.langs), jsonOf(win.langs) + ' vs ' + jsonOf(wk.langs));
    assert('N-LANG-01b 缺省 → HTTP = pref 派生原生 q 头（语言族与 JS 一致）',
      navAls.length > 0 && navAls.every((v) => firstLang(v) === win.langs[0]) && navAls.every((v) => v.indexOf(';q=') !== -1),
      jsonOf(navAls));
    console.log('  INFO stock pref 链 = ' + jsonOf(win.langs));
    await ctx.close();
  }

  // ---- N-LANG-02c/04b（无 locale 对照）：pref 注入 + CDP feed，CDP 全请求面能力 ----
  {
    const tmpDir = tmpProfileDir();
    writePrefs(tmpDir, feed);
    const ctx = await chromium.launchPersistentContext(tmpDir, {
      executablePath: BIN, headless: true,
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    const p = await ctx.newPage();
    await p.goto(URL_BASE, { waitUntil: 'load' });
    const mark = seen.length;
    await applyOverride(ctx, p, { userAgent: '', acceptLanguage: feed });
    await p.goto(URL_BASE, { waitUntil: 'load' });
    await p.evaluate(() => fetch('/xhr', { cache: 'no-store' }).then((r) => r.text()));
    const win = await probePage(p);
    const wk = await probeWorker(p);
    const httpAls = seen.slice(mark).map((r) => r.al).filter(Boolean);
    assert('N-LANG-02c window-native == identity 列表（CDP probe 纯列表、无 q 污染）',
      jsonOf(win.langs) === jsonOf(EXPECT_LANGS), jsonOf(win.langs));
    assert('N-LANG-04b 无 locale 对照 → 全请求面（navigation+subresource+XHR）== 原生 q',
      httpAls.length > 0 && httpAls.every((v) => v === EXPECT_HTTP_AL), jsonOf(httpAls));
    assert('N-LANG-04d 无 locale 对照 → Worker == identity 列表（pref 通道独立生效）',
      jsonOf(wk.langs) === jsonOf(EXPECT_LANGS), jsonOf(wk.langs));
    await ctx.close();
    rmTmp(tmpDir);
  }

  // ---- N-LANG-06：CDP > pref（pref=de 列表，CDP 显式 fr 列表）----
  {
    const tmpDir = tmpProfileDir();
    writePrefs(tmpDir, feed);
    const ctx = await chromium.launchPersistentContext(tmpDir, {
      executablePath: BIN, headless: true,
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    const p = await ctx.newPage();
    await p.goto(URL_BASE, { waitUntil: 'load' });
    const mark = seen.length;
    await applyOverride(ctx, p, { userAgent: '', acceptLanguage: OTHER_FEED });
    await p.goto(URL_BASE, { waitUntil: 'load' });
    const win = await probePage(p);
    const wk = await probeWorker(p);
    const navAls = seen.slice(mark).filter((r) => r.path === '/').map((r) => r.al).filter(Boolean);
    assert('N-LANG-06a CDP override > pref：window-native == CDP 显式列表（fr）',
      jsonOf(win.langs) === jsonOf(['fr-FR', 'fr']), jsonOf(win.langs));
    assert('N-LANG-06b CDP override > pref：HTTP navigation == GenerateAcceptLanguageHeader(fr 列表)',
      navAls.length > 0 && navAls.every((v) => v === 'fr-FR,fr;q=0.9'), jsonOf(navAls));
    assert('N-LANG-06c Worker 恒走 pref 链（de 列表；page-session CDP 不达 Worker 的边界锁定）',
      jsonOf(wk.langs) === jsonOf(EXPECT_LANGS), jsonOf(wk.langs));
    await ctx.close();
    rmTmp(tmpDir);
  }

  // ---- N-LANG-07：畸形输入 stock 语义（window-native 通道；B 类缺陷机制负控）----
  {
    const mk = async (alValue) => {
      const ctx = await plainBrowser.newContext();
      const p = await ctx.newPage();
      await p.goto(URL_BASE, { waitUntil: 'load' });
      await applyOverride(ctx, p, { userAgent: '', acceptLanguage: alValue });
      await p.goto(URL_BASE, { waitUntil: 'load' });
      const win = await probePage(p);
      await ctx.close();
      return win;
    };
    const wkA = await mk('de-DE,de;q=0.9');
    assert('N-LANG-07a 负控：q 串经 ParseAndSanitize 逐字保留（污染机制实证）',
      jsonOf(wkA.langs) === jsonOf(['de-DE', 'de;q=0.9']), jsonOf(wkA.langs));
    const wkB = await mk('de-DE,,de');
    assert('N-LANG-07b 空 token 跳过（SplitSkippingEmpty）', jsonOf(wkB.langs) === jsonOf(['de-DE', 'de']), jsonOf(wkB.langs));
    const wkC = await mk('  de-DE ,  de  ');
    assert('N-LANG-07c 空白剥离（StripWhiteSpace）', jsonOf(wkC.langs) === jsonOf(['de-DE', 'de']), jsonOf(wkC.langs));
    const wkD = await mk(',,,');
    const bcp47Shape = /^[A-Za-z]{2,3}(-[A-Za-z0-9]+)?$/;
    assert('N-LANG-07d 纯逗号列表（全 token 零长跳过）→ DefaultLanguage()（单值、BCP47 形状、fail-open）',
      wkD.langs.length === 1 && isCleanToken(wkD.langs[0]) && bcp47Shape.test(wkD.langs[0]), jsonOf(wkD.langs));
    // 实测（.benchmark/c7_parse_probe.js）：SplitSkippingEmpty 只在 split 时跳过零长段，
    // 空白 token（' '）非零长被保留、StripWhiteSpace 后变空串且不再移除 → ['', '']（stock 精确语义）。
    const wkE = await mk(' , ,');
    assert('N-LANG-07e 空白 token strip 后保留为空串（非 DefaultLanguage；SplitSkippingEmpty 语义边界）',
      jsonOf(wkE.langs) === jsonOf(['', '']), jsonOf(wkE.langs));
  }

  // ---- N-LANG-09：下划线转换（window-native 通道）----
  {
    const ctx = await plainBrowser.newContext();
    const p = await ctx.newPage();
    await p.goto(URL_BASE, { waitUntil: 'load' });
    await applyOverride(ctx, p, { userAgent: '', acceptLanguage: 'de_DE,en_US' });
    await p.goto(URL_BASE, { waitUntil: 'load' });
    const win = await probePage(p);
    assert('N-LANG-09 下划线→连字符（de_DE → de-DE；en_US → en-US）',
      jsonOf(win.langs) === jsonOf(['de-DE', 'en-US']), jsonOf(win.langs));
    await ctx.close();
  }

  // ---- N-LANG-11 补充：window-native FrozenArray 缓存语义（无 inject）----
  // stock 精确语义（IsLanguagesDirty() = languages_dirty_ || !override.IsNull(), cc:48-60）：
  // 无 override → 首次访问后缓存生效（同一性 true）；有 override → 恒 dirty（同一性 false
  // 但值恒正确——override 随时可变的 by-design 缓存失效）。Worker 侧无 page-session
  // override → 11b 的 identity === true 与此完全自洽。
  {
    const ctx1 = await plainBrowser.newContext();
    const p1 = await ctx1.newPage();
    await p1.goto(URL_BASE, { waitUntil: 'load' });
    const stockWin = await probePage(p1);
    assert('N-LANG-11d 无 override → window-native FrozenArray 对象同一性（缓存生效）',
      stockWin.identity === true && isCleanList(stockWin.langs), String(stockWin.identity) + ' ' + jsonOf(stockWin.langs));
    await ctx1.close();
    const ctx2 = await plainBrowser.newContext();
    const p2 = await ctx2.newPage();
    await p2.goto(URL_BASE, { waitUntil: 'load' });
    await applyOverride(ctx2, p2, { userAgent: '', acceptLanguage: feed });
    await p2.goto(URL_BASE, { waitUntil: 'load' });
    const ovrWin = await probePage(p2);
    assert('N-LANG-11e 有 override → window-native 恒 dirty（同一性 false，stock CachedAttribute 语义锁定）+ 值 == identity 列表',
      ovrWin.identity === false && ovrWin.stable === true && jsonOf(ovrWin.langs) === jsonOf(EXPECT_LANGS),
      String(ovrWin.identity) + ' ' + jsonOf(ovrWin.langs));
    await ctx2.close();
  }

  await plainBrowser.close();

  // ================= 生产终态主场景：pref 注入 + locale + inject + CDP full shape =================
  {
    const tmpDir = tmpProfileDir();
    writePrefs(tmpDir, feed);
    const ctx = await chromium.launchPersistentContext(tmpDir, {
      executablePath: BIN, headless: true,
      args: ['--no-first-run', '--no-default-browser-check'],
      locale: fp.language, // 生产 launchOpts 保留项（Intl 层一致性）
    });
    await ctx.addInitScript(injectScript);
    const p = await ctx.newPage();
    await p.goto(URL_BASE, { waitUntil: 'load' });
    const mark = seen.length;
    await applyOverride(ctx, p, {
      userAgent: PROD_UA,
      acceptLanguage: feed,
      platform: 'Windows',
      userAgentMetadata: PROD_METADATA,
    });
    await p.goto(URL_BASE, { waitUntil: 'load' });
    await p.evaluate(() => fetch('/xhr', { cache: 'no-store' }).then((r) => r.text()));
    const win = await probePage(p);       // inject 掩盖层
    const wk = await probeWorker(p);      // 原生 Worker

    assert('N-LANG-02a Window languages == identity 列表（inject 回放，CONFIG source correctness）',
      jsonOf(win.langs) === jsonOf(EXPECT_LANGS), jsonOf(win.langs));
    assert('N-LANG-02b Worker languages == identity 列表（pref 注入通道直达 Worker）',
      jsonOf(wk.langs) === jsonOf(EXPECT_LANGS), jsonOf(wk.langs));
    assert('N-LANG-03 Worker === Window 且无 q-factor 污染（B 类缺陷修复实证）',
      jsonOf(wk.langs) === jsonOf(win.langs) && isCleanList(wk.langs), jsonOf(wk.langs) + ' vs ' + jsonOf(win.langs));

    const navAls = seen.slice(mark).filter((r) => r.path === '/' || r.path === '/iframe').map((r) => r.al).filter(Boolean);
    assert('N-LANG-04a 生产形态：HTTP navigation == GenerateAcceptLanguageHeader(列表)（q 原生）',
      navAls.length > 0 && navAls.every((v) => v === EXPECT_HTTP_AL), jsonOf(navAls));
    const allAls = seen.slice(mark).map((r) => r.al).filter(Boolean);
    assert('N-LANG-04c 生产形态：全部请求头语言族一致（以 de-DE 开头）',
      allAls.length > 0 && allAls.every((v) => String(v).split(',')[0].trim() === 'de-DE'), jsonOf(allAls));

    const iframeFrame = p.frames().find((f) => f.url().indexOf('/iframe') !== -1);
    let iframeLangs = null;
    if (iframeFrame) { try { iframeLangs = Array.from(await iframeFrame.evaluate(() => navigator.languages)); } catch (e) { iframeLangs = null; } }
    assert('N-LANG-05 iframe 内 languages 同值（addInitScript 覆盖子 frame）',
      !!iframeFrame && jsonOf(iframeLangs) === jsonOf(EXPECT_LANGS), jsonOf(iframeLangs));

    assert('N-LANG-08 单复数联动：Worker language ≡ languages[0] == de-DE',
      wk.lang === TEST_LANG && wk.lang === wk.langs[0], wk.lang + ' vs ' + jsonOf(wk.langs));
    assert('N-LANG-10 kReduceAcceptLanguage 默认态哨兵：Worker 4 值列表不被收缩',
      wk.langs.length === 4, String(wk.langs.length));

    markNotApplicable('N-LANG-11(window-inject 对象同一性)', 'inject JS_OWNED：FP.languages.slice() 每次新数组（架构边界，非缺陷）');
    assert('N-LANG-11a inject 场景 window 两次读取值稳定', win.stable && jsonOf(win.langs) === jsonOf(EXPECT_LANGS), String(win.stable));
    assert('N-LANG-11b Worker 原生 FrozenArray 对象同一性（连续两次读同一对象）', wk.identity === true, String(wk.identity));
    assert('N-LANG-11c Worker 两次读取值稳定', wk.stable === true, String(wk.stable));
    await ctx.close();
    rmTmp(tmpDir);
  }

  srv.close();

  console.log('');
  console.log('RESULT mode=' + MODE + ' pass=' + pass + ' fail=' + fail);
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
