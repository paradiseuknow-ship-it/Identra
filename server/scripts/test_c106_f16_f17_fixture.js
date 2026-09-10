'use strict';
// C106 F16/F17 — 【真实浏览器 fixture】端到端守护。
//
// 三个真实站点实证缺陷（Webflow 注册 task_mtuqje3txasfd）：
//
// F16「填错字段」型假成功
//   idx28 fill {semantic:'注册密码输入框', field:'password'} FAILED 未找到输入目标
//   idx29 fill {semantic:'email',          field:'password'} SUCCESS ← 值被写进 email 框
//   根因：field 解析不到时退而接受 semantic 命中的另一个可填字段。
//
// F17「观察全崩 = 全盲」
//   webflow.com/signup 上 observation.inspect 抛
//     TypeError: Cannot read properties of undefined (reading 'toLowerCase')
//   → 返回 {ok:false} 且无 observation → 所有动作一律报「未找到」，
//   与页面真实内容无关；F15 也因此恒报 no_advance_control。
//
// 覆盖场景（真实 Chromium + 真实 observation + 真实 tools）：
//   A 容错：页面含一个 tagName 被覆写为 undefined 的元素 → 观察仍 ok 且能看到其余元素
//   B F16：email + password 同页，fill {semantic:'email', field:'password'} → 填到 password
//   C F16：只有 email 框，fill {semantic:'email', field:'password'} → 拒绝，不写 email
//   D F17b：observation 失败（{ok:false}）→ fill/click 报 OBSERVATION_FAILED 而非 ELEMENT_NOT_FOUND

const http = require('http');
const { chromium } = require('playwright');
const observation = require('../agent/observation');
const tools = require('../agent/tools');
const { listenSafe } = require('./lib_safe_port');

const PAGES = {
  // A：含「坏元素」（tagName 被覆写为 undefined）——复现真实站点观察崩溃的形状
  '/broken': [
    '<!doctype html><html><body><form action="#">',
    '<input id="email" name="email" type="email" placeholder="Email">',
    '<input id="password" name="password" type="password" placeholder="Password">',
    '<button id="save" type="submit">Save</button>',
    '</form>',
    '<script>',
    "Object.defineProperty(document.getElementById('save'), 'tagName', { value: undefined, configurable: true });",
    '</script></body></html>',
  ].join('\n'),

  // B：email + password 同页
  '/both': [
    '<!doctype html><html><body><form action="#">',
    '<input id="email" name="email" type="email" placeholder="Email">',
    '<input id="password" name="password" type="password" placeholder="Password">',
    '<button id="save" type="submit">Save</button>',
    '</form></body></html>',
  ].join('\n'),

  // C：只有 email（password 尚未挂载）
  '/emailonly': [
    '<!doctype html><html><body><form action="#">',
    '<input id="email" name="email" type="email" placeholder="Email">',
    '<button id="save" type="submit">Save</button>',
    '</form></body></html>',
  ].join('\n'),
};

