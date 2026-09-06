'use strict';

// Phase 16-B C4 — hardwareConcurrency-identity 行为测试矩阵（N-HC-01~08）。
//
// 两种模式（与 test_fp16b_nnav.js 同构）：
//   1) stock（默认，无 FPB_NATIVE_CHROME env）：对系统 Chrome 跑 stock 半边断言，
//      保证 harness 在回归中持续活性。patched 专属断言 SKIP-STOCK。
//   2) patched（FPB_NATIVE_CHROME=<native chrome.exe>）：Gate 判定入口——
//      patched binary + 本测试全绿 = N-HC 行为矩阵通过。
//
// 测试值纪律：TEST_HC 显著区别于本机原生核数（动态避让 42/43），否则无法证明
// Native identity override 真正生效。
//
// 架构事实（C4 考古）：navigator.hardwareConcurrency 唯一 virtual 生产点 =
// NavigatorBase::hardwareConcurrency()（navigator_base.h:57 override；WorkerNavigator
// 无独立覆写），Worker/iframe 同 renderer 进程内天然同源。stock 基值 =
// NavigatorConcurrentHardware::hardwareConcurrency()（SysInfo::NumberOfProcessors）；
// CDP probe（Emulation.setHardwareConcurrencyOverride）在 patch 插入点之后应用 =
// 显式 CDP override 仍获胜（本测试不触碰 CDP，保持 Playwright 默认无 override）。
//
// N-HC-01 patched 无开关 → navigator.hardwareConcurrency == 本机原生核数（缺省逐字节 stock）
// N-HC-02 patched identity switch → 主 frame hardwareConcurrency == identity
// N-HC-03 patched 裸开关 → 本机原生核数（value_or fallback）
// N-HC-04 identity switch → Worker（WorkerNavigator）== identity（单点覆盖免费获得）
// N-HC-05 identity switch → 同源 iframe == identity（同 renderer 进程）
// N-HC-06 注入判别：
//   06a 让位（fp._nativeOwned 含 navigator.hardwareConcurrency）→ 原生值胜出（fp 值为干扰值）；
//   06b 无让位（_nativeOwned 空）→ JS 生产值胜出（既有行为不回归）
// N-HC-07 非法 switch 值（abc / 0 / 9999 / -8 / 12x）→ fail-open 本机原生核数
// N-HC-08 一致性：http → about:blank → http 三读同值 + 第二独立 context 同值 + 新 tab 10 读稳定

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const { buildInjectionScript } = require('../fp/inject');
const { generateFingerprint } = require('../fp/generate');

