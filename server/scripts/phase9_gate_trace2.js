'use strict';
// Phase 9 — execute 链路级 trace：为什么「直接点击有效」但「tools.execute(submit) 无效」。
// 对照 phase9_gate_trace.js（直接 humanClick 成功）与 Gate 结果（HEALING / 结构未变）。
// 差异只可能出在 tools.execute 内部：resolveSelector → humanClick → 落点等待 → inspect2 → after 观察。

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
  const db = require('../db');
  const observation = require('../agent/observation');
  const verification = require('../agent/verification');
  const tools = require('../agent/tools');
  const browserManager = require('../browserManager');
  const taskManager = require('../agent/taskManager');
  require('../agent/runtime');

  const server = await startMockServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const PROFILE_ID = 'p9_exec_' + Date.now().toString(36);
  const profile = {
    id: PROFILE_ID, name: 'P9-EXEC', group: 'default', tags: [], notes: '',
    seed: 'exec', headless: true, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { restoreLastSession: false, blockVideo: false, blockImages: false, clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false },
    fingerprintOverride: {}, fingerprint: null, lastSessionUrls: [], createdAt: Date.now(),
  };
  db.upsertProfile(profile);
  // 先启动浏览器（同一 profileId），再建任务，使 tools 内部 getPageFor(taskId) 能取到同一 session
  const session = await browserManager.launch(profile, null);
  const page = session.page;

  const task = taskManager.createTask({
    name: 'P9-EXEC-TRACE', objective: 'trace', targetUrl: base + '/data_entry/form.html',
    profileId: PROFILE_ID, executionMode: 'AUTONOMOUS', constraints: [], policy: { riskFloor: 'HIGH' },
  });
  taskManager.start(task.id);
  await new Promise((r) => setTimeout(r, 800));

  // ── CASE A: rw.056 场景，走完整 tools.execute ──
  console.log('\n══ CASE A  rw.056 — 完整 tools.execute 链路 (data_entry/form.html) ══');
  await page.goto(base + '/data_entry/form.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);

  for (const [name, val] of [['name', '张三'], ['email', 'z@x.io'], ['phone', '13900000000']]) {
    const r = await tools.execute({ type: 'fill', target: { semantic: name + '输入框', field: name }, value: val },
      { taskId: task.id, profileId: PROFILE_ID, dryRun: false });
    console.log('  fill ' + name + ' → ok=' + r.ok + (r.error ? ' err=' + JSON.stringify(r.error) : ''));
  }

  const beforeObs = (await observation.inspect(page, { taskId: task.id, skipCache: true })).observation;
  console.log('  [submit 前] textSummary = ' + String(beforeObs.textSummary || '').slice(0, 80));

  const meta = { taskId: task.id, profileId: PROFILE_ID };
  const out = await tools.execute({ type: 'submit', target: { semantic: '提交按钮', field: 'submit' } }, meta);
  console.log('  execute(submit).ok =', out.ok);
  console.log('  execute(submit).result =', JSON.stringify(out.result).slice(0, 200));
  console.log('  execute(submit).error =', JSON.stringify(out.error || null));
  console.log('  meta.selFromMemory =', meta.selFromMemory, '| matchedBy =', meta.matchedBy, '| preferApplied =', meta.preferApplied, '| memoryDeclined =', meta.memoryDeclinedByPrefer);

  const afterObs = (await observation.inspect(page, { taskId: task.id, skipCache: true })).observation;
  console.log('  [submit 后] textSummary = ' + String(afterObs.textSummary || '').slice(0, 120));
  console.log('  → text_present="注册成功" (after) =', verification.verify({ type: 'text_present', expect: '注册成功' }, afterObs).success);
  console.log('  → execute 返回的 after.observation 判定 =',
    out.after ? verification.verify({ type: 'text_present', expect: '注册成功' }, out.after).success : 'no after');

  // 直接看 DOM 真相
  const msgText = await page.textContent('#msg').catch(() => null);
  console.log('  [DOM 真相] #msg =', JSON.stringify(msgText));

  // ── CASE B: rw.076 场景，走完整 tools.execute ──
  console.log('\n══ CASE B  rw.076 — 完整 tools.execute 链路 (ecommerce/search.html 搜索「显示器」) ══');
  await page.goto(base + '/ecommerce/search.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  const f = await tools.execute({ type: 'fill', target: { semantic: '搜索输入框', field: 'search' }, value: '显示器' },
    { taskId: task.id, profileId: PROFILE_ID, dryRun: false });
  console.log('  fill search → ok=' + f.ok);
  const qVal = await page.inputValue('input#q').catch(() => null);
  console.log('  [DOM 真相] input#q value =', JSON.stringify(qVal));

  const meta2 = { taskId: task.id, profileId: PROFILE_ID };
  const out2 = await tools.execute({ type: 'submit', target: { semantic: '搜索表单', field: 'search' } }, meta2);
  console.log('  execute(submit).ok =', out2.ok);
  console.log('  execute(submit).result =', JSON.stringify(out2.result).slice(0, 200));
  console.log('  meta2.matchedBy =', meta2.matchedBy, '| preferApplied =', meta2.preferApplied, '| memoryDeclined =', meta2.memoryDeclinedByPrefer);
  const afterObs2 = (await observation.inspect(page, { taskId: task.id, skipCache: true })).observation;
  console.log('  [submit 后] textSummary = ' + String(afterObs2.textSummary || '').slice(0, 200));
  console.log('  → text_present="显示器" =', verification.verify({ type: 'text_present', expect: '显示器' }, afterObs2).success);
  const resHtml = await page.innerHTML('#results').catch(() => null);
  console.log('  [DOM 真相] #results 长度 =', resHtml ? resHtml.length : 'null');

  // ── CASE C: rw.001 场景 navigate 后 element_present ──
  console.log('\n══ CASE C  rw.001 — navigate 后 element_present="input[name=\'email\']" ══');
  await page.goto('about:blank');
  await page.waitForTimeout(200);
  const nav = await tools.execute({ type: 'navigate', target: { url: base + '/saas/login.html' } },
    { taskId: task.id, profileId: PROFILE_ID, dryRun: false });
  console.log('  execute(navigate).ok =', nav.ok);
  console.log('  execute(navigate).result =', JSON.stringify(nav.result).slice(0, 200));
  console.log('  execute(navigate).error =', JSON.stringify(nav.error || null));
  const navObs = (await observation.inspect(page, { taskId: task.id, skipCache: true })).observation;
  console.log('  [navigate 后] url =', navObs.url);
  console.log('  [navigate 后] elements 数 =', (navObs.elements || []).length);
  console.log('  [navigate 后] textSummary = ' + String(navObs.textSummary || '').slice(0, 100));
  console.log('  → element_present="input[name=\'email\']" =',
    verification.verify({ type: 'element_present', expect: "input[name='email']" }, navObs).success);

  try { taskManager.cancel(task.id); } catch (e) {}
  try { await browserManager.close(PROFILE_ID); } catch (e) {}
  server.close();
  process.exit(0);
})().catch((e) => { console.error('trace 异常:', e && e.stack || e); process.exit(1); });
