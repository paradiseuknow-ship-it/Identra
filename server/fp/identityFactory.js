'use strict';

// Phase 16-B1 — Identity Factory（fp → identity 确定性映射）
//
// 架构位置（16-B 规格 §7-9）：
//   Profile(seed) → generateFingerprint(fp) → identityFactory → identity（schema 合规）
//   → identityStore（data/profiles/<id>/identity.json）→ BrowserManager → Native Chromium
//
// 硬性原则：
//   - 纯函数确定性：同 seedStr + 同 fp → identity 字节恒等（canonicalIdentityString 验证）
//   - 派生而非硬编码：browserVersion 从 fp.userAgent 解析；osVersion 来自显式派生表
//     （16-B4 platformVersion POC 将把该表升级为完整派生链，消除 '15.0.0' 孤立硬编码）
//   - fail-fast：UA 无法解析版本 / fp 非法 → IdentityError，禁止 random fallback
//   - 不携带秘密：identity 无 credentials/cookies/tokens（identitySchema 秘密扫描兜底）

const { assertValidIdentity, IdentityError } = require('./identitySchema');

// osVersion 派生表（16-B4 将升级为 identity 驱动的完整派生链）
// Windows: NT 10.0（Win10/11 共用 UA 惯例）；macOS: 14.x Sonoma 基线；Linux: 6.x 内核基线
// Android: 14（API 34 基线）；iOS: 17.5 基线（与模板池 UA 版本一致派生，16-B4 收口）
const OS_VERSION_TABLE = {
  Windows: '10.0.0',
  macOS: '14.5.0',
  Linux: '6.6.0',
  Android: '14.0.0',
  iOS: '17.5.0',
};

// FNV-1a（与 generate.js hashString 同算法；本地副本避免为导出触碰生产路径）
function fnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// identityId：由 seed + os + browser + UA 派生（同输入恒等，跨 seed 不同）
function identityIdFromSeed(seedStr, os, browser, userAgent) {
  const basis = [seedStr, os, browser, userAgent].join('\u0000');
  return 'idn-' + fnv1a(basis).toString(16).padStart(8, '0');
}

// browserVersion：从 UA 解析（Chrome/Edge→Chrome/、Firefox→Firefox/、Safari→Version/）
function browserVersionFromUA(ua) {
  if (typeof ua !== 'string' || !ua.trim()) {
    throw new IdentityError('[fp.identity] IDENTITY_INVALID_VERSION @userAgent: UA 为空，无法派生 browserVersion', 'IDENTITY_INVALID_VERSION');
  }
  const m = ua.match(/Chrome\/(\d{1,10}(?:\.\d{1,10}){0,3})/)
    || ua.match(/Firefox\/(\d{1,10}(?:\.\d{1,10}){0,3})/)
    || ua.match(/Version\/(\d{1,10}(?:\.\d{1,10}){0,3})[\s\S]*Safari/);
  if (!m) {
    throw new IdentityError('[fp.identity] IDENTITY_INVALID_VERSION @userAgent: UA 中无可识别的浏览器版本: ' + ua.slice(0, 80), 'IDENTITY_INVALID_VERSION');
  }
  return m[1];
}

// 深拷贝（profile 内对象来自 fp 引用，必须拷贝防外部突变破坏落盘稳定性）
function deepClone(v) {
  return v === null || v === undefined ? v : JSON.parse(JSON.stringify(v));
}

// fp → identity（schema 合规、fail-fast）。不修改入参 fp。
function buildIdentity(seedStr, fp) {
  if (typeof seedStr !== 'string' || !seedStr.trim()) {
    throw new IdentityError('[fp.identity] IDENTITY_MALFORMED @seed: seedStr 必须是非空 string', 'IDENTITY_MALFORMED');
  }
  if (fp === null || typeof fp !== 'object' || Array.isArray(fp)) {
    throw new IdentityError('[fp.identity] IDENTITY_MALFORMED @fp: fp 必须是对象', 'IDENTITY_MALFORMED');
  }

  const os = fp.os;
  const browser = fp.browser;
  const osVersion = OS_VERSION_TABLE[os];
  if (!osVersion) {
    // schema 值域内必然命中；到不了这里说明 fp.os 非法 → fail-fast（不猜）
    throw new IdentityError('[fp.identity] IDENTITY_UNKNOWN_OS @os: os "' + os + '" 无 osVersion 派生项', 'IDENTITY_UNKNOWN_OS');
  }
  const browserVersion = browserVersionFromUA(fp.userAgent);

  const identity = {
    identityId: identityIdFromSeed(seedStr, os, browser, fp.userAgent),
    seed: seedStr,
    os,
    osVersion,
    browser,
    browserVersion,
    locale: fp.language,
    languages: [...fp.languages],
    timezone: fp.timezone,
    cpuProfile: {
      platform: fp.platform,
      hardwareConcurrency: fp.hardwareConcurrency,
    },
    memoryProfile: {
      deviceMemoryGB: fp.deviceMemory,
    },
    gpuProfile: {
      webglVendor: fp.webgl.vendor,
      webglRenderer: fp.webgl.renderer,
      webgpuMode: fp.webgpu,
      hardwareAcceleration: fp.hardwareAcceleration,
    },
    displayProfile: {
      screenWidth: fp.screen.width,
      screenHeight: fp.screen.height,
      pixelRatio: fp.screen.pixelRatio,
      deviceName: fp.deviceName,
    },
    fontProfile: {
      families: [...fp.fonts],
    },
    networkProfile: {
      mac: fp.mac,
      webRtcMode: fp.webRtc,
      webRtcPublicIp: fp.webRtcPublicIp || null,
      tlsDisabled: fp.tlsDisabled,
      portScanProtection: fp.portScanProtection,
      geolocation: deepClone(fp.geolocation),
    },
    renderingProfile: {
      canvasNoise: fp.canvas,
      webglImageNoise: fp.webglImage,
      clientRectsNoise: fp.clientRects,
      noiseSeed: fp.noiseSeed,
    },
    audioProfile: {
      audioContextNoise: fp.audioContext,
    },
    webrtcProfile: {
      mode: fp.webRtc,
      mediaDevices: fp.mediaDevices,
    },
  };

  assertValidIdentity(identity);
  return identity;
}

module.exports = {
  buildIdentity,
  identityIdFromSeed,
  browserVersionFromUA,
  OS_VERSION_TABLE,
};
