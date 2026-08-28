'use strict';
// Phase 9 Gate — 剩余 3 个失败的确定性 trace。
// 目的：判定每个失败属于「真断裂点（代码可修）」还是「planner 契约与 fixture 不符（改验证器=降标准，红线）」。
// 方法：真实浏览器 + 真实 observation + 真实 verification，把 planner 的 expect 与 fixture 真实 DOM 直接比对。

const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..', '..');

function startMockServer() {
  const root = path.join(ROOT, 'mock-site');
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(String(req.url || '/').split('?')[0]);
    if (p === '/') p = '/search.html';
    const file = path.join(root, p);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

(async () => {
  const observation = require('../agent/observation');
  const semanticResolver = require('../agent/semanticResolver');
  const verification = require('../agent/verification');
  const tools = require('../agent/tools');
  const { isActionableControl } = tools;
  const browserManager = require('../browserManager');

  const server = await startMockServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const profile = {
    id: 'p9_trace_' + Date.now().toString(36), name: 'P9-TRACE', group: 'default', tags: [], notes: '',
    seed: 'trace', headless: true, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { restoreLastSession: false, blockVideo: false, blockImages: false, clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false },
    fingerprintOverride: {}, fingerprint: null, lastSessionUrls: [], createdAt: Date.now(),
  };
  const session = await browserManager.launch(profile, null);
  const page = session.page;

  // ══════════ CASE 1: rw.001 #0 — element_present="input[name='username']" on saas/login.html ══════════
  console.log('\n══ CASE 1  rw.001#0  navigate → saas/login.html, expect element_present="input[name=\'username\']" ══');
  await page.goto(base + '/saas/login.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  let obs = (await observation.inspect(page, { taskId: 'trace', skipCache: true })).observation;
  const inputs = (obs.elements || []).filter((e) => e.tag === 'input');
  console.log('  fixture 真实 input 列表:');
  inputs.forEach((e) => console.log('    - tag=' + e.tag + ' id=' + e.id + ' name=' + e.name + ' type=' + e.type + ' aria=' + e.aria));
  const hasUsername = inputs.some((e) => e.name === 'username');
  console.log('  → 存在 name="username" 吗？', hasUsername);
  console.log('  → 真实 verification 判定:', JSON.stringify(verification.verify({ type: 'element_present', expect: "input[name='username']" }, obs).success));
  console.log('  → 对照 element_present="input[name=\'email\']":', JSON.stringify(verification.verify({ type: 'element_present', expect: "input[name='email']" }, obs).success));

  // ══════════ CASE 2: rw.076 #2 — 搜索「耳机」后 text_present="耳机" ══════════
  console.log('\n══ CASE 2  rw.076#2  ecommerce/search.html 搜索「耳机」, expect text_present="耳机" ══');
  await page.goto(base + '/ecommerce/search.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  await page.fill('input#q', '耳机');
  await page.click('#searchBtn');
  await page.waitForTimeout(600);
  obs = (await observation.inspect(page, { taskId: 'trace', skipCache: true })).observation;
  console.log('  搜索「耳机」后页面文本:', String(obs.textSummary || '').slice(0, 160));
  console.log('  → text_present="耳机" 判定:', JSON.stringify(verification.verify({ type: 'text_present', expect: '耳机' }, obs).success));
  // 对照：搜索库里真实存在的商品
  await page.goto(base + '/ecommerce/search.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  await page.fill('input#q', '显示器');
  await page.click('#searchBtn');
  await page.waitForTimeout(600);
  obs = (await observation.inspect(page, { taskId: 'trace', skipCache: true })).observation;
  console.log('  对照 搜索「显示器」后文本:', String(obs.textSummary || '').slice(0, 160));
  console.log('  → text_present="显示器" 判定:', JSON.stringify(verification.verify({ type: 'text_present', expect: '显示器' }, obs).success));

  // ══════════ CASE 3: rw.056 #4 — form.html submit 后 text_present="提交成功" ══════════
  console.log('\n══ CASE 3  rw.056#4  data_entry/form.html submit, expect text_present="提交成功" ══');
  await page.goto(base + '/data_entry/form.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  await page.fill('input#name', '张三');
  await page.fill('input#email', 'z@x.io');
  await page.fill('input#phone', '13900000000');
  obs = (await observation.inspect(page, { taskId: 'trace', skipCache: true })).observation;

  const target = { semantic: '提交按钮', field: 'submit' };
  const cands = semanticResolver.resolve(target, obs);
  console.log('  resolver 候选（前 5）:');
  cands.slice(0, 5).forEach((c) => console.log('    - ' + c.el.tag + '#' + (c.el.id || '') + ' score=' + (typeof c.score === 'number' ? c.score.toFixed(3) : c.score) + ' sel=' + c.selector));
  const meta = {};
  const sel = await tools.resolveSelector({ type: 'submit', target }, obs, meta, null, { prefer: isActionableControl });
  console.log('  → resolveSelector(submit, prefer=actionable) =', sel ? sel.selector : 'null', '| matchedBy=' + meta.matchedBy + ' | memoryDeclined=' + meta.memoryDeclinedByPrefer);

  if (sel) {
    await browserManager.humanClick(page, sel.selector, {});
    await page.waitForTimeout(800);
  }
  const after = (await observation.inspect(page, { taskId: 'trace', skipCache: true })).observation;
  console.log('  点击后页面文本:', String(after.textSummary || '').slice(0, 200));
  console.log('  → text_present="提交成功" 判定:', JSON.stringify(verification.verify({ type: 'text_present', expect: '提交成功' }, after).success));
  console.log('  → 对照 text_present="注册成功" 判定:', JSON.stringify(verification.verify({ type: 'text_present', expect: '注册成功' }, after).success));
  console.log('  → 页面结构是否改变? textSummary 长度 before=' + String(obs.textSummary || '').length + ' after=' + String(after.textSummary || '').length);

  await browserManager.close(profile.id);
  server.close();
  process.exit(0);
})().catch((e) => { console.error('trace 异常:', e && e.stack || e); process.exit(1); });
