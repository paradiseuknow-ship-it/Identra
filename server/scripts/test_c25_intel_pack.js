'use strict';
// C25 守护测试 —— 经验包导出/导入（/api/ai/intelligence/export|import 的 UI 出口）。
// 覆盖（tmp 隔离真实服务器，零浏览器；AI_PROVIDER=mock）：
//   P1 POST export（未知站点）→ 200 + pack 结构（不 500）
//   P2 POST import（P1 的 pack）→ 200（回灌成功）
//   P3 import 缺 pack → 400
//   P4 export 缺 site → 400

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 22190 + (process.pid % 50);
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c25-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      AI_PROVIDER: 'mock',
      FPB_DATA_DIR: dataDir,
      FPB_VAULT_FILE: path.join(dataDir, 'vault.json'),
      FPB_SETTINGS_FILE: path.join(dataDir, 'runtime_settings.json'),
      FPB_MASTER_KEY: Buffer.alloc(32, 11).toString('base64'),
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
    if (!ready) { chk('P0 服务器启动', false, logs.join('').slice(-400)); throw new Error('server not ready'); }
    chk('P0 服务器启动', true, '');

    // P1 export（未知站点）
    const exp = await req('POST', '/api/ai/intelligence/export', { site: 'guard.example', name: 'C25 守护包' });
    let pack = null;
    try { pack = JSON.parse(exp.body); } catch (e) { /* ignore */ }
    chk('P1 export → 200 + pack 结构', exp.code === 200 && pack && typeof pack === 'object' && (pack.pack || pack.site || pack.flows !== undefined || pack.meta !== undefined),
      exp.code + ' ' + exp.body.slice(0, 200));

    // P2 import 回灌
    const imp = await req('POST', '/api/ai/intelligence/import', { pack: pack && pack.pack ? pack.pack : pack });
    chk('P2 import 回灌 → 200', imp.code === 200, imp.code + ' ' + imp.body.slice(0, 200));

    // P3 import 缺 pack
    const badImp = await req('POST', '/api/ai/intelligence/import', {});
    chk('P3 import 缺 pack → 400', badImp.code === 400, badImp.code + ' ' + badImp.body.slice(0, 120));

    // P4 export 缺 site
    const badExp = await req('POST', '/api/ai/intelligence/export', {});
    chk('P4 export 缺 site → 400', badExp.code === 400, badExp.code + ' ' + badExp.body.slice(0, 120));
  } finally {
    child.kill();
  }

  console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
  if (failures.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
