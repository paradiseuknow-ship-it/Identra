'use strict';
// C79 守护测试 —— 归属守卫漏网面第三批（C65 同族 B 类，跨切面水平复审产出）。
// 缺陷背景：C65 给 AI 任务生命周期/读取路由补了 workspace 归属守卫，但漏了三张面——
//   D1 GET /api/ai/snapshots/:taskId/:file —— 文件证据（截图）下载零守卫（列表面有守卫，
//      文件面没有 → 跨工作区可读他人任务截图证据）；
//   D2 GET /api/ai/observability/trace/:taskId —— 完整执行轨迹（steps/observations，
//      动作序列+页面内容）零守卫；
//   D3 GET /api/ai/sessions —— session 携带用户聊天明文（每条至多 4000 字符）零过滤；
//      且 POST /api/ai/chat 复用他人 sessionId 可向其对话写消息（跨工作区读写）。
// 修复：D1/D2 按 C65 同地板 task:read 守卫（任务存在且不归属 → 403；无归属章的遗留
//   快照目录保持可读 = C65 已记录边界）；D3 = 创建时盖 workspaceId/createdBy 章（CAP-O1 §10
//   同款，身份层提供不接受伪造）+ 列表 filterByWorkspace（legacy 无章 → 仅 local 可见）+
//   /chat 复用有章 session 时守卫。
// 覆盖（tmp 隔离真实服务器 ×1，Mode A 本地模式 + 注册双用户跨工作区，零浏览器零外网）：
//   P0  服务器启动 + register×2/login×2（跨工作区双身份链路）
//   P1  alice 建 AI 任务 → 200 + id
//   P2  alice chat 创建 session（C108 后 mock 规划成功→任务创建；session 创建先于规划）
//   P3  P3a bob sessions 列表不含 alice session（D3 列表过滤）
//       P3b alice session 有 workspaceId 章 === alice 工作区（盖章生效）
//       P3c alice sessions 列表含自有 session（归属者零变化）
//   P4  bob chat 复用 alice sessionId → 403（D3 复用写面，守卫先于规划触发）
//   P5  P5a bob 读 alice 任务 trace → 403（D2，修复前 200 全轨迹可读）
//       P5b alice 读自有 trace → 非 403（守卫不误伤归属者）
//   P6  P6a bob 读 alice 任务快照文件 → 403（D1，修复前 200 文件证据可读）
//       P6b alice 读自有快照文件 → 200（sendFile 正常）
//   P7  P7a legacy 快照目录（无任务记录/无归属章）匿名可读 → 200（C65 记录边界保持）
//       P7b 快照路径穿越（..%2f）→ 400（safePath 校验不回归）
//   P8  Mode A 匿名 chat 创建 session 且 local 全可见（本地单机可见性零变化）
//   P9  文件断言：三张面守卫锚点落盘 + sessionManager 盖章签名

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 22860 + (process.pid % 50);
const ROOT = path.join(__dirname, '..', '..');
const SNAP_DIR = path.join(ROOT, 'data', 'evidence', 'snapshots');

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

