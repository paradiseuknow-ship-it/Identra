'use strict';
// P3.2 humanType replace-input 语义 targeted tests
// Test1 首次输入 / Test2 二次覆盖（核心回归）/ Test3 多次覆盖
// Test4 空串（契约澄清：replace 语义下 = 清空）/ Test5 textarea / Test6 credential no-op
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name); }
}

(async () => {
  const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
  const browserManager = require(path.join(ROOT, 'server', 'browserManager.js'));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(`
    <input id="q" value="">
    <textarea id="ta">old text</textarea>
    <input id="cred" value="">
  `);

  console.log('① Test1 首次输入');
  await browserManager.humanType(page, '#q', '无线鼠标');
  ok((await page.inputValue('#q')) === '无线鼠标', '首次输入 → "无线鼠标"');

  console.log('② Test2 二次覆盖（核心回归：不得拼接）');
  await browserManager.humanType(page, '#q', '机械键盘');
  ok((await page.inputValue('#q')) === '机械键盘', '前置值就位');
  await browserManager.humanType(page, '#q', '无线鼠标');
  const v2 = await page.inputValue('#q');
  ok(v2 === '无线鼠标', '二次输入 → "无线鼠标"（实际: ' + JSON.stringify(v2) + '）');
  ok(v2 !== '机械键盘无线鼠标', '不得拼接为 "机械键盘无线鼠标"');

  console.log('③ Test3 多次输入');
  await browserManager.humanType(page, '#q', 'A');
  await browserManager.humanType(page, '#q', 'B');
  await browserManager.humanType(page, '#q', 'C');
  ok((await page.inputValue('#q')) === 'C', 'A→B→C 三次后 = "C"（非 "ABC"）');

  console.log('④ Test4 空串（replace 语义自然延伸：清空）');
  await browserManager.humanType(page, '#q', 'xyz');
  await browserManager.humanType(page, '#q', '');
  ok((await page.inputValue('#q')) === '', 'humanType("") → 清空（replace 语义下唯一一致行为）');

  console.log('⑤ Test5 textarea');
  await browserManager.humanType(page, '#ta', 'new');
  ok((await page.inputValue('#ta')) === 'new', 'textarea "old text" → "new"');

  console.log('⑥ Test6 credential 路径 no-op 幂等（空框注入不丢字符）');
  await browserManager.humanType(page, '#cred', '4111111111111111');
  ok((await page.inputValue('#cred')) === '4111111111111111', '空输入框 credential 注入 → 完整值（清空 no-op 不破坏）');

  await browser.close();
  console.log('\n结果: ' + passed + ' passed / ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
