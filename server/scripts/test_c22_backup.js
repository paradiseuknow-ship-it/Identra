'use strict';
// C22 守护测试 —— 数据备份 / 恢复全链（/api/backup/export + /api/backup/restore）。
// 覆盖（tmp 隔离真实服务器，零浏览器）：
//   B1 造数据（创建 Profile）→ 导出快照含 profiles.json 且含该 Profile
//   B2 快照含 vault.json（凭据密文随包）与 format/version 元数据
//   B3 删除该 Profile → 用旧快照恢复 → 200 + restored 含 profiles.json
//   B4 恢复后列表里 Profile 回来了（恢复真实生效，JsonStore 无缓存读盘即生效）
//   B5 坏格式恢复 → 400（format 不识别）
//   B6 快照不含明文凭据形态（vault.json 内容为密文结构）
// AI_PROVIDER=mock。恢复权限 workspace:delete / 导出 workspace:update（本地测试身份恒通过）。

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 22010 + (process.pid % 50);
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c22-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      AI_PROVIDER: 'mock',
      FPB_DATA_DIR: dataDir,
      FPB_VAULT_FILE: path.join(dataDir, 'vault.json'),
      FPB_SETTINGS_FILE: path.join(dataDir, 'runtime_settings.json'),
      FPB_MASTER_KEY: Buffer.alloc(32, 8).toString('base64'),
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
    if (!ready) { chk('B0 服务器启动', false, logs.join('').slice(-400)); throw new Error('server not ready'); }
    chk('B0 服务器启动', true, '');

    // 造数据
    const created = await req('POST', '/api/profiles', { name: 'C22 备份守护号', group: 'default' });
    const prof = JSON.parse(created.body || '{}');
    const pid = prof.id || prof.profile && prof.profile.id;
    chk('B0b 创建 Profile', created.code === 200 || created.code === 201, created.code + ' ' + created.body.slice(0, 150));

    // 造一条加密凭据 → 强制 vault.json 创建（快照必须随包密文凭据）
    const setSecret = await req('POST', '/api/vault/' + pid, { email: 'c22@test.local', password: 'pw-c22-guard' });
    chk('B0c 写入凭据（vault 创建）', setSecret.code === 200, setSecret.code + ' ' + setSecret.body.slice(0, 150));

    // B1 导出
    const exp = await req('GET', '/api/backup/export');
    const snap = JSON.parse(exp.body || '{}');
    const profilesArr = snap.files && snap.files['profiles.json'];
    chk('B1 导出 200 + 快照含 profiles.json 且含新号', exp.code === 200 &&
      Array.isArray(profilesArr) && profilesArr.some((x) => x.id === pid),
      exp.code + ' files=' + Object.keys(snap.files || {}).join(','));

    // B2 元数据 + vault
    chk('B2 format/version/vault 齐备', snap.format === 'identra-backup' && snap.version === 1 &&
      snap.files && snap.files['vault.json'] !== undefined,
      'format=' + snap.format + ' hasVault=' + !!(snap.files && snap.files['vault.json']));

    // B3 删除 → 恢复
    await req('DELETE', '/api/profiles/' + pid);
    const afterDel = await req('GET', '/api/profiles');
    const gone = !JSON.parse(afterDel.body || '[]').some((x) => x.id === pid);
    const restore = await req('POST', '/api/backup/restore', snap);
    let rj = {};
    try { rj = JSON.parse(restore.body); } catch (e) { /* ignore */ }
    chk('B3 删除后恢复 200 + restored 含 profiles.json', gone && restore.code === 200 &&
      Array.isArray(rj.restored) && rj.restored.includes('profiles.json'),
      'gone=' + gone + ' code=' + restore.code + ' ' + restore.body.slice(0, 200));

    // B4 恢复生效
    const afterRestore = await req('GET', '/api/profiles');
    const back = JSON.parse(afterRestore.body || '[]').some((x) => x.id === pid);
    chk('B4 恢复后 Profile 回归', back, afterRestore.body.slice(0, 200));

    // B5 坏格式
    const bad = await req('POST', '/api/backup/restore', { foo: 1 });
    chk('B5 坏格式恢复 → 400', bad.code === 400, bad.code + ' ' + bad.body.slice(0, 150));

    // B6 vault 密文形态（不应含明文 password 字段值——vault.json 本身就是密文结构）
    const vaultSnap = snap.files['vault.json'];
    const vaultRaw = vaultSnap === undefined ? 'ABSENT' : JSON.stringify(vaultSnap);
    chk('B6 vault 密文结构（快照不含明文密码）', vaultRaw !== 'ABSENT' &&
      !/"password"\s*:\s*"pw-c22-guard"/.test(vaultRaw), vaultRaw.slice(0, 120));

    // 防呆目录存在
    const preDir = fs.readdirSync(path.join(dataDir, 'backups')).filter((d) => d.startsWith('pre-restore-'));
    chk('B7 恢复前防呆快照目录生成', preDir.length >= 1, String(preDir));
  } finally {
    child.kill();
  }

  console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
  if (failures.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
