'use strict';

// Phase 16-B C2 — platformversion-identity 行为测试矩阵（spec §12-§15 N-PV-01~10）。
//
// 两种模式（与 test_fp16b_nauto_patched.js 同构）：
//   1) stock（默认，无 FPB_NATIVE_CHROME env）：对系统 Chrome 跑 stock 半边断言，
//      保证 harness 在回归中持续活性。patched 专属断言 SKIP-STOCK。
//   2) patched（FPB_NATIVE_CHROME=<native chrome.exe>）：Gate 判定入口——
//      patched binary + 本测试全绿 = N-PV 行为矩阵通过。
//
// 测试值纪律（spec §14）：TEST_PV='99.1.2' 明显区别于本机 OS 值（Windows → 1x.0.0），
// 否则无法证明 Native identity override 真正生效。
//
// N-PV-01 C2 disabled → stock platformVersion（确定性、非测试值）
// N-PV-02 C2 enabled + identity → NavigatorUAData == identity
// N-PV-03 C2 enabled + identity → HTTP Sec-CH-UA-Platform-Version == identity
// N-PV-04 C2 enabled → Navigator == HTTP
// N-PV-05 C2 enabled → Worker == Navigator == HTTP
// N-PV-06 C2 enabled + 无 identity（裸开关）→ 原生 OS 值（value_or fallback）
// N-PV-07 C2 disabled + CDP 显式发送 platformVersion → 被尊重（既有 ownership 不回归）
// N-PV-08 C2 enabled + CDP 让位（override 缺 platformVersion）→ merge 回退原生=identity；
//         brands ownership 不变
// N-PV-09 User-Agent string 不受 C2 影响
// N-PV-10 其他 UA metadata（architecture/bitness/model/mobile）ownership 不变

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');

const STOCK_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const NATIVE = process.env.FPB_NATIVE_CHROME || null;
const BIN = NATIVE || STOCK_CHROME;
const TEST_PV = '99.1.2';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const BRANDS = [{ brand: 'Google Chrome', version: '137' }];
const FULL_VERSION_LIST = [{ brand: 'Google Chrome', version: '137.0.0.0' }];

let pass = 0; let fail = 0; const failures = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + (detail !== undefined ? ' :: ' + String(detail).slice(0, 300) : '')); console.log('  FAIL ' + name); }
}
function skip(name) { console.log('  SKIP ' + name); }

// 本地 HTTP 头捕获服务：首响应发 Accept-CH，之后导航请求应携带 Sec-CH-UA-Platform-Version
function startHeaderServer() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(req.headers);
    res.setHeader('Accept-CH', 'sec-ch-ua-platform-version');
    res.setHeader('Critical-CH', 'sec-ch-ua-platform-version');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>npv-capture</body></html>');
  });
  return new Promise((resolve, reject) => {
    // Chromium unsafe-port 黑名单规避：固定安全段起始，冲突递增（最多 20 次）
    let attempt = 0;
    const tryListen = () => {
      const port = 18231 + attempt;
      srv.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && attempt < 20) { attempt++; tryListen(); }
        else reject(e);
      });
      srv.listen(port, '127.0.0.1', () => resolve({ srv, port, seen }));
    };
    tryListen();
  });
}

async function launch(args) {
  const browser = await chromium.launch({
    executablePath: BIN, headless: true,
    args: ['--no-first-run', '--no-default-browser-check'].concat(args || []),
  });
  return browser;
}

async function hevPlatformVersion(page) {
  return page.evaluate(async () =>
    (await navigator.userAgentData.getHighEntropyValues(['platformVersion'])).platformVersion);
}

async function workerPlatformVersion(page) {
  return page.evaluate(async () => {
    const code = "self.onmessage = async () => { const v = await self.navigator.userAgentData.getHighEntropyValues(['platformVersion']); self.postMessage(v.platformVersion); };";
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    const w = new Worker(url);
    return new Promise((res) => { w.onmessage = (e) => res(e.data); w.postMessage('go'); });
  });
}

