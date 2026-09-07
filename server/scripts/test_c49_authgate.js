'use strict';
// C49 守护测试 —— 多用户模式（Mode B / FPB_API_TOKEN）Web UI 登录闭环。
// 缺口背景：Mode B 下无有效身份时全部 API 401，而 client 零 register/login 消费 →
//   Web UI 死锁（readiness auth 项 hint 引导去治理中心，但治理中心本身也 401）。
// 覆盖（tmp 隔离真实服务器 ×2，零浏览器；AI_PROVIDER=mock）：
//   Mode B 行为链（服务端契约 = AuthGate 依赖的真实行为）：
//   R1  无凭据 GET /settings/readiness     → 401（App 启动探测触发登录门控的依据）
//   R2  无凭据 GET /auth/me                → 401（治理中心同样打不开 = 死锁实证）
//   R3  register 弱密码/坏用户名           → 400（服务端约束真实存在，前端提示有依据）
//   R4  register 合法                      → 201 + workspaceId（注册即赠个人工作区）
//   R5  login 错误密码                     → 401（不区分「不存在」与「密码错」）
//   R6  login 合法                         → 200 + token（会话凭据）
//   R7  Bearer + GET /auth/me              → 200（req 层 Authorization 透传契约）
//   R8  Bearer + readiness                 → 200 + auth.kind=session + auth 检查项 ok
//       （C30 auth 检查项「闭环待查」正式闭环：多用户模式登录后必需项转绿）
//   R9  logout → 二次 me                   → 401（会话真实销毁，非前端单方面丢弃）
//   Mode A 回归（本地单机不受 C49 影响）：
//   R10 无任何凭据 readiness               → 200（loopback 自动挂 local 用户）
//   R11 Mode A 下携带无效 Bearer           → 仍 200（客户端恒附加 token 的安全性证明）
//   Client 静态守护（防接线漂移）：
//   R12 api.js token 层 + 三方法；AuthGate 消费 api.login/register；
//       App.jsx 门控接线（401 探测 / AuthGate 渲染 / 退出登录）

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 22460 + (process.pid % 50);
const PORT_A = PORT + 200;
const ROOT = path.join(__dirname, '..', '..');

function req(port, method, p, body, token) {
  return new Promise((resolve) => {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = http.request('http://127.0.0.1:' + port + p, { method, timeout: 15000, headers }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ code: res.statusCode, body: d }));
    });
    r.on('error', (e) => resolve({ code: 0, body: String(e) }));
    r.on('timeout', () => { r.destroy(); resolve({ code: 0, body: 'TIMEOUT' }); });
    if (body !== undefined) r.write(JSON.stringify(body));
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

function bootServer(port, dataDir, extraEnv) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      AI_PROVIDER: 'mock',
      FPB_DATA_DIR: dataDir,
      FPB_VAULT_FILE: path.join(dataDir, 'vault.json'),
      FPB_SETTINGS_FILE: path.join(dataDir, 'runtime_settings.json'),
      FPB_MASTER_KEY: Buffer.alloc(32, 12).toString('base64'),
      DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', AI_API_KEY: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (c) => logs.push(String(c)));
  child.stderr.on('data', (c) => logs.push(String(c)));
  return { child, logs };
}

