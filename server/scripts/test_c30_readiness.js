'use strict';
// C30 守护测试 —— 系统就绪度自检（首次运行引导）。
// 覆盖（tmp 隔离真实服务器，零浏览器；AI_PROVIDER=mock）：
//   P1 GET /settings/readiness → 200 + stage/checks/auth/llm/assets/security 齐备
//   P2 空环境 → stage = SETUP_REQUIRED，必需阻塞项含 profile（auth 在本机模式自动引导故为绿）
//   P3 新建 profile 后 → profile 项转绿，llm 仍缺 → 依然 SETUP_REQUIRED
//   P4 配好 LLM 凭据后 → 三项必需全绿 → stage = READY
//   P5 秘密红线：readiness 响应体绝不出现 API Key 明文（只能有掩码）
//   P6 client 静态守护：api.js 方法 + App.jsx tab/自动引导徽标 + ReadinessPanel 组件存在

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 22510 + (process.pid % 50);
const BASE = 'http://127.0.0.1:' + PORT;
const ROOT = path.join(__dirname, '..', '..');

// 明文只在本测试内构造/比对，永不出站到任何日志
const SECRET_KEY = 'sk-readiness-guard-ABCD1234wxyz';

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
const checkOf = (data, key) => (data && Array.isArray(data.checks) ? data.checks.find((c) => c.key === key) : null);

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c30-'));
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

    // P1 契约齐备
    const r1 = await req('GET', '/api/settings/readiness');
    const d1 = j(r1);
    chk('P1 GET readiness → 200 + 六段结构',
      r1.code === 200 && d1 && Array.isArray(d1.checks) && d1.assets && d1.security && 'stage' in d1 && 'auth' in d1 && 'llm' in d1,
      r1.code + ' ' + r1.body.slice(0, 200));

    // P2 空环境：本机模式 auth 自动引导为绿；profile/llm 阻塞
    const p2 = checkOf(d1, 'profile');
    const l2 = checkOf(d1, 'llm');
    const a2 = checkOf(d1, 'auth');
    chk('P2a 空环境 → stage = SETUP_REQUIRED',
      d1 && d1.stage === 'SETUP_REQUIRED' && d1.ok === false, 'stage=' + (d1 && d1.stage));
    chk('P2b 空环境 profile 项阻塞且非可选',
      p2 && p2.ok === false && p2.optional === false, JSON.stringify(p2));
    chk('P2c 空环境 llm 项阻塞且非可选',
      l2 && l2.ok === false && l2.optional === false, JSON.stringify(l2));
    chk('P2d 本机模式 auth 项自动引导为绿',
      a2 && a2.ok === true && a2.detail.includes('local'), JSON.stringify(a2));
    chk('P2e 可选三项存在且不参与阻塞判定',
      ['template', 'proxy', 'task'].every((k) => { const c = checkOf(d1, k); return c && c.optional === true; }),
      JSON.stringify((d1 && d1.checks) || []));

    // P3 新建 profile → profile 项转绿，仍未 READY
    const cr = await req('POST', '/api/profiles', { name: 'c30-readiness-guard' });
    chk('P3a POST /profiles 建号成功', cr.code === 200 && j(cr) && j(cr).id, cr.code + ' ' + cr.body.slice(0, 160));
    const r3 = await req('GET', '/api/settings/readiness');
    const d3 = j(r3);
    chk('P3b 建号后 profile 项转绿',
      checkOf(d3, 'profile') && checkOf(d3, 'profile').ok === true, JSON.stringify(checkOf(d3, 'profile')));
    chk('P3c llm 仍缺 → 依然 SETUP_REQUIRED',
      d3 && d3.stage === 'SETUP_REQUIRED' && checkOf(d3, 'llm').ok === false, 'stage=' + (d3 && d3.stage));

    // P4 配好 LLM → 三项必需全绿 → READY
    const up = await req('PUT', '/api/settings', { provider: 'deepseek', apiKey: SECRET_KEY, model: 'deepseek-chat' });
    chk('P4a PUT /settings 写入 provider+key', up.code === 200, up.code + ' ' + up.body.slice(0, 200));
    const r4 = await req('GET', '/api/settings/readiness');
    const d4 = j(r4);
    const needOK = ['auth', 'llm', 'profile'].every((k) => checkOf(d4, k) && checkOf(d4, k).ok === true);
    chk('P4b 配好 LLM → stage = READY + 必需项全绿',
      d4 && d4.stage === 'READY' && d4.ok === true && needOK,
      'stage=' + (d4 && d4.stage) + ' checks=' + JSON.stringify((d4 && d4.checks) || []).slice(0, 300));
    chk('P4c assets.profiles ≥ 1',
      d4 && d4.assets && d4.assets.profiles >= 1, JSON.stringify(d4 && d4.assets));

    // P5 秘密红线：响应体不得含明文 key，只能有掩码
    chk('P5a readiness 绝不回传 API Key 明文',
      r4.code === 200 && !r4.body.includes(SECRET_KEY),
      'body 出现明文 key');
    chk('P5b keyMasked 存在且≠明文',
      d4 && d4.llm && d4.llm.keyMasked && d4.llm.keyMasked !== SECRET_KEY && d4.llm.keyMasked.includes('****'),
      JSON.stringify(d4 && d4.llm));

    // P6 client 静态守护
    const apiSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'api.js'), 'utf8');
    const appSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'App.jsx'), 'utf8');
    const panelPath = path.join(ROOT, 'client', 'src', 'components', 'ReadinessPanel.jsx');
    chk('P6a api.js 暴露 systemReadiness', apiSrc.includes('systemReadiness:'), 'missing');
    chk('P6b App.jsx 接入 readiness tab + 启动自检 + header 徽标',
      appSrc.includes("['readiness', '就绪检查']") && appSrc.includes('systemReadiness()') && appSrc.includes('SETUP_REQUIRED'),
      'missing');
    chk('P6c ReadinessPanel 组件存在且含六项检查渲染',
      fs.existsSync(panelPath) && fs.readFileSync(panelPath, 'utf8').includes('系统就绪度'), 'missing');
  } finally {
    child.kill();
  }

  console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
  if (failures.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
