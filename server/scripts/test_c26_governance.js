'use strict';
// C26 守护测试 —— 治理中心三族端点（/api/auth 下的 api-keys / audit / workspaces）。
// 覆盖（tmp 隔离真实服务器，零浏览器；AI_PROVIDER=mock）：
//   P1  GET  /auth/me             → 200 + user
//   P2  POST /auth/api-keys       → 201 + 明文 key（fpbak_ 前缀，仅此一次）
//   P3  GET  /auth/api-keys       → 200 + 列表含该 key 且**不含明文**
//   P4  DELETE /auth/api-keys/:id → 200；二次删除 → 404
//   P5  GET  /auth/audit          → 200 + entries 含 apikey.create / apikey.revoke
//   P6  GET  /auth/audit/export   → 200 + format=fpb-audit
//   P7  GET  /auth/audit?action=  → 过滤生效
//   P8  POST /auth/workspaces     → 201
//   P9  GET  /auth/workspaces     → 列表含新工作空间
//   P10 POST members 缺 username  → 400（不 500）
//   P11 client 静态守护：api.js 导出治理方法 + App.jsx 挂载 governance tab

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 22260 + (process.pid % 50);
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c26-'));
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
    if (!ready) { chk('P0 服务器启动', false, logs.join('').slice(-400)); throw new Error('server not ready'); }
    chk('P0 服务器启动', true, '');

    // P1 /auth/me
    const me = await req('GET', '/api/auth/me');
    const meJ = j(me);
    chk('P1 GET /auth/me → 200 + user', me.code === 200 && meJ && meJ.user, me.code + ' ' + me.body.slice(0, 160));

    // P2 创建 API Key（明文一次性）
    const created = await req('POST', '/api/auth/api-keys', { name: 'c26-guard', readOnly: true });
    const cJ = j(created);
    const plain = cJ && cJ.key;
    chk('P2 POST /auth/api-keys → 201 + 明文 fpbak_',
      created.code === 201 && typeof plain === 'string' && plain.startsWith('fpbak_'),
      created.code + ' ' + created.body.slice(0, 200));

    // P3 列表不含明文
    const list = await req('GET', '/api/auth/api-keys');
    const lJ = j(list);
    const found = lJ && (lJ.keys || []).find((k) => k.id === (cJ && cJ.id));
    const leaked = j(list) && JSON.stringify(lJ).includes(String(plain));
    chk('P3 GET /auth/api-keys → 含该 key 且不含明文',
      list.code === 200 && !!found && !leaked,
      list.code + ' found=' + !!found + ' leaked=' + !!leaked);

    // P4 撤销 + 重复撤销 404
    const del = await req('DELETE', '/api/auth/api-keys/' + (cJ && cJ.id));
    const del2 = await req('DELETE', '/api/auth/api-keys/' + (cJ && cJ.id));
    chk('P4 DELETE key → 200，重复 → 404', del.code === 200 && del2.code === 404,
      'del=' + del.code + ' del2=' + del2.code);

    // P5 审计可见 create/revoke
    const aud = await req('GET', '/api/auth/audit');
    const aJ = j(aud);
    const actions = ((aJ && aJ.entries) || []).map((e) => e.action);
    chk('P5 GET /auth/audit → 200 + apikey.create/revoke 入账',
      aud.code === 200 && actions.includes('apikey.create') && actions.includes('apikey.revoke'),
      aud.code + ' actions=' + actions.slice(0, 6).join(','));

    // P6 导出
    const exp = await req('GET', '/api/auth/audit/export');
    const eJ = j(exp);
    chk('P6 GET /auth/audit/export → 200 + format=fpb-audit',
      exp.code === 200 && eJ && eJ.format === 'fpb-audit' && Array.isArray(eJ.entries),
      exp.code + ' ' + exp.body.slice(0, 160));

    // P7 过滤生效
    const filtered = await req('GET', '/api/auth/audit?action=apikey.create');
    const fJ = j(filtered);
    const allCreate = ((fJ && fJ.entries) || []).every((e) => e.action === 'apikey.create');
    chk('P7 audit?action 过滤生效',
      filtered.code === 200 && (fJ.entries || []).length > 0 && allCreate,
      filtered.code + ' n=' + ((fJ && fJ.entries) || []).length);

    // P8 创建工作空间
    const ws = await req('POST', '/api/auth/workspaces', { name: 'C26 守护空间' });
    const wJ = j(ws);
    chk('P8 POST /auth/workspaces → 201', ws.code === 201 && wJ && wJ.workspace && wJ.workspace.id,
      ws.code + ' ' + ws.body.slice(0, 160));

    // P9 工作空间列表
    const wsl = await req('GET', '/api/auth/workspaces');
    const wlJ = j(wsl);
    chk('P9 GET /auth/workspaces → 含新空间',
      wsl.code === 200 && (wlJ.workspaces || []).some((w) => w.id === (wJ && wJ.workspace && wJ.workspace.id)),
      wsl.code + ' ' + wsl.body.slice(0, 160));

    // P10 成员缺 username → 400
    const badMember = await req('POST', '/api/auth/workspaces/' + (wJ && wJ.workspace && wJ.workspace.id) + '/members', { role: 'MEMBER' });
    chk('P10 POST members 缺 username → 400', badMember.code === 400, badMember.code + ' ' + badMember.body.slice(0, 160));

    // P11 client 静态守护
    const apiSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'api.js'), 'utf8');
    const appSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'App.jsx'), 'utf8');
    const panelSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'GovernancePanel.jsx'), 'utf8');
    const needApi = ['apiKeys:', 'createApiKey:', 'revokeApiKey:', 'auditLog:', 'auditExport:', 'workspaces:', 'createWorkspace:', 'workspaceMembers:', 'addWorkspaceMember:'];
    const missing = needApi.filter((m) => !apiSrc.includes(m));
    chk('P11a api.js 导出治理方法', missing.length === 0, 'missing=' + missing.join(','));
    chk('P11b App.jsx 挂载 governance tab + 面板',
      appSrc.includes("'governance'") && appSrc.includes('<GovernancePanel'),
      'nav=' + appSrc.includes("'governance'") + ' panel=' + appSrc.includes('<GovernancePanel'));
    chk('P11c 明文一次性展示 + 审计只读（无删除入口）',
      panelSrc.includes('明文仅出现这一次') && !/auditDelete|deleteAudit/.test(panelSrc),
      'once-flag=' + panelSrc.includes('明文仅出现这一次'));
  } finally {
    child.kill();
  }

  console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
  if (failures.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
