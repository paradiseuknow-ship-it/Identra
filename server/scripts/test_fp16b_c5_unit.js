'use strict';

// Phase 16-B C5 — deviceMemory-identity unit 断言集（纯 Node，无浏览器）。
//
// 断言对象纪律（同 c3_unit/c4_unit）：断言「真正会执行的那份东西」——chromium src
// 工作区实际内容（已 apply 的 0006，即下次编译真正吃进去的源码）、patches/0006 工件、
// 项目侧真实接线源码、nativeOwnership 运行时语义。不 eval patch 文本、不猜测行为。
//
// C5 与 C4 的结构差异（断言语义随之不同）：
//   1) 无 CDP probe 竞争（core/inspector 无 DeviceMemory override）→ 值序断言是
//      「stock 基值 → 白名单块 → return」（无 probe 层）。
//   2) 白名单 = Chromium 真实输出域精确字符串 token {1,2,4,8,16,32}（非区间校验）。
//      依据 ApproximatedDeviceMemory 实际 clamp（桌面 [2,32]/Android [1,8]，
//      crbug 454354290）+ STOCK 实测（32GB 机器 nativeRef=32）；spec 文本域
//      {0.25..8} 已过时，0.25/0.5 为不可达 token。
//   3) patch 为替换式最小删除：唯一删除行 = return 替换行（非纯插入）。
//   4) data.js DEVICE_MEMORY 池 [4,8,8,16,16,32] 全部在真实输出域内（16/32 非反
//      真实值——实测 32GB 机器原生即返回 32）；I2 固化「池值 ⊆ patch 白名单」一致性。

const fs = require('fs');
const path = require('path');

const FPB = path.resolve(__dirname, '..'); // server/
const CHROMIUM_SRC = 'D:/chromium/src';
const PATCH_0006 = 'D:/chromium/patches/0006-navigator-device-memory-identity.patch';

let pass = 0; let fail = 0; const failures = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + (detail !== undefined ? ' :: ' + String(detail).slice(0, 300) : '')); console.log('  FAIL ' + name); }
}
function section(name) { console.log('[' + name + ']'); }
const read = (p) => fs.readFileSync(p, 'utf8');

