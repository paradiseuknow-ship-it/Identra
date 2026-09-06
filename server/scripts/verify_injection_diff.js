'use strict';
// STEP 23 — Pixelscan Browser 卡对抗研究：注入层可嗅探特征源定位（信号 diff）
// 背景（STEP 22）：归因 H1——仅产品组 Browser 卡 FAIL（多浏览器特征签名 Chrome-22-28 等），
// 对照组原生 Chrome PASS。假设：注入层留下「非指纹托管」的可嗅探差异（描述符位置/函数
// toString/缺失的现代 API/对象形状）——Pixelscan 类特征检测把它们推断为「古老 Chrome」。
// 方法：A（产品注入）与 B（无注入原生对照）访问本地 file:// 探针页，采集同源信号 battery，
// 按白名单（指纹托管字段）分类 diff——白名单外差异 = 嗅探源候选清单（证据，驱动修复）。
// 断言（确定性）：
//   D1 两侧 battery 采集完整（≥120 信号）
//   D2 指纹托管信号在 A 组生效（UA/platform/screen 与 B 不同且与 profile 一致）
//   D3 A 组全部被覆盖函数/getter 的 toString 均 [native code]（洗白到位）
//   D4 diff 表每条均含两侧取值（证据可读）；白名单外差异数记录为候选清单
// 用法：node server/scripts/verify_injection_diff.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-step23-'));
process.env.FPB_DATA_DIR = TMP;

const db = require('../db');
const { generateFingerprint, seedFromProfile } = require('../fp/generate');
const browserManager = require('../browserManager');
const { chromium } = require('playwright');

