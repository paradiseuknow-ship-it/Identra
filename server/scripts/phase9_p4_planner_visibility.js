'use strict';
// ============================================================================
// Phase 9 P4 — Planner 可见性探针（只读诊断，不改任何代码）
//
// 要验证的唯一假设：
//   contextBuilder 把 observation 的 17 个字段裁剪成 7 个（丢掉 id / selector），
//   导致 Planner 在看不到页面真实元素标识的情况下凭空编造验证契约
//   （实测：member-list / order-list / log-list 在页面上根本不存在，真实 id 是 list）。
//
// 做法：真实 Chromium 打开 mock-site fixture → observation.inspect() → contextBuilder.build()
//       对比「原始 observation 元素」与「Planner 实际可见元素」。
// ============================================================================

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

const PAGES = [
  '/scraping/list.html',
  '/admin/users.html',
  '/ecommerce/search.html',
  '/data_entry/form.html',
  '/saas/login.html',
];

(async () => {
  const db = require('../db');
  const observation = require('../agent/observation');
  const contextBuilder = require('../agent/contextBuilder');
  const browserManager = require('../browserManager');

  const server = await startMockServer();
  const base = 'http://127.0.0.1:' + server.address().port;
  const PROFILE_ID = 'p9p4_' + Date.now().toString(36);
  db.upsertProfile({
    id: PROFILE_ID, name: 'P9P4', group: 'default', tags: [], notes: '',
    seed: 'p4', headless: true, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { restoreLastSession: false, blockVideo: false, blockImages: false, clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false },
    fingerprintOverride: {}, fingerprint: null, lastSessionUrls: [], createdAt: Date.now(),
  });
  const session = await browserManager.launch(db.getProfile(PROFILE_ID), null);
  const page = session.page;

  const report = [];
  for (const p of PAGES) {
    await page.goto(base + p, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    const insp = await observation.inspect(page, {});
    if (!insp.ok) { console.log('[inspect 失败] ' + p + ' → ' + insp.error); continue; }
    const obs = insp.observation;

    const ctx = contextBuilder.build({
      task: { id: 'probe', objective: 'probe', targetUrl: base + p, executionMode: 'AUTONOMOUS', status: 'RUNNING' },
      observation: obs, steps: [], checkpoint: null, errorHistory: [], verification: null, execution: null, error: null, budgetCfg: null,
    });

    const rawEls = obs.elements || [];
    const ctxEls = (ctx.page && ctx.page.elements) || [];
    const rawFields = Array.from(new Set(rawEls.flatMap((e) => Object.keys(e))));
    const ctxFields = Array.from(new Set(ctxEls.flatMap((e) => Object.keys(e))));
    const lost = rawFields.filter((f) => !ctxFields.includes(f));
    const dropped = rawEls.slice(ctxEls.length);

    // 页面真实存在的 id（供对照：Planner 编造的 member-list 是否在真实 id 里）
    const realIds = rawEls.map((e) => e.id).filter(Boolean);
    const realSelectors = rawEls.slice(0, 8).map((e) => e.selector).filter(Boolean);

    // Planner 契约里用到的「元素标识」能否被 Planner 自己看到
    const visibleTokens = ctxEls.map((e) => [e.id, e.selector, e.name, e.text, e.placeholder, e.label].filter(Boolean).join(' ')).join(' | ');

    console.log('\n══ ' + p + ' ══');
    console.log('  observation 元素数: ' + rawEls.length + '  →  Planner 可见元素数: ' + ctxEls.length + '（被截断丢弃 ' + dropped.length + '）');
    console.log('  observation 字段: ' + rawFields.join(','));
    console.log('  Planner 可见字段: ' + ctxFields.join(','));
    console.log('  ★ 丢失字段      : ' + (lost.join(',') || '(无)'));
    console.log('  页面真实 id     : ' + (realIds.slice(0, 12).join(', ') || '(无)'));
    console.log('  前 8 个 selector: ' + realSelectors.join(' | '));
    console.log('  Planner 能看到「member-list」吗? ' + (visibleTokens.includes('member-list') ? '能' : '不能（页面无此 id，Planner 只能猜）'));

    report.push({
      page: p,
      rawCount: rawEls.length, ctxCount: ctxEls.length, dropped: dropped.length,
      rawFields, ctxFields, lost,
      realIds, realSelectors,
      droppedEls: dropped.map((e) => ({ id: e.id, tag: e.tag, text: String(e.text || '').slice(0, 30), selector: e.selector })),
      textSummaryLen: String(obs.textSummary || '').length,
      ctxTextSummaryLen: String((ctx.page && ctx.page.textSummary) || '').length,
    });
  }

  const outFile = path.join(ROOT, '.benchmark', 'phase9_p4_planner_visibility.json');
  fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), pages: report }, null, 2));
  console.log('\n已写出: ' + outFile);

  try { browserManager.close(PROFILE_ID).catch(() => {}); } catch (e) {}
  try { db.deleteProfile(PROFILE_ID); } catch (e) {}
  server.close();
  process.exit(0);
})();
