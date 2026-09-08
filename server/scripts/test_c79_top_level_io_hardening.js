#!/usr/bin/env node
// C79 —— server/ 顶层老模块收尾扫（integrity/agentScore/db/auth/audit/geoip/proxyPool/
// settings/loadEnv/dataRoot 共 1253 行）守护测试：
//   D1 (A 类)：db.js 自持 I/O 未消费 C62 fsSafe —— readJson 把瞬时锁（EPERM/EBUSY）与
//     真损坏一并吞成 fallback[]，而 upsertProfile/deleteProfile/upsertTask 全是
//     read-all → modify → write-all RMW 链：一次瞬时锁后下一次 save* 就把整个集合
//     覆写成空 = 永久静默清空（C60/C61/C62 同族）；writeJson 裸 writeFileSync 非原子，
//     崩溃半截 JSON 又是下一次损坏 fallback 的直接来源。修复：范式对齐 identity.js
//    （锁重试 fail-loud + ENOENT fallback + 原子写）。
//   D2 (B 类)：settings.js readAll 同款静默 {} —— updateSettings 的 RMW 写回时
//     apiKey 密文等既有字段被静默丢弃。修复：锁重试 fail-loud（RMW 绝不带空 {} 落盘），
//     真损坏 fail-soft 但先侧车保全 .corrupt-<ts>。
//   D3 (B 类)：audit.js flush 非原子写 + load 失败后内存 [] 会被 scheduleFlush 落盘
//     覆写 = 审计历史（安全合规流）静默清空且损坏现场丢失。修复：读失败期间禁止落盘、
//     真损坏先侧车保全、flush 原子写（fail-open 设计对查询/内存链保留）。
// 零浏览器：FPB_DATA_DIR / FPB_SETTINGS_FILE 子进程隔离。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const here = __dirname;
let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + ': ' + detail); console.log('  FAIL ' + name + ' — ' + detail); }
}

