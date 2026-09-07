'use strict';
// C33 守护测试 —— 执行引擎操作收尾（端点×UI 对账最后一批操作缺口）。
// 覆盖（tmp 隔离真实服务器，零浏览器；AI_PROVIDER=mock）：
//   P1 POST /execution/resources/recover → 200 + ok:true + actions 数组 + summary
//   P2 POST /execution/scheduler/tick → 200 + ok:true + tick 计数推进（未启动状态也可手动 tick）
//   P3 recover 心跳超时参数透传（超大超时 → 无动作回收，不误伤活绑定）
//   P4 client 静态守护：api.js resourceRecover + ExecutionPanel「僵尸资源回收 / 单次 tick」

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 22550 + (process.pid % 50);
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
      res.on('end', () => resolve({ code: res.statusCode, body: d }));
    });
    r.on('error', (e) => resolve({ code: 0, body: String(e) }));
    r.on('timeout', () => { r.destroy(); resolve({ code: 0, body: 'TIMEOUT' }); });
    if (body) r.write(JSON.stringify(body));
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c33-'));
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

    // P1 recover 契约
    const r1 = await req('POST', '/api/ai/execution/resources/recover', {});
    const d1 = j(r1);
    chk('P1 POST resources/recover → 200 + ok:true + actions/summary',
      r1.code === 200 && d1 && d1.ok === true && Array.isArray(d1.actions) && d1.summary,
      r1.code + ' ' + r1.body.slice(0, 200));

    // P2 手动 tick（调度器未启动也必须可手动推进）
    const t0 = await req('POST', '/api/ai/execution/scheduler/tick', {});
    const t0J = j(t0);
    const t1 = await req('POST', '/api/ai/execution/scheduler/tick', {});
    const t1J = j(t1);
    chk('P2a POST scheduler/tick → 200 + ok:true',
      t0.code === 200 && t0J && t0J.ok === true && typeof t0J.tick === 'number',
      t0.code + ' ' + t0.body.slice(0, 160));
    chk('P2b 连续两次 tick 计数单调递增',
      t1.code === 200 && t1J && t1J.ok === true && t1J.tick > t0J.tick,
      'tick0=' + (t0J && t0J.tick) + ' tick1=' + (t1J && t1J.tick));

    // P3 超大心跳超时 → 不误伤（空池下 actions 仍为数组且为空）
    const r3 = await req('POST', '/api/ai/execution/resources/recover', { heartbeatTimeoutMs: 24 * 3600 * 1000 });
    const d3 = j(r3);
    chk('P3 超大心跳超时不误伤（空池 actions=[]）',
      r3.code === 200 && d3 && d3.ok === true && Array.isArray(d3.actions) && d3.actions.length === 0,
      r3.code + ' ' + r3.body.slice(0, 200));

    // P4 client 静态守护
    const apiSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'api.js'), 'utf8');
    const uiSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'ExecutionPanel.jsx'), 'utf8');
    chk('P4a api.js 暴露 resourceRecover', apiSrc.includes('resourceRecover:'), 'missing');
    const needUi = ['僵尸资源回收', 'runResourceRecover', '单次 tick', 'heartbeatTimeoutMs'];
    const missUi = needUi.filter((m) => !uiSrc.includes(m));
    chk('P4b ExecutionPanel 补齐资源回收 + 手动 tick', missUi.length === 0, 'missing=' + missUi.join(' / '));
  } finally {
    child.kill();
  }

  console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
  if (failures.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