async function waitReady(port, logs) {
  for (let i = 0; i < 40; i++) {
    const r = await req(port, 'GET', '/api/auth/me');
    if (r.code === 200 || r.code === 401) return true;
    await new Promise((s) => setTimeout(s, 300));
  }
  return false;
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c49-'));

  // ---- Mode B：FPB_API_TOKEN 部署（多用户语义）----
  const b = bootServer(PORT, dataDir, { FPB_API_TOKEN: 'c49-machine-token' });
  try {
    if (!(await waitReady(PORT, b.logs))) { chk('R0 服务器启动(Mode B)', false, b.logs.join('').slice(-400)); throw new Error('server not ready'); }
    chk('R0 服务器启动(Mode B)', true, '');

    // R1 无凭据 readiness → 401（App 启动探测触发门控的依据）
    const r1 = await req(PORT, 'GET', '/api/settings/readiness');
    chk('R1 Mode B 无凭据 readiness → 401', r1.code === 401, r1.code + ' ' + r1.body.slice(0, 120));

    // R2 无凭据 /auth/me → 401（治理中心死锁实证）
    const r2 = await req(PORT, 'GET', '/api/auth/me');
    chk('R2 Mode B 无凭据 /auth/me → 401', r2.code === 401, r2.code + ' ' + r2.body.slice(0, 120));

    // R3 服务端注册约束真实存在
    const r3a = await req(PORT, 'POST', '/api/auth/register', { username: 'ab', password: 'longenough1' });
    const r3b = await req(PORT, 'POST', '/api/auth/register', { username: 'alice49', password: 'short1' });
    chk('R3 register 弱约束 → 400', r3a.code === 400 && r3b.code === 400,
      r3a.code + '/' + r3b.code + ' ' + r3a.body.slice(0, 100) + ' ' + r3b.body.slice(0, 100));

    // R4 合法注册 → 201 + 个人工作区
    const r4 = await req(PORT, 'POST', '/api/auth/register', { username: 'alice49', password: 'alice49-pass-1', email: 'a49@example.com' });
    const b4 = j(r4);
    chk('R4 register → 201 + workspaceId', r4.code === 201 && !!(b4 && b4.workspaceId), r4.code + ' ' + r4.body.slice(0, 160));

    // R5 错误密码 → 401
    const r5 = await req(PORT, 'POST', '/api/auth/login', { username: 'alice49', password: 'wrong-pass-999' });
    chk('R5 login 错误密码 → 401', r5.code === 401, r5.code + ' ' + r5.body.slice(0, 120));

    // R6 合法登录 → token
    const r6 = await req(PORT, 'POST', '/api/auth/login', { username: 'alice49', password: 'alice49-pass-1' });
    const b6 = j(r6);
    const token = b6 && b6.token;
    chk('R6 login → 200 + token', r6.code === 200 && !!token, r6.code + ' ' + r6.body.slice(0, 120));

    // R7 Bearer + me → 200（req 层 Authorization 契约）
    const r7 = await req(PORT, 'GET', '/api/auth/me', undefined, token);
    const b7 = j(r7);
    chk('R7 Bearer /auth/me → 200', r7.code === 200 && b7 && b7.user && b7.user.username === 'alice49',
      r7.code + ' ' + r7.body.slice(0, 160));

    // R8 Bearer + readiness → auth 检查项闭环（kind=session）
    const r8 = await req(PORT, 'GET', '/api/settings/readiness', undefined, token);
    const b8 = j(r8);
    const authCheck = b8 && b8.checks && b8.checks.find((c) => c.key === 'auth');
    chk('R8 readiness(Bearer) → 200 + auth.kind=session', r8.code === 200 && b8 && b8.auth && b8.auth.kind === 'session',
      r8.code + ' ' + JSON.stringify(b8 && b8.auth).slice(0, 160));
    chk('R8b auth 检查项 ok=true（C30 待查项闭环）', !!authCheck && authCheck.ok === true,
      JSON.stringify(authCheck).slice(0, 200));

    // R9 logout 真实销毁会话
    const r9 = await req(PORT, 'POST', '/api/auth/logout', {}, token);
    const r9b = await req(PORT, 'GET', '/api/auth/me', undefined, token);
    chk('R9 logout → me 401', r9.code === 200 && r9b.code === 401, r9.code + '/' + r9b.code);
  } finally {
    b.child.kill();
  }

  // ---- Mode A：本地单机（默认），C49 零影响回归 ----
  const a = bootServer(PORT_A, dataDir, {});
  try {
    if (!(await waitReady(PORT_A, a.logs))) { chk('R10 服务器启动(Mode A)', false, a.logs.join('').slice(-400)); throw new Error('server not ready'); }
    const r10 = await req(PORT_A, 'GET', '/api/settings/readiness');
    const b10 = j(r10);
    chk('R10 Mode A 无凭据 readiness → 200（local 自动挂载）', r10.code === 200 && b10 && b10.auth && b10.auth.kind === 'local',
      r10.code + ' ' + JSON.stringify(b10 && b10.auth).slice(0, 160));
    const r11 = await req(PORT_A, 'GET', '/api/settings/readiness', undefined, 'stale-invalid-token');
    chk('R11 Mode A 无效 Bearer 仍 → 200（客户端恒附加 token 安全）', r11.code === 200, r11.code + ' ' + r11.body.slice(0, 120));
  } finally {
    a.child.kill();
  }

  // ---- R12 client 静态守护 ----
  const apiSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'api.js'), 'utf8');
  chk('R12a api.js token 层（getAuthToken/setAuthToken + Bearer 附加 + status 透传）',
    apiSrc.includes('export function getAuthToken') && apiSrc.includes('export function setAuthToken')
    && apiSrc.includes("'Bearer ' + token") && apiSrc.includes('err.status = res.status'), 'api.js');
  chk('R12b api.js 导出 login/register/logout', ['login:', 'register:', 'logout:'].every((k) => apiSrc.includes(k)), 'api.js');
  const gateSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'AuthGate.jsx'), 'utf8');
  chk('R12c AuthGate 消费 api.login/api.register/setAuthToken',
    gateSrc.includes('api.login') && gateSrc.includes('api.register') && gateSrc.includes('setAuthToken'), 'AuthGate.jsx');
  const appSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'App.jsx'), 'utf8');
  chk('R12d App 接线（401 探测→门控 / AuthGate 渲染 / 退出登录）',
    appSrc.includes('e.status === 401') && appSrc.includes('<AuthGate onAuthed={handleAuthed} />')
    && appSrc.includes('doLogout') && appSrc.includes('hasSession'), 'App.jsx');

  console.log('\n==== C49 SUMMARY: ' + pass + ' pass / ' + fail + ' fail ====');
  if (failures.length) { console.log('FAILURES:\n' + failures.join('\n')); process.exit(1); }
  process.exit(0);
})();
