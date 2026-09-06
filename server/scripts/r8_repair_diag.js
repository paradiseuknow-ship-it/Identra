#!/usr/bin/env node
// R8 诊断采样驱动：对 repair 方差场景逐个跑单任务（E3_1_DIAG=1 全打点 + planner capture）。
// 用途：只读取证 repair 失败模式，非 benchmark；结果落 .benchmark/r8_diag/。
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const P9 = require('./phase10Benchmark');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '.benchmark', 'r8_diag');
const TARGETS = ['rw.026', 'rw.030', 'rw.087', 'rw.050', 'rw.091'];
const HARD_DEADLINE_MS = 300000; // worker 内 240s + 余量

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const mock = await P9.startMockServer();
  console.log('[r8] mock server port=' + mock.port);
  const summary = [];
  for (const id of TARGETS) {
    const logFile = path.join(OUT, id + '.log');
    const out = fs.openSync(logFile, 'w');
    const env = {
      ...process.env,
      E3_1_DIAG: '1',
      FPB_SCENARIO_DIR: 'server/scenarios/real-world-v2',
      FPB_POOL_FILE: 'phase12_pool_v2.json',
      FPB_CAPTURE_PLAN_DIR: path.join(OUT, 'plans_' + id),
    };
    const t0 = Date.now();
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(ROOT, 'server', 'scripts', 'phase12_task_worker.js'), '--task', id, '--port', String(mock.port)], { cwd: ROOT, env, stdio: ['ignore', out, out] });
      const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, HARD_DEADLINE_MS);
      child.on('exit', (c) => { clearTimeout(killer); resolve(c); });
      child.on('error', () => { clearTimeout(killer); resolve(-1); });
    });
    const rec = { id, exitCode: code, wallSec: Math.round((Date.now() - t0) / 1000) };
    try {
      const line = fs.readFileSync(logFile, 'utf8').split('\n').find((l) => l.startsWith('WORKER_RESULT:'));
      if (line) { const r = JSON.parse(line.slice('WORKER_RESULT:'.length)); rec.status = r.status; rec.repair = r.repairCount + '/' + r.repairSuccess; rec.verif = r.verificationPassed + '/' + r.verificationTotal; }
    } catch (e) {}
    summary.push(rec);
    console.log('[r8] ' + JSON.stringify(rec));
  }
  try { mock.server.close(); } catch (e) {}
  fs.writeFileSync(path.join(OUT, 'SUMMARY.json'), JSON.stringify(summary, null, 1));
  console.log('[r8] DONE -> ' + path.join(OUT, 'SUMMARY.json'));
})();
