'use strict';

// P4.2 —— UA-CH brands 唯一事实源：浏览器原生运行时（native browser value is the source of truth）。
//
// 背景：STEP 23 曾在 inject.js（JS 层）与 browserManager.applyClientHints（HTTP 层）各硬编码一套
// GREASE brands（「Not=A?Brand」v99 首位）。该格式实为 Playwright bundled Chromium 151 的形状，
// 系统 Chrome 152 原生为「Chromium 首位 + Not?A_Brand v24 次位」，硬编码随浏览器版本轮换必然漂移
// （P4.1 取证：.benchmark/step19_drift_probe.json）。本模块确立修复原则：
//   native browser brands → system value → JS + HTTP（两层同源回放）。
// 严禁重新引入任何硬编码 GREASE 字符串、按版本号的 if/else 或 GREASE version table。

// 既有产品契约（源自 STEP 23 inject.js 注释与 browserManager「无 HeadlessChrome 痕迹」要求）：
// 无头二进制原生 brands 中的 HeadlessChrome 品牌呈现为 Google Chrome。
// 除该重命名外，brand 名称/顺序/数量/版本结构逐项保留，不做任何其他替换或重排。
function applyHeadlessBrandContract(list) {
  if (!Array.isArray(list)) return null;
  return list.map((b) => ({
    brand: (b && b.brand === 'HeadlessChrome') ? 'Google Chrome' : String(b && b.brand),
    version: String(b && b.version),
  }));
}

module.exports = { applyHeadlessBrandContract };
