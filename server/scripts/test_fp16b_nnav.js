'use strict';

// Phase 16-B C3 — navigator-identity 行为测试矩阵（N-NAV-01~10）。
//
// 两种模式（与 test_fp16b_npv.js 同构）：
//   1) stock（默认，无 FPB_NATIVE_CHROME env）：对系统 Chrome 跑 stock 半边断言，
//      保证 harness 在回归中持续活性。patched 专属断言 SKIP-STOCK。
//   2) patched（FPB_NATIVE_CHROME=<native chrome.exe>）：Gate 判定入口——
//      patched binary + 本测试全绿 = N-NAV 行为矩阵通过。
//
// 测试值纪律：TEST_PLATFORM='MacIntel' 显著区别于本机原生值（Windows → 'Win32'），
// 否则无法证明 Native identity override 真正生效。
//
// 架构事实（C3 实证）：navigator.platform 唯一 virtual 生产点 =
// NavigatorBase::platform()（window.navigator 与 WorkerNavigator 均派生 NavigatorBase），
// 因此 Worker/iframe 同 renderer 进程内天然同源，无需逐点 patch。
//
// N-NAV-01 patched 无开关 → navigator.platform == 本机原生（缺省逐字节 stock）
// N-NAV-02 patched identity switch → 主 frame platform == identity
// N-NAV-03 patched 裸开关 → 本机原生值（value_or fallback）
// N-NAV-04 identity switch → Worker（WorkerNavigator）== identity（单点覆盖免费获得）
// N-NAV-05 identity switch → 同源 iframe == identity（同 renderer 进程）
// N-NAV-06 注入判别：
//   06a 让位（fp._nativeOwned 含 navigator.platform）→ 原生值胜出（fp.platform 为干扰值）；
//   06b 无让位（_nativeOwned 空）→ JS 生产值胜出（既有行为不回归）
// N-NAV-07 非 ASCII switch 值 → fail-open 本机原生值（latin1 构造防误读，不 mojibake）
// N-NAV-08 同 page：http → about:blank → http 三读同值（文档域一致）
// N-NAV-09 同 browser 两独立 context 同值
// N-NAV-10 新 tab + 10 次重复读取稳定

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const { buildInjectionScript } = require('../fp/inject');
const { generateFingerprint } = require('../fp/generate');

const STOCK_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const NATIVE = process.env.FPB_NATIVE_CHROME || null;
const BIN = NATIVE || STOCK_CHROME;
const TEST_PLATFORM = 'MacIntel';
const JS_PLATFORM = 'Linux x86_64'; // 6b JS 注入值（区别于本机原生与 identity 值）

let pass = 0; let fail = 0; const failures = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + (detail !== undefined ? ' :: ' + String(detail).slice(0, 300) : '')); console.log('  FAIL ' + name); }
}
function skip(name) { console.log('  SKIP ' + name); }

// 本地同源 HTTP 服务：/（主页面）、/ifr（含同源 iframe）、/inner（iframe 内容）
function startServer() {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (req.url.startsWith('/ifr')) {
      res.end('<html><body><iframe src="/inner"></iframe>ifr-host</body></html>');
    } else if (req.url.startsWith('/inner')) {
      res.end('<html><body>inner</body></html>');
    } else {
      res.end('<html><body>nnav-capture</body></html>');
    }
  });
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = () => {
      const port = 18331 + attempt; // 与 npv(18231)/nauto 端口段错开
      srv.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && attempt < 20) { attempt++; tryListen(); }
        else reject(e);
      });
      srv.listen(port, '127.0.0.1', () => resolve({ srv, port }));
    };
    tryListen();
  });
}

async function launch(args) {
  return chromium.launch({
    executablePath: BIN, headless: true,
    args: ['--no-first-run', '--no-default-browser-check'].concat(args || []),
  });
}

const readPlatform = (page) => page.evaluate(() => navigator.platform);
// 原生形态判别：真实 Chrome 的 platform 描述符在 Navigator.prototype（WebIDL），
// navigator 实例无 own descriptor。
async function readDescriptorShape(page) {
  return page.evaluate(() => ({
    own: !!Object.getOwnPropertyDescriptor(navigator, 'platform'),
    proto: !!Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform'),
  }));
}

async function workerPlatform(page) {
  return page.evaluate(() => {
    const code = 'self.onmessage = () => self.postMessage(self.navigator.platform);';
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    const w = new Worker(url);
    return new Promise((res) => { w.onmessage = (e) => res(e.data); w.postMessage('go'); });
  });
}

