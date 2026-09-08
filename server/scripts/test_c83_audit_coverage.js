'use strict';
// C83 守护测试 —— 审计覆盖面对账（水平复审 round 3：mutation 路由 vs auditReq 全量枚举）：
//   D1 (B 类审计链断裂)：browser 会话驱动面零审计 —— launch/stop 有 auditReq 而
//     navigate / evaluate（RCE 等价面）/ human-click/type/google-search 全裸奔；
//     cookies import（认证态注入）/ export（完整 cookie exfil 面，含登录态）零审计；
//     automation/run（业务关键 mutation：注册/下单工作流完整执行轨迹）零审计 ——
//     launch 有审计而 run 无 = 审计链在最重要的事件上断裂。
//   修复：8 处埋点（+automation.run.fail 失败路径 = 9 actions），detail 只记长度/数量/
//     url 截断（human_type 的 text、evaluate 的 script 可能携带 vault 解密凭据 →
//     永不见内容，C81 凭据明文红线同族；audit.redact 兜底为第二层）。
//   边界（不审计，冻结在 allowlist）：preview-fp / check-geo / check-inline /
//     automation/preview（纯预览或诊断读面，无状态变更）；human-move / human-scroll
//     （高频流，逐次审计会把环形缓冲里的关键安全事件冲刷掉）。
//   守护：P2 结构化对账 —— index.js 全部 mutation 路由必须含 auditReq 或命中
//     冻结 allowlist（双向断言：新 mutation 漏埋点即红；allowlist 条目漂移即红）；
//     C83 九个 action 逐一存在；红线字段只允许 *Len 形态。
//   P1 行为面（零浏览器 Mode A）：profile.create/update/delete 审计落盘且字段正确；
//     evaluate 禁用时 403 且**不**产生审计（只在真实执行时落）。
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 23040 + (process.pid % 50);
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
// 冻结 allowlist：{ 路由 path: 不审计理由 }。新增豁免必须在此登记理由。
const AUDIT_ALLOWLIST = {
  '/profiles/preview-fp': '纯预览（指纹试算），无状态变更',
  '/proxies/:id/check-geo': '诊断读面（外呼 geo 查询），无状态变更',
  '/proxies/check-inline': '诊断读面（外呼代理测试），无状态变更',
  '/automation/preview': '纯预览（模板生成），无状态变更',
  '/browser/:id/human-move': '高频拟人流：逐次审计会冲刷环形缓冲中的关键安全事件',
  '/browser/:id/human-scroll': '高频拟人流：同 human-move',
};

function parseMutationRoutes(src) {
  const lines = src.split(/\r?\n/);
  const routeRe = /^(proxyRouter|browserRouter|vaultRouter|storageRouter|settingsRouter|taskRouter|automationRouter|cookieRouter|templateRouter|router|app)\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/;
  const out = [];
  lines.forEach((l, i) => {
    const m = l.match(routeRe);
    if (m) out.push({ line: i, verb: m[2], rpath: m[3], router: m[1] });
  });
  for (const r of out) {
    const end = lines.findIndex((l, i) => i > r.line && l === '});');
    if (end < 0) continue;
    r.body = lines.slice(r.line, end + 1).join('\n');
  }
  return out.filter((r) => r.body && ['post', 'put', 'delete', 'patch'].includes(r.verb));
}

