'use strict';

// Phase 16-B C2 — platformversion-identity 单元测试（plumbing/gate/让位/版本免疫/预算）。
//
// 覆盖（spec §6 §7 §9 §16 §21）：
//   G1-G3  manifest isPatchActive gate（enabled 唯一正式来源；FPB_FORCE_ACTIVE_PATCHES
//          显式测试通道，命中必留痕）
//   O1-O3  ownership 基线 gate 驱动（未激活=JS_OWNED；激活=NATIVE_OWNED；可还原）
//   J1-J4  inject.js 让位——真实 buildInjectionScript 求值（系统 Chrome 内执行，
//          断言「真正会执行的那份东西」）：
//            J1 _nativeOwned 空 → getHighEntropyValues platformVersion = '15.0.0'（既有行为）
//            J2 platformVersion NATIVE_OWNED → JS 不生产，回读原生值（stock 二进制下=真实 OS 值）
//            J3 brands 不被让位影响（N-PV-08 JS 半边）
//            J4 navigator.userAgent 不变（N-PV-09 JS 半边）
//   W1     browserManager 接线静态检查（gate 同时约束 args 注入与 CDP 让位）
//   V1     0003 patch 版本免疫（新增行零 Chromium 版本常量，spec §16）
//   B1-B2  0003 patch 预算（≤3 文件 / ≤100 added，spec §21）
//
// 纪律：不修改 Success Definition / benchmark / manifest.enabled；本测试不依赖
// native patched 二进制（native 半边 = test_fp16b_npv.js FPB_NATIVE_CHROME）。

const fs = require('fs');
const path = require('path');

let pass = 0; let fail = 0; const failures = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + (detail !== undefined ? ' :: ' + String(detail).slice(0, 300) : '')); console.log('  FAIL ' + name); }
}

const ROOT = path.join(__dirname, '..');
const manifest = require('../fp/nativePatchManifest');
const ownership = require('../fp/nativeOwnership');
const { buildInjectionScript } = require('../fp/inject');

const PATCH_FILE = 'D:\\chromium\\patches\\0003-platformversion-identity.patch';

