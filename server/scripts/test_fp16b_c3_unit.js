'use strict';

// Phase 16-B C3 — navigator-identity unit 断言集（纯 Node，无浏览器）。
//
// 断言对象纪律：断言「真正会执行的那份东西」——chromium src 工作区实际内容（已 apply
// 的 0004，即下次编译真正吃进去的源码）、patches/0004 工件、项目侧真实接线源码、
// nativeOwnership 运行时语义。不 eval patch 文本、不猜测行为。

const fs = require('fs');
const path = require('path');

const FPB = path.resolve(__dirname, '..'); // server/
const CHROMIUM_SRC = 'D:/chromium/src';
const PATCH_0004 = 'D:/chromium/patches/0004-navigator-platform-identity.patch';

let pass = 0; let fail = 0; const failures = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + (detail !== undefined ? ' :: ' + String(detail).slice(0, 300) : '')); console.log('  FAIL ' + name); }
}
function section(name) { console.log('[' + name + ']'); }
const read = (p) => fs.readFileSync(p, 'utf8');

(async () => {
  // ---- M: manifest 真值（C3 flip 前状态）----
  section('manifest');
  const manPath = path.join(FPB, 'fp', 'nativePatchManifest.js');
  const manifest = require(manPath);
  const p = manifest.getPatch('navigator-identity');
  assert('M1 navigator-identity 存在于 manifest', !!p);
  assert('M2 sourceFiles = 实证真值（navigator_base.cc + render_process_host_impl.cc）',
    JSON.stringify(p.sourceFiles) === JSON.stringify([
      'third_party/blink/renderer/core/execution_context/navigator_base.cc',
      'content/browser/renderer_host/render_process_host_impl.cc',
    ]), JSON.stringify(p.sourceFiles));
  assert('M3 sourceSymbols = NavigatorBase::platform + RenderProcessHostImpl::kSwitchNames',
    JSON.stringify(p.sourceSymbols) === JSON.stringify(['NavigatorBase::platform', 'RenderProcessHostImpl::kSwitchNames']),
    JSON.stringify(p.sourceSymbols));
  assert('M4 testSuite = N-NAV-01..10 完整',
    JSON.stringify(p.testSuite) === JSON.stringify(['N-NAV-01', 'N-NAV-02', 'N-NAV-03', 'N-NAV-04', 'N-NAV-05', 'N-NAV-06', 'N-NAV-07', 'N-NAV-08', 'N-NAV-09', 'N-NAV-10']),
    JSON.stringify(p.testSuite));
  assert('M5 flip 后 enabled=true / status=ACTIVE（§18：双回归全绿后翻转）',
    p.enabled === true && p.status === 'ACTIVE', p.enabled + '/' + p.status);
  assert('M6 chromiumVersion=152 + dep identity-config-plumbing',
    p.chromiumVersion === '152' && Array.isArray(p.dependencies) && p.dependencies.includes('identity-config-plumbing'),
    p.chromiumVersion + '/' + JSON.stringify(p.dependencies));
  assert('M7 16-A 死代码规划已修正（sourceFiles 不含 navigator_id.cc / navigator_platform.cc）',
    p.sourceFiles.every((f) => !f.includes('navigator_id.cc') && !f.includes('navigator_platform.cc')),
    p.sourceFiles.join('|'));

  // ---- P: 0004 patch 工件 ----
  section('patch-0004');
  assert('P1 0004 patch 文件存在', fs.existsSync(PATCH_0004));
  const patch = read(PATCH_0004);
  assert('P2 含 navigator_base.cc diff 段',
    patch.includes('diff --git a/third_party/blink/renderer/core/execution_context/navigator_base.cc'));
  assert('P3 含 render_process_host_impl.cc diff 段（kSwitchNames 传播）',
    patch.includes('diff --git a/content/browser/renderer_host/render_process_host_impl.cc'));
  assert('P4 opt-in 语义（HasSwitch("fp-platform")）', patch.includes('HasSwitch("fp-platform")'));
  assert('P5 switch 值读取（GetSwitchValueASCII）', patch.includes('GetSwitchValueASCII'));
  assert('P6 ASCII 守卫（>= 0x80 fail-open）', patch.includes('>= 0x80'));
  assert('P7 latin1 构造返回（return String(fp_c3_platform)）',
    patch.includes('return String(fp_c3_platform)'));
  assert('P8 不触碰 navigator_id.cc（死代码修正证据）',
    !patch.includes('a/third_party/blink/renderer/core/frame/navigator_id.cc'));
  const added = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  assert('P9 patch budget ≤100 行（实际 ' + added + '）', added > 0 && added <= 100, added);
  assert('P10 patch 文件为 LF（无 CRLF 污染）', !patch.includes('\r'));

  // ---- S: chromium src 工作区（真正会被编译的那份）----
  section('chromium-src');
  const nb = read(path.join(CHROMIUM_SRC, 'third_party/blink/renderer/core/execution_context/navigator_base.cc'));
  assert('S1 include base/command_line.h 已在工作区', nb.includes('#include "base/command_line.h"'));
  assert('S2 NavigatorBase::platform() 头部即 opt-in 块（fp16b C3 注释锚点）',
    /String NavigatorBase::platform\(\) const \{\s*\r?\n\s*\/\/ fp16b C3/.test(nb));
  assert('S3 HasSwitch("fp-platform") 已在工作区', nb.includes('HasSwitch("fp-platform")'));
  assert('S4 ASCII 守卫已在工作区', nb.includes('>= 0x80'));
  assert('S5 值序正确（ASCII 校验先于 String 构造）',
    nb.indexOf('>= 0x80') >= 0 && nb.indexOf('>= 0x80') < nb.indexOf('return String(fp_c3_platform)'));
  assert('S6 stock 路径保留（GetReducedNavigatorPlatform 仍在）',
    nb.includes('GetReducedNavigatorPlatform()'));
  const rp = read(path.join(CHROMIUM_SRC, 'content/browser/renderer_host/render_process_host_impl.cc'));
  assert('S7 kSwitchNames 含 "fp-platform",（renderer 传播）', rp.includes('"fp-platform",'));
  assert('S8 fp-platform 位于 fp-automation-webdriver 之后（0002 叠加序）',
    rp.indexOf('"fp-platform",') > rp.indexOf('"fp-automation-webdriver",'));

  // ---- W: 项目侧接线源码 ----
  section('wiring');
  const bm = read(path.join(FPB, 'browserManager.js'));
  assert('W1 isC3PlatformActive gate 存在', bm.includes('function isC3PlatformActive()'));
  assert('W2 gate = manifest active + FPB_NATIVE_CHROME（与 C2 同款相干性）',
    /function isC3PlatformActive\(\)\s*\{\s*return isPatchActive\('navigator-identity'\) && !!process\.env\.FPB_NATIVE_CHROME;/.test(bm));
  assert('W3 launch 注入 --fp-platform=<identity 值>', bm.includes("'--fp-platform=' + identityPlatform"));
  assert('W4 bare switch value_or 语义', /\? '--fp-platform=' \+ identityPlatform : '--fp-platform'/.test(bm));
  assert('W5 identity 值路径 = identity.identity.cpuProfile.platform',
    bm.includes('identity.identity.cpuProfile.platform'));
  const inj = read(path.join(FPB, 'fp', 'inject.js'));
  assert('W6 inject.js platform 让位守卫（nativeOwned 时跳过 defNav）',
    /if \(!NATIVE_OWNED_SET\.has\('navigator\.platform'\)\) \{\s*\r?\n\s*defNav\('platform'/.test(inj));

  // ---- O: nativeOwnership 运行时语义 ----
  section('ownership');
  const ownPath = path.join(FPB, 'fp', 'nativeOwnership.js');
  let own = require(ownPath);
  assert('O1 baseline 登记 navigator.platform + navigator-identity',
    own.NATIVE_OWNED_BASELINE.some((b) => b.surface === 'navigator.platform' && b.patchId === 'navigator-identity'),
    JSON.stringify(own.NATIVE_OWNED_BASELINE));
  assert('O2 flip 后（ACTIVE）→ NATIVE_OWNED（baseline 随 manifest 生效）',
    own.getOwner('navigator.platform') === 'NATIVE_OWNED',
    own.getOwner('navigator.platform'));
  // 测试通道语义探针（flip 后用仍处 PLANNED 的 identity-config-plumbing 验证）：
  // FORCE env + 模块重载 → 通道可驱动 PLANNED patch；finally 恢复防状态泄漏
  const prevForce = process.env.FPB_FORCE_ACTIVE_PATCHES;
  try {
    process.env.FPB_FORCE_ACTIVE_PATCHES = 'identity-config-plumbing';
    delete require.cache[require.resolve(ownPath)];
    delete require.cache[require.resolve(manPath)];
    own = require(ownPath);
    const man2 = require(manPath);
    assert('O3 FORCE 测试通道可驱动 PLANNED patch（identity-config-plumbing）',
      man2.isPatchActive('identity-config-plumbing') === true
      && own.getOwner('navigator.platform') === 'NATIVE_OWNED', // navigator-identity 已 enabled，不受 FORCE 影响
      man2.isPatchActive('identity-config-plumbing'));
  } finally {
    if (prevForce === undefined) delete process.env.FPB_FORCE_ACTIVE_PATCHES;
    else process.env.FPB_FORCE_ACTIVE_PATCHES = prevForce;
    delete require.cache[require.resolve(ownPath)];
    delete require.cache[require.resolve(manPath)];
    own = require(ownPath);
    const man3 = require(manPath);
    assert('O4 env 清理后恢复（navigator.platform 保持 NATIVE_OWNED、PLANNED patch 回到 inactive）',
      own.getOwner('navigator.platform') === 'NATIVE_OWNED'
      && man3.isPatchActive('identity-config-plumbing') === false,
      own.getOwner('navigator.platform') + '/' + man3.isPatchActive('identity-config-plumbing'));
  }

  // ---- I: identityFactory 值链路 ----
  section('identity');
  const { generateFingerprint } = require(path.join(FPB, 'fp', 'generate.js'));
  const { buildIdentity } = require(path.join(FPB, 'fp', 'identityFactory.js'));
  const fp = generateFingerprint('test-fp16b-c3-unit::identity', { os: 'Windows', browser: 'Chrome' }, null);
  const idRet = buildIdentity('test-fp16b-c3-unit::identity', fp);
  const inner = (idRet && idRet.identity && !idRet.cpuProfile) ? idRet.identity : idRet;
  assert('I1 identity.cpuProfile.platform 透传 fp.platform（launch switch 值来源）',
    !!(inner.cpuProfile) && inner.cpuProfile.platform === fp.platform,
    JSON.stringify({ got: inner.cpuProfile && inner.cpuProfile.platform, want: fp.platform }));

  console.log('');
  console.log('RESULT pass=' + pass + ' fail=' + fail);
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
