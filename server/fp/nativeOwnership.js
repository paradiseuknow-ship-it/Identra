'use strict';

// Phase 16-B 前置 — Native/JS/CDP Surface Ownership 注册表（16-A §IsNativeOwned 落地）
//
// 目标（16-B 规格 §14 §17）：Native = source of truth 后，inject.js 必须自动让位——
//   Native Navigator + JS Navigator override 同时生效 = 双重覆盖（禁止态）。
// 本模块 = 单一注册表：每个 surface 恰有一个 owner；inject.js 通过 fp._nativeOwned
// 消费（buildInjectionScript 内 jsOwned(surface) 守卫），Native patch 落地一个 surface
// 即在此登记 NATIVE_OWNED，JS hook 自动 skip，无需逐处改 inject.js 业务逻辑。
//
// 状态语义：
//   NATIVE_OWNED —— Native Chromium patch 持有，JS/CDP 均不得覆盖
//   JS_OWNED     —— inject.js hook 持有（当前全部默认态）
//   CDP_OWNED    —— CDP 层（如 UA override）持有
//   HYBRID       —— 分层协作（如 uaBrands：原生捕获回放+JS 双缺不覆盖）
//
// 纪律：登记不生效于行为——行为只由 inject.js 守卫与 Native patch 实际实现决定；
// 本注册表是声明层 + 取证层（JSON 快照进 evidence），fail-fast 拒绝未知 surface/owner。

const OWNERS = ['NATIVE_OWNED', 'JS_OWNED', 'CDP_OWNED', 'HYBRID'];

// Surface 词表（Phase 16-A SURFACE_MATRIX P0 家族；新 surface 必须先登记此处）
const SURFACES = [
  'navigator.userAgent', 'navigator.platform', 'navigator.vendor',
  'navigator.languages', 'navigator.webdriver', 'navigator.hardwareConcurrency',
  'navigator.deviceMemory', 'navigator.maxTouchPoints',
  'navigator.userAgentData.brands', 'navigator.userAgentData.platformVersion',
  'plugins.mimeTypes', 'screen', 'window.outer', 'window.devicePixelRatio',
  'notification.permission', 'permissions.query', 'timezone.intl', 'geolocation',
  'canvas.2d', 'webgl.parameters', 'webgpu.adapter', 'audio.analyser',
  'fonts.check', 'clientRects', 'speech.voices', 'mediaDevices.enumerate',
  'webrtc.candidates', 'chrome.object',
];

const state = new Map(SURFACES.map((s) => [s, 'JS_OWNED']));

// Phase 16-B C2 — POC 完成驱动的 NATIVE_OWNED 基线：
// 仅当对应 patch 全链完成（manifest enabled；或显式测试通道 FPB_FORCE_ACTIVE_PATCHES）
// 才登记 NATIVE_OWNED，inject.js/browserManager 自动让位。stock 二进制或未完成 POC
// 保持 JS_OWNED = 行为逐字节等价（§18 manifest discipline 的 ownership 侧镜像）。
const { isPatchActive } = require('./nativePatchManifest');

const NATIVE_OWNED_BASELINE = [
  { surface: 'navigator.userAgentData.platformVersion', patchId: 'platformversion-identity' },
  // Phase 16-B C3（navigator-identity）：manifest flip ACTIVE 后 navigator.platform
  // 由 patched NavigatorBase::platform() 单点生产（window/Worker 同源），inject.js
  // 让位（不创建 own property）。stock/未 flip 时本条不生效 = JS_OWNED 既有行为。
  { surface: 'navigator.platform', patchId: 'navigator-identity' },
  // Phase 16-B C4（hardwareConcurrency-identity）：manifest flip ACTIVE 后
  // navigator.hardwareConcurrency 由 patched NavigatorBase::hardwareConcurrency()
  // 单点生产（window/Worker 同源；CDP 显式 override 仍在 probe 层获胜），
  // inject.js 让位（不创建 own property）。stock/未 flip 时本条不生效 = JS_OWNED。
  { surface: 'navigator.hardwareConcurrency', patchId: 'hardwareConcurrency-identity' },
  // Phase 16-B C5（deviceMemory-identity）：manifest flip ACTIVE 后
  // navigator.deviceMemory 由 patched NavigatorDeviceMemory::deviceMemory()
  // 单点生产（window/Worker 同源；core/inspector 无 CDP probe 竞争），
  // inject.js 让位（不创建 own property）。stock/未 flip 时本条不生效 = JS_OWNED。
  { surface: 'navigator.deviceMemory', patchId: 'deviceMemory-identity' },
  // Phase 16-B C6（maxTouchPoints-identity）：manifest flip ACTIVE 后
  // navigator.maxTouchPoints 由 patched NavigatorEvents::maxTouchPoints()
  // 单点生产（静态工具类，window 侧唯一暴露点；WorkerNavigator 无此扩展 =
  // Worker undefined 语义天然保持；core/inspector 无 CDP probe，
  // DevToolsEmulator 触摸模拟只写 Settings 存储层不碰 JS 暴露点），
  // inject.js 让位（不创建 own property）。stock/未 flip 时本条不生效 = JS_OWNED。
  { surface: 'navigator.maxTouchPoints', patchId: 'maxTouchPoints-identity' },
];

function applyNativeOwnedBaseline() {
  for (const s of SURFACES) state.set(s, 'JS_OWNED');
  for (const b of NATIVE_OWNED_BASELINE) {
    if (isPatchActive(b.patchId)) state.set(b.surface, 'NATIVE_OWNED');
  }
}
applyNativeOwnedBaseline();

class OwnershipError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'OwnershipError';
    this.code = code;
  }
}

function setOwner(surface, owner) {
  if (!state.has(surface)) throw new OwnershipError('[fp.ownership] 未知 surface "' + surface + '"——先在 SURFACES 词表登记', 'OWNERSHIP_UNKNOWN_SURFACE');
  if (!OWNERS.includes(owner)) throw new OwnershipError('[fp.ownership] 非法 owner "' + owner + '"', 'OWNERSHIP_INVALID_OWNER');
  state.set(surface, owner);
  return state.get(surface);
}

function getOwner(surface) {
  if (!state.has(surface)) throw new OwnershipError('[fp.ownership] 未知 surface "' + surface + '"', 'OWNERSHIP_UNKNOWN_SURFACE');
  return state.get(surface);
}

// inject.js 守卫唯一入口：JS hook 是否应让位（native/hybrid 持有时 JS skip）
function isJsOwned(surface) {
  return getOwner(surface) === 'JS_OWNED' || getOwner(surface) === 'CDP_OWNED';
}

// 生成注入 fp._nativeOwned 数组（仅 NATIVE_OWNED 进入；inject.js 内 Set 消费）
function nativeOwnedSurfaces() {
  return SURFACES.filter((s) => state.get(s) === 'NATIVE_OWNED');
}

// 取证快照（禁止把该快照当行为来源）
function snapshot() {
  const out = {};
  for (const s of SURFACES) out[s] = state.get(s);
  return out;
}

function reset() {
  applyNativeOwnedBaseline();
}

module.exports = { OWNERS, SURFACES, OwnershipError, NATIVE_OWNED_BASELINE, setOwner, getOwner, isJsOwned, nativeOwnedSurfaces, snapshot, reset, applyNativeOwnedBaseline };
