'use strict';
// C81 守护测试 —— 扫尾批（server/automation/ + server/security/ + client 小组件 + index.js 对账补丁）：
//   D1 (B 类)：PUT /api/proxies/:id 不检测 masked 密码 —— GET 列表返回 '••••••'+尾2
//     掩码（getProxiesPublic），客户端编辑表单回填后原样提交 → 掩码串被 vault.encrypt
//     落盘**永久覆盖真实密码**（下次连接代理 401，凭据静默损坏）。
//     修复：掩码开头 = 客户端未改密码 → delete body.password 保留原值。
//   D2 (B 类)：client ProxyPanel startEdit 回填掩码进表单（客户端侧双层防御）——
//     修复：不回填 password（留空=保持不变，saveEdit 空值不提交该字段）。
//   D3 (B 类)：automation/engine.js selectOption 日志记录解析后的实际值 ——
//     value 可能是 {{card.number}}/{{password}} 等 vault 解密明文，进工作流日志（UI/LLM 面）。
//     修复：与 fill 同口径记长度。
//   D4 (B 类)：engine freshPage 新开 page 成功/异常路径都不 close —— 游离 page 累积。
//     修复：内层 finally page.close()。
//   D5 (C 类)：extract 的 textContent 可返回 null → txt.trim() TypeError。
// 零浏览器：P1 tmp 隔离真实服务器（Mode A + vault 密钥固定）；P2 子进程 require.cache
//   注入 fake browserManager/db + fake page（记录调用，不真启动 Chromium）。
'use strict';
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 22910 + (process.pid % 50);
const ROOT = path.join(__dirname, '..', '..');
const here = __dirname.replace(/\\/g, '/');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}

