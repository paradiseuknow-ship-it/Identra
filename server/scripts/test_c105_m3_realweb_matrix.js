'use strict';
// C105 M3 — REAL-WEB fixture 矩阵（Test A–J + Negative Test）
//
// 目的：把 M1/M2 的修复面从「单元契约」拉到「真实浏览器行为面」上固化，并回答
// 规格 §Negative Test 的核心问题：Agent 能不能「不点击」。
// 手段：本地 http server 提供 fixture 页面 + 真实 Chromium + observation.inspect
//       （真 bbox / 真 elementFromPoint），不做任何 mock 替身。
//
// 用法：node server/scripts/test_c105_m3_realweb_matrix.js
const http = require('http');
const assert = require('assert');
const { chromium } = require('playwright');
const observation = require('../agent/observation');
const semanticResolver = require('../agent/semanticResolver');
const verification = require('../agent/verification');

// ─────────────────────────── fixture 页面（Test A–J）───────────────────────────
const PAGES = {
  // A：C105 主诉现场复刻 —— 法语落地页，导航菜单 button"Plateforme"在 DOM 中排在
  //    真实 CTA（右上角 a#continue-nav "Commencez gratuitement"）之前。
  '/a-fr-cta': [
    '<!doctype html><html lang="fr"><body>',
    '<nav><button id="dropdown_toggle_0" class="nav-link cc-dropdown-btn">Plateforme</button>',
    '<button id="dropdown_toggle_1" class="nav-link cc-dropdown-btn">Solutions</button>',
    '<a href="/pricing" class="nav-link">Tarifs</a></nav>',
    '<header style="text-align:right">',
    '<a id="continue-nav" href="/signup" class="btn w-button">Commencez gratuitement</a>',
    '</header></body></html>',
  ].join('\n'),

  // B：中文多语言同构场景 —— 导航项与 CTA 用不同措辞，验证跨语言下仍锚定真实 CTA。
  '/b-zh-cta': [
    '<!doctype html><html lang="zh"><body>',
    '<nav><button id="nav-platform" class="menu">平台功能</button>',
    '<button id="nav-price" class="menu">价格方案</button></nav>',
    '<main><h1>建站从未如此简单</h1>',
    '<button id="cta-start-cn" class="primary">免费开始</button></main></body></html>',
  ].join('\n'),

  // C：Negative Test —— CTA 被全屏 cookie/营销 overlay 完全覆盖。
  //    正确行为：不把被遮挡的 CTA 当作可用目标（点了也是打在遮挡层上）。
  '/c-overlay': [
    '<!doctype html><html><body>',
    '<button id="cta-start" style="margin:40px">开始注册</button>',
    '<div id="cookie-overlay" style="position:fixed;left:0;top:0;width:100%;height:100%;',
    'z-index:9999;background:rgba(0,0,0,0.5)"></div></body></html>',
  ].join('\n'),

  // D：延时挂载 —— 按钮 3s 后才出现。快照缺失 ≠ 永久不存在（M1 F2 实证教训固化）。
  '/d-delayed': [
    '<!doctype html><html><body><div id="host"></div>',
    '<script>setTimeout(function(){var b=document.createElement("button");',
    'b.id="delayed-btn";b.textContent="Continue";document.getElementById("host").appendChild(b);},3000);</script>',
    '</body></html>',
  ].join('\n'),

  // E：零面积隐藏控件（F7）—— 与真实控件同语义，但 w/h = 0，点了没有任何效果。
  '/e-zero-area': [
    '<!doctype html><html><body>',
    '<form><label for="real-email">邮箱</label>',
    '<input id="real-email" name="email" placeholder="邮箱"></form>',
    '<input id="ghost-email" name="email" placeholder="邮箱"',
    ' style="width:0;height:0;padding:0;border:0;overflow:hidden">',
    '</body></html>',
  ].join('\n'),

  // E2：只有一个零面积控件（无替代）—— 验证「全阻断回落」不静默返回空。
  '/e2-zero-only': [
    '<!doctype html><html><body>',
    '<input id="only-ghost" name="email" placeholder="邮箱"',
    ' style="width:0;height:0;padding:0;border:0;overflow:hidden">',
    '</body></html>',
  ].join('\n'),

  // G：无文本 icon button，语义只存在于 data-testid（M2 回归）。
  '/g-testid': [
    '<!doctype html><html><body>',
    '<button id="icon-submit" data-testid="submit-order"><svg viewBox="0 0 24 24"></svg></button>',
    '<button id="nav-menu">菜单</button></body></html>',
  ].join('\n'),

  // H：无文本锚点（图标链接），身份只在 href 上（M2 href pathname + M3 语义池）。
  //    注意 img 必须给真实尺寸：1x1 透明 gif 会让 inline <a> 的 rect 宽度为 0，
  //    被 observation 的 isVisible 过滤掉（实测 w=0,h=21）—— 那是 fixture 失真，不是产品缺陷。
  '/h-href': [
    '<!doctype html><html><body>',
    '<a href="/signup?utm=x"><img alt="" width="24" height="24" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a>',
    '<a href="/pricing">Tarifs</a></body></html>',
  ].join('\n'),

  // I：目标在首屏视口外（offscreen）—— scroll 后仍可点，不得被否决（防 M1 F2 覆辙）。
  '/i-offscreen': [
    '<!doctype html><html><body>',
    '<div style="height:2500px">scroll down</div>',
    '<button id="far-below">立即购买</button></body></html>',
  ].join('\n'),

  // J：同语义双按钮，一个被 fixed 层覆盖、一个干净 —— 干净者必须胜出。
  '/j-occluded-vs-clean': [
    '<!doctype html><html><body>',
    '<button id="buy-blocked">立即购买</button>',
    '<div style="position:fixed;left:0;top:0;width:100%;height:220px;z-index:99;background:#000"></div>',
    '<div style="height:400px"></div>',
    '<button id="buy-clean">立即购买</button></body></html>',
  ].join('\n'),
};