const STOCK_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const NATIVE = process.env.FPB_NATIVE_CHROME || null;
const BIN = NATIVE || STOCK_CHROME;

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
      res.end('<html><body>nhc-capture</body></html>');
    }
  });
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = () => {
      const port = 18431 + attempt; // 与 nnav(18331)/npv(18231) 端口段错开
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

const readHc = (page) => page.evaluate(() => navigator.hardwareConcurrency);
// 原生形态判别：真实 Chrome 的 hardwareConcurrency 描述符在 Navigator.prototype
// （WebIDL），navigator 实例无 own descriptor。
async function readDescriptorShape(page) {
  return page.evaluate(() => ({
    own: !!Object.getOwnPropertyDescriptor(navigator, 'hardwareConcurrency'),
    proto: !!Object.getOwnPropertyDescriptor(Navigator.prototype, 'hardwareConcurrency'),
  }));
}

async function workerHc(page) {
  return page.evaluate(() => {
    const code = 'self.onmessage = () => self.postMessage(self.navigator.hardwareConcurrency);';
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

  // 无开关参考值（本机原生核数）
  const b0 = await launch([]);
  const c0 = await b0.newContext();
  const p0 = await c0.newPage();
  await p0.goto(URL_BASE);
  const nativeRef = await readHc(p0);
  await c0.close(); await b0.close();
  console.log('  INFO nativeRef(无开关原生核数)=' + nativeRef);
  if (!nativeRef) { console.error('FATAL nativeRef empty'); process.exit(2); }

  // 测试值动态避让：identity 值与 JS 干扰值都必须显著区别于本机原生核数
  const TEST_HC = nativeRef === 42 ? 43 : 42;
  const JS_HC = nativeRef === 2 ? 3 : 2;
  console.log('  INFO TEST_HC=' + TEST_HC + ' JS_HC=' + JS_HC);

  if (MODE === 'PATCHED') {
    // ---- N-HC-01：无开关 = stock（缺省逐字节等价）----
    const b1 = await launch([]);
    const c1 = await b1.newContext();
    const p1 = await c1.newPage();
    await p1.goto(URL_BASE);
    const hc1 = await readHc(p1);
    assert('N-HC-01 无开关 → 本机原生核数（缺省 stock，非测试值）',
      hc1 === nativeRef && hc1 !== TEST_HC, hc1);
    const d1 = await readDescriptorShape(p1);
    assert('N-HC-01b 无开关 → 原生描述符形态（无 own、prototype 存在）',
      d1.own === false && d1.proto === true, JSON.stringify(d1));
    await c1.close(); await b1.close();

    // ---- N-HC-02/04/05/08：identity switch（纯 Native 路径）----
    const b2 = await launch(['--fp-hardware-concurrency=' + TEST_HC]);
    const c2 = await b2.newContext();
    const p2 = await c2.newPage();
    await p2.goto(URL_BASE);
    const hc2 = await readHc(p2);
    assert('N-HC-02 identity switch → 主 frame hardwareConcurrency == identity', hc2 === TEST_HC, hc2);

    const whc = await workerHc(p2);
    assert('N-HC-04 Worker == identity（WorkerNavigator 单点覆盖免费同源）',
      whc === TEST_HC && whc === hc2, whc + ' vs ' + hc2);

    await p2.goto(URL_BASE + 'ifr');
    await p2.waitForSelector('iframe');
    await p2.waitForFunction(() => {
      try { return frames[0] && frames[0].document && frames[0].document.body && frames[0].document.body.textContent === 'inner'; }
      catch (e) { return false; }
    }, { timeout: 5000 }).catch(() => {});
    const ifrHc = await p2.evaluate(() => {
      try { return frames[0].navigator.hardwareConcurrency; } catch (e) { return 'ERR:' + e.message; }
    });
    assert('N-HC-05 同源 iframe == identity（同 renderer 进程）', ifrHc === TEST_HC, ifrHc);

    await p2.goto('about:blank');
    const ab = await readHc(p2);
    await p2.goto(URL_BASE);
    const back = await readHc(p2);
    assert('N-HC-08a http → about:blank → http 三读同值',
      hc2 === TEST_HC && ab === TEST_HC && back === TEST_HC,
      hc2 + '/' + ab + '/' + back);

    const c2b = await b2.newContext();
    const p2b = await c2b.newPage();
    await p2b.goto(URL_BASE);
    const hc2b = await readHc(p2b);
    assert('N-HC-08b 第二独立 context 同值', hc2b === TEST_HC && hc2b === hc2, hc2b);

    const p2c = await c2.newPage();
    await p2c.goto(URL_BASE);
    const reads = [];
    for (let i = 0; i < 10; i++) reads.push(await readHc(p2c));
    assert('N-HC-08c 新 tab + 10 次重复读取稳定', reads.every((v) => v === TEST_HC), reads.join(','));
    await c2b.close(); await c2.close(); await b2.close();

    // ---- N-HC-03：裸开关 = value_or 原生 fallback ----
    const b3 = await launch(['--fp-hardware-concurrency']);
    const c3 = await b3.newContext();
    const p3 = await c3.newPage();
    await p3.goto(URL_BASE);
    const hc3 = await readHc(p3);
    assert('N-HC-03 裸开关 → 本机原生核数（value_or，非测试值）',
      hc3 === nativeRef && hc3 !== TEST_HC, hc3);
    await c3.close(); await b3.close();

    // ---- N-HC-07：非法值 fail-open（abc / 0 / 9999 / -8 / 12x）----
    const invalidValues = ['abc', '0', '9999', '-8', '12x'];
    for (const iv of invalidValues) {
      const bI = await launch(['--fp-hardware-concurrency=' + iv]);
      const cI = await bI.newContext();
      const pI = await cI.newPage();
      await pI.goto(URL_BASE);
      const hcI = await readHc(pI);
      assert('N-HC-07 非法值 "' + iv + '" → fail-open 本机原生核数', hcI === nativeRef, hcI);
      await cI.close(); await bI.close();
    }

    // ---- N-HC-06a：让位判别（项目侧注入 + nativeOwned）----
    // fp.hardwareConcurrency 故意取干扰值 JS_HC（≠ switch 值）：若让位守卫失效，JS
    // getter 会把原生 identity 值覆盖为 JS_HC → 断言失败。值级判别不依赖描述符猜测。
    const fpA = generateFingerprint('test-fp16b-nhc::a', { os: 'Windows', browser: 'Chrome' }, null);
    fpA.hardwareConcurrency = JS_HC; // 干扰值
    fpA._nativeOwned = ['navigator.hardwareConcurrency']; // launcher 语义（nativeOwnership active 时注入）
    const b5 = await launch(['--fp-hardware-concurrency=' + TEST_HC]);
    const c5 = await b5.newContext();
    await c5.addInitScript(buildInjectionScript(fpA));
    const p5 = await c5.newPage();
    await p5.goto(URL_BASE);
    const hc5 = await readHc(p5);
    const d5 = await readDescriptorShape(p5);
    assert('N-HC-06a nativeOwned 让位 → 原生 identity 值胜出（干扰 fp 值未生效）',
      hc5 === TEST_HC && hc5 !== JS_HC, hc5);
    assert('N-HC-06a-own 让位后保持原生形态（无 own、prototype 存在）',
      d5.own === false && d5.proto === true, JSON.stringify(d5));
    await c5.close(); await b5.close();

    // ---- N-HC-06b：JS 对照组（无让位 → 既有行为不回归）----
    const fpB = generateFingerprint('test-fp16b-nhc::b', { os: 'Windows', browser: 'Chrome' }, null);
    fpB.hardwareConcurrency = JS_HC;
    fpB._nativeOwned = [];
    const b6 = await launch([]);
    const c6 = await b6.newContext();
    await c6.addInitScript(buildInjectionScript(fpB));
    const p6 = await c6.newPage();
    await p6.goto(URL_BASE);
    const hc6 = await readHc(p6);
    assert('N-HC-06b 无让位 → JS 生产值胜出（既有 JS ownership 不回归）', hc6 === JS_HC, hc6);
    await c6.close(); await b6.close();
  } else {
    skip('N-HC-01~07（patched 专属，STOCK 模式跳过）');
    // STOCK 活性 A：未知 switch 对系统 Chrome 无影响（fail-safe）
    const bA = await launch(['--fp-hardware-concurrency=' + TEST_HC]);
    const cA = await bA.newContext();
    const pA = await cA.newPage();
    await pA.goto(URL_BASE);
    const hcA = await readHc(pA);
    assert('N-HC-STOCK-A 未知 switch 被忽略 → 本机原生核数（stock 无影响）',
      hcA === nativeRef && hcA !== TEST_HC, hcA);
    await cA.close(); await bA.close();
    // STOCK 活性 B：JS 注入在系统 Chrome 生效（既有行为 + harness 活性）
    const fpB = generateFingerprint('test-fp16b-nhc::b', { os: 'Windows', browser: 'Chrome' }, null);
    fpB.hardwareConcurrency = JS_HC;
    fpB._nativeOwned = [];
    const bB = await launch([]);
    const cB = await bB.newContext();
    await cB.addInitScript(buildInjectionScript(fpB));
    const pB = await cB.newPage();
    await pB.goto(URL_BASE);
    const hcB = await readHc(pB);
    assert('N-HC-STOCK-B JS 注入生效（harness 活性）', hcB === JS_HC, hcB);
    await cB.close(); await bB.close();
  }

  srv.close();
  console.log('');
  console.log('RESULT mode=' + MODE + ' pass=' + pass + ' fail=' + fail);
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
