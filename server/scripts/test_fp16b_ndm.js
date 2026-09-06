'use strict';

// Phase 16-B C5 — deviceMemory-identity 行为测试矩阵（N-DM-01~08）。
//
// 两种模式（与 test_fp16b_nhc.js 同构）：
//   1) stock（默认，无 FPB_NATIVE_CHROME env）：对系统 Chrome 跑 stock 半边断言，
//      保证 harness 在回归中持续活性。patched 专属断言 SKIP-STOCK。
//   2) patched（FPB_NATIVE_CHROME=<native chrome.exe>）：Gate 判定入口——
//      patched binary + 本测试全绿 = N-DM 行为矩阵通过。
//
// 测试值纪律：TEST_DM/JS_DM 均取 Chromium 真实输出域 {1,2,4,8,16,32} 内、动态
// 避让本机原生值（本机 32GB 物理内存时 stock 值为 32， ApproximatedDeviceMemory
// clamp 桌面 [2,32]，crbug 454354290）。TEST_DM 从 {8,16} 挑避让值；'1'（Android
// 域 token）作白名单全域覆盖用例；0.25/0.5（不可达 token）与 64（超上界）恒作
// fail-open 用例。
//
// 架构事实（C5 考古）：navigator.deviceMemory 唯一生产点 =
// NavigatorDeviceMemory::deviceMemory()（navigator_device_memory.cc，mixin 非 virtual
// 单函数、全库无覆写分叉）；NavigatorBase 多重继承该 mixin（navigator_base.h:42），
// Worker/iframe 同 renderer 进程内天然同源。stock 基值 =
// ApproximatedDeviceMemory::GetApproximatedDeviceMemory()；core/inspector 无
// DeviceMemory CDP probe = 无 CDP override 竞争。patch 白名单 = 精确字符串 token
// {0.25,0.5,1,2,4,8}，bare/未知/超域/形式不匹配（如 "8.0"）一律 fail-open stock。
//
// N-DM-01 patched 无开关 → navigator.deviceMemory == 本机原生值（缺省逐字节 stock）
// N-DM-02 patched identity switch → 主 frame deviceMemory == identity
// N-DM-03 第二合法值（8/16 对侧）+ '1'（Android 域 token）→ 各自生效
// N-DM-04 identity switch → Worker（WorkerNavigator）== identity（mixin 继承单点免费）
// N-DM-05 identity switch → 同源 iframe == identity（同 renderer 进程）
// N-DM-06 裸开关 → 本机原生值（fail-open）+ 让位/JS ownership 判别（06a/06b）
// N-DM-07 非法/不可达/形式不匹配（0.25 / 0.5 / 3 / 0.3 / 8.0 / 64 / abc）→ fail-open
// N-DM-08 一致性：http → about:blank → http 三读同值 + 第二独立 context 同值 + 新 tab 10 读稳定

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
      res.end('<html><body>ndm-capture</body></html>');
    }
  });
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = () => {
      const port = 19431 + attempt; // 与 npv(18231)/nnav(18331)/nhc(18431) 端口段错开
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

const readDm = (page) => page.evaluate(() => navigator.deviceMemory);
// 原生形态判别：真实 Chrome 的 deviceMemory 描述符在 Navigator.prototype
// （WebIDL mixin 展开），navigator 实例无 own descriptor。
async function readDescriptorShape(page) {
  return page.evaluate(() => ({
    own: !!Object.getOwnPropertyDescriptor(navigator, 'deviceMemory'),
    proto: !!Object.getOwnPropertyDescriptor(Navigator.prototype, 'deviceMemory'),
  }));
}

async function workerDm(page) {
  return page.evaluate(() => {
    const code = 'self.onmessage = () => self.postMessage(self.navigator.deviceMemory);';
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

  // 无开关参考值（本机原生近似内存，spec 域内 2 的幂）
  const b0 = await launch([]);
  const c0 = await b0.newContext();
  const p0 = await c0.newPage();
  await p0.goto(URL_BASE);
  const nativeRef = await readDm(p0);
  await c0.close(); await b0.close();
  console.log('  INFO nativeRef(无开关原生近似值)=' + nativeRef);
  if (!nativeRef) { console.error('FATAL nativeRef empty'); process.exit(2); }

  // 测试值动态避让：identity 值与 JS 干扰值都必须显著区别于本机原生值
  const TEST_DM = nativeRef === 8 ? 16 : 8;
  const SECOND_DM = TEST_DM === 8 ? 16 : 8; // 第二合法值（与 TEST_DM 对侧）
  const JS_DM = nativeRef === 4 ? 2 : 4;
  console.log('  INFO TEST_DM=' + TEST_DM + ' SECOND_DM=' + SECOND_DM + ' JS_DM=' + JS_DM);

  if (MODE === 'PATCHED') {
    // ---- N-DM-01：无开关 = stock（缺省逐字节等价）----
    const b1 = await launch([]);
    const c1 = await b1.newContext();
    const p1 = await c1.newPage();
    await p1.goto(URL_BASE);
    const dm1 = await readDm(p1);
    assert('N-DM-01 无开关 → 本机原生值（缺省 stock，非测试值）',
      dm1 === nativeRef && dm1 !== TEST_DM, dm1);
    const d1 = await readDescriptorShape(p1);
    assert('N-DM-01b 无开关 → 原生描述符形态（无 own、prototype 存在）',
      d1.own === false && d1.proto === true, JSON.stringify(d1));
    await c1.close(); await b1.close();

    // ---- N-DM-02/04/05/08：identity switch（纯 Native 路径）----
    const b2 = await launch(['--fp-device-memory=' + TEST_DM]);
    const c2 = await b2.newContext();
    const p2 = await c2.newPage();
    await p2.goto(URL_BASE);
    const dm2 = await readDm(p2);
    assert('N-DM-02 identity switch → 主 frame deviceMemory == identity', dm2 === TEST_DM, dm2);

    const wdm = await workerDm(p2);
    assert('N-DM-04 Worker == identity（WorkerNavigator mixin 继承单点免费同源）',
      wdm === TEST_DM && wdm === dm2, wdm + ' vs ' + dm2);

    await p2.goto(URL_BASE + 'ifr');
    await p2.waitForSelector('iframe');
    await p2.waitForFunction(() => {
      try { return frames[0] && frames[0].document && frames[0].document.body && frames[0].document.body.textContent === 'inner'; }
      catch (e) { return false; }
    }, { timeout: 5000 }).catch(() => {});
    const ifrDm = await p2.evaluate(() => {
      try { return frames[0].navigator.deviceMemory; } catch (e) { return 'ERR:' + e.message; }
    });
    assert('N-DM-05 同源 iframe == identity（同 renderer 进程）', ifrDm === TEST_DM, ifrDm);

    await p2.goto('about:blank');
    const ab = await readDm(p2);
    await p2.goto(URL_BASE);
    const back = await readDm(p2);
    // deviceMemory 为 [SecureContext] API（navigator_device_memory.idl）：about:blank
    // （opaque origin，非 secure context）上属性不存在 = undefined —— 原生语义实证；
    // C4 的 hardwareConcurrency 无 SecureContext 标记故三读同值，两 surface 语义
    // 差异即本断言价值（JS spoof 层无法复现该语义，让位后由原生天然保证）。
    assert('N-DM-08a http → about:blank → http：两端同值 + SecureContext 语义（about:blank undefined）',
      dm2 === TEST_DM && ab === undefined && back === TEST_DM,
      dm2 + '/' + ab + '/' + back);

    const c2b = await b2.newContext();
    const p2b = await c2b.newPage();
    await p2b.goto(URL_BASE);
    const dm2b = await readDm(p2b);
    assert('N-DM-08b 第二独立 context 同值', dm2b === TEST_DM && dm2b === dm2, dm2b);

    const p2c = await c2.newPage();
    await p2c.goto(URL_BASE);
    const reads = [];
    for (let i = 0; i < 10; i++) reads.push(await readDm(p2c));
    assert('N-DM-08c 新 tab + 10 次重复读取稳定', reads.every((v) => v === TEST_DM), reads.join(','));
    await c2b.close(); await c2.close(); await b2.close();

    // ---- N-DM-03：第二合法值 + 0.5 小数 token ----
    const b3 = await launch(['--fp-device-memory=' + SECOND_DM]);
    const c3 = await b3.newContext();
    const p3 = await c3.newPage();
    await p3.goto(URL_BASE);
    const dm3 = await readDm(p3);
    assert('N-DM-03 第二合法值 ' + SECOND_DM + ' → 生效（白名单对侧覆盖）',
      dm3 === SECOND_DM && dm3 !== TEST_DM, dm3);
    await c3.close(); await b3.close();

    // ---- N-DM-03b：'1'（Android 域下界 token，白名单全域覆盖）----
    const b3b = await launch(['--fp-device-memory=1']);
    const c3b = await b3b.newContext();
    const p3b = await c3b.newPage();
    await p3b.goto(URL_BASE);
    const dm3b = await readDm(p3b);
    assert('N-DM-03b token "1"（Android 域下界）→ 生效（白名单全域覆盖）', dm3b === 1, dm3b);
    await c3b.close(); await b3b.close();

    // ---- N-DM-06：裸开关 = fail-open 原生 fallback ----
    const b4 = await launch(['--fp-device-memory']);
    const c4 = await b4.newContext();
    const p4 = await c4.newPage();
    await p4.goto(URL_BASE);
    const dm4 = await readDm(p4);
    assert('N-DM-06 裸开关 → 本机原生值（fail-open，非测试值）',
      dm4 === nativeRef && dm4 !== TEST_DM, dm4);
    await c4.close(); await b4.close();

    // ---- N-DM-07：非法/不可达/形式不匹配 fail-open ----
    // "0.25"/"0.5"=现代 Chromium 不可达 token（clamp 下界桌面 2/Android 1）；
    // "3"=非 2 幂；"0.3"=非 token；"8.0"=形式不匹配精确 token（设计边界：白名单
    // 是字符串精确比对，无归一化）；"64"=超上界 32；"abc"=非数字。
    const invalidValues = ['0.25', '0.5', '3', '0.3', '8.0', '64', 'abc'];
    for (const iv of invalidValues) {
      const bI = await launch(['--fp-device-memory=' + iv]);
      const cI = await bI.newContext();
      const pI = await cI.newPage();
      await pI.goto(URL_BASE);
      const dmI = await readDm(pI);
      assert('N-DM-07 值 "' + iv + '" → fail-open 本机原生值', dmI === nativeRef, dmI);
      await cI.close(); await bI.close();
    }

    // ---- N-DM-06a：让位判别（项目侧注入 + nativeOwned）----
    // fp.deviceMemory 故意取干扰值 JS_DM（≠ switch 值）：若让位守卫失效，JS
    // getter 会把原生 identity 值覆盖为 JS_DM → 断言失败。值级判别不依赖描述符猜测。
    const fpA = generateFingerprint('test-fp16b-ndm::a', { os: 'Windows', browser: 'Chrome' }, null);
    fpA.deviceMemory = JS_DM; // 干扰值
    fpA._nativeOwned = ['navigator.deviceMemory']; // launcher 语义（nativeOwnership active 时注入）
    const b5 = await launch(['--fp-device-memory=' + TEST_DM]);
    const c5 = await b5.newContext();
    await c5.addInitScript(buildInjectionScript(fpA));
    const p5 = await c5.newPage();
    await p5.goto(URL_BASE);
    const dm5 = await readDm(p5);
    const d5 = await readDescriptorShape(p5);
    assert('N-DM-06a nativeOwned 让位 → 原生 identity 值胜出（干扰 fp 值未生效）',
      dm5 === TEST_DM && dm5 !== JS_DM, dm5);
    assert('N-DM-06a-own 让位后保持原生形态（无 own、prototype 存在）',
      d5.own === false && d5.proto === true, JSON.stringify(d5));
    await c5.close(); await b5.close();

    // ---- N-DM-06b：JS 对照组（无让位 → 既有行为不回归）----
    const fpB = generateFingerprint('test-fp16b-ndm::b', { os: 'Windows', browser: 'Chrome' }, null);
    fpB.deviceMemory = JS_DM;
    fpB._nativeOwned = [];
    const b6 = await launch([]);
    const c6 = await b6.newContext();
    await c6.addInitScript(buildInjectionScript(fpB));
    const p6 = await c6.newPage();
    await p6.goto(URL_BASE);
    const dm6 = await readDm(p6);
    assert('N-DM-06b 无让位 → JS 生产值胜出（既有 JS ownership 不回归）', dm6 === JS_DM, dm6);
    await c6.close(); await b6.close();
  } else {
    skip('N-DM-01~08（patched 专属，STOCK 模式跳过）');
    // STOCK 活性 A：未知 switch 对系统 Chrome 无影响（fail-safe）
    const bA = await launch(['--fp-device-memory=' + TEST_DM]);
    const cA = await bA.newContext();
    const pA = await cA.newPage();
    await pA.goto(URL_BASE);
    const dmA = await readDm(pA);
    assert('N-DM-STOCK-A 未知 switch 被忽略 → 本机原生值（stock 无影响）',
      dmA === nativeRef && dmA !== TEST_DM, dmA);
    await cA.close(); await bA.close();
    // STOCK 活性 B：JS 注入在系统 Chrome 生效（既有行为 + harness 活性）
    const fpB = generateFingerprint('test-fp16b-ndm::b', { os: 'Windows', browser: 'Chrome' }, null);
    fpB.deviceMemory = JS_DM;
    fpB._nativeOwned = [];
    const bB = await launch([]);
    const cB = await bB.newContext();
    await cB.addInitScript(buildInjectionScript(fpB));
    const pB = await cB.newPage();
    await pB.goto(URL_BASE);
    const dmB = await readDm(pB);
    assert('N-DM-STOCK-B JS 注入生效（harness 活性）', dmB === JS_DM, dmB);
    await cB.close(); await bB.close();
  }

  srv.close();
  console.log('');
  console.log('RESULT mode=' + MODE + ' pass=' + pass + ' fail=' + fail);
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