// 项目侧让位后的 CDP override 形状：metadata 完整但【无 platformVersion 字段】
// 时序纪律（实测复现）：① override 必须在首个真实导航后发送（初始 target 上发送会被
// 首次 commit 重置）；② session 不得 detach——detach 会清除 UA override（Emulation
// 状态是 session 作用域，实测 A/B 变体对比证实），故本测试保持 session 至 page 关闭。
async function applySurrenderOverride(ctx, page, withPlatformVersion) {
  // C2 active 时的项目侧让位形态（与 browserManager.applyClientHints 对齐）：
  // withPlatformVersion=false → 不发送任何 CDP UA-CH override（Playwright context option
  // 提供 UA string），JS/HTTP/Worker 全部回落 browser 级 patched GetUserAgentMetadata。
  // withPlatformVersion=true → C2 disabled（既有 ownership）：显式发送完整 metadata 含 pv。
  if (!withPlatformVersion) return;
  const client = await ctx.newCDPSession(page);
  await client.send('Emulation.setUserAgentOverride', {
    userAgent: UA, acceptLanguage: 'en-US', platform: 'Windows',
    userAgentMetadata: {
      brands: BRANDS, fullVersionList: FULL_VERSION_LIST, platform: 'Windows',
      platformVersion: '15.0.0', architecture: 'x86', bitness: '64',
      model: '', mobile: false, wow64: false,
    },
  });
}

