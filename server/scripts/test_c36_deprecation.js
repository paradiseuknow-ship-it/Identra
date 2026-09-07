'use strict';
// C36 守护测试 —— 遗留端点 deprecation 标记 + readiness auth 项闭环评估。
// 覆盖（tmp 隔离真实服务器，零浏览器；AI_PROVIDER=mock）：
//   P1 GET /ai/queue → 200 + Deprecation:true + Link successor（body 结构不变，裸数组）
//   P2 GET /ai/observability/metrics → 200 + body.deprecated.successor + header
//   P3 GET /ai/events（SSE）→ 响应 headers Deprecation:true（读到头即断开）
//   P4 正常端点（GET /ai/tasks）不携带 Deprecation 标记（不误伤）
//   P5 GET /api/settings/readiness → auth 检查 ok + panel=governance（register/login UI 路径由治理中心覆盖，闭环）

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 22700 + (process.pid % 50);
const BASE = 'http://127.0.0.1:' + PORT;
const ROOT = path.join(__dirname, '..', '..');

function req(method, p, body) {
  return new Promise((resolve) => {
    const r = http.request(BASE + p, {
      method, timeout: 20000,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', (e) => resolve({ code: 0, headers: {}, body: String(e) }));
    r.on('timeout', () => { r.destroy(); resolve({ code: 0, headers: {}, body: 'TIMEOUT' }); });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
// SSE 专用：读到响应头即销毁连接
function reqHeadersOnly(p) {
  return new Promise((resolve) => {
    const r = http.request(BASE + p, { method: 'GET', timeout: 20000 }, (res) => {
      const h = { ...res.headers };
      r.destroy();
      resolve({ code: res.statusCode, headers: h });
    });
    r.on('error', () => { /* destroy 触发的 error 视为正常结束 */ });
    r.on('timeout', () => { r.destroy(); resolve({ code: 0, headers: {} }); });
    r.end();
  });
}
const j = (r) => { try { return JSON.parse(r.body); } catch (e) { return null; } };

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c36-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      AI_PROVIDER: 'mock',
      FPB_DATA_DIR: dataDir,
      FPB_VAULT_FILE: path.join(dataDir, 'vault.json'),
      FPB_SETTINGS_FILE: path.join(dataDir, 'runtime_settings.json'),
      FPB_MASTER_KEY: Buffer.alloc(32, 15).toString('base64'),
      DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', AI_API_KEY: '',
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
    if (!ready) { chk('P0 服务器启动', false, logs.join('').slice(-400)); throw new Error('server not ready'); }
    chk('P0 服务器启动', true, '');

    // P1 /ai/queue：legacy 队列 → Deprecation 标记 + 裸数组结构不变
    const q = await req('GET', '/api/ai/queue');
    const qDep = q.headers && q.headers.deprecation;
    const qLink = q.headers && q.headers.link || '';
    chk('P1 /ai/queue → 200 + Deprecation:true + Link successor + body 仍为裸数组',
      q.code === 200 && qDep === 'true' && qLink.includes('/ai/execution/queue') && Array.isArray(j(q)),
      q.code + ' dep=' + qDep + ' link=' + qLink.slice(0, 60) + ' body=' + q.body.slice(0, 60));

    // P2 /ai/observability/metrics：冗余端点 → body.deprecated + header
    const om = await req('GET', '/api/ai/observability/metrics');
    const omJ = j(om);
    chk('P2 /ai/observability/metrics → 200 + deprecated.successor + Deprecation header',
      om.code === 200 && omJ && omJ.deprecated && !!omJ.deprecated.successor && om.headers && om.headers.deprecation === 'true',
      om.code + ' ' + om.body.slice(0, 120));

    // P3 /ai/events（SSE）：读到 headers 即断开，验证标记
    const ev = await reqHeadersOnly('/api/ai/events');
    chk('P3 /ai/events SSE → headers Deprecation:true + Link 指向任务级取证流',
      ev.code === 200 && ev.headers.deprecation === 'true' && (ev.headers.link || '').includes('/ai/tasks/{id}/events'),
      ev.code + ' ' + JSON.stringify(ev.headers).slice(0, 160));

    // P4 正常端点不误伤
    const t = await req('GET', '/api/ai/tasks');
    chk('P4 GET /ai/tasks → 200 且无 Deprecation 标记（不误伤正常端点）',
      t.code === 200 && !(t.headers && t.headers.deprecation),
      t.code + ' dep=' + (t.headers && t.headers.deprecation));

    // P5 readiness auth 项闭环：local 身份自动覆盖，UI 路径 = governance 面板（register/login 无需独立登录页）
    const rd = await req('GET', '/api/settings/readiness');
    const rdJ = j(rd);
    const authChk = rdJ && Array.isArray(rdJ.checks) && rdJ.checks.find((c) => c.key === 'auth');
    chk('P5 readiness auth 检查 ok=true + panel=governance + kind=local（本地单机自动身份闭环）',
      rd.code === 200 && rdJ && rdJ.auth && authChk && authChk.ok === true && authChk.panel === 'governance' && rdJ.auth.kind === 'local',
      rd.code + ' auth=' + JSON.stringify(rdJ && rdJ.auth).slice(0, 120) + ' check=' + JSON.stringify(authChk).slice(0, 120));
  } catch (e) {
    chk('未预期异常', false, String(e && e.message || e));
  } finally {
    try { child.kill(); } catch (e2) { /* ignore */ }
  }

  console.log('---');
  console.log('PASS=' + pass + ' FAIL=' + fail);
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})();
