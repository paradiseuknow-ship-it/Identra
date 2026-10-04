'use strict';
// C106 F18 — 【真实浏览器】挑战页识别端到端守护。
//
// 零浏览器测试用的是手搓 observation 对象；真实链条还有三个未知数：
//   ① 真实 observation 的 textSummary / elements.text 能否拿到挑战文案
//      （本仓实证：PX 挑战页 DOM 仅 22–26 节点，elements 可能为 0，只剩文本通道）
//   ② 正常注册页在真实观察下不会被误判
//   ③ （C160 追加）VISIBILITY_PROBE 是【页面内】函数，只有真实浏览器才能验证它
//      对真实几何的计算是否正确（被动 badge 不可见 / 真挑战容器可见）
// 本文件用真实 Chromium 加载四类本地页面，走完整 observation → detect 链路。

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

  // C160：复刻 https://app.spocket.co/signup 的真实形状 —— 【正常注册页】，
  // 但页脚有一句全站声明 + 引用被动防护脚本 + 一个有尺寸的 hCaptcha 挂载容器。
  // 这正是 C159 被误判为「人机验证挑战页」而拒绝填凭据的那一页。
  '/signup-hcaptcha': [
    '<!doctype html><html><head><title>Spocket: #1 Dropshipping App</title></head><body>',
    '<h1>Welcome to Spocket</h1>',
    '<form action="#">',
    '<input id="email" name="email" type="email" placeholder="Email address">',
    '<input id="name" name="name" type="text" placeholder="Name">',
    '<button id="get-started" type="submit">Get Started</button>',
    '</form>',
    '<div class="h-captcha" data-sitekey="10000000-ffff-ffff-ffff-000000000001" style="width:303px;height:78px"></div>',
    '<script src="https://js.hcaptcha.com/1/api.js" async defer></script>',
    '<p>This site is protected by hCaptcha and the hCaptcha Privacy Policy and Terms of Service apply.</p>',
    '</body></html>',
  ].join('\n'),

  // C160：可见挑战控件（整块挑战区，尺寸 ≈ 真挑战实测 520×570，无任何指令性文案）
  '/challenge-visible': [
    '<!doctype html><html><head><title>Site</title></head><body>',
    '<div id="px-captcha" style="width:520px;height:570px;display:block"></div>',
    '</body></html>',
  ].join('\n'),

  // C160 真实站点实证（app.spocket.co/signup）：hCaptcha 的**隐形验证 iframe** ——
  // 尺寸 300×150（**达阈值**）却置于屏外 top:-9999px 且 visibility:hidden。
  // 只看尺寸会把它误判为「正在要求人机验证」⇒ 凭据闸随即拒绝往正常注册表单填凭据。
  '/signup-hcaptcha-offscreen': [
    '<!doctype html><html><head><title>Sign Up - Spocket</title></head><body>',
    '<h1>Welcome to Spocket</h1>',
    '<form action="#">',
    '<input id="email" name="email" type="email" placeholder="Email address">',
    '<input id="name" name="name" type="text" placeholder="Name">',
    '<button id="get-started" type="submit">Get Started</button>',
    '</form>',
    '<div class="h-captcha" style="width:303px;height:78px"></div>',
    '<iframe id="hcaptcha-invisible" src="https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=challenge" style="position:absolute;top:-9999px;left:1px;width:300px;height:150px;border:0;visibility:hidden"></iframe>',
    '<script src="https://js.hcaptcha.com/1/api.js" async defer></script>',
    '<p>This site is protected by hCaptcha and the hCaptcha Privacy Policy and Terms of Service apply.</p>',
    '</body></html>',
  ].join('\n'),
};

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('✅ PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('❌ FAIL | ' + name + ' | ' + detail); }
}

