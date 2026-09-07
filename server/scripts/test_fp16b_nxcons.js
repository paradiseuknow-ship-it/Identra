'use strict';

// Phase 16-B C50 — N-XCONS：native identity.json 驱动下 JS 层 <-> HTTP Client Hints 层全链 cross-consistency。
//
// 背景：patch 0008（POC #7）从 identity.json 派生 5 个 --fp-* 开关
//（platform / platform-version / hardware-concurrency / device-memory / max-touch-points）。
// 其中仅 platformVersion（C2 patch）有明确的双层承诺（NPV 已实证 HTTP 头跟随）；
// platform（C3）/ brands / UA 面的 HTTP 头层跟随从未实测——本套件补齐。
//
// 两种模式（与 N-IDP harness 约定一致）：
//   1) stock（默认，无 FPB_NATIVE_CHROME env）：对系统 Chrome 跑 stock 双层一致性
//      （原生浏览器 JS 层与 HTTP 层天然同源 → 必须全绿 = 回归活性）。
//   2) patched（FPB_NATIVE_CHROME=<native chrome.exe>）：identity.json 驱动下的双层矩阵。
//
// 断言矩阵：
//   N-XC-S1..S4 stock：sec-ch-ua-platform / user-agent / sec-ch-ua(brands) /
//           sec-ch-ua-platform-version 头 === 页内 JS 对应值（原生双层同源，活性）
//   N-XC-P1 patched：identity platformVersion 驱动双层 === identity.osVersion（C2 双层承诺）
//   N-XC-P2 patched：user-agent 头 === JS navigator.userAgent（identity 不驱动 UA 面 → 双层原生同源）
//   N-XC-P3 patched：sec-ch-ua-platform 头 === JS userAgentData.platform（platform 面不被 identity 覆盖 → 同源）
//   N-XC-P4 patched：sec-ch-ua brands 头 === JS userAgentData.brands（逐项，含 GREASE 顺序）
//   N-XC-P5 patched：JS navigator.platform === identity.platform（JS 面驱动重申，cross 比对基准）
//   N-XC-W1 边界记录（WARN 非 FAIL）：navigator.platform(identity JS 层) vs sec-ch-ua-platform 头(原生 HTTP 层)
//           ——16-B POC #3 冻结范围为 navigator.platform 单面，头层 OS 面联动属后续扩展；现状必须显式留痕。
//
// 关键纪律：platform-version 是高熵 hint，须 Accept-CH + Critical-CH 首导航授权后二次导航捕获；
// userAgentData 仅 http(s) origin、deviceMemory secure-context-only → 探针走 127.0.0.1 真实 origin。
//
// 用法：node server/scripts/test_fp16b_nxcons.js
//   FPB_NATIVE_CHROME=D:/chromium/src/out/Default/chrome.exe 启用 patched 全矩阵

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STOCK_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const NATIVE = process.env.FPB_NATIVE_CHROME || null;
const BIN = NATIVE || STOCK_CHROME;
const MODE = NATIVE ? 'PATCHED' : 'STOCK';

let pass = 0, fail = 0, warn = 0; const failures = []; const boundaryNotes = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else {
    let d = '';
    if (detail !== undefined) { try { d = JSON.stringify(detail); } catch (e) { d = String(detail); } }
    fail++; failures.push(name + (d ? ' :: ' + d.slice(0, 300) : '')); console.log('  FAIL ' + name + (d ? ' :: ' + d.slice(0, 300) : ''));
  }
}
function boundary(name, note) { warn++; boundaryNotes.push(name + ' :: ' + note); console.log('  WARN-BOUNDARY ' + name + ' :: ' + note); }

function stripSF(v) { return v === undefined || v === null ? null : String(v).replace(/^"|"$/g, ''); }

// 解析 sec-ch-ua 头为 [{brand, version}]（顶层逗号切分，GREASE 值不含逗号）
function parseSecChUa(hdr) {
  if (!hdr) return null;
  return String(hdr).split(',').map((part) => {
    const m = part.trim().match(/^"([^"]+)"\s*;\s*v\s*=\s*"?([^"]+)"?$/);
    return m ? { brand: m[1], version: m[2] } : null;
  }).filter(Boolean);
}

// 头捕获 + Accept-CH 授权服务：首导航响应发 Accept-CH/Critical-CH，记录每次导航请求头
function makeCaptureServer() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ t: Date.now(), headers: Object.assign({}, req.headers) });
    res.setHeader('Accept-CH', 'sec-ch-ua-platform-version');
    res.setHeader('Critical-CH', 'sec-ch-ua-platform-version');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>nxcons</body></html>');
  });
  return { srv, seen };
}

const JS_PROBE = () => new Promise((resolve) => {
  const out = { platform: navigator.platform, userAgent: navigator.userAgent };
  if (navigator.userAgentData) {
    out.uadPlatform = navigator.userAgentData.platform;
    out.uadMobile = navigator.userAgentData.mobile;
    out.brands = navigator.userAgentData.brands.map((b) => ({ brand: String(b.brand), version: String(b.version) }));
    // Chrome 151→152 漂移实证：getHighEntropyValue（单数）已移除，仅存 getHighEntropyValues（复数）
    const h = navigator.userAgentData.getHighEntropyValues;
    if (typeof h !== 'function') { resolve(out); return; }
    Promise.all([
      h.call(navigator.userAgentData, ['platformVersion']),
      h.call(navigator.userAgentData, ['fullVersionList']),
    ]).then(([pv, fvl]) => {
      out.platformVersion = pv && pv.platformVersion;
      out.fullVersionList = fvl && fvl.fullVersionList;
      resolve(out);
    }).catch(() => resolve(out));
  } else {
    resolve(out);
  }
});

