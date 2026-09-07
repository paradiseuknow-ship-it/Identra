'use strict';
// C37 守护测试 —— api 方法零消费清理 + 代理编辑/Geo/任务恢复 UI 补齐。
// 覆盖（静态双向对账 + tmp 隔离真实服务器最小契约，零浏览器）：
//   P1 ProxyPanel 消费 api.updateProxy（编辑代理闭环）
//   P2 ProxyPanel 消费 api.checkProxyGeo（出口 Geo 检测闭环）
//   P3 AiPanel 消费 api.aiResumeTask（PAUSED_FOR_HUMAN 从暂停点恢复闭环）
//   P4 api.js 已删除 5 个零消费死方法（getProfile/status/getVault/importCookies/aiCreateTask）
//   P5 server 端 PUT /proxies/:id 与 check-geo 路由真实存在（UI 不是调空端点）
//   P6 真实服务器：POST /proxies 建号 → PUT 改 name 往返 200 → check-geo 对不存在 id 返回 404

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 22750 + (process.pid % 50);
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
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}

(async () => {
  // ---- 静态双向对账 ----
  const proxyPanel = read('client/src/components/ProxyPanel.jsx');
  const aiPanel = read('client/src/components/AiPanel.jsx');
  const apijs = read('client/src/api.js');
  const serverIndex = read('server/index.js');

  chk('P1 ProxyPanel 消费 api.updateProxy（编辑代理闭环）',
    proxyPanel.includes('api.updateProxy(') && proxyPanel.includes('startEdit') && proxyPanel.includes('saveEdit'),
    'updateProxy/startEdit/saveEdit 缺失');

  chk('P2 ProxyPanel 消费 api.checkProxyGeo（出口 Geo 检测闭环）',
    proxyPanel.includes('api.checkProxyGeo('),
    'checkProxyGeo 调用缺失');

  chk('P3 AiPanel 消费 api.aiResumeTask（PAUSED_FOR_HUMAN 恢复闭环）',
    aiPanel.includes('api.aiResumeTask(') && aiPanel.includes('resumeTask'),
    'aiResumeTask 调用缺失');

  const dead = ['getProfile:', 'status: () =>', 'getVault:', 'importCookies:', 'aiCreateTask:'];
  const remaining = dead.filter((m) => apijs.includes(m));
  chk('P4 api.js 已删除 5 个零消费死方法', remaining.length === 0, '仍存在: ' + remaining.join(','));

  chk('P5 server 端 PUT /proxies/:id 与 check-geo 路由真实存在',
    serverIndex.includes("proxyRouter.put('/proxies/:id'") && serverIndex.includes("/proxies/:id/check-geo"),
    '路由缺失');

  // ---- 真实服务器最小契约 ----
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c37-'));
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

    const cr = await req('POST', '/api/proxies', { name: 'c37', type: 'socks5', server: '127.0.0.1:10808' });
    const crJ = j(cr);
    chk('P6a POST /proxies 建号 → 200 + id',
      cr.code === 200 && crJ && crJ.id, cr.code + ' ' + cr.body.slice(0, 120));

    const ur = await req('PUT', '/api/proxies/' + crJ.id, { name: 'c37-edited' });
    const list = await req('GET', '/api/proxies');
    const after = j(list).find((x) => x.id === crJ.id);
    chk('P6b PUT /proxies/:id 改 name 往返 → 200 且持久化',
      ur.code === 200 && after && after.name === 'c37-edited',
      ur.code + ' name=' + (after && after.name));

    const gf = await req('POST', '/api/proxies/nonexistent/check-geo');
    chk('P6c check-geo 对不存在 id → 404（契约路径正确）', gf.code === 404, String(gf.code));
  } catch (e) {
    chk('未预期异常', false, String(e && e.message || e));
  } finally {
    try { child.kill(); } catch (e2) { /* ignore */ }
  }

  console.log('---');
  console.log('PASS=' + pass + ' FAIL=' + fail);
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})();
