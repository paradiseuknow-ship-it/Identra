'use strict';

// Phase 16-B §21 — stock Chromium 性能基线（Playwright + 系统 Google Chrome，persistent profile）
// 纯测量，不改生产代码；输出 .benchmark/PHASE16B_PERF_BASELINE.md 的数据部分。
// 注意：测量项 = startup / basic navigation / JS execution / chrome.exe RSS 合计。5 轮取中位。

const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROUNDS = 5;

function chromeRssMB() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /FO CSV /NH', { encoding: 'utf8' });
    let total = 0; let count = 0;
    for (const line of out.split('\n')) {
      const m = line.match(/"chrome\.exe","(\d+)"/);
      if (m) { total += parseInt(m[1], 10); count++; }
    }
    return { mb: Math.round(total / 1024), procs: count };
  } catch (e) { return { mb: -1, procs: -1 }; }
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

(async () => {
  const runs = [];
  for (let i = 0; i < ROUNDS; i++) {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp16b-perf-'));
    const t0 = Date.now();
    const ctx = await chromium.launchPersistentContext(profileDir, {
      executablePath: CHROME,
      headless: true,
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    const tLaunched = Date.now();
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('about:blank');
    const tReady = Date.now();
    const jsResult = await page.evaluate(() => 1 + 1);
    const tJs = Date.now();
    await page.goto('data:text/html,<title>fp16b-baseline</title><h1>ok</h1>');
    const title = await page.title();
    const tNav = Date.now();
    const rss = chromeRssMB();
    await ctx.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
    runs.push({
      launchMs: tLaunched - t0,
      readyMs: tReady - t0,
      jsMs: tJs - tReady,
      navMs: tNav - tJs,
      jsResult,
      title,
      rssMB: rss.mb,
      procs: rss.procs,
    });
    console.log('run ' + (i + 1) + ': ' + JSON.stringify(runs[i]));
  }

  const med = {
    launchMs: median(runs.map((r) => r.launchMs)),
    readyMs: median(runs.map((r) => r.readyMs)),
    jsMs: median(runs.map((r) => r.jsMs)),
    navMs: median(runs.map((r) => r.navMs)),
    rssMB: median(runs.map((r) => r.rssMB)),
    procs: median(runs.map((r) => r.procs)),
  };
  const summary = {
    chrome: 'stock Google Chrome（系统安装，152.x）',
    engine: 'Playwright launchPersistentContext + 系统 Chrome executablePath',
    rounds: ROUNDS,
    median: med,
    all: runs,
  };
  fs.writeFileSync(path.join(__dirname, '..', '..', '.benchmark', 'p16b_perf_stock.json'),
    JSON.stringify(summary, null, 2));
  console.log('MEDIAN: ' + JSON.stringify(med));
  console.log('saved -> .benchmark/p16b_perf_stock.json');
})().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