async function runCase({ identityObj, extraArgs }) {
  const { srv, seen } = makeCaptureServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + srv.address().port + '/';
  let dir = null;
  const args = ['--no-first-run', '--no-default-browser-check'];
  if (extraArgs) args.push(...extraArgs);
  let ctx;
  try {
    if (identityObj !== undefined) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nxcons-'));
      if (identityObj !== null) fs.writeFileSync(path.join(dir, 'identity.json'), JSON.stringify(identityObj));
      ctx = await chromium.launchPersistentContext(dir, { executablePath: BIN, headless: true, args });
    } else {
      const browser = await chromium.launch({ executablePath: BIN, headless: true, args });
      ctx = await browser.newContext();
    }
    const page = await ctx.newPage();
    await page.goto(origin); // 首导航：接受 Accept-CH（Critical-CH 可能自动重导航）
    await page.goto(origin); // 二次导航：携带高熵 hint
    const mark = seen.length; // 此后的导航头为授权后样本
    await page.goto(origin);
    await page.waitForTimeout(200);
    const js = await page.evaluate(JS_PROBE);
    const hdr = (seen.slice(mark).find((s) => s.headers['sec-ch-ua-platform-version']) || seen[seen.length - 1]).headers;
    return { js, hdr, origin };
  } finally {
    try { await ctx.close(); } catch (e) { /* noop */ }
    srv.close();
  }
}

async function main() {
  console.log('N-XCONS mode=' + MODE + ' bin=' + BIN);

  // ── STOCK 半边（活性：原生浏览器双层天然同源）──
  const stock = await runCase({ identityObj: undefined });
  assert('N-XC-S1 stock: sec-ch-ua-platform 头 === JS userAgentData.platform',
    stripSF(stock.hdr['sec-ch-ua-platform']) === stock.js.uadPlatform,
    { hdr: stock.hdr['sec-ch-ua-platform'], js: stock.js.uadPlatform });
  assert('N-XC-S2 stock: user-agent 头 === JS navigator.userAgent',
    stripSF(stock.hdr['user-agent']) === stock.js.userAgent);
  assert('N-XC-S3 stock: sec-ch-ua brands 头 === JS brands（逐项含 GREASE 顺序）',
    JSON.stringify(parseSecChUa(stock.hdr['sec-ch-ua'])) === JSON.stringify(stock.js.brands),
    { hdr: stock.hdr['sec-ch-ua'], js: stock.js.brands });
  assert('N-XC-S4 stock: sec-ch-ua-platform-version 头 === JS platformVersion',
    stripSF(stock.hdr['sec-ch-ua-platform-version']) === stock.js.platformVersion,
    { hdr: stock.hdr['sec-ch-ua-platform-version'], js: stock.js.platformVersion });

  // ── PATCHED 半边（identity.json 驱动矩阵）──
  if (NATIVE) {
    // identity.desktop：platform=MacIntel（C3 JS 面）/ osVersion=10.0.0（C2 双层面）
    const idDesktop = {
      identityId: 'idn-nxcons-desktop', os: 'Windows', osVersion: '10.0.0',
      cpuProfile: { platform: 'MacIntel', hardwareConcurrency: 2 },
      memoryProfile: { deviceMemoryGB: 4 },
    };
    const p = await runCase({ identityObj: idDesktop });

    assert('N-XC-P1 identity platformVersion 驱动双层 === osVersion',
      stripSF(p.hdr['sec-ch-ua-platform-version']) === '10.0.0' && p.js.platformVersion === '10.0.0',
      { hdr: p.hdr['sec-ch-ua-platform-version'], js: p.js.platformVersion });
    assert('N-XC-P2 user-agent 头 === JS navigator.userAgent（UA 面双层原生同源）',
      stripSF(p.hdr['user-agent']) === p.js.userAgent);
    assert('N-XC-P3 sec-ch-ua-platform 头 === JS userAgentData.platform',
      stripSF(p.hdr['sec-ch-ua-platform']) === p.js.uadPlatform,
      { hdr: p.hdr['sec-ch-ua-platform'], js: p.js.uadPlatform });
    assert('N-XC-P4 sec-ch-ua brands 头 === JS brands（逐项含 GREASE 顺序）',
      JSON.stringify(parseSecChUa(p.hdr['sec-ch-ua'])) === JSON.stringify(p.js.brands),
      { hdr: p.hdr['sec-ch-ua'], js: p.js.brands });
    assert('N-XC-P5 JS navigator.platform === identity.platform（C3 JS 面驱动重申）',
      p.js.platform === 'MacIntel', p.js.platform);

    // N-XC-W1：显式边界留痕（非 FAIL）——identity platform 面冻结为 navigator.platform 单面
    const jsPlat = p.js.platform; const hdrPlat = stripSF(p.hdr['sec-ch-ua-platform']);
    if (jsPlat !== hdrPlat) {
      boundary('N-XC-W1 navigator.platform(identity JS 层) != sec-ch-ua-platform 头(原生 HTTP 层)',
        'identity.platform=' + jsPlat + ' vs header=' + hdrPlat + ' — 16-B POC #3 冻结单面设计，OS 面头层联动为后续扩展项');
    }
  } else {
    console.log('  SKIP-PATCHED patched 矩阵（未设置 FPB_NATIVE_CHROME）');
  }

  console.log('\n==== N-XCONS (' + MODE + ') ====');
  console.log('PASS=' + pass + ' FAIL=' + fail + ' WARN-BOUNDARY=' + warn);
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
  if (boundaryNotes.length) { console.log('BOUNDARY:'); boundaryNotes.forEach((b) => console.log('  ~ ' + b)); }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
