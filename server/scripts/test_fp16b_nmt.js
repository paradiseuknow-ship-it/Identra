'use strict';

// Phase 16-B C6 — maxTouchPoints-identity 行为测试矩阵（N-MT-01~09）。
//
// 两种模式（与 test_fp16b_ndm.js/nhc.js 同构）：
//   1) stock（默认，无 FPB_NATIVE_CHROME env）：对系统 Chrome 跑 stock 半边断言，
//      保证 harness 在回归中持续活性。patched 专属断言 SKIP-STOCK。
//   2) patched（FPB_NATIVE_CHROME=<native chrome.exe>）：Gate 判定入口——
//      patched binary + 本测试全绿 = N-MT 行为矩阵通过。
//
// 测试值纪律：白名单 = Chromium 真实输出域 {0,5,10}（Windows
// ui::MaxTouchPoints() = GetSystemMetrics(SM_MAXIMUMTOUCHES) 触摸屏数字化仪
// 常见 10 / 无数字化仪 0；移动端典型 5）。TEST_MT/SECOND_MT 动态避让
// 本机原生值；候选顺序 [5,10,0] 保证 TEST_MT 恒 ≠ 0（JS 层 Windows 派生值
// 恒为 0，TEST_MT ≠ 0 是 N-MT-06a 值级判别成立的前提）。
//
// 架构事实（C6 考古，与 C4/C5 两点关键差异）：
//   a) 唯一 .cc 生产点 = NavigatorEvents::maxTouchPoints(Navigator&)（core/events/
//      navigator_events.cc，STATIC_ONLY 静态工具类非 mixin）；绑定经
//      navigator_events.idl partial interface Navigator —— WorkerNavigator 无此
//      扩展 → Worker 端 navigator.maxTouchPoints 在 stock 即 undefined → 单
//      window 侧 patch 点即全局完整（C5 deviceMemory 是双端 includes 同源，C6 不是）。
//   b) 非 [SecureContext]：about:blank 上可读（与 C5 deviceMemory 的 undefined
//      语义相反），patch 后三读同值（C4 模式）。
//   c) CDP 面：无 protocol 级 maxTouchPoints override probe；仅
//      DevToolsEmulator::SetTouchEventEmulationEnabled 运行时写 Settings 存储层。
//      patch 拦截 JS 暴露点（Settings 下游）→ CDP 触摸模拟开启期间 JS 身份面
//      恒 identity（N-MT-09），Settings save/restore 与内部事件消费者不受破坏。
//
// N-MT-01 patched 无开关 → navigator.maxTouchPoints == 本机原生值（缺省逐字节 stock）
// N-MT-02 patched identity switch → 主 frame maxTouchPoints == identity
// N-MT-03 第二合法值（白名单对侧）→ 生效
// N-MT-04 identity switch → Worker navigator.maxTouchPoints === undefined
//         （stock 语义实证：WorkerNavigator 无 partial 扩展，与 C5 Worker==identity 相反）
// N-MT-05 identity switch → 同源 iframe == identity（同 renderer 进程）
// N-MT-06 裸开关 → 本机原生值（fail-open）+ 让位/JS ownership 判别（06a/06b）
// N-MT-07 非法/越域/形式不匹配（-1 / 1 / 2 / 15 / 5.0 / 010 / abc）→ fail-open
// N-MT-08 一致性：http → about:blank → http 三读同值（非 SecureContext）+ 第二独立 context + 新 tab 10 读稳定
// N-MT-09 CDP 触摸模拟（Emulation.setTouchEmulationEnabled）开启期间 JS 身份面恒 identity
//         （patch 拦截点在 Settings 下游；关闭后仍 identity）

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const { buildInjectionScript } = require('../fp/inject');
const { generateFingerprint } = require('../fp/generate');

