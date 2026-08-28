'use strict';
// ============================================================================
// Phase 9 P4 — 契约可推导性上限分析（只读，不改任何代码 / 判定）
//
// 目的：诚实评估 P4（Planner 现在能看到真实页面）的收益天花板。
// 对每个失败契约条款，判断其期望值【是否能从页面真实内容推导出来】：
//   - DERIVABLE   ：期望值存在于页面的真实渲染内容（或元素标识存在于 DOM/源码）
//                   → Planner 若看到页面就能写对 → P4 可修复
//   - UNDERIVABLE ：期望值在页面上根本不存在 → 看到页面也写不对 → 需 benchmark 资产修正
//   - POST_ACTION ：期望值是「动作之后才出现」的结果态（成功文案 / URL 变化）
//                   → 规划前无论看多少次页面都不可见 → 非 P4 范围
//
// 判定口径（避免假阳性）：
//   text_present / text_absent：只认【真实渲染文本】。
//     反例：search.html 的 JS 源码里有 `btn.textContent='已加入购物车'`，但规划时刻
//     渲染文本里并没有它 —— 用源码判定会误判为 DERIVABLE。
//   element_present / element_absent / element_state：渲染元素标识 + 源码兜底
//     （id/name 不一定出现在可见文本里，但确实存在于 DOM）。
//   url_contains：URL 只在动作后才变化 → POST_ACTION。
//
// 输入：
//   node server/scripts/analyze_phase9_p4_derivability.js
//     → 默认分析最新 phase9_gate4_replay_*.json（20-task 回放，VIL 影响样本）
//   node server/scripts/analyze_phase9_p4_derivability.js --store .benchmark/phase68_100task_store
//     → 分析 phase68 全量 100-task（覆盖 saas/login 等 fixture）
// ============================================================================

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, '.benchmark');
const MOCK = path.join(ROOT, 'mock-site');

const argv = process.argv.slice(2);
const STORE_MODE = (() => { const i = argv.indexOf('--store'); return i < 0 ? null : argv[i + 1]; })();

