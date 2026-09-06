'use strict';
// C16 守护测试 —— LLM key 缺失 fail-fast + mock 静默陷阱消除（2026-09-07）。
// 缺陷背景：AI_PROVIDER=auto（缺省）且无任何 key 时，/api/ai/chat 静默走 mock
// provider 返回"假计划"，用户无感知。修复后：
//   G1 无 key + auto → 409 NO_LLM_KEY + 可行动文案（不落库不执行）
//   G2 显式 AI_PROVIDER=mock → 不拦截（开发/测试路径保留）
//   G3 settings 配置 key（PUT /api/settings）后 → 不再 409（即时生效链路）
//   G4 GET /api/ai/health provider 报告真实状态（mock/deepseek）
// 真实 HTTP 链路，tmp 隔离，零浏览器。端口 21720 + pid%50。

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 21720 + (process.pid % 50);
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

function startServer(extraEnv) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c16-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      FPB_DATA_DIR: dataDir,
      FPB_VAULT_FILE: path.join(dataDir, 'vault.json'),
      FPB_SETTINGS_FILE: path.join(dataDir, 'runtime_settings.json'),
      FPB_MASTER_KEY: Buffer.alloc(32, 3).toString('base64'),
      // 守护前置：剥掉宿主可能带有的 LLM key，保证「无 key」前提真实成立
      DEEPSEEK_API_KEY: '',
      OPENAI_API_KEY: '',
      AI_API_KEY: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (c) => logs.push(String(c)));
  child.stderr.on('data', (c) => logs.push(String(c)));
  return { child, logs, dataDir };
}

async function waitReady() {
  for (let i = 0; i < 40; i++) {
    const r = await req('GET', '/api/settings');
    if (r.code === 200) return true;
    await new Promise((s) => setTimeout(s, 300));
  }
  return false;
}

const CHAT_BODY = JSON.stringify({ message: '打开 http://example.com 首页' });

function chatOnce() {
  return new Promise((resolve) => {
    const r = http.request(BASE + '/api/ai/chat', { method: 'POST', timeout: 20000, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ code: res.statusCode, body: d }));
    });
    r.on('error', (e) => resolve({ code: 0, body: String(e) }));
    r.on('timeout', () => { r.destroy(); resolve({ code: 0, body: 'TIMEOUT' }); });
    r.write(CHAT_BODY);
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
  // ---- 场景 1：无 key（auto）----
  let s = startServer({});
  try {
    if (!(await waitReady())) {
      chk('S1 服务器启动', false, s.logs.join('').slice(-400));
    } else {
      const health = await req('GET', '/api/ai/health');
      let h = {};
      try { h = JSON.parse(health.body); } catch (e) { /* ignore */ }
      chk('G4 无 key 时 health.provider=mock', health.code === 200 && h.provider === 'mock', health.body.slice(0, 200));

      const chat = await chatOnce();
      let j = {};
      try { j = JSON.parse(chat.body); } catch (e) { /* ignore */ }
      chk('G1 无 key + auto → 409 NO_LLM_KEY + 可行动文案',
        chat.code === 409 && j.code === 'NO_LLM_KEY' && /系统设置/.test(j.error || ''),
        `code=${chat.code} body=${chat.body.slice(0, 220)}`);
    }
  } finally { s.child.kill(); await new Promise((r) => setTimeout(r, 500)); }

  // ---- 场景 2：显式 AI_PROVIDER=mock（开发路径不拦截）----
  s = startServer({ AI_PROVIDER: 'mock' });
  try {
    if (!(await waitReady())) {
      chk('S2 服务器启动(mock)', false, s.logs.join('').slice(-400));
    } else {
      const chat = await chatOnce();
      chk('G2 显式 AI_PROVIDER=mock → 不拦截（非 409）', chat.code !== 409, `code=${chat.code} body=${chat.body.slice(0, 200)}`);
    }
  } finally { s.child.kill(); await new Promise((r) => setTimeout(r, 500)); }

  // ---- 场景 3：settings 配置 key 后即时放行 ----
  s = startServer({});
  try {
    if (!(await waitReady())) {
      chk('S3 服务器启动', false, s.logs.join('').slice(-400));
    } else {
      const before = await chatOnce();
      chk('G3a 配置前 409', before.code === 409, `code=${before.code}`);
      // settings 保存 key（真实生效链路：加密落盘 + applyToEnv 覆盖进程 env）
      const put = await req('PUT', '/api/settings', { apiKey: 'sk-c16-guard-fake-key-000' });
      if (put.code !== 200) {
        chk('G3b PUT settings 200', false, put.body.slice(0, 200));
      } else {
        const after = await chatOnce();
        // key 是假的：放行后 deepseek 调用会失败，但绝不能再是 409 NO_LLM_KEY（守卫已让位）
        let j = {};
        try { j = JSON.parse(after.body); } catch (e) { /* ignore */ }
        chk('G3c 配置后不再 409（key 即时生效）', after.code !== 409, `code=${after.code} body=${after.body.slice(0, 200)}`);
        const health = await req('GET', '/api/ai/health');
        let h = {};
        try { h = JSON.parse(health.body); } catch (e) { /* ignore */ }
        chk('G4b 配置后 health.provider=deepseek', health.code === 200 && h.provider === 'deepseek', health.body.slice(0, 200));
      }
    }
  } finally { s.child.kill(); }

  console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
  if (fail.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
