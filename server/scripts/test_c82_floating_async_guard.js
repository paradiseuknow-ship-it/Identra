'use strict';
// C82 守护测试 —— 跨切面水平复审第二轮：浮动 async handler 悬挂面（Express 4 不接 rejection）：
//   D1 (B 类·真实)：POST /api/automation/run 零 try/catch —— runWorkflow 是设计性抛错契约
//     （C71 D2 download face 修复正依赖「入口抛错被捕获」语义；launch 失败/任务取消/step 抛错
//     都会 reject），handler 不接 rejection → 请求悬挂至客户端超时，UI 零反馈死等。
//     修复：整体 try/catch → 500 JSON。
//   D2-D7 (B 类·同族防御硬化)：GET /profiles/:id、PUT /profiles/:id、POST /profiles/:id/duplicate、
//     POST /profiles/preview-fp、POST /proxies/:id/check-geo、POST /browser/:id/stop ——
//     await 链（resolveIpGeo→checkProxyGeo 自吞错 / browserManager.close 内部全守卫）当前契约
//     不 rejection（C78 D2 先例：如实记边界），但属跨层契约边界（db fsSafe fail-loud 抛错、
//     browserManager 内部演进），统一 try/catch 固化「路由层永远回 JSON 不悬挂」契约。
//   P3 结构化守卫：全量扫描 server/index.js + server/agent/index.js —— 任何 async (req,res)
//     路由 handler 体内必须含 try（整类缺陷回归杀手，修复前可检出全部 7 处）。
// 零浏览器：P1 tmp 隔离真实服务器语义保留（Mode A）；P2 子进程 require.cache 注入 fake
//   browserManager（launch/close 定向抛错）→ HTTP 面行为级最强实证（修复前 TIMEOUT 悬挂）。
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 23320 + (process.pid % 50);
const PORT2 = PORT + 1;
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}

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