let pass = 0, fail = 0;
const rows = [];
function rec(name, ok, detail) {
  if (ok) pass++; else fail++;
  rows.push((ok ? 'PASS' : 'FAIL') + ' | ' + name + ' | ' + detail);
}
function check(name, fn, detail) {
  try { fn(); rec(name, true, detail || ''); }
  catch (e) { rec(name, false, (detail ? detail + ' || ' : '') + (e && e.message)); }
}
const top = (c) => (c && c[0]) || null;
const idOf = (c) => (top(c) && (top(c).elementId || top(c).selector)) || '(none)';

(async () => {
  const server = http.createServer((req, res) => {
    const p = String(req.url || '/').split('?')[0];
    const html = PAGES[p];
    if (!html) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true });

  const inspectAt = async (path) => {
    const page = await browser.newPage();
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
    const insp = await observation.inspect(page, { taskId: 'm3' });
    return { page, obs: insp.observation };
  };

  try {
    // ── Test A：法语落地页 CTA 定位（C105 D-A 回归）──
    {
      const { page, obs } = await inspectAt('/a-fr-cta');
      const c = semanticResolver.resolve({ semantic: 'Commencez gratuitement' }, obs);
      check('A1 法语 CTA 命中真实入口 a#continue-nav', () => {
        assert.strictEqual(top(c) && top(c).elementId, 'continue-nav', 'got ' + idOf(c));
      });
      check('A2 不得误点导航菜单 button#dropdown_toggle_0 (Plateforme)', () => {
        const ids = c.map((x) => x.elementId);
        assert.ok(ids.indexOf('dropdown_toggle_0') < 0, '候选里出现了 Plateforme: ' + ids.join(','));
      });
      check('A3 法语页零词法关联的英文语义不臆造目标（跨语言拒点）', () => {
        // 用与页面任何身份信号（text/cls/id/href）都无 token 交集的英文短语。
        // 注意 'signup' 会命中 href=/signup —— 那是**正确**行为（A4 显式固化）。
        const c2 = semanticResolver.resolve({ semantic: 'register account now' }, obs);
        assert.strictEqual(c2.length, 0, '零关联英文语义应无候选，got ' + idOf(c2));
      });
      check('A4 href 是语言中立信号：英文 semantic=signup 命中法语页 CTA', () => {
        const c3 = semanticResolver.resolve({ semantic: 'signup' }, obs);
        assert.strictEqual(top(c3) && top(c3).elementId, 'continue-nav', 'got ' + idOf(c3));
      });
      await page.close();
    }

    // ── Test B：中文多语言锚定 ──
    {
      const { page, obs } = await inspectAt('/b-zh-cta');
      const c = semanticResolver.resolve({ semantic: '免费开始' }, obs);
      check('B1 中文 CTA 命中 #cta-start-cn', () => {
        assert.strictEqual(top(c) && top(c).elementId, 'cta-start-cn', 'got ' + idOf(c));
      });
      check('B2 不得误点导航项 #nav-platform', () => {
        assert.ok(c.map((x) => x.elementId).indexOf('nav-platform') < 0, '命中了导航项');
      });
      await page.close();
    }

    // ── Test C：Negative Test —— 被 overlay 完全遮挡时不点击 ──
    {
      const { page, obs } = await inspectAt('/c-overlay');
      const c = semanticResolver.resolve({ semantic: '开始注册' }, obs);
      check('C1 被全屏 overlay 遮挡的 CTA 不得作为可用目标', () => {
        const t = top(c);
        assert.ok(!t || t.blockedBy === 'occluded', 'got ' + idOf(c) + ' blockedBy=' + (t && t.blockedBy));
      });
      check('C2 存在性通道仍能看见该元素（点不到 ≠ 不存在）', () => {
        const c2 = semanticResolver.resolve({ semantic: '开始注册' }, obs, { requireActionable: false });
        assert.strictEqual(top(c2) && top(c2).elementId, 'cta-start', 'got ' + idOf(c2));
      });
      check('C3 observation 标记 occluded=true 且 bbox 非零面积', () => {
        const el = obs.elements.filter((e) => e.id === 'cta-start')[0];
        assert.ok(el, '观察中缺少 cta-start');
        assert.strictEqual(el.occluded, true, 'occluded 应为 true，got ' + el.hitTest);
        assert.ok(el.bbox.w > 0 && el.bbox.h > 0, 'bbox 不应为零面积');
      });
      await page.close();
    }

    // ── Test D：延时挂载（首次缺失 ≠ 永久缺失）──
    {
      const page = await browser.newPage();
      await page.goto(BASE + '/d-delayed', { waitUntil: 'domcontentloaded' });
      const before = (await observation.inspect(page, { taskId: 'm3' })).observation;
      const c0 = semanticResolver.resolve({ semantic: 'Continue' }, before);
      await page.waitForTimeout(3600);
      const after = (await observation.inspect(page, { taskId: 'm3' })).observation;
      const c1 = semanticResolver.resolve({ semantic: 'Continue' }, after);
      check('D1 按钮挂载前无候选（快照真实反映当时状态）', () => {
        assert.strictEqual(c0.length, 0, '挂载前不应有候选，got ' + idOf(c0));
      });
      check('D2 挂载后解析成功命中 #delayed-btn（不被误判为永久缺失）', () => {
        assert.strictEqual(top(c1) && top(c1).elementId, 'delayed-btn', 'got ' + idOf(c1));
      });
      await page.close();
    }

    // ── Test E：零面积控件（F7）──
    {
      const { page, obs } = await inspectAt('/e-zero-area');
      const c = semanticResolver.resolve({ field: 'email' }, obs);
      check('E1 零面积隐藏控件不得胜出', () => {
        assert.notStrictEqual(top(c) && top(c).elementId, 'ghost-email', '选中了零面积控件');
      });
      check('E2 正常控件命中 #real-email', () => {
        assert.strictEqual(top(c) && top(c).elementId, 'real-email', 'got ' + idOf(c));
      });
      await page.close();
    }
    {
      // 浏览器面：零面积元素在 observation 层就被 isVisible（w>0&&h>0）挡在候选池外，
      // 所以 resolver 侧看到的是「没有这个元素」—— 这是第一道防线，不是 F7 的作用点。
      const { page, obs } = await inspectAt('/e2-zero-only');
      const c = semanticResolver.resolve({ field: 'email' }, obs);
      check('E3 零面积元素不进观察候选池（isVisible 第一道防线）', () => {
        assert.strictEqual(c.length, 0, '应是空候选，got ' + idOf(c));
        assert.ok(obs.elements.every((e) => e.id !== 'only-ghost'), '零面积元素不该出现在观察里');
      });
      await page.close();
    }
    {
      // 单元面：F7 守卫的真实作用点是非 observation 来源的元素（elementMemory 快照、
      // replan 合成 target、跨 frame 元素），此时 bbox 可能带零面积而 isVisible 没跑过。
      // 「全阻断回落」必须保留候选并打标记，不能静默返回空（空集会被误读成元素不存在）。
      const manualObs = {
        url: 'http://x.local/', title: '', textSummary: '', visibleText: '',
        elements: [{
          id: 'only-ghost', tag: 'input', type: 'email', role: 'textbox', name: 'email',
          placeholder: '邮箱', text: '邮箱', cls: null, ariaLabel: null, label: null,
          visible: true, bbox: { x: 0, y: 0, w: 0, h: 0 }, boundingBox: { x: 0, y: 0, w: 0, h: 0 },
        }],
      };
      const c = semanticResolver.resolve({ field: 'email' }, manualObs);
      check('E4 F7 守卫：唯一候选零面积时回落并打 blockedBy=zero-area', () => {
        const t = top(c);
        assert.ok(t && t.blockedBy === 'zero-area', 'got ' + idOf(c) + ' blockedBy=' + (t && t.blockedBy));
      });
    }

    // ── Test F：联盟参数污染 URL 验证（F3 回归，纯逻辑面）──
    {
      const v = { type: 'url_contains', expect: 'webflow.com' };
      const r1 = verification.verify(v,
        { url: 'https://webflow.com/signup?ref=a' },
        { url: 'https://example.com/landing?pscd=try.webflow.com' });
      check('F1 query 注入 pscd=try.webflow.com 不再误判恒真', () => {
        assert.strictEqual(r1.invalidEvidence, undefined, '不应判 precondition_true');
        assert.strictEqual(r1.success, true, '真导航应判成功');
      });
      const r2 = verification.verify(v,
        { url: 'https://webflow.com/signup?ref=a' },
        { url: 'https://webflow.com/signup?ref=a' });
      check('F2 真恒真（before/after 同表面）仍判 precondition_true', () => {
        assert.strictEqual(r2.invalidEvidence, 'precondition_true', 'got ' + r2.invalidEvidence);
      });
      const r3 = verification.verify(v,
        { url: 'https://webflow.com/signup' },
        { url: 'https://try.webflow.com/t0wz830c5n4y' });
      check('F3 已知边界固化：子域 host(try.webflow.com) 仍被子串命中判恒真', () => {
        assert.strictEqual(r3.invalidEvidence, 'precondition_true', 'got ' + r3.invalidEvidence);
      });
    }

    // ── Test G：data-testid icon button（M2 回归）──
    {
      const { page, obs } = await inspectAt('/g-testid');
      const c = semanticResolver.resolve({ semantic: 'submit' }, obs);
      check('G1 无文本 icon button 凭 data-testid 命中', () => {
        const t = top(c);
        assert.ok(t, '无候选');
        assert.strictEqual(t.elementId, 'icon-submit', 'got ' + idOf(c));
      });
      check('G2 selector 生成优先 data-testid', () => {
        assert.ok(/data-testid=/.test(top(c).selector), 'selector 未用 testid: ' + top(c).selector);
      });
      await page.close();
    }

    // ── Test H：无文本锚点 href 接地 ──
    {
      const { page, obs } = await inspectAt('/h-href');
      const c = semanticResolver.resolve({ semantic: 'signup' }, obs);
      check('H1 无文本锚点凭 href pathname 命中', () => {
        assert.ok(top(c), '无候选');
        assert.strictEqual(top(c).el && top(c).el.tag, 'a', '应命中锚点，got ' + idOf(c));
      });
      check('H2 selector 为 a[href*=pathname] 形态（query 已剥离）', () => {
        assert.ok(/a\[href\*="\/signup"\]/.test(top(c).selector), 'selector: ' + top(c).selector);
      });
      await page.close();
    }

    // ── Test I：视口外元素不得被否决（防 M1 F2 覆辙）──
    {
      const { page, obs } = await inspectAt('/i-offscreen');
      const c = semanticResolver.resolve({ semantic: '立即购买' }, obs);
      check('I1 offscreen 元素仍作为可用目标（scroll 后可点）', () => {
        const t = top(c);
        assert.ok(t && !t.blockedBy, '被误否决 blockedBy=' + (t && t.blockedBy));
        assert.strictEqual(t.elementId, 'far-below', 'got ' + idOf(c));
      });
      check('I2 observation hitTest=offscreen 且未被标记 occluded', () => {
        const el = obs.elements.filter((e) => e.id === 'far-below')[0];
        assert.ok(el, '观察中缺少 far-below');
        assert.strictEqual(el.hitTest, 'offscreen', 'got ' + el.hitTest);
        assert.notStrictEqual(el.occluded, true, 'offscreen 不得判 occluded');
      });
      await page.close();
    }

    // ── Test J：遮挡 vs 干净同语义，干净者胜出 ──
    {
      const { page, obs } = await inspectAt('/j-occluded-vs-clean');
      const c = semanticResolver.resolve({ semantic: '立即购买' }, obs);
      check('J1 同语义下未遮挡按钮胜出', () => {
        assert.strictEqual(top(c) && top(c).elementId, 'buy-clean', 'got ' + idOf(c));
      });
      check('J2 被遮挡同语义按钮被阻断（带 blockedBy 标记）', () => {
        const blockedOne = c.filter((x) => x.elementId === 'buy-blocked')[0];
        assert.ok(!blockedOne || blockedOne.blockedBy === 'occluded',
          '遮挡项未标记: ' + JSON.stringify(blockedOne && blockedOne.blockedBy));
      });
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log('C105 M3 REAL-WEB fixture 矩阵（Test A–J + Negative）');
  console.log('================================================================');
  rows.forEach((r) => console.log((r.indexOf('PASS') === 0 ? '✅ ' : '❌ ') + r));
  console.log('================================================================');
  console.log('PASS: ' + pass + ' / FAIL: ' + fail);
  console.log('注：F3 为已知边界固化断言（子域 host 子串命中），非缺陷放行。');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(2); });
