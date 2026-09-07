'use strict';
// C28 守护测试 —— Intelligence 决策与评估（decision / profile-recommend / profiles+record / evaluation / matrix）。
// 覆盖（tmp 隔离真实服务器，零浏览器；AI_PROVIDER=mock）：
//   P1 POST decision（有 objective）→ 200 + decision 对象
//   P2 POST decision（空）→ 400（不 500）
//   P3 POST profile-recommend（未知站点）→ 200 + matched=false + reason
//   P4 GET  profiles → 200 + 数组
//   P5 POST profiles/:id/record（site+ok）→ 200，随后 GET profiles 含该 profileId
//   P6 POST record 缺 site → 400
//   P7 GET  evaluation/report → 200 + routerAccuracy 字段存在
//   P8 GET  site-profile-matrix → 200 + sites/profiles/matrix 三段结构
//   P9 client 静态守护：api.js 六方法 + IntelligencePanel 两个新视图

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 22400 + (process.pid % 50);
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c28-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      AI_PROVIDER: 'mock',
      FPB_DATA_DIR: dataDir,
      FPB_VAULT_FILE: path.join(dataDir, 'vault.json'),
      FPB_SETTINGS_FILE: path.join(dataDir, 'runtime_settings.json'),
      FPB_MASTER_KEY: Buffer.alloc(32, 14).toString('base64'),
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

    // P1 decision
    const dec = await req('POST', '/api/ai/intelligence/decision', { objective: '在 guard.example 下单', targetUrl: 'https://guard.example/cart' });
    const dJ = j(dec);
    chk('P1 POST decision → 200 + decision 对象',
      dec.code === 200 && dJ && dJ.decision && typeof dJ.decision === 'object',
      dec.code + ' ' + dec.body.slice(0, 200));

    // P2 decision 空 → 400
    const decBad = await req('POST', '/api/ai/intelligence/decision', {});
    chk('P2 POST decision 空 → 400', decBad.code === 400, decBad.code + ' ' + decBad.body.slice(0, 160));

    // P3 recommend
    const rec = await req('POST', '/api/ai/intelligence/profile-recommend', { site: 'guard.example' });
    const rJ = j(rec);
    chk('P3 POST profile-recommend → 200 + matched/reason',
      rec.code === 200 && rJ && typeof rJ.matched === 'boolean' && (rJ.matched || typeof rJ.reason === 'string'),
      rec.code + ' ' + rec.body.slice(0, 200));

    // P4 profiles
    const profs = await req('GET', '/api/ai/intelligence/profiles');
    chk('P4 GET profiles → 200 + 数组', profs.code === 200 && Array.isArray(j(profs)),
      profs.code + ' ' + profs.body.slice(0, 160));

    // P5 record outcome → 落库可见
    const pid = 'c28-guard-profile';
    const rec1 = await req('POST', '/api/ai/intelligence/profiles/' + pid + '/record', { site: 'guard.example', ok: true });
    const profs2 = await req('GET', '/api/ai/intelligence/profiles');
    const hasPid = (j(profs2) || []).some((x) => x.profileId === pid);
    chk('P5 POST record → 200 且 profiles 可见该 profileId',
      rec1.code === 200 && hasPid, rec1.code + ' hasPid=' + hasPid + ' ' + rec1.body.slice(0, 160));

    // P6 record 缺 site → 400
    const recBad = await req('POST', '/api/ai/intelligence/profiles/' + pid + '/record', { ok: true });
    chk('P6 POST record 缺 site → 400', recBad.code === 400, recBad.code + ' ' + recBad.body.slice(0, 160));

    // P7 evaluation
    const ev = await req('GET', '/api/ai/intelligence/evaluation/report');
    const eJ = j(ev) || {};
    const rep = eJ.report || eJ; // 端点返回 { ok, report } 包装；UI 侧需解包（回归该解包语义）
    chk('P7 GET evaluation/report → 200 + report.routerAccuracy 字段',
      ev.code === 200 && rep && 'routerAccuracy' in rep,
      ev.code + ' ' + ev.body.slice(0, 200));

    // P8 matrix
    const mx = await req('GET', '/api/ai/intelligence/site-profile-matrix');
    const mJ = j(mx);
    chk('P8 GET site-profile-matrix → 200 + sites/profiles/matrix',
      mx.code === 200 && mJ && Array.isArray(mJ.sites) && Array.isArray(mJ.profiles) && mJ.matrix && typeof mJ.matrix === 'object',
      mx.code + ' ' + mx.body.slice(0, 200));

    // P9 client 静态守护
    const apiSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'api.js'), 'utf8');
    const uiSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'IntelligencePanel.jsx'), 'utf8');
    const needApi = ['intelDecision:', 'intelRecommend:', 'intelProfiles:', 'intelRecordOutcome:', 'intelEvaluation:', 'intelMatrix:'];
    const missApi = needApi.filter((m) => !apiSrc.includes(m));
    chk('P9a api.js 导出决策/评估六方法', missApi.length === 0, 'missing=' + missApi.join(','));
    const needUi = ["['advisor'", "['health'", 'Router 决策试算', '经验健康看板', '站点 × 环境矩阵', '环境推荐（Profile Advisor）'];
    const missUi = needUi.filter((m) => !uiSrc.includes(m));
    chk('P9b IntelligencePanel 新增 advisor/health 视图', missUi.length === 0, 'missing=' + missUi.join(' / '));
  } finally {
    child.kill();
  }

  console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
  if (failures.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
