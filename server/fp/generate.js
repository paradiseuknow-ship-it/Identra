'use strict';

const D = require('./data');
const { countryToLanguage } = require('../geoip');

// 简单可复现 PRNG（mulberry32），seed 由 profile id 派生，保证同一 profile 指纹稳定。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function pickInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function fmtMac(rng) {
  const prefix = pick(rng, D.MAC_PREFIXES);
  const parts = prefix.split('-').concat([...Array(3)].map(() => {
    const v = Math.floor(rng() * 256);
    return v.toString(16).toUpperCase().padStart(2, '0');
  }));
  return parts.join(':');
}

// 根据 ipGeo 解析基于 IP 的时区/语言/地理位置
function resolveIpBased(override, ipGeo) {
  const tzMode = override.timezoneMode;
  const langMode = override.languageMode;
  const geoMode = override.geolocation?.mode;

  let timezone = null;
  let timezoneOffset = null;
  let language = null;
  let languageBase = null;
  let geolocation = null;

  if (tzMode === 'ip' && ipGeo) {
    timezone = ipGeo.timezone || 'UTC';
    // ipGeo.offset 与 D.TIMEZONES 同为"东区为正"（分钟），注入脚本内会再取负转成 Date.getTimezoneOffset 约定
    timezoneOffset = typeof ipGeo.offset === 'number' ? ipGeo.offset : 0;
  }

  if (langMode === 'ip' && ipGeo) {
    const detected = ipGeo.language || countryToLanguage(ipGeo.countryCode);
    if (detected) {
      language = detected;
      languageBase = detected.split('-')[0];
    }
  }

  if (geoMode === 'ip' && ipGeo) {
    geolocation = {
      mode: 'ip',
      lat: typeof ipGeo.lat === 'number' ? ipGeo.lat : 0,
      lng: typeof ipGeo.lng === 'number' ? ipGeo.lng : 0,
      accuracy: 100,
    };
  }

  return { timezone, timezoneOffset, language, languageBase, geolocation };
}

