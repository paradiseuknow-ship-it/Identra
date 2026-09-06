'use strict';
// STEP 19 证据归因审计 — 25 信号族 × 3 模式对照（指令十：不追求检测站点评分）
// 目标：找出当前暴露的 headless 相关信号，逐项判定 A(真实工程缺陷)/B(可安全修复的一致性问题)/
//       C(Chromium/Playwright/headless 架构固有限制)/D(仅针对检测站点的 spoof 优化)。
// 只修 A/B；C 记录为产品边界；D 禁止。第三方检测只作外部 Evidence。
// 模式：
//   M1 product-headless      产品注入 + headless:true（架构最不利形态，用于暴露 C 类信号）
//   M2 product-hidden-headful 产品注入 + hiddenWindow:true（当前推荐反检测形态）
//   M3 control-headed        原生系统 Chrome headed 无注入（真实性基线）
// contract 对照基线 = session.fp（launch 时 geo/引擎对齐后的会话指纹，非 profile 预生成值）。
// 用法：node server/scripts/audit_headless_signals.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-step19-audit-'));
process.env.FPB_DATA_DIR = TMP;

const { chromium } = require('playwright');
const db = require('../db');
const { generateFingerprint, seedFromProfile } = require('../fp/generate');
const browserManager = require('../browserManager');

const SYSTEM_CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const out = { at: new Date().toISOString(), modes: {}, contractChecks: {} };

// file:// 探针页（含 iframe 供维度检查）
const probeHtml = '<!DOCTYPE html><html><head><title>probe</title></head><body>' +
  '<iframe id="f" width="500" height="300" src="about:blank"></iframe>' +
  '<script>window.__probeReady = true;</script></body></html>';
const probePath = path.join(TMP, 'probe.html');
fs.writeFileSync(probePath, probeHtml, 'utf8');

async function collectBattery(page) {
  return await page.evaluate(async () => {
    const dsc = (obj, key) => {
      let o = obj, loc = 'missing';
      while (o) {
        if (Object.prototype.hasOwnProperty.call(o, key)) {
          const d = Object.getOwnPropertyDescriptor(o, key);
          const isProto = o !== obj;
          loc = (isProto ? 'proto:' : 'own:') + (d && d.get ? (String(d.get).includes('[native code]') ? 'native-get' : 'JS-get') : (d ? 'val' : '?'));
          return loc;
        }
        o = Object.getPrototypeOf(o);
      }
      return loc;
    };
    const fnNative = (f) => !!f && String(f).includes('[native code]');
    const res = {};
    res.ua = navigator.userAgent;
    res.uaHeadlessLike = /headless/i.test(navigator.userAgent);
    res.webdriver = navigator.webdriver;
    res.platformNav = navigator.platform;
    // 1/2 mimeTypes & plugins
    res.mimeTypes = { length: navigator.mimeTypes.length, loc: dsc(navigator, 'mimeTypes'), getterNative: dsc(navigator, 'mimeTypes').includes('native-get') };
    res.plugins = { length: navigator.plugins.length, names: Array.from(navigator.plugins).map(function (p) { return p.name; }), loc: dsc(navigator, 'plugins') };
    // 3 screen
    res.screen = { w: screen.width, h: screen.height, availW: screen.availWidth, availH: screen.availHeight, colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth, dpr: window.devicePixelRatio };
    // 4/5 outer vs inner
    res.window = { outerW: window.outerWidth, outerH: window.outerHeight, innerW: window.innerWidth, innerH: window.innerHeight, screenX: window.screenX, screenY: window.screenY };
    res.outerGeInner = window.outerWidth >= window.innerWidth && window.outerHeight >= window.innerHeight;
    // 6 notification
    res.notification = { permission: (window.Notification && Notification.permission) || 'unavailable' };
    // 8 permissions API
    let permState = null;
    try { permState = await navigator.permissions.query({ name: 'notifications' }).then(function (s) { return s.state; }); } catch (e) { permState = 'error:' + String(e).slice(0, 60); }
    res.permissionsNotification = permState;
    // 7 window.chrome
    res.windowChrome = window.chrome ? { keys: Object.keys(window.chrome), hasApp: !!window.chrome.app, hasRuntime: !!window.chrome.runtime, hasCsi: !!window.chrome.csi, hasLoadTimes: !!window.chrome.loadTimes } : null;
    // 10 connection
    res.connection = navigator.connection ? { effectiveType: navigator.connection.effectiveType, downlink: navigator.connection.downlink, rtt: navigator.connection.rtt, type: navigator.connection.type || null } : null;
    // 11/12 exotic APIs
    res.contactsManager = !!navigator.contacts;
    res.contentIndex = !!(window.ContentIndex || (navigator.serviceWorker && 'getRegistrations' in navigator.serviceWorker)) && 'index' in (window.Registration || {});
    // 13/14 hardware
    res.deviceMemory = navigator.deviceMemory;
    res.hardwareConcurrency = navigator.hardwareConcurrency;
    // 15 webgl
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        res.webgl = {
          vendor: gl.getParameter(gl.VENDOR),
          renderer: gl.getParameter(gl.RENDERER),
          unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
          unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
        };
      } else res.webgl = { disabled: true };
    } catch (e) { res.webgl = { error: String(e).slice(0, 80) }; }
    // 16 webgpu
    try {
      res.webgpu = navigator.gpu ? await navigator.gpu.requestAdapter().then(function (a) { return a ? { exists: true, info: 'adapter-ok' } : { exists: true, adapter: null }; }) : { exists: false };
    } catch (e) { res.webgpu = { error: String(e).slice(0, 80) }; }
    // 17 mediaDevices
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      res.mediaDevices = { count: devs.length, kinds: devs.map(function (d) { return d.kind; }) };
    } catch (e) { res.mediaDevices = { error: String(e).slice(0, 80) }; }
    // 18 speech
    res.speechVoices = window.speechSynthesis ? speechSynthesis.getVoices().length : 'unavailable';
    // 19 fonts（抽查常用字体可用性）
    try {
      const fontsToCheck = ['Arial', 'Courier New', 'Georgia', 'Times New Roman', 'Verdana', 'Segoe UI', 'Tahoma', 'Calibri', 'Impact', 'Comic Sans MS'];
      const avail = fontsToCheck.filter(function (f) { return document.fonts.check('12px "' + f + '"'); });
      res.fonts = { checked: fontsToCheck.length, available: avail.length, sample: avail.slice(0, 5) };
    } catch (e) { res.fonts = { error: String(e).slice(0, 80) }; }
    // 20/21 UA-CH / client hints
    if (navigator.userAgentData) {
      res.userAgentData = { brands: navigator.userAgentData.brands.map(function (b) { return b.brand + '|' + b.version; }), mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform };
      try {
        res.uaHighEntropy = await navigator.userAgentData.getHighEntropyValues(['platformVersion', 'fullVersionList', 'uaFullVersion', 'model', 'architecture', 'bitness']);
      } catch (e) { res.uaHighEntropy = { error: String(e).slice(0, 80) }; }
    } else res.userAgentData = null;
    // 22 timezone / language
    res.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    res.language = navigator.language;
    res.languages = Array.from(navigator.languages);
    // 23 webrtc
    res.rtcPeerConnection = typeof window.RTCPeerConnection !== 'undefined' || typeof window.webkitRTCPeerConnection !== 'undefined';
    // 24 iframe dims
    try {
      const f = document.getElementById('f');
      res.iframe = { w: f.getBoundingClientRect().width, h: f.getBoundingClientRect().height, contentInnerW: f.contentWindow.innerWidth, contentInnerH: f.contentWindow.innerHeight };
    } catch (e) { res.iframe = { error: String(e).slice(0, 80) }; }
    // 25 headless 专属 API 面
    res.headlessApiSurface = {
      hasHeadlessUA: /headless/i.test(navigator.userAgent),
      notificationPermission: (window.Notification && Notification.permission) || 'unavailable',
      pluginsEmpty: navigator.plugins.length === 0,
      mimeTypesEmpty: navigator.mimeTypes.length === 0,
      missingWindowChromeApp: !!(window.chrome && !window.chrome.app),
    };
    return res;
  });
}

