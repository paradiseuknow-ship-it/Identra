'use strict';
// C85 守护测试 —— /api/ai/schedules 子路由审计闭环（C84 登记的收尾面，水平复审 round 5）：
//   D1 (B 类审计链断裂)：scheduleTrigger.js 自有 CRUD（create/update/delete/trigger）零审计
//     —— C84 已闭环 agent/index.js 34 面，但 /schedules 是独立子路由（挂载点 agent/index.js:811），
//     自带守卫也自带「审计盲区」：定时批量执行的创建/修改/删除/手动触发在安全审计链上不可见。
//   意图归因设计（C84 同款）：审计只记意图事件（谁/何时/哪个 scheduleId），运行细节归
//     events（schedule.* 事件流）；tick 自动触发是高频自动化事件 → 不逐次审计（环形缓冲
//     冲刷边界，events.emit('schedule.triggered') 已覆盖），仅手动 trigger（用户意图）落审计。
//   红线：objective/targetUrl 等用户明文不入审计 detail（只记标识/数量/布尔；redact 兜底第二层）。
//   守护：P2 结构化（scheduleTrigger.js 全部 mutation 路由必须含 audit.logRequest；
//     4 个 action 逐一存在；tick 模块函数不得调用审计（边界固化）；红线负向断言）。
//   P1 行为面（零浏览器 Mode A，autoStart:false 防真启动浏览器）：create/update/delete/
//     trigger 审计落盘且意图字段正确（workspaceId/actorName/resourceId）；无效创建 400 不落
//     审计；跨工作区 403 负向控制不产生审计。
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 23160 + (process.pid % 50);
const ROOT = path.join(__dirname, '..', '..');

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
    const r = http.request('http://127.0.0.1:' + PORT + p, { method, timeout: 25000, headers }, (res) => {
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

// ---- P2 结构化对账 ----
function structuralScan() {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'agent', 'scheduleTrigger.js'), 'utf8');
  const lines = src.split(/\r?\n/);

  // P2a: 全部 mutation 路由必须含 audit.logRequest（本模块 4 条，无豁免）
  const routeRe = /^router\.(post|put|delete|patch)\(\s*['"`]([^'"`]*)['"`]/;
  const starts = [];
  lines.forEach((l, i) => { const m = l.match(routeRe); if (m) starts.push({ line: i, verb: m[1], path: m[2] || '(root)' }); });
  const muts = starts.map((s) => {
    const end = lines.findIndex((l, i) => i > s.line && l === '});');
    s.body = end > s.line ? lines.slice(s.line, end + 1).join('\n') : '';
    return s;
  }).filter((s) => s.body);
  chk('P2a 路由枚举 = 4', muts.length === 4, 'got=' + muts.length + ' [' + muts.map((m) => m.verb + ' ' + m.path).join(', ') + ']');
  for (const m of muts) {
    chk('P2a ' + m.verb.toUpperCase() + ' /schedules' + (m.path === '(root)' ? '' : '/' + m.path) + ' 已审计', /audit\.logRequest\(req/.test(m.body), 'mutation 路由零审计');
  }

  // P2b: 4 个 action 逐一存在
  for (const a of ['ai.schedule.create', 'ai.schedule.update', 'ai.schedule.delete', 'ai.schedule.trigger']) {
    chk('P2b action 落地 ' + a, src.includes("'" + a + "'"), 'source 未找到 ' + a);
  }

  // P2c: tick/模块层不得调用审计（高频自动化边界固化 —— 审计只在 HTTP 意图层）
  const tickFn = src.slice(src.indexOf('function tickSchedules'), src.indexOf('let _loopTimer'));
  chk('P2c tickSchedules 不落审计', !/logRequest/.test(tickFn), 'tick 高频自动路径出现审计调用（冲刷边界被破坏）');
  const fireFn = src.slice(src.indexOf('function fireSchedule'), src.indexOf('function triggerOnce'));
  chk('P2c fireSchedule 不落审计', !/logRequest/.test(fireFn), 'fireSchedule 模块层出现审计调用（意图归因错位：tick 与手动共用此函数）');

  // P2d: 红线 —— detail 不携带 objective/targetUrl 明文（只允许标识/数量/布尔）
  const auditCalls = src.split(/audit\.logRequest\(req/).slice(1);
  chk('P2d 埋点数 = 4', auditCalls.length === 4, 'got=' + auditCalls.length);
  for (const c of auditCalls) {
    chk('P2d detail 无 objective 明文', !/objective:/.test(c), 'logRequest detail 疑似携带 objective 明文');
    chk('P2d detail 无 targetUrl 明文', !/targetUrl:/.test(c), 'logRequest detail 疑似携带 targetUrl 明文');
  }
}

(async () => {
  structuralScan();

  // ---- P1: 行为面（零浏览器 Mode A）----
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c85-'));
  const srv = bootServer(PORT, dataDir);
  try {
    if (!(await waitReady())) { chk('P0 服务器启动', false, 'not ready'); throw new Error('server not ready'); }
    chk('P0 服务器启动', true, '');

    const rr = await req('POST', '/api/auth/register', { username: 'u85', password: 'u85-pass-1', email: 'u85@example.com' });
    chk('P0 register → 201', rr.code === 201, 'code=' + rr.code);
    const lg = j(await req('POST', '/api/auth/login', { username: 'u85', password: 'u85-pass-1' }));
    const tk = lg && lg.token;
    chk('P0 login → token', !!tk, JSON.stringify(lg).slice(0, 60));

    const auditOf = async (action, token) => j(await req('GET', '/api/auth/audit?action=' + encodeURIComponent(action) + '&limit=100', undefined, token));

    // P1a: create → 意图审计落盘
    const cs = j(await req('POST', '/api/ai/schedules', {
      name: 'c85-sched', objective: 'c85 objective text', targetUrl: 'https://example.com',
      profileIds: [], intervalMs: 60000, autoStart: false,
    }, tk));
    chk('P1a 建 schedule → 200', !!cs && cs.ok && !!(cs.schedule && cs.schedule.id), JSON.stringify(cs).slice(0, 140));
    const sid = cs && cs.schedule && cs.schedule.id;
    const aCreate = await auditOf('ai.schedule.create', tk);
    const eCreate = aCreate && aCreate.entries && aCreate.entries.find((e) => e.resourceId === sid);
    chk('P1a ai.schedule.create 审计落盘', !!eCreate, JSON.stringify(aCreate).slice(0, 140));
    chk('P1a 意图字段正确（actorName/detail.name）', !!eCreate && eCreate.actorName === 'u85' && eCreate.detail && eCreate.detail.name === 'c85-sched', JSON.stringify(eCreate).slice(0, 200));
    chk('P1a workspaceId 盖章', !!eCreate && !!eCreate.workspaceId, JSON.stringify(eCreate).slice(0, 200));

    // P1b: 无效创建（缺 objective）→ 400 且不落审计（无实体即无意图实现）
    const badCreate = await req('POST', '/api/ai/schedules', { name: 'bad' }, tk);
    chk('P1b 无效创建 → 400', badCreate.code === 400, 'code=' + badCreate.code);
    const aCreate2 = await auditOf('ai.schedule.create', tk);
    chk('P1b 无效创建不落审计', !!aCreate2 && aCreate2.entries && aCreate2.entries.length === 1, 'count=' + (aCreate2 && aCreate2.entries ? aCreate2.entries.length : 'null'));

    // P1c: update → 审计
    const up = await req('PUT', '/api/ai/schedules/' + sid, { name: 'c85-sched-2' }, tk);
    chk('P1c 改 schedule → 200', up.code === 200, 'code=' + up.code);
    const aUp = await auditOf('ai.schedule.update', tk);
    chk('P1c ai.schedule.update 审计落盘', !!aUp && aUp.entries && aUp.entries.length >= 1, JSON.stringify(aUp).slice(0, 140));

    // P1d: trigger（手动意图，autoStart:false → 任务创建但不起浏览器）→ 审计
    const tg = j(await req('POST', '/api/ai/schedules/' + sid + '/trigger', {}, tk));
    chk('P1d 手动触发 → 200', !!tg && tg.ok === true, JSON.stringify(tg).slice(0, 160));
    const aTrg = await auditOf('ai.schedule.trigger', tk);
    const eTrg = aTrg && aTrg.entries && aTrg.entries[0];
    chk('P1d ai.schedule.trigger 审计落盘', !!eTrg && eTrg.resourceId === sid, JSON.stringify(aTrg).slice(0, 160));
    chk('P1d trigger 记 taskCount', !!eTrg && eTrg.detail && typeof eTrg.detail.taskCount === 'number' && eTrg.detail.taskCount >= 1, JSON.stringify(eTrg).slice(0, 200));

    // P1e: 跨工作区负向控制 —— 他人 trigger/delete → 403 且不产生审计
    await req('POST', '/api/auth/register', { username: 'u85b', password: 'u85b-pass-1', email: 'u85b@example.com' });
    const lgB = j(await req('POST', '/api/auth/login', { username: 'u85b', password: 'u85b-pass-1' }));
    const tkB = lgB && lgB.token;
    chk('P0 用户B login → token', !!tkB, '');
    const trgB = await req('POST', '/api/ai/schedules/' + sid + '/trigger', {}, tkB);
    chk('P1e 跨工作区 trigger → 403', trgB.code === 403, 'code=' + trgB.code);
    const delB = await req('DELETE', '/api/ai/schedules/' + sid, undefined, tkB);
    chk('P1e 跨工作区 delete → 403', delB.code === 403, 'code=' + delB.code);
    const aTrgB = await auditOf('ai.schedule.trigger', tkB);
    const aDelB = await auditOf('ai.schedule.delete', tkB);
    chk('P1e 用户B 审计面为空（守卫先于埋点）', !!aTrgB && aTrgB.entries && aTrgB.entries.length === 0 && !!aDelB && aDelB.entries && aDelB.entries.length === 0, JSON.stringify({ trg: aTrgB, del: aDelB }).slice(0, 200));
    const aDelOwn = await auditOf('ai.schedule.delete', tk);
    chk('P1e 用户A delete 审计数仍为 0（仅负向控制未删）', !!aDelOwn && aDelOwn.entries && aDelOwn.entries.length === 0, 'count=' + (aDelOwn && aDelOwn.entries ? aDelOwn.entries.length : 'null'));

    // P1f: delete → 审计
    const del = await req('DELETE', '/api/ai/schedules/' + sid, undefined, tk);
    chk('P1f 删 schedule → 200', del.code === 200, 'code=' + del.code);
    const aDel = await auditOf('ai.schedule.delete', tk);
    chk('P1f ai.schedule.delete 审计落盘', !!aDel && aDel.entries && aDel.entries.length === 1, JSON.stringify(aDel).slice(0, 140));
  } catch (e) {
    chk('P1 流程异常', false, String(e.message || e));
  } finally {
    try { srv.kill(); } catch (e) {}
  }

  try {
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (f.startsWith('fpb-c85-')) { try { fs.rmSync(path.join(os.tmpdir(), f), { recursive: true, force: true }); } catch (e) {} }
    }
  } catch (e) {}

  console.log('\n===== C85 RESULT: ' + pass + ' passed, ' + fail + ' failed =====');
  if (fail) { failures.forEach((f) => console.log('  FAIL: ' + f)); process.exit(1); }
})();