const createdSnapDirs = [];
(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c79-'));
  const srv = bootServer(PORT, dataDir, {});
  try {
    if (!(await waitReady())) { chk('P0 服务器启动', false, srv.logs.join('').slice(-400)); throw new Error('server not ready'); }
    chk('P0 服务器启动', true, '');

    // P0 双身份：注册即赠独立工作区 → 天然跨工作区
    const ra = await req('POST', '/api/auth/register', { username: 'alice79', password: 'alice79-pass-1', email: 'a79@example.com' });
    const rb = await req('POST', '/api/auth/register', { username: 'bob79', password: 'bob79-pass-1', email: 'b79@example.com' });
    chk('P0 register×2 → 201', ra.code === 201 && rb.code === 201, ra.code + '/' + rb.code);
    const la = j(await req('POST', '/api/auth/login', { username: 'alice79', password: 'alice79-pass-1' }));
    const lb = j(await req('POST', '/api/auth/login', { username: 'bob79', password: 'bob79-pass-1' }));
    chk('P0 login×2 → token', !!(la && la.token) && !!(lb && lb.token), JSON.stringify(la).slice(0, 80));
    const AT = la.token, BT = lb.token;
    chk('P0 两用户工作区互异', la.workspaceId && lb.workspaceId && la.workspaceId !== lb.workspaceId,
      la.workspaceId + ' vs ' + lb.workspaceId);

    // P1 alice 建 AI 任务（snapshot/trace 守卫的归属目标）
    const ct = j(await req('POST', '/api/ai/tasks', { name: 'c79-guard-task', objective: 'guard-test' }, AT));
    const tid = ct && ct.id;
    chk('P1 alice 建 AI 任务 → 200+id', ct && !!tid, ct ? JSON.stringify(ct).slice(0, 120) : 'null');

    // P2 alice chat → session 创建+盖章。C108 已修复 mock plan strict 契约（原边界：规划阶段
    // 恒 400），规划成功 → 任务创建 + 挂计划；session 创建先于规划 → 归属章断言不受影响。
    // 此前不可达的 runtime REPLAN 路径随契约修复激活（C79 归因），step22 时序由 C108 专门批次重基线。
    const aliceMsg = 'c79-alice-chat-归属取证消息';
    await req('POST', '/api/ai/chat', { message: aliceMsg }, AT);
    const alist0 = j(await req('GET', '/api/ai/sessions', undefined, AT));
    const mine0 = Array.isArray(alist0) ? alist0.find((s) => (s.userMessages || []).some((m) => m.content === aliceMsg)) : null;
    const sid = mine0 && mine0.id;
    chk('P2 alice chat 创建 session（列表取证）', !!sid, Array.isArray(alist0) ? 'len=' + alist0.length : String(alist0).slice(0, 100));

    // P3 session 列表过滤 + 盖章
    const blist = j(await req('GET', '/api/ai/sessions', undefined, BT));
    chk('P3a bob sessions 不含 alice session', Array.isArray(blist) && !blist.some((s) => s.id === sid),
      Array.isArray(blist) ? 'len=' + blist.length : String(blist).slice(0, 100));
    const alist = j(await req('GET', '/api/ai/sessions', undefined, AT));
    const mine = Array.isArray(alist) ? alist.find((s) => s.id === sid) : null;
    chk('P3b alice session 盖章 workspaceId === alice 工作区', !!(mine && mine.workspaceId === la.workspaceId),
      mine ? ('ws=' + mine.workspaceId) : (Array.isArray(alist) ? 'session-not-found len=' + alist.length : String(alist).slice(0, 100)));
    chk('P3c alice sessions 含自有 session', !!(mine), mine ? 'ok' : (Array.isArray(alist) ? 'len=' + alist.length : 'null'));

    // P4 bob chat 复用 alice sessionId → 403（修复前 200 直接写他人对话）
    const r4 = await req('POST', '/api/ai/chat', { message: 'c79 cross-write', sessionId: sid }, BT);
    chk('P4 bob chat 复用 alice session → 403', r4.code === 403, r4.code + ' ' + r4.body.slice(0, 120));

    // P5 trace 守卫
    const r5 = await req('GET', '/api/ai/observability/trace/' + tid, undefined, BT);
    chk('P5a bob 读 alice 任务 trace → 403', r5.code === 403, r5.code + ' ' + r5.body.slice(0, 120));
    const r5b = await req('GET', '/api/ai/observability/trace/' + tid, undefined, AT);
    chk('P5b alice 读自有 trace → 非 403', r5b.code !== 403, r5b.code + ' ' + r5b.body.slice(0, 120));

    // P6 快照文件守卫：先在快照目录放一份证据文件（repo data 目录，测试后清理）
    const snapFile = 'c79_' + tid + '.png';
    const tdir = path.join(SNAP_DIR, tid);
    fs.mkdirSync(tdir, { recursive: true });
    fs.writeFileSync(path.join(tdir, snapFile), Buffer.from('89504e47', 'hex'));
    createdSnapDirs.push(tdir);
    const r6 = await req('GET', '/api/ai/snapshots/' + tid + '/' + snapFile, undefined, BT);
    chk('P6a bob 读 alice 任务快照文件 → 403', r6.code === 403, r6.code + ' ' + r6.body.slice(0, 120));
    const r6b = await req('GET', '/api/ai/snapshots/' + tid + '/' + snapFile, undefined, AT);
    chk('P6b alice 读自有快照文件 → 200', r6b.code === 200, r6b.code);

    // P7 legacy 边界：无任务记录/无归属章的快照目录匿名可读（C65 记录边界保持）+ 穿越校验
    const legacyId = 'legacy-c79-' + Date.now();
    const ldir = path.join(SNAP_DIR, legacyId);
    fs.mkdirSync(ldir, { recursive: true });
    const legacyFile = 'legacy.png';
    fs.writeFileSync(path.join(ldir, legacyFile), Buffer.from('89504e47', 'hex'));
    createdSnapDirs.push(ldir);
    const r7 = await req('GET', '/api/ai/snapshots/' + legacyId + '/' + legacyFile);
    chk('P7a legacy 快照目录匿名可读 → 200', r7.code === 200, r7.code + ' ' + r7.body.slice(0, 80));
    // P7b 路径穿越：走 legacy taskId（无任务记录 → 守卫放行到 safePath）→ 400。
    // 注：用有归属章的真实 taskId 时守卫先行（匿名 local 用户 403）——归因期间实证的正确行为。
    const r7b = await req('GET', '/api/ai/snapshots/' + legacyId + '/..%2f..%2f..%2fvault.json');
    chk('P7b 快照路径穿越 → 400', r7b.code === 400, r7b.code + ' ' + r7b.body.slice(0, 80));

    // P8 Mode A 回归：匿名 chat（C108 后规划成功 → session+任务创建）+ 匿名 sessions 可见其 session
    const anonMsg = 'c79-anon-chat-ModeA取证消息';
    await req('POST', '/api/ai/chat', { message: anonMsg });
    const a8list = j(await req('GET', '/api/ai/sessions'));
    const a8found = Array.isArray(a8list) && a8list.some((s) => (s.userMessages || []).some((m) => m.content === anonMsg));
    chk('P8 匿名 chat session 创建且 local 全可见', a8found,
      Array.isArray(a8list) ? 'len=' + a8list.length : String(a8list).slice(0, 100));

    // P9 文件断言：守卫锚点落盘
    const src = fs.readFileSync(path.join(ROOT, 'server', 'agent', 'index.js'), 'utf8');
    const smSrc = fs.readFileSync(path.join(ROOT, 'server', 'agent', 'sessionManager.js'), 'utf8');
    chk('P9a snapshot 文件面守卫锚点', src.includes('aiTaskGuardedBy(req, res, req.params.taskId)'), 'guard missing on file route');
    chk('P9b trace 守卫锚点', /trace\/:taskId[\s\S]{0,200}aiTaskGuardedBy/.test(src), 'guard missing on trace route');
    chk('P9c sessions 列表 filterByWorkspace 锚点', /sessions'[\s\S]{0,160}filterByWorkspace\(sessionManager\.listSessions/.test(src), 'filter missing');
    chk('P9d chat 复用 session 守卫锚点', /session\.workspaceId && !guardAiTask\(req, res, session\)/.test(src), 'reuse guard missing');
    chk('P9e sessionManager 盖章签名', smSrc.includes('workspaceId, createdBy') && smSrc.includes("session.workspaceId = workspaceId"), 'stamp missing');

  } catch (e) {
    chk('FATAL', false, String(e && e.stack || e).slice(0, 400));
  } finally {
    try { srv.child.kill(); } catch (e) {}
    for (const d of createdSnapDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {}
    }
  }
  console.log('\n==== C79 RESULT: ' + pass + ' pass / ' + fail + ' fail ====');
  if (failures.length) failures.forEach((f) => console.log('  FAILED: ' + f));
  process.exit(fail ? 1 : 0);
})();
