'use strict';
// C29 守护测试 —— 执行引擎操作补齐 + 契约/策略调试端点。
// 覆盖（tmp 隔离真实服务器，零浏览器；AI_PROVIDER=mock）：
//   P1 POST /execution/submit 缺 taskId → 400
//   P2 POST /execution/submit 未知 taskId → 非 2xx 且 ok:false（绝不静默成功）
//   P3 POST /execution/recovery → 200 + recovered/dead 数值
//   P4 POST /execution/resources/acquire 缺 profileId → 400
//   P5 POST /execution/resources/release 缺 profileId → 400
//   P6 POST /schema/validate 合法动作 → 200 + ok:true
//   P7 POST /schema/validate 非法动作 → 200 + ok:false + errors 数组
//   P8 POST /policy/decide 合法动作 → 200 + ok:true + effectiveRisk
//   P9 client 静态守护：api.js 六方法 + ExecutionPanel 补齐区块

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 22470 + (process.pid % 50);
const BASE = 'http://127.0.0.1:' + PORT;
const ROOT = path.join(__dirname, '..', '..');

// 合法样例必须自带业务完成契约：click 属 MUST_VERIFY，缺 verification(type≠none) 即判不合法
const VALID_ACTION = {
  type: 'click',
  target: { text: '加入购物车' },
  verification: { type: 'text_present', value: '购物车：1 件' },
};
const INVALID_ACTION = { type: 'definitely_not_a_type' };

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

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c29-'));
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

    // P1 submit 缺 taskId
    const s1 = await req('POST', '/api/ai/execution/submit', {});
    chk('P1 submit 缺 taskId → 400', s1.code === 400, s1.code + ' ' + s1.body.slice(0, 160));

    // P2 submit 未知 taskId → 非 2xx 且 ok:false
    const s2 = await req('POST', '/api/ai/execution/submit', { taskId: 'task_no_such_id' });
    const s2J = j(s2);
    chk('P2 submit 未知 taskId → 非 2xx + ok:false',
      s2.code >= 400 && s2J && s2J.ok === false, s2.code + ' ' + s2.body.slice(0, 200));

    // P3 recovery（实际返回 recovered/dead 为**数组**，UI 需按 length 渲染——固化该契约）
    const rc = await req('POST', '/api/ai/execution/recovery', { timeoutMs: 1000 });
    const rcJ = j(rc);
    const rcOk = rcJ && Array.isArray(rcJ.recovered) && Array.isArray(rcJ.dead);
    chk('P3 POST recovery → 200 + recovered/dead 均为数组',
      rc.code === 200 && rcOk, rc.code + ' ' + rc.body.slice(0, 200));

    // P4 acquire 缺 profileId
    const a1 = await req('POST', '/api/ai/execution/resources/acquire', {});
    chk('P4 acquire 缺 profileId → 400', a1.code === 400, a1.code + ' ' + a1.body.slice(0, 160));

    // P5 release 缺 profileId
    const r1 = await req('POST', '/api/ai/execution/resources/release', {});
    chk('P5 release 缺 profileId → 400', r1.code === 400, r1.code + ' ' + r1.body.slice(0, 160));

    // P6 schema validate 合法
    const v1 = await req('POST', '/api/ai/schema/validate', VALID_ACTION);
    const v1J = j(v1);
    chk('P6 schema/validate 合法动作 → 200 + ok:true',
      v1.code === 200 && v1J && v1J.ok === true, v1.code + ' ' + v1.body.slice(0, 200));

    // P7 schema validate 非法
    const v2 = await req('POST', '/api/ai/schema/validate', INVALID_ACTION);
    const v2J = j(v2);
    chk('P7 schema/validate 非法动作 → 200 + ok:false + errors',
      v2.code === 200 && v2J && v2J.ok === false && Array.isArray(v2J.errors) && v2J.errors.length > 0,
      v2.code + ' ' + v2.body.slice(0, 200));

    // P8 policy decide
    const p1 = await req('POST', '/api/ai/policy/decide', { action: VALID_ACTION });
    const p1J = j(p1);
    chk('P8 policy/decide → 200 + ok:true + effectiveRisk',
      p1.code === 200 && p1J && p1J.ok === true && p1J.effectiveRisk !== undefined,
      p1.code + ' ' + p1.body.slice(0, 200));

    // P9 client 静态守护
    const apiSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'api.js'), 'utf8');
    const uiSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'ExecutionPanel.jsx'), 'utf8');
    const needApi = ['executionSubmit:', 'executionRecovery:', 'resourceAcquire:', 'resourceRelease:', 'schemaValidate:', 'policyDecide:'];
    const missApi = needApi.filter((m) => !apiSrc.includes(m));
    chk('P9a api.js 导出执行操作与调试六方法', missApi.length === 0, 'missing=' + missApi.join(','));
    const needUi = ['提交执行', '崩溃恢复扫描', '动作契约校验 / 策略判定（只读调试）', 'acquireResource', 'releaseResource'];
    const missUi = needUi.filter((m) => !uiSrc.includes(m));
    chk('P9b ExecutionPanel 补齐提交/恢复/契约调试', missUi.length === 0, 'missing=' + missUi.join(' / '));
  } finally {
    child.kill();
  }

  console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
  if (failures.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