let pass = 0; let fail = 0;
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

  // PHASE 17-A P0-A：`fill` 对 email/password 这类**凭据字段**会先过 Credential Action
  // Authorization Gate（tools.guardCredentialAction）。旧版这里硬编码 taskId='t_c106_f16f17'，
  // 该任务在 store 中不存在 → 授权上下文缺失 → fail closed（CREDENTIAL_ACTION_BLOCKED），
  // 导致 B/C/D 四条断言全部改报安全闸错误（实测）。
  // 这是安全闸的**正确行为**，不是缺陷 —— 修复方向是给 fixture 一个真实任务 +
  // 真实 targetUrl（锚点 origin），绝不为了跑绿而放宽闸门。
  const taskManager = require('../agent/taskManager');
  const task = taskManager.createTask({
    name: 'c106 f16/f17 fixture',
    objective: 'field authority + observation tolerance on a real page',
    targetUrl: BASE + '/both',
    executionMode: 'ASSIST',
    profileId: null,
    policy: {}, budget: {}, constraints: [], secretRefs: [],
    createdBy: 'fixture',
  });
  const meta = () => ({ taskId: task.id, executionId: 'exe_' + task.id, stepId: 'step_f1617' });

  // ---------- A 观察容错：坏元素不得让整页观察归零 ----------
  await page.goto(BASE + '/broken', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  const oBroken = await observation.inspect(page, { taskId: task.id });
  const elsBroken = (oBroken.observation && oBroken.observation.elements) || [];
  check('A1 坏元素存在时观察仍 ok', oBroken.ok !== false, 'ok=' + oBroken.ok + (oBroken.error ? ' err=' + oBroken.error : ''));
  check('A2 坏元素之外的元素仍被采集（email）', elsBroken.some((e) => e.id === 'email'), 'elements=' + elsBroken.length);
  check('A3 坏元素之外的元素仍被采集（password）', elsBroken.some((e) => e.id === 'password'), 'elements=' + elsBroken.length);

  // ---------- B F16：同页两字段，semantic 指向 email 但 field=password → 必须填 password ----------
  await page.goto(BASE + '/both', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  const rB = await tools.runTool({
    type: 'fill',
    target: { semantic: 'email', field: 'password' },
    value: 'Secret123!',
  }, { page }, meta());
  const filledB = await page.evaluate(() => ({
    email: (document.getElementById('email') || {}).value,
    password: (document.getElementById('password') || {}).value,
  }));
  check('B1 fill 未报失败', !!(rB && rB.success), 'success=' + (rB && rB.success) + ' err=' + (rB && rB.error ? String(rB.error.message || rB.error.code).slice(0, 80) : ''));
  check('B2 值写进 password 框', filledB.password === 'Secret123!', JSON.stringify(filledB));
  check('B3 值没有写进 email 框（F16 核心）', !filledB.email, JSON.stringify(filledB));

  // ---------- C F16：password 不存在时不得退而填 email ----------
  await page.goto(BASE + '/emailonly', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  const rC = await tools.runTool({
    type: 'fill',
    target: { semantic: 'email', field: 'password' },
    value: 'Secret123!',
  }, { page }, meta());
  const filledC = await page.evaluate(() => ({
    email: (document.getElementById('email') || {}).value,
  }));
  check('C1 fill 判失败（未找到 password）', !!(rC && rC.success === false), 'success=' + (rC && rC.success));
  check('C2 失败类型为 ELEMENT_NOT_FOUND（不是观察失败）', !!(rC && rC.error && rC.error.code === 'ELEMENT_NOT_FOUND'), 'code=' + (rC && rC.error && rC.error.code));
  check('C3 email 框未被污染（拒绝填错字段）', !filledC.email, JSON.stringify(filledC));

  // ---------- D F17b：观察失败 → OBSERVATION_FAILED，不伪装成 ELEMENT_NOT_FOUND ----------
  const realInspect = observation.inspect;
  observation.inspect = async () => ({ ok: false, error: '页面不可观察: injected failure' });
  try {
    await page.goto(BASE + '/both', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    const rD1 = await tools.runTool({ type: 'fill', target: { field: 'password' }, value: 'x' }, { page }, meta());
    const rD2 = await tools.runTool({ type: 'click', target: { semantic: 'Save' } }, { page }, meta());
    const filledD = await page.evaluate(() => ({ password: (document.getElementById('password') || {}).value }));
    check('D1 fill 报 OBSERVATION_FAILED', !!(rD1 && rD1.error && rD1.error.code === 'OBSERVATION_FAILED'), 'code=' + (rD1 && rD1.error && rD1.error.code));
    check('D2 click 报 OBSERVATION_FAILED', !!(rD2 && rD2.error && rD2.error.code === 'OBSERVATION_FAILED'), 'code=' + (rD2 && rD2.error && rD2.error.code));
    check('D3 观察失败时零写入', !filledD.password, JSON.stringify(filledD));
  } finally {
    observation.inspect = realInspect;
  }

  // 恢复后观察正常（确保 patch 已还原）
  const oBack = await observation.inspect(page, { taskId: 't_c106_f16f17' });
  check('D4 patch 还原后观察恢复', oBack.ok !== false && ((oBack.observation && oBack.observation.elements) || []).length > 0,
    'els=' + (((oBack.observation && oBack.observation.elements) || []).length));

  await browser.close();
  srv.close();
  console.log(`\n=== C106 F16/F17 真实浏览器 fixture: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
