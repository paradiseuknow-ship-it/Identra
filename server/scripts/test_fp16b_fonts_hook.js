'use strict';
// Phase 16-B §29 fonts 止血 — 断言 buildInjectionScript(fp) 返回的**实际执行脚本字符串**
// 在真实 Chromium（Playwright headless）中的行为（纪律：断言真正会执行的那份东西）。
// 修复前缺口：fp.fonts 生成后从未被消费，document.fonts.check 反映宿主机真实字体。
// 原生 quirk 前提（对照组实测）：check(font) 不传 text 时原生对任意字族恒返回 true，
// 因此 identity 判定全部使用带 text 的探测；空 text 必须透传原生（F3b）。
//   F0 注入脚本可解析且含 fonts hook 段
//   F1 identity 列表内字族（宿主原生不可用）→ check=true（identity 驱动，非宿主驱动）
//   F2 宿主机可用但不在 identity 列表 → check=false（切断宿主字体泄露）
//   F3a 仅通用字族 → 原生透传（与原生对照组一致）
//   F3b 空 text → 原生透传（spec quirk 保持）
//   F4 列表内+通用混排 → true；列表外+通用混排 → false（shorthand family-list 解析）
//   F5 描述符在 FontFaceSet.prototype（无实例 own 泄露）且 hook 函数有 own toString（whiten 生效）
//   F6 同 identity 跨 context 确定性一致
//   F7 fp.fonts 为空数组 → 不覆盖（mixed 探测行为与原生一致）
// 用法：node server/scripts/test_fp16b_fonts_hook.js

const { chromium } = require('playwright');
const { buildInjectionScript } = require('../fp/inject');
const { generateFingerprint } = require('../fp/generate');

const results = [];
function assert(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log('  ' + (cond ? '✔' : '✘ FAIL') + ' ' + name + (cond ? '' : '  [' + JSON.stringify(detail).slice(0, 240) + ']'));
  return !!cond;
}

