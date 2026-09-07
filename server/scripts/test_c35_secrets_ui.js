'use strict';
// C35 守护测试 —— 凭据引用（credentialRef）治理 UI + 任务恢复 + A 类缺陷修复实证。
// 覆盖（tmp 隔离真实服务器，零浏览器；AI_PROVIDER=mock）：
//   R1  POST /ai/secrets 缺 profileId        → 400（不 500）
//   R2  POST /ai/secrets 正常创建（vault 未录）→ 200 + 脱敏形态（available=false）
//   R3  setVault 补录明文                    → GET /ai/secrets 同一引用 available=true + maskedEmail
//       （A 类缺陷修复最强实证：修复前 available 是注册时快照，恒为 false；
//        路径 = 先注册、后补录，排除 createSecret→refreshAvailability 的干扰）
//   R4  凭据列表响应体明文红线               → 全响应 JSON 不含明文 email/password
//   R5  DELETE /ai/secrets/:id               → 200；二次 DELETE → 404
//   R6  POST /ai/tasks/:id/recover 未知 id   → 400 任务不存在（路由挂载实证）
//   R7  recover 合法状态外（PENDING 任务）   → 400「不允许恢复」（语义守护，零浏览器）
//   R8  client 静态守护                      → api.js 导出四方法；GovernancePanel 含凭据引用卡；
//       TaskDetail 含恢复按钮；secretManager.maskedView 现算 available（防回归）

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 22360 + (process.pid % 50);
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c35-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      AI_PROVIDER: 'mock',
      FPB_DATA_DIR: dataDir,
      FPB_VAULT_FILE: path.join(dataDir, 'vault.json'),
      FPB_SETTINGS_FILE: path.join(dataDir, 'runtime_settings.json'),
      FPB_MASTER_KEY: Buffer.alloc(32, 12).toString('base64'),
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
    if (!ready) { chk('R0 服务器启动', false, logs.join('').slice(-400)); throw new Error('server not ready'); }
    chk('R0 服务器启动', true, '');

    // R1 缺 profileId → 400
    const r1 = await req('POST', '/api/ai/secrets', { type: 'email_password' });
    chk('R1 缺 profileId → 400', r1.code === 400 && /profileId/.test(r1.body), r1.code + ' ' + r1.body.slice(0, 120));

    // R2 先建 Profile，再注册引用（此刻 vault 未录 → available=false）
    const pr = await req('POST', '/api/profiles', { name: 'c35prof' });
    const profile = j(pr);
    chk('R2a 建 Profile → 200', pr.code === 200 && !!(profile && profile.id), pr.code + ' ' + pr.body.slice(0, 120));
    const r2 = await req('POST', '/api/ai/secrets', { profileId: profile.id, type: 'email_password', site: 'example-mail.com', label: 'c35 测试' });
    const b2 = j(r2);
    const credId = b2 && (b2.id || (b2.secret && b2.secret.id));
    chk('R2b 注册引用 → 200', r2.code === 200 && !!credId, r2.code + ' ' + r2.body.slice(0, 160));
    const view2 = b2 && b2.secret ? b2.secret : b2;
    chk('R2c 脱敏形态（available=false 无明文字段）', view2 && view2.available === false
      && view2.email === undefined && view2.password === undefined && view2.maskedEmail === null,
      JSON.stringify(view2).slice(0, 200));

    // R3 后补录明文 → 同一引用在列表中 available 现算为 true（A 类修复最强实证）
    const PLAIN_EMAIL = 'alice.trader@example-mail.com';
    const PLAIN_PASS = 'Sup3rSecret!Pass#35';
    const vr = await req('POST', '/api/vault/' + profile.id, {
      email: PLAIN_EMAIL, password: PLAIN_PASS,
      card: { number: '', expMonth: '', expYear: '', cvv: '', name: '', zip: '' },
    });
    chk('R3a vault 补录 → ok', vr.code === 200 && j(vr) && j(vr).ok === true, vr.code + ' ' + vr.body.slice(0, 120));
    const r3 = await req('GET', '/api/ai/secrets');
    const list3 = j(r3);
    const arr3 = Array.isArray(list3) ? list3 : (list3 && list3.secrets) || [];
    const rec3 = arr3.find((s) => s.id === credId);
    chk('R3b 同一引用 available 现算=true（修复实证）', !!rec3 && rec3.available === true,
      'available=' + (rec3 ? rec3.available : 'NOT_FOUND') + ' list=' + JSON.stringify(arr3).slice(0, 200));
    chk('R3c maskedEmail 脱敏格式', !!rec3 && rec3.maskedEmail === 'a***@example-mail.com',
      'maskedEmail=' + (rec3 ? JSON.stringify(rec3.maskedEmail) : 'NOT_FOUND'));

    // R4 明文红线：列表全响应体不得含明文 email/password
    const leak = arr3.length && (JSON.stringify(arr3).includes(PLAIN_EMAIL) || JSON.stringify(arr3).includes(PLAIN_PASS));
    chk('R4 列表明文红线（无 email/password 明文）', !leak, leak ? 'LEAK DETECTED' : 'clean');

    // R5 DELETE + 二次 DELETE 404
    const r5 = await req('DELETE', '/api/ai/secrets/' + credId);
    chk('R5a 删除 → ok', r5.code === 200, r5.code + ' ' + r5.body.slice(0, 120));
    const r5b = await req('DELETE', '/api/ai/secrets/' + credId);
    chk('R5b 二次删除 → 404', r5b.code === 404, r5b.code + ' ' + r5b.body.slice(0, 120));

    // R6 recover 未知 id → 400
    const r6 = await req('POST', '/api/ai/tasks/task_nosuch/recover', {});
    chk('R6 recover 未知 id → 400 任务不存在', r6.code === 400 && /不存在/.test(r6.body), r6.code + ' ' + r6.body.slice(0, 120));

    // R7 recover 状态机守护：PENDING 任务不允许恢复（零浏览器）
    const t7 = await req('POST', '/api/ai/tasks', { objective: '打开示例站点并截图', executionMode: 'ASSIST' });
    const task7 = j(t7);
    chk('R7a 创建 AI 任务 → 200', t7.code === 200 && !!(task7 && task7.id), t7.code + ' ' + t7.body.slice(0, 120));
    const r7 = task7 && task7.id ? await req('POST', '/api/ai/tasks/' + task7.id + '/recover', {}) : { code: 0, body: 'skip' };
    chk('R7b PENDING recover → 400 不允许恢复', r7.code === 400 && /不允许恢复/.test(r7.body), r7.code + ' ' + r7.body.slice(0, 140));

    // R8 client 静态守护
    const apiSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'api.js'), 'utf8');
    chk('R8a api.js 导出凭据引用三方法', ['listSecrets', 'createSecret', 'deleteSecret'].every((k) => apiSrc.includes(k + ':')), 'api.js');
    chk('R8b api.js 导出 aiRecoverTask', apiSrc.includes('aiRecoverTask:'), 'api.js');
    const govSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'GovernancePanel.jsx'), 'utf8');
    chk('R8c GovernancePanel 含凭据引用卡与创建表单', govSrc.includes('凭据引用') && govSrc.includes('createSecretRef') && govSrc.includes('listSecrets'), 'GovernancePanel.jsx');
    const tdSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'TaskDetail.jsx'), 'utf8');
    chk('R8d TaskDetail 含恢复按钮（状态门控 + aiRecoverTask）', tdSrc.includes('aiRecoverTask') && tdSrc.includes('RECOVERING'), 'TaskDetail.jsx');
    const smSrc = fs.readFileSync(path.join(ROOT, 'server', 'agent', 'secretManager.js'), 'utf8');
    chk('R8e maskedView 现算 available（computeAvailable 存在且被 maskedView 调用）', smSrc.includes('function computeAvailable') && /available: computeAvailable\(rec\)/.test(smSrc), 'secretManager.js');

  } catch (e) {
    chk('FATAL', false, String(e && e.stack || e));
  } finally {
    try { child.kill(); } catch (e) {}
  }

  console.log('\n==== C35 SUMMARY: ' + pass + ' pass / ' + fail + ' fail ====');
  if (failures.length) { console.log('FAILURES:\n' + failures.join('\n')); process.exit(1); }
  process.exit(0);
})();