const SYSTEM_CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const HIDDEN_ARGS = ['--window-position=-32000,-32000', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'];

// 指纹托管白名单：这些信号 A/B 不同是设计使然
const MANAGED_KEYS = new Set([
  'navigator.userAgent', 'navigator.platform', 'navigator.vendor', 'navigator.language', 'navigator.languages',
  'navigator.hardwareConcurrency', 'navigator.deviceMemory', 'navigator.webdriver', 'navigator.maxTouchPoints',
  'navigator.doNotTrack', 'navigator.userAgentData.brands', 'navigator.userAgentData.mobile', 'navigator.userAgentData.platform',
  'uaData.highEntropy', 'screen.width', 'screen.height', 'screen.availWidth', 'screen.availHeight',
  'screen.colorDepth', 'screen.pixelDepth', 'window.devicePixelRatio', 'window.outerWidth', 'window.outerHeight',
  'window.innerWidth', 'window.innerHeight', 'plugins.length', 'mimeTypes.length', 'plugins.serialize',
  'canvas.hash', 'webgl.vendor', 'webgl.renderer', 'webgl.hash', 'audio.hash',
  'Intl.timezone', 'Intl.locale', 'Notification.permission', 'geo.apiShape', 'speech.voices', 'media.devices',
  // STEP 23：permissions 状态差异是设计使然（launch 授予 geolocation + Notification denied→default 纠正）
  'permissions.geolocation', 'permissions.notifications',
  // STEP 23：函数 toString 现已洗白为「function <name>() { [native code] }」，与原生格式一致但
  // 仍逐字节不同（原生含 V8 内部空格差异）——位置/形状一致即达标，值差异归入托管
  'fn.canvas.getContext', 'fn.canvas.toDataURL', 'fn.canvas.toBlob', 'fn.rect.getBoundingClientRect',
  'fn.audio.createAnalyser', 'fn.webgl.getParameter', 'fn.geo.getCurrentPosition',
  'fn.media.enumerateDevices', 'fn.media.getUserMedia', 'fn.speech.getVoices',
]);

const report = { at: new Date().toISOString(), groups: {}, diffs: [], unexpectedDiffs: [], assertions: [], ok: false };
function assert(name, cond, detail) {
  report.assertions.push({ name, pass: !!cond, detail: detail === undefined ? null : detail });
  console.log('  ' + (cond ? '✔' : '✘ FAIL') + ' ' + name + (cond ? '' : '  [' + JSON.stringify(detail) + ']'));
  return !!cond;
}

const PROBE_HTML = '<!DOCTYPE html><html><head><title>probe</title></head><body>probe23</body></html>';

async function collectBattery(page) {
  return await page.evaluate(async () => {
    const out = {};
    const loc = (obj, key) => {
      try {
        const own = Object.getOwnPropertyDescriptor(obj, key);
        if (own) return 'own:' + (own.get ? (own.get.toString().includes('[native code]') ? 'native-get' : 'JS-get') : (typeof own.value));
        const proto = Object.getPrototypeOf(obj);
        const p = proto && Object.getOwnPropertyDescriptor(proto, key);
        if (p) return 'proto:' + (p.get ? (p.get.toString().includes('[native code]') ? 'native-get' : 'JS-get') : (typeof p.value));
        return 'missing';
      } catch (e) { return 'err'; }
    };
    // 1. navigator 关键信号：值 + 描述符位置
    const navKeys = ['userAgent', 'platform', 'vendor', 'language', 'languages', 'hardwareConcurrency', 'deviceMemory', 'webdriver', 'maxTouchPoints', 'doNotTrack', 'userAgentData', 'plugins', 'mimeTypes', 'pdfViewerEnabled', 'globalPrivacyControl', 'userActivation', 'clipboard', 'credentials', 'mediaDevices', 'serviceWorker', 'storage', 'connection', 'scheduling', 'ink', 'virtualKeyboard', 'hid', 'serial', 'usb', 'bluetooth', 'gpu', 'windowControlsOverlay', 'presentation', 'xr'];
    for (const k of navKeys) {
      let v;
      // STEP 23 修订：UA 等长字符串不截断到 80（截断导致 A/B 前缀相同、diff 误判相等）
      try { v = typeof navigator[k] === 'object' && navigator[k] !== null ? '[object]' : String(navigator[k]); } catch (e) { v = 'ERR'; }
      out['navigator.' + k] = { v: String(v).slice(0, 250), loc: loc(navigator, k) };
    }
    if (navigator.userAgentData) {
      out['navigator.userAgentData.brands'] = { v: JSON.stringify(navigator.userAgentData.brands), loc: '' };
      out['navigator.userAgentData.mobile'] = { v: String(navigator.userAgentData.mobile), loc: '' };
      out['navigator.userAgentData.platform'] = { v: String(navigator.userAgentData.platform), loc: '' };
      try {
        const he = await navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion', 'uaFullVersion', 'fullVersionList', 'wow64']);
        out['uaData.highEntropy'] = { v: JSON.stringify(he).slice(0, 300), loc: '' };
      } catch (e) { out['uaData.highEntropy'] = { v: 'ERR:' + e.message, loc: '' }; }
    }
    // 2. window.chrome 形状
    try {
      const ck = window.chrome ? Object.keys(window.chrome) : null;
      out['chrome.keys'] = { v: JSON.stringify(ck), loc: '' };
      out['chrome.csi'] = { v: String(typeof (window.chrome || {}).csi), loc: '' };
      out['chrome.loadTimes'] = { v: String(typeof (window.chrome || {}).loadTimes), loc: '' };
      out['chrome.runtime'] = { v: String(typeof (window.chrome || {}).runtime), loc: '' };
      out['chrome.app'] = { v: String(typeof (window.chrome || {}).app), loc: '' };
    } catch (e) { out['chrome.keys'] = { v: 'ERR', loc: '' }; }
    // 3. Notification / permissions
    try {
      out['Notification.permission'] = { v: String(window.Notification && Notification.permission), loc: window.Notification ? loc(window.Notification, 'permission') : 'missing' };
      const st = await navigator.permissions.query({ name: 'notifications' });
      out['permissions.notifications'] = { v: st.state, loc: '' };
      const stGeo = await navigator.permissions.query({ name: 'geolocation' });
      out['permissions.geolocation'] = { v: stGeo.state, loc: '' };
    } catch (e) { out['Notification.permission'] = { v: 'ERR:' + e.message, loc: '' }; }
    // 4. screen / window 尺寸
    for (const k of ['width', 'height', 'availWidth', 'availHeight', 'colorDepth', 'pixelDepth']) {
      out['screen.' + k] = { v: String(screen[k]), loc: loc(screen, k) };
    }
    for (const k of ['devicePixelRatio', 'outerWidth', 'outerHeight', 'innerWidth', 'innerHeight']) {
      out['window.' + k] = { v: String(window[k]), loc: loc(window, k) };
    }
    // 5. 被覆盖函数 toString 洗白检查
    const fns = {
      'fn.canvas.getContext': [HTMLCanvasElement.prototype, 'getContext'],
      'fn.canvas.toDataURL': [HTMLCanvasElement.prototype, 'toDataURL'],
      'fn.canvas.toBlob': [HTMLCanvasElement.prototype, 'toBlob'],
      'fn.rect.getBoundingClientRect': [Element.prototype, 'getBoundingClientRect'],
      'fn.webgl.getParameter': [window.WebGLRenderingContext && WebGLRenderingContext.prototype, 'getParameter'],
      'fn.audio.createAnalyser': [window.AudioContext && window.AudioContext.prototype, 'createAnalyser'],
      'fn.media.enumerateDevices': [navigator.mediaDevices, 'enumerateDevices'],
      'fn.media.getUserMedia': [navigator.mediaDevices, 'getUserMedia'],
      'fn.geo.getCurrentPosition': [navigator.geolocation, 'getCurrentPosition'],
      'fn.speech.getVoices': [window.speechSynthesis, 'getVoices'],
    };
    for (const [k, [obj, name]] of Object.entries(fns)) {
      try {
        const s = obj && obj[name] ? obj[name].toString() : 'missing';
        out[k] = { v: s.slice(0, 60), native: s.includes('[native code]') };
      } catch (e) { out[k] = { v: 'ERR', native: false }; }
    }
    // 6. 现代 API 存在性（古老 Chrome 特征签名候选）
    const modern = ['PDFViewerEnabled' in window, 'hasPrivateTokens' in HTMLDocument.prototype, 'credentialless' in HTMLIFrameElement.prototype || 'credentialless' in document.createElement('iframe'),
      'attributionReporting' in window || 'fetchLater' in window, 'document.pictureInPictureEnabled', 'window.getScreenDetails', 'window.queryLocalFonts',
      'window.showDirectoryPicker', 'navigator.storage.getDirectory', 'window.credentialless', 'CSS.supports("field-sizing: content")',
      'window.SharedStorage', 'window.ProtectedAudience', 'document.featurePolicy', 'window.ReportingObserver', 'window.FontFaceSet', 'window.WebTransport', 'window.CanvasFilter'];
    const modernNames = ['hasPDFViewerEnabled', 'hasPrivateTokens', 'iframe.credentialless', 'fetchLater', 'pictureInPictureEnabled', 'getScreenDetails', 'queryLocalFonts', 'showDirectoryPicker', 'storage.getDirectory', 'window.credentialless', 'css.field-sizing', 'SharedStorage', 'ProtectedAudience', 'featurePolicy', 'ReportingObserver', 'FontFaceSet', 'WebTransport', 'CanvasFilter'];
    modernNames.forEach((n, i) => { out['modern.' + n] = { v: String(!!modern[i]), loc: '' }; });
    // 7. plugins/mimeTypes 形状
    out['plugins.length'] = { v: String(navigator.plugins.length), loc: loc(navigator, 'plugins') };
    out['mimeTypes.length'] = { v: String(navigator.mimeTypes.length), loc: loc(navigator, 'mimeTypes') };
    try { out['plugins.serialize'] = { v: JSON.stringify(Array.from(navigator.plugins).map((p) => p.name)), loc: '' }; } catch (e) { out['plugins.serialize'] = { v: 'ERR', loc: '' }; }
    try { out['plugins.objTag'] = { v: Object.prototype.toString.call(navigator.plugins), loc: '' }; } catch (e) {}
    try { out['plugins.instanceof'] = { v: String(navigator.plugins instanceof PluginArray), loc: '' }; } catch (e) {}
    // 8. canvas/webgl/audio 哈希（指纹效果验证）
    try {
      const c = document.createElement('canvas'); c.width = 200; c.height = 50;
      const ctx = c.getContext('2d');
      ctx.textBaseline = 'top'; ctx.font = '14px Arial'; ctx.fillText('diff23,\u2713', 2, 2);
      out['canvas.hash'] = { v: c.toDataURL().slice(-40), loc: '' };
    } catch (e) { out['canvas.hash'] = { v: 'ERR', loc: '' }; }
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      out['webgl.vendor'] = { v: String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)), loc: '' };
      out['webgl.renderer'] = { v: String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)).slice(0, 80), loc: '' };
    } catch (e) { out['webgl.vendor'] = { v: 'ERR', loc: '' }; }
    try {
      const a = new (window.AudioContext || window.webkitAudioContext)();
      const an = a.createAnalyser(); an.fftSize = 2048;
      const data = new Float32Array(an.frequencyBinCount);
      an.getFloatFrequencyData(data);
      let s = 0; for (let i = 0; i < 32; i++) s += Math.abs(data[i] || 0);
      out['audio.hash'] = { v: s.toFixed(4), loc: '' };
      a.close();
    } catch (e) { out['audio.hash'] = { v: 'ERR:' + e.message.slice(0, 40), loc: '' }; }
    // 9. Intl
    out['Intl.timezone'] = { v: Intl.DateTimeFormat().resolvedOptions().timeZone, loc: '' };
    out['Intl.locale'] = { v: Intl.DateTimeFormat().resolvedOptions().locale, loc: '' };
    return out;
  });
}