function buildProfile(id, seed, opts) {
  const profile = {
    id, name: id, group: 'audit', tags: [], notes: '',
    seed, headless: !!opts.headless, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: Object.assign({ restoreLastSession: false, blockVideo: false, blockImages: false, blockImagesThresholdKB: 10, clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false }, opts.launchBehavior || {}),
    lastSessionUrls: [], fingerprintOverride: {}, createdAt: Date.now(),
  };
  profile.fingerprint = generateFingerprint(seedFromProfile(profile), { os: 'Windows', browser: 'Chrome' }, null);
  return profile;
}

// contract 一致性检查（产品模式）：页内观测值 vs session.fp（对齐后会话指纹）
function contractChecks(obs, fp) {
  const checks = [];
  const add = (name, expected, actual, note) => checks.push({
    name, expected: expected === undefined ? null : expected, actual: actual === undefined ? null : actual,
    pass: JSON.stringify(expected) === JSON.stringify(actual), note: note || null,
  });
  add('ua === fp.userAgent', fp.userAgent, obs.ua);
  add('Intl timezone === fp.timezone', fp.timezone, obs.timezone);
  add('languages === fp.languages', fp.languages, obs.languages);
  add('platform === fp.platform', fp.platform, obs.platformNav);
  add('hardwareConcurrency === fp.hardwareConcurrency', fp.hardwareConcurrency, obs.hardwareConcurrency);
  add('deviceMemory === fp.deviceMemory', fp.deviceMemory, obs.deviceMemory);
  add('screen w/h === fp.screen', [fp.screen.width, fp.screen.height], [obs.screen.w, obs.screen.h]);
  add('availW/H === fp.screen', [fp.screen.availWidth, fp.screen.availHeight], [obs.screen.availW, obs.screen.availH]);
  add('devicePixelRatio === fp.screen.pixelRatio', fp.screen.pixelRatio, obs.screen.dpr);
  add('webgl renderer === fp.webgl.renderer', fp.webgl ? fp.webgl.renderer : null, obs.webgl ? (obs.webgl.unmaskedRenderer || obs.webgl.renderer) : null);
  add('outer>=inner（物理可能）', true, obs.outerGeInner);
  add('Notification.permission === default（fresh Chromium 真实值）', 'default', obs.notification.permission);
  add('webdriver === false', false, obs.webdriver);
  return checks;
}

