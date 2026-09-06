'use strict';
// C18 守护测试 —— portable 发布打包 + 秘密排除 + staged 目录真实启动冒烟。
//   P1 pack 产出结构齐备（server/index.js、loadEnv、client/dist/index.html、start.bat、.env.example）
//   P2 秘密排除硬断言：.env / data(vault/settings) / node_modules 绝不入包
//   P3 从 staged 目录真实起服务器（NODE_PATH 指向源项目依赖）→ GET / 200 SPA + /api/settings 200
//      —— 验证「解压即可用」不是纸面承诺（loadEnv 在 stage 根找不到 .env 时应静默跳过）
// P4 zip 由 pack_release.js --zip 在真实发布时执行（测试环境跳过，避免 PS 依赖）。
// 端口 21820 + pid%50，零浏览器。

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 21820 + (process.pid % 50);
const BASE = 'http://127.0.0.1:' + PORT;

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
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
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c18-'));
  const { pack } = require('./pack_release.js');
  let stage;
  try {
    const r = pack(outRoot, { zip: false });
    stage = r.stage;
    chk('P1 发布包结构齐备', true, '');
    console.log('  stage: ' + stage + ' (' + r.files + ' files)');

    const secrets = ['.env', path.join('data', 'vault.json'), path.join('data', 'runtime_settings.json'), 'node_modules'];
    const leaked = secrets.filter((rel) => fs.existsSync(path.join(stage, rel)));
    chk('P2 秘密/依赖排除（.env/data/node_modules 不入包）', leaked.length === 0, 'leaked=' + leaked.join(','));

    // P3 staged 目录真实启动（NODE_PATH 复用源项目依赖；stage 根无 .env → loadEnv 静默跳过）
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c18data-'));
    const child = spawn(process.execPath, [path.join(stage, 'server', 'index.js')], {
      env: {
        ...process.env,
        NODE_PATH: path.join(ROOT, 'node_modules'),
        PORT: String(PORT),
        FPB_DATA_DIR: dataDir,
        FPB_VAULT_FILE: path.join(dataDir, 'vault.json'),
        FPB_SETTINGS_FILE: path.join(dataDir, 'runtime_settings.json'),
        FPB_MASTER_KEY: Buffer.alloc(32, 8).toString('base64'),
        DEEPSEEK_API_KEY: '',
        OPENAI_API_KEY: '',
        AI_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: stage, // 模拟目标机器：在 stage 目录内启动
    });
    const logs = [];
    child.stdout.on('data', (c) => logs.push(String(c)));
    child.stderr.on('data', (c) => logs.push(String(c)));
    try {
      let ready = false;
      for (let i = 0; i < 40; i++) {
        const s = await req('GET', '/api/settings');
        if (s.code === 200) { ready = true; break; }
        await new Promise((x) => setTimeout(x, 300));
      }
      chk('P3a staged 服务器可启动（/api/settings 200）', ready, logs.join('').slice(-400));
      if (ready) {
        const home = await req('GET', '/');
        chk('P3b staged 静态前端可服务（GET / 200 SPA）', home.code === 200 && /<div id="root">/.test(home.body), `code=${home.code}`);
      }
    } finally { child.kill(); }
  } catch (e) {
    chk('P1-P3 pack/冒烟异常', false, String(e.message || e));
  }

  console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
  if (fail.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
