'use strict';
// C23 守护测试 —— 执行引擎面板 HTTP 契约（scheduler + worker 池 + 队列 + 资源池）。
// 缺口背景：/api/ai/execution/* 全家桶此前 client 零消费（README 宣称的 Worker 池/容量管理无 UI 出口）。
// 覆盖（tmp 隔离真实服务器，零浏览器；AI_PROVIDER=mock）：
//   E1 GET scheduler/status → 200 + status 字段
//   E2 POST scheduler/start → status 变 RUNNING；POST stop → 回 STOPPED（控制面真实生效）
//   E3 GET workers 空 → POST workers/start → 200 + worker 实体 → POST stop → 优雅停止
//   E4 GET queue → 200 + { queue, dispatches }
//   E5 GET resources → 200 + { resources, bindings }

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 22070 + (process.pid % 50);
const BASE = 'http://127.0.0.1:' + PORT;
const ROOT = path.join(__dirname, '..', '..');

function req(method, p, body) {
  return new Promise((resolve) => {
    const r = http.request(BASE + p, { method, timeout: 15000, headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ code: res.statusCode, body: d }));
    });
    r.on('error', (e) => resolve({ code: 0, body: String(e) }));
    r.on('timeout', () => { r.destroy(); resolve({ code: 0, body: 'TIMEOUT' }); });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c23-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      AI_PROVIDER: 'mock',
      FPB_DATA_DIR: dataDir,
      FPB_VAULT_FILE: path.join(dataDir, 'vault.json'),
      FPB_SETTINGS_FILE: path.join(dataDir, 'runtime_settings.json'),
      FPB_MASTER_KEY: Buffer.alloc(32, 9).toString('base64'),
      DEEPSEEK_API_KEY: '',
      OPENAI_API_KEY: '',
      AI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (c) => logs.push(String(c)));
  child.stderr.on('data', (c) => logs.push(String(c)));

  try {
    let ready = false;
    for (let i = 0; i < 40; i++) {
      const r = await req('GET', '/api/settings');
      if (r.code === 200) { ready = true; break; }
      await new Promise((s) => setTimeout(s, 300));
    }
    if (!ready) { chk('E0 服务器启动', false, logs.join('').slice(-400)); throw new Error('server not ready'); }
    chk('E0 服务器启动', true, '');

    // E1 status
    const s0 = await req('GET', '/api/ai/execution/scheduler/status');
    const s0j = JSON.parse(s0.body || '{}');
    chk('E1 scheduler/status 200 + status 字段', s0.code === 200 && typeof (s0j.status || s0j.state) === 'string', s0.code + ' ' + s0.body.slice(0, 200));

    // E2 start → RUNNING → stop → STOPPED
    const start = await req('POST', '/api/ai/execution/scheduler/start', {});
    const s1 = JSON.parse((await req('GET', '/api/ai/execution/scheduler/status')).body || '{}');
    chk('E2a scheduler start → RUNNING', start.code === 200 && (s1.status || s1.state) === 'RUNNING',
      start.code + ' status=' + (s1.status || s1.state));
    const stop = await req('POST', '/api/ai/execution/scheduler/stop', {});
    const s2 = JSON.parse((await req('GET', '/api/ai/execution/scheduler/status')).body || '{}');
    chk('E2b scheduler stop → STOPPED', stop.code === 200 && (s2.status || s2.state) === 'STOPPED',
      stop.code + ' status=' + (s2.status || s2.state));

    // E3 worker 全生命周期
    const w0 = JSON.parse((await req('GET', '/api/ai/execution/workers')).body || '{}');
    chk('E3a workers 列表 200', (await req('GET', '/api/ai/execution/workers')).code === 200 && Array.isArray(w0.workers), JSON.stringify(w0).slice(0, 120));
    const wNew = await req('POST', '/api/ai/execution/workers/start', {});
    const wNewJ = JSON.parse(wNew.body || '{}');
    const wid = wNewJ.worker && wNewJ.worker.id;
    chk('E3b worker 启动 200 + id', wNew.code === 200 && !!wid, wNew.code + ' ' + wNew.body.slice(0, 200));
    const wStop = await req('POST', '/api/ai/execution/workers/' + wid + '/stop', {});
    chk('E3c worker 优雅停止', wStop.code === 200 && JSON.parse(wStop.body || '{}').ok === true, wStop.code + ' ' + wStop.body.slice(0, 150));

    // E4 queue
    const q = await req('GET', '/api/ai/execution/queue');
    const qj = JSON.parse(q.body || '{}');
    chk('E4 queue 200 + queue/dispatches 数组', q.code === 200 && Array.isArray(qj.queue) && Array.isArray(qj.dispatches), q.body.slice(0, 150));

    // E5 resources
    const rs = await req('GET', '/api/ai/execution/resources');
    const rsj = JSON.parse(rs.body || '{}');
    chk('E5 resources 200 + resources/bindings 数组', rs.code === 200 && Array.isArray(rsj.resources) && Array.isArray(rsj.bindings), rs.body.slice(0, 150));
  } finally {
    child.kill();
  }

  console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
  if (failures.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
