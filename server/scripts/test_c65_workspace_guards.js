'use strict';
// C65 守护测试 —— AI 任务/浏览器会话 workspace 归属守卫补齐（B 类授权一致性）。
// 缺陷背景：AI 任务创建时按 CAP-O1 §10 盖章 workspaceId，但原生 /api/ai/tasks/:id/* 全部
//   生命周期/读取路由 + /api/tasks/:id/* 兼容别名零归属守卫（跨工作区用户可读取/控制/删除
//   他人任务）；/browser/:id/human-* 与 /evaluate 无 profile 存在性+归属检查（兄弟路由
//   navigate/screenshot/stream 全有）；/browser/status 泄漏全部工作区 profile id；
//   cookie import/export 异步 handler 零 try/catch（Express 4 不接 rejection → 请求悬挂）。
// 覆盖（tmp 隔离真实服务器 ×1，Mode A 本地模式 + 注册双用户跨工作区，零浏览器零外网）：
//   P0  服务器启动 + register×2/login×2（跨工作区双身份链路）
//   P1  alice 建 AI 任务 → 200 + id（CAP-K2 enhancer fail-open 不阻塞）
//   P2  bob GET /api/ai/tasks 列表 → 不含 alice 任务（修复前列表全量泄漏）
//   P3  bob GET /api/ai/tasks/:id → 403（修复前 200 全文可读 = 最强泄漏实证）
//   P4  bob POST /api/ai/tasks/:id/pause → 403（原生生命周期）
//   P5  bob POST /api/tasks/:id/pause → 403（兼容别名同地板）
//   P6  alice 自有任务读 → 200 + id 一致；列表含 1 条（归属者零变化）
//   P7  bob DELETE /api/ai/tasks/:id → 403（删除面）
//   P8  bob GET /api/ai/tasks/:id/recent-events → 403（取证事件面）
//   P9  bob GET /api/ai/tasks/:id/diagnosis → 403（诊断面；任务存在走 403 非 404）
//   P10 alice 建 profile → bob GET /api/browser/status 不含该 id（存在性泄漏关闭）
//   P11 bob POST /api/browser/:pid/human-move → 403（修复前 getPage 400 = 越权驱动面）
//   P12 bob POST /api/browser/:pid/evaluate → 403（守卫在 FPB_ALLOW_EVALUATE 开关之前）
//   P13 alice 自有 profile human-move → 400（浏览器未运行；守卫不误伤归属者）
//   P14 alice cookie import 非数组 → 400（修复前 addCookies(undefined) 抛错挂起请求）
//   P15 alice cookie import 合法数组未运行 → 409（既有语义保留）
//   P16 alice cookie export 未运行 → 409（既有语义保留）
//   P17 死代码锚点：/automation/run 的 `if (taskId && !rawSteps)` 无操作块已删除
//   P18 Mode A 回归：匿名 loopback /profiles /ai/tasks /browser/status 全 200（本地单机行为不变）

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 22770 + (process.pid % 50);
const ROOT = path.join(__dirname, '..', '..');