(async () => {
  // ---- M: manifest 真值（C5 flip 前状态）----
  section('manifest');
  const manPath = path.join(FPB, 'fp', 'nativePatchManifest.js');
  const manifest = require(manPath);
  const p = manifest.getPatch('deviceMemory-identity');
  assert('M1 deviceMemory-identity 存在于 manifest', !!p);
  assert('M2 sourceFiles = 实证真值（navigator_device_memory.cc + render_process_host_impl.cc）',
    JSON.stringify(p.sourceFiles) === JSON.stringify([
      'third_party/blink/renderer/core/frame/navigator_device_memory.cc',
      'content/browser/renderer_host/render_process_host_impl.cc',
    ]), JSON.stringify(p.sourceFiles));
  assert('M3 sourceSymbols = NavigatorDeviceMemory::deviceMemory + RenderProcessHostImpl::kSwitchNames',
    JSON.stringify(p.sourceSymbols) === JSON.stringify(['NavigatorDeviceMemory::deviceMemory', 'RenderProcessHostImpl::kSwitchNames']),
    JSON.stringify(p.sourceSymbols));
  assert('M4 testSuite = N-DM-01..08 完整',
    JSON.stringify(p.testSuite) === JSON.stringify(['N-DM-01', 'N-DM-02', 'N-DM-03', 'N-DM-04', 'N-DM-05', 'N-DM-06', 'N-DM-07', 'N-DM-08']),
    JSON.stringify(p.testSuite));
  assert('M5 flip 后 enabled=true / status=ACTIVE（§18：N-DM PATCHED 21/0 + STOCK 2/2 + 双回归全绿后翻转）',
    p.enabled === true && p.status === 'ACTIVE', p.enabled + '/' + p.status);
  assert('M6 chromiumVersion=152 + deps（identity-config-plumbing, navigator-identity）',
    p.chromiumVersion === '152'
    && Array.isArray(p.dependencies)
    && p.dependencies.includes('identity-config-plumbing')
    && p.dependencies.includes('navigator-identity'),
    p.chromiumVersion + '/' + JSON.stringify(p.dependencies));
  assert('M7 surface = navigator.deviceMemory + riskLevel=LOW',
    p.surface === 'navigator.deviceMemory' && p.riskLevel === 'LOW',
    p.surface + '/' + p.riskLevel);
  assert('M8 C4 flip 状态不受 C5 登记影响（hardwareConcurrency-identity 仍 ACTIVE）',
    (() => { const c4 = manifest.getPatch('hardwareConcurrency-identity'); return c4 && c4.enabled === true && c4.status === 'ACTIVE'; })(),
    'see detail');

  // ---- P: 0006 patch 工件 ----
  section('patch-0006');
  assert('P1 0006 patch 文件存在', fs.existsSync(PATCH_0006));
  const patch = read(PATCH_0006);
  assert('P2 含 navigator_device_memory.cc diff 段',
    patch.includes('diff --git a/third_party/blink/renderer/core/frame/navigator_device_memory.cc'));
  assert('P3 含 render_process_host_impl.cc diff 段（kSwitchNames 传播）',
    patch.includes('diff --git a/content/browser/renderer_host/render_process_host_impl.cc'));
  assert('P4 opt-in 语义（HasSwitch("fp-device-memory")）',
    patch.includes('"fp-device-memory"'));
  assert('P5 switch 值读取（GetSwitchValueASCII）', patch.includes('GetSwitchValueASCII'));
  assert('P6 白名单 = Chromium 真实输出域精确 token {1, 2, 4, 8, 16, 32}',
    ['"1"', '"2"', '"4"', '"8"', '"16"', '"32"'].every((t) => patch.includes('fp_c5_dm == ' + t)),
    'whitelist tokens');
  assert('P7 stock 基值调用保留（ApproximatedDeviceMemory::GetApproximatedDeviceMemory）',
    patch.includes('ApproximatedDeviceMemory::GetApproximatedDeviceMemory()'));
  assert('P8 替换式最小删除：删除行恰 1 行且为 return 替换行（零其他结构变更）',
    (() => {
      const del = patch.split('\n').filter((l) => /^-(?!-)/.test(l));
      return del.length === 1 && del[0].includes('return ApproximatedDeviceMemory::GetApproximatedDeviceMemory()');
    })(),
    patch.split('\n').filter((l) => /^-(?!-)/.test(l)).join(' | '));
  const added = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  assert('P9 patch budget ≤100 行（实际 ' + added + '）', added > 0 && added <= 100, added);
  assert('P10 patch 文件为 LF（无 CRLF 污染）', !patch.includes('\r'));
  assert('P11 include base/command_line.h（独立文件，不可复用他文件 include）',
    patch.includes('#include "base/command_line.h"'));

  // ---- S: chromium src 工作区（真正会被编译的那份）----
  section('chromium-src');
  const ndm = read(path.join(CHROMIUM_SRC, 'third_party/blink/renderer/core/frame/navigator_device_memory.cc'));
  assert('S1 include base/command_line.h 已在工作区', ndm.includes('#include "base/command_line.h"'));
  assert('S2 deviceMemory() 含 fp16b C5 注释锚点（opt-in 块已落地）',
    /fp16b C5 \(deviceMemory-identity\)/.test(ndm));
  assert('S3 HasSwitch("fp-device-memory") 已在工作区', ndm.includes('"fp-device-memory"'));
  assert('S4 白名单六 token 全在工作区（真实输出域 {1,2,4,8,16,32}）',
    ['"1"', '"2"', '"4"', '"8"', '"16"', '"32"'].every((t) => ndm.includes('fp_c5_dm == ' + t)),
    'whitelist tokens');
  assert('S5 值序正确（stock 基值 → C5 白名单块 → return；无 probe 层）',
    ndm.indexOf('ApproximatedDeviceMemory::GetApproximatedDeviceMemory()')
      < ndm.indexOf('"fp-device-memory"')
    && ndm.lastIndexOf('return device_memory;') > ndm.indexOf('"fp-device-memory"')
    && !ndm.includes('ApplyDeviceMemoryOverride'),
    [ndm.indexOf('ApproximatedDeviceMemory::GetApproximatedDeviceMemory()'), ndm.indexOf('"fp-device-memory"'), ndm.lastIndexOf('return device_memory;')].join('<'));
  assert('S6 函数仍以 float 单函数收尾（无第二实现分叉）',
    (ndm.match(/float NavigatorDeviceMemory::deviceMemory\(\) const \{/g) || []).length === 1);
  const nb = read(path.join(CHROMIUM_SRC, 'third_party/blink/renderer/core/execution_context/navigator_base.cc'));
  assert('S7 navigator_base.cc 未被 0006 触碰（C4 块完好共存、无 deviceMemory 泄入）',
    /fp16b C4 \(hardwareConcurrency-identity\)/.test(nb) && !nb.includes('fp-device-memory'));
  const nbh = read(path.join(CHROMIUM_SRC, 'third_party/blink/renderer/core/execution_context/navigator_base.h'));
  assert('S8 NavigatorBase 多重继承 NavigatorDeviceMemory（window/Worker 单点同源根基）',
    nbh.includes('public NavigatorDeviceMemory,'));
  const rp = read(path.join(CHROMIUM_SRC, 'content/browser/renderer_host/render_process_host_impl.cc'));
  assert('S9 kSwitchNames 叠加序：fp-platform < fp-hardware-concurrency < fp-device-memory',
    rp.indexOf('"fp-platform",') < rp.indexOf('"fp-hardware-concurrency",')
    && rp.indexOf('"fp-hardware-concurrency",') < rp.indexOf('"fp-device-memory",'),
    [rp.indexOf('"fp-platform",'), rp.indexOf('"fp-hardware-concurrency",'), rp.indexOf('"fp-device-memory",')].join('<'));

  // ---- W: 项目侧接线源码 ----
  section('wiring');
  const bm = read(path.join(FPB, 'browserManager.js'));
  assert('W1 isC5DeviceMemoryActive gate 存在', bm.includes('function isC5DeviceMemoryActive()'));
  assert('W2 gate = manifest active + FPB_NATIVE_CHROME（与 C2/C3/C4 同款相干性）',
    /function isC5DeviceMemoryActive\(\)\s*\{\s*return isPatchActive\('deviceMemory-identity'\) && !!process\.env\.FPB_NATIVE_CHROME;/.test(bm));
  assert('W3 launch 注入 --fp-device-memory=<identity 值>', bm.includes("'--fp-device-memory=' + identityDm"));
  assert('W4 接线侧白名单守卫 = 真实输出域 [1,2,4,8,16,32].includes',
    bm.includes('[1, 2, 4, 8, 16, 32].includes(identityDm)'));
  assert('W5 超域 identity 值不注入（else 分支显式 NOT injected 留痕）',
    bm.includes('NOT injected') && bm.includes('identity.identity.memoryProfile.deviceMemoryGB'));
  assert('W6 identity 值路径 = identity.identity.memoryProfile.deviceMemoryGB',
    bm.includes('identity.identity.memoryProfile.deviceMemoryGB'));
  const inj = read(path.join(FPB, 'fp', 'inject.js'));
  assert('W7 inject.js deviceMemory 让位守卫（nativeOwned 时跳过 defNav）',
    /if \(!NATIVE_OWNED_SET\.has\('navigator\.deviceMemory'\)\) \{\s*\r?\n\s*defNav\('deviceMemory'/.test(inj));
  assert('W8 C4 hardwareConcurrency 让位守卫未受影响（同文件共存）',
    /if \(!NATIVE_OWNED_SET\.has\('navigator\.hardwareConcurrency'\)\) \{\s*\r?\n\s*defNav\('hardwareConcurrency'/.test(inj));

  // ---- O: nativeOwnership 运行时语义（flip 前）----
  section('ownership');
  const ownPath = path.join(FPB, 'fp', 'nativeOwnership.js');
  let own = require(ownPath);
  assert('O1 baseline 登记 navigator.deviceMemory + deviceMemory-identity',
    own.NATIVE_OWNED_BASELINE.some((b) => b.surface === 'navigator.deviceMemory' && b.patchId === 'deviceMemory-identity'),
    JSON.stringify(own.NATIVE_OWNED_BASELINE));
  assert('O2 flip 后 C5 生效 → navigator.deviceMemory NATIVE_OWNED（baseline 随 manifest 生效）',
    own.getOwner('navigator.deviceMemory') === 'NATIVE_OWNED',
    own.getOwner('navigator.deviceMemory'));
  assert('O3 SURFACES 词表已登记 navigator.deviceMemory（fail-fast 前置）',
    own.SURFACES.includes('navigator.deviceMemory'));
  // FORCE 测试通道语义探针（flip 后语义，同 c4_unit O4）：C5 已 ACTIVE，FORCE 改用
  // 仍 PLANNED 的 identity-config-plumbing 验证通道活性；finally 恢复防状态泄漏
  const prevForce = process.env.FPB_FORCE_ACTIVE_PATCHES;
  try {
    process.env.FPB_FORCE_ACTIVE_PATCHES = 'identity-config-plumbing';
    delete require.cache[require.resolve(ownPath)];
    delete require.cache[require.resolve(manPath)];
    own = require(ownPath);
    const man2 = require(manPath);
    assert('O4 FORCE 测试通道可驱动仍 PLANNED 的 identity-config-plumbing（通道活性；C5 已 ACTIVE 保持 NATIVE_OWNED）',
      man2.isPatchActive('identity-config-plumbing') === true
      && own.getOwner('navigator.deviceMemory') === 'NATIVE_OWNED',
      man2.isPatchActive('identity-config-plumbing') + '/' + own.getOwner('navigator.deviceMemory'));
  } finally {
    if (prevForce === undefined) delete process.env.FPB_FORCE_ACTIVE_PATCHES;
    else process.env.FPB_FORCE_ACTIVE_PATCHES = prevForce;
    delete require.cache[require.resolve(ownPath)];
    delete require.cache[require.resolve(manPath)];
    own = require(ownPath);
    const man3 = require(manPath);
    assert('O5 env 清理后恢复（C5 flip 后 owner 保持 NATIVE_OWNED、FORCE 目标回 inactive、C4 flip 状态不受污染）',
      own.getOwner('navigator.deviceMemory') === 'NATIVE_OWNED'
      && own.getOwner('navigator.hardwareConcurrency') === 'NATIVE_OWNED'
      && man3.isPatchActive('identity-config-plumbing') === false,
      own.getOwner('navigator.deviceMemory') + '/' + own.getOwner('navigator.hardwareConcurrency'));
  }

  // ---- I: identityFactory 值链路 ----
  section('identity');
  const { generateFingerprint } = require(path.join(FPB, 'fp', 'generate.js'));
  const { buildIdentity } = require(path.join(FPB, 'fp', 'identityFactory.js'));
  const fp = generateFingerprint('test-fp16b-c5-unit::identity', { os: 'Windows', browser: 'Chrome' }, null);
  const idRet = buildIdentity('test-fp16b-c5-unit::identity', fp);
  const inner = (idRet && idRet.identity && !idRet.memoryProfile) ? idRet.identity : idRet;
  assert('I1 identity.memoryProfile.deviceMemoryGB 透传 fp.deviceMemory（launch switch 值来源）',
    !!(inner.memoryProfile) && inner.memoryProfile.deviceMemoryGB === fp.deviceMemory,
    JSON.stringify({ got: inner.memoryProfile && inner.memoryProfile.deviceMemoryGB, want: fp.deviceMemory }));
  assert('I2 池值 ⊆ patch 白名单一致性：data.js DEVICE_MEMORY 池值全部在真实输出域 {1,2,4,8,16,32} 内' +
    '（实测 32GB 机器原生返回 32；16/32 为真实域值非反真实值）',
    (() => {
      const WHITELIST = [1, 2, 4, 8, 16, 32];
      const data = read(path.join(FPB, 'fp', 'data.js'));
      const m = data.match(/const DEVICE_MEMORY = \[([^\]]*)\];/);
      if (!m) return false;
      const vals = m[1].split(',').map((s) => parseFloat(s.trim())).filter((v) => !Number.isNaN(v));
      return vals.length > 0 && vals.every((v) => WHITELIST.includes(v));
    })(),
    'pool ⊆ whitelist');

  console.log('');
  console.log('RESULT pass=' + pass + ' fail=' + fail);
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
