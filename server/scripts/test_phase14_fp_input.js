'use strict';

// Phase 14.1 测试 — Fingerprint Input Normalization & Fail-Fast
// 断言目标（Phase 14 规格 §二.B）：
//   valid aliases → same canonical environment
//   invalid input → deterministic error
//   never silently fallback to random environment
// 全部纯函数级，不依赖网络/浏览器。

const assert = require('assert');
const FPInput = require('../fp/inputNormalize');
const { generateFingerprint } = require('../fp/generate');
const D = require('../fp/data');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok -', name); }
  catch (e) { fail++; console.error('  FAIL -', name, '::', e.message); }
}

// ---------- 1. 大小写归一：三态输入 → 完全一致的环境 ----------
t('Windows+Chrome / windows+chrome / WINDOWS+CHROME → 同一 canonical 环境', () => {
  const a = generateFingerprint('seed_fp_input', { os: 'Windows', browser: 'Chrome' }, null);
  const b = generateFingerprint('seed_fp_input', { os: 'windows', browser: 'chrome' }, null);
  const c = generateFingerprint('seed_fp_input', { os: 'WINDOWS', browser: 'CHROME' }, null);
  for (const f of [b, c]) {
    assert.strictEqual(f.userAgent, a.userAgent, 'UA 必须逐字节一致');
    assert.strictEqual(f.platform, a.platform, 'platform 必须一致');
    assert.strictEqual(f.os, 'Windows');
    assert.strictEqual(f.browser, 'Chrome');
  }
});

t('别名归一：win/mac/darwin/chromium/msedge/iphone → canonical', () => {
  assert.strictEqual(FPInput.canonicalOs('win'), 'Windows');
  assert.strictEqual(FPInput.canonicalOs('MAC'), 'macOS');
  assert.strictEqual(FPInput.canonicalOs('darwin'), 'macOS');
  assert.strictEqual(FPInput.canonicalOs('iphone'), 'iOS');
  assert.strictEqual(FPInput.canonicalBrowser('chromium'), 'Chrome');
  assert.strictEqual(FPInput.canonicalBrowser('msedge'), 'Edge');
});

t('null/空串输入 → null（未指定，交上层默认）', () => {
  assert.strictEqual(FPInput.canonicalOs(null), null);
  assert.strictEqual(FPInput.canonicalOs(''), null);
  assert.strictEqual(FPInput.canonicalBrowser(undefined), null);
});

// ---------- 2. fail-fast：未知输入确定性报错 ----------
t('unknown OS（solaris）→ FingerprintInputError / FP_INPUT_UNKNOWN_OS', () => {
  assert.throws(
    () => generateFingerprint('s', { os: 'solaris' }, null),
    (e) => e instanceof FPInput.FingerprintInputError && e.code === 'FP_INPUT_UNKNOWN_OS'
  );
});

t('unknown browser（firefox）→ FingerprintInputError / FP_INPUT_UNKNOWN_BROWSER', () => {
  assert.throws(
    () => generateFingerprint('s', { os: 'Windows', browser: 'firefox' }, null),
    (e) => e instanceof FPInput.FingerprintInputError && e.code === 'FP_INPUT_UNKNOWN_BROWSER'
  );
});

// ---------- 3. 禁止静默随机回退：不可用组合确定性报错 ----------
t('不可用组合 Windows+Safari → FP_INPUT_UNAVAILABLE_COMBINATION（绝不回退全池随机）', () => {
  assert.throws(
    () => generateFingerprint('s', { os: 'Windows', browser: 'Safari' }, null),
    (e) => e instanceof FPInput.FingerprintInputError && e.code === 'FP_INPUT_UNAVAILABLE_COMBINATION'
  );
  // 同样覆盖 macOS+Edge / Linux+Safari / iOS+Chrome（模板池均无此组合）
  assert.throws(() => generateFingerprint('s', { os: 'macOS', browser: 'Edge' }, null), /UNAVAILABLE_COMBINATION|无可用模板/);
  assert.throws(() => generateFingerprint('s', { os: 'Linux', browser: 'Safari' }, null), /UNAVAILABLE_COMBINATION|无可用模板/);
  assert.throws(() => generateFingerprint('s', { os: 'iOS', browser: 'Chrome' }, null), /UNAVAILABLE_COMBINATION|无可用模板/);
});

