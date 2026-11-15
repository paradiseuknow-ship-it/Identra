'use strict';
// C203 守护：browserscan 「Canvas Tampering / WebGL exception」的产品侧真缺陷。
//
// 受控对照（native = 真 Chrome 无注入；injected = 产品注入脚本）实证的旧缺陷：
//   Canvas ① getContextAttributes().willReadFrequently 被强制 true（真 Chrome false）
//          ② 写纯红 (255,0,0,255) 后 getImageData 读出 (253,0,0,255)
//          ③ 纯色 PNG 从 262B 膨胀到 3254B、toDataURL hash 偏离真实值
//          ④ getImageData.toString() = "function () { [native code] }"（匿名）
//          ⑤ 三个被 hook 函数带 own toString（真 Chrome 恒 false）
//          ⑥ 原型上可见 __fpGID 标记
//   WebGL  ⑦ getParameter(7936/7937) 返回人设 GPU 串，真 Chrome 恒 "WebKit"/"WebKit WebGL"
//          ⑧ getParameter 带 own toString
//
// 契约：低熵（纯色/少量颜色）画布与真 Chrome **逐项完全一致**；高熵画布的
// toDataURL/toBlob 仍施加确定性噪声（伪装收益不归零），而 getImageData 保持原生，
// 因此「写像素→读像素」与「读像素→再导出」两条路径都与真 Chrome 自洽。
// WebGL 只改写两个 unmasked 常量，VENDOR/RENDERER 保持原生。

const path = require('path');
const http = require('http');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { buildInjectionScript } = require('../fp/inject');
const { generateFingerprint } = require('../fp/generate');
const { listenSafe } = require('./lib_safe_port');

const CHROME = process.env.FP_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PUBLIC_IP = '203.0.113.99';
const HTML = '<!doctype html><html><head><meta charset="utf-8"></head><body>c203</body></html>';

let pass = 0; let fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? ' :: ' + extra : '')); }
}

