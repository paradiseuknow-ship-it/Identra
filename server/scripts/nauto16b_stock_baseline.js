'use strict';

// Phase 16-B §12 — N-AUTO stock 行为基线（真实 Chromium，Playwright 默认连接）
// 目的：在 Native automation patch 之前，记录 stock Chrome 在 Playwright 驱动下的
// automation 可观测信号原值（N-AUTO-01..06 stock 半边），供 patch 后对比「改变前 → 改变后」。
// 纯记录，不做任何绕过。

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('about:blank');
  const signals = await page.evaluate(() => {
    const out = {};
    // N-AUTO-01 navigator.webdriver
    out.webdriver = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver')
      ? navigator.webdriver : 'NO-DESCRIPTOR';
    // N-AUTO-02 UA / Headless 标记
    out.userAgent = navigator.userAgent;
    out.uaHasHeadless = /Headless/i.test(navigator.userAgent);
    // N-AUTO-03 userAgentData brands
    out.brands = navigator.userAgentData ? navigator.userAgentData.brands.map((b) => b.brand) : null;
    // N-AUTO-04 window.chrome
    out.windowChrome = typeof window.chrome === 'object' && window.chrome !== null;
    // N-AUTO-05 plugins/languages 形态（automation 不直接相关，作 cross-check 锚点）
    out.pluginsLength = navigator.plugins.length;
    out.languages = JSON.stringify(navigator.languages);
    // N-AUTO-06 permissions 描述符探测（Playwright/CDP 不改变其原语义）
    out.permissionsQueryExists = typeof navigator.permissions.query === 'function';
    return out;
  });
  // N-AUTO-06b: CDP 层痕迹（Playwright 默认连接不注入 cdc_*；--enable-automation 是默认 flag）
  const launchArgsStock = [
    '--disable-blink-features=AutomationControlled', // Playwright 默认不加；stock 记录为 absent
  ];
  signals.playwrightDefaultAddsEnableAutomation = true; // Playwright launch 默认带 --enable-automation（见其源码 defaults），stock Chrome 直接开则无
  signals.contextOptions = 'newContext 无任何 override';

  const out = {
    chrome: 'stock Google Chrome 152.x (system)',
    driver: 'Playwright default (no override args)',
    date: new Date().toISOString(),
    signals,
    note: 'stock 半边。Native automation patch（Navigator::webdriver() 单函数）落地后，用同脚本记录 patched 半边，逐字段对比。',
  };
  fs.writeFileSync(path.join(__dirname, '..', '..', '.benchmark', 'p16b_nauto_stock.json'),
    JSON.stringify(out, null, 2));
  console.log(JSON.stringify(signals, null, 2));
  console.log('saved -> .benchmark/p16b_nauto_stock.json');
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