function runInChild(tag, env, script) {
  const tmpJS = path.join(os.tmpdir(), 'c79-' + tag + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.js');
  fs.writeFileSync(tmpJS, script, 'utf8');
  const r = spawnSync(process.execPath, [tmpJS], {
    env: Object.assign({}, process.env, env),
    encoding: 'utf8',
    timeout: 120000,
  });
  if (r.status !== 0 || !(r.stdout || '').includes('RES:')) {
    console.log('  [diag ' + tag + '] status=' + r.status + ' stdout=' + String(r.stdout || '').slice(0, 300) + ' stderr=' + String(r.stderr || '').slice(0, 400));
  }
  return r;
}

function cleanup(tag) {
  const dir = (tag && typeof tag === 'string' && fs.existsSync(tag)) ? tag : null;
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
  for (const f of fs.readdirSync(os.tmpdir())) {
    if (f.startsWith('c79-')) { try { fs.rmSync(path.join(os.tmpdir(), f), { force: true }); } catch (e) {} }
  }
}

// ---- P1 (D1): db.js RMW 不再被瞬时锁/读错误静默降级 ----
{
  // 注意：P1a 会把 profiles.json 变成目录（EISDIR 注入），必须与 P1b 用独立 dataDir
  const dataDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'c79-db-'));
  // P1a: 非瞬时 fs 错误（EISDIR：把目录当文件读）必须 fail-loud 冒泡，绝不吞成 fallback[]
  const r1 = runInChild('db-eisdir', { FPB_DATA_DIR: dataDirA }, `
    'use strict';
    const db = require('${here.replace(/\\/g, '/')}/../db.js');
    const fs = require('fs');
    // 伪造：profiles.json 是一个目录 → readFileSync 抛 EISDIR（非瞬时锁，readFileSyncRetry 直接 throw）
    fs.mkdirSync(require('path').join(process.env.FPB_DATA_DIR, 'profiles.json'));
    try {
      const p = db.getProfiles();
      console.log('SWALLOWED:' + JSON.stringify(p));
    } catch (e) {
      console.log('THREW:' + (e.code || e.message));
    }
  `);
  chk('P1a db EISDIR fail-loud（绝不吞成 fallback[]）', r1.stdout.includes('THREW:'), 'out=' + r1.stdout.trim() + ' err=' + r1.stderr.trim().slice(0, 200));
  cleanup(dataDirA);

  // P1b: 写路径原子性 —— 正常写后无 .tmp 残留 + roundtrip 一致 + ENOENT fallback 契约保留
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c79-db2-'));
  const r2 = runInChild('db-atomic', { FPB_DATA_DIR: dataDir }, `
    'use strict';
    const db = require('${here.replace(/\\/g, '/')}/../db.js');
    const fs = require('fs');
    const path = require('path');
    const out = {};
    // ENOENT：合法缺省
    out.enoent = JSON.stringify(db.getProxies());
    // RMW roundtrip
    db.upsertProfile({ id: 'p1', os: 'windows', browser: 'chrome' });
    db.upsertTask({ id: 't1', name: 'wf' });
    db.saveProxies([{ id: 'px1', server: '1.2.3.4:8080', password: 'secret-pw' }]);
    out.profiles = db.getProfiles().length;
    out.tasks = db.getTasks().length;
    out.proxyPwMasked = db.getProxiesPublic()[0].password.slice(0, 6);
    // 盘上不应有明文密码（B.11 加密落盘固化）
    const raw = fs.readFileSync(path.join(process.env.FPB_DATA_DIR, 'proxies.json'), 'utf8');
    out.plaintextLeak = raw.includes('secret-pw');
    out.hasEnc = raw.includes('passwordEnc');
    // 无 .tmp 残留
    out.tmpLeft = fs.readdirSync(process.env.FPB_DATA_DIR).filter((f) => f.endsWith('.tmp'));
    console.log('RES:' + JSON.stringify(out));
  `);
  let o2 = {};
  try { o2 = JSON.parse(r2.stdout.split('RES:')[1] || '{}'); } catch (e) {}
  chk('P1b ENOENT fallback 契约', o2.enoent === '[]', 'got=' + o2.enoent);
  chk('P1b RMW roundtrip 三集合', o2.profiles === 1 && o2.tasks === 1, JSON.stringify(o2));
  chk('P1b 代理密码密文落盘（无明文泄漏）', o2.plaintextLeak === false && o2.hasEnc === true, JSON.stringify(o2));
  chk('P1b 原子写无 .tmp 残留', Array.isArray(o2.tmpLeft) && o2.tmpLeft.length === 0, JSON.stringify(o2.tmpLeft));
  cleanup(dataDir);
}