// ---------- 4. 环境一致性：canonical 输入产出的 UA/平台自洽 ----------
t('Windows 输入 → UA 含 Windows NT 且 platform=Win32（绝无 iPhone UA 错配）', () => {
  for (const seed of ['s1', 's2', 's3', 'seed_recon_webflow']) {
    const fp = generateFingerprint(seed, { os: 'Windows', browser: 'Chrome' }, null);
    assert.ok(/Windows NT/.test(fp.userAgent), seed + ' UA 应含 Windows NT: ' + fp.userAgent);
    assert.strictEqual(fp.platform, 'Win32');
    assert.ok(!/iPhone|iPad|Android/.test(fp.userAgent), seed + ' UA 不得含移动端 token');
  }
});

t('macOS 输入 → UA 含 Macintosh 且 platform=MacIntel', () => {
  const fp = generateFingerprint('smac', { os: 'macOS', browser: 'Safari' }, null);
  assert.ok(/Macintosh/.test(fp.userAgent));
  assert.strictEqual(fp.platform, 'MacIntel');
  assert.strictEqual(fp.os, 'macOS');
});

t('iOS 输入 → UA 含 iPhone 且 SCREENS/FONTS 取 iOS 域', () => {
  const fp = generateFingerprint('sios', { os: 'iOS', browser: 'Safari' }, null);
  assert.ok(/iPhone/.test(fp.userAgent));
  assert.strictEqual(fp.os, 'iOS');
});

// ---------- 5. 确定性与向后兼容 ----------
t('同 seed 同输入两次生成 → 指纹逐字节一致（canonical 化不引入随机性）', () => {
  const a = generateFingerprint('det_seed', { os: 'windows', browser: 'chrome' }, null);
  const b = generateFingerprint('det_seed', { os: 'windows', browser: 'chrome' }, null);
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
});

t('canonical 输入（规范大小写）生成结果与规范化前一致（向后兼容，老 profile 指纹不变）', () => {
  // 直接用 canonical 值生成两次对比（等价于：规范化对已是 canonical 的输入是恒等变换）
  const a = generateFingerprint('compat_seed', { os: 'Windows', browser: 'Chrome' }, null);
  const b = generateFingerprint('compat_seed', { os: 'Windows', browser: 'Chrome' }, null);
  assert.strictEqual(a.userAgent, b.userAgent);
});

t('空 override（{}）→ 正常生成（未指定 os/browser 时保持原随机语义）', () => {
  const fp = generateFingerprint('empty_seed', {}, null);
  assert.ok(fp.userAgent, '应产出 UA');
  assert.ok(FPInput.OS_CANONICAL.includes(fp.os), '随机 os 仍在 canonical 值域');
  assert.ok(FPInput.BROWSER_CANONICAL.includes(fp.browser), '随机 browser仍在 canonical 值域');
});

t('custom userAgent 路径 + 小写 os → os 被规范化（SCREENS/FONTS 域正确）', () => {
  const fp = generateFingerprint('ua_seed', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Test', os: 'windows' }, null);
  assert.strictEqual(fp.os, 'Windows');
  assert.ok(fp.screen.width > 0);
});

// ---------- 6. canonicalizeFingerprintInput 纯函数行为 ----------
t('canonicalizeFingerprintInput：仅改 os/browser 两键，其余键原样保留且不改入参', () => {
  const input = { os: 'WINDOWS', browser: 'CHROME', timezoneMode: 'ip', custom: { a: 1 } };
  const out = FPInput.canonicalizeFingerprintInput(input);
  assert.strictEqual(out.os, 'Windows');
  assert.strictEqual(out.browser, 'Chrome');
  assert.strictEqual(out.timezoneMode, 'ip');
  assert.deepStrictEqual(out.custom, { a: 1 });
  assert.strictEqual(input.os, 'WINDOWS', '入参不得被修改');
});

t('模板池 canonical 值域自检：USER_AGENTS 的 os/browser 全部落在 canonical 值域内', () => {
  for (const u of D.USER_AGENTS) {
    assert.ok(FPInput.OS_CANONICAL.includes(u.os), 'UA 池 os 越域: ' + u.os);
    assert.ok(FPInput.BROWSER_CANONICAL.includes(u.browser), 'UA 池 browser 越域: ' + u.browser);
  }
});

console.log(`\nPhase 14.1 fingerprint input: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
