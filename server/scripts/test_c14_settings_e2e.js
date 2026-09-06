'use strict';
// C14 端到端冒烟守护 —— 设置中心真实 HTTP 链路（2026-09-07）。
// server/scripts/test_c14_settings.js 是模块级单测；本测试持久化端到端验证：
//   E1 服务器可启动（FPB_DATA_DIR/FPB_VAULT_FILE/FPB_SETTINGS_FILE tmp 隔离）
//   E2 PUT /api/settings 保存 apiKey → 200 + set=true，响应掩码不泄漏明文
//   E3 GET /api/settings env 对账：DEEPSEEK_API_KEY overriddenBySettings=true
//   E4 POST /api/settings/test 假 key → 干净失败（HTTP_401/NETWORK_ERROR，不冒泡 500）
//   E5 落盘 runtime_settings.json 不含明文 key
// 纯 HTTP 验证，零浏览器、零外网依赖（test 用假 key 指向官方域名也会干净失败，
// 但为避免真实外网依赖，E4 接受 401 或本地不可达两种干净失败形态）。
// 端口取 21620 + pid%50 避开既有测试段。

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 21620 + (process.pid % 50);
const BASE = 'http://127.0.0.1:' + PORT;

function req(method, p, body) {
  return new Promise((resolve) => {
    const r = http.request(BASE + p, { method, timeout: 8000, headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
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

async function main() {
  let pass = 0, fail = 0;
  const failures = [];
  const chk = (name, ok, detail) => {
    if (ok) { pass++; console.log('PASS ' + name); }
    else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
  };

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c14e2e-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      FPB_DATA_DIR: dataDir,
      FPB_VAULT_FILE: path.join(dataDir, 'vault.json'),
      FPB_SETTINGS_FILE: path.join(dataDir, 'runtime_settings.json'),
      FPB_MASTER_KEY: Buffer.alloc(32, 9).toString('base64'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (c) => logs.push(String(c)));
  child.stderr.on('data', (c) => logs.push(String(c)));

  try {
    // 等待就绪
    let ready = false;
    for (let i = 0; i < 40; i++) {
      const r = await req('GET', '/api/settings');
      if (r.code === 200) { ready = true; break; }
      await new Promise((s) => setTimeout(s, 300));
    }
    chk('E1 服务器启动且 GET /api/settings 200', ready, logs.join('').slice(-500));

    if (ready) {
      const KEY = 'sk-c14e2e-abcdef123456';
      const put = await req('PUT', '/api/settings', { apiKey: KEY, model: 'deepseek-chat' });
      let putJson = null;
      try { putJson = JSON.parse(put.body); } catch (e) { /* ignore */ }
      chk('E2 PUT 保存 apiKey 200 + set=true', put.code === 200 && putJson && putJson.settings && putJson.settings.llm.apiKey.set === true, put.body.slice(0, 200));
      chk('E2b PUT 响应掩码不泄漏明文', !put.body.includes(KEY), (putJson && putJson.settings.llm.apiKey.masked) || 'null');

      const get = await req('GET', '/api/settings');
      let g = null;
      try { g = JSON.parse(get.body); } catch (e) { /* ignore */ }
      const row = g && g.env && g.env.find((x) => x.env === 'DEEPSEEK_API_KEY');
      chk('E3 env 对账 overriddenBySettings=true', !!(row && row.overriddenBySettings === true && row.effectiveMasked && row.effectiveMasked.includes('3456')), get.body.slice(0, 400));

      const test = await req('POST', '/api/settings/test', {});
      let tj = null;
      try { tj = JSON.parse(test.body); } catch (e) { /* ignore */ }
      // 假 key：DeepSeek 真实端点会回 401；无外网时干净返回 NETWORK_ERROR/TIMEOUT。两者都算干净失败。
      const cleanFail = test.code === 200 && tj && tj.ok === false && (tj.error === 'HTTP_401' || tj.error === 'NETWORK_ERROR' || tj.error === 'TIMEOUT');
      chk('E4 testLlm 假 key 干净失败（不冒泡 500）', cleanFail, test.body.slice(0, 200));

      const settingsFile = path.join(dataDir, 'runtime_settings.json');
      const raw = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : '';
      chk('E5 落盘文件无明文 key', raw.length > 0 && !raw.includes(KEY), 'file=' + settingsFile);
    }
  } finally {
    child.kill();
  }

  console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
  if (fail.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
