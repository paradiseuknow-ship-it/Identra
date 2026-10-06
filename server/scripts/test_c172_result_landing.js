'use strict';

// C172 守护：结果落点窗口 —— click 触发（延迟）跨文档导航时，after 观察必须落在**新**文档上。
//
// 现场（真实任务，2026-10-06，逐字取自 aiAttempts）：
//   task_muwco0lhxixif step_003 = click {semantic:'Get Started'}，判据 url_contains "/signup"。
//   click **确实**触发了跨域跳转 app.spocket.co/signup，但 after 观测连续读到**旧** URL
//   （www.spocket.co/?ps_partner_key=…）⇒ 判失败 ⇒ 重试 / 重规划 / reload 螺旋；
//   等到后续 try 才看到新页，此时判据「在动作执行前已成立」⇒ 只拿到恒真证据（C171 拦下）
//   ⇒ 整步最终升级人工。task_muw5da7hgw7bw（C165）同构。
//   结构性根因：submit/login/logout 分支早已有落点窗口，click 分支只有固定 300ms。
//
// 本守护钉住五件事（全程离线：本地夹具 + 真实 Chromium，不触任何真实站点）：
//   ① 端到端咬合：**延迟**（1200ms）跨文档导航，落点后 url_contains 必须由假失败转真成功；
//   ② revert 咬：旧行为（仅 300ms 固定等）在同一夹具上必须变红 —— 证明①的断言有分辨力；
//   ③ 代价：不导航的 click 不得被拖满超时（只付「发起检测窗」）；
//   ④ 静默降级：等待能力缺失 / 全部失败时有界返回、绝不阻断主流程；
//   ⑤ 接线与位置唯一性：落点窗口在生产代码里只有一处实现，且时序在观察**之前**。
//
// 运行：node server/scripts/test_c172_result_landing.js

const os = require('os');
const path = require('path');
const http = require('http');
const fs = require('fs');

// C140 纪律：夹具一律隔离数据根，绝不写入 server/data。
// 必须在任何 require 之前设置（数据根是模块加载期解析的）。
process.env.FPB_DATA_DIR = path.join(os.tmpdir(), 'c172_landing_' + Date.now());

const ROOT = path.join(__dirname, '..', '..');
const AGENT = path.join(__dirname, '..', 'agent');
const tools = require(path.join(AGENT, 'tools'));
const verification = require(path.join(AGENT, 'verification'));
const networkReadiness = require(path.join(AGENT, 'networkReadiness'));
const browserManager = require(path.join(__dirname, '..', 'browserManager'));
const { chromium } = require('playwright');
// C94 P3a：test_*.js 一律禁用「零端口自动分配」（Chromium 官方黑名单含 80 个端口，
// 自动分配可能恰好落在其中，产生「偶发、极难归因」的失败）。统一消费 lib_safe_port 唯一事实源。
// ⚠️ 注释里也不得出现该调用形态的字面文本 —— 该守卫按源码文本扫描，写进注释同样算违规。
const { listenSafe } = require('./lib_safe_port');

const META = { taskId: null };
// 模拟跨域首跳的网络耗时（DNS / TLS / 响应）：必须显著大于旧行为的 300ms 固定等。
const SIGNUP_DELAY_MS = 1200;

// ⚠️ 必须用生产的点击原语 —— browserManager.humanClick（裸 mouse.down/up）。
// 不能用 page.click()：Playwright 的高层动作会**等待点击触发的导航完成**，
// 那会把本守护要抓的竞态整个掩盖掉（首版夹具即因此让 B 组 revert 咬假绿）。
// 「断言真正执行的那份」在这里的含义就是：点击必须和 click 分支用同一个原语。
async function prodClick(page, selector) {
  return browserManager.humanClick(page, selector, {});
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  << ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// ---- 本地夹具：/shop 上的链接指向 /signup，而 /signup 的响应被刻意延迟 ----
function startServer() {
  return http.createServer((req, res) => {
    if (String(req.url).indexOf('/signup') === 0) {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><head><title>Signup</title></head><body><h1>Create your account</h1>'
          + '<form><input type="email" name="email"></form></body></html>');
      }, SIGNUP_DELAY_MS);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><head><title>Shop</title></head><body>'
      + '<h1>Spocket</h1>'
      + '<a id="go" href="/signup">Get Started</a>'
      + '<button id="noop">Toggle</button>'
      + '<script>document.getElementById("noop").addEventListener("click",function(){document.body.setAttribute("data-toggled","1");});<\/script>'
      + '</body></html>');
  });
}

