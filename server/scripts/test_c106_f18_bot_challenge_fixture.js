'use strict';
// C106 F18 — 【真实浏览器】挑战页识别端到端守护。
//
// 零浏览器测试用的是手搓 observation 对象；真实链条还有两个未知数：
//   ① 真实 observation 的 textSummary / elements.text 能否拿到挑战文案
//      （本仓实证：PX 挑战页 DOM 仅 22–26 节点，elements 可能为 0，只剩文本通道）
//   ② 正常注册页在真实观察下不会被误判
// 本文件用真实 Chromium 加载两类本地页面，走完整 observation → detect 链路。

const http = require('http');
const { chromium } = require('playwright');
const observation = require('../agent/observation');
const botChallenge = require('../agent/botChallenge');
const { listenSafe } = require('./lib_safe_port');

const PAGES = {
  // 复刻真实 PerimeterX 挑战页形状：极少数节点 + 自述文案 + 供应商脚本引用
  '/challenge': [
    '<!doctype html><html><head><title>Attention Required</title></head><body>',
    '<div id="px-captcha"><h1>Confirm you&#39;re not a bot</h1>',
    '<p>Before we continue, press and hold the button to confirm you&#39;re human.</p>',
    '<p>ID de r&#233;f&#233;rence e130f876-aca9-11f1-96db-37fb13bc5988</p></div>',
    '<script src="https://js.px-cloud.net/?t=d-afmqzvw8o&v=373dd718"></script>',
    '</body></html>',
  ].join('\n'),

  // 正常注册表单（负例）
  '/signup': [
    '<!doctype html><html><body><form action="#">',
    '<h1>Create your account</h1>',
    '<input id="email" name="email" type="email" placeholder="Email">',
    '<input id="password" name="password" type="password" placeholder="Password">',
    '<button id="create" type="submit">Create account</button>',
    '</form></body></html>',
  ].join('\n'),
};

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('✅ PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('❌ FAIL | ' + name + ' | ' + detail); }
}

(async () => {
  const srv = http.createServer((req, res) => {
    const body = PAGES[req.url.split('?')[0]];
    if (!body) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  await listenSafe(srv, '127.0.0.1');
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // ① 挑战页：真实观察 → 必须命中
  await page.goto(BASE + '/challenge', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  const o1 = await observation.inspect(page, { taskId: 't_c106_f18' });
  const html1 = await page.evaluate(() => (document.documentElement ? document.documentElement.outerHTML.slice(0, 20000) : ''));
  const d1 = botChallenge.detect(o1.observation, { url: page.url(), html: html1 });
  check('挑战页：观察 ok', o1.ok !== false, 'ok=' + o1.ok);
  check('挑战页：detect 命中', d1.blocked === true, JSON.stringify(d1));
  check('挑战页：识别出 perimeterx 供应商', d1.vendor === 'perimeterx', String(d1.vendor));
  check('挑战页：置信度 ≥0.95（文本+供应商双信号）', d1.confidence >= 0.95, String(d1.confidence));

  // ② 正常注册页：不得误判
  await page.goto(BASE + '/signup', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  const o2 = await observation.inspect(page, { taskId: 't_c106_f18' });
  const html2 = await page.evaluate(() => (document.documentElement ? document.documentElement.outerHTML.slice(0, 20000) : ''));
  const d2 = botChallenge.detect(o2.observation, { url: page.url(), html: html2 });
  check('注册页：detect 不误判', d2.blocked === false, JSON.stringify(d2.evidence));
  check('注册页：观察能看到 email/password（页面本身正常）',
    ((o2.observation && o2.observation.elements) || []).some((e) => e.id === 'password'),
    'elements=' + ((o2.observation && o2.observation.elements) || []).length);

  await browser.close();
  srv.close();
  console.log(`\n=== C106 F18 真实浏览器 fixture: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
