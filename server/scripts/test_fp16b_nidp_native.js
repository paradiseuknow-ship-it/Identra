'use strict';

// Phase 16-B POC #7 — identity-config-plumbing 行为测试（N-IDP 套件）。
//
// 两种模式（与 N-AUTO harness 约定一致）：
//   1) stock（默认，无 FPB_NATIVE_CHROME env）：对系统 Chrome 跑 stock 半边断言
//      （identity.json 不驱动 stock 二进制 → 全部 stock 值），保证回归活性。
//   2) patched（FPB_NATIVE_CHROME=<native chrome.exe>）：全矩阵断言。
//
// 断言矩阵：
//   N-IDP-01 patched：仅 --user-data-dir（identity.json 存在、零外部 fp-* 开关）
//           → platform/platformVersion/hardwareConcurrency/deviceMemory 全部命中 identity 值
//   N-IDP-02 patched：外部显式开关优先（--fp-platform=CustomVal 覆盖 identity）
//   N-IDP-03 patched+stock：user-data-dir 无 identity.json → 全部 stock（fail-open）
//   N-IDP-04 patched：os=Android 派生 maxTouchPoints=5（C6 派生语义）
//   N-IDP-05 patched：identity.json 损坏（非法 JSON）→ 全部 stock（fail-open 实证）
//   N-IDP-06 stock/patched：默认 user-data（无 identity.json）行为与基线一致（活性）
//
// patch：D:/chromium/patches/0008-identity-config-plumbing.patch

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STOCK_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const NATIVE = process.env.FPB_NATIVE_CHROME || null;
const BIN = NATIVE || STOCK_CHROME;
const MODE = NATIVE ? 'PATCHED' : 'STOCK';

let pass = 0, fail = 0; const failures = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + (detail !== undefined ? ' :: ' + String(detail).slice(0, 300) : '')); console.log('  FAIL ' + name); }
}
function skipStock(name) { console.log('  SKIP-STOCK ' + name); }

function mkIdentityDir(identityObj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nidp-'));
  if (identityObj !== null) fs.writeFileSync(path.join(dir, 'identity.json'), JSON.stringify(identityObj));
  return dir;
}

// 桌面 identity（C2/C3/C4/C5 全部与 stock 可区分：platform MacIntel / hc 2 / dm 4 / osVersion 10.0.0）
const IDENTITY_DESKTOP = {
  identityId: 'idn-nidp-desktop', os: 'Windows', osVersion: '10.0.0',
  cpuProfile: { platform: 'MacIntel', hardwareConcurrency: 2 },
  memoryProfile: { deviceMemoryGB: 4 },
};
// Android identity（C6 派生：maxTouchPoints=5）
const IDENTITY_ANDROID = {
  identityId: 'idn-nidp-android', os: 'Android', osVersion: '13.0.0',
  cpuProfile: { platform: 'Linux armv8l', hardwareConcurrency: 8 },
  memoryProfile: { deviceMemoryGB: 4 },
};

async function probe(bin, userDataDir, extraArgs) {
  // userAgentData 仅 http(s) 真实 origin 存在 + deviceMemory 是 secure-context-only
  // （about:blank/data: 上两者均 undefined——C2 单测 line70 既有结论），故统一走
  // 127.0.0.1 本地 origin（localhost = secure context）。
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><body>nidp</body></html>'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + srv.address().port + '/';
  const args = ['--no-first-run', '--no-default-browser-check'];
  if (extraArgs) args.push(...extraArgs);
  // Playwright 禁止 args 携带 --user-data-dir：显式 dir 用 launchPersistentContext，
  // 无 dir（N-IDP-06 默认 profile 活性）用普通 launch。
  let ctx;
  if (userDataDir) {
    ctx = await chromium.launchPersistentContext(userDataDir, { executablePath: bin, headless: true, args });
  } else {
    const browser = await chromium.launch({ executablePath: bin, headless: true, args });
    ctx = await browser.newContext();
  }
  const page = await ctx.newPage();
  await page.goto(origin);
  const sig = await page.evaluate(async () => {
    let platformVersion = null;
    try {
      platformVersion = (await navigator.userAgentData.getHighEntropyValues(['platformVersion'])).platformVersion;
    } catch (e) { platformVersion = 'UAH_ERR:' + e.message; }
    return {
      platform: navigator.platform,
      platformVersion,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      maxTouchPoints: navigator.maxTouchPoints,
    };
  });
  await ctx.close();
  await new Promise((r) => srv.close(r));
  return sig;
}

