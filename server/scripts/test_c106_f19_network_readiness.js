'use strict';
// C106 F19 — 【真实浏览器 fixture】网络就绪判据分层守护。
//
// 实证背景（真实 Webflow E2E 第 6 轮）：27 个动作全部卡在 step_001，
// 固定循环 networkState=pending → EVENTUAL_CONSISTENCY → WAIT
//   → 误诊 NETWORK_REQUEST_FAILED(conf 0.9) → wait → …
// 根因：请求计数器把所有请求一视同仁（document/xhr/fetch/长轮询/analytics 全算）
// → 真实站点（SPA + analytics + 长轮询）pending 恒为真
// → verificationIntelligence._analyze 第 2 步短路命中 WAIT
// → 第 3 步起整条判据链（loading / domChanged / 证据）永远走不到。
//
// 覆盖（真实 Chromium + 真实请求 + 真实 observation）：
//   A 长轮询长挂（>xhr 窗口）→ 不得再判 pending（破除恒真，核心）
//   B 首屏 xhr 刚发出（窗口内）→ 仍判 pending（该等的时候要等，不得矫枉过正）
//   C 主 frame 阻塞脚本长挂 → 判 pending（文档主体仍在加载）
//   D iframe 第三方长挂 → 不得钉住宿主页面（子 frame 不计入）
//   E 验证链不再短路：networkState=idle 时不得再返回 WAIT/EVENTUAL_CONSISTENCY

const http = require('http');
const { chromium } = require('playwright');
const observation = require('../agent/observation');
const networkReadiness = require('../agent/networkReadiness');
const verificationIntelligence = require('../agent/verification/verificationIntelligence');
const { listenSafe } = require('./lib_safe_port');

const PAGE = (body) => '<!doctype html><html><body>' + body + '</body></html>';

const PAGES = {
  // A/B：发起一个永不返回的 fetch（模拟长轮询 / analytics 挂起）
  '/longpoll': PAGE([
    '<div id="x">ready</div>',
    '<script>fetch("/hang").catch(function(){});</script>',
  ].join('')),
  // C：主 frame 阻塞脚本永不返回（文档主体仍在加载）
  '/blockscript': '<!doctype html><html><body><div id="x">ready</div><script src="/hang"></script></body></html>',
  // D：iframe 里挂着永不返回的请求
  '/framed': PAGE('<div id="x">ready</div><iframe src="/hang"></iframe>'),
};

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('✅ PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('❌ FAIL | ' + name + ' | ' + detail); }
}

function server() {
  return http.createServer((req, res) => {
    if (req.url === '/hang') return; // 永不响应 —— 模拟长轮询/挂起请求
    const body = PAGES[req.url.split('?')[0]];
    if (!body) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  });
}