function req(method, p, body, token) {
  return new Promise((resolve) => {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = http.request('http://127.0.0.1:' + PORT + p, { method, timeout: 20000, headers }, (res) => {
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

function bootServer(port, dataDir) {
  return spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      AI_PROVIDER: 'mock',
      FPB_DATA_DIR: dataDir,
      FPB_VAULT_FILE: path.join(dataDir, 'vault.json'),
      FPB_SETTINGS_FILE: path.join(dataDir, 'runtime_settings.json'),
      FPB_MASTER_KEY: Buffer.alloc(32, 12).toString('base64'),
      DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', AI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitReady() {
  for (let i = 0; i < 40; i++) {
    const r = await req('GET', '/api/auth/me');
    if (r.code === 200 || r.code === 401) return true;
    await new Promise((s) => setTimeout(s, 300));
  }
  return false;
}

function cleanupTmp(tag) {
  for (const f of fs.readdirSync(os.tmpdir())) {
    if (f.startsWith(tag)) { try { fs.rmSync(path.join(os.tmpdir(), f), { recursive: true, force: true }); } catch (e) {} }
  }
}

(async () => {
  // ---- P1: PUT /proxies/:id masked 密码拦截（D1/D2 服务端面）----
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c81-'));
  const srv = bootServer(PORT, dataDir);
  try {
    if (!(await waitReady())) { chk('P0 服务器启动', false, 'not ready'); throw new Error('server not ready'); }
    chk('P0 服务器启动', true, '');

    const rr = await req('POST', '/api/auth/register', { username: 'u81', password: 'u81-pass-1', email: 'u81@example.com' });
    chk('P0 register → 201', rr.code === 201, 'code=' + rr.code);
    const lg = j(await req('POST', '/api/auth/login', { username: 'u81', password: 'u81-pass-1' }));
    const tk = lg && lg.token;
    chk('P0 login → token', !!tk, JSON.stringify(lg).slice(0, 60));

    // 建代理（真实密码）
    const cp = j(await req('POST', '/api/proxies', { name: 'p1', type: 'socks5', server: '1.2.3.4:8080', username: 'u', password: 'real-secret-77' }, tk));
    chk('P1a 建代理 → 200 且响应面为掩码', !!cp && cp.id && typeof cp.password === 'string' && cp.password.indexOf('••••') === 0, JSON.stringify(cp).slice(0, 120));

    const readDisk = () => {
      process.env.FPB_DATA_DIR = dataDir;
      process.env.FPB_VAULT_FILE = path.join(dataDir, 'vault.json');
      process.env.FPB_MASTER_KEY = Buffer.alloc(32, 12).toString('base64');
      delete require.cache[require.resolve(path.join(ROOT, 'server', 'vault.js'))];
      const db = require(path.join(ROOT, 'server', 'db.js'));
      const p = db.getProxies().find((x) => x.id === cp.id);
      return p ? p.password : null;
    };
    chk('P1a 盘上真实密码可解密还原', readDisk() === 'real-secret-77', 'got=' + readDisk());

    // P1b: 编辑不改密码（提交掩码串）→ 真实密码保留（修复前被掩码覆盖）
    const masked = '••••••77';
    const r1 = await req('PUT', '/api/proxies/' + cp.id, { name: 'p1-renamed', type: 'socks5', server: '1.2.3.4:8080', username: 'u', password: masked }, tk);
    chk('P1b PUT 掩码密码 → 200', r1.code === 200, 'code=' + r1.code);
    chk('P1b 掩码提交不覆盖真实密码', readDisk() === 'real-secret-77', 'got=' + readDisk());

    // P1c: PUT 不传 password 字段 → 保留
    const r2 = await req('PUT', '/api/proxies/' + cp.id, { name: 'p1-renamed2' }, tk);
    chk('P1c PUT 缺 password 字段 → 保留', r2.code === 200 && readDisk() === 'real-secret-77', 'code=' + r2.code + ' got=' + readDisk());

    // P1d: PUT 传新密码 → 正常更新
    const r3 = await req('PUT', '/api/proxies/' + cp.id, { name: 'p1-renamed3', password: 'new-pw-99' }, tk);
    chk('P1d PUT 新密码 → 正常更新', r3.code === 200 && readDisk() === 'new-pw-99', 'code=' + r3.code + ' got=' + readDisk());

    // P1e: 客户端文件断言（D2）：startEdit 不回填掩码 + saveEdit 空值不提交 + placeholder
    const ppSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'ProxyPanel.jsx'), 'utf8');
    const ppClean = ppSrc.replace(/\/\/ C81[^\n]*/g, '').replace(/\/\* C81[\s\S]*?\*\//g, '');
    chk('P1e startEdit 不回填掩码密码', /setForm\(\{[\s\S]*?password: ''/.test(ppClean), 'no empty-password reset');
    chk('P1e saveEdit 空值不提交 password 字段', /if \(form\.password\) payload\.password = form\.password/.test(ppClean), 'conditional password submit missing');
    chk('P1e 编辑态 placeholder 提示留空保持', ppSrc.includes('留空保持原密码'), 'placeholder missing');
  } catch (e) {
    chk('P1 流程异常', false, String(e.message || e));
  } finally {
    try { srv.child ? srv.child.kill() : srv.kill(); } catch (e) {}
    try { srv.kill(); } catch (e) {}
  }

  // ---- P2: automation/engine（D3/D4/D5，子进程 fake 注入）----
  const script = `
'use strict';
const path = require('path');
// fake browserManager：getSession→null → 走 launch（owned 路径），fake session/page 记录调用
const fakePage = (behavior) => ({
  closed: false,
  _calls: [],
  async goto(u) { this._calls.push('goto:' + u); if (behavior.gotoFail) throw new Error('goto boom'); },
  async waitForSelector() {},
  async fill(sel, v) { this._calls.push('fill:' + sel + '=' + v); },
  async selectOption(sel, v) { this._calls.push('select:' + sel + '=' + v); },
  async textContent() { return behavior.text == null ? null : behavior.text; },
  async close() { this.closed = true; this._calls.push('close'); },
});
const bmPath = require.resolve('${ROOT.replace(/\\/g, '/')}/server/browserManager.js');
const behavior = { text: 'hello value', gotoFail: false };
const mainPage = {
  _calls: [],
  async selectOption(sel, v) { this._calls.push('select:' + sel + '=' + v); },
  async fill(sel, v) { this._calls.push('fill:' + sel + '=' + v); },
  async goto() {},
  async close() { this._calls.push('close'); },
};
let freshPage = null;
require.cache[bmPath] = {
  id: bmPath, filename: bmPath, loaded: true,
  exports: {
    getSession: () => null,
    launch: async () => ({ page: mainPage, context: { newPage: async () => { freshPage = fakePage(behavior); return freshPage; } } }),
    close: async () => {},
  },
};
const dbPath = require.resolve('${ROOT.replace(/\\/g, '/')}/server/db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { getProxies: () => [] } };

process.env.FPB_DATA_DIR = ${JSON.stringify(process.env.FPB_DATA_DIR)};
process.env.FPB_VAULT_FILE = path.join(process.env.FPB_DATA_DIR, 'vault.json');
process.env.FPB_MASTER_KEY = Buffer.alloc(32, 12).toString('base64');
const engine = require('${ROOT.replace(/\\/g, '/')}/server/automation/engine.js');
const profile = { id: 'prof1' };
const vars = { email: 'a@b.c', password: 'PLAIN-PW-9' };

(async () => {
  const out = {};
  // P2a: selectOption 日志不泄漏解析后明文（D3）
  const r1 = await engine.runWorkflow(profile, [
    { action: 'selectOption', args: { selector: 'select#plan', value: '{{password}}' } },
  ], { vars });
  out.selLeak = r1.log.join('|').includes('PLAIN-PW-9');
  out.selHasLen = r1.log.join('|').includes('len=10');
  out.selDelivered = mainPage._calls.some((c) => c === 'select:select#plan=PLAIN-PW-9'); // 工具仍收到真实值

  // P2b: freshPage 成功路径 close（D4）
  const r2 = await engine.runWorkflow(profile, [
    { action: 'goto', args: { url: 'https://x/' } },
    { action: 'extract', args: { selector: '.v', name: 'v' } },
  ], { freshPage: true });
  out.freshClosedOnSuccess = !!(freshPage && freshPage.closed);
  out.extractNullSafe = r2.success && r2.extracted && r2.extracted.v === 'hello value';

  // P2c: freshPage 异常路径 close（D4）+ extract null 不抛（D5）
  behavior.text = null; behavior.gotoFail = true;
  const r3 = await engine.runWorkflow(profile, [
    { action: 'goto', args: { url: 'https://x/' } },
    { action: 'extract', args: { selector: '.v', name: 'v2' } },
  ], { freshPage: true });
  out.freshClosedOnError = !!(freshPage && freshPage.closed);
  out.errCaptured = r3.success === false && !!r3.error;
  console.log('RES:' + JSON.stringify(out));
})().catch((e) => { console.log('RES:' + JSON.stringify({ fatal: String(e && e.message || e) })); });
`;
  const dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c81e-'));
  const tmpJS = path.join(os.tmpdir(), 'c81-engine-' + Date.now() + '.js');
  fs.writeFileSync(tmpJS, script, 'utf8');
  const cr = spawnSync(process.execPath, [tmpJS], {
    env: { ...process.env, FPB_DATA_DIR: dataDir2 },
    encoding: 'utf8', timeout: 60000,
  });
  let o = {};
  try { o = JSON.parse((cr.stdout || '').split('RES:')[1] || '{}'); } catch (e) {}
  if (!Object.keys(o).length) console.log('[diag engine] stdout=' + String(cr.stdout || '').slice(0, 300) + ' stderr=' + String(cr.stderr || '').slice(0, 400));
  chk('P2a selectOption 日志不泄漏明文（len 口径）', o.selLeak === false && o.selHasLen === true, JSON.stringify(o));
  chk('P2a 工具仍收到解析后真实值（不改变执行语义）', o.selDelivered === true, JSON.stringify(o));
  chk('P2b freshPage 成功路径关闭', o.freshClosedOnSuccess === true, JSON.stringify(o));
  chk('P2b extract null 值安全且提取正确', o.extractNullSafe === true, JSON.stringify(o));
  chk('P2c freshPage 异常路径关闭 + 错误捕获', o.freshClosedOnError === true && o.errCaptured === true, JSON.stringify(o));
  try { fs.rmSync(dataDir2, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(tmpJS, { force: true }); } catch (e) {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  cleanupTmp('fpb-c81-');

  console.log('RESULT pass=' + pass + ' fail=' + fail);
  if (failures.length) { console.log('FAILURES:\n- ' + failures.join('\n- ')); process.exit(1); }
})();
