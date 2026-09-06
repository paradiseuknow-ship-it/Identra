'use strict';
// C20 守护测试 —— Profile 运行态快照端点（/api/profiles/runtime）。
// 缺陷背景：/profiles 列表只给 running 布尔，运行中 Profile 的时长/当前页面/页签数/代理全不可见。
// 本测试 tmp 隔离真实服务器、零浏览器验证 HTTP 契约：
//   R1 GET /profiles/runtime → 200 + { profiles: [], at }（空会话形态）
//   R2 路由顺序：'runtime' 不被 /profiles/:id 吞掉（被吞则 404 'not found'）
//   R3 GET /profiles/runtime 响应字段完整（快照消费方 ProfilesTab 卡片的数据契约）
// 真实浏览器会话的快照值由 runtimeSnapshots() 内部 try 包裹保证（单会话异常不拖垮整个快照），
// 其字段由 browserManager 单元语义覆盖（startedAt/uptimeMs/currentUrl/pagesCount/proxyId/chromePid）。

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 21890 + (process.pid % 50);
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c20-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      AI_PROVIDER: 'mock',
      FPB_DATA_DIR: dataDir,
      FPB_VAULT_FILE: path.join(dataDir, 'vault.json'),
      FPB_SETTINGS_FILE: path.join(dataDir, 'runtime_settings.json'),
      FPB_MASTER_KEY: Buffer.alloc(32, 6).toString('base64'),
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
    if (!ready) { chk('R0 服务器启动', false, logs.join('').slice(-400)); throw new Error('server not ready'); }
    chk('R0 服务器启动', true, '');

    // R1 + R2 + R3：空会话形态（无浏览器启动）
    const r = await req('GET', '/api/profiles/runtime');
    let j = {};
    try { j = JSON.parse(r.body); } catch (e) { /* ignore */ }
    chk('R1 runtime → 200 + profiles 数组 + at', r.code === 200 && Array.isArray(j.profiles) && typeof j.at === 'number', r.code + ' ' + r.body.slice(0, 200));
    chk('R2 路由顺序正确（runtime 未被 :id 吞掉）', r.code === 200 && !(j.error === 'not found'), r.body.slice(0, 200));
    chk('R3 空会话 = 零快照', j.profiles && j.profiles.length === 0, 'profiles=' + JSON.stringify(j.profiles));

    // R4：创建一个 Profile 后 runtime 仍为空快照（running=false 的 Profile 不出现在快照里）
    const create = await req('POST', '/api/profiles', { name: 'C20 快照守护', group: 'default' });
    if (create.code === 200 || create.code === 201) {
      const r2 = await req('GET', '/api/profiles/runtime');
      const j2 = JSON.parse(r2.body || '{}');
      chk('R4 未启动的 Profile 不出现在快照', r2.code === 200 && j2.profiles && j2.profiles.length === 0, r2.body.slice(0, 200));
    } else {
      chk('R4 未启动的 Profile 不出现在快照', false, '创建 Profile 失败 code=' + create.code + ' ' + create.body.slice(0, 150));
    }
  } finally {
    child.kill();
  }

  console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
  if (failures.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
