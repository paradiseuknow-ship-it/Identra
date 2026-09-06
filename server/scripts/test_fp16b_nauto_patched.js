'use strict';

// Phase 16-B POC #1 — automation-native-webdriver 行为测试（§12 N-AUTO 矩阵）。
//
// 两种模式：
//   1) stock（默认，无 FPB_NATIVE_CHROME env）：对系统 Chrome 跑 stock 半边断言，
//      保证本 harness 在回归中持续活性（与 nauto16b_stock_baseline 一致）。
//      patched 专属断言标记 SKIP-STOCK，不计失败。
//   2) patched（FPB_NATIVE_CHROME=<native chrome.exe>）：跑 patched 断言。
//      Gate D 判定入口——patched binary + 本测试全绿 = N-AUTO 行为矩阵通过。
//
// 断言矩阵：
//   N-AUTO-01 native patched：--fp-automation-webdriver 下 navigator.webdriver === false
//   N-AUTO-02 native patched：无开关 = stock 行为（webdriver === true，Playwright 下）
//   N-AUTO-03 native patched：UA 不被 POC #1 改变（交叉面 §19）
//   N-AUTO-04 stock/patched：webdriver getter 存在于 Navigator.prototype
//   N-AUTO-05 stock/patched：window.chrome 存在
//
// 注意：patch 文件 D:/chromium/patches/0001-automation-native-webdriver.patch
// 已通过 git apply --check + 字节级预验证（152.0.7977.113，autocrlf=false）。

const { chromium } = require('playwright');
const fs = require('fs');

const STOCK_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const NATIVE = process.env.FPB_NATIVE_CHROME || null;
const BIN = NATIVE || STOCK_CHROME;

let pass = 0; let fail = 0; const failures = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + (detail !== undefined ? ' :: ' + String(detail).slice(0, 300) : '')); console.log('  FAIL ' + name); }
}
function skip(name) { console.log('  SKIP ' + name); }

(async () => {
  if (!fs.existsSync(BIN)) { console.error('FATAL binary not found: ' + BIN); process.exit(2); }
  const MODE = NATIVE ? 'PATCHED' : 'STOCK';
  console.log('mode=' + MODE + ' bin=' + BIN);

  const browser = await chromium.launch({
    executablePath: BIN, headless: true,
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('about:blank');

  const sig = await page.evaluate(() => {
    const d = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
    return {
      webdriver: navigator.webdriver,
      getterExists: !!d && typeof d.get === 'function',
      windowChrome: !!window.chrome,
      ua: navigator.userAgent,
    };
  });

  // 通用断言（stock/patched 都必须成立）
  assert('N-AUTO-04 webdriver getter 存在于 Navigator.prototype', sig.getterExists);
  assert('N-AUTO-05 window.chrome 存在', sig.windowChrome);

  // stock 行为断言（patched 无开关时同样必须成立 = N-AUTO-02 的判定）
  if (sig.webdriver !== undefined) {
    assert(MODE === 'STOCK' ? 'N-AUTO-STOCK webdriver=true（Playwright 下 stock 语义，与基线一致）'
      : 'N-AUTO-02 无开关 = stock 行为（webdriver=true）', sig.webdriver === true, sig.webdriver);
  } else {
    skip('webdriver 属性未定义（' + MODE + '）');
  }

  if (MODE === 'PATCHED') {
    await ctx.close(); await browser.close();

    // N-AUTO-01：--fp-automation-webdriver 开关下 webdriver=false
    const browser2 = await chromium.launch({
      executablePath: BIN, headless: true,
      args: ['--no-first-run', '--no-default-browser-check', '--fp-automation-webdriver'],
    });
    const ctx2 = await browser2.newContext();
    const page2 = await ctx2.newPage();
    await page2.goto('about:blank');
    const patched = await page2.evaluate(() => ({
      webdriver: navigator.webdriver,
      ua: navigator.userAgent,
    }));
    assert('N-AUTO-01 --fp-automation-webdriver 下 navigator.webdriver === false', patched.webdriver === false, patched.webdriver);
    assert('N-AUTO-03 UA 不被 POC #1 改变（与无开关一致）', patched.ua === sig.ua);
    await ctx2.close(); await browser2.close();
  } else {
    skip('N-AUTO-01/03（patched 专属，STOCK 模式跳过）');
  }

  await ctx.close(); await browser.close();

  console.log('');
  console.log('RESULT mode=' + MODE + ' pass=' + pass + ' fail=' + fail);
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