function startMockServer() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(String(req.url || '/').split('?')[0]);
    if (p === '/') p = '/search.html';
    const file = path.join(MOCK, p);
    if (!file.startsWith(MOCK) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

function parseUnmet(msg) {
  const out = [];
  const re = /required unmet:\s*([^→\n]+?)\s*→/g;
  let m;
  while ((m = re.exec(msg))) {
    let u = m[1].trim();
    const q = u.match(/^([\w_]+)\s*=\s*(.+)$/);
    if (q) { let v = q[2].trim(); if (v.length > 1 && v[0] === '"' && v[v.length - 1] === '"') v = v.slice(1, -1); u = q[1] + '=' + v; }
    out.push(u);
  }
  return out;
}

const SUCCESS_SIGNALS = ['成功', '完成', '已加入', '已提交', '欢迎', '已添加', '已创建', '已保存'];

// ── 载入「页面 → 失败契约条款」
function loadFromReplay() {
  const c = fs.readdirSync(OUT_DIR).filter((f) => /^phase9_gate4_replay_\d+\.json$/.test(f)).sort();
  const file = path.join(OUT_DIR, c[c.length - 1]);
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const items = [];
  const objectives = {};
  for (const r of (d.results || [])) {
    const page = String(r.targetUrl || '').replace(/^http:\/\/127\.0\.0\.1:\d+/, '');
    objectives[page] = objectives[page] || [];
    objectives[page].push(String(r.objective || ''));
    for (const a of (r.attempts || [])) {
      if (a.status === 'SUCCESS') continue;
      items.push({ page, clauses: parseUnmet(String(a.raw || '')) });
    }
  }
  return { source: path.basename(file), items, objectives };
}

function loadFromStore(dir) {
  const tasks = JSON.parse(fs.readFileSync(path.join(dir, 'aiTasks.json'), 'utf8'));
  const attempts = JSON.parse(fs.readFileSync(path.join(dir, 'aiAttempts.json'), 'utf8'));
  const byTask = {};
  for (const t of tasks) {
    byTask[t.id] = String(t.targetUrl || '').replace(/^http:\/\/127\.0\.0\.1:\d+/, '').replace(/^http:\/\/localhost:\d+/, '');
  }
  const items = [];
  const objectives = {};
  for (const t of tasks) {
    const p = byTask[t.id];
    objectives[p] = objectives[p] || [];
    objectives[p].push(String(t.objective || ''));
  }
  for (const a of attempts) {
    if (a.status === 'SUCCESS' || !a.error) continue;
    items.push({ page: byTask[a.taskId] || '', clauses: parseUnmet(String((a.error && a.error.message) || '')) });
  }
  return { source: dir, items, objectives };
}

(async () => {
  const loaded = STORE_MODE ? loadFromStore(STORE_MODE) : loadFromReplay();
  const { source, items, objectives } = loaded;

  const targets = new Set();
  for (const it of items) if (it.page) targets.add(it.page);

  const server = await startMockServer();
  const port = server.address().port;
  const db = require('../db');
  const observation = require('../agent/observation');
  const browserManager = require('../browserManager');

  const PROFILE_ID = 'p9p4c_' + Date.now().toString(36);
  db.upsertProfile({
    id: PROFILE_ID, name: 'P9P4C', group: 'default', tags: [], notes: '',
    seed: 'p4c', headless: true, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { restoreLastSession: false, blockVideo: false, blockImages: false, clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false },
    fingerprintOverride: {}, fingerprint: null, lastSessionUrls: [], createdAt: Date.now(),
  });
  const session = await browserManager.launch(db.getProfile(PROFILE_ID), null);
  const page = session.page;

  const pageFacts = {};
  for (const t of targets) {
    let rendered = ''; let src = '';
    try {
      const f = path.join(MOCK, String(t).replace(/^\/+/, ''));
      if (fs.existsSync(f)) src = fs.readFileSync(f, 'utf8');
    } catch (e) {}
    try {
      await page.goto('http://127.0.0.1:' + port + t, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(300);
      const insp = await observation.inspect(page, {});
      if (insp && insp.ok) {
        const o = insp.observation;
        rendered = [o.textSummary || '', o.visibleText || '', o.roleText || '',
          (o.elements || []).map((e) => [e.id, e.name, e.text, e.placeholder, e.label, e.ariaLabel].filter(Boolean).join(' ')).join(' ')].join(' ');
      }
    } catch (e) {}
    pageFacts[t] = { rendered, src };
  }

  const tally = { DERIVABLE: 0, UNDERIVABLE: 0, POST_ACTION: 0, UNKNOWN: 0 };
  const byPage = {};
  const samples = { DERIVABLE: [], UNDERIVABLE: [], POST_ACTION: [], UNKNOWN: [] };
  let clauses = 0;

  for (const it of items) {
    const fact = pageFacts[it.page] || { rendered: '', src: '' };
    for (const c of it.clauses) {
      clauses++;
      byPage[it.page] = byPage[it.page] || { DERIVABLE: 0, UNDERIVABLE: 0, POST_ACTION: 0, UNKNOWN: 0, total: 0 };
      const q = c.match(/^([\w_]+)=(.+)$/);
      if (!q) { tally.UNKNOWN++; byPage[it.page].UNKNOWN++; byPage[it.page].total++; continue; }
      const [, type, want] = q;
      let cls;
      if (type === 'url_contains') cls = 'POST_ACTION';
      else if (type === 'text_present' || type === 'text_absent') {
        if (fact.rendered.includes(want)) cls = 'DERIVABLE';
        else if (SUCCESS_SIGNALS.some((s) => want.includes(s))) cls = 'POST_ACTION';
        else cls = 'UNDERIVABLE';
      } else {
        cls = (fact.rendered.includes(want) || fact.src.includes(want)) ? 'DERIVABLE' : 'UNDERIVABLE';
      }
      tally[cls]++; byPage[it.page][cls]++; byPage[it.page].total++;
      if (samples[cls].length < 8) samples[cls].push({ page: it.page, clause: type + '=' + want });
    }
  }

  console.log('\n===== Phase 9 P4 — 契约可推导性上限（只读）=====');
  console.log('数据源:', source);
  console.log('失败契约条款总数:', clauses);
  console.log('');
  for (const k of ['DERIVABLE', 'UNDERIVABLE', 'POST_ACTION', 'UNKNOWN']) {
    const pct = clauses ? (tally[k] / clauses * 100).toFixed(1) : '0.0';
    console.log('  ' + String(tally[k]).padStart(4) + '  ' + k.padEnd(14) + ' (' + pct + '%)');
  }

  console.log('\n── 按 fixture 分组 ──');
  console.log('  ' + 'fixture'.padEnd(30) + '  总数  DERIV  UNDER  POST');
  for (const [p, v] of Object.entries(byPage).sort((a, b) => b[1].total - a[1].total)) {
    console.log('  ' + String(p || '(未知)').padEnd(30) + String(v.total).padStart(6)
      + String(v.DERIVABLE).padStart(7) + String(v.UNDERIVABLE).padStart(7) + String(v.POST_ACTION).padStart(6));
  }

  console.log('');
  for (const k of Object.keys(samples)) {
    if (!samples[k].length) continue;
    console.log('── 样本 [' + k + '] ──');
    for (const s of samples[k]) console.log('  ' + String(s.page).padEnd(28) + s.clause);
    console.log('');
  }

  console.log('解读：');
  console.log('  DERIVABLE   = 页面真实内容里存在 → P4 后 Planner 有能力写对（P4 可修复）');
  console.log('  UNDERIVABLE = 纯属臆造且页面无对应内容 → benchmark 资产问题，非 P4 范围');
  console.log('  POST_ACTION = 动作后才出现的结果态 → 规划前不可见，非 P4 范围');

  const outName = STORE_MODE ? 'phase9_p4_derivability_phase68.json' : 'phase9_p4_derivability_ceiling.json';
  fs.writeFileSync(path.join(OUT_DIR, outName), JSON.stringify({
    generatedAt: new Date().toISOString(), source, clauses, tally, byPage, samples,
    objectivesSample: Object.fromEntries(Object.entries(objectives).map(([k, v]) => [k, v.slice(0, 12)])),
  }, null, 2));
  console.log('\n已写出: .benchmark/' + outName);

  try { browserManager.close(PROFILE_ID).catch(() => {}); } catch (e) {}
  try { db.deleteProfile(PROFILE_ID); } catch (e) {}
  server.close();
  process.exit(0);
})();
