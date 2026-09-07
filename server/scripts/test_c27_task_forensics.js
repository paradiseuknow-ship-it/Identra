'use strict';
// C27 守护测试 —— 任务取证四件套（/api/ai/tasks/:id 下的 diagnosis / repairs / execution / replay）。
// 覆盖（tmp 隔离真实服务器，零浏览器；AI_PROVIDER=mock）：
//   P1 建任务 → 拿到 taskId
//   P2 GET diagnosis → 200 + available=false + failureSnapshots 为数组
//   P3 GET repairs   → 200 + repairs 数组 + stats 数组
//   P4 GET execution → 200（null 或对象；未开始执行时不得 500）
//   P5 GET replay    → 200（对象）
//   P6 未知 taskId → diagnosis 404（不 500）
//   P7 client 静态守护：api.js 三方法 + TaskDetail 渲染取证四块

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 22330 + (process.pid % 50);
const BASE = 'http://127.0.0.1:' + PORT;
const ROOT = path.join(__dirname, '..', '..');

function req(method, p, body) {
  return new Promise((resolve) => {
    const r = http.request(BASE + p, {
      method, timeout: 15000,
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

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c27-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      AI_PROVIDER: 'mock',
      FPB_DATA_DIR: dataDir,
      FPB_VAULT_FILE: path.join(dataDir, 'vault.json'),
      FPB_SETTINGS_FILE: path.join(dataDir, 'runtime_settings.json'),
      FPB_MASTER_KEY: Buffer.alloc(32, 13).toString('base64'),
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

    // P1 建任务
    const created = await req('POST', '/api/ai/tasks', {
      objective: 'C27 取证守护任务',
      targetUrl: 'http://127.0.0.1:1/never',
      mode: 'dry',
    });
    const cJ = j(created);
    const taskId = cJ && (cJ.id || (cJ.task && cJ.task.id));
    chk('P1 创建任务 → 200 + id', created.code === 200 && !!taskId, created.code + ' ' + created.body.slice(0, 200));

    // P2 diagnosis
    const diag = await req('GET', '/api/ai/tasks/' + taskId + '/diagnosis');
    const dJ = j(diag);
    chk('P2 GET diagnosis → 200 + available=false + snapshots 数组',
      diag.code === 200 && dJ && dJ.available === false && Array.isArray(dJ.failureSnapshots),
      diag.code + ' ' + diag.body.slice(0, 200));

    // P3 repairs
    const rep = await req('GET', '/api/ai/tasks/' + taskId + '/repairs');
    const rJ = j(rep);
    chk('P3 GET repairs → 200 + repairs/stats 数组',
      rep.code === 200 && rJ && Array.isArray(rJ.repairs) && Array.isArray(rJ.stats),
      rep.code + ' ' + rep.body.slice(0, 200));

    // P4 execution（未执行：null 或对象，不得 500）
    const exe = await req('GET', '/api/ai/tasks/' + taskId + '/execution');
    chk('P4 GET execution → 200（null 或对象）',
      exe.code === 200 && (exe.body.trim() === 'null' || (j(exe) && typeof j(exe) === 'object')),
      exe.code + ' ' + exe.body.slice(0, 160));

    // P5 replay
    const rpl = await req('GET', '/api/ai/tasks/' + taskId + '/replay');
    const pJ = j(rpl);
    chk('P5 GET replay → 200 + 对象', rpl.code === 200 && pJ && typeof pJ === 'object',
      rpl.code + ' ' + rpl.body.slice(0, 160));

    // P6 未知 id → 404
    const unknown = await req('GET', '/api/ai/tasks/task_does_not_exist/diagnosis');
    chk('P6 未知 taskId → 404', unknown.code === 404, unknown.code + ' ' + unknown.body.slice(0, 160));

    // P7 client 静态守护
    const apiSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'api.js'), 'utf8');
    const tdSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'TaskDetail.jsx'), 'utf8');
    const need = ['aiDiagnosis:', 'aiRepairs:', 'aiExecutionDetail:'];
    const miss = need.filter((m) => !apiSrc.includes(m));
    chk('P7a api.js 导出取证三方法', miss.length === 0, 'missing=' + miss.join(','));
    const needUi = ['Diagnosis（结构化诊断）', 'Repair Attempts（修复尝试 · 策略成功率）', 'Execution Detail（执行记录）', 'Action Replay（动作链重放）', 'JsonBlock'];
    const missUi = needUi.filter((m) => !tdSrc.includes(m));
    chk('P7b TaskDetail 渲染取证四块 + JsonBlock', missUi.length === 0, 'missing=' + missUi.join(' / '));
  } finally {
    child.kill();
  }

  console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
  if (failures.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
