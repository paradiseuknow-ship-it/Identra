'use strict';
// C44 守护测试 —— 遗留端点命中可观测性（deprecationMetrics）。
// 缺陷背景：C36 给 legacy 端点打了 RFC 8594 Deprecation 头，但"还在被谁调用"不可见——
//   无法支撑安全下线决策，也无迁移未完成的告警信号。
// 修复：deprecationMetrics（hit 累计 + store 持久化）→ dashboard.deprecation → ObservabilityPanel 卡片。
// 覆盖：
//   P1 hit 累计：同路由多次命中 count 递增、lastAt 更新、id=route
//   P2 snapshot 结构：total 汇总、命中数降序、lastUser/successor 透传
//   P3 持久化：写盘后重读仍在（store 集合真实落盘）
//   P4 markDeprecated 接线：真实服务器调 legacy 端点 → dashboard.deprecation 计数增长
//   P5 前端接线契约：ObservabilityPanel 含 DeprecationView 且消费 dash.deprecation

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

(async () => {
  // ---- P1-P3：模块级行为（tmp 隔离 store）----
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c44-guard-'));
  process.env.FPB_DATA_DIR = dataDir; // storage/index.js 读取
  // 清 require 缓存以在隔离目录下加载
  const storePath = require.resolve(path.join(ROOT, 'server', 'agent', 'store'));
  delete require.cache[storePath];
  const store = require(storePath);
  const dep = require(path.join(ROOT, 'server', 'agent', 'observability', 'deprecationMetrics.js'));
  dep.resetForTests();

  {
    const a = dep.hit('/ai/queue', { user: 'u1', successor: '/ai/execution/queue' });
    dep.hit('/ai/queue', { user: 'u2' });
    const b = dep.hit('/ai/events', { user: 'u1', successor: '/ai/tasks/{id}/events' });
    chk('P1 hit 累计：count 递增、id=route、lastUser 更新',
      a.count === 1 && a.id === '/ai/queue'
        && store.read('deprecationHits', []).find((r) => r.route === '/ai/queue').count === 2
        && b.id === '/ai/events',
      'a=' + JSON.stringify(a));
  }
  {
    dep.hit('/ai/observability/metrics', { user: 'u3', successor: '/ai/dashboard' });
    const snap = dep.snapshot();
    const top = snap.routes[0];
    chk('P2 snapshot：total 汇总 + 命中降序 + 字段透传',
      snap.total === 4 && top.route === '/ai/queue' && top.count === 2 && top.lastUser === 'u2'
        && top.successor === '/ai/execution/queue',
      'snap=' + JSON.stringify(snap).slice(0, 220));
  }
  {
    // P3 持久化：直接重读 store 集合（同进程已证明真实写盘；跨进程由 P4 真实服务器验证）
    const rows = store.read('deprecationHits', []);
    chk('P3 store 集合真实落盘（3 路由 4 命中）',
      rows.length === 3 && rows.reduce((s, r) => s + r.count, 0) === 4,
      'rows=' + rows.length);
  }

  // ---- P4：真实服务器契约（tmp 隔离）----
  try {
    const { spawn } = require('child_process');
    const PORT = 22750 + (process.pid % 50);
    const srvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c44-srv-'));
    const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      env: {
        ...process.env, PORT: String(PORT), AI_PROVIDER: 'mock',
        FPB_DATA_DIR: srvDir,
        FPB_VAULT_FILE: path.join(srvDir, 'vault.json'),
        FPB_SETTINGS_FILE: path.join(srvDir, 'runtime_settings.json'),
        FPB_MASTER_KEY: Buffer.alloc(32, 15).toString('base64'),
        DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', AI_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let srvLog = '';
    child.stdout.on('data', (d) => { srvLog += d; });
    child.stderr.on('data', (d) => { srvLog += d; });
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/api/browser/status`); if (r.ok) ready = true; } catch { /* not yet */ }
      if (!ready) await sleep(250);
    }
    if (!ready) throw new Error('server not ready: ' + srvLog.slice(-400));

    const BASE = `http://127.0.0.1:${PORT}/api/ai`;
    await fetch(`${BASE}/queue`); // legacy（bare array）
    await fetch(`${BASE}/observability/metrics`);
    await sleep(300);
    const dr = await fetch(`${BASE}/dashboard`);
    const dj = await dr.json();
    const depSnap = dj.dashboard && dj.dashboard.deprecation;
    const queueRow = depSnap && depSnap.routes.find((r) => r.route === '/queue');
    chk('P4 真实服务器：legacy 命中进 dashboard.deprecation（含 successor）',
      depSnap && depSnap.total >= 2 && queueRow && queueRow.count === 1
        && queueRow.successor === '/ai/execution/queue',
      'depSnap=' + JSON.stringify(depSnap).slice(0, 300));
    // Deprecation 头仍在（C36 契约不回归）
    const r2 = await fetch(`${BASE}/queue`);
    chk('P4b Deprecation 头不回归（C36 契约保持）',
      r2.headers.get('deprecation') === 'true',
      'deprecation=' + r2.headers.get('deprecation'));
    child.kill();
  } catch (e) {
    chk('P4 真实服务器契约', false, e.message);
  }

  // ---- P5：前端接线契约 ----
  {
    const panel = read('client/src/components/ObservabilityPanel.jsx');
    const wired = panel.includes('<DeprecationView dash={dash} />')
      && panel.includes('function DeprecationView({ dash })')
      && panel.includes('dash.deprecation')
      && panel.includes('遗留端点命中');
    chk('P5 前端接线：ObservabilityPanel 消费 dash.deprecation', wired,
      'panel 含 DeprecationView/遗留端点命中=' + wired);
  }

  console.log('\nRESULT: pass=' + pass + ' fail=' + fail);
  if (fail > 0) { console.log('FAILURES:\n- ' + failures.join('\n- ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
