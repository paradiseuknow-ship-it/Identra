'use strict';
// C19 守护测试 —— 调度→任务 来源可追溯全链（UI 契约：任务徽章 + 调度运行历史 chips）。
// 缺陷背景：scheduleTrigger.fireSchedule 已把 scheduleId 盖章进任务（CAP-M1），但 client
// 任务列表/调度面板均无出口，用户无法从任务反查来源、也无法从调度跳到任务时间线。
// 本测试用 tmp 隔离真实服务器验证 HTTP 契约（前端消费的正是这些端点）：
//   T1 触发后 GET /api/ai/tasks → 任务带 scheduleId = 调度 id（徽章数据源）
//   T2 任务名含调度名前缀（「调度名 · 时间」形态）
//   T3 GET /api/ai/tasks/:id → scheduleId 持久化（详情页/时间线可反查）
//   T4 GET /api/ai/schedules/:id → lastRunTaskIds 含触发产生的 taskId（chips 数据源）
//   T5 两次触发 → runCount=2 且 lastRunTaskIds 只保留最近一批（顺延周期语义）
// AI_PROVIDER=mock 显式设置（不依赖真实 LLM）。零浏览器。

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 21830 + (process.pid % 50);
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c19-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      AI_PROVIDER: 'mock', // 显式 mock：不依赖真实 LLM
      FPB_DATA_DIR: dataDir,
      FPB_VAULT_FILE: path.join(dataDir, 'vault.json'),
      FPB_SETTINGS_FILE: path.join(dataDir, 'runtime_settings.json'),
      FPB_MASTER_KEY: Buffer.alloc(32, 5).toString('base64'),
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
    if (!ready) { chk('T0 服务器启动', false, logs.join('').slice(-400)); throw new Error('server not ready'); }
    chk('T0 服务器启动', true, '');

    // 创建调度（autoStart:false → 触发只建任务不启动，零浏览器）
    const create = await req('POST', '/api/ai/schedules', {
      name: 'C19 追溯守护',
      objective: '打开首页确认可达',
      targetUrl: 'http://127.0.0.1:9/no-such-site',
      profileIds: [],
      intervalMs: 60000,
      autoStart: false,
    });
    const sched = (JSON.parse(create.body) || {}).schedule;
    chk('T0b 创建调度', create.code === 200 && sched && sched.id, create.body.slice(0, 200));

    // 第一次触发
    const trig1 = await req('POST', '/api/ai/schedules/' + sched.id + '/trigger');
    const t1 = (JSON.parse(trig1.body) || {});
    chk('T0c 触发产生任务', trig1.code === 200 && Array.isArray(t1.taskIds) && t1.taskIds.length >= 1, trig1.body.slice(0, 200));
    const taskId1 = t1.taskIds[0];

    // T1: 任务列表带 scheduleId（AiPanel 徽章数据源）
    const tasks = await req('GET', '/api/ai/tasks');
    const tasksJ = (JSON.parse(tasks.body) || []);
    const traced = tasksJ.find((x) => x.id === taskId1);
    chk('T1 任务带 scheduleId 盖章', tasks.code === 200 && traced && traced.scheduleId === sched.id,
      tasks.code + ' traced=' + JSON.stringify(traced ? { id: traced.id, scheduleId: traced.scheduleId } : null));

    // T2: 任务名含调度名前缀
    chk('T2 任务名含调度名前缀', traced && typeof traced.name === 'string' && traced.name.indexOf('C19 追溯守护') === 0,
      'name=' + (traced ? traced.name : 'N/A'));

    // T3: 任务详情持久化 scheduleId（时间线/详情可反查）
    const detail = await req('GET', '/api/ai/tasks/' + taskId1);
    const dj = (JSON.parse(detail.body) || {});
    const dTask = dj.task || dj;
    chk('T3 任务详情 scheduleId 持久化', detail.code === 200 && dTask.scheduleId === sched.id,
      detail.code + ' ' + detail.body.slice(0, 200));

    // T4: 调度详情 lastRunTaskIds 含 taskId（SchedulesPanel chips 数据源）
    const schedDetail = await req('GET', '/api/ai/schedules/' + sched.id);
    const sj = (JSON.parse(schedDetail.body) || {}).schedule || {};
    chk('T4 lastRunTaskIds 含触发的 taskId', schedDetail.code === 200 && Array.isArray(sj.lastRunTaskIds) && sj.lastRunTaskIds.includes(taskId1),
      'lastRunTaskIds=' + JSON.stringify(sj.lastRunTaskIds) + ' runCount=' + sj.runCount);

    // T5: 第二次触发 → runCount=2，lastRunTaskIds 只保留最近一批
    const trig2 = await req('POST', '/api/ai/schedules/' + sched.id + '/trigger');
    const t2 = (JSON.parse(trig2.body) || {});
    const schedDetail2 = await req('GET', '/api/ai/schedules/' + sched.id);
    const sj2 = (JSON.parse(schedDetail2.body) || {}).schedule || {};
    chk('T5 二次触发 runCount=2 + lastRunTaskIds 滚动到最新批',
      trig2.code === 200 && sj2.runCount === 2 && Array.isArray(sj2.lastRunTaskIds) &&
      sj2.lastRunTaskIds.includes(t2.taskIds[0]) && !sj2.lastRunTaskIds.includes(taskId1),
      'runCount=' + sj2.runCount + ' lastRunTaskIds=' + JSON.stringify(sj2.lastRunTaskIds));
  } finally {
    child.kill();
  }

  console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
  if (failures.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