(async () => {
  if (!fs.existsSync(BIN)) { console.error('FATAL binary not found: ' + BIN); process.exit(2); }
  const MODE = NATIVE ? 'PATCHED' : 'STOCK';
  console.log('mode=' + MODE + ' bin=' + BIN);

  const { srv, port, seen } = await startHeaderServer();
  const URL_BASE = 'http://127.0.0.1:' + port + '/';

  // 无开关参考值（本机原生 OS platformVersion）
  const b0 = await launch([]);
  const c0 = await b0.newContext();
  const p0 = await c0.newPage();
  await p0.goto(URL_BASE);
  const nativeRef = await hevPlatformVersion(p0);
  const uaRef = await p0.evaluate(() => navigator.userAgent);
  await c0.close(); await b0.close();
  console.log('  INFO nativeRef(无开关原生 platformVersion)=' + nativeRef);

  if (MODE === 'PATCHED') {
    // ---- N-PV-01：C2 disabled（无开关）= stock ----
    const b1 = await launch([]);
    const c1 = await b1.newContext();
    const p1 = await c1.newPage();
    await p1.goto(URL_BASE);
    const pv1 = await hevPlatformVersion(p1);
    const brandStock = await p1.evaluate(() => navigator.userAgentData.brands.map((b) => b.brand + '@' + b.version));
    assert('N-PV-01 C2 disabled → stock platformVersion（确定性且非测试值）',
      pv1 === nativeRef && pv1 !== TEST_PV && pv1 !== '', pv1);
    await c1.close(); await b1.close();

    // ---- N-PV-02/03/04/05：identity switch，无 CDP override（纯 Native 路径）----
    const seenMarkB2 = seen.length; // 场景切分：只统计本场景（b2）的捕获
    const b2 = await launch(['--fp-platform-version=' + TEST_PV]);
    const c2 = await b2.newContext();
    const p2 = await c2.newPage();
    await p2.goto(URL_BASE);
    const pv2 = await hevPlatformVersion(p2);
    assert('N-PV-02 identity switch → NavigatorUAData.platformVersion == identity', pv2 === TEST_PV, pv2);

    await p2.goto(URL_BASE); // 首导航：接受 Accept-CH（Critical-CH 可能自动重导航）
    await p2.goto(URL_BASE); // 次导航：应携带高熵 hint
    // HTTP 头值为 RFC 8941 sf-string（带引号），与 JS 层裸值比较前需剥离
    const stripSfString = (v) => (typeof v === 'string' ? v.replace(/^"(.*)"$/s, '$1') : v);
    const httpPvs = seen.slice(seenMarkB2).map((h) => stripSfString(h['sec-ch-ua-platform-version'])).filter(Boolean);
    assert('N-PV-03 HTTP Sec-CH-UA-Platform-Version == identity', httpPvs.includes(TEST_PV), httpPvs);
    assert('N-PV-04 Navigator == HTTP（全部捕获请求一致）',
      httpPvs.length > 0 && httpPvs.every((v) => v === TEST_PV) && pv2 === TEST_PV, pv2 + ' vs [' + httpPvs.join(',') + ']');

    const wpv = await workerPlatformVersion(p2);
    assert('N-PV-05 Worker == Navigator == HTTP', wpv === pv2 && wpv === TEST_PV && httpPvs.length > 0 && httpPvs.every((v) => v === TEST_PV), wpv + ' vs [' + httpPvs.join(',') + ']');

    const ua2 = await p2.evaluate(() => navigator.userAgent);
    assert('N-PV-09 User-Agent string 不受 C2 影响', ua2 === uaRef, ua2 + ' vs ' + uaRef);
    await c2.close(); await b2.close();

    // ---- N-PV-06：裸开关 = value_or 原生 fallback ----
    const b3 = await launch(['--fp-platform-version']);
    const c3 = await b3.newContext();
    const p3 = await c3.newPage();
    await p3.goto(URL_BASE);
    const pv3 = await hevPlatformVersion(p3);
    assert('N-PV-06 裸开关 → 原生 OS 值（非空、非 identity、非硬编码）',
      pv3 === nativeRef && pv3 !== '' && pv3 !== TEST_PV, pv3);
    await c3.close(); await b3.close();

    // ---- N-PV-07：C2 disabled + CDP 显式发送 platformVersion → 被尊重 ----
    // 时序纪律：CDP override 必须在首个真实导航后发送（初始 about:blank target 上发送
    // 会被首次 commit 重置——实测复现），发送后再导航一次使新文档生效。
    const b4 = await launch([]);
    const c4 = await b4.newContext();
    const p4 = await c4.newPage();
    await p4.goto(URL_BASE);
    await applySurrenderOverride(c4, p4, true);
    await p4.goto(URL_BASE);
    const pv4 = await hevPlatformVersion(p4);
    assert('N-PV-07 CDP 显式 platformVersion 被尊重（既有 ownership 不回归）', pv4 === '15.0.0', pv4);
    await c4.close(); await b4.close();

    // ---- N-PV-08/10：C2 enabled + CDP 让位（override 缺 platformVersion）----
    const b5 = await launch(['--fp-platform-version=' + TEST_PV]);
    const c5 = await b5.newContext();
    const p5 = await c5.newPage();
    await p5.goto(URL_BASE);
    await applySurrenderOverride(c5, p5, false);
    await p5.goto(URL_BASE);
    const pv5 = await hevPlatformVersion(p5);
    assert('N-PV-08 CDP 让位 → merge 回退 patched 原生值 == identity', pv5 === TEST_PV, pv5);
    const brands5 = await p5.evaluate(() => navigator.userAgentData.brands.map((b) => b.brand + '@' + b.version));
    assert('N-PV-08b brands 保持 native 同源（与 C2 disabled 基线一致，未受让位影响）',
      JSON.stringify(brands5) === JSON.stringify(brandStock), brands5.join('|') + ' vs ' + brandStock.join('|'));
    const other5 = await p5.evaluate(async () => {
      const v = await navigator.userAgentData.getHighEntropyValues(['architecture', 'model', 'bitness']);
      return { arch: v.architecture, model: v.model, bitness: v.bitness, mobile: navigator.userAgentData.mobile };
    });
    assert('N-PV-10 其他 UA metadata ownership 不变',
      other5.arch === 'x86' && other5.bitness === '64' && other5.model === '' && other5.mobile === false, JSON.stringify(other5));
    await c5.close(); await b5.close();
  } else {
    skip('N-PV-01~06/08/10（patched 专属，STOCK 模式跳过）');
    // STOCK 模式活性：既有 CDP override 行为（N-PV-07 同型）在系统 Chrome 上持续成立
    const b4 = await launch([]);
    const c4 = await b4.newContext();
    const p4 = await c4.newPage();
    await p4.goto(URL_BASE);
    await applySurrenderOverride(c4, p4, true);
    await p4.goto(URL_BASE);
    const pv4 = await hevPlatformVersion(p4);
    assert('N-PV-STOCK CDP 显式 platformVersion 在系统 Chrome 上被尊重（harness 活性）', pv4 === '15.0.0', pv4);
    const ua4 = await p4.evaluate(() => navigator.userAgent);
    assert('N-PV-STOCK UA == override UA', ua4 === UA, ua4);
    await c4.close(); await b4.close();
  }

  srv.close();
  console.log('');
  console.log('RESULT mode=' + MODE + ' pass=' + pass + ' fail=' + fail);
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