async function main() {
  // =========================================================================
  section('A 端到端咬合：点击触发的延迟跨文档导航必须被等到（核心）');
  const srv = startServer();
  await listenSafe(srv, '127.0.0.1');
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();

  try {
    {
      const page = await ctx.newPage();
      // 生产的挂载点在 page 创建时（browserManager.newTrackedPage；由 F19 守护 F4 钉住）。
      networkReadiness.attach(page);
      await page.goto(BASE + '/shop', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);

      ok('A1 网络观测能力在线（否则本测试无意义）', networkReadiness.compute(page) !== 'unknown', networkReadiness.compute(page));
      const watch = tools.armLandingWatch(page);
      ok('A2 动作前已取得「文档请求时刻」基线（导航发起信号可用）', watch.docReqAt > 0, watch.docReqAt);

      await prodClick(page, '#go');
      const landing = await tools.settleResultLanding(page, META, watch);
      ok('A3 落点窗口判定「导航已提交」', landing.navigated === true, landing);
      ok('A4 落点后 page.url() 已是新文档', page.url().indexOf('/signup') >= 0, page.url());

      // 生产链路：落点 → 观察（不是观察 → 落点）
      const after = await tools.observeAfterClick(page, META);
      ok('A5 after 观察交付新 URL', !!(after && String(after.url || '').indexOf('/signup') >= 0), after && after.url);

      const vUrl = verification.verify({ type: 'url_contains', expect: '/signup' }, after, { url: BASE + '/shop' });
      ok('A6 判据 url_contains "/signup" 由假失败转真成功', vUrl.success === true, vUrl);
      await page.close();
    }

    // =========================================================================
    section('B revert 咬：旧行为（仅 300ms 固定等）在同一夹具上必须变红');
    {
      const page = await ctx.newPage();
      networkReadiness.attach(page);
      await page.goto(BASE + '/shop', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);

      await prodClick(page, '#go');
      // 旧行为 —— tools.js 修复前 click 分支的全部等待：
      await page.waitForTimeout(300);
      ok('B1 旧行为下 300ms 后仍是旧文档（= 现场读到的旧 URL）', page.url().indexOf('/signup') < 0, page.url());

      const after = await tools.observeAfterClick(page, META);
      const vUrl = verification.verify({ type: 'url_contains', expect: '/signup' }, after, { url: BASE + '/shop' });
      ok('B2 旧行为下 url_contains "/signup" 判失败（复现真实假失败）', vUrl.success === false, vUrl);
      await page.close();
    }

    // =========================================================================
    section('C 代价：不导航的 click 不得被拖满超时');
    {
      const page = await ctx.newPage();
      networkReadiness.attach(page);
      await page.goto(BASE + '/shop', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);

      const watch = tools.armLandingWatch(page);
      await prodClick(page, '#noop');
      const t0 = Date.now();
      const landing = await tools.settleResultLanding(page, META, watch);
      const ms = Date.now() - t0;
      ok('C1 不导航 ⇒ navigated=false（不冒充已落点）', landing.navigated === false, landing);
      ok('C2 只付「发起检测窗」而非「提交等待窗」（< 1200ms）', ms < 1200, ms + 'ms');
      ok('C3 页面仍在原文档（等待不得改写状态）', page.url().indexOf('/shop') >= 0, page.url());
      await page.close();
    }
  } finally {
    await browser.close().catch(() => {});
    srv.close();
  }

  // =========================================================================
  section('D 静默降级：等待能力缺失 / 全部失败时必须有限返回、绝不阻断');
  {
    // D1–D3：waitForLoadState 恒抛（SPA 长轮询 / 能力异常）
    const p1 = {
      isClosed: () => false, url: () => 'http://x/', mainFrame: () => ({}),
      waitForLoadState: async () => { throw new Error('stub: 网络永不空闲'); },
      waitForTimeout: async () => {},
    };
    let thrown = null, out = null;
    const t0 = Date.now();
    try { out = await tools.settleResultLanding(p1, META, { docReqAt: 0, commitP: Promise.resolve(false) }); }
    catch (e) { thrown = e; }
    const ms1 = Date.now() - t0;
    ok('D1 全部等待失败 ⇒ 不抛错', !thrown, thrown && thrown.message);
    ok('D2 仍返回结构且 landed=false（不冒充成功）', !!out && out.landed === false && out.navigated === false && out.idle === false, out);
    ok('D3 有界返回（< 3000ms）', ms1 < 3000, ms1 + 'ms');

    // D4：完全没有等待能力
    const p2 = { isClosed: () => false, url: () => 'http://x/' };
    thrown = null; out = null;
    try { out = await tools.settleResultLanding(p2, META, { docReqAt: 0, commitP: Promise.resolve(true) }); }
    catch (e) { thrown = e; }
    ok('D4 无等待能力 ⇒ 不抛错且返回结构', !thrown && !!out, thrown && thrown.message);

    // D5：page 缺失（极端）—— 不得抛
    thrown = null; out = null;
    try { out = await tools.settleResultLanding(null, META, null); }
    catch (e) { thrown = e; }
    ok('D5 page 缺失 ⇒ 不抛错且返回结构', !thrown && !!out && out.landed === false, thrown && thrown.message);

    // D6：watch 缺失（未武装，如非 click 路径误用）—— 仍不得抛
    thrown = null; out = null;
    try { out = await tools.settleResultLanding(p1, META, null); }
    catch (e) { thrown = e; }
    ok('D6 未武装 watch ⇒ 不抛错且返回结构', !thrown && !!out, thrown && thrown.message);

    // D7：armLandingWatch 对无 waitForEvent 能力的 page 必须安全降级（commitP=null，不抛）
    let arm = null; thrown = null;
    try { arm = tools.armLandingWatch(p2); } catch (e) { thrown = e; }
    ok('D7 armLandingWatch 对弱能力 page 安全降级', !thrown && !!arm && arm.commitP === null, thrown && thrown.message);

    // D8：armLandingWatch(null) 不得抛
    thrown = null;
    try { tools.armLandingWatch(null); } catch (e) { thrown = e; }
    ok('D8 armLandingWatch(null) 不抛错', !thrown, thrown && thrown.message);
  }

  // =========================================================================
  section('E 接线与位置唯一性（源码级）');
  {
    const SRC = stripComments(read('server/agent/tools.js'));

    // 「等加载状态」的**每一次**调用都必须落在 settleResultLanding 内 —— 这才是
    // 「落点窗口只有一处实现」的准确口径（该函数内部合法地等两次：新文档解析 + 网络稳态）。
    const iFn = SRC.indexOf('async function settleResultLanding');
    const iNextFn = SRC.indexOf('function isActionableControl', iFn);
    const callIdx = [];
    for (let i = SRC.indexOf('page.waitForLoadState('); i >= 0; i = SRC.indexOf('page.waitForLoadState(', i + 1)) callIdx.push(i);
    ok('E1 至少存在一处落点窗口等待', callIdx.length >= 1, callIdx.length);
    ok('E2 全部落在 settleResultLanding 内（分支里零调用 = 无第二份实现）',
      iFn >= 0 && iNextFn > iFn && callIdx.every((i) => i > iFn && i < iNextFn),
      { iFn, iNextFn, callIdx });
    const iUseDoc = SRC.indexOf("page.waitForLoadState('domcontentloaded'");
    ok('E2b 其中包含「等新文档解析」（提交后才有效的那个）', iUseDoc > iFn && iUseDoc < iNextFn, iUseDoc);

    const iClick = SRC.indexOf("case 'click':");
    const iHover = SRC.indexOf("case 'hover':", iClick);
    const clickSeg = SRC.slice(iClick, iHover);
    ok('E2c click 分支内零等待加载状态调用', clickSeg.indexOf('waitForLoadState') < 0, '');

    const posArm = clickSeg.indexOf('armLandingWatch(page)');
    const posClickOp = clickSeg.indexOf("withBrowserOp('click', page");
    const posSettle = clickSeg.indexOf('settleResultLanding(page, meta, landingWatch)');
    const posObserve = clickSeg.indexOf('observeAfterClick(page, meta)');
    ok('E3 click 分支：武装在点击**之前**（否则会漏掉已提交的导航）', posArm >= 0 && posArm < posClickOp, { posArm, posClickOp });
    ok('E4 click 分支：落点在观察**之前**（先落点再观察）', posSettle >= 0 && posSettle < posObserve, { posSettle, posObserve });

    const iSub = SRC.indexOf("case 'submit':");
    const iDefault = SRC.indexOf('    default:', iSub);
    const subSeg = SRC.slice(iSub, iDefault);
    ok('E5 submit 族内零等待加载状态调用（已委托唯一实现）', subSeg.indexOf('waitForLoadState') < 0, '');
    const subArm = subSeg.indexOf('armLandingWatch(page)');
    const subClickOp = subSeg.indexOf("withBrowserOp('action.click', page");
    ok('E6 submit 族：武装同样在点击之前', subArm >= 0 && subArm < subClickOp, { subArm, subClickOp });
    ok('E7 submit 族已委托唯一实现', subSeg.indexOf('settleResultLanding(page, meta, landingWatch)') >= 0, '');
    // 口径：只看 submit 族那一段。'action.wait' 在业务动作族（purchase/payment 等）里
    // 仍然合法存在 —— 那是另一条分支，C172 未改；整文件级断言会误报（首版即踩）。
    ok('E8 旧内联副本的标签在本分支已消失',
      subSeg.indexOf("'action.land'") < 0 && subSeg.indexOf("'action.wait'") < 0, '');
    ok('E9 landed 字段语义保留（phase9_gate_replay 读 result.landed）', /landed:\s*landing\.landed/.test(subSeg), '');
  }

  // =========================================================================
  section('F 不放宽：落点窗口只改「何时观察」，不产生任何证据');
  {
    const SRC = stripComments(read('server/agent/tools.js'));
    const iFn = SRC.indexOf('function armLandingWatch');
    const iEnd = SRC.indexOf('function isActionableControl', iFn);
    const body = SRC.slice(iFn, iEnd);
    ok('F1 不产生元素 / 文本证据', !/observation\.inspect/.test(body) && !/textSummary|visibleText|contentLeaves/.test(body), '');
    ok('F2 不伪造成功（无 success:true）', !/success\s*:\s*true/.test(body), '');
    ok('F3 返回键恰为 started/navigated/idle/landed 四个布尔', /return\s*\{\s*started,\s*navigated,\s*idle,\s*landed:/.test(body), '');
    ok('F4 未触碰 P2 恒真守卫（invalidEvidence 不在本批改动面）', SRC.indexOf('invalidEvidence') < 0, '');
    ok('F5 未放宽 CONTEXT_NOT_READY 闸门（未改动 contextGuard）', stripComments(read('server/agent/contextGuard.js')).indexOf('CONTEXT_NOT_READY') >= 0, '');
  }

  console.log('\n结果: ' + pass + ' passed / ' + fail + ' failed');
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