const PROBE = `(() => {
  const out = { err: null };
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(16); };
  try {
    // ---------- 低熵（纯色）画布 ----------
    const solid = document.createElement('canvas'); solid.width = 64; solid.height = 32;
    const sc = solid.getContext('2d');
    out.ctxAttrs = sc.getContextAttributes() ? JSON.parse(JSON.stringify(sc.getContextAttributes())) : null;
    sc.fillStyle = '#ff0000'; sc.fillRect(0, 0, 64, 32);
    out.solidPixel = Array.from(sc.getImageData(0, 0, 1, 1).data);
    out.solidHash = hash(solid.toDataURL());
    out.solidHash2 = hash(solid.toDataURL());
    out.solidLen = solid.toDataURL().length;

    // ---------- 高熵（渐变 + 文本）画布：伪装必须仍然生效 ----------
    const hi = document.createElement('canvas'); hi.width = 200; hi.height = 60;
    const hc = hi.getContext('2d');
    const g = hc.createLinearGradient(0, 0, 200, 60);
    g.addColorStop(0, '#ff0000'); g.addColorStop(0.5, '#00ff00'); g.addColorStop(1, '#0000ff');
    hc.fillStyle = g; hc.fillRect(0, 0, 200, 60);
    hc.font = '18px sans-serif'; hc.fillStyle = '#ffffff'; hc.fillText('C203 high entropy 123', 8, 34);
    const hd = hc.getImageData(0, 0, 200, 60).data;
    const colors = new Set();
    for (let i = 0; i < hd.length; i += 4) colors.add((hd[i] << 16) | (hd[i + 1] << 8) | hd[i + 2]);
    out.highColors = colors.size;
    out.highGidSample = Array.from(hd.slice(0, 16));
    out.highHash = hash(hi.toDataURL());
    out.highHash2 = hash(hi.toDataURL());
    // 同源一致性：把 getImageData 结果铺到临时画布再导出，应等于 toDataURL
    const t = document.createElement('canvas'); t.width = 200; t.height = 60;
    t.getContext('2d').putImageData(hc.getImageData(0, 0, 200, 60), 0, 0);
    out.highFromGidHash = hash(t.toDataURL());

    // ---------- toString / own toString / 原型标记 ----------
    const P = HTMLCanvasElement.prototype, C = CanvasRenderingContext2D.prototype;
    out.toDataURL_toString = P.toDataURL.toString();
    out.getContext_toString = P.getContext.toString();
    out.getImageData_toString = C.getImageData.toString();
    out.ownToString = [
      Object.prototype.hasOwnProperty.call(P.toDataURL, 'toString'),
      Object.prototype.hasOwnProperty.call(P.getContext, 'toString'),
      Object.prototype.hasOwnProperty.call(C.getImageData, 'toString'),
    ];
    out.gidMarker = Object.prototype.hasOwnProperty.call(C, '__fpGID');
    out.normalFnToString = (function sampleFn(a, b) { return a + b; }).toString();
    out.nativeFnToString = Array.prototype.push.toString();
    out.fpToString = Function.prototype.toString.toString();
    out.fpToStringName = Function.prototype.toString.name;

    // C209：被 hook 函数的 name 必须与真 Chrome 逐字相同（旧实现匿名 ⇒ ''）
    out.hookNames = {
      toDataURL: P.toDataURL.name,
      toBlob: P.toBlob ? P.toBlob.name : '(missing)',
      getParameter: window.WebGLRenderingContext ? WebGLRenderingContext.prototype.getParameter.name : '(missing)',
      getExtension: window.WebGLRenderingContext ? WebGLRenderingContext.prototype.getExtension.name : '(missing)',
      getBoundingClientRect: Element.prototype.getBoundingClientRect.name,
    };

    // ---------- WebGL ----------
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) { out.gl = null; }
    else {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const K = ext ? { UV: ext.UNMASKED_VENDOR_WEBGL, UR: ext.UNMASKED_RENDERER_WEBGL } : { UV: 37445, UR: 37446 };
      const get = (p) => { try { return gl.getParameter(p); } catch (e) { return 'ERR:' + e.message; } };
      out.gl = {
        vendor: get(7936), renderer: get(7937),
        unmaskedVendor: get(K.UV), unmaskedRenderer: get(K.UR),
        version: get(7938),
        getParameter_toString: WebGLRenderingContext.prototype.getParameter.toString(),
        getParameter_ownToString: Object.prototype.hasOwnProperty.call(WebGLRenderingContext.prototype.getParameter, 'toString'),
        getExtension_toString: WebGLRenderingContext.prototype.getExtension.toString(),
      };
    }
  } catch (e) { out.err = String((e && e.stack) || e); }
  return out;
})()`;

async function startServer() {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(HTML);
  });
  const bound = await listenSafe(srv, '127.0.0.1');
  return { srv, port: bound.address().port };
}