// 根据 profile 已有指纹 + seed 生成完整指纹；若传入已有 fingerprint 则在其基础上补全（用于编辑）。
function generateFingerprint(seedStr, override = {}, ipGeo = null) {
  const rng = mulberry32(hashString(seedStr));

  // 若指定了 os/browser，优先选匹配的 UA；否则随机
  const targetOs = override.os;
  const targetBrowser = override.browser;
  let uaPool = D.USER_AGENTS;
  if (!override.userAgent && (targetOs || targetBrowser)) {
    uaPool = D.USER_AGENTS.filter((u) => {
      const osMatch = targetOs ? u.os === targetOs : true;
      const browserMatch = targetBrowser ? u.browser === targetBrowser : true;
      return osMatch && browserMatch;
    });
    if (uaPool.length === 0) uaPool = D.USER_AGENTS;
  }
  const uaObj = override.userAgent ? null : pick(rng, uaPool);
  const os = override.os || (uaObj ? uaObj.os : 'Windows');
  const browser = override.browser || (uaObj ? uaObj.browser : 'Chrome');

  const screenList = D.SCREENS[os] || D.SCREENS.Windows;
  let [w, h] = pick(rng, screenList);
  if (override.screen && override.screen.width && override.screen.height) {
    w = override.screen.width;
    h = override.screen.height;
  }
  const pixelRatio = override.screen && override.screen.pixelRatio ? override.screen.pixelRatio : pick(rng, D.PIXEL_RATIOS);

  // 时区：基于 IP > 自定义 > 随机
  const ipResolved = resolveIpBased(override, ipGeo);
  let tz;
  if (ipResolved.timezone) {
    tz = { tz: ipResolved.timezone, offset: ipResolved.timezoneOffset };
  } else if (override.timezone && override.timezoneOffset !== undefined) {
    tz = { tz: override.timezone, offset: override.timezoneOffset };
  } else if (override.timezone) {
    const found = D.TIMEZONES.find((t) => t.tz === override.timezone);
    tz = found || pick(rng, D.TIMEZONES);
  } else {
    tz = pick(rng, D.TIMEZONES);
  }

  // 语言：基于 IP > 自定义 > 随机
  let lang, langBase;
  if (ipResolved.language) {
    lang = ipResolved.language;
    langBase = ipResolved.languageBase;
  } else if (override.language) {
    lang = override.language;
    langBase = override.language.split('-')[0];
  } else {
    [lang, langBase] = pick(rng, D.LANGUAGES);
  }

  // 真实浏览器语言列表通常带英文回退，避免只有单一语言显得不自然
  const buildLanguages = (l, base) => {
    const arr = [l, base, 'en-US', 'en'].filter(Boolean);
    return [...new Set(arr)];
  };
  const languages = buildLanguages(lang, langBase);

  const fonts = override.fonts || D.FONT_SETS[os] || D.FONT_SETS.Windows;
  const webgl = override.webgl || pick(rng, D.WEBGL);
  const hardwareConcurrency = override.hardwareConcurrency || pickInt(rng, 4, 16);
  const deviceMemory = override.deviceMemory || pick(rng, D.DEVICE_MEMORY);
  const deviceName = override.deviceName || pick(rng, D.DEVICE_NAMES[os] || D.DEVICE_NAMES.Windows);
  const mac = override.mac || fmtMac(rng);

  // 地理位置：基于 IP > 自定义 > 随机 > 禁止
  let geo;
  let effectiveGeoMode = override.geolocation?.mode || 'random';
  if (ipResolved.geolocation) {
    geo = ipResolved.geolocation;
  } else if (effectiveGeoMode === 'custom' && override.geolocation && typeof override.geolocation.lat === 'number') {
    geo = { lat: override.geolocation.lat, lng: override.geolocation.lng, accuracy: override.geolocation.accuracy || 100 };
  } else if (effectiveGeoMode === 'block') {
    geo = { lat: 0, lng: 0, accuracy: 0 };
  } else {
    effectiveGeoMode = effectiveGeoMode === 'ip' ? 'random' : effectiveGeoMode;
    const picked = pick(rng, D.GEOLOCATIONS);
    geo = { lat: picked.lat, lng: picked.lng, accuracy: picked.accuracy };
  }

  // Canvas / AudioContext / ClientRects 噪声种子
  const noiseSeed = Math.floor(rng() * 1e9);

  const fp = {
    userAgent: override.userAgent || (uaObj ? uaObj.ua : ''),
    platform: override.platform || (uaObj ? uaObj.platform : 'Win32'),
    vendor: override.vendor || (uaObj ? uaObj.vendor : 'Google Inc.'),
    os,
    browser,
    screen: { width: w, height: h, availWidth: w, availHeight: h - 40, pixelRatio },
    timezone: tz.tz,
    timezoneOffset: tz.offset,
    timezoneMode: override.timezoneMode || 'random',
    language: lang,
    languageBase: langBase,
    languageMode: override.languageMode || 'random',
    languages,
    interfaceLanguage: override.interfaceLanguage || lang,
    interfaceLanguageMode: override.interfaceLanguageMode || 'language',
    fonts,
    webgl: { vendor: webgl.vendor, renderer: webgl.renderer },
    webgpu: override.webgpu !== undefined ? override.webgpu : 'webgl', // webgl | real | disable
    hardwareConcurrency,
    deviceMemory,
    deviceName,
    mac,
    geolocation: {
      mode: effectiveGeoMode,
      lat: geo.lat,
      lng: geo.lng,
      accuracy: geo.accuracy,
    },
    webRtc: override.webRtc || 'replace-udp', // replace-udp | proxy | disable | real | forward
    webRtcPublicIp: (ipGeo && ipGeo.ip) || override.webRtcPublicIp || null, // 出口公网 IP，用于 WebRTC 候选伪装
    doNotTrack: override.doNotTrack !== undefined ? override.doNotTrack : null, // null | true | false
    mediaDevices: override.mediaDevices !== undefined ? override.mediaDevices : true,
    clientRects: override.clientRects !== undefined ? override.clientRects : true,
    speechVoices: override.speechVoices !== undefined ? override.speechVoices : true,
    canvas: override.canvas !== undefined ? override.canvas : true,
    webglImage: override.webglImage !== undefined ? override.webglImage : true,
    audioContext: override.audioContext !== undefined ? override.audioContext : true,
    hardwareAcceleration: override.hardwareAcceleration !== undefined ? override.hardwareAcceleration : true,
    tlsDisabled: override.tlsDisabled !== undefined ? override.tlsDisabled : false,
    portScanProtection: override.portScanProtection !== undefined ? override.portScanProtection : false,
    randomFingerprint: override.randomFingerprint !== undefined ? override.randomFingerprint : false,
    ipGeo: ipGeo || null, // 保存检测到的 IP 地理信息，方便前端展示
    noiseSeed,
  };
  return fp;
}

// 由 profile 生成稳定 seed 字符串
function seedFromProfile(profile) {
  return profile.id + '::' + (profile.seed || profile.id) + (profile.fingerprint?.randomFingerprint ? '::' + Date.now() : '');
}

module.exports = { generateFingerprint, seedFromProfile, resolveIpBased };
