'use strict';
// C191 守护：注入的 getBoundingClientRect 必须满足两条契约，否则真实站点会整页崩溃。
//
// 背景（C191 实测）：GitKraken checkout 点「Country or region」下拉 → 页面变
// 「Application error: a client-side exception has occurred」，console 里是
// React error #185（Maximum update depth exceeded）。根因是注入把
// Element.prototype.getBoundingClientRect 改成**每次调用都重新掷 ±0.02px 噪声**：
//   A 稳定性契约：同一布局下同一元素的 rect 必须逐字段稳定。会抖的 rect 让
//     「render 期读 rect → effect 里 setState」的组件（react-select 菜单定位等）
//     每次渲染都认为几何变了 ⇒ 无限重渲染 ⇒ React #185。
//   B 一致性契约：真实 DOMRect 恒满足 x===left、y===top、right-left===width、
//     bottom-top===height。旧实现对八个字段各自独立加噪，四条等式全部不成立
//     （本身也是比"无噪声"更强的破绽）。
// 因果双向验证（C191）：纯 Chrome 只加旧噪声 ⇒ 必崩；产品注入关掉该段 ⇒ 正常。
//
// 本守护用真实 Chrome + 真 buildInjectionScript 在本地页面上验证契约，不联网。

const path = require('path');
const http = require('http');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { buildInjectionScript } = require('../fp/inject');
const { generateFingerprint } = require('../fp/generate');
const { listenSafe } = require('./lib_safe_port');

const CHROME = process.env.FP_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

