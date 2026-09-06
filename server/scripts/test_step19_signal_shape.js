'use strict';
// STEP 19 证据归因审计 — B 类修复最小工程测试
// 断言对象 = buildInjectionScript(fp) 返回的**实际执行脚本字符串**（纪律：断言真正会执行
// 的那份东西，不 readFileSync 源码再 eval）。在真实 Chromium（Playwright headless）中
// addInitScript 求值后断言页内行为：
//   S1 plugins.length === 5（STEP 23 现代清单保持）
//   S2 每个 plugin.length === 2 且 mime 类型恰为 [application/pdf, text/pdf]
//   S3 navigator.mimeTypes.length === 2（原生形状；修复前为 5）
//   S4 mimeTypes[i].enabledPlugin.name === 'PDF Viewer'（首个插件）
//   S5 共享实例恒等：plugins[i].mimeTypes[j] === navigator.mimeTypes[j]（原生恒等）
//   S6 permissions.query 映射：Notification.permission='default' → state='prompt'
//   S7 permissions.query 映射：'denied' → 'denied'
//   S8 query 传入非法 descriptor 仍交还原生抛 TypeError
// 用法：node server/scripts/test_step19_signal_shape.js

const { chromium } = require('playwright');
const { buildInjectionScript } = require('../fp/inject');
const { generateFingerprint } = require('../fp/generate');

const results = [];
function assert(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log('  ' + (cond ? '✔' : '✘ FAIL') + ' ' + name + (cond ? '' : '  [' + JSON.stringify(detail).slice(0, 200) + ']'));
  return !!cond;
}

(async () => {
  const fp = generateFingerprint('test-step19-shape::seed1', { os: 'Windows', browser: 'Chrome' }, null);
  const script = buildInjectionScript(fp);
  if (!assert('S0 注入脚本为非空字符串且含 plugins 构建段', typeof script === 'string' && script.length > 5000 && script.indexOf('PluginArray') !== -1, typeof script)) {
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  // S6/S7 需要可控的 Notification.permission：先钉成 default（脚本运行时会动态读取）
  const ctx = await browser.newContext();
  await ctx.addInitScript('Object.defineProperty(Notification, "permission", { value: "default", configurable: true });');
  await ctx.addInitScript(script);
  const page = await ctx.newPage();
  await page.goto('about:blank');

  const shape = await page.evaluate(async () => {
    const plugins = Array.from(navigator.plugins).map((p) => ({
      name: p.name, length: p.length, mimes: Array.from(p).map((m) => m.type),
    }));
    const mimes = Array.from(navigator.mimeTypes).map((m) => ({
      type: m.type, plugin: m.enabledPlugin ? m.enabledPlugin.name : null,
    }));
    const identity = plugins.map((p, i) =>
      Array.from(navigator.plugins[i].mimeTypes).map((m, j) => m === navigator.mimeTypes[j]));
    const stateDefault = await navigator.permissions.query({ name: 'notifications' }).then((s) => s.state);
    let typeErr = null;
    try { await navigator.permissions.query({ name: 'definitely-not-a-permission' }); } catch (e) { typeErr = e.name; }
    return { plugins, mimes, identity, stateDefault, typeErr };
  });

  assert('S1 plugins.length === 5', shape.plugins.length === 5, shape.plugins.length);
  assert('S2a 每个 plugin.length === 2', shape.plugins.every((p) => p.length === 2), shape.plugins.map((p) => p.length));
  assert('S2b 每个 plugin mime 类型恰为 [application/pdf, text/pdf]',
    shape.plugins.every((p) => p.mimes.join(',') === 'application/pdf,text/pdf'), shape.plugins.map((p) => p.mimes));
  assert('S3 navigator.mimeTypes.length === 2', shape.mimes.length === 2, shape.mimes.length);
  assert('S4 enabledPlugin === "PDF Viewer"（首个插件）', shape.mimes.every((m) => m.plugin === 'PDF Viewer'), shape.mimes.map((m) => m.plugin));
  const flatIdentity = [].concat.apply([], shape.identity);
  assert('S5 共享实例恒等（plugins[i].mimeTypes[j] === mimeTypes[j]）', flatIdentity.length > 0 && flatIdentity.every(Boolean), shape.identity);

  // S7：denied → denied（换 context 钉 denied）
  const ctx2 = await browser.newContext();
  await ctx2.addInitScript('Object.defineProperty(Notification, "permission", { value: "denied", configurable: true });');
  await ctx2.addInitScript(script);
  const page2 = await ctx2.newPage();
  await page2.goto('about:blank');
  const stateDenied = await page2.evaluate(async () => ({
    notif: Notification.permission,
    state: await navigator.permissions.query({ name: 'notifications' }).then((s) => s.state),
  }));
  assert('S6 default → prompt', shape.stateDefault === 'prompt', shape.stateDefault);
  // S7 语义修正：headless Chromium 原生 Notification.permission='denied' 是真实缺陷，
  // STEP 19 修复会把 denied 纠正为 default；随后 query 按原生映射 default→prompt。
  // 因此断言整条链：denied 输入 → 最终 permission=default 且 query=prompt（原生形状）。
  assert('S7 denied 输入被纠正为 default（STEP 19 修复保持）且 query=prompt',
    stateDenied.notif === 'default' && stateDenied.state === 'prompt', stateDenied);
  assert('S8 非法 descriptor 交还原生抛 TypeError', shape.typeErr === 'TypeError', shape.typeErr);

  await browser.close();
  const pass = results.filter((r) => r.pass).length;
  console.log('\nPASS=' + pass + ' FAIL=' + (results.length - pass) + ' => ' + (pass === results.length ? 'TEST_OK' : 'TEST_FAILED'));
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
