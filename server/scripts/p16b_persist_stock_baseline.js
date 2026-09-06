'use strict';

// Phase 16-B §20 — Profile Persistence stock 基线（「改变前」锚点，非回归测试）。
// 目的：验证 stock Chrome persistent profile 的存储跨重启保留（localStorage /
// IndexedDB / cookie / Cache API）。Native POC 落地后用同一脚本 + 换 executablePath
// 对比——若 Native patch 意外清除任何存储项，此处立即暴露。
// 纪律：固定 profileId 复用（reopen 语义），不递归删除 profile 目录（safe-delete 守卫）。
// 端口固定 46621：跨运行 origin 必须恒定，否则 localStorage 按.origin 隔离读不回旧值；
// 被占用时 fail-fast（不要静默换端口）。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const PORT = 46621;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = path.join(__dirname, '..', '..', 'data', 'profiles', 'p16b_persist_stock');

async function waitForServer(server) {
  for (let i = 0; i < 50; i++) {
    try { await new Promise((res, rej) => { const r = http.get(BASE + '/', res); r.on('error', rej); r.end(); }); return; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('local server not ready');
}

(async () => {
  if (!fs.existsSync(CHROME)) { console.error('FATAL chrome.exe not found: ' + CHROME); process.exit(2); }

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>fp16b persist probe</body></html>');
  });
  await new Promise((res) => server.listen(PORT, '127.0.0.1', res));
  await waitForServer(server);

  const launchOpts = {
    executablePath: CHROME, headless: true,
    args: ['--no-first-run', '--no-default-browser-check'],
  };

  const results = {};
  try {
    // ---- pass 1: 写入四类存储 ----
    const ctx1 = await chromium.launchPersistentContext(PROFILE_DIR, launchOpts);
    const p1 = ctx1.pages()[0] || await ctx1.newPage();
    await p1.goto(BASE + '/');
    const written = await p1.evaluate(async (BASE) => {
      localStorage.setItem('fp16b_ls', 'persist-local-' + Date.now());
      document.cookie = 'fp16b_cookie=persist-cookie; path=/; max-age=86400';
      const idb = await new Promise((resolve, reject) => {
        const req = indexedDB.open('fp16b_db', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => {
          const tx = req.result.transaction('kv', 'readwrite');
          tx.objectStore('kv').put('persist-idb', 'fp16b_key');
          tx.oncomplete = () => { req.result.close(); resolve(true); };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      });
      const cache = await caches.open('fp16b_cache');
      await cache.put(BASE + '/cached-res', new Response('persist-cache-body'));
      return { idb };
    }, BASE);
    if (!written.idb) throw new Error('IndexedDB write failed');
    const lsValue = await p1.evaluate(() => localStorage.getItem('fp16b_ls'));
    await ctx1.close();

    // ---- pass 2: relaunch 同 profile 读回（reopen 语义） ----
    const ctx2 = await chromium.launchPersistentContext(PROFILE_DIR, launchOpts);
    const p2 = ctx2.pages()[0] || await ctx2.newPage();
    await p2.goto(BASE + '/');
    results.recovered = await p2.evaluate(async (BASE) => {
      const ls = localStorage.getItem('fp16b_ls');
      const cookie = (document.cookie.match(/fp16b_cookie=([^;]+)/) || [])[1] || null;
      const idb = await new Promise((resolve) => {
        const req = indexedDB.open('fp16b_db', 1);
        req.onsuccess = () => {
          const tx = req.result.transaction('kv', 'readonly');
          const g = tx.objectStore('kv').get('fp16b_key');
          g.onsuccess = () => { req.result.close(); resolve(g.result || null); };
        };
        req.onerror = () => resolve(null);
      });
      const cache = await caches.open('fp16b_cache');
      const m = await cache.match(BASE + '/cached-res');
      const cacheBody = m ? await m.text() : null;
      return { ls, cookie, idb, cacheBody };
    }, BASE);
    results.lsValueWritten = lsValue;
    await ctx2.close();
  } finally { server.close(); }

  // ---- 判定 ----
  const r = results.recovered || {};
  results.pass = {
    localStorage: !!r.ls && r.ls === results.lsValueWritten,
    cookie: r.cookie === 'persist-cookie',
    indexedDB: r.idb === 'persist-idb',
    cacheAPI: r.cacheBody === 'persist-cache-body',
  };
  results.allPass = Object.values(results.pass).every(Boolean);

  const out = path.join(__dirname, '..', '..', '.benchmark', 'p16b_persist_stock.json');
  fs.writeFileSync(out, JSON.stringify({ timestamp: new Date().toISOString(), engine: 'stock', ...results }, null, 2));

  for (const [k, v] of Object.entries(results.pass)) console.log(`  ${v ? 'PASS' : 'FAIL'} §20 ${k} 跨重启保留`);
  console.log('RESULT ' + (results.allPass ? 'ALL-PASS' : 'FAILED') + ' -> ' + out);
  process.exit(results.allPass ? 0 : 1);
})().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
