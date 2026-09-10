'use strict';
/**
 * PHASE 17-A / P0-A —— Credential Safety Boundary【真实浏览器 fixture】。
 *
 * 目的：证明「真正执行到了 Credential Safety Gate」，而不是只测 helper function。
 * 全部用例走真实 Chromium + 真实 tools.runTool（与生产同一条 fill 路径）。
 *
 * 真实跨域构造（与 F21 fixture 同法）：
 *   主站 srvA 绑 127.0.0.1:portA，第三方站 srvB 绑 127.0.0.1:portB
 *   —— 端口不同即 origin 不同（URL.origin 语义），等价于真实的「目标域 vs 第三方域」；
 *   另用 localhost:portA 作为「另一个注册域」（非子域关系）验证 A2。
 *
 * 覆盖：A1 同域放行 / A2 跨注册域禁止 / A3(R6) 第三方 OAuth 面禁止 /
 *       A4 同源 iframe 放行 / A5 跨 origin iframe 禁止 / A7 上下文缺失 fail closed /
 *       A8 挑战页禁止 / N1 非凭据字段不受影响。
 */

const http = require('http');
const { chromium } = require('playwright');
const tools = require('../agent/tools');
const taskManager = require('../agent/taskManager');
const { listenSafe } = require('./lib_safe_port');

const MAIN = [
  '<!doctype html><html><body><form action="#">',
  '<input id="email" name="email" type="email" placeholder="Email">',
  '<input id="search" name="search" type="text" placeholder="Search">',
  '<button id="save" type="submit">Save</button>',
  '</form></body></html>',
].join('\n');

const INNER = [
  '<!doctype html><html><body><form action="#">',
  '<input id="email" name="email" type="email" placeholder="Email">',
  '</form></body></html>',
].join('\n');

const CHALLENGE = [
  '<!doctype html><html><body>',
  '<h1>Confirm you are not a bot</h1>',
  '<p>Before we continue, press and hold the button to confirm you are human.</p>',
  '<script src="https://js.px-cloud.net/x.js"></script>',
  '<form action="#"><input id="email" name="email" type="email" placeholder="Email"></form>',
  '</body></html>',
].join('\n');

const framePage = (src) => [
  '<!doctype html><html><body>',
  '<iframe id="fr" name="fr" src="' + src + '" width="400" height="200"></iframe>',
  '</body></html>',
].join('\n');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + detail); }
}
const codeOf = (r) => (r && r.error && r.error.code) || null;
const msgOf = (r) => String((r && r.error && r.error.message) || '');

function upsert(targetUrl) {
  const created = taskManager.createTask({
    name: 'c107 credential boundary fixture',
    objective: 'credential authorization gate',
    targetUrl,
    status: 'RUNNING',
    executionMode: 'ASSIST',
    profileId: null,
    policy: {},
    budget: {},
    constraints: [],
    secretRefs: [],
    createdBy: 'fixture',
  });
  return created.id;
}