(async () => {
  console.log('=== STEP 19 证据归因审计（3 模式 × 25 信号族） ===');
  console.log('数据目录: ' + TMP);

  // M1 product-headless
  {
    const P = buildProfile('p19_audit_h', 'step19-audit-headless', { headless: true });
    db.upsertProfile(P);
    const session = await browserManager.launch(P, null);
    const page = session.page;
    await page.goto('file:///' + probePath.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(800);
    const obs = await collectBattery(page);
    out.modes['product-headless'] = obs;
    out.contractChecks['product-headless'] = contractChecks(obs, session.fp);
    await browserManager.close(P.id);
  }
  // M2 product-hidden-headful
  {
    const P = buildProfile('p19_audit_hh', 'step19-audit-hh', { headless: false, launchBehavior: { hiddenWindow: true } });
    db.upsertProfile(P);
    const session = await browserManager.launch(P, null);
    const page = session.page;
    await page.goto('file:///' + probePath.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(800);
    const obs = await collectBattery(page);
    out.modes['product-hidden-headful'] = obs;
    out.contractChecks['product-hidden-headful'] = contractChecks(obs, session.fp);
    await browserManager.close(P.id);
  }
  // M3 control-headed（原生 Chrome 无注入）
  {
    const ctrlDir = path.join(TMP, 'control');
    const ctx = await chromium.launchPersistentContext(ctrlDir, {
      headless: false,
      executablePath: fs.existsSync(SYSTEM_CHROME) ? SYSTEM_CHROME : undefined,
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('file:///' + probePath.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(800);
    out.modes['control-headed'] = await collectBattery(page);
    out.contractChecks['control-headed'] = null; // 无 contract（原生）
    await ctx.close();
  }

  // 汇总输出
  for (const m of Object.keys(out.modes)) {
    console.log('\n──── ' + m + ' ────');
    const o = out.modes[m];
    console.log('  ua=' + String(o.ua).slice(0, 100));
    console.log('  webdriver=' + o.webdriver + '  headlessLike=' + o.uaHeadlessLike);
    console.log('  screen=' + JSON.stringify(o.screen));
    console.log('  window=' + JSON.stringify(o.window) + '  outerGeInner=' + o.outerGeInner);
    console.log('  notification=' + o.notification.permission + '  permQuery=' + o.permissionsNotification);
    console.log('  chrome=' + JSON.stringify(o.windowChrome));
    console.log('  plugins=' + o.plugins.length + ' (' + o.plugins.loc + ')  mimeTypes=' + o.mimeTypes.length + ' (' + o.mimeTypes.loc + ')');
    console.log('  webgl=' + JSON.stringify(o.webgl).slice(0, 200));
    console.log('  webgpu=' + JSON.stringify(o.webgpu).slice(0, 120));
    console.log('  mediaDevices=' + JSON.stringify(o.mediaDevices).slice(0, 160));
    console.log('  speechVoices=' + o.speechVoices + '  fonts=' + JSON.stringify(o.fonts));
    console.log('  uaData=' + JSON.stringify(o.userAgentData).slice(0, 220));
    console.log('  highEntropy=' + JSON.stringify(o.uaHighEntropy).slice(0, 260));
    console.log('  tz=' + o.timezone + '  lang=' + o.language + ' langs=' + o.languages.join(','));
    console.log('  connection=' + JSON.stringify(o.connection));
    console.log('  iframe=' + JSON.stringify(o.iframe).slice(0, 160));
    console.log('  headlessApiSurface=' + JSON.stringify(o.headlessApiSurface));
    const cc = out.contractChecks[m];
    if (cc) {
      const pass = cc.filter(function (x) { return x.pass; }).length;
      console.log('  CONTRACT: ' + pass + '/' + cc.length + ' PASS');
      for (const x of cc) if (!x.pass) console.log('    ✘ ' + x.name + '  expected=' + JSON.stringify(x.expected).slice(0, 60) + ' actual=' + JSON.stringify(x.actual).slice(0, 60));
    }
  }

  const outPath = path.join(__dirname, '..', '..', 'STEP19_HEADLESS_SIGNAL_AUDIT.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  const bmPath = path.join(__dirname, '..', '..', '.benchmark', 'step19_signal_audit_' + Date.now() + '.json');
  fs.mkdirSync(path.dirname(bmPath), { recursive: true });
  fs.writeFileSync(bmPath, JSON.stringify(out, null, 2), 'utf8');
  console.log('\n审计 JSON: ' + outPath);
  console.log('留档 JSON: ' + bmPath);
  await browserManager.closeAll().catch(function () {});
  process.exit(0);
})().catch(async function (e) {
  console.error('FATAL', e);
  await browserManager.closeAll().catch(function () {});
  process.exit(1);
});
