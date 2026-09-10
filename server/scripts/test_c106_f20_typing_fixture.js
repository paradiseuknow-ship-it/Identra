'use strict';
// C106 F20 — 【真实浏览器 fixture】人类化输入端到端守护。
//
// 真实站点实证（用户观察 + 任务取证）：
//   注册第一步输入邮箱时「输入太快 → 界面刷新 → 只输了一小部分 → 页面又刷新
//   → 又把密码输入到邮箱里」。对应三个工程缺陷：
//     F20-a 注入节奏 60ms/字符（≈17 字符/秒），人类是 150–250ms/字符
//     F20-b 输入前不等字段稳定，撞上受控组件 re-render 窗口
//     F20-c fill 后从不回读校验 → 只进去几个字符也判 SUCCESS
//
// 覆盖场景（真实 Chromium + 真实 observation + 真实 tools）：
//   A 节奏：常规长度值确实是逐字符注入（耗时证明不是瞬时填充），且回读一致
//   B 核心：受控组件 re-render 重建 input → 焦点丢失 → 守卫补录后值完整
//   C 对照：关掉守卫后同一场景必然丢字符（证明是守卫在起作用，而非 fixture 不实）
//   D 死路：页面强制清空该字段 → 补录无效 → fail-loud FILL_VALUE_MISMATCH（不得静默成功）
//   E 格式化：前端给卡号插空格 → 非敏感字段宽松放行，不误报
//   F 长值：>120 字符降级整体赋值（对应人类粘贴），不击穿超时

const http = require('http');
const { chromium } = require('playwright');
const tools = require('../agent/tools');
const browserManager = require('../browserManager');
const { listenSafe } = require('./lib_safe_port');

const PAGES = {
  // A：普通表单（无干扰）
  '/plain': [
    '<!doctype html><html><body><form action="#">',
    '<input id="email" name="email" type="email" placeholder="Email">',
    '<button id="save" type="submit">Save</button>',
    '</form></body></html>',
  ].join('\n'),

  // B/C：模拟 React 受控组件 —— 输入到第 5 个字符时 re-render 并**重建 input 节点**，
  // 且不重新聚焦 → 后续字符全部打到 body（这正是用户看到的「只输了一小部分」）。
  '/controlled': [
    '<!doctype html><html><body><form action="#">',
    '<input id="email" name="email" type="email" placeholder="Email">',
    '<button id="save" type="submit">Save</button>',
    '</form>',
    '<script>',
    'window.__rebuilds = 0;',
    "document.addEventListener('input', function (e) {",
    "  if (e.target.id !== 'email') return;",
    '  if (e.target.value.length === 5 && window.__rebuilds < 1) {',
    '    window.__rebuilds++;',
    '    var old = e.target;',
    '    var neu = document.createElement("input");',
    "    neu.id = old.id; neu.name = old.name; neu.type = old.type; neu.placeholder = old.placeholder;",
    '    neu.value = old.value;',
    '    old.parentNode.replaceChild(neu, old);',
    '    /* 刻意不重新聚焦：真实框架 re-render 换节点时焦点就是这样丢的 */',
    '  }',
    '}, true);',
    '</script></body></html>',
  ].join('\n'),

  // D：页面持续清空该字段（模拟校验失败重置 / 步骤切换）→ 补录也留不住
  '/wipe': [
    '<!doctype html><html><body><form action="#">',
    '<input id="email" name="email" type="email" placeholder="Email">',
    '</form>',
    '<script>',
    "document.addEventListener('input', function (e) {",
    "  if (e.target.id === 'email') setTimeout(function () { e.target.value = ''; }, 0);",
    '}, true);',
    '</script></body></html>',
  ].join('\n'),

  // E：前端自动格式化（每 4 位插空格）——真人输入也会被格式化
  '/format': [
    '<!doctype html><html><body><form action="#">',
    '<input id="phone" name="phone" type="tel" placeholder="Phone">',
    '</form>',
    '<script>',
    "document.addEventListener('input', function (e) {",
    "  if (e.target.id !== 'phone') return;",
    "  var v = e.target.value.replace(/\\s/g, '');",
    "  if (v.length > 4) e.target.value = v.slice(0, 4) + ' ' + v.slice(4);",
    '}, true);',
    '</script></body></html>',
  ].join('\n'),
};

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('✅ PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('❌ FAIL | ' + name + ' | ' + detail); }
}