// ---- P2 (D2): settings.js RMW 防覆写 + 损坏侧车 ----
{
  // P2a 会把 setFile 变成目录（EISDIR 注入），必须与 P2b 用独立文件
  const dataDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'c79-set-'));
  const setFileA = path.join(dataDirA, 'runtime_settings.json');
  // P2a: 损坏 settings 文件 → getMasked fail-soft + .corrupt 侧车保全（apiKey 密文现场可恢复）
  const r1 = runInChild('set-corrupt', { FPB_SETTINGS_FILE: setFileA, FPB_DATA_DIR: dataDirA }, `
    'use strict';
    const fs = require('fs');
    fs.writeFileSync(process.env.FPB_SETTINGS_FILE, '{"llm":{"apiKey": TRUNCATED', 'utf8');
    const settings = require('${here.replace(/\\/g, '/')}/../settings.js');
    const out = {};
    try {
      const m = settings.getMasked();
      out.softOk = !!m && typeof m.llm === 'object';
    } catch (e) { out.softOk = false; out.err = e.message; }
    out.corruptSidecar = fs.readdirSync(process.env.FPB_DATA_DIR).filter((f) => f.includes('.corrupt-')).length;
    // EISDIR：RMW 链必须 fail-loud，绝不带空 {} 落盘
    fs.unlinkSync(process.env.FPB_SETTINGS_FILE);
    fs.mkdirSync(process.env.FPB_SETTINGS_FILE);
    try {
      settings.updateSettings({ apiKey: 'sk-should-not-land' });
      out.rmw = 'SWALLOWED';
    } catch (e) { out.rmw = 'THREW'; }
    console.log('RES:' + JSON.stringify(out));
  `);
  let o1 = {};
  try { o1 = JSON.parse(r1.stdout.split('RES:')[1] || '{}'); } catch (e) {}
  chk('P2a 损坏文件 getMasked fail-soft', o1.softOk === true, JSON.stringify(o1));
  // getMasked 内部 readAll 双调用（自身 + getEnvAudit）→ 每次读损坏各保全一份侧车，语义正确
  chk('P2a 损坏现场 .corrupt 侧车保全', (o1.corruptSidecar || 0) >= 1, JSON.stringify(o1));
  chk('P2a RMW 瞬时锁类错误 fail-loud（不覆写）', o1.rmw === 'THREW', JSON.stringify(o1));
  cleanup(dataDirA);

  // P2b: 正常 RMW roundtrip + 密文落盘 + 覆盖语义
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c79-set2-'));
  const setFile = path.join(dataDir, 'runtime_settings.json');
  const r2 = runInChild('set-rmw', { FPB_SETTINGS_FILE: setFile, FPB_DATA_DIR: dataDir }, `
    'use strict';
    const fs = require('fs');
    const settings = require('${here.replace(/\\/g, '/')}/../settings.js');
    const out = {};
    settings.updateSettings({ apiKey: 'sk-test-1234567890', model: 'deepseek-chat' });
    const raw = fs.readFileSync(process.env.FPB_SETTINGS_FILE, 'utf8');
    out.noPlaintextKey = !raw.includes('sk-test-1234567890');
    out.hasCipher = raw.includes('apiKey');
    const masked = settings.getMasked();
    out.masked = masked.llm.apiKey.masked;
    settings.updateSettings({ apiKey: null }); // 清除 → 让位 .env
    const raw2 = fs.readFileSync(process.env.FPB_SETTINGS_FILE, 'utf8');
    out.cleared = !raw2.includes('"apiKey"');
    out.modelKept = raw2.includes('deepseek-chat');
    console.log('RES:' + JSON.stringify(out));
  `);
  let o2 = {};
  try { o2 = JSON.parse(r2.stdout.split('RES:')[1] || '{}'); } catch (e) {}
  chk('P2b RMW roundtrip：apiKey 密文落盘无明文', o2.noPlaintextKey === true && o2.hasCipher === true, JSON.stringify(o2));
  chk('P2b getMasked 脱敏', typeof o2.masked === 'string' && o2.masked.includes('****'), JSON.stringify(o2));
  chk('P2b 清除只删目标字段（model 保留）', o2.cleared === true && o2.modelKept === true, JSON.stringify(o2));
  cleanup(dataDir);
}

