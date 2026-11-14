'use strict';
// C205 守护：跨 realm Function.prototype.toString 不得泄漏 JS 注入层 hook 源码。
//
// C204 在真实站点实证：browserscan「Canvas Tampering」只需一行
//   iframe.contentWindow.Function.prototype.toString.call(
//     HTMLCanvasElement.prototype.toDataURL)
// 就能读到 JS wrapper 全源码。C204 曾把它判为「JS 注入层原理上限」。
// C205 受控对照推翻该结论：addInitScript 会在每个 frame 都装 shim，真正原因是
// C203 的 HOOKED_FN 为 per-realm WeakMap，子 realm 查不到主 realm 的标记。
//
// 修复契约：登记表放到同源 realm 共享位置（window.top 上不可枚举 symbol），
// 每个 realm 的 shim 同时查本 realm 表与共享表；被 hook 的函数对象上依旧
// 零 own 属性。守护同时做双向咬：把共享表退化回 per-realm，跨 realm 必须
// 重新泄漏，证明本组断言不是真空绿。
//
// C207 扩展（同一「注入层 ↔ 原生」对照夹具，非新增测试文件）：注入层不得再
// 替换 Intl 原生时区解析方法。旧实现无条件改写 resolvedOptions 返回值，导致
// 调用方显式 timeZone 被静默改成人设时区，而同一 formatter 的 format() 仍是
// 原生正确值 ⇒ 页内自相矛盾。S10 锁源码形态，E0–E4 以值级判据锁显式时区、
// 默认时区与格式化输出三方与无注入对照组逐字一致；文件级 revert 咬下 S10/E1/E2 必红。

const os = require('os');
const path = require('path');
if (!process.env.FPB_DATA_DIR) {
  process.env.FPB_DATA_DIR = path.join(os.tmpdir(), 'fpb-c205-guard');
}
const http = require('http');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { buildInjectionScript } = require('../fp/inject');
const { generateFingerprint } = require('../fp/generate');
const { listenSafe } = require('./lib_safe_port');

const CHROME = process.env.FP_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const HTML = '<!doctype html><html><head><meta charset="utf-8"></head><body>c205</body></html>';
const NATIVE_TO_DATA_URL = 'function toDataURL() { [native code] }';
const NATIVE_GET_PARAMETER = 'function getParameter() { [native code] }';
const NATIVE_NAV_GETTER = 'function get userAgent() { [native code] }';
const NATIVE_TO_STRING = 'function toString() { [native code] }';

let pass = 0; let fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; fails.push(name); console.log('FAIL  ' + name + (extra ? ' :: ' + extra : '')); }
}