const STOCK_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const NATIVE = process.env.FPB_NATIVE_CHROME || null;
const BIN = NATIVE || STOCK_CHROME;
const WHITELIST = [0, 5, 10];

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
      res.end('<html><body>nmt-capture</body></html>');
    }
  });
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = () => {
      const port = 20431 + attempt; // 与 npv(18231)/nnav(18331)/nhc(18431)/ndm(19431) 端口段错开
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

const readMt = (page) => page.evaluate(() => navigator.maxTouchPoints);
// 原生形态判别：真实 Chrome 的 maxTouchPoints 描述符在 Navigator.prototype
// （WebIDL partial interface 展开），navigator 实例无 own descriptor。
async function readDescriptorShape(page) {
  return page.evaluate(() => ({
    own: !!Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints'),
    proto: !!Object.getOwnPropertyDescriptor(Navigator.prototype, 'maxTouchPoints'),
  }));
}

async function workerMt(page) {
  return page.evaluate(() => {
    const code = 'self.onmessage = () => self.postMessage(self.navigator.maxTouchPoints);';
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

  // 无开关参考值（本机原生触摸数字化仪能力：SM_MAXIMUMTOUCHES 或 0）
  const b0 = await launch([]);
  const c0 = await b0.newContext();
  const p0 = await c0.newPage();
  await p0.goto(URL_BASE);
  const nativeRef = await readMt(p0);
  await c0.close(); await b0.close();
  console.log('  INFO nativeRef(无开关原生触摸值)=' + nativeRef);
  if (typeof nativeRef !== 'number' || nativeRef < 0) { console.error('FATAL nativeRef invalid'); process.exit(2); }

  // 测试值动态避让：候选 [5,10,0] 排除 nativeRef → TEST_MT 恒 ≠ 0（JS 干扰判别前提）
  const candidates = [5, 10, 0].filter((v) => v !== nativeRef);
  const TEST_MT = candidates[0];
  const SECOND_MT = candidates[1];
  // 06b/STOCK-B JS 对照动态 os：JS 派生值恒 ≠ nativeRef（值级判别力保证）。
  // nativeRef≠5 → Android(派生 5)；nativeRef=5 → Windows(派生 0)。
  const JS_OS = nativeRef === 5 ? 'Windows' : 'Android';
  const JS_EXPECT = nativeRef === 5 ? 0 : 5;
  console.log('  INFO TEST_MT=' + TEST_MT + ' SECOND_MT=' + SECOND_MT + ' JS_OS=' + JS_OS + ' JS_EXPECT=' + JS_EXPECT);

  if (MODE === 'PATCHED') {
    // ---- N-MT-01：无开关 = stock（缺省逐字节等价）----
    const b1 = await launch([]);
    const c1 = await b1.newContext();
    const p1 = await c1.newPage();
    await p1.goto(URL_BASE);
    const mt1 = await readMt(p1);
    assert('N-MT-01 无开关 → 本机原生值（缺省 stock，非测试值）',
      mt1 === nativeRef && mt1 !== TEST_MT, mt1);
    const d1 = await readDescriptorShape(p1);
    assert('N-MT-01b 无开关 → 原生描述符形态（无 own、prototype 存在）',
      d1.own === false && d1.proto === true, JSON.stringify(d1));
    await c1.close(); await b1.close();

    // ---- N-MT-02/04/05/08：identity switch（纯 Native 路径）----
    const b2 = await launch(['--fp-max-touch-points=' + TEST_MT]);
    const c2 = await b2.newContext();
    const p2 = await c2.newPage();
    await p2.goto(URL_BASE);
    const mt2 = await readMt(p2);
    assert('N-MT-02 identity switch → 主 frame maxTouchPoints == identity', mt2 === TEST_MT, mt2);

    const wmt = await workerMt(p2);
    assert('N-MT-04 Worker navigator.maxTouchPoints === undefined（WorkerNavigator 无 partial 扩展，stock 语义实证）',
      wmt === undefined, wmt);

    await p2.goto(URL_BASE + 'ifr');
    await p2.waitForSelector('iframe');
    await p2.waitForFunction(() => {
      try { return frames[0] && frames[0].document && frames[0].document.body && frames[0].document.body.textContent === 'inner'; }
      catch (e) { return false; }
    }, { timeout: 5000 }).catch(() => {});
    const ifrMt = await p2.evaluate(() => {
      try { return frames[0].navigator.maxTouchPoints; } catch (e) { return 'ERR:' + e.message; }
    });
    assert('N-MT-05 同源 iframe == identity（同 renderer 进程）', ifrMt === TEST_MT, ifrMt);

    await p2.goto('about:blank');
    const ab = await readMt(p2);
    await p2.goto(URL_BASE);
    const back = await readMt(p2);
    // maxTouchPoints 非 [SecureContext]（navigator_events.idl 无 SecureContext 标记）：
    // about:blank 上可读且 patch 生效 = 三读同值（与 C5 deviceMemory 的 about:blank
    // undefined 语义相反；JS spoof 层无法复现该原生语义差异，让位后由原生天然保证）。
    assert('N-MT-08a http → about:blank → http：三读同 identity（非 SecureContext，about:blank 可读）',
      mt2 === TEST_MT && ab === TEST_MT && back === TEST_MT,
      mt2 + '/' + ab + '/' + back);

    const c2b = await b2.newContext();
    const p2b = await c2b.newPage();
    await p2b.goto(URL_BASE);
    const mt2b = await readMt(p2b);
    assert('N-MT-08b 第二独立 context 同值', mt2b === TEST_MT && mt2b === mt2, mt2b);

    const p2c = await c2.newPage();
    await p2c.goto(URL_BASE);
    const reads = [];
    for (let i = 0; i < 10; i++) reads.push(await readMt(p2c));
    assert('N-MT-08c 新 tab + 10 次重复读取稳定', reads.every((v) => v === TEST_MT), reads.join(','));
    await c2b.close(); await c2.close(); await b2.close();

    // ---- N-MT-03：第二合法值（白名单对侧）----
    const b3 = await launch(['--fp-max-touch-points=' + SECOND_MT]);
    const c3 = await b3.newContext();
    const p3 = await c3.newPage();
    await p3.goto(URL_BASE);
    const mt3 = await readMt(p3);
    assert('N-MT-03 第二合法值 ' + SECOND_MT + ' → 生效（白名单对侧覆盖）',
      mt3 === SECOND_MT && mt3 !== TEST_MT, mt3);
    await c3.close(); await b3.close();

    // ---- N-MT-06：裸开关 = fail-open 原生 fallback ----
    const b4 = await launch(['--fp-max-touch-points']);
    const c4 = await b4.newContext();
    const p4 = await c4.newPage();
    await p4.goto(URL_BASE);
    const mt4 = await readMt(p4);
    assert('N-MT-06 裸开关 → 本机原生值（fail-open，非测试值）',
      mt4 === nativeRef && mt4 !== TEST_MT, mt4);
    await c4.close(); await b4.close();

    // ---- N-MT-07：非法/越域/形式不匹配 fail-open ----
    // "-1"=负值；"1"/"2"=非白名单 int（真实域 {0,5,10} 外）；"15"=超上界 10；
    // "5.0"=形式不匹配精确 token（设计边界：白名单字符串精确比对，无归一化）；
    // "010"=前导零形式不匹配；"abc"=非数字。
    const invalidValues = ['-1', '1', '2', '15', '5.0', '010', 'abc'];
    for (const iv of invalidValues) {
      const bI = await launch(['--fp-max-touch-points=' + iv]);
      const cI = await bI.newContext();
      const pI = await cI.newPage();
      await pI.goto(URL_BASE);
      const mtI = await readMt(pI);
      assert('N-MT-07 值 "' + iv + '" → fail-open 本机原生值', mtI === nativeRef, mtI);
      await cI.close(); await bI.close();
    }

    // ---- N-MT-09：CDP 触摸模拟期间 JS 身份面恒 identity（层次关系实证）----
    // DevToolsEmulator::SetTouchEventEmulationEnabled 写 Settings 存储层；
    // patch 拦截 JS 暴露点（Settings 下游）→ 模拟开启/关闭期间 navigator.
    // maxTouchPoints 读值恒 TEST_MT（JS 身份面归 Native 所有权；Settings
    // save/restore 语义不受破坏）。
    const b9 = await launch(['--fp-max-touch-points=' + TEST_MT]);
    const c9 = await b9.newContext();
    const p9 = await c9.newPage();
    await p9.goto(URL_BASE);
    const beforeCdp = await readMt(p9);
    const cdp = await c9.newCDPSession(p9);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 7 });
    const duringCdp = await readMt(p9);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    const afterCdp = await readMt(p9);
    assert('N-MT-09 CDP 触摸模拟 on/off 期间 JS 身份面恒 identity（before/during/after）',
      beforeCdp === TEST_MT && duringCdp === TEST_MT && afterCdp === TEST_MT,
      beforeCdp + '/' + duringCdp + '/' + afterCdp);
    await c9.close(); await b9.close();

    // ---- N-MT-06a：让位判别（项目侧注入 + nativeOwned）----
    // JS 层生产值 = FP.os 派生（Windows → 0）。TEST_MT 恒 ≠ 0（候选序 [5,10,0]
    // 保证）：若让位守卫失效，defNav 会替换 prototype getter → 值变 JS 派生 0
    // → 值级判别成立。注：defNav 定义在 Navigator.prototype（非实例），
    // own descriptor 形态在 JS 注入与原生间不可区分（恒 own=false/proto=true），
    // 形态判别无判别力 —— 本 surface 判别 = 纯值级（与 C5 deviceMemory 同理）。
    const fpA = generateFingerprint('test-fp16b-nmt::a', { os: 'Windows', browser: 'Chrome' }, null);
    fpA._nativeOwned = ['navigator.maxTouchPoints']; // launcher 语义（nativeOwnership active 时注入）
    const b5 = await launch(['--fp-max-touch-points=' + TEST_MT]);
    const c5 = await b5.newContext();
    await c5.addInitScript(buildInjectionScript(fpA));
    const p5 = await c5.newPage();
    await p5.goto(URL_BASE);
    const mt5 = await readMt(p5);
    assert('N-MT-06a nativeOwned 让位 → 原生 identity 值胜出（JS 派生 0 未生效）',
      mt5 === TEST_MT && mt5 !== 0, mt5);
    await c5.close(); await b5.close();

    // ---- N-MT-06b：JS 对照组（无让位 → 既有行为不回归）----
    // 无 switch + 无 nativeOwned → JS os 派生值胜出。JS_OS 动态选择保证
    // JS_EXPECT ≠ nativeRef（恒有值级判别力）。
    const fpB = generateFingerprint('test-fp16b-nmt::b', { os: JS_OS, browser: 'Chrome' }, null);
    fpB._nativeOwned = [];
    const b6 = await launch([]);
    const c6 = await b6.newContext();
    await c6.addInitScript(buildInjectionScript(fpB));
    const p6 = await c6.newPage();
    await p6.goto(URL_BASE);
    const mt6 = await readMt(p6);
    assert('N-MT-06b 无让位 → JS 派生值胜出（os=' + JS_OS + ' → ' + JS_EXPECT + '，既有 JS ownership 不回归）',
      mt6 === JS_EXPECT && mt6 !== nativeRef, mt6);
    await c6.close(); await b6.close();
  } else {
    skip('N-MT-01~09（patched 专属，STOCK 模式跳过）');
    // STOCK 活性 A：未知 switch 对系统 Chrome 无影响（fail-safe）
    const bA = await launch(['--fp-max-touch-points=' + TEST_MT]);
    const cA = await bA.newContext();
    const pA = await cA.newPage();
    await pA.goto(URL_BASE);
    const mtA = await readMt(pA);
    assert('N-MT-STOCK-A 未知 switch 被忽略 → 本机原生值（stock 无影响）',
      mtA === nativeRef && mtA !== TEST_MT, mtA);
    await cA.close(); await bA.close();
    // STOCK 活性 B：JS 注入在系统 Chrome 生效（既有行为 + harness 活性）。
    // JS_OS 动态选择保证派生值 ≠ nativeRef（判别力）。
    const fpB = generateFingerprint('test-fp16b-nmt::b', { os: JS_OS, browser: 'Chrome' }, null);
    fpB._nativeOwned = [];
    const bB = await launch([]);
    const cB = await bB.newContext();
    await cB.addInitScript(buildInjectionScript(fpB));
    const pB = await cB.newPage();
    await pB.goto(URL_BASE);
    const mtB = await readMt(pB);
    assert('N-MT-STOCK-B JS 注入生效（os=' + JS_OS + ' → ' + JS_EXPECT + '，harness 活性）',
      mtB === JS_EXPECT && mtB !== nativeRef, mtB);
    await cB.close(); await bB.close();
  }

  srv.close();
  console.log('');
  console.log('RESULT mode=' + MODE + ' pass=' + pass + ' fail=' + fail);
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