async function waitReady(port) {
  for (let i = 0; i < 40; i++) {
    const r = await req(port, 'GET', '/api/auth/me');
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
  // ---- P1: tmp 隔离真实服务器 —— 语义保留（修复不改行为，只加守卫）----
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c82-'));
  const srv = bootServer(PORT, dataDir);
  try {
    if (!(await waitReady(PORT))) { chk('P0 服务器启动', false, 'not ready'); throw new Error('server not ready'); }
    chk('P0 服务器启动', true, '');

    await req(PORT, 'POST', '/api/auth/register', { username: 'u82', password: 'u82-pass-1', email: 'u82@example.com' });
    const lg = j(await req(PORT, 'POST', '/api/auth/login', { username: 'u82', password: 'u82-pass-1' }));
    const tk = lg && lg.token;
    chk('P0 login → token', !!tk, JSON.stringify(lg).slice(0, 60));

    // 建配置 + 死代理（不触发浏览器）
    const cp = j(await req(PORT, 'POST', '/api/profiles', { name: 'c82-prof', os: 'windows' }, tk));
    chk('P1a 建配置 → 200 且含 fingerprint', !!cp && !!cp.id && !!cp.fingerprint, JSON.stringify(cp).slice(0, 100));
    const dp = j(await req(PORT, 'POST', '/api/proxies', { name: 'dead', type: 'http', server: '127.0.0.1:1' }, tk));

    // D2 面：GET /profiles/:id 正常路径 200（守卫不改变成功语义）
    const g1 = await req(PORT, 'GET', '/api/profiles/' + cp.id, undefined, tk);
    chk('P1b GET /profiles/:id → 200 且 running 字段在', g1.code === 200 && j(g1) && 'running' in j(g1), 'code=' + g1.code);

    // D3 面：PUT /profiles/:id 正常路径 200
    const p1 = await req(PORT, 'PUT', '/api/profiles/' + cp.id, { name: 'c82-prof-x', regenerateSeed: true }, tk);
    chk('P1c PUT /profiles/:id → 200 且 seed 已再生', p1.code === 200 && j(p1) && j(p1).seed !== cp.seed, 'code=' + p1.code);

    // D4 面：duplicate 正常路径 200
    const d1 = j(await req(PORT, 'POST', '/api/profiles/' + cp.id + '/duplicate', {}, tk));
    chk('P1d duplicate → 200 且新 id/副本名', !!d1 && d1.id && d1.id !== cp.id && /副本/.test(d1.name || ''), JSON.stringify(d1).slice(0, 100));

    // D5 面：preview-fp 正常路径 200（纯计算 + 自吞错的 geo 链）
    const pf = j(await req(PORT, 'POST', '/api/profiles/preview-fp', { seed: 'c82-seed', fingerprintOverride: { os: 'windows' } }, tk));
    chk('P1e preview-fp → 200 且返回指纹', !!pf && !!pf.userAgent, JSON.stringify(pf).slice(0, 80));

    // D6 面：check-geo 对死代理 → 200 + ok:false 降级结果（checkProxyGeo 自吞错契约保持）
    const cg = j(await req(PORT, 'POST', '/api/proxies/' + dp.id + '/check-geo', {}, tk));
    chk('P1f check-geo 死代理 → 200 且 ok:false 降级', cg && cg.ok === false && typeof cg.error === 'string', JSON.stringify(cg).slice(0, 100));

    // D1 面：automation/run 早退守卫路径不受影响（no steps → 400，不进 runWorkflow）
    const a0 = j(await req(PORT, 'POST', '/api/automation/run', { profileId: cp.id, steps: [] }, tk));
    chk('P1g automation/run 空 steps → 400 早退', a0 && a0.error === 'no steps', JSON.stringify(a0));
  } catch (e) {
    chk('P1 流程异常', false, String(e.message || e));
  } finally {
    try { srv.kill(); } catch (e) {}
  }

  // ---- P2: fake browserManager 注入 —— D1/D7 行为级最强实证 ----
  // launch/close 定向抛错 → 修复前请求悬挂（TIMEOUT），修复后快速 500 JSON。
  const boot2 = `
'use strict';
const bmPath = require.resolve('${ROOT.replace(/\\/g, '/')}/server/browserManager.js');
const boom = async () => { throw new Error('LAUNCH_FAIL_C82_TEST'); };
require.cache[bmPath] = {
  id: bmPath, filename: bmPath, loaded: true,
  exports: {
    getSession: () => null,
    isRunning: () => false,
    launch: boom,
    close: boom,
    getPage: async () => { throw new Error('x'); },
    navigate: async () => { throw new Error('x'); },
    screenshot: async () => { throw new Error('x'); },
    humanMove: async () => {}, humanClick: async () => {}, humanType: async () => {}, humanScroll: async () => {},
    runtimeSnapshots: () => ({}),
    getChromeVersion: () => '0.0.0-test',
    cleanupOrphanedChromium: () => {},
    startZombieKiller: () => {},
  },
};
process.env.PORT = '${PORT2}';
process.env.AI_PROVIDER = 'mock';
process.env.FPB_DATA_DIR = ${JSON.stringify(dataDir)};
process.env.FPB_VAULT_FILE = require('path').join(process.env.FPB_DATA_DIR, 'vault.json');
process.env.FPB_SETTINGS_FILE = require('path').join(process.env.FPB_DATA_DIR, 'runtime_settings.json');
process.env.FPB_MASTER_KEY = Buffer.alloc(32, 12).toString('base64');
process.env.DEEPSEEK_API_KEY = ''; process.env.OPENAI_API_KEY = ''; process.env.AI_API_KEY = '';
require('${ROOT.replace(/\\/g, '/')}/server/index.js');
`;
  const boot2File = path.join(dataDir, 'boot_c82_p2.js');
  fs.writeFileSync(boot2File, boot2);
  const srv2 = spawn(process.execPath, [boot2File], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let srv2err = '';
  srv2.stderr.on('data', (c) => { srv2err += c; });
  try {
    if (!(await waitReady(PORT2))) { chk('P2 服务器启动', false, 'not ready; stderr=' + srv2err.slice(-400)); throw new Error('server2 not ready'); }
    chk('P2 服务器启动', true, '');

    await req(PORT2, 'POST', '/api/auth/register', { username: 'u82b', password: 'u82-pass-2', email: 'u82b@example.com' });
    const lg2 = j(await req(PORT2, 'POST', '/api/auth/login', { username: 'u82b', password: 'u82-pass-2' }));
    const tk2 = lg2 && lg2.token;
    chk('P2 login → token', !!tk2, JSON.stringify(lg2).slice(0, 60));
    const cp2 = j(await req(PORT2, 'POST', '/api/profiles', { name: 'c82-p2' }, tk2));
    chk('P2 建配置 → id', !!cp2 && !!cp2.id, JSON.stringify(cp2).slice(0, 80));

    // D1 杀手：launch 定向抛错 → 必须快速 500 JSON（修复前悬挂 TIMEOUT）
    const t0 = Date.now();
    const a1 = await req(PORT2, 'POST', '/api/automation/run', { profileId: cp2.id, steps: [{ action: 'goto', args: { url: 'https://x/' } }] }, tk2);
    const dt1 = Date.now() - t0;
    chk('P2a automation/run launch 失败 → 500 JSON（不悬挂）', a1.code === 500 && j(a1) && j(a1).ok === false && /LAUNCH_FAIL_C82_TEST/.test(a1.body), 'code=' + a1.code + ' body=' + a1.body.slice(0, 120) + ' dt=' + dt1 + 'ms');
    chk('P2a 响应及时（<10s，非超时悬挂）', dt1 < 10000, 'dt=' + dt1 + 'ms');

    // D7 杀手：close 定向抛错 → 500 JSON
    const s1 = await req(PORT2, 'POST', '/api/browser/' + cp2.id + '/stop', {}, tk2);
    chk('P2b browser stop close 抛错 → 500 JSON', s1.code === 500 && j(s1) && j(s1).ok === false && /LAUNCH_FAIL_C82_TEST/.test(s1.body), 'code=' + s1.code + ' body=' + s1.body.slice(0, 120));

    // 对照：正常路径语义不受守卫影响（isRunning:false → /browser/status 200）
    const st = await req(PORT2, 'GET', '/api/browser/status', undefined, tk2);
    chk('P2c browser/status 正常路径 200', st.code === 200 && Array.isArray(j(st)), 'code=' + st.code);
  } catch (e) {
    chk('P2 流程异常', false, String(e.message || e));
  } finally {
    try { srv2.kill(); } catch (e) {}
  }

  // ---- P3: 结构化守卫（整类回归杀手）----
  const scanFile = (rel) => {
    const src = fs.readFileSync(path.join(ROOT, 'server', rel), 'utf8');
    const lines = src.split('\n');
    const unguarded = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/async \(req, res\) => \{\s*$/.test(lines[i])) continue;
      if (!/\w+\.\w+\(\s*(?:'[^']*')?\s*,?\s*$/.test(lines[i]) && !/(router|app|Router)\.\w+\(/.test(lines[i])) continue;
      let depth = 1, k = i + 1;
      for (; k < lines.length && depth > 0; k++) {
        for (const ch of lines[k]) { if (ch === '{') depth++; else if (ch === '}') depth--; if (depth === 0) break; }
      }
      const body = lines.slice(i + 1, k - 1).join('\n');
      if (!/\btry\b/.test(body)) unguarded.push(i + 1);
    }
    return unguarded;
  };
  const u1 = scanFile('index.js');
  chk('P3a server/index.js 全部 async handler 有 try 守卫', u1.length === 0, 'unguarded lines: ' + u1.join(','));
  const u2 = scanFile(path.join('agent', 'index.js'));
  chk('P3b server/agent/index.js 全部 async handler 有 try 守卫', u2.length === 0, 'unguarded lines: ' + u2.join(','));

  cleanupTmp('fpb-c82-');
  console.log('\\n===== C82 RESULT: ' + pass + ' passed, ' + fail + ' failed =====');
  if (failures.length) { console.log(failures.join('\\n')); process.exit(1); }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