let pass = 0; let fail = 0;
const fails = [];
function ok(name, cond, extra) { if (cond) { pass++; } else { fail++; fails.push(name + (extra ? ' :: ' + extra : '')); console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }
function eq(name, a, b) { ok(name, a === b, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
function near(name, a, b, tol) { ok(name, Math.abs(a - b) <= tol, 'got=' + a + ' want≈' + b); }

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>c191</title>
<style>
  body{margin:0;font:14px/1.4 sans-serif}
  #box{position:absolute;left:37px;top:41px;width:200px;height:60px;background:#ddd}
  #list{position:absolute;left:37px;top:120px;width:200px;height:24px;overflow:visible}
  #item{position:absolute;left:50px;top:10px;width:80px;height:16px;background:#bbb}
</style></head>
<body><div id="box">box</div><div id="list"><div id="item">item</div></div></body></html>`;

async function startServer() {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(HTML);
  });
  // listenSafe 返回 Promise<server>（不是端口号），端口从 address() 取
  const bound = await listenSafe(srv, '127.0.0.1');
  const port = bound.address().port;
  return { srv, port };
}

// 页内探针：连续读同一元素 3 次 rect，返回是否逐字段稳定 + 内部一致性
const PROBE = () => {
  const el = document.getElementById('box');
  const read = () => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, t: r.top, l: r.left, rt: r.right, b: r.bottom }; };
  const a = read(); const b = read(); const c = read();
  const stable = ['x', 'y', 'w', 'h', 't', 'l', 'rt', 'b'].every((k) => a[k] === b[k] && b[k] === c[k]);
  const invariants = (r) => r.x === r.l && r.y === r.t && Math.abs((r.rt - r.l) - r.w) < 1e-9 && Math.abs((r.b - r.t) - r.h) < 1e-9;
  return { a: a, stable: stable, invA: invariants(a), invB: invariants(b), invC: invariants(c) };
};

(async () => {
  console.log('=== C191 getBoundingClientRect 注入契约守护 ===');
  const { srv, port } = await startServer();
  const url = 'http://127.0.0.1:' + port + '/';
  const fpNoisy = generateFingerprint('c191-guard-seed');
  const fpQuiet = generateFingerprint('c191-guard-seed', { clientRects: false });
  console.log('[fp] clientRects(noisy)=' + fpNoisy.clientRects + ' clientRects(quiet)=' + fpQuiet.clientRects);

  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    // ---------------- A 段：默认（噪声开启） ----------------
    console.log('\n--- A 噪声开启：稳定契约 ---');
    const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
    await ctx.addInitScript(buildInjectionScript(fpNoisy));
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'load' });

    const r1 = await page.evaluate(PROBE);
    ok('A1 连续 3 次 getBoundingClientRect 逐字段稳定', r1.stable,
      JSON.stringify(r1.a) + ' (旧实现此处必为 false ⇒ React #185)');
    ok('A2 首次读满足内部不变量 x===left 等', r1.invA, JSON.stringify(r1.a));
    ok('A3 第二次读满足内部不变量', r1.invB, JSON.stringify(r1.a));
    ok('A4 第三次读满足内部不变量', r1.invC, JSON.stringify(r1.a));

    // 真实布局值（无注入时的几何）作为基准
    const nativeCtx = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const nativePage = await nativeCtx.newPage();
    await nativePage.goto(url, { waitUntil: 'load' });
    const n1 = await nativePage.evaluate(PROBE);
    ok('A5 原生页面同样稳定（对照组基线）', n1.stable === true);
    near('A6 注入后 x 仍在噪声范围内（|Δ|≤0.02）', r1.a.x - n1.a.x, 0, 0.0201);
    near('A7 注入后 y 仍在噪声范围内', r1.a.y - n1.a.y, 0, 0.0201);
    near('A8 注入后 width 仍在噪声范围内', r1.a.w - n1.a.w, 0, 0.0201);
    ok('A9 噪声确实生效（不是退化成零偏移）',
      Math.abs(r1.a.x - n1.a.x) > 0 || Math.abs(r1.a.y - n1.a.y) > 0 || Math.abs(r1.a.w - n1.a.w) > 0,
      'Δx=' + (r1.a.x - n1.a.x).toFixed(4) + ' Δy=' + (r1.a.y - n1.a.y).toFixed(4));

    // 布局变化后必须跟随（不能变成写死的常量）
    const r2 = await page.evaluate(() => {
      const el = document.getElementById('box');
      const before = el.getBoundingClientRect().width;
      el.style.width = '320px';
      void el.offsetWidth;
      const after = el.getBoundingClientRect().width;
      return { before: before, after: after };
    });
    ok('A10 布局变化后 rect.width 随之变化（噪声跟随真实几何）', r2.after - r2.before > 100,
      'before=' + r2.before + ' after=' + r2.after);

    // 静态布局下再读仍稳定（缓存不因时间流逝失效）
    await page.waitForTimeout(600);
    const r3 = await page.evaluate(() => {
      const el = document.getElementById('box');
      const a = el.getBoundingClientRect();
      return { w: a.width, x: a.x };
    });
    near('A11 600ms 后再读与布局变化后的值一致', r3.w, r2.after, 1e-9);
    const r4 = await page.evaluate(PROBE);
    ok('A12 稳态布局再次连续读取仍稳定', r4.stable === true, JSON.stringify(r4.a));
    await ctx.close();
    await nativeCtx.close();

    // ---------------- B 段：clientRects=false ----------------
    console.log('\n--- B clientRects=false：零偏移 ---');
    const ctx2 = await browser.newContext({ viewport: { width: 800, height: 600 } });
    await ctx2.addInitScript(buildInjectionScript(fpQuiet));
    const page2 = await ctx2.newPage();
    await page2.goto(url, { waitUntil: 'load' });
    const q = await page2.evaluate(PROBE);
    eq('B1 关闭后 x 与原生逐字相同', q.a.x, n1.a.x);
    eq('B2 关闭后 y 与原生逐字相同', q.a.y, n1.a.y);
    eq('B3 关闭后 width 与原生逐字相同', q.a.w, n1.a.w);
    eq('B4 关闭后 height 与原生逐字相同', q.a.h, n1.a.h);
    eq('B5 关闭后 right 与原生逐字相同', q.a.rt, n1.a.rt);
    ok('B6 关闭后同样稳定', q.stable === true);
    await ctx2.close();

    // ---------------- C 段：源码形态守护（防回退到"每次重掷"） ----------------
    console.log('\n--- C 实现形态 ---');
    const src = fs.readFileSync(path.join(__dirname, '../fp/inject.js'), 'utf8');
    ok('C1 存在按几何签名缓存噪声的实现（WeakMap 签名缓存）',
      /rectNoiseCache/.test(src) && /sig\s*!==\s*sig|rec\.sig\s*!==\s*sig/.test(src));
    ok('C2 right/bottom 由 x+width / y+height 推导（不吃独立噪声）',
      /right:\s*x\s*\+\s*w/.test(src) && /bottom:\s*y\s*\+\s*h/.test(src));
    ok('C3 八个字段不再各自调用噪声函数',
      !/right:\s*rect\.right\s*\+\s*n\(\)/.test(src) && !/left:\s*rect\.left\s*\+\s*n\(\)/.test(src));
  } finally {
    await browser.close().catch(() => {});
    srv.close();
  }

  console.log('\n=== 结果：PASS=' + pass + ' FAIL=' + fail + ' ===');
  if (fail) { console.log('失败项：\n' + fails.join('\n')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