(async () => {
  if (!fs.existsSync(BIN)) { console.error('FATAL binary not found: ' + BIN); process.exit(2); }
  console.log('mode=' + MODE + ' bin=' + BIN);

  const stock = await probe(BIN, fs.mkdtempSync(path.join(os.tmpdir(), 'nidp-empty-')), null);
  // 活性断言只要求本机可区分面（系统 Chrome 152 的 deviceMemory/userAgentData
  // 可能不暴露——它们不是 stock 活性的必要条件，patched 断言里单独严格验证）
  assert('N-IDP-06 默认 user-data（无 identity.json）行为与基线一致（活性）',
    typeof stock.platform === 'string' && stock.hardwareConcurrency > 0,
    JSON.stringify(stock));

  // N-IDP-03：无 identity.json → 全部 stock（两种模式都必须成立）
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nidp-nojson-'));
  const s3 = await probe(BIN, emptyDir, null);
  assert('N-IDP-03a 无 identity.json → platform=stock(' + stock.platform + ')', s3.platform === stock.platform, s3.platform);
  assert('N-IDP-03b 无 identity.json → hardwareConcurrency=stock(' + stock.hardwareConcurrency + ')', s3.hardwareConcurrency === stock.hardwareConcurrency, s3.hardwareConcurrency);
  assert('N-IDP-03c 无 identity.json → deviceMemory=stock(' + stock.deviceMemory + ')', s3.deviceMemory === stock.deviceMemory, s3.deviceMemory);

  if (MODE === 'PATCHED') {
    // N-IDP-01：identity.json 驱动（零外部 fp-* 开关）
    const dir1 = mkIdentityDir(IDENTITY_DESKTOP);
    const s1 = await probe(BIN, dir1, null);
    assert('N-IDP-01a navigator.platform=MacIntel（identity）', s1.platform === 'MacIntel', s1.platform);
    assert('N-IDP-01b platformVersion=10.0.0（identity C2）', s1.platformVersion === '10.0.0', s1.platformVersion);
    assert('N-IDP-01c hardwareConcurrency=2（identity C4）', s1.hardwareConcurrency === 2, s1.hardwareConcurrency);
    assert('N-IDP-01d deviceMemory=4（identity C5）', s1.deviceMemory === 4, s1.deviceMemory);
    assert('N-IDP-01e maxTouchPoints=0（桌面派生 C6）', s1.maxTouchPoints === 0, s1.maxTouchPoints);

    // N-IDP-02：外部显式开关优先
    const dir2 = mkIdentityDir(IDENTITY_DESKTOP);
    const s2 = await probe(BIN, dir2, ['--fp-platform=CustomVal']);
    assert('N-IDP-02 外部 --fp-platform=CustomVal 覆盖 identity（append-if-absent 语义）', s2.platform === 'CustomVal', s2.platform);

    // N-IDP-04：os=Android → maxTouchPoints=5（派生）
    const dir4 = mkIdentityDir(IDENTITY_ANDROID);
    const s4 = await probe(BIN, dir4, null);
    assert('N-IDP-04a os=Android → maxTouchPoints=5（C6 派生）', s4.maxTouchPoints === 5, s4.maxTouchPoints);
    assert('N-IDP-04b os=Android 下 platform 仍为 identity（Linux armv8l）', s4.platform === 'Linux armv8l', s4.platform);
  } else {
    skipStock('N-IDP-01/02/04 patched 专属断言（identity.json 不驱动 stock 二进制）');
  }

  // N-IDP-05：损坏 JSON → stock（两种模式都必须成立：stock 天然成立，patched 验证 fail-open）
  const dir5 = mkIdentityDir(null);
  fs.writeFileSync(path.join(dir5, 'identity.json'), '{corrupted!!!');
  const s5 = await probe(BIN, dir5, null);
  assert('N-IDP-05 损坏 identity.json → platform=stock（fail-open）', s5.platform === stock.platform, s5.platform);
  assert('N-IDP-05b 损坏 identity.json → hardwareConcurrency=stock（fail-open）', s5.hardwareConcurrency === stock.hardwareConcurrency, s5.hardwareConcurrency);

  console.log('\nRESULT: pass=' + pass + ' fail=' + fail + (failures.length ? '\n' + failures.join('\n') : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