function structuralScan() {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const muts = parseMutationRoutes(src);

  // P2a: 双向对账
  for (const m of muts) {
    const audited = /auditReq\(/.test(m.body);
    if (audited) {
      chk('P2a ' + m.verb.toUpperCase() + ' ' + m.rpath + ' 已审计', true, '');
      if (AUDIT_ALLOWLIST[m.rpath] !== undefined) {
        chk('P2a ' + m.rpath + ' 同时命中 allowlist（漂移）', false, '路由已有审计但仍在豁免表，应从 allowlist 移除');
      }
    } else if (AUDIT_ALLOWLIST[m.rpath] !== undefined) {
      chk('P2a ' + m.verb.toUpperCase() + ' ' + m.rpath + ' 冻结豁免（' + AUDIT_ALLOWLIST[m.rpath] + '）', true, '');
    } else {
      chk('P2a ' + m.verb.toUpperCase() + ' ' + m.rpath + ' 已审计', false, 'mutation 路由零审计且未登记豁免 —— 补 auditReq 或在 allowlist 登记理由');
    }
  }
  // allowlist 反向活性：豁免条目必须仍对应真实存在的路由（防路由改名后豁免悬空）
  for (const p of Object.keys(AUDIT_ALLOWLIST)) {
    chk('P2b allowlist 活性 ' + p, muts.some((m) => m.rpath === p), '豁免表条目没有对应路由，应清理');
  }

  // P2c: C83 九个 action 逐一存在
  const actions = ['browser.evaluate', 'browser.navigate', 'browser.human_click', 'browser.human_type',
    'browser.human_search', 'automation.run', 'automation.run.fail', 'cookie.import', 'cookie.export'];
  for (const a of actions) {
    chk('P2c action 落地 ' + a, src.includes("'" + a + "'"), 'source 中未找到 ' + a);
  }

  // P2d: 凭据明文红线 —— 埋点 detail 只允许长度/数量形态
  chk('P2d evaluate 只记 scriptLen', /auditReq\(req, 'browser\.evaluate'[\s\S]{0,120}scriptLen: script\.length/.test(src), 'evaluate 埋点未用 scriptLen 形态');
  chk('P2d evaluate 不落脚本原文', !/auditReq\(req, 'browser\.evaluate'[\s\S]{0,200}script:\s*script/.test(src), 'evaluate 埋点疑似携带脚本原文');
  chk('P2d human_type 只记 textLen', /auditReq\(req, 'browser\.human_type'[\s\S]{0,200}textLen: String\(req\.body\.text/.test(src), 'human_type 埋点未用 textLen 形态');
  chk('P2d human_type 不落输入原文', !/auditReq\(req, 'browser\.human_type'[\s\S]{0,300}text:\s*(?!Len)/.test(src), 'human_type 埋点疑似携带输入原文');
  chk('P2d cookie 两面只记 count', /auditReq\(req, 'cookie\.export'[\s\S]{0,120}count: cookies\.length/.test(src) && /auditReq\(req, 'cookie\.import'[\s\S]{0,120}count: cookies\.length/.test(src), 'cookie 埋点未用 count 形态');

  // P2e: automation/run 双路径（成功 + 失败）都有埋点
  const runRoute = muts.find((m) => m.rpath === '/automation/run');
  chk('P2e automation/run 成功路径埋点', !!runRoute && /automation\.run'/.test(runRoute.body) && !/automation\.run\.fail/.test(runRoute.body.split('catch')[0]), 'success 埋点缺失');
  chk('P2e automation/run 失败路径埋点', !!runRoute && /automation\.run\.fail'/.test(runRoute.body), 'fail 埋点缺失');

  // P2f: cookie.export 是 GET 面但必须审计（exfil 面）——结构上确认挂在 export handler
  const expRoute = parseMutationRoutes(src).concat(parseRoutesAll(src)).find((r) => r.rpath === '/cookies/:id/export');
  chk('P2f cookie.export handler 含审计', !!expRoute && /cookie\.export'/.test(expRoute.body), 'export handler 未埋点');
}
function parseRoutesAll(src) {
  const lines = src.split(/\r?\n/);
  const routeRe = /^(proxyRouter|browserRouter|vaultRouter|storageRouter|settingsRouter|taskRouter|automationRouter|cookieRouter|templateRouter|router|app)\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/;
  const out = [];
  lines.forEach((l, i) => {
    const m = l.match(routeRe);
    if (m) out.push({ line: i, verb: m[2], rpath: m[3] });
  });
  for (const r of out) {
    const end = lines.findIndex((l, i) => i > r.line && l === '});');
    if (end < 0) continue;
    r.body = lines.slice(r.line, end + 1).join('\n');
  }
  return out.filter((r) => r.body);
}

(async () => {
  structuralScan();

  // ---- P1: 行为面（零浏览器 Mode A）----
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c83-'));
  const srv = bootServer(PORT, dataDir);
  try {
    if (!(await waitReady())) { chk('P0 服务器启动', false, 'not ready'); throw new Error('server not ready'); }
    chk('P0 服务器启动', true, '');

    const rr = await req('POST', '/api/auth/register', { username: 'u83', password: 'u83-pass-1', email: 'u83@example.com' });
    chk('P0 register → 201', rr.code === 201, 'code=' + rr.code);
    const lg = j(await req('POST', '/api/auth/login', { username: 'u83', password: 'u83-pass-1' }));
    const tk = lg && lg.token;
    chk('P0 login → token', !!tk, JSON.stringify(lg).slice(0, 60));

    const auditOf = async (action) => j(await req('GET', '/api/auth/audit?action=' + encodeURIComponent(action) + '&limit=100', undefined, tk));

    // P1a: create → 审计落盘且 resourceId/detail.name 正确
    const cp = j(await req('POST', '/api/profiles', { name: 'c83-profile' }, tk));
    chk('P1a 建配置 → 200', !!cp && !!cp.id, JSON.stringify(cp).slice(0, 100));
    const aCreate = await auditOf('profile.create');
    const eCreate = aCreate && aCreate.entries && aCreate.entries.find((e) => e.resourceId === cp.id);
    chk('P1a profile.create 审计落盘', !!eCreate, JSON.stringify(aCreate).slice(0, 120));
    chk('P1a create 审计 detail.name', !!eCreate && eCreate.detail && eCreate.detail.name === 'c83-profile', JSON.stringify(eCreate).slice(0, 160));

    // P1b: update → 审计
    const up = await req('PUT', '/api/profiles/' + cp.id, { name: 'c83-profile-2' }, tk);
    chk('P1b 改配置 → 200', up.code === 200, 'code=' + up.code);
    const aUp = await auditOf('profile.update');
    chk('P1b profile.update 审计落盘', !!aUp && aUp.entries && aUp.entries.length >= 1, JSON.stringify(aUp).slice(0, 120));

    // P1c: evaluate 禁用 → 403 且不产生审计（负向控制：只在真实执行时落）
    const ev = await req('POST', '/api/browser/' + cp.id + '/evaluate', { script: '1+1' }, tk);
    chk('P1c evaluate 禁用 → 403', ev.code === 403, 'code=' + ev.code);
    const aEv = await auditOf('browser.evaluate');
    chk('P1c 禁用态不产生 evaluate 审计', !!aEv && aEv.entries && aEv.entries.length === 0, JSON.stringify(aEv).slice(0, 120));

    // P1d: delete → 审计
    const del = await req('DELETE', '/api/profiles/' + cp.id, undefined, tk);
    chk('P1d 删配置 → 200', del.code === 200, 'code=' + del.code);
    const aDel = await auditOf('profile.delete');
    chk('P1d profile.delete 审计落盘', !!aDel && aDel.entries && aDel.entries.length >= 1, JSON.stringify(aDel).slice(0, 120));
  } catch (e) {
    chk('P1 流程异常', false, String(e.message || e));
  } finally {
    try { srv.kill(); } catch (e) {}
  }

  try {
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (f.startsWith('fpb-c83-')) { try { fs.rmSync(path.join(os.tmpdir(), f), { recursive: true, force: true }); } catch (e) {} }
    }
  } catch (e) {}

  console.log('\n===== C83 RESULT: ' + pass + ' passed, ' + fail + ' failed =====');
  if (fail) { failures.forEach((f) => console.log('  FAIL: ' + f)); process.exit(1); }
})();