(async () => {
  const srv = server();
  await listenSafe(srv, '127.0.0.1');
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  // F19 根因二：hook 必须在 page 创建时挂载（由 browserManager.newTrackedPage 保证），
  // 而不是等到首次 inspect —— 否则页面加载期间的请求全部漏计。
  const page = await ctx.newPage();
  networkReadiness.attach(page);

  // ---------- A 核心：长轮询长挂 → 不得再判 pending（破除恒真）----------
  await page.goto(BASE + '/longpoll', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000); // 超过 xhr 的 3s 阻塞窗口
  {
    const o = await observation.inspect(page, { taskId: 't_f19_a', skipCache: true });
    check('A1 长轮询挂起 4s 后判 idle（核心：不再恒 pending）',
      o.observation && o.observation.networkState === 'idle',
      'networkState=' + (o.observation && o.observation.networkState));
    check('A2 页面确实仍有一个未完成的请求（fixture 生效）',
      (page.__pendingRequests || 0) > 0, '__pendingRequests=' + page.__pendingRequests);
  }

  // ---------- B 对照：首屏 xhr 在窗口内 → 仍判 pending（不得矫枉过正）----------
  {
    const p2 = await ctx.newPage(); networkReadiness.attach(p2);
    await p2.goto(BASE + '/longpoll', { waitUntil: 'domcontentloaded' });
    const o2 = await observation.inspect(p2, { taskId: 't_f19_b', skipCache: true });
    check('B1 首屏 xhr 刚发出（3s 窗口内）仍判 pending（该等的时候要等）',
      o2.observation && o2.observation.networkState === 'pending',
      'networkState=' + (o2.observation && o2.observation.networkState));
    await p2.close();
  }

  // ---------- C 主 frame 阻塞脚本 → 判 pending ----------
  {
    const p3 = await ctx.newPage(); networkReadiness.attach(p3);
    await p3.goto(BASE + '/blockscript', { waitUntil: 'commit' }).catch(() => {});
    await p3.waitForTimeout(600);
    const o3 = await observation.inspect(p3, { taskId: 't_f19_c', skipCache: true }).catch(() => null);
    check('C1 主 frame 阻塞脚本长挂 → 判 pending（文档主体仍在加载）',
      !!(o3 && o3.observation && o3.observation.networkState === 'pending'),
      'networkState=' + (o3 && o3.observation && o3.observation.networkState));
    await p3.close();
  }

  // ---------- D iframe 第三方长挂 → 不得钉住宿主页面 ----------
  {
    const p4 = await ctx.newPage(); networkReadiness.attach(p4);
    await p4.goto(BASE + '/framed', { waitUntil: 'domcontentloaded' });
    await p4.waitForTimeout(1500);
    const o4 = await observation.inspect(p4, { taskId: 't_f19_d', skipCache: true });
    check('D1 iframe 子 frame 长挂不钉住主页面 → idle',
      o4.observation && o4.observation.networkState === 'idle',
      'networkState=' + (o4.observation && o4.observation.networkState));
    await p4.close();
  }

  // ---------- E 验证链不再短路 ----------
  {
    const before = { url: 'https://x/signup', textSummary: 'signup', domFingerprint: 'fp_before' };
    const after = {
      url: 'https://x/signup', textSummary: 'welcome', domFingerprint: 'fp_after',
      loadingState: 'complete',
      networkState: 'idle', // F19 后：长轮询不再让这里恒为 pending
      previousObservationDiff: { domChanged: true },
    };
    const r = verificationIntelligence.analyze({
      beforeObservation: before,
      afterObservation: after,
      actionResult: { success: true },
      action: { type: 'fill' },
      expectedVerification: { type: 'element_present', target: { semantic: 'welcome' } },
    });
    const ft = r && (r.failureType || (r.verificationEvidence && r.verificationEvidence.failureType));
    check('E1 networkState=idle 时不再短路为 EVENTUAL_CONSISTENCY', ft !== 'EVENTUAL_CONSISTENCY', 'failureType=' + ft);
    check('E2 也不再返回 WAIT 决策', !!(r && r.decision !== 'WAIT'), 'decision=' + (r && r.decision));
  }

  // ---------- F 兼容：无分层信息时回退旧总计数语义 ----------
  {
    const fake = { __pendingRequests: 2 };
    // computeNetworkState 是模块内函数；通过 inspect 的回退路径间接验证不了，
    // 这里直接断言回退分支存在于源码（防止后续重构删掉兼容）。
    const fs = require('fs');
    const nr = fs.readFileSync(require('path').join(__dirname, '..', 'agent', 'networkReadiness.js'), 'utf8');
    check('F1 保留 __pendingRequests 回退分支（兼容既有测试桩）',
      /typeof page\.__pendingRequests === 'number'/.test(nr), '');
    check('F2 pending 分层窗口表存在且 xhr 窗口短于 document',
      /xhr:\s*3000/.test(nr) && /document:\s*20000/.test(nr), '');
    check('F3 非阻塞类型（ping/websocket/eventsource/image）不在窗口表内',
      !/ping:|websocket:|eventsource:|image:/.test(nr), '');
    // 挂载时机：browserManager 必须在新 page 创建时就 attach（根因二）
    const bmsrc = fs.readFileSync(require('path').join(__dirname, '..', 'browserManager.js'), 'utf8');
    check('F4 browserManager 在 page 创建时 attach（不再等首次 inspect）',
      /networkReadiness\.attach\(p\)/.test(bmsrc) && /async function newTrackedPage/.test(bmsrc), '');
    check('F5 newTrackedPage 内部未自递归（sed 批量替换易踩坑）',
      !/async function newTrackedPage[\s\S]{0,120}await newTrackedPage\(/.test(bmsrc), '');
    const obssrc = fs.readFileSync(require('path').join(__dirname, '..', 'agent', 'observation.js'), 'utf8');
    check('F6 observation 已收敛为委托 networkReadiness（不再自己维护计数）',
      /networkReadiness\.compute\(page\)/.test(obssrc) && !/BLOCKING_WINDOW_MS\s*=\s*\{/.test(obssrc), '');
    void fake;
  }

  await browser.close();
  srv.close();
  console.log('\n结果: ' + pass + ' passed / ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e && e.message); process.exit(1); });