const PROBE = `(() => {
  const out = { err: null };
  try {
    const f = document.createElement('iframe');
    f.style.display = 'none';
    document.body.appendChild(f);
    const W = f.contentWindow;
    const childToString = W.Function.prototype.toString;
    const P = HTMLCanvasElement.prototype;
    const GP = WebGLRenderingContext.prototype.getParameter;

    // ① 检测站判据：用子 realm 的 toString 查主 realm 的 4 类 hook
    out.cross = {
      toDataURL: childToString.call(P.toDataURL),
      getContext: childToString.call(P.getContext),
      getParameter: childToString.call(GP),
      navGetter: (() => {
        try {
          const d = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent');
          return d && d.get ? childToString.call(d.get) : '(no getter)';
        } catch (e) { return 'ERR:' + e.message; }
      })(),
      mainShim: childToString.call(Function.prototype.toString),
    };
    // ② 反向分支：主 realm 的 shim 查子 realm 的 shim
    out.reverse = Function.prototype.toString.call(W.Function.prototype.toString);

    // ③ 本 realm 洗白（C203 成果，不得回退）
    out.local = {
      toDataURL: P.toDataURL.toString(),
      getParameter: GP.toString(),
      fpToString: Function.prototype.toString.toString(),
      normalFn: (function sampleFn(a, b) { return a + b; }).toString(),
      nativeFn: Array.prototype.push.toString(),
    };
    out.ownToString = Object.prototype.hasOwnProperty.call(P.toDataURL, 'toString');
    out.getContext_ownToString = Object.prototype.hasOwnProperty.call(P.getContext, 'toString');

    // ④ 非 vacuous：hook 必须真的装了（否则「全 native 格式」只是没注入）
    out.hookEvidence = {
      ua: navigator.userAgent,
      unmaskedVendor: (() => {
        try {
          const gl = document.createElement('canvas').getContext('webgl');
          if (!gl) return '(no webgl)';
          const e = gl.getExtension('WEBGL_debug_renderer_info');
          return gl.getParameter(e ? e.UNMASKED_VENDOR_WEBGL : 37445);
        } catch (e) { return 'ERR:' + e.message; }
      })(),
    };

    // ⑤ 共享前提与新增痕迹的显式登记
    const K = Symbol.for('__fpb_hook_registry_v1__');
    const d = Object.getOwnPropertyDescriptor(window.top, K);
    out.shared = {
      symbolShared: (Symbol.for('__c205_guard__') === W.Symbol.for('__c205_guard__')),
      topReadableFromChild: (() => {
        try {
          const g = Symbol.for('__c205_guard_top__');
          Object.defineProperty(window.top, g, { value: 'YES', configurable: true });
          return W.Function('var k = Symbol.for("__c205_guard_top__"); return window.top[k];')();
        } catch (e) { return 'ERR:' + e.message; }
      })(),
      registryPresent: !!d,
      registryEnumerable: d ? d.enumerable : null,
      extraOwnNames: Object.getOwnPropertyNames(window.top).filter((k) => /fpb_hook|c205_guard/i.test(k)),
    };
    // ⑥ C207：Intl 显式时区语义（值级判据，不依赖标识符）
    out.tz = (() => {
      const stamp = Date.UTC(2026, 5, 15, 12, 0, 0);
      const dt = new Date(stamp);
      const zones = ['Asia/Tokyo', 'Europe/Berlin', 'America/New_York', 'UTC', 'Australia/Sydney'];
      return {
        defaultZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
        cases: zones.map((z) => {
          const f2 = new Intl.DateTimeFormat('en-US', {
            timeZone: z, hour: '2-digit', minute: '2-digit', hour12: false,
          });
          return { requested: z, resolved: f2.resolvedOptions().timeZone, formatted: f2.format(dt) };
        }),
      };
    })();
    f.remove();
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
  console.log('=== C205 跨 realm toString 与真 Chrome 一致性守护 ===');
  const src = fs.readFileSync(path.join(__dirname, '../fp/inject.js'), 'utf8');
  const fp = generateFingerprint('c205-guard-seed', {
    os: 'Windows', browser: 'Chrome', webRtc: 'proxy', webRtcPublicIp: '203.0.113.99',
  });
  // 强制与宿主不同的可观测人设，作为「hook 确实安装」的非 vacuous 证据
  fp.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 C205GUARD';
  fp.webgl = Object.assign({}, fp.webgl, { vendor: 'C205 Guard Vendor', renderer: 'C205 Guard Renderer' });
  ok('前置：fp 含可区分人设', /C205GUARD/.test(fp.userAgent) && fp.webgl.vendor === 'C205 Guard Vendor');

  const injected = buildInjectionScript(fp);
  let compileErr = '';
  try { new Function(injected); } catch (e) { compileErr = String(e.message); }
  ok('S1 生成注入脚本可编译（C202 CRLF 防线）', compileErr === '', compileErr);

  // ---------- S：源码形态（防回退，判据建在内容形状） ----------
  console.log('-- S 源码形态 --');
  ok('S2 共享登记表存在：Symbol.for + ensure + shared + 双写',
    /Symbol\.for\('__fpb_hook_registry_v1__'\)/.test(src) &&
    /function ensureSharedHookTable\(\)/.test(src) &&
    /function sharedHookTable\(\)/.test(src) &&
    /if \(shared && shared !== HOOKED_FN\) shared\.set\(fn, name\);/.test(src));
  ok('S3 shim 委托 hookName，不再内联 per-realm 查表',
    /function hookName\(fn\)/.test(src) && /const name = hookName\(this\);/.test(src) &&
    !/if \(HOOKED_FN\.has\(this\)\)/.test(src));
  ok('S4 用鸭子判定共享表（跨 realm instanceof 恒 false 的陷阱）',
    /const isHookTable = \(v\) =>/.test(src) &&
    /typeof v\.has === 'function'/.test(src) && !/instanceof WeakMap/.test(src));
  ok('S5 C203 成果未回退：Function.prototype shim + 函数对象零 own toString',
    /Object\.defineProperty\(Function\.prototype, 'toString'/.test(src) &&
    !/Object\.defineProperty\(obj, 'toString'/.test(src));
  ok('S6 空名字登记不被吞（hookName 用 !== null，不用 truthy）',
    /if \(name !== null\)/.test(src) && /if \(shared && shared\.has\(fn\)\) return shared\.get\(fn\);/.test(src));
  ok('S7 共享表在 window.top 上不可枚举',
    /Object\.defineProperty\(window\.top, HOOK_REGISTRY_KEY, \{/.test(src) &&
    /value: HOOKED_FN, writable: false, enumerable: false, configurable: true/.test(src));

  // ---------- 双向咬：把共享表退化回 per-realm（C203 行为） ----------
  const REVERT_ANCHOR = 'if (SHARED_HOOKED_FN) return SHARED_HOOKED_FN;';
  const anchorCount = injected.split(REVERT_ANCHOR).length - 1;
  ok('S8 咬测锚点唯一且可替换', anchorCount === 1, 'count=' + anchorCount);
  const reverted = injected.replace(REVERT_ANCHOR, 'return null;');
  ok('S9 咬测脚本确实退化且仍可编译',
    reverted !== injected && (() => { try { new Function(reverted); return true; } catch (e) { return false; } })());
  // C207：注入层不得再替换原生 Intl 解析方法，也不得无条件覆写返回值里的时区字段。
  // 判据建在内容形状（赋值形态 + 覆写形态），revert 咬下两条同时不成立 ⇒ 必红。
  ok('S10 C207 注入层不替换原生 Intl 解析方法 / 不覆写时区返回值',
    !/Intl\.DateTimeFormat\.prototype\.resolvedOptions\s*=/.test(src) &&
    !/opts\.timeZone\s*=\s*TZ/.test(src));

  const { srv, port } = await startServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--disable-gpu'] });
  const r = {}; const errs = {};
  try {
    for (const mode of ['native', 'injected', 'reverted']) {
      const ctx = await browser.newContext();
      if (mode === 'injected') await ctx.addInitScript(injected);
      if (mode === 'reverted') await ctx.addInitScript(reverted);
      const page = await ctx.newPage();
      errs[mode] = [];
      page.on('pageerror', (e) => errs[mode].push(String(e.message)));
      await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load', timeout: 15000 });
      r[mode] = await page.evaluate(PROBE);
      await ctx.close();
    }
  } finally { await browser.close(); srv.close(); }

  const a = r.native, b = r.injected, c = r.reverted;
  ok('X0 三组探针均无异常 / 无 pageerror',
    !a.err && !b.err && !c.err &&
    errs.native.length === 0 && errs.injected.length === 0 && errs.reverted.length === 0,
    'native=' + a.err + ' injected=' + b.err + ' reverted=' + c.err + ' pageErrors=' + JSON.stringify(errs));

  // ---------- X：共享前提与非 vacuous ----------
  console.log('-- X 共享前提与非 vacuous --');
  ok('X1 Symbol.for 跨 realm 同值、window.top 从子 realm 可读',
    b.shared.symbolShared === true && b.shared.topReadableFromChild === 'YES',
    JSON.stringify(b.shared));
  ok('X2 hook 确实安装（UA 与 UNMASKED_VENDOR 均等于人设且≠原生）',
    b.hookEvidence.ua === fp.userAgent && a.hookEvidence.ua !== b.hookEvidence.ua &&
    b.hookEvidence.unmaskedVendor === fp.webgl.vendor &&
    a.hookEvidence.unmaskedVendor !== b.hookEvidence.unmaskedVendor,
    JSON.stringify([a.hookEvidence, b.hookEvidence]));
  ok('X3 咬测组 hook 同样安装（退化只影响共享表，不是把脚本弄坏）',
    c.hookEvidence.ua === fp.userAgent && c.hookEvidence.unmaskedVendor === fp.webgl.vendor,
    JSON.stringify(c.hookEvidence));

  // ---------- A：跨 realm 与真 Chrome 逐字节一致 ----------
  console.log('-- A 跨 realm 零泄漏 --');
  ok('A1 canvas toDataURL 跨 realm = 真 Chrome 原生格式',
    b.cross.toDataURL === a.cross.toDataURL && b.cross.toDataURL === NATIVE_TO_DATA_URL,
    b.cross.toDataURL);
  ok('A2 WebGL getParameter 跨 realm = 真 Chrome 原生格式',
    b.cross.getParameter === a.cross.getParameter && b.cross.getParameter === NATIVE_GET_PARAMETER,
    b.cross.getParameter);
  ok('A3 navigator.userAgent getter 跨 realm = 真 Chrome 原生格式',
    b.cross.navGetter === a.cross.navGetter && b.cross.navGetter === NATIVE_NAV_GETTER,
    b.cross.navGetter);
  ok('A4 主 realm shim 自身跨 realm = 真 Chrome 原生格式',
    b.cross.mainShim === a.cross.mainShim && b.cross.mainShim === NATIVE_TO_STRING,
    b.cross.mainShim);
  ok('A5 getContext（未被 hook）跨 realm 亦一致',
    b.cross.getContext === a.cross.getContext && /\[native code\]/.test(b.cross.getContext));
  ok('A6 反向分支：主 realm shim 查子 realm shim 不泄漏',
    b.reverse === a.reverse && b.reverse === NATIVE_TO_STRING, b.reverse);

  // ---------- B：C203 成果零回退 ----------
  console.log('-- B 本 realm 洗白零回退 --');
  ok('B1 本 realm toDataURL / getParameter 仍为原生格式',
    b.local.toDataURL === a.local.toDataURL && b.local.getParameter === a.local.getParameter &&
    b.local.toDataURL === NATIVE_TO_DATA_URL && b.local.getParameter === NATIVE_GET_PARAMETER);
  ok('B2 Function.prototype.toString 自身自洽',
    b.local.fpToString === NATIVE_TO_STRING && a.local.fpToString === b.local.fpToString);
  ok('B3 普通函数 / 原生函数 toString 不受扰动',
    a.local.normalFn === b.local.normalFn && a.local.nativeFn === b.local.nativeFn &&
    /\[native code\]/.test(b.local.nativeFn));
  ok('B4 被 hook 函数仍无 own toString（函数对象零痕迹）',
    b.ownToString === false && b.getContext_ownToString === false,
    JSON.stringify([b.ownToString, b.getContext_ownToString]));

  // ---------- C：新增面显式登记 ----------
  console.log('-- C 新增面与边界 --');
  ok('C1 window own names 零新增（不引入可枚举字符串属性）',
    b.shared.extraOwnNames.length === 0 && a.shared.extraOwnNames.length === 0,
    JSON.stringify(b.shared.extraOwnNames));
  ok('C2 共享表只在注入组存在，且不可枚举（已知边界显式登记）',
    a.shared.registryPresent === false && b.shared.registryPresent === true &&
    b.shared.registryEnumerable === false,
    JSON.stringify([a.shared.registryPresent, b.shared.registryPresent, b.shared.registryEnumerable]));

  // ---------- D：双向咬（退化后必须重新泄漏） ----------
  console.log('-- D 双向咬：退化回 per-realm --');
  ok('D1 toDataURL 重新泄漏 JS wrapper 源码',
    c.cross.toDataURL.indexOf('[native code]') === -1 &&
    /exportPixels/.test(c.cross.toDataURL), c.cross.toDataURL);
  ok('D2 WebGL getParameter 重新泄漏 JS wrapper 源码',
    c.cross.getParameter.indexOf('[native code]') === -1 &&
    /FP\.webgl/.test(c.cross.getParameter), c.cross.getParameter);
  // 注意：shim 源码本身含 '[native code]' 字符串字面量，不能用「不含该串」判泄漏；
  // 判据建在内容形状（注入特征 + 与原生对照不等）上。
  ok('D3 navigator getter / 主 realm shim 重新泄漏',
    c.cross.navGetter !== a.cross.navGetter && /FP\.userAgent/.test(c.cross.navGetter) &&
    c.cross.mainShim !== a.cross.mainShim && /hookName\(this\)/.test(c.cross.mainShim),
    JSON.stringify([c.cross.navGetter, c.cross.mainShim]));
  ok('D4 反向分支亦重新泄漏',
    c.reverse !== a.reverse && /hookName\(this\)/.test(c.reverse), c.reverse);
  ok('D5 咬测组本 realm 洗白仍成立（只退化共享面）',
    c.local.toDataURL === NATIVE_TO_DATA_URL && c.local.fpToString === NATIVE_TO_STRING &&
    c.ownToString === false, JSON.stringify(c.local));

  // ---------- E：C207 时区原生一致性 ----------
  // 判据建在「值形状」：显式请求的时区必须原样出现在 resolvedOptions 里，且
  // format() 输出与无注入对照组逐字一致。旧实现把返回值改成人设时区 ⇒ E1 必红。
  console.log('-- E C207 时区原生一致性（调用方显式 timeZone 不得被改写）--');
  const tzOf = (x) => (x && x.tz && Array.isArray(x.tz.cases)) ? x.tz.cases : [];
  const tzDefault = (x) => (x && x.tz) ? x.tz.defaultZone : null;
  ok('E0 前提：原生对照组五例齐备、零改写、默认时区非空（非 vacuous）',
    tzOf(a).length === 5 && tzOf(a).every((c) => c.resolved === c.requested) &&
    !!tzDefault(a), JSON.stringify(tzOf(a)));
  ok('E1 注入组显式 timeZone 全部原样返回（值级判据，revert 咬下必红）',
    tzOf(b).length === 5 && tzOf(b).every((c) => c.resolved === c.requested),
    JSON.stringify(tzOf(b)));
  ok('E2 注入组默认时区与原生对照组一致（移除冗余覆写不牺牲对齐）',
    tzDefault(b) === tzDefault(a) && !!tzDefault(b),
    tzDefault(a) + ' vs ' + tzDefault(b));
  ok('E3 注入组 format() 与原生对照组逐字一致（formatter 语义未被扰动）',
    tzOf(b).every((c, i) => c.formatted === tzOf(a)[i].formatted),
    JSON.stringify(tzOf(b).map((c) => c.formatted)));
  ok('E4 五例格式化结果彼此可区分（断言不是恒等真空绿）',
    new Set(tzOf(a).map((c) => c.formatted)).size >= 4,
    JSON.stringify(tzOf(a).map((c) => c.formatted)));

  console.log('\n== C205 守护结果: ' + pass + ' 通过 / ' + fail + ' 失败 ==');
  if (fail > 0) { console.log('FAILS:\n' + fails.join('\n')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('GUARD CRASH:', e); process.exit(2); });
