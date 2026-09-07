'use strict';
// Phase 16-B1 前置 — identitySchema / identityStore / nativeOwnership / nativePatchManifest
// 断言对象 = 真实模块行为（V1-V6 fail-fast、确定性序列化、秘密扫描、路径安全、
// ownership 让位经 buildInjectionScript 在真实 Chromium 中验证）。
// 用法：node server/scripts/test_fp16b_identity_plumbing.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const results = [];
function assert(name, cond, detail) {
  results.push({ name, pass: !!cond });
  console.log('  ' + (cond ? '✔' : '✘ FAIL') + ' ' + name + (cond ? '' : '  [' + JSON.stringify(detail).slice(0, 200) + ']'));
  return !!cond;
}
function expectThrow(fn, code) {
  try { fn(); return null; } catch (e) { return (e.code === code) ? true : { got: e.code || e.message }; }
}

const {
  IdentityError, validateIdentity, assertValidIdentity, canonicalIdentityString,
} = require('../fp/identitySchema');
const identityStore = require('../fp/identityStore');
const ownership = require('../fp/nativeOwnership');
const manifest = require('../fp/nativePatchManifest');

function baseIdentity(over = {}) {
  return Object.assign({
    identityId: 'id_test_0001',
    seed: 'seed-test-0001',
    os: 'Windows',
    osVersion: '15.0.0',
    browser: 'Chrome',
    browserVersion: '152.0.7636.1',
    cpuProfile: null,
    memoryProfile: null,
    gpuProfile: null,
    displayProfile: null,
    fontProfile: { families: ['Arial', 'Segoe UI'] },
    locale: 'en-US',
    languages: ['en-US', 'en'],
    timezone: 'America/New_York',
    networkProfile: null,
    renderingProfile: null,
    audioProfile: null,
    webrtcProfile: null,
  }, over);
}

