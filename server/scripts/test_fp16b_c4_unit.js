'use strict';

// Phase 16-B C4 — hardwareConcurrency-identity unit 断言集（纯 Node，无浏览器）。
//
// 断言对象纪律（同 c3_unit）：断言「真正会执行的那份东西」——chromium src 工作区
// 实际内容（已 apply 的 0005，即下次编译真正吃进去的源码）、patches/0005 工件、
// 项目侧真实接线源码、nativeOwnership 运行时语义。不 eval patch 文本、不猜测行为。

const fs = require('fs');
const path = require('path');

const FPB = path.resolve(__dirname, '..'); // server/
const CHROMIUM_SRC = 'D:/chromium/src';
const PATCH_0005 = 'D:/chromium/patches/0005-navigator-hardware-concurrency-identity.patch';

let pass = 0; let fail = 0; const failures = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + (detail !== undefined ? ' :: ' + String(detail).slice(0, 300) : '')); console.log('  FAIL ' + name); }
}
function section(name) { console.log('[' + name + ']'); }
const read = (p) => fs.readFileSync(p, 'utf8');

(async () => {
  // ---- M: manifest 真值（C4 flip 前状态）----
  section('manifest');
  const manPath = path.join(FPB, 'fp', 'nativePatchManifest.js');
  const manifest = require(manPath);
  const p = manifest.getPatch('hardwareConcurrency-identity');
  assert('M1 hardwareConcurrency-identity 存在于 manifest', !!p);
  assert('M2 sourceFiles = 实证真值（navigator_base.cc + render_process_host_impl.cc）',
    JSON.stringify(p.sourceFiles) === JSON.stringify([
      'third_party/blink/renderer/core/execution_context/navigator_base.cc',
      'content/browser/renderer_host/render_process_host_impl.cc',
    ]), JSON.stringify(p.sourceFiles));
  assert('M3 sourceSymbols = NavigatorBase::hardwareConcurrency + RenderProcessHostImpl::kSwitchNames',
    JSON.stringify(p.sourceSymbols) === JSON.stringify(['NavigatorBase::hardwareConcurrency', 'RenderProcessHostImpl::kSwitchNames']),
    JSON.stringify(p.sourceSymbols));
  assert('M4 testSuite = N-HC-01..08 完整',
    JSON.stringify(p.testSuite) === JSON.stringify(['N-HC-01', 'N-HC-02', 'N-HC-03', 'N-HC-04', 'N-HC-05', 'N-HC-06', 'N-HC-07', 'N-HC-08']),
    JSON.stringify(p.testSuite));
  assert('M5 flip 后 enabled=true / status=ACTIVE（§18：N-HC PATCHED 17/17 + 双回归全绿后翻转）',
    p.enabled === true && p.status === 'ACTIVE', p.enabled + '/' + p.status);
  assert('M6 chromiumVersion=152 + deps（identity-config-plumbing, navigator-identity）',
    p.chromiumVersion === '152'
    && Array.isArray(p.dependencies)
    && p.dependencies.includes('identity-config-plumbing')
    && p.dependencies.includes('navigator-identity'),
    p.chromiumVersion + '/' + JSON.stringify(p.dependencies));
  assert('M7 surface = navigator.hardwareConcurrency + riskLevel=LOW',
    p.surface === 'navigator.hardwareConcurrency' && p.riskLevel === 'LOW',
    p.surface + '/' + p.riskLevel);

  // ---- P: 0005 patch 工件 ----
  section('patch-0005');
  assert('P1 0005 patch 文件存在', fs.existsSync(PATCH_0005));
  const patch = read(PATCH_0005);
  assert('P2 含 navigator_base.cc diff 段',
    patch.includes('diff --git a/third_party/blink/renderer/core/execution_context/navigator_base.cc'));
  assert('P3 含 render_process_host_impl.cc diff 段（kSwitchNames 传播）',
    patch.includes('diff --git a/content/browser/renderer_host/render_process_host_impl.cc'));
  assert('P4 opt-in 语义（HasSwitch("fp-hardware-concurrency")）',
    patch.includes('HasSwitch(\n          "fp-hardware-concurrency")') || patch.includes('"fp-hardware-concurrency"'));
  assert('P5 switch 值读取（GetSwitchValueASCII）', patch.includes('GetSwitchValueASCII'));
  assert('P6 严格十进制守卫（< \'0\' || > \'9\' fail-open）',
    patch.includes("fp_c4_c < '0' || fp_c4_c > '9'"));
  assert('P7 值域守卫（[1,1024]：fp_c4_value >= 1u 且 1024u 上限）',
    patch.includes('fp_c4_value >= 1u') && patch.includes('(1024u - fp_c4_digit) / 10u'));
  assert('P8 CDP probe 调用保留（patch 之后 ApplyHardwareConcurrencyOverride 仍在）',
    patch.includes('ApplyHardwareConcurrencyOverride'));
  assert('P9 纯插入 patch（无删除行，零结构变更；-- 签名行与 --- 文件头除外）',
    !patch.split('\n').some((l) => /^-(?!-)/.test(l)));
  const added = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  assert('P10 patch budget ≤100 行（实际 ' + added + '）', added > 0 && added <= 100, added);
  assert('P11 patch 文件为 LF（无 CRLF 污染）', !patch.includes('\r'));

  // ---- S: chromium src 工作区（真正会被编译的那份）----
  section('chromium-src');
  const nb = read(path.join(CHROMIUM_SRC, 'third_party/blink/renderer/core/execution_context/navigator_base.cc'));
  assert('S1 include base/command_line.h 已在工作区（0004 复用）', nb.includes('#include "base/command_line.h"'));
  assert('S2 hardwareConcurrency() 含 fp16b C4 注释锚点（opt-in 块已落地）',
    /fp16b C4 \(hardwareConcurrency-identity\)/.test(nb));
  assert('S3 HasSwitch("fp-hardware-concurrency") 已在工作区', nb.includes('"fp-hardware-concurrency"'));
  assert('S4 stock 基值调用保留（NavigatorConcurrentHardware::hardwareConcurrency）',
    nb.includes('NavigatorConcurrentHardware::hardwareConcurrency()'));
  assert('S5 值序正确（stock 基值 → C4 opt-in 块 → CDP probe）',
    nb.indexOf('NavigatorConcurrentHardware::hardwareConcurrency()')
      < nb.indexOf('"fp-hardware-concurrency"')
    && nb.indexOf('"fp-hardware-concurrency"') < nb.lastIndexOf('ApplyHardwareConcurrencyOverride'),
    [nb.indexOf('NavigatorConcurrentHardware::hardwareConcurrency()'), nb.indexOf('"fp-hardware-concurrency"'), nb.lastIndexOf('ApplyHardwareConcurrencyOverride')].join('<'));
  assert('S6 C3 platform 块未受影响（fp16b C3 注释锚点仍在）',
    /fp16b C3 \(navigator-identity\)/.test(nb));
  assert('S7 navigator_concurrent_hardware.cc 未被触碰（单文件原则）',
    !nb.includes('navigator_concurrent_hardware.cc'));
  const rp = read(path.join(CHROMIUM_SRC, 'content/browser/renderer_host/render_process_host_impl.cc'));
  assert('S8 kSwitchNames 含 "fp-hardware-concurrency",（renderer 传播）', rp.includes('"fp-hardware-concurrency",'));
  assert('S9 fp-hardware-concurrency 位于 fp-platform 之后（0004→0005 叠加序）',
    rp.indexOf('"fp-hardware-concurrency",') > rp.indexOf('"fp-platform",'));

  // ---- W: 项目侧接线源码 ----
  section('wiring');
  const bm = read(path.join(FPB, 'browserManager.js'));
  assert('W1 isC4HardwareConcurrencyActive gate 存在', bm.includes('function isC4HardwareConcurrencyActive()'));
  assert('W2 gate = manifest active + FPB_NATIVE_CHROME（与 C2/C3 同款相干性）',
    /function isC4HardwareConcurrencyActive\(\)\s*\{\s*return isPatchActive\('hardwareConcurrency-identity'\) && !!process\.env\.FPB_NATIVE_CHROME;/.test(bm));
  assert('W3 launch 注入 --fp-hardware-concurrency=<identity 值>', bm.includes("'--fp-hardware-concurrency=' + identityHc"));
  assert('W4 bare switch value_or 语义', /\? '--fp-hardware-concurrency=' \+ identityHc : '--fp-hardware-concurrency'/.test(bm));
  assert('W5 identity 值路径 = identity.identity.cpuProfile.hardwareConcurrency',
    bm.includes('identity.identity.cpuProfile.hardwareConcurrency'));
  const inj = read(path.join(FPB, 'fp', 'inject.js'));
  assert('W6 inject.js hardwareConcurrency 让位守卫（nativeOwned 时跳过 defNav）',
    /if \(!NATIVE_OWNED_SET\.has\('navigator\.hardwareConcurrency'\)\) \{\s*\r?\n\s*defNav\('hardwareConcurrency'/.test(inj));
  assert('W7 C3 platform 让位守卫未受影响（同文件共存）',
    /if \(!NATIVE_OWNED_SET\.has\('navigator\.platform'\)\) \{\s*\r?\n\s*defNav\('platform'/.test(inj));

  // ---- O: nativeOwnership 运行时语义 ----
  section('ownership');
  const ownPath = path.join(FPB, 'fp', 'nativeOwnership.js');
  let own = require(ownPath);
  assert('O1 baseline 登记 navigator.hardwareConcurrency + hardwareConcurrency-identity',
    own.NATIVE_OWNED_BASELINE.some((b) => b.surface === 'navigator.hardwareConcurrency' && b.patchId === 'hardwareConcurrency-identity'),
    JSON.stringify(own.NATIVE_OWNED_BASELINE));
  assert('O2 flip 后（ACTIVE）→ NATIVE_OWNED（baseline 随 manifest 生效）',
    own.getOwner('navigator.hardwareConcurrency') === 'NATIVE_OWNED',
    own.getOwner('navigator.hardwareConcurrency'));
  // FORCE 测试通道语义探针：FORCE env + 模块重载 → 通道可驱动 PLANNED 的 C4；
  // finally 恢复防状态泄漏
  const prevForce = process.env.FPB_FORCE_ACTIVE_PATCHES;
  try {
    process.env.FPB_FORCE_ACTIVE_PATCHES = 'hardwareConcurrency-identity';
    delete require.cache[require.resolve(ownPath)];
    delete require.cache[require.resolve(manPath)];
    own = require(ownPath);
    const man2 = require(manPath);
    assert('O3 FORCE 测试通道可驱动 PLANNED C4（owner 短暂 NATIVE_OWNED）',
      man2.isPatchActive('hardwareConcurrency-identity') === true
      && own.getOwner('navigator.hardwareConcurrency') === 'NATIVE_OWNED',
      man2.isPatchActive('hardwareConcurrency-identity') + '/' + own.getOwner('navigator.hardwareConcurrency'));
  } finally {
    if (prevForce === undefined) delete process.env.FPB_FORCE_ACTIVE_PATCHES;
    else process.env.FPB_FORCE_ACTIVE_PATCHES = prevForce;
    delete require.cache[require.resolve(ownPath)];
    delete require.cache[require.resolve(manPath)];
    own = require(ownPath);
    const man3 = require(manPath);
    // 2026-09-07 POC #7 收口演进：identity-config-plumbing 已 ACTIVE（N-IDP 14/0），
    // FORCE 清理后保持真 ACTIVE（不再是「PLANNED→force→回 inactive」语义）。
    assert('O4 env 清理后恢复（C4 flip 后 owner 保持 NATIVE_OWNED、FORCE 目标=真 ACTIVE 不回落）',
      own.getOwner('navigator.hardwareConcurrency') === 'NATIVE_OWNED'
      && man3.isPatchActive('identity-config-plumbing') === true,
      own.getOwner('navigator.hardwareConcurrency') + '/' + man3.isPatchActive('identity-config-plumbing'));
  }

  // ---- I: identityFactory 值链路 ----
  section('identity');
  const { generateFingerprint } = require(path.join(FPB, 'fp', 'generate.js'));
  const { buildIdentity } = require(path.join(FPB, 'fp', 'identityFactory.js'));
  const fp = generateFingerprint('test-fp16b-c4-unit::identity', { os: 'Windows', browser: 'Chrome' }, null);
  const idRet = buildIdentity('test-fp16b-c4-unit::identity', fp);
  const inner = (idRet && idRet.identity && !idRet.cpuProfile) ? idRet.identity : idRet;
  assert('I1 identity.cpuProfile.hardwareConcurrency 透传 fp.hardwareConcurrency（launch switch 值来源）',
    !!(inner.cpuProfile) && inner.cpuProfile.hardwareConcurrency === fp.hardwareConcurrency
    && Number.isInteger(inner.cpuProfile.hardwareConcurrency) && inner.cpuProfile.hardwareConcurrency >= 1,
    JSON.stringify({ got: inner.cpuProfile && inner.cpuProfile.hardwareConcurrency, want: fp.hardwareConcurrency }));
  assert('I2 identity 值在 patch 合法值域 [1,1024] 内（launch 侧永不发非法值）',
    inner.cpuProfile.hardwareConcurrency >= 1 && inner.cpuProfile.hardwareConcurrency <= 1024,
    inner.cpuProfile.hardwareConcurrency);

  console.log('');
  console.log('RESULT pass=' + pass + ' fail=' + fail);
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
