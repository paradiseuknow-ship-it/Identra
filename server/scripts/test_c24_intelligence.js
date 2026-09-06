'use strict';
// C24 守护测试 —— 智能记忆面板 HTTP 契约（sites / flows / failures 只读出口）。
// 缺口背景：/api/ai/intelligence/* 全家桶（Flow/Element Memory、Failure Knowledge）此前 client 零消费。
// 覆盖（tmp 隔离真实服务器，零浏览器；AI_PROVIDER=mock；空库形态 + site 详情四段结构）：
//   I1 GET sites → 200 + 数组
//   I2 GET sites/:site → 200 + { site, elements, flows, failures } 四段（未知站点也给默认画像，不 404）
//   I3 GET flows → 200 + 数组
//   I4 GET failures → 200 + 数组
//   I5 GET site-profile-matrix → 200
// AI_PROVIDER=mock。

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 22130 + (process.pid % 50);
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c24-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      AI_PROVIDER: 'mock',
      FPB_DATA_DIR: dataDir,
      FPB_VAULT_FILE: path.join(dataDir, 'vault.json'),
      FPB_SETTINGS_FILE: path.join(dataDir, 'runtime_settings.json'),
      FPB_MASTER_KEY: Buffer.alloc(32, 10).toString('base64'),
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
    if (!ready) { chk('I0 服务器启动', false, logs.join('').slice(-400)); throw new Error('server not ready'); }
    chk('I0 服务器启动', true, '');

    const s = await req('GET', '/api/ai/intelligence/sites');
    chk('I1 sites → 200 + 数组', s.code === 200 && Array.isArray(JSON.parse(s.body || '[]')), s.code + ' ' + s.body.slice(0, 120));

    const d = await req('GET', '/api/ai/intelligence/sites/' + encodeURIComponent('example.com'));
    const dj = JSON.parse(d.body || '{}');
    chk('I2 site 详情四段结构', d.code === 200 && dj.site && Array.isArray(dj.elements) && Array.isArray(dj.flows) && Array.isArray(dj.failures),
      d.code + ' ' + d.body.slice(0, 200));
    chk('I2b 未知站点给默认画像（不 404）', dj.site && dj.site.riskLevel === 'unknown', JSON.stringify(dj.site).slice(0, 150));

    const f = await req('GET', '/api/ai/intelligence/flows');
    chk('I3 flows → 200 + 数组', f.code === 200 && Array.isArray(JSON.parse(f.body || '[]')), f.code + ' ' + f.body.slice(0, 120));

    const k = await req('GET', '/api/ai/intelligence/failures');
    chk('I4 failures → 200 + 数组', k.code === 200 && Array.isArray(JSON.parse(k.body || '[]')), k.code + ' ' + k.body.slice(0, 120));

    const m = await req('GET', '/api/ai/intelligence/site-profile-matrix');
    chk('I5 site-profile-matrix → 200', m.code === 200, m.code + ' ' + m.body.slice(0, 120));
  } finally {
    child.kill();
  }

  console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
  if (failures.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
