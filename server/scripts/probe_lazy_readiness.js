'use strict';

// probe_lazy_readiness.js — rw.083 确定性取证探针（只读，无 LLM）。
// 用仓库真实 observation/semanticResolver/pageReady 对 search_lazy.html 的 800ms 懒加载
// 逐层探测：观察采集 → 语义解析 → 就绪等待 → fill/click 实打。定位「等待懒加载内容完全加载」
// 重试耗尽的精确失败层。

const path = require('path');
const http = require('http');
const fs = require('fs');

const observation = require('../agent/observation');
const semanticResolver = require('../agent/semanticResolver');
const pageReady = require('../agent/pageReady');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html';
      const p = path.join(ROOT, 'mock-site', rel);
      if (!p.startsWith(path.join(ROOT, 'mock-site')) || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
        res.writeHead(404); res.end('nf'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function summarize(obs) {
  const els = (obs && obs.elements) || [];
  const q = els.filter((e) => (e.selector || '').includes('#q') || (e.selector || '').includes('q'));
  const btn = els.filter((e) => (e.selector || '').includes('#searchBtn') || (e.selector || '').includes('searchBtn'));
  return {
    url: obs && obs.url,
    textSummary: String((obs && (obs.textSummary || ''))).slice(0, 80),
    elementCount: els.length,
    hasQ: q.length > 0,
    qSelectors: q.map((e) => e.selector).slice(0, 3),
    hasSearchBtn: btn.length > 0,
  };
}

(async () => {
  const { srv, port } = await startServer();
  const url = 'http://127.0.0.1:' + port + '/ecommerce/search_lazy.html';
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const target = { field: 'q', semantic: '搜索框' };
  const out = {};

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });

  // ── 层 1：t≈0（hidden 期）观察 + 解析 ──
  const r1 = await observation.inspect(page, { taskId: 'probe', skipCache: true });
  out.t0 = summarize(r1.observation);
  const c1 = semanticResolver.resolve(target, r1.observation);
  out.t0_resolve = { hits: c1.length, top: c1[0] ? c1[0].selector : null };
  out.t0_pageReady = pageReady.isPageReady(r1.observation);

  // ── 层 2：hidden 期 fill 实打（模拟 agent 在 800ms 内执行） ──
  try {
    await page.fill('#q', '机械键盘', { timeout: 1500 });
    out.t0_fill = 'ok（Playwright fill 等到了元素可见）';
  } catch (e) {
    out.t0_fill = 'fail: ' + String(e.message || e).split('\n')[0].slice(0, 100);
  }

  // ── 层 3：t≈1.2s（visible 期）观察 + 解析 ──
  await page.waitForTimeout(1200);
  const r2 = await observation.inspect(page, { taskId: 'probe', skipCache: true });
  out.t1200 = summarize(r2.observation);
  const c2 = semanticResolver.resolve(target, r2.observation);
  out.t1200_resolve = { hits: c2.length, top: c2[0] ? c2[0].selector : null };

  // ── 层 4：waitForElement 就绪等待（从 hidden 期开始计时才真实，但此处页面已就绪，验证解析链） ──
  const readyObs = await pageReady.waitForElement(page, target, { timeoutMs: 4000, taskId: 'probe' });
  out.waitForElement = readyObs ? 'resolved' : 'null(超时)';

  // ── 层 5：搜索动作实打 + 结果回显验证 ──
  try {
    await page.fill('#q', '机械键盘', { timeout: 3000 });
    await page.click('#searchBtn', { timeout: 3000 });
    await page.waitForTimeout(200);
    const r3 = await observation.inspect(page, { taskId: 'probe', skipCache: true });
    out.searchEcho = summarize(r3.observation).textSummary;
    const vp = String((r3.observation && r3.observation.textSummary) || '').includes('机械键盘');
    out.textPresent_mechanicalKeyboard = vp;
  } catch (e) {
    out.searchEcho = 'fail: ' + String(e.message || e).split('\n')[0].slice(0, 100);
  }

  await browser.close();
  srv.close();
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error('PROBE_FATAL:', e.message); process.exit(1); });