(async () => {
  console.log('=== C203 Canvas / WebGL 与真 Chrome 一致性守护 ===');
  const src = fs.readFileSync(path.join(__dirname, '../fp/inject.js'), 'utf8');
  const fp = generateFingerprint('c203-guard-seed', {
    os: 'Windows', browser: 'Chrome', webRtc: 'proxy', webRtcPublicIp: PUBLIC_IP,
  });
  ok('前置：fp 含 webgl 人设且 canvas 开启', !!fp.webgl && !!fp.webgl.vendor && fp.canvas !== false,
    JSON.stringify(fp.webgl) + ' canvas=' + fp.canvas);

  const injected = buildInjectionScript(fp);
  let compileErr = '';
  try { new Function(injected); } catch (e) { compileErr = String(e.message); }
  ok('S1 生成注入脚本可编译', compileErr === '', compileErr);

  // ---------- S2：源码形态（防回退，判据建在内容形状上） ----------
  console.log('-- S 源码形态 --');
  ok('S2 WebGL 只改写 37445/37446，7936/7937 保持原生',
    /if \(p === 37445\) return FP\.webgl\.vendor;/.test(src) &&
    /if \(p === 37446\) return FP\.webgl\.renderer;/.test(src) &&
    !/p === 7936/.test(src) && !/p === 7937/.test(src) && !/p === 0x9245/.test(src));
  ok('S3 不再强制 willReadFrequently / 不再留 __fpGID 原型标记',
    !/Object\.assign\(\{\}, attrs, \{ willReadFrequently: true \}\)/.test(src) && !/__fpGID/.test(src));
  ok('S4 toString 洗白改为 Function.prototype shim + WeakMap（无 own 属性）',
    /new WeakMap\(\)/.test(src) && /Object\.defineProperty\(Function\.prototype, 'toString'/.test(src) &&
    !/Object\.defineProperty\(obj, 'toString'/.test(src));
  ok('S5 低熵判定 + 单一 noiseCopy 实现（导出路径复用）',
    /const isLowEntropy = \(src\) =>/.test(src) && /const noiseCopy = \(img\) =>/.test(src) &&
    /return noiseCopy\(img\);/.test(src) && /const exportPixels = \(cv\) =>/.test(src));
  ok('S6 getImageData 保持原生（不再包裹、不再 whiten，少一个可嗅探面）',
    !/CanvasRenderingContext2D\.prototype\.getImageData = function/.test(src) &&
    !/whiten\(CanvasRenderingContext2D\.prototype\.getImageData/.test(src));
  // C209：匿名函数表达式包裹会让 fn.name === ''，真 Chrome 原生方法恒具名。
  // 形态判据锁定五个已实证偏差的 hook，同时禁止重新引入任何匿名包裹赋值。
  ok('S7 五个原型 hook 均为具名函数表达式（无 = function( 匿名赋值）',
    /= function toDataURL\(/.test(src) && /= function toBlob\(/.test(src) &&
    /= function getParameter\(/.test(src) && /= function getExtension\(/.test(src) &&
    /= function getBoundingClientRect\(/.test(src) &&
    !/= function\s*\(/.test(src));

  const { srv, port } = await startServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--force-webrtc-ip-handling-policy=default_public_interface_only'] });
  const r = {}; const errs = {};
  try {
    for (const mode of ['native', 'injected']) {
      const ctx = await browser.newContext();
      if (mode === 'injected') await ctx.addInitScript(injected);
      const page = await ctx.newPage();
      errs[mode] = [];
      page.on('pageerror', (e) => errs[mode].push(String(e.message)));
      await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load', timeout: 15000 });
      r[mode] = await page.evaluate(PROBE);
      await ctx.close();
    }
  } finally { await browser.close(); srv.close(); }

  const a = r.native, b = r.injected;
  ok('X0 两种上下文探针均无异常', !a.err && !b.err && errs.native.length === 0 && errs.injected.length === 0,
    'native=' + a.err + ' injected=' + b.err + ' pageErrors=' + JSON.stringify(errs));

  // ---------- A：低熵画布与真 Chrome 完全一致 ----------
  console.log('-- A 低熵（纯色）Canvas parity --');
  ok('A1 getContextAttributes 完全一致（willReadFrequently 不再被强制）',
    JSON.stringify(a.ctxAttrs) === JSON.stringify(b.ctxAttrs) && b.ctxAttrs.willReadFrequently === false,
    JSON.stringify(a.ctxAttrs) + ' vs ' + JSON.stringify(b.ctxAttrs));
  ok('A2 写纯红后 getImageData 读出 (255,0,0,255)（写读自洽）',
    JSON.stringify(b.solidPixel) === JSON.stringify([255, 0, 0, 255]) && JSON.stringify(a.solidPixel) === JSON.stringify(b.solidPixel),
    JSON.stringify(b.solidPixel));
  ok('A3 纯色 toDataURL hash 与真 Chrome 相同',
    a.solidHash === b.solidHash && !!b.solidHash, a.solidHash + ' vs ' + b.solidHash);
  ok('A4 纯色 PNG 长度与真 Chrome 相同（不再膨胀 12 倍）',
    a.solidLen === b.solidLen && b.solidLen < 500, a.solidLen + ' vs ' + b.solidLen);
  ok('A5 纯色导出幂等（两次同值）', b.solidHash === b.solidHash2);

  // ---------- B：高熵画布仍被伪装（收益未归零，非 vacuous） ----------
  console.log('-- B 高熵 Canvas 仍伪装 --');
  ok('B0 高熵夹具确实高熵（颜色数 > 8，断言非 vacuous）',
    a.highColors > 8 && b.highColors > 8, 'native=' + a.highColors + ' injected=' + b.highColors);
  ok('B1 高熵 toDataURL 与真 Chrome 不同（噪声仍生效）',
    a.highHash !== b.highHash, a.highHash + ' vs ' + b.highHash);
  ok('B2 高熵 getImageData 与 toDataURL 同源一致（单一实现）',
    b.highHash === b.highFromGidHash, b.highHash + ' vs ' + b.highFromGidHash);
  ok('B3 高熵导出幂等（无二次叠加）', b.highHash === b.highHash2);
  ok('B4 高熵 getImageData 与真 Chrome 相同（写读自洽扩展到高熵）',
    JSON.stringify(a.highGidSample) === JSON.stringify(b.highGidSample),
    JSON.stringify(a.highGidSample) + ' vs ' + JSON.stringify(b.highGidSample));

  // ---------- C：toString 洗白零痕迹 ----------
  console.log('-- C 函数 toString 零痕迹 --');
  ok('C1 三个 hook 函数均无 own toString（与真 Chrome 一致）',
    b.ownToString.every((v) => v === false) && a.ownToString.every((v) => v === false),
    JSON.stringify(b.ownToString));
  ok('C2 getImageData.toString() 具名且为原生格式',
    b.getImageData_toString === 'function getImageData() { [native code] }' &&
    a.getImageData_toString === b.getImageData_toString, b.getImageData_toString);
  ok('C3 toDataURL / getContext toString 与真 Chrome 一致',
    a.toDataURL_toString === b.toDataURL_toString && a.getContext_toString === b.getContext_toString);
  ok('C4 原型无 __fpGID 标记', b.gidMarker === false);
  ok('C5 shim 不扰动普通函数 / 原生函数的 toString',
    a.normalFnToString === b.normalFnToString && a.nativeFnToString === b.nativeFnToString &&
    /\[native code\]/.test(b.nativeFnToString));
  ok('C6 Function.prototype.toString 自身自洽',
    b.fpToString === 'function toString() { [native code] }' && b.fpToStringName === 'toString',
    b.fpToString + ' name=' + b.fpToStringName);

  // ---------- D：WebGL ----------
  console.log('-- D WebGL --');
  ok('D0 两个上下文都拿到 WebGL（断言非 vacuous）', !!a.gl && !!b.gl);
  ok('D1 VENDOR/RENDERER 保持真 Chrome 原生值',
    b.gl.vendor === a.gl.vendor && b.gl.renderer === a.gl.renderer &&
    b.gl.vendor === 'WebKit' && b.gl.renderer === 'WebKit WebGL',
    JSON.stringify([b.gl.vendor, b.gl.renderer]));
  ok('D2 仅 UNMASKED_* 为人设 GPU（伪装收益保留，与 fp 一致）',
    b.gl.unmaskedVendor === fp.webgl.vendor && b.gl.unmaskedRenderer === fp.webgl.renderer &&
    b.gl.unmaskedVendor !== a.gl.unmaskedVendor,
    b.gl.unmaskedVendor + ' / ' + b.gl.unmaskedRenderer);
  ok('D3 VERSION 等其余参数保持原生', a.gl.version === b.gl.version);
  ok('D4 getParameter / getExtension toString 与真 Chrome 一致、无 own toString',
    a.gl.getParameter_toString === b.gl.getParameter_toString &&
    a.gl.getExtension_toString === b.gl.getExtension_toString &&
    b.gl.getParameter_ownToString === false);

  // ---------- E：C209 函数 name 契约（真浏览器值级） ----------
  console.log('-- E 函数 name 契约（C209 具名化）--');
  ok('E1 五个原型 hook 的 name 与真 Chrome 逐字相同',
    JSON.stringify(a.hookNames) === JSON.stringify(b.hookNames),
    'native=' + JSON.stringify(a.hookNames) + ' injected=' + JSON.stringify(b.hookNames));
  ok('E2 五个 hook 的 name 均非空（旧实现恒为空串）',
    Object.keys(b.hookNames).every((k) => typeof b.hookNames[k] === 'string' && b.hookNames[k].length > 0),
    JSON.stringify(b.hookNames));
  ok('E3 具名化不扰动 toString shim（仍为带函数名的原生格式）',
    b.toDataURL_toString === 'function toDataURL() { [native code] }' &&
    a.toDataURL_toString === b.toDataURL_toString,
    a.toDataURL_toString + ' vs ' + b.toDataURL_toString);

  console.log('\n== C203 守护结果: ' + pass + ' 通过 / ' + fail + ' 失败 ==');
  if (fail > 0) { console.log('FAILS:\n' + fails.join('\n')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('GUARD CRASH:', e); process.exit(2); });