(async () => {
  // ---- G: manifest gate ----
  delete process.env.FPB_FORCE_ACTIVE_PATCHES;
  // G1：§18 flip 时机合规（2026-09-06：行为验证 N-PV 11/0 + 双回归 103/0 + 96/0 全过后 flip）
  const pvPatch = manifest.getPatch('platformversion-identity');
  assert('G1 platformversion-identity → ACTIVE/enabled=true（§18 双回归全绿后 flip）+ sourceFiles 实证真值',
    pvPatch.enabled === true && pvPatch.status === 'ACTIVE' && manifest.isPatchActive('platformversion-identity') === true
    && pvPatch.sourceFiles.includes('components/embedder_support/user_agent_utils.cc'), null);
  assert('G2 automation-native-webdriver（POC #1 已完成）→ isPatchActive=true',
    manifest.isPatchActive('automation-native-webdriver') === true, null);
  process.env.FPB_FORCE_ACTIVE_PATCHES = 'platformversion-identity';
  assert('G3 显式测试通道 FPB_FORCE_ACTIVE_PATCHES → isPatchActive=true',
    manifest.isPatchActive('platformversion-identity') === true, null);
  delete process.env.FPB_FORCE_ACTIVE_PATCHES;

  // ---- O: ownership 基线 ----
  // O1-O3：双层语义（2026-09-06 flip 后）——ownership = 架构登记（isPatchActive，manifest
  // 驱动）；行为 gate = isC2PlatformVersionActive（manifest enabled **且** FPB_NATIVE_CHROME）。
  assert('O1 manifest ACTIVE → platformVersion 架构登记 NATIVE_OWNED（isPatchActive 驱动基线）',
    ownership.getOwner('navigator.userAgentData.platformVersion') === 'NATIVE_OWNED', ownership.snapshot()['navigator.userAgentData.platformVersion']);
  assert('O1b flip 后状态：两 patch 均 isPatchActive=true（webdriver POC#1 + platformVersion C2）',
    manifest.isPatchActive('automation-native-webdriver') === true && manifest.isPatchActive('platformversion-identity') === true, null);
  process.env.FPB_FORCE_ACTIVE_PATCHES = 'platformversion-identity';
  ownership.applyNativeOwnedBaseline();
  assert('O2 FORCE 通道幂等（已 ACTIVE patch 无副作用，仍 NATIVE_OWNED）',
    ownership.getOwner('navigator.userAgentData.platformVersion') === 'NATIVE_OWNED' && ownership.isJsOwned('navigator.userAgentData.platformVersion') === false, null);
  delete process.env.FPB_FORCE_ACTIVE_PATCHES;
  ownership.applyNativeOwnedBaseline();
  assert('O3 FORCE 撤除 + 基线重算 → manifest 驱动（ACTIVE 保持 NATIVE_OWNED，非回退 JS_OWNED）',
    ownership.getOwner('navigator.userAgentData.platformVersion') === 'NATIVE_OWNED', null);

  // ---- J: inject.js 让位（真实求值，系统 Chrome）----
  // 注意：navigator.userAgentData 仅存在于 http(s) 真实 origin（about:blank/data: 均为
  // undefined，P4.2 已实证）——求值页必须走本地 http 服务。
  const http = require('http');
  const httpSrv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>c2-unit</body></html>');
  });
  await require('./lib_safe_port').listenSafe(httpSrv, '127.0.0.1');
  const httpPort = httpSrv.address().port;
  const EVAL_URL = 'http://127.0.0.1:' + httpPort + '/';
  const { chromium } = require('playwright');
  const STOCK_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const browser = await chromium.launch({
    executablePath: fs.existsSync(STOCK_CHROME) ? STOCK_CHROME : undefined,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check'],
  });

  async function evalWithInjection(nativeOwned) {
    const ctx = await browser.newContext();
    const fp = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36', os: 'Windows', language: 'en-US', _nativeOwned: nativeOwned, fonts: [] };
    await ctx.addInitScript(buildInjectionScript(fp));
    const page = await ctx.newPage();
    await page.goto(EVAL_URL);
    const out = await page.evaluate(async () => {
      const hev = await navigator.userAgentData.getHighEntropyValues(['platformVersion', 'architecture', 'model', 'bitness']);
      return {
        pv: hev.platformVersion, arch: hev.architecture, model: hev.model, bitness: hev.bitness,
        brands: navigator.userAgentData.brands.map((b) => b.brand + '@' + b.version),
        ua: navigator.userAgent,
      };
    });
    await ctx.close();
    return out;
  }

  const jsOwned = await evalWithInjection([]);
  const nativeOwned = await evalWithInjection(['navigator.userAgentData.platformVersion']);

  assert('J1 C2 让位关闭（_nativeOwned 空）→ JS 生产 platformVersion=\'15.0.0\'（既有行为逐字节保持）',
    jsOwned.pv === '15.0.0', jsOwned.pv);
  // 原生参考值：无任何注入时页面的原生 getHighEntropyValues 值
  const refCtx = await browser.newContext();
  const refPage = await refCtx.newPage();
  await refPage.goto(EVAL_URL);
  const nativeRef = await refPage.evaluate(async () => (await navigator.userAgentData.getHighEntropyValues(['platformVersion'])).platformVersion);
  await refCtx.close();
  assert('J2 C2 让位开启 → JS 不生产 platformVersion，回读原生值（stock 下=真实 OS 值 ' + nativeRef + '）',
    nativeOwned.pv === nativeRef && nativeRef !== '15.0.0', 'nativeOwned.pv=' + nativeOwned.pv + ' nativeRef=' + nativeRef);
  assert('J3 brands 不受 platformVersion 让位影响（N-PV-08 JS 半边）',
    JSON.stringify(jsOwned.brands) === JSON.stringify(nativeOwned.brands) && nativeOwned.brands.length > 0, nativeOwned.brands);
  assert('J4 navigator.userAgent 两种 ownership 态下不变（N-PV-09 JS 半边）',
    jsOwned.ua === nativeOwned.ua && /Chrome\/137\.0\.0\.0/.test(nativeOwned.ua), nativeOwned.ua);
  assert('J5 architecture/bitness/model ownership 不变（N-PV-10 JS 半边）',
    jsOwned.arch === nativeOwned.arch && jsOwned.arch === 'x86' && jsOwned.bitness === nativeOwned.bitness && jsOwned.bitness === '64'
    && jsOwned.model === nativeOwned.model && jsOwned.model === '', JSON.stringify({ a: jsOwned.arch, b: jsOwned.bitness, m: jsOwned.model }));

  await browser.close(); httpSrv.close();

  // ---- W: browserManager 接线静态检查 ----
  const bmSrc = fs.readFileSync(path.join(ROOT, 'browserManager.js'), 'utf8');
  assert('W1 browserManager gate 同时约束 launch args 注入与 CDP 让位（单点 isC2PlatformVersionActive）',
    bmSrc.includes("isPatchActive('platformversion-identity') && !!process.env.FPB_NATIVE_CHROME")
    && bmSrc.includes("'--fp-platform-version=' + identityPv")
    && bmSrc.includes('if (isC2PlatformVersionActive())')
    && bmSrc.includes("platformVersion: '15.0.0'"), null);
  assert('W2 fp._nativeOwned 已接线（nativeOwnedSurfaces → buildInjectionScript）',
    bmSrc.includes('fp._nativeOwned = nativeOwnership.nativeOwnedSurfaces()'), null);

  // ---- V: 版本免疫（spec §16）----
  const patchText = fs.readFileSync(PATCH_FILE, 'utf8');
  const addedLines = patchText.split('\n').filter((l) => /^\+[^+]/.test(l));
  const badVersion = addedLines.filter((l) => /\b152\b|7977|Chrome\/152|Chrome\/1\d\d|version\s*==/i.test(l));
  assert('V1 0003 patch 新增行零 Chromium 版本常量（版本升级非漂移）', badVersion.length === 0, badVersion.join(' | '));

  // ---- B: patch 预算（spec §21）----
  const files = patchText.split('\n').filter((l) => /^\+\+\+ /.test(l)).length;
  const addedCount = addedLines.length;
  assert('B1 patch 文件数 ≤3', files <= 3, files);
  assert('B2 patch 新增行数 ≤100', addedCount <= 100, addedCount);
  console.log('  INFO patch=' + PATCH_FILE + ' files=' + files + ' added=' + addedCount);

  console.log('');
  console.log('RESULT pass=' + pass + ' fail=' + fail);
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