// ---- P3 (D3): audit.js 读失败禁落盘 + 原子写 + 脱敏固化 ----
{
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c79-audit-'));
  // P3a: 正常 log → flush → 新进程 query 可见（持久化 roundtrip）+ 无 .tmp 残留
  const r1 = runInChild('audit-persist', { FPB_DATA_DIR: dataDir }, `
    'use strict';
    const audit = require('${here.replace(/\\/g, '/')}/../audit.js');
    audit.log({ action: 'profile.create', actorId: 'u1', resourceType: 'profile', resourceId: 'p1', detail: { name: 'n' } });
    audit.flush();
    console.log('COUNT:' + audit.count());
  `);
  const r1b = runInChild('audit-read', { FPB_DATA_DIR: dataDir }, `
    'use strict';
    const fs = require('fs');
    const audit = require('${here.replace(/\\/g, '/')}/../audit.js');
    const q = audit.query({ action: 'profile.create' });
    const tmpLeft = fs.readdirSync(process.env.FPB_DATA_DIR).filter((f) => f.endsWith('.tmp'));
    console.log('RES:' + JSON.stringify({ total: q.total, first: q.entries[0] && q.entries[0].action, tmpLeft }));
  `);
  let o1 = {};
  try { o1 = JSON.parse(r1b.stdout.split('RES:')[1] || '{}'); } catch (e) {}
  chk('P3a 落盘→跨进程 query roundtrip', o1.total === 1 && o1.first === 'profile.create', JSON.stringify(o1));
  chk('P3a 原子写无 .tmp 残留', Array.isArray(o1.tmpLeft) && o1.tmpLeft.length === 0, JSON.stringify(o1.tmpLeft));

  // P3b: 损坏 audit 文件 → query fail-open + .corrupt 侧车 + 后续 log+flush 绝不覆写损坏现场
  const auditFile = path.join(dataDir, 'identity_audit.json');
  const corruptPayload = '[{"at":1,"action":"HISTORY-MUST-SURVIVE"';
  const r2 = runInChild('audit-corrupt', { FPB_DATA_DIR: dataDir }, `
    'use strict';
    const fs = require('fs');
    fs.writeFileSync(require('path').join(process.env.FPB_DATA_DIR, 'identity_audit.json'), ${JSON.stringify(corruptPayload)}, 'utf8');
    const audit = require('${here.replace(/\\/g, '/')}/../audit.js');
    const out = {};
    out.queryTotal = audit.query({}).total; // fail-open：查询返回空不抛
    audit.log({ action: 'x.new' });
    audit.flush(); // 必须被 _loadFailed 拦截：磁盘上的损坏现场原样保留
    out.diskAfter = fs.readFileSync(require('path').join(process.env.FPB_DATA_DIR, 'identity_audit.json'), 'utf8');
    out.sidecar = fs.readdirSync(process.env.FPB_DATA_DIR).filter((f) => f.includes('.corrupt-')).length;
    console.log('RES:' + JSON.stringify(out));
  `);
  let o2 = {};
  try { o2 = JSON.parse(r2.stdout.split('RES:')[1] || '{}'); } catch (e) {}
  chk('P3b 损坏文件 query fail-open', o2.queryTotal === 0, JSON.stringify(o2));
  chk('P3b 读失败期间 flush 不覆写磁盘（损坏现场原样保留）', o2.diskAfter === corruptPayload, 'disk=' + String(o2.diskAfter).slice(0, 80));
  chk('P3b 损坏现场 .corrupt 侧车保全', o2.sidecar === 1, JSON.stringify(o2));

  // P3c: 脱敏固化（敏感键不落盘）+ 环形上限 —— 独立 dataDir（P3b 故意把磁盘留成损坏现场）
  const dataDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'c79-audit2-'));
  const r3 = runInChild('audit-redact', { FPB_DATA_DIR: dataDirB }, `
    'use strict';
    const fs = require('fs');
    const audit = require('${here.replace(/\\/g, '/')}/../audit.js');
    audit.resetForTests();
    audit.log({ action: 't.redact', detail: { password: 'PLAIN-PW', nested: { authToken: 'PLAIN-TK' }, safe: 'ok' } });
    audit.flush();
    const raw = fs.readFileSync(require('path').join(process.env.FPB_DATA_DIR, 'identity_audit.json'), 'utf8');
    const out = {};
    out.noPw = !raw.includes('PLAIN-PW') && !raw.includes('PLAIN-TK');
    out.hasSafe = raw.includes('ok');
    for (let i = 0; i < (audit.MAX_ENTRIES + 120); i++) audit.log({ action: 'bulk' });
    audit.flush();
    out.ringSize = audit.query({ action: 'bulk' }).total;
    console.log('RES:' + JSON.stringify(out));
  `);
  let o3 = {};
  try { o3 = JSON.parse(r3.stdout.split('RES:')[1] || '{}'); } catch (e) {}
  chk('P3c 敏感键脱敏落盘（password/authToken 无明文）', o3.noPw === true && o3.hasSafe === true, JSON.stringify(o3));
  chk('P3c MAX_ENTRIES 环形上限', o3.ringSize === 5000, 'got=' + o3.ringSize);
  cleanup(dataDirB);
  cleanup(dataDir);
}

console.log('RESULT pass=' + pass + ' fail=' + fail);
if (failures.length) { console.log('FAILURES:\\n- ' + failures.join('\\n- ')); process.exit(1); }