(async () => {
  // ---- identitySchema ----
  assert('S1 合法 identity 通过', validateIdentity(baseIdentity()).ok === true, validateIdentity(baseIdentity()));
  assert('V6 缺 identityId → MISSING_FIELD',
    expectThrow(() => assertValidIdentity(baseIdentity({ identityId: undefined })), 'IDENTITY_MISSING_FIELD') === true,
    expectThrow(() => assertValidIdentity(baseIdentity({ identityId: undefined })), 'IDENTITY_MISSING_FIELD'));
  assert('V1 unknown os → UNKNOWN_OS',
    expectThrow(() => assertValidIdentity(baseIdentity({ os: 'Solaris' })), 'IDENTITY_UNKNOWN_OS') === true,
    expectThrow(() => assertValidIdentity(baseIdentity({ os: 'Solaris' })), 'IDENTITY_UNKNOWN_OS'));
  assert('V2 unknown browser → UNKNOWN_BROWSER',
    expectThrow(() => assertValidIdentity(baseIdentity({ browser: 'Firefox' })), 'IDENTITY_UNKNOWN_BROWSER') === true,
    expectThrow(() => assertValidIdentity(baseIdentity({ browser: 'Firefox' })), 'IDENTITY_UNKNOWN_BROWSER'));
  assert('V3 Windows+Safari → UNAVAILABLE_COMBINATION',
    expectThrow(() => assertValidIdentity(baseIdentity({ os: 'Windows', browser: 'Safari' })), 'IDENTITY_UNAVAILABLE_COMBINATION') === true,
    expectThrow(() => assertValidIdentity(baseIdentity({ os: 'Windows', browser: 'Safari' })), 'IDENTITY_UNAVAILABLE_COMBINATION'));
  assert('V4 osVersion 非版本格式 → INVALID_VERSION',
    expectThrow(() => assertValidIdentity(baseIdentity({ osVersion: 'fifteen' })), 'IDENTITY_INVALID_VERSION') === true,
    expectThrow(() => assertValidIdentity(baseIdentity({ osVersion: 'fifteen' })), 'IDENTITY_INVALID_VERSION'));
  assert('V5 languages 非数组 → MALFORMED',
    expectThrow(() => assertValidIdentity(baseIdentity({ languages: 'en-US' })), 'IDENTITY_MALFORMED') === true,
    expectThrow(() => assertValidIdentity(baseIdentity({ languages: 'en-US' })), 'IDENTITY_MALFORMED'));
  assert('秘密扫描：authToken 键 → FORBIDDEN_SECRET',
    expectThrow(() => assertValidIdentity(baseIdentity({ webrtcProfile: { authToken: 'x' } })), 'IDENTITY_FORBIDDEN_SECRET') === true,
    expectThrow(() => assertValidIdentity(baseIdentity({ webrtcProfile: { authToken: 'x' } })), 'IDENTITY_FORBIDDEN_SECRET'));
  const a = baseIdentity({ gpuProfile: { vendor: 'b', name: 'a' } });
  const a2 = baseIdentity({ gpuProfile: { name: 'a', vendor: 'b' } });
  assert('确定性序列化：键序无关，字节恒等', canonicalIdentityString(a) === canonicalIdentityString(a2), { a: canonicalIdentityString(a).slice(0, 80), a2: canonicalIdentityString(a2).slice(0, 80) });

  // ---- identityStore（临时 root，不污染 data/profiles）----
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fp16b-identity-'));
  const idBody = identityStore.writeIdentity('p_test0001', baseIdentity(), { root: tmpRoot });
  const file = identityStore.identityFilePath('p_test0001', tmpRoot);
  assert('ST1 落盘于 <root>/p_test0001/identity.json 且为确定性字节', fs.existsSync(file) && fs.readFileSync(file, 'utf8') === idBody, file);
  assert('ST2 不同键序写入同一字节（幂等覆盖）',
    identityStore.writeIdentity('p_test0001', baseIdentity({ languages: ['en-US', 'en'], fontProfile: { families: ['Arial', 'Segoe UI'] } }), { root: tmpRoot }) === idBody
    && identityStore.writeIdentity('p_test0001', a2, { root: tmpRoot }).length > 0,
    idBody.slice(0, 60));
  const roundtrip = identityStore.readIdentity('p_test0001', { root: tmpRoot });
  assert('ST3 读回逐字段相等', roundtrip && roundtrip.identityId === 'id_test_0001' && roundtrip.fontProfile.families.length === 2, roundtrip && roundtrip.fontProfile);
  assert('ST4 缺失 → null', identityStore.readIdentity('p_absent', { root: tmpRoot }) === null, identityStore.readIdentity('p_absent', { root: tmpRoot }));
  assert('ST5 损坏文件 → fail-fast IDENTITY_MALFORMED（不 fallback）', (() => {
    const bf = identityStore.identityFilePath('p_broken', tmpRoot);
    fs.mkdirSync(path.dirname(bf), { recursive: true });
    fs.writeFileSync(bf, '{not-json', 'utf8');
    return expectThrow(() => identityStore.readIdentity('p_broken', { root: tmpRoot }), 'IDENTITY_MALFORMED') === true;
  })(), null);
  assert('ST6 落盘后 schema 漂移（手工写入非法 os）→ 读回 fail-fast', (() => {
    const df = identityStore.identityFilePath('p_drift', tmpRoot);
    fs.mkdirSync(path.dirname(df), { recursive: true });
    fs.writeFileSync(df, JSON.stringify(baseIdentity({ os: 'Solaris' })), 'utf8');
    return expectThrow(() => identityStore.readIdentity('p_drift', { root: tmpRoot }), 'IDENTITY_UNKNOWN_OS') === true;
  })(), null);
  assert('ST7 profileId 路径穿越 → 拒绝', expectThrow(() => identityStore.identityFilePath('..\\evil', tmpRoot), null) !== null, null);
  // 隔离：两个 profile 互不串读
  identityStore.writeIdentity('p_aaa', baseIdentity({ identityId: 'id_A', seed: 'seed_A' }), { root: tmpRoot });
  identityStore.writeIdentity('p_bbb', baseIdentity({ identityId: 'id_B', seed: 'seed_B' }), { root: tmpRoot });
  assert('ST8 profile A/B 隔离（A≠B 双字段）',
    identityStore.readIdentity('p_aaa', { root: tmpRoot }).identityId === 'id_A'
    && identityStore.readIdentity('p_bbb', { root: tmpRoot }).identityId === 'id_B'
    && identityStore.readIdentity('p_aaa', { root: tmpRoot }).seed !== identityStore.readIdentity('p_bbb', { root: tmpRoot }).seed, null);
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  // ---- ownership / manifest ----
  // 2026-09-06 C2 不变量演进：默认态不再恒空集——NATIVE_OWNED 基线由「patch 全链完成
  // （manifest enabled）/显式测试通道」驱动（nativeOwnership.NATIVE_OWNED_BASELINE）。
  // 不变量 = 非 baseline surface 一律 JS_OWNED，且实际 NATIVE_OWNED 集合 ⊆ baseline allowlist。
  const OWNED_BASELINE_ALLOW = ownership.NATIVE_OWNED_BASELINE.map((b) => b.surface);
  assert('OW1 非 baseline surface 默认 JS_OWNED；NATIVE_OWNED 集合 ⊆ 基线 allowlist',
    ownership.snapshot()['fonts.check'] === 'JS_OWNED'
    && ownership.nativeOwnedSurfaces().every((s) => OWNED_BASELINE_ALLOW.includes(s)), ownership.nativeOwnedSurfaces());
  ownership.setOwner('fonts.check', 'NATIVE_OWNED');
  assert('OW2 登记 NATIVE_OWNED 后 isJsOwned=false 且进入 nativeOwnedSurfaces', ownership.isJsOwned('fonts.check') === false && ownership.nativeOwnedSurfaces().includes('fonts.check'), ownership.nativeOwnedSurfaces());
  assert('OW3 未知 surface → fail-fast', expectThrow(() => ownership.setOwner('nope.surface', 'NATIVE_OWNED'), 'OWNERSHIP_UNKNOWN_SURFACE') === true, null);
  assert('OW4 非法 owner → fail-fast', expectThrow(() => ownership.setOwner('fonts.check', 'MAGIC'), 'OWNERSHIP_INVALID_OWNER') === true, null);
  ownership.reset();
  assert('OW5 reset 回 gate 驱动 ownership 基线（fonts.check=JS_OWNED）',
    ownership.snapshot()['fonts.check'] === 'JS_OWNED'
    && JSON.stringify(ownership.nativeOwnedSurfaces().slice().sort()) === JSON.stringify(
      ownership.NATIVE_OWNED_BASELINE.filter((b) => manifest.isPatchActive(b.patchId)).map((b) => b.surface).sort()
    ), ownership.nativeOwnedSurfaces());

  assert('PM1 manifest 内建校验通过（模块加载即验证）', manifest.validateManifest(manifest.PATCHES) === true, null);
  // 2026-09-06 C2 不变量演进：enabled ⊆ 已完成全链 POC 集合。C3/C4/C5 同款演进：
  // navigator-identity（0004）、hardwareConcurrency-identity（0005，N-HC PATCHED
  // 17/17）、deviceMemory-identity（0006，N-DM PATCHED 21/0 + STOCK 2/2）均已完成全链。
  // 2026-09-08 C53 演进：ua-metadata-platform-identity（0009，metadata 生产层 platform
  // 覆盖；N-XCONS patched 10/0 含新 P6 三层同源 + gate16a 6/6 + N-IDP 14/0 + N-AUTO 5/0
  // 零退化）完成全链 → 16-B 全部 8 patch ACTIVE。
  const POC_COMPLETED = ['identity-config-plumbing', 'automation-native-webdriver', 'platformversion-identity', 'navigator-identity', 'ua-metadata-platform-identity', 'hardwareConcurrency-identity', 'deviceMemory-identity', 'maxTouchPoints-identity'];
  assert('PM2 八个 16-B patch 已登记；enabled ⊆ 已完成全链 POC 集合', manifest.PATCHES.length === 8
    && manifest.PATCHES.every((p) => p.enabled === POC_COMPLETED.includes(p.patchId)), manifest.PATCHES.map((p) => p.patchId + ':' + (p.enabled ? 'on' : 'off')));
  assert('PM3 必备字段逐项齐备', manifest.PATCHES.every((p) => manifest.REQUIRED_FIELDS.every((f) => f in p)), null);
  assert('PM4 依赖拓扑合法（重复/悬空依赖 fail-fast）', (() => {
    const dup = manifest.PATCHES.concat([Object.assign({}, manifest.PATCHES[0])]);
    const dangling = [{ patchId: 'x', surface: 's', chromiumVersion: '152', sourceFiles: ['a.cc'], sourceSymbols: ['S'], dependencies: ['ghost'], riskLevel: 'LOW', testSuite: ['T'], enabled: false }];
    return expectThrow(() => manifest.validateManifest(dup), null) !== null && expectThrow(() => manifest.validateManifest(dangling), null) !== null;
  })(), null);
  assert('PM5 拓扑序 = 已完成 POC 集合（依赖序合法）', (() => {
    const en = manifest.enabledPatchesInDependencyOrder();
    return en.length === POC_COMPLETED.length && en.every((p) => POC_COMPLETED.includes(p.patchId));
  })(), manifest.enabledPatchesInDependencyOrder().map((p) => p.patchId));

  // ---- ownership 让位行为（真实 buildInjectionScript 求值，Playwright）----
  const { chromium } = require('playwright');
  const { buildInjectionScript } = require('../fp/inject');
  const { generateFingerprint } = require('../fp/generate');
  const fp = generateFingerprint('test-fp16b-plumbing::seed1', { os: 'Windows', browser: 'Chrome' }, null);
  fp.fonts = ['Segoe UI', 'Mythical Identity Font'];
  const scriptJsOwned = buildInjectionScript(fp);
  const fpNative = Object.assign({}, fp, { _nativeOwned: ['fonts.check'] });
  const scriptNativeOwned = buildInjectionScript(fpNative);
  let parseOk1 = true, parseOk2 = true;
  try { new Function(scriptJsOwned); } catch (e) { parseOk1 = false; }
  try { new Function(scriptNativeOwned); } catch (e) { parseOk2 = false; }
  assert('IN0 两版本注入脚本均可解析（模板纪律）', parseOk1 && parseOk2, null);

  const browser = await chromium.launch({ headless: true });
  const mk = async (script) => {
    const ctx = await browser.newContext();
    await ctx.addInitScript(script);
    const page = await ctx.newPage();
    await page.goto('about:blank');
    return page.evaluate(`(() => ({
      hookOwnToString: (() => { const d = Object.getOwnPropertyDescriptor(FontFaceSet.prototype, 'check'); return d ? Object.getOwnPropertyNames(d.value).includes('toString') : null; })(),
      inList: document.fonts.check('12px "Mythical Identity Font"', 'a'),
      notInList: document.fonts.check('12px Arial', 'a'),
    }))()`);
  };
  const jsState = await mk(scriptJsOwned);
  const nativeState = await mk(scriptNativeOwned);
  assert('IN1 默认（全 JS_OWNED）→ fonts hook 生效（列表外 Arial→false）', jsState.hookOwnToString === true && jsState.notInList === false, jsState);
  assert('IN2 fonts 登记 NATIVE_OWNED → JS hook 让位（check 保持原生：Arial→true，hook 未安装）', nativeState.hookOwnToString === false && nativeState.notInList === true, nativeState);
  assert('IN3 让位后无双重覆盖（inList 语义回原生恒 true，而非 JS identity 判定）', nativeState.inList === true, nativeState.inList);
  await browser.close();

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nRESULT: ${results.length - failed}/${results.length} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e && e.message); process.exit(2); });