function server() {
  return http.createServer((req, res) => {
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
  const page = await ctx.newPage();
  const meta = () => ({ taskId: 't_c106_f20' });

  // ---------- A 节奏 + 回读一致 ----------
  await page.goto(BASE + '/plain', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(200);
  {
    const val = 'user@example.com'; // 16 字符
    const t0 = Date.now();
    const rA = await tools.runTool({ type: 'fill', target: { field: 'email' }, value: val }, { page }, meta());
    const elapsed = Date.now() - t0;
    const got = await page.inputValue('#email');
    check('A1 fill 成功', !!(rA && rA.success), 'success=' + (rA && rA.success) + ' err=' + (rA && rA.error ? String(rA.error.code || rA.error.message).slice(0, 90) : ''));
    check('A2 回读值完全一致', got === val, JSON.stringify(got));
    // 16 字符 × 人类节奏地板 25ms = 400ms；瞬时填充 < 100ms → 这条能抓住「退化成瞬时」
    check('A3 逐字符注入（耗时证明不是瞬时填充）', elapsed >= 400, elapsed + 'ms for ' + val.length + ' chars');
  }

  // ---------- B 核心：re-render 换节点导致焦点丢失 → 守卫补录后值完整 ----------
  await page.goto(BASE + '/controlled', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(200);
  {
    const val = 'user@example.com';
    const rB = await tools.runTool({ type: 'fill', target: { field: 'email' }, value: val }, { page }, meta());
    const got = await page.inputValue('#email');
    const rebuilds = await page.evaluate(() => window.__rebuilds);
    check('B1 页面确实发生过 re-render 重建（fixture 生效）', rebuilds === 1, 'rebuilds=' + rebuilds);
    check('B2 焦点丢失后守卫补录 → 值完整（核心）', got === val, JSON.stringify(got));
    check('B3 未误报失败', !!(rB && rB.success), 'success=' + (rB && rB.success) + ' err=' + (rB && rB.error ? String(rB.error.code).slice(0, 60) : ''));
  }

  // ---------- C 对照：关掉守卫 → 必然丢字符（证明 B 是守卫的功劳）----------
  await page.goto(BASE + '/controlled', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(200);
  {
    const val = 'user@example.com';
    await browserManager.humanType(page, '#email', val, { focusGuard: false, baseDelay: 10, randomDelay: 5 });
    const got = await page.inputValue('#email');
    check('C1 无守卫时字符确实丢失（对照组，复现用户看到的现象）', got !== val && got.length < val.length, JSON.stringify(got));
  }

  // ---------- D 死路：字段被页面持续清空 → fail-loud，不得静默成功 ----------
  await page.goto(BASE + '/wipe', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(200);
  {
    const rD = await tools.runTool({ type: 'fill', target: { field: 'email' }, value: 'user@example.com' }, { page }, meta());
    const code = rD && rD.error && (rD.error.code || rD.error);
    check('D1 值留不住时判失败（不静默 SUCCESS）', !(rD && rD.success), 'success=' + (rD && rD.success));
    check('D2 失败码为 FILL_VALUE_MISMATCH', String(code) === 'FILL_VALUE_MISMATCH', String(code).slice(0, 80));
  }

  // ---------- E 格式化：非敏感字段宽松放行 ----------
  await page.goto(BASE + '/format', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(200);
  {
    const rE = await tools.runTool({ type: 'fill', target: { field: 'phone' }, value: '41111111' }, { page }, meta());
    check('E1 前端格式化插入空格 → 不误报失败', !!(rE && rE.success), 'success=' + (rE && rE.success) + ' err=' + (rE && rE.error ? String(rE.error.code).slice(0, 60) : ''));
  }

  // ---------- F 长值：降级整体赋值，不击穿超时 ----------
  await page.goto(BASE + '/plain', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(200);
  {
    const long = 'x'.repeat(400);
    const t0 = Date.now();
    const rF = await tools.runTool({ type: 'fill', target: { field: 'email' }, value: long }, { page }, meta());
    const elapsed = Date.now() - t0;
    const got = await page.inputValue('#email');
    check('F1 超长值写入成功', got === long, 'len=' + String(got || '').length);
    check('F2 超长值不逐字符（耗时受控，不击穿 25s 超时）', elapsed < 12000, elapsed + 'ms');
    check('F3 长值通道不影响成功判定', !!(rF && rF.success), 'success=' + (rF && rF.success));
  }

  await browser.close();
  srv.close();
  console.log('\n结果: ' + pass + ' passed / ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e && e.message); process.exit(1); });