async function probePage(page) {
  // 与生产调用点同形：PROBE_PAGE 整体作为 pageFunction 传入（作为 arg 会被 Playwright 拒绝）。
  return await page.evaluate(botChallenge.PROBE_PAGE);
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
  const p1 = await probePage(page);
  const d1 = botChallenge.detect(o1.observation, { url: page.url(), html: p1.html, challengeVisible: p1.visible });
  check('挑战页：观察 ok', o1.ok !== false, 'ok=' + o1.ok);
  check('挑战页：detect 命中', d1.blocked === true, JSON.stringify(d1));
  check('挑战页：识别出 perimeterx 供应商', d1.vendor === 'perimeterx', String(d1.vendor));
  check('挑战页：置信度 ≥0.95（文本+供应商双信号）', d1.confidence >= 0.95, String(d1.confidence));

  // ② 正常注册页：不得误判
  await page.goto(BASE + '/signup', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  const o2 = await observation.inspect(page, { taskId: 't_c106_f18' });
  const p2 = await probePage(page);
  const d2 = botChallenge.detect(o2.observation, { url: page.url(), html: p2.html, challengeVisible: p2.visible });
  check('注册页：detect 不误判', d2.blocked === false, JSON.stringify(d2.evidence));
  check('注册页：观察能看到 email/password（页面本身正常）',
    ((o2.observation && o2.observation.elements) || []).some((e) => e.id === 'password'),
    'elements=' + ((o2.observation && o2.observation.elements) || []).length);

  // ③ C160 真实形状注册页（Spocket 形状）：凭据闸必须放行，否则注册第一步即死
  await page.goto(BASE + '/signup-hcaptcha', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  const o3 = await observation.inspect(page, { taskId: 't_c106_f18' });
  const p3 = await probePage(page);
  const d3 = botChallenge.detect(o3.observation, { url: page.url(), html: p3.html, challengeVisible: p3.visible });
  check('Spocket 形状注册页：可见性探测未误报（303×78 容器不达挑战尺寸）', p3.visible === false, 'visible=' + p3.visible);
  check('Spocket 形状注册页：detect 【不】误判（C159 真实站点锚）', d3.blocked === false, JSON.stringify(d3.evidence));
  check('Spocket 形状注册页：仍识别出供应商（留痕不阻断）', d3.vendor === 'hcaptcha' && d3.passive === true, String(d3.vendor) + '/' + d3.passive);
  check('Spocket 形状注册页：观察能看到 email/name（表单可用）',
    ((o3.observation && o3.observation.elements) || []).filter((e) => e.id === 'email' || e.id === 'name').length === 2,
    'elements=' + ((o3.observation && o3.observation.elements) || []).length);

  // ④ 可见挑战控件（无文案）：几何通道必须命中
  await page.goto(BASE + '/challenge-visible', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  const o4 = await observation.inspect(page, { taskId: 't_c106_f18' });
  const p4 = await probePage(page);
  const d4 = botChallenge.detect(o4.observation, { url: page.url(), html: p4.html, challengeVisible: p4.visible });
  check('可见挑战控件：可见性探测命中（520×570）', p4.visible === true, 'visible=' + p4.visible);
  check('可见挑战控件：detect 命中（几何通道，无任何文案）', d4.blocked === true, JSON.stringify(d4.evidence));

  // ⑤ C160 真实站点实证：屏外 + hidden 的达标尺寸 captcha iframe ⇒ 绝不得判为挑战页
  //    （这正是 C159 实战中被误判、导致注册第一步即死的那一页的真实形状）
  await page.goto(BASE + '/signup-hcaptcha-offscreen', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  const o5 = await observation.inspect(page, { taskId: 't_c106_f18' });
  const p5 = await probePage(page);
  const d5 = botChallenge.detect(o5.observation, { url: page.url(), html: p5.html, challengeVisible: p5.visible });
  check('屏外隐形 captcha iframe（300×150 / top:-9999 / visibility:hidden）：可见性探测必须为 false',
    p5.visible === false, 'visible=' + p5.visible);
  check('屏外隐形 captcha iframe：detect 【不】误判为挑战页（C160 真实站点锚）',
    d5.blocked === false, JSON.stringify(d5.evidence));

  await browser.close();
  srv.close();
  console.log(`\n=== C106 F18 真实浏览器 fixture: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
