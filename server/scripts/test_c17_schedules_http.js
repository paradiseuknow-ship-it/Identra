'use strict';
// C17 守护测试 —— 定时调度 HTTP 全链（CAP-M1 schedules 的 UI 出口验证）。
// 缺陷背景：/api/ai/schedules 完整 CRUD + trigger 端点存在，但 client 零消费（UI 缺口）。
// 本测试用 tmp 隔离真实服务器验证 HTTP 契约（前端消费的正是这些端点）：
//   S1 POST 创建（intervalMs 校验、autoStart:false 防浏览器启动）
//   S2 GET 列表/详情回读一致
//   S3 PUT 暂停/恢复 + intervalMs 变更重算 nextRunAt
//   S4 POST trigger：ACTIVE 触发成功（autoStart:false → 只建任务不启动）、PAUSED 拒绝
//   S5 DELETE 删除后 404
//   S6 非法 intervalMs → 400
// AI_PROVIDER=mock 显式设置（不依赖真实 LLM）。零浏览器。

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 21770 + (process.pid % 50);
const BASE = 'http://127.0.0.1:' + PORT;
const ROOT = path.join(__dirname, '..', '..');

function req(method, p, body) {
  return new Promise((resolve) => {
    const r = http.request(BASE + p, { method, timeout: 15000, headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
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

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c17-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      AI_PROVIDER: 'mock', // 显式 mock：不依赖真实 LLM
      FPB_DATA_DIR: dataDir,
      FPB_VAULT_FILE: path.join(dataDir, 'vault.json'),
      FPB_SETTINGS_FILE: path.join(dataDir, 'runtime_settings.json'),
      FPB_MASTER_KEY: Buffer.alloc(32, 4).toString('base64'),
      DEEPSEEK_API_KEY: '',
      OPENAI_API_KEY: '',
      AI_API_KEY: '',
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
    if (!ready) { chk('S0 服务器启动', false, logs.join('').slice(-400)); throw new Error('server not ready'); }
    chk('S0 服务器启动', true, '');

    // S6 非法 intervalMs → 400
    const badCreate = await req('POST', '/api/ai/schedules', { objective: 'x', intervalMs: 0 });
    chk('S6 非法 intervalMs → 400', badCreate.code === 400, `code=${badCreate.code} body=${badCreate.body.slice(0, 150)}`);

    // S1 创建（autoStart:false → 触发只建任务不启动）
    const create = await req('POST', '/api/ai/schedules', {
      name: 'C17 守护调度',
      objective: '打开首页确认可达',
      targetUrl: 'http://127.0.0.1:9/no-such-site',
      profileIds: [],
      intervalMs: 60000,
      autoStart: false,
    });
    let cj = {};
    try { cj = JSON.parse(create.body); } catch (e) { /* ignore */ }
    const sched = cj && cj.schedule;
    chk('S1 创建 200 + 字段齐备', create.code === 200 && sched && sched.id && sched.status === 'ACTIVE' && sched.nextRunAt > Date.now(), create.body.slice(0, 250));

    // S2 列表/详情
    const list = await req('GET', '/api/ai/schedules');
    let lj = {};
    try { lj = JSON.parse(list.body); } catch (e) { /* ignore */ }
    chk('S2a 列表含新调度', list.code === 200 && lj.schedules && lj.schedules.some((x) => x.id === sched.id), list.body.slice(0, 250));
    const one = await req('GET', '/api/ai/schedules/' + sched.id);
    let oj = {};
    try { oj = JSON.parse(one.body); } catch (e) { /* ignore */ }
    chk('S2b 详情回读一致', one.code === 200 && oj.schedule && oj.schedule.name === 'C17 守护调度', one.body.slice(0, 250));

    // S4a 手动触发（ACTIVE）
    const trig = await req('POST', '/api/ai/schedules/' + sched.id + '/trigger');
    let tj = {};
    try { tj = JSON.parse(trig.body); } catch (e) { /* ignore */ }
    chk('S4a 触发成功（runCount=1，taskIds>=1）', trig.code === 200 && tj.runCount === 1 && Array.isArray(tj.taskIds) && tj.taskIds.length >= 1, trig.body.slice(0, 250));

    // S3 暂停 → 触发拒绝 → 恢复
    const pause = await req('PUT', '/api/ai/schedules/' + sched.id, { status: 'PAUSED' });
    const trigPaused = await req('POST', '/api/ai/schedules/' + sched.id + '/trigger');
    chk('S3a 暂停后触发被拒（400）', pause.code === 200 && trigPaused.code === 400, `pause=${pause.code} trig=${trigPaused.code} body=${trigPaused.body.slice(0, 150)}`);
    const resume = await req('PUT', '/api/ai/schedules/' + sched.id, { status: 'ACTIVE', intervalMs: 120000 });
    let rj = {};
    try { rj = JSON.parse(resume.body); } catch (e) { /* ignore */ }
    chk('S3b 恢复 + intervalMs 变更重算 nextRunAt', resume.code === 200 && rj.schedule && rj.schedule.intervalMs === 120000 && rj.schedule.nextRunAt > Date.now(), resume.body.slice(0, 250));

    // S5 删除 → 404
    const del = await req('DELETE', '/api/ai/schedules/' + sched.id);
    const afterDel = await req('GET', '/api/ai/schedules/' + sched.id);
    chk('S5 删除后详情 404', del.code === 200 && afterDel.code === 404, `del=${del.code} after=${afterDel.code}`);
  } finally {
    child.kill();
  }

  console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
  if (fail.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
