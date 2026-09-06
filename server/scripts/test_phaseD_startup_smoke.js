'use strict';
// Phase D 启动冒烟守护（2026-09-06）。
// 背景：Phase D 启动实测抓到 A 类交付缺陷（GET /api/profiles 500 —— vault 解密失败冒泡，
// 新环境首启必踩），修复后该验证只做过一次手工执行。本测试将其持久化：
//   S1 服务器可启动（FPB_DATA_DIR/FPB_VAULT_FILE tmp 隔离 + 固定测试主密钥）
//   S2 GET / 与 GET /api/profiles 返回 200（vault fail-soft 不回退）
//   S3 进程可干净终止
// 纯 HTTP 验证，零浏览器启动，目标 <10s。端口取 21570 + pid%50 避开既有测试段。

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 21570 + (process.pid % 50);
const BASE = 'http://127.0.0.1:' + PORT;

function get(p) {
  return new Promise((resolve) => {
    const req = http.get(BASE + p, { timeout: 4000 }, (res) => {
      res.resume();
      resolve({ code: res.statusCode });
    });
    req.on('error', () => resolve({ code: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ code: 0 }); });
  });
}

async function main() {
  let pass = 0, fail = 0;
  const failures = [];
  const assert = (name, ok, detail) => {
    if (ok) { pass++; console.log('PASS ' + name); }
    else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
  };

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp16b-dsmoke-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      FPB_DATA_DIR: dataDir,
      FPB_VAULT_FILE: path.join(dataDir, 'vault.json'),
      FPB_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (c) => logs.push(c.toString()));
  child.stderr.on('data', (c) => logs.push(c.toString()));

  // S1: 等待就绪（最多 20s）
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const r = await get('/');
    up = r.code === 200;
  }
  assert('S1 服务器可启动（tmp 数据目录 + 固定主密钥）', up,
    up ? '' : '20s 未就绪; log=' + logs.slice(-5).join('|').slice(0, 300));

  if (up) {
    // S2: 关键端点 200 —— /api/profiles 曾因 vault 解密失败整端点 500（A 类已修，fail-soft 守护）
    const root = await get('/');
    const profiles = await get('/api/profiles');
    assert('S2 GET / 200', root.code === 200, String(root.code));
    assert('S2 GET /api/profiles 200（vault fail-soft 不回退）', profiles.code === 200, String(profiles.code));
  }

  // S3: 干净终止
  child.kill();
  const exited = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 5000);
    child.on('exit', () => { clearTimeout(t); resolve(true); });
  });
  if (!exited) { try { child.kill('SIGKILL'); } catch (e) {} }
  assert('S3 服务器进程可干净终止', exited, String(exited));

  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}

  console.log('');
  console.log('RESULT pass=' + pass + ' fail=' + fail);
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
