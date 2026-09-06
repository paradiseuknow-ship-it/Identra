'use strict';
// C15 守护测试 —— .env 加载器（server/loadEnv.js）+ 生产模式静态服务。
//
// Part 1（子进程，FPB_ENV_FILE tmp 隔离）：
//   L1 .env 值被注入 process.env（真实 require 链路，非 eval）；
//   L2 不覆盖语义：显式 env > .env；
//   L3 引号剥除 + 注释/空行/坏行跳过。
// Part 2（子进程真实服务器 + client/dist）：
//   P1 GET / → 200 且是 SPA HTML（root div）；
//   P2 GET /profiles（SPA fallback）→ 200 HTML；
//   P3 GET /api/settings → 200 JSON（.env 加载器就位后启动链不回归）。

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}

const ROOT = path.join(__dirname, '..', '..');
const PORT = 21670 + (process.pid % 50);
const BASE = 'http://127.0.0.1:' + PORT;

function childEnvDump(envFile, preSet) {
  return new Promise((resolve) => {
    const script = `require(${JSON.stringify(path.join(ROOT, 'server', 'loadEnv.js'))});
console.log(JSON.stringify({
  A: process.env.C15_TEST_A || null,
  B: process.env.C15_TEST_B || null,
  Q: process.env.C15_TEST_Q || null,
}));`;
    const child = spawn(process.execPath, ['-e', script], {
      env: { ...process.env, FPB_ENV_FILE: envFile, ...preSet },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', () => resolve(out));
  });
}

function req(method, p) {
  return new Promise((resolve) => {
    const r = http.request(BASE + p, { method, timeout: 8000 }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ code: res.statusCode, body: d, headers: res.headers }));
    });
    r.on('error', (e) => resolve({ code: 0, body: String(e) }));
    r.on('timeout', () => { r.destroy(); resolve({ code: 0, body: 'TIMEOUT' }); });
    r.end();
  });
}

(async () => {
  // ---- Part 1: loader ----
  const envFile = path.join(os.tmpdir(), `fpb-c15-env-${process.pid}.env`);
  fs.writeFileSync(envFile, [
    '# 注释行',
    '',
    'C15_TEST_A=from-dotenv',
    'C15_TEST_B="quoted value"',
    "C15_TEST_Q='single'",
    'BROKEN LINE WITHOUT EQUALS',
    '=EMPTY_KEY',
    'C15_BAD KEY=x',
  ].join('\n'), 'utf8');

  const dump1 = await childEnvDump(envFile, {});
  let j1 = {};
  try { j1 = JSON.parse(dump1.trim().split('\n').pop()); } catch (e) { /* ignore */ }
  chk('L1 .env 值真实注入 process.env', j1.A === 'from-dotenv', dump1.slice(0, 200));

  const dump2 = await childEnvDump(envFile, { C15_TEST_A: 'explicit-wins' });
  let j2 = {};
  try { j2 = JSON.parse(dump2.trim().split('\n').pop()); } catch (e) { /* ignore */ }
  chk('L2 不覆盖语义：显式 env 优先', j2.A === 'explicit-wins' && j2.B === 'quoted value', dump2.slice(0, 200));
  chk('L3 引号剥除', j2.B === 'quoted value' && j2.Q === 'single', JSON.stringify(j2));

  // ---- Part 2: 生产静态服务 + 启动链冒烟 ----
  const distIndex = path.join(ROOT, 'client', 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) {
    chk('P1-P3 前置：client/dist 存在', false, '请先 npm run build');
  } else {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c15prod-'));
    const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      env: {
        ...process.env,
        PORT: String(PORT),
        FPB_DATA_DIR: dataDir,
        FPB_VAULT_FILE: path.join(dataDir, 'vault.json'),
        FPB_SETTINGS_FILE: path.join(dataDir, 'runtime_settings.json'),
        FPB_MASTER_KEY: Buffer.alloc(32, 5).toString('base64'),
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
      chk('P0 启动链健康（loadEnv 接入后 /api/settings 200）', ready, logs.join('').slice(-400));
      if (ready) {
        const home = await req('GET', '/');
        chk('P1 GET / → 200 SPA HTML', home.code === 200 && /<div id="root">/.test(home.body) && (home.headers['content-type'] || '').includes('text/html'), `code=${home.code} ct=${home.headers && home.headers['content-type']}`);
        const spa = await req('GET', '/profiles');
        chk('P2 SPA fallback /profiles → 200 HTML', spa.code === 200 && /<div id="root">/.test(spa.body), `code=${spa.code}`);
      }
    } finally {
      child.kill();
    }
  }

  console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
  if (fail.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
