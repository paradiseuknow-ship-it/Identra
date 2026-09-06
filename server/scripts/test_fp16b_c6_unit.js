'use strict';

// Phase 16-B C6 — maxTouchPoints-identity 单元断言集（c6_unit）。
// 与 c5_unit 同构：M(manifest) / P(patch 工件) / S(chromium src) / W(接线) /
// O(ownership) / I(值链) 六区，全部纯文件/模块断言（零浏览器启动）。
//
// flip 演进点（M5/O2）：PLANNED 期断言 enabled=false + owner=JS_OWNED；
// §18 flip 时同步演进为 enabled=true/ACTIVE + NATIVE_OWNED 后重跑本测试。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PATCH = 'D:/chromium/patches/0007-max-touch-points-identity.patch';
const SRC = 'D:/chromium/src';
const NMT_CC = SRC + '/third_party/blink/renderer/core/events/navigator_events.cc';
const RPHI_CC = SRC + '/content/browser/renderer_host/render_process_host_impl.cc';
const NE_IDL = SRC + '/third_party/blink/renderer/core/events/navigator_events.idl';
const SETTINGS_JSON5 = SRC + '/third_party/blink/renderer/core/frame/settings.json5';

let pass = 0; let fail = 0; const failures = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + (detail !== undefined ? ' :: ' + String(detail).slice(0, 300) : '')); console.log('  FAIL ' + name); }
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } };

// ---- M 区：manifest 真值 ----
const manifest = require('../fp/nativePatchManifest');
const c6 = manifest.PATCHES.find((p) => p.patchId === 'maxTouchPoints-identity');
const c5 = manifest.PATCHES.find((p) => p.patchId === 'deviceMemory-identity');

assert('M1 manifest 含 maxTouchPoints-identity 条目', !!c6);
if (c6) {
  assert('M2 必备字段完整（REQUIRED_FIELDS 全集）',
    ['patchId', 'surface', 'chromiumVersion', 'sourceFiles', 'sourceSymbols', 'dependencies', 'riskLevel', 'testSuite', 'enabled'].every((f) => f in c6));
  assert('M3 surface == navigator.maxTouchPoints', c6.surface === 'navigator.maxTouchPoints', c6.surface);
  assert('M4 sourceFiles 两文件（navigator_events.cc + render_process_host_impl.cc）',
    JSON.stringify(c6.sourceFiles) === JSON.stringify([
      'third_party/blink/renderer/core/events/navigator_events.cc',
      'content/browser/renderer_host/render_process_host_impl.cc',
    ]), JSON.stringify(c6.sourceFiles));
  assert('M5 C6 flip 后：enabled=true + status=ACTIVE（§18，N-MT PATCHED 20/0 + STOCK 2/0）',
    c6.enabled === true && c6.status === 'ACTIVE', c6.enabled + '/' + c6.status);
  assert('M6 testSuite == N-MT-01..08',
    JSON.stringify(c6.testSuite) === JSON.stringify(['N-MT-01', 'N-MT-02', 'N-MT-03', 'N-MT-04', 'N-MT-05', 'N-MT-06', 'N-MT-07', 'N-MT-08']));
  assert('M7 dependencies 含 identity-config-plumbing + navigator-identity',
    c6.dependencies.includes('identity-config-plumbing') && c6.dependencies.includes('navigator-identity'));
  assert('M8 C5 deviceMemory-identity 状态不受影响（enabled=true/ACTIVE）',
    c5 && c5.enabled === true && c5.status === 'ACTIVE');
  assert('M8b manifest 总条目 = 7（六 flip + C6 PLANNED）', manifest.PATCHES.length === 7, manifest.PATCHES.length);
}

// ---- P 区：patch 工件 ----
const patchText = read(PATCH);
assert('P1 0007 patch 文件存在且非空', patchText.length > 0, PATCH);
assert('P2 patch 目标一：navigator_events.cc',
  patchText.includes('--- a/third_party/blink/renderer/core/events/navigator_events.cc'));
assert('P3 patch 目标二：render_process_host_impl.cc',
  patchText.includes('--- a/content/browser/renderer_host/render_process_host_impl.cc'));
assert('P4 白名单三分支 token "0"/"5"/"10"（真实输出域）',
  patchText.includes('fp_c6_mtp == "0"') && patchText.includes('fp_c6_mtp == "5"') && patchText.includes('fp_c6_mtp == "10"'));
assert('P5 switch 名 fp-max-touch-points', patchText.includes('"fp-max-touch-points"'));
assert('P6 纯插入（除 --- 文件头外零删除行）',
  patchText.split('\n').filter((l) => /^-[^-]/.test(l)).length === 0,
  patchText.split('\n').filter((l) => /^-[^-]/.test(l)).join(' | '));
assert('P7 注释含真实域依据（SM_MAXIMUMTOUCHES + fail-open）',
  patchText.includes('SM_MAXIMUMTOUCHES') && patchText.includes('fail open'));
assert('P8 patch 面预算 ≤ 100 行（C3 单函数级纪律）',
  patchText.split('\n').filter((l) => /^[ +]/.test(l) && !/^(---|\+\+\+)/.test(l)).length <= 100);

// ---- S 区：chromium src 实态 ----
const nmt = read(NMT_CC);
const rphi = read(RPHI_CC);
const neIdl = read(NE_IDL);
const settings = read(SETTINGS_JSON5);
assert('S1 navigator_events.cc 含 HasSwitch("fp-max-touch-points")',
  nmt.includes('HasSwitch("fp-max-touch-points")'));
assert('S2 三分支 return 0/5/10 存在',
  /fp_c6_mtp == "0"\) \{\s*\r?\n\s*return 0;/.test(nmt)
  && /fp_c6_mtp == "5"\) \{\s*\r?\n\s*return 5;/.test(nmt)
  && /fp_c6_mtp == "10"\) \{\s*\r?\n\s*return 10;/.test(nmt));