(async () => {
  // identity：Windows 基线生成后收窄 fonts 列表——保留 Segoe UI/Consolas（宿主可用），
  // 剔除 Arial（宿主 Windows 必有 → F2 判别对），加入宿主必不可用的虚构字族（F1 判别对）。
  const fp = generateFingerprint('test-fp16b-fonts::seed1', { os: 'Windows', browser: 'Chrome' }, null);
  fp.fonts = ['Segoe UI', 'Consolas', 'Mythical Identity Font'];
  const script = buildInjectionScript(fp);
  let parseOk = true;
  try { new Function(script); } catch (e) { parseOk = false; console.log('  PARSE-ERROR:', e.message.slice(0, 200)); }
  if (!assert('F0 注入脚本可解析且含 FontFaceSet hook 段', parseOk && script.length > 5000 && script.indexOf('FontFaceSet.prototype.check') !== -1, typeof script)) {
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const probes = `(() => ({
    inListHostMissing: document.fonts.check('12px "Mythical Identity Font"', 'a'),
    hostAvailableNotInList: document.fonts.check('12px Arial', 'a'),
    genericOnly: document.fonts.check('12px monospace', 'a'),
    emptyText: document.fonts.check('12px Arial'),
    mixedInList: document.fonts.check('12px "Mythical Identity Font", monospace', 'a'),
    mixedNotInList: document.fonts.check('12px Arial, monospace', 'a'),
    hookOwnToString: (() => { const d = Object.getOwnPropertyDescriptor(FontFaceSet.prototype, 'check'); return d ? Object.getOwnPropertyNames(d.value).includes('toString') : null; })(),
    instanceOwnDescriptor: (() => Object.getOwnPropertyDescriptor(document.fonts, 'check') !== undefined)(),
  }))()`;

  // 原生对照组（无注入）——F1/F2/F3/F7 的判别基准
  const nativeCtx = await browser.newContext();
  const nativePage = await nativeCtx.newPage();
  await nativePage.goto('about:blank');
  const native = await nativePage.evaluate(probes);
  await nativeCtx.close();

  // identity 驱动组
  const ctx = await browser.newContext();
  await ctx.addInitScript(script);
  const page = await ctx.newPage();
  await page.goto('about:blank');
  const hooked = await page.evaluate(probes);

  assert('F1 原生对照：虚构字族（带 text）原生=true（check 无法感知系统字族缺失，实测 quirk）', native.inListHostMissing === true, native.inListHostMissing);
  assert('F1b identity 列表内 → check=true（与原生一致，宿主缺失也不改变）', hooked.inListHostMissing === true, hooked.inListHostMissing);
  assert('F2a 原生对照：Arial（带 text）check=true（宿主 Windows 可用）', native.hostAvailableNotInList === true, native.hostAvailableNotInList);
  assert('F2b 宿主可用但不在 identity 列表 → check=false（切断宿主泄露）', hooked.hostAvailableNotInList === false, hooked.hostAvailableNotInList);
  assert('F3a 仅通用字族 monospace 与原生一致', hooked.genericOnly === native.genericOnly, { hooked: hooked.genericOnly, native: native.genericOnly });
  assert('F3b 空 text 探测与原生一致（spec quirk 透传）', hooked.emptyText === native.emptyText, { hooked: hooked.emptyText, native: native.emptyText });
  assert('F4a 列表内+通用混排 → true', hooked.mixedInList === true, hooked.mixedInList);
  assert('F4b 列表外+通用混排 → false', hooked.mixedNotInList === false, hooked.mixedNotInList);
  assert('F5a hook 函数有 own toString（whiten 生效；原生函数 own 无 toString）', hooked.hookOwnToString === true, hooked.hookOwnToString);
  assert('F5b 无实例 own 描述符泄露（覆盖在 prototype 上）', hooked.instanceOwnDescriptor === false, hooked.instanceOwnDescriptor);

  // F6 确定性：同 identity 第二个 context 全部判别值一致
  const ctx2 = await browser.newContext();
  await ctx2.addInitScript(script);
  const page2 = await ctx2.newPage();
  await page2.goto('about:blank');
  const hooked2 = await page2.evaluate(probes);
  assert('F6 同 identity 跨 context 判定逐项一致',
    hooked2.inListHostMissing === hooked.inListHostMissing
    && hooked2.hostAvailableNotInList === hooked.hostAvailableNotInList
    && hooked2.mixedInList === hooked.mixedInList
    && hooked2.mixedNotInList === hooked.mixedNotInList, { hooked, hooked2 });
  await ctx2.close();

  // F7 空 fonts → 不覆盖：mixed 探测（带 text）行为与原生一致（hooked 应为 true，原生/未覆盖应为 false）
  const fpEmpty = generateFingerprint('test-fp16b-fonts::seed1', { os: 'Windows', browser: 'Chrome' }, null);
  fpEmpty.fonts = [];
  const emptyCtx = await browser.newContext();
  await emptyCtx.addInitScript(buildInjectionScript(fpEmpty));
  const emptyPage = await emptyCtx.newPage();
  await emptyPage.goto('about:blank');
  const emptyShape = await emptyPage.evaluate(`(() => ({
    mixedInList: document.fonts.check('12px "Mythical Identity Font", monospace', 'a'),
    hookOwnToString: (() => { const d = Object.getOwnPropertyDescriptor(FontFaceSet.prototype, 'check'); return d ? Object.getOwnPropertyNames(d.value).includes('toString') : null; })(),
  }))()`);
  assert('F7 空 fonts 不覆盖（mixed 判定与原生逐字节一致且 hook 未安装）',
    emptyShape.mixedInList === native.mixedInList && emptyShape.hookOwnToString === false,
    { emptyShape, nativeMixed: native.mixedInList });
  await emptyCtx.close();

  await ctx.close();
  await browser.close();

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nRESULT: ${results.length - failed}/${results.length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e && e.message); process.exit(2); });
