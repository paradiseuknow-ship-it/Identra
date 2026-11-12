'use strict';
// C199：nativeOwnership baseline 相干性 + CDP platform 参数语义守护。
// 实证基线（C199 审计，_c198_probe/platform_probe.js 根因探针）：
//   ① 生产未启用 native 二进制（无 FPB_NATIVE_CHROME）时，旧 baseline 仍按 manifest
//      登记五 surface NATIVE_OWNED ⇒ inject.js 让位不打 JS 补丁；而行为 gate 因缺
//      env 不激活 ⇒ native 也不生产 ⇒ 双输直漏（navigator.platform='Windows' 格式
//      异常 + hardwareConcurrency/deviceMemory/maxTouchPoints 直漏真机值）。
//   ② CDP setUserAgentOverride 的 platform 参数传了 UA-CH 风格 osPlatform（'Windows'），
//      而该参数对应 navigator.platform（真 Chrome 在 Windows 恒报 'Win32'）——最经典
//      反指纹检测点。
// 修复：baseline 补 nativeBinaryActive 双条件（与行为 gate 单一事实源）；CDP platform
// 参数改传 fp.platform（Win32/MacIntel 真实形态值域）；userAgentMetadata.platform
// 保持 osPlatform（userAgentData.platform 是另一 API，真 Chrome 报 'Windows'）。
// A 单元（行为：ownership 双态）｜B 单元（行为：platform 值域）｜C 源断言（接线）。
const _fs = require('fs');
const _os = require('os');
const _path = require('path');
process.env.FPB_DATA_DIR = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'fpb-c199-guard-'));

const SERVER = _path.join(__dirname, '..');
const read = (p) => _fs.readFileSync(_path.join(SERVER, p), 'utf8');
const BM = read('browserManager.js');
const OWN = read('fp/nativeOwnership.js');
const INJ = read('fp/inject.js');

let pass = 0, fail = 0;
function chk(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ FAIL ' + name + (extra !== undefined ? '  [' + String(extra).slice(0, 200) + ']' : '')); }
}

console.log('== A 单元：nativeBinaryActive 双态与基线相干性 ==');
{
  const ownership = require('../fp/nativeOwnership');
  const FIVE = ['navigator.userAgentData.platformVersion', 'navigator.platform',
    'navigator.hardwareConcurrency', 'navigator.deviceMemory', 'navigator.maxTouchPoints'];
  chk('A1 默认（无 env）nativeBinaryActive=false', ownership.nativeBinaryActive() === false);
  chk('A2 默认基线 = 空集（五 surface 全 JS_OWNED，manifest ACTIVE 也不让位）',
    ownership.nativeOwnedSurfaces().length === 0 && FIVE.every((s) => ownership.getOwner(s) === 'JS_OWNED'),
    ownership.nativeOwnedSurfaces());
  process.env.FPB_NATIVE_CHROME = 'C:\\fpb-c199-dummy.exe';
  ownership.applyNativeOwnedBaseline();
  chk('A3 nativeBinaryActive=true → 五 surface 全 NATIVE_OWNED（双条件齐备才让位）',
    ownership.nativeOwnedSurfaces().length === 5 && FIVE.every((s) => ownership.getOwner(s) === 'NATIVE_OWNED'),
    ownership.nativeOwnedSurfaces());
  delete process.env.FPB_NATIVE_CHROME;
  ownership.applyNativeOwnedBaseline();
  chk('A4 撤 env → 回空集（C199 防双输直漏核心不变量）',
    ownership.nativeOwnedSurfaces().length === 0 && FIVE.every((s) => ownership.getOwner(s) === 'JS_OWNED'),
    ownership.nativeOwnedSurfaces());
}

console.log('== B 单元：generateFingerprint platform 值域（navigator.platform 真实形态） ==');
{
  const { generateFingerprint } = require('../fp/generate');
  const win = generateFingerprint('c199-guard-seed', { os: 'Windows', browser: 'Chrome' }, null);
  chk('B1 Windows → platform=Win32', win.platform === 'Win32', win.platform);
  const mac = generateFingerprint('c199-guard-seed', { os: 'macOS', browser: 'Chrome' }, null);
  chk('B2 macOS → platform=MacIntel', mac.platform === 'MacIntel', mac.platform);
  const lin = generateFingerprint('c199-guard-seed', { os: 'Linux', browser: 'Chrome' }, null);
  chk('B3 Linux → platform 真实形态（非 UA-CH 风格）', typeof lin.platform === 'string' && lin.platform !== 'Linux' && lin.platform.length > 0, lin.platform);
}

console.log('== C 源断言：单一事实源 + CDP platform 语义 ==');
{
  const GATES = ['platformversion-identity', 'navigator-identity', 'hardwareConcurrency-identity', 'deviceMemory-identity', 'maxTouchPoints-identity'];
  chk('C1 五个行为 gate 均消费 nativeOwnership.nativeBinaryActive()（单一事实源）',
    GATES.every((p) => BM.includes("isPatchActive('" + p + "') && nativeOwnership.nativeBinaryActive()")));
  chk('C2 gate 内联 env 展开零残留（杜绝判据再度漂移）',
    !/isPatchActive\('[^']+'\)\s*&&\s*!!process\.env\.FPB_NATIVE_CHROME/.test(BM));
  chk('C3 nativeOwnership baseline 双条件（isPatchActive && nativeBinaryActive）',
    OWN.includes('if (isPatchActive(b.patchId) && nativeBinaryActive())'));
  chk('C4 setUserAgentOverride platform 参数 = fp.platform（恰好两处：fallback+主分支）',
    (BM.match(/platform: fp\.platform,/g) || []).length === 2);
  chk('C5 userAgentMetadata.platform 保持 osPlatform（UA-CH 风格另一 API，恰好一处）',
    (BM.match(/platform: osPlatform,/g) || []).length === 1 && BM.includes('userAgentMetadata:'));
  chk('C6 inject.js 四 surface 让位守卫存在（_nativeOwned 空时恢复 JS 生产）',
    ['navigator.platform', 'navigator.hardwareConcurrency', 'navigator.deviceMemory', 'navigator.maxTouchPoints']
      .every((s) => INJ.includes("NATIVE_OWNED_SET.has('" + s + "')")));
  chk('C7 inject.js platformVersion 让位守卫存在（pvNativeOwned 形态）',
    INJ.includes("NATIVE_OWNED_SET.has('navigator.userAgentData.platformVersion')"));
}

console.log('\nC199 guard: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