assert('S3 stock return 行保留（fail-open 兜底）',
  nmt.includes('return window ? window->GetFrame()->GetSettings()->GetMaxTouchPoints() : 0;'));
assert('S4 include base/command_line.h（独立文件自含）',
  nmt.includes('#include "base/command_line.h"'));
assert('S5 值序：HasSwitch 拦截块在 stock return 之前',
  nmt.indexOf('HasSwitch("fp-max-touch-points")') < nmt.indexOf('return window ? window->GetFrame()->GetSettings()->GetMaxTouchPoints() : 0;'));
assert('S5b 无越权改写（不含 ApplyDeviceMemoryOverride 式 helper 引用）',
  !nmt.includes('ApplyTouchPointsOverride') && !nmt.includes('fp_c5_dm'));
assert('S6 kSwitchNames 含 "fp-max-touch-points"', rphi.includes('"fp-max-touch-points",'));
assert('S7 kSwitchNames 叠加序：fp-device-memory 之后',
  rphi.indexOf('"fp-device-memory",') < rphi.indexOf('"fp-max-touch-points",'));
assert('S8 IDL = partial interface Navigator（WorkerNavigator 无扩展语义源）',
  /partial interface Navigator \{/.test(neIdl) && !/WorkerNavigator/.test(neIdl));
assert('S9 settings.json5 maxTouchPoints initial 0（值域语义源）',
  /name: "maxTouchPoints"/.test(settings) && settings.includes('initial: 0,'));

// ---- W 区：项目侧接线 ----
const bm = read(ROOT + '/server/browserManager.js');
const inj = read(ROOT + '/server/fp/inject.js');
const own = read(ROOT + '/server/fp/nativeOwnership.js');
assert('W1 browserManager 定义 isC6MaxTouchPointsActive', bm.includes('function isC6MaxTouchPointsActive()'));
assert('W2 gate 语义 = isPatchActive(maxTouchPoints-identity) && FPB_NATIVE_CHROME',
  /function isC6MaxTouchPointsActive\(\) \{\s*\r?\n\s*return isPatchActive\('maxTouchPoints-identity'\) && !!process\.env\.FPB_NATIVE_CHROME;/.test(bm));
assert('W3 launch 块注入 --fp-max-touch-points=identity 值',
  bm.includes("launchArgs.push('--fp-max-touch-points=' + identityMt);"));
assert('W4 派生规则与 inject.js JS 层同构（Android/iOS → 5，否则 0）',
  bm.includes("(fp.os === 'Android' || fp.os === 'iOS') ? 5 : 0")
  && inj.includes("(FP.os === 'Android' || FP.os === 'iOS' ? 5 : 0)"));
assert('W5 inject.js 让位守卫（NATIVE_OWNED_SET.has navigator.maxTouchPoints）',
  inj.includes("NATIVE_OWNED_SET.has('navigator.maxTouchPoints')"));
assert('W6 ownership baseline 含 {navigator.maxTouchPoints, maxTouchPoints-identity}',
  own.includes("{ surface: 'navigator.maxTouchPoints', patchId: 'maxTouchPoints-identity' }"));

// ---- O 区：ownership 真值 ----
const ownership = require('../fp/nativeOwnership');
assert('O1 SURFACES 词表含 navigator.maxTouchPoints（16-A 登记）',
  ownership.SURFACES.includes('navigator.maxTouchPoints'));
assert('O2 C6 flip 后 owner = NATIVE_OWNED（baseline 经 manifest enabled 生效）',
  ownership.getOwner('navigator.maxTouchPoints') === 'NATIVE_OWNED',
  ownership.getOwner('navigator.maxTouchPoints'));
assert('O3 flip 后 isJsOwned = false（JS 注入路径让位）',
  ownership.isJsOwned('navigator.maxTouchPoints') === false);
{
  // O4 FORCE 测试通道：仍 PLANNED 的 patchId 可经 FPB_FORCE_ACTIVE_PATCHES 驱动
  // ownership 让位（N-PV 让位矩阵在 manifest PLANNED 期的行为通道）。
  const saved = process.env.FPB_FORCE_ACTIVE_PATCHES;
  process.env.FPB_FORCE_ACTIVE_PATCHES = 'maxTouchPoints-identity';
  try {
    ownership.reset();
    assert('O4 FORCE 通道 → owner 变 NATIVE_OWNED（测试通道活性）',
      ownership.getOwner('navigator.maxTouchPoints') === 'NATIVE_OWNED',
      ownership.getOwner('navigator.maxTouchPoints'));
  } finally {
    if (saved === undefined) delete process.env.FPB_FORCE_ACTIVE_PATCHES;
    else process.env.FPB_FORCE_ACTIVE_PATCHES = saved;
    ownership.reset();
  }
  assert('O5 FORCE 撤除后回到 baseline 驱动态（enabled=true → NATIVE_OWNED 无泄漏）',
    ownership.getOwner('navigator.maxTouchPoints') === 'NATIVE_OWNED');
}

// ---- I 区：值链一致性 ----
assert('I1 白名单 {0,5,10} ⊇ JS 派生域 {0,5}（os 规则全集）',
  [0, 5].every((v) => [0, 5, 10].includes(v)));
assert('I2 browserManager 派生域 {0,5} 与 patch 白名单 token 对齐（I1 的文本级锚）',
  bm.includes("? 5 : 0") && patchText.includes('fp_c6_mtp == "0"') && patchText.includes('fp_c6_mtp == "5"'));

console.log('');
console.log('RESULT c6_unit pass=' + pass + ' fail=' + fail);
if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
process.exit(0);