(async () => {
  if (!fs.existsSync(BIN)) { console.error('FATAL binary not found: ' + BIN); process.exit(2); }
  const MODE = NATIVE ? 'PATCHED' : 'STOCK';
  console.log('mode=' + MODE + ' bin=' + BIN);

  const { srv, port } = await startServer();
  const URL_BASE = 'http://127.0.0.1:' + port + '/';

  // 无开关参考值（本机原生 platform）
  const b0 = await launch([]);
  const c0 = await b0.newContext();
  const p0 = await c0.newPage();
  await p0.goto(URL_BASE);
  const nativeRef = await readPlatform(p0);
  await c0.close(); await b0.close();
  console.log('  INFO nativeRef(无开关原生 platform)=' + nativeRef);
  if (!nativeRef) { console.error('FATAL nativeRef empty'); process.exit(2); }

  if (MODE === 'PATCHED') {
    // ---- N-NAV-01：无开关 = stock（缺省逐字节等价）----
    const b1 = await launch([]);
    const c1 = await b1.newContext();
    const p1 = await c1.newPage();
    await p1.goto(URL_BASE);
    const pv1 = await readPlatform(p1);
    assert('N-NAV-01 无开关 → 本机原生值（缺省 stock，非测试值）',
      pv1 === nativeRef && pv1 !== TEST_PLATFORM, pv1);
    const d1 = await readDescriptorShape(p1);
    assert('N-NAV-01b 无开关 → 原生描述符形态（无 own、prototype 存在）',
      d1.own === false && d1.proto === true, JSON.stringify(d1));
    await c1.close(); await b1.close();

    // ---- N-NAV-02/04/05/08/09/10：identity switch（纯 Native 路径）----
    const b2 = await launch(['--fp-platform=' + TEST_PLATFORM]);
    const c2 = await b2.newContext();
    const p2 = await c2.newPage();
    await p2.goto(URL_BASE);
    const pv2 = await readPlatform(p2);
    assert('N-NAV-02 identity switch → 主 frame platform == identity', pv2 === TEST_PLATFORM, pv2);

    const wplat = await workerPlatform(p2);
    assert('N-NAV-04 Worker == identity（WorkerNavigator 单点覆盖免费同源）',
      wplat === TEST_PLATFORM && wplat === pv2, wplat + ' vs ' + pv2);

    await p2.goto(URL_BASE + 'ifr');
    await p2.waitForSelector('iframe');
    await p2.waitForFunction(() => {
      try { return frames[0] && frames[0].document && frames[0].document.body && frames[0].document.body.textContent === 'inner'; }
      catch (e) { return false; }
    }, { timeout: 5000 }).catch(() => {});
    const ifrPlat = await p2.evaluate(() => {
      try { return frames[0].navigator.platform; } catch (e) { return 'ERR:' + e.message; }
    });
    assert('N-NAV-05 同源 iframe == identity（同 renderer 进程）', ifrPlat === TEST_PLATFORM, ifrPlat);

    await p2.goto('about:blank');
    const ab = await readPlatform(p2);
    await p2.goto(URL_BASE);
    const back = await readPlatform(p2);
    assert('N-NAV-08 http → about:blank → http 三读同值',
      pv2 === TEST_PLATFORM && ab === TEST_PLATFORM && back === TEST_PLATFORM,
      pv2 + '/' + ab + '/' + back);

    const c2b = await b2.newContext();
    const p2b = await c2b.newPage();
    await p2b.goto(URL_BASE);
    const pv2b = await readPlatform(p2b);
    assert('N-NAV-09 第二独立 context 同值', pv2b === TEST_PLATFORM && pv2b === pv2, pv2b);

    const p2c = await c2.newPage();
    await p2c.goto(URL_BASE);
    const reads = [];
    for (let i = 0; i < 10; i++) reads.push(await readPlatform(p2c));
    assert('N-NAV-10 新 tab + 10 次重复读取稳定', reads.every((v) => v === TEST_PLATFORM), reads.join(','));
    await c2b.close(); await c2.close(); await b2.close();

    // ---- N-NAV-03：裸开关 = value_or 原生 fallback ----
    const b3 = await launch(['--fp-platform']);
    const c3 = await b3.newContext();
    const p3 = await c3.newPage();
    await p3.goto(URL_BASE);
    const pv3 = await readPlatform(p3);
    assert('N-NAV-03 裸开关 → 本机原生值（value_or，非测试值）',
      pv3 === nativeRef && pv3 !== '' && pv3 !== TEST_PLATFORM, pv3);
    await c3.close(); await b3.close();

    // ---- N-NAV-07：非 ASCII 值 fail-open ----
    const b4 = await launch(['--fp-platform=Mäc32']);
    const c4 = await b4.newContext();
    const p4 = await c4.newPage();
    await p4.goto(URL_BASE);
    const pv4 = await readPlatform(p4);
    assert('N-NAV-07 非 ASCII → fail-open 本机原生值（不 mojibake、不崩溃）',
      pv4 === nativeRef && pv4 !== 'Mäc32' && !/M.{1,2}c32/.test(pv4), pv4);
    await c4.close(); await b4.close();

    // ---- N-NAV-06a：让位判别（项目侧注入 + nativeOwned）----
    // fp.platform 故意取干扰值 'Win32'（≠ switch 值）：若让位守卫失效，JS getter 会
    // 把原生 identity 值覆盖为 Win32 → 断言失败。值级判别不依赖描述符形态猜测。
    const fpA = generateFingerprint('test-fp16b-nnav::a', { os: 'macOS', browser: 'Chrome' }, null);
    fpA.platform = 'Win32'; // 干扰值
    fpA._nativeOwned = ['navigator.platform']; // launcher 语义（nativeOwnership active 时注入）
    const b5 = await launch(['--fp-platform=' + TEST_PLATFORM]);
    const c5 = await b5.newContext();
    await c5.addInitScript(buildInjectionScript(fpA));
    const p5 = await c5.newPage();
    await p5.goto(URL_BASE);
    const pv5 = await readPlatform(p5);
    const d5 = await readDescriptorShape(p5);
    assert('N-NAV-06a nativeOwned 让位 → 原生 identity 值胜出（干扰 fp.platform 未生效）',
      pv5 === TEST_PLATFORM && pv5 !== 'Win32', pv5);
    assert('N-NAV-06a-own 让位后保持原生形态（无 own、prototype 存在）',
      d5.own === false && d5.proto === true, JSON.stringify(d5));
    await c5.close(); await b5.close();

    // ---- N-NAV-06b：JS 对照组（无让位 → 既有行为不回归）----
    const fpB = generateFingerprint('test-fp16b-nnav::b', { os: 'Windows', browser: 'Chrome' }, null);
    fpB.platform = JS_PLATFORM;
    fpB._nativeOwned = [];
    const b6 = await launch([]);
    const c6 = await b6.newContext();
    await c6.addInitScript(buildInjectionScript(fpB));
    const p6 = await c6.newPage();
    await p6.goto(URL_BASE);
    const pv6 = await readPlatform(p6);
    assert('N-NAV-06b 无让位 → JS 生产值胜出（既有 JS ownership 不回归）', pv6 === JS_PLATFORM, pv6);
    await c6.close(); await b6.close();
  } else {
    skip('N-NAV-01~06/08/09/10 + 03/07（patched 专属，STOCK 模式跳过）');
    // STOCK 活性 A：未知 switch 对系统 Chrome 无影响（fail-safe）
    const bA = await launch(['--fp-platform=' + TEST_PLATFORM]);
    const cA = await bA.newContext();
    const pA = await cA.newPage();
    await pA.goto(URL_BASE);
    const pvA = await readPlatform(pA);
    assert('N-NAV-STOCK-A 未知 switch 被忽略 → 本机原生值（stock 无影响）',
      pvA === nativeRef && pvA !== TEST_PLATFORM, pvA);
    await cA.close(); await bA.close();
    // STOCK 活性 B：JS 注入在系统 Chrome 生效（既有行为 + harness 活性）
    const fpB = generateFingerprint('test-fp16b-nnav::b', { os: 'Windows', browser: 'Chrome' }, null);
    fpB.platform = JS_PLATFORM;
    fpB._nativeOwned = [];
    const bB = await launch([]);
    const cB = await bB.newContext();
    await cB.addInitScript(buildInjectionScript(fpB));
    const pB = await cB.newPage();
    await pB.goto(URL_BASE);
    const pvB = await readPlatform(pB);
    assert('N-NAV-STOCK-B JS 注入生效（harness 活性）', pvB === JS_PLATFORM, pvB);
    await cB.close(); await bB.close();
  }

  srv.close();
  console.log('');
  console.log('RESULT mode=' + MODE + ' pass=' + pass + ' fail=' + fail);
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