function req(method, p, body, token) {
  return new Promise((resolve) => {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = http.request('http://127.0.0.1:' + PORT + p, { method, timeout: 15000, headers }, (res) => {
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

async function waitReady() {
  for (let i = 0; i < 40; i++) {
    const r = await req('GET', '/api/auth/me');
    if (r.code === 200 || r.code === 401) return true;
    await new Promise((s) => setTimeout(s, 300));
  }
  return false;
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c65-'));
  const srv = bootServer(PORT, dataDir, {});
  try {
    if (!(await waitReady())) { chk('P0 服务器启动', false, srv.logs.join('').slice(-400)); throw new Error('server not ready'); }
    chk('P0 服务器启动', true, '');

    // P0 双身份：注册即赠独立工作区 → 天然跨工作区
    const ra = await req('POST', '/api/auth/register', { username: 'alice65', password: 'alice65-pass-1', email: 'a65@example.com' });
    const rb = await req('POST', '/api/auth/register', { username: 'bob65', password: 'bob65-pass-1', email: 'b65@example.com' });
    chk('P0 register×2 → 201', ra.code === 201 && rb.code === 201, ra.code + '/' + rb.code);
    const la = j(await req('POST', '/api/auth/login', { username: 'alice65', password: 'alice65-pass-1' }));
    const lb = j(await req('POST', '/api/auth/login', { username: 'bob65', password: 'bob65-pass-1' }));
    chk('P0 login×2 → token', !!(la && la.token) && !!(lb && lb.token), JSON.stringify(la).slice(0, 80));
    const AT = la.token, BT = lb.token;
    chk('P0 两用户工作区互异', la.workspaceId && lb.workspaceId && la.workspaceId !== lb.workspaceId,
      la.workspaceId + ' vs ' + lb.workspaceId);

    // P1 alice 建 AI 任务
    const ct = j(await req('POST', '/api/ai/tasks', { name: 'c65-cross-task', objective: 'guard-test' }, AT));
    const tid = ct && ct.id;
    chk('P1 alice 建 AI 任务 → 200+id', ct && !!tid, ct ? JSON.stringify(ct).slice(0, 120) : 'null');

    // P2 列表泄漏关闭
    const blist = j(await req('GET', '/api/ai/tasks', undefined, BT));
    chk('P2 bob 任务列表不含 alice 任务', Array.isArray(blist) && !blist.some((t) => t.id === tid),
      Array.isArray(blist) ? 'len=' + blist.length : String(blist).slice(0, 100));

    // P3 单读 403（最强泄漏实证）
    const r3 = await req('GET', '/api/ai/tasks/' + tid, undefined, BT);
    chk('P3 bob 读 alice 任务 → 403', r3.code === 403, r3.code + ' ' + r3.body.slice(0, 120));

    // P4 原生生命周期 403
    const r4 = await req('POST', '/api/ai/tasks/' + tid + '/pause', { reason: 'c65' }, BT);
    chk('P4 bob pause alice 任务 → 403', r4.code === 403, r4.code + ' ' + r4.body.slice(0, 120));

    // P5 兼容别名同地板
    const r5 = await req('POST', '/api/tasks/' + tid + '/pause', { reason: 'c65' }, BT);
    chk('P5 bob 别名 pause → 403', r5.code === 403, r5.code + ' ' + r5.body.slice(0, 120));

    // P6 归属者零变化
    const o6 = j(await req('GET', '/api/ai/tasks/' + tid, undefined, AT));
    const olist = j(await req('GET', '/api/ai/tasks', undefined, AT));
    chk('P6 alice 自读 200 + 列表含 1', o6 && o6.id === tid && Array.isArray(olist) && olist.some((t) => t.id === tid),
      o6 ? (o6.id === tid ? 'list=' + (olist || []).length : 'id-mismatch') : 'null');

    // P7 删除面
    const r7 = await req('DELETE', '/api/ai/tasks/' + tid, undefined, BT);
    chk('P7 bob delete alice 任务 → 403', r7.code === 403, r7.code + ' ' + r7.body.slice(0, 120));

    // P8 取证事件面
    const r8 = await req('GET', '/api/ai/tasks/' + tid + '/recent-events', undefined, BT);
    chk('P8 bob recent-events → 403', r8.code === 403, r8.code + ' ' + r8.body.slice(0, 120));

    // P9 诊断面（任务存在 → 403 非 404）
    const r9 = await req('GET', '/api/ai/tasks/' + tid + '/diagnosis', undefined, BT);
    chk('P9 bob diagnosis → 403', r9.code === 403, r9.code + ' ' + r9.body.slice(0, 120));

    // P10 profile 存在性泄漏关闭
    const cp = j(await req('POST', '/api/profiles', { name: 'c65-prof-alice' }, AT));
    const pid = cp && cp.id;
    chk('P10a alice 建 profile → 200+id', !!(cp && pid), cp ? JSON.stringify(cp).slice(0, 120) : 'null');
    const bstat = j(await req('GET', '/api/browser/status', undefined, BT));
    chk('P10b bob /browser/status 不含 alice profile', Array.isArray(bstat) && !bstat.some((x) => x.id === pid),
      Array.isArray(bstat) ? 'len=' + bstat.length : String(bstat).slice(0, 100));

    // P11 跨工作区 human-move → 403
    const r11 = await req('POST', '/api/browser/' + pid + '/human-move', { x: 1, y: 1 }, BT);
    chk('P11 bob human-move alice profile → 403', r11.code === 403, r11.code + ' ' + r11.body.slice(0, 120));

    // P12 evaluate 守卫在开关之前
    const r12 = await req('POST', '/api/browser/' + pid + '/evaluate', { script: '1+1' }, BT);
    chk('P12 bob evaluate alice profile → 403', r12.code === 403, r12.code + ' ' + r12.body.slice(0, 120));

    // P13 归属者不误伤：守卫放行 → getPage 抛错 → 400
    const r13 = await req('POST', '/api/browser/' + pid + '/human-move', { x: 1, y: 1 }, AT);
    chk('P13 alice human-move 自有 profile → 400(未运行)', r13.code === 400, r13.code + ' ' + r13.body.slice(0, 120));

    // P14 import 非数组 → 400（快速失败，不再悬挂）
    const r14 = await req('POST', '/api/cookies/' + pid + '/import', { cookies: 'not-an-array' }, AT);
    chk('P14 cookie import 非数组 → 400', r14.code === 400, r14.code + ' ' + r14.body.slice(0, 120));

    // P15 合法数组未运行 → 409（既有语义保留）
    const r15 = await req('POST', '/api/cookies/' + pid + '/import', { cookies: [] }, AT);
    chk('P15 cookie import 合法未运行 → 409', r15.code === 409, r15.code + ' ' + r15.body.slice(0, 120));

    // P16 export 未运行 → 409
    const r16 = await req('GET', '/api/cookies/' + pid + '/export', undefined, AT);
    chk('P16 cookie export 未运行 → 409', r16.code === 409, r16.code + ' ' + r16.body.slice(0, 120));

    // P17 死代码锚点
    const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
    chk('P17 /automation/run 死代码块已删', !src.includes('if (taskId && !rawSteps)'), 'anchor still present');

    // P18 Mode A 匿名回归
    const a18a = await req('GET', '/api/profiles');
    const a18b = await req('GET', '/api/ai/tasks');
    const a18c = await req('GET', '/api/browser/status');
    chk('P18 Mode A 匿名三读全 200', a18a.code === 200 && a18b.code === 200 && a18c.code === 200,
      a18a.code + '/' + a18b.code + '/' + a18c.code);

  } catch (e) {
    chk('FATAL', false, String(e && e.stack || e).slice(0, 400));
  } finally {
    try { srv.child.kill(); } catch (e) {}
  }
  console.log('\n==== C65 RESULT: ' + pass + ' pass / ' + fail + ' fail ====');
  if (failures.length) failures.forEach((f) => console.log('  FAILED: ' + f));
  process.exit(fail ? 1 : 0);
})();