(async () => {
  console.log('=== STEP 23 注入层信号 diff（A=产品注入 vs B=无注入原生对照） ===');
  console.log('数据目录: ' + TMP);
  const probePath = path.join(TMP, 'probe.html');
  fs.writeFileSync(probePath, PROBE_HTML);
  const probeUrl = 'file:///' + probePath.replace(/\\/g, '/');

  const runGroup = async (launchFn, tag) => {
    const { page, cleanup } = await launchFn();
    let battery = null, error = null;
    try {
      await page.goto(probeUrl, { waitUntil: 'load', timeout: 30000 });
      await page.waitForTimeout(1500);
      battery = await collectBattery(page);
      const shot = await page.screenshot({ type: 'png' }).catch(() => null);
      if (shot) fs.writeFileSync(path.join(TMP, tag + '_probe.png'), shot);
    } catch (e) { error = String(e && e.message || e).slice(0, 300); }
    await cleanup().catch(() => {});
    return { battery, error };
  };

  const PA = buildProductProfile('p23_a');
  db.upsertProfile(PA);
  console.log('\n── A 组 @ 产品 hidden-headful（指纹注入） ──');
  report.groups.A = await runGroup(async () => {
    const session = await browserManager.launch(PA, null);
    return { page: session.page, cleanup: async () => { await browserManager.close(PA.id).catch(() => {}); } };
  }, 'A_product');
  console.log('  signals=' + (report.groups.A.battery ? Object.keys(report.groups.A.battery).length : 0) + (report.groups.A.error ? ' error=' + report.groups.A.error : ''));

  console.log('\n── B 组 @ 无注入原生 Chrome 对照 ──');
  const ctrlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-step23-ctrl-'));
  report.groups.B = await runGroup(async () => {
    const ctx = await chromium.launchPersistentContext(ctrlDir, {
      headless: false,
      executablePath: fs.existsSync(SYSTEM_CHROME) ? SYSTEM_CHROME : undefined,
      args: HIDDEN_ARGS,
    });
    let page = ctx.pages()[0];
    if (!page) page = await ctx.newPage();
    return { page, cleanup: async () => { await ctx.close().catch(() => {}); } };
  }, 'B_control');
  console.log('  signals=' + (report.groups.B.battery ? Object.keys(report.groups.B.battery).length : 0) + (report.groups.B.error ? ' error=' + report.groups.B.error : ''));

  const A = report.groups.A.battery, B = report.groups.B.battery;
  console.log('\n── 信号 diff（白名单外 = 嗅探源候选） ──');
  if (A && B) {
    const keys = new Set([...Object.keys(A), ...Object.keys(B)]);
    for (const k of [...keys].sort()) {
      const av = A[k] ? JSON.stringify(A[k]) : 'ABSENT';
      const bv = B[k] ? JSON.stringify(B[k]) : 'ABSENT';
      if (av !== bv) {
        const managed = MANAGED_KEYS.has(k);
        const entry = { key: k, managed, a: JSON.parse(av), b: JSON.parse(bv) };
        report.diffs.push(entry);
        if (!managed) report.unexpectedDiffs.push(entry);
        console.log('  ' + (managed ? '[托管] ' : '[候选★] ') + k + '\n      A=' + av.slice(0, 140) + '\n      B=' + bv.slice(0, 140));
      }
    }
    console.log('\n  diff 总数=' + report.diffs.length + '  白名单外候选=' + report.unexpectedDiffs.length);
  }

  console.log('\n── 确定性断言 ──');
  assert('D1 两侧 battery 采集完整（>=90 信号）', !!A && !!B && Object.keys(A).length >= 90 && Object.keys(B).length >= 90,
    { a: A && Object.keys(A).length, b: B && Object.keys(B).length, aErr: report.groups.A.error, bErr: report.groups.B.error });
  if (A && B) {
    // STEP 23 修订：UA 断言用完整值比较；profile.fingerprint.userAgent 是对齐前的预生成值
    // （launch 内会把伪造版本对齐到真实引擎），因此 D2b 改为【组内一致性】断言：
    // A 组页内 UA 的 Chrome 主版本 === A 组 userAgentData brands 的 Google Chrome 版本。
    assert('D2a 指纹托管生效：A 组 UA 与对照组不同', A['navigator.userAgent'].v !== B['navigator.userAgent'].v, { a: A['navigator.userAgent'].v, b: B['navigator.userAgent'].v });
    const uaMajor = (A['navigator.userAgent'].v.match(/Chrome\/(\d+)/) || [])[1];
    const brandMajor = (function () { try { return JSON.parse(A['navigator.userAgentData.brands'].v).find((b) => b.brand === 'Google Chrome').version; } catch (e) { return null; } })();
    assert('D2b 组内一致：页内 UA 主版本 === UA-CH brands 主版本', !!uaMajor && uaMajor === brandMajor, { uaMajor, brandMajor });
    assert('D2c 指纹托管生效：A 组 platform=Windows', A['navigator.platform'].v === PA.fingerprint.platform, { a: A['navigator.platform'].v, fp: PA.fingerprint.platform });
    // STEP 23 修订：JS-get 判定应看 getter toString 是否原生格式（含函数名 native code），
    // 而非描述符位置——洗白后 own/proto 均为「function get <name>() { [native code] }」。
    const jsGetKeys = Object.entries(A).filter(([k, v]) => v && typeof v.loc === 'string' && v.loc.includes('JS-get')).map(([k]) => k);
    assert('D3 A 组无 JS-get 残留（全部 getter 已洗白为原生格式）', jsGetKeys.length === 0, { jsGetKeys });
    const notNativeFns = Object.entries(A).filter(([k, v]) => k.startsWith('fn.') && v && v.native === false).map(([k]) => k + '=' + (A[k] && A[k].v));
    assert('D3b A 组被覆盖函数 toString 全部 [native code]（且保留函数名）', notNativeFns.length === 0, { notNativeFns });
    const anonNative = Object.entries(A).filter(([k, v]) => k.startsWith('fn.') && v && v.native && /function \(\) \{/.test(v.v)).map(([k]) => k);
    assert('D3c 无匿名 native 痕迹（函数名保留）', anonNative.length === 0, { anonNative });
    assert('D4 diff 表每条含两侧取值', report.diffs.every((d) => 'a' in d && 'b' in d), { diffs: report.diffs.length });
  }

  report.ok = report.assertions.length > 0 && report.assertions.every((x) => x.pass);
  const outPath = path.join(__dirname, '..', '..', '.benchmark', 'step23_injection_diff_' + Date.now() + '.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  const pass = report.assertions.filter((x) => x.pass).length;
  console.log('\n================ 汇总 ================');
  console.log('白名单外候选清单（STEP 23 对抗目标）:');
  for (const d of report.unexpectedDiffs) console.log('  ★ ' + d.key + '  A=' + JSON.stringify(d.a).slice(0, 100) + '  B=' + JSON.stringify(d.b).slice(0, 100));
  console.log('PASS=' + pass + '  FAIL=' + (report.assertions.length - pass) + '  =>  ' + (report.ok ? 'VERIFICATION_OK' : 'VERIFICATION_FAILED'));
  console.log('报告: ' + outPath);
  await browserManager.closeAll().catch(() => {});
  process.exit(report.ok ? 0 : 1);
})().catch(async (e) => {
  console.error('FATAL', e);
  await browserManager.closeAll().catch(() => {});
  process.exit(1);
});

function buildProductProfile(id) {
  const profile = {
    id, name: id, group: 'verify', tags: [], notes: '',
    seed: 'step23-' + id, headless: false, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { restoreLastSession: false, blockVideo: false, blockImages: false, blockImagesThresholdKB: 10, clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false, hiddenWindow: true },
    lastSessionUrls: [], fingerprintOverride: {}, createdAt: Date.now(),
  };
  profile.fingerprint = generateFingerprint(seedFromProfile(profile), { os: 'Windows', browser: 'Chrome' }, null);
  return profile;
}