(async () => {
  const srvA = http.createServer((req, res) => {
    const u = String(req.url || '/');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (u.indexOf('/inner') === 0) return res.end(INNER);
    if (u.indexOf('/frame-same') === 0) return res.end(framePage('/inner'));
    if (u.indexOf('/challenge') === 0) return res.end(CHALLENGE);
    return res.end(MAIN);
  });
  const srvB = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(INNER);
  });
  await listenSafe(srvA, '127.0.0.1');
  await listenSafe(srvB, '127.0.0.1');
  const portA = srvA.address().port;
  const portB = srvB.address().port;
  const A = 'http://127.0.0.1:' + portA + '/';
  const B = 'http://127.0.0.1:' + portB + '/';
  const OTHER_REGISTRABLE = 'http://localhost:' + portA + '/'; // 另一个注册域（非子域关系）

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const meta = (id) => ({ taskId: id, executionId: 'exe_' + id, stepId: 'step_001', attemptId: 'att_1' });
  const fillEmail = (id) => tools.runTool(
    { type: 'fill', target: { field: 'email', semantic: 'Email' }, value: 'user@example.com' },
    { page }, meta(id),
  );
  const val = () => page.evaluate(() => (document.getElementById('email') || {}).value);
  const frameVal = () => page.frame({ name: 'fr' })
    .evaluate(() => (document.getElementById('email') || {}).value);

  // ── A1 同 origin → 放行，值正常落盘 ────────────────────────────────
  {
    await page.goto(A, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    const id = upsert(A);
    const r = await fillEmail(id);
    check('A1 同 origin 凭据 fill 放行', codeOf(r) !== 'CREDENTIAL_ACTION_BLOCKED', 'code=' + codeOf(r) + ' msg=' + msgOf(r).slice(0, 120));
    const v = await val();
    check('A1b 值正常写入', String(v || '').indexOf('user@example.com') >= 0, 'value=' + JSON.stringify(v));
  }

  // ── A2 跨注册域（无显式授权）→ 禁止，且值未落盘 ─────────────────────
  {
    await page.goto(A, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    const id = upsert(OTHER_REGISTRABLE);
    const r = await fillEmail(id);
    check('A2 跨注册域未授权 → 拦截', codeOf(r) === 'CREDENTIAL_ACTION_BLOCKED', 'code=' + codeOf(r) + ' msg=' + msgOf(r).slice(0, 160));
    check('A2b 拒绝原因=ORIGIN_NOT_AUTHORIZED', /ORIGIN_NOT_AUTHORIZED/.test(msgOf(r)), msgOf(r).slice(0, 160));
    const v = await val();
    check('A2c 拦截后值未写入', v === '' || v === undefined, 'value=' + JSON.stringify(v));
  }

  // ── A3 / R6 复现：漂移到第三方 OAuth 登录域 → 禁止 ──────────────────
  {
    const oauthUrl = B + 'login?client_id=Iv1.abc&return_to=%2Flogin%2Foauth%2Fauthorize';
    await page.goto(oauthUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    const id = upsert(A); // 锚点是主站，当前页是第三方授权面
    const r = await fillEmail(id);
    check('A3 第三方 OAuth 面 → 拦截（R6 复现）', codeOf(r) === 'CREDENTIAL_ACTION_BLOCKED', 'code=' + codeOf(r) + ' msg=' + msgOf(r).slice(0, 160));
    check('A3b 拒绝原因=THIRD_PARTY_AUTH_SURFACE_UNAUTHORIZED', /THIRD_PARTY_AUTH_SURFACE_UNAUTHORIZED/.test(msgOf(r)), msgOf(r).slice(0, 160));
    const v = await val();
    check('A3c 凭据未落入第三方域输入框', v === '' || v === undefined, 'value=' + JSON.stringify(v));
    const t = taskManager.getTask(id);
    const blocks = (t && t.securityBlocks) || [];
    check('A3d 写入安全证据 task.securityBlocks', blocks.length > 0 && blocks[0].kind === 'CREDENTIAL_ACTION_BLOCKED',
      'blocks=' + JSON.stringify(blocks.slice(-1)));
  }

  // ── A4 同源 iframe → 放行 ──────────────────────────────────────────
  {
    await page.goto(A + 'frame-same', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    const id = upsert(A);
    const r = await tools.runTool(
      { type: 'fill', target: { field: 'email', selector: 'iframe >> #email' }, value: 'same-frame@example.com' },
      { page }, meta(id),
    );
    check('A4 同源 iframe 凭据 fill 放行', codeOf(r) !== 'CREDENTIAL_ACTION_BLOCKED', 'code=' + codeOf(r) + ' msg=' + msgOf(r).slice(0, 120));
    const v = await frameVal().catch(() => '<err>');
    check('A4b 值写入同源 iframe', String(v || '').indexOf('same-frame@example.com') >= 0, 'value=' + JSON.stringify(v));
  }

  // ── A5 跨 origin iframe → 禁止 ─────────────────────────────────────
  {
    await page.goto(A + 'frame-same', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    // 把 iframe 指向第三方 origin：元素所在文档与页面 origin 不同
    await page.evaluate((u) => { const f = document.getElementById('fr'); if (f) f.src = u; }, B + 'inner');
    await page.waitForTimeout(600);
    const id = upsert(A);
    const r = await tools.runTool(
      { type: 'fill', target: { field: 'email', selector: 'iframe >> #email' }, value: 'cross-frame@example.com' },
      { page }, meta(id),
    );
    check('A5 跨 origin iframe → 拦截', codeOf(r) === 'CREDENTIAL_ACTION_BLOCKED', 'code=' + codeOf(r) + ' msg=' + msgOf(r).slice(0, 160));
    check('A5b 拒绝原因=CROSS_ORIGIN_FRAME', /CROSS_ORIGIN_FRAME/.test(msgOf(r)), msgOf(r).slice(0, 160));
  }

  // ── A7 授权上下文缺失 → fail closed ────────────────────────────────
  {
    await page.goto(A, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    const id = upsert(''); // targetUrl 缺失
    const r = await fillEmail(id);
    check('A7 授权上下文缺失 → fail closed', codeOf(r) === 'CREDENTIAL_ACTION_BLOCKED' && /AUTHORIZATION_CONTEXT_MISSING/.test(msgOf(r)),
      'code=' + codeOf(r) + ' msg=' + msgOf(r).slice(0, 160));
    const v = await val();
    check('A7b fail closed 时值未写入', v === '' || v === undefined, 'value=' + JSON.stringify(v));
  }

  // ── A8 挑战页 → 禁止 ───────────────────────────────────────────────
  {
    await page.goto(A + 'challenge', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    const id = upsert(A);
    const r = await fillEmail(id);
    check('A8 挑战页 → 拦截', codeOf(r) === 'CREDENTIAL_ACTION_BLOCKED' && /SECURITY_CHALLENGE/.test(msgOf(r)),
      'code=' + codeOf(r) + ' msg=' + msgOf(r).slice(0, 160));
  }

  // ── N1 非凭据字段跨域不受影响（不得误伤普通浏览）────────────────────
  {
    await page.goto(A, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    const id = upsert(OTHER_REGISTRABLE);
    const r = await tools.runTool(
      { type: 'fill', target: { field: 'search', semantic: 'Search' }, value: 'query' },
      { page }, meta(id),
    );
    check('N1 跨域非凭据字段放行', codeOf(r) !== 'CREDENTIAL_ACTION_BLOCKED', 'code=' + codeOf(r) + ' msg=' + msgOf(r).slice(0, 120));
  }

  await browser.close();
  srvA.close();
  srvB.close();
  console.log('\nRESULT pass=' + pass + ' fail=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e && e.stack); process.exit(1); });
