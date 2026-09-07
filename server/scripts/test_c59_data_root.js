'use strict';

// C59 守护测试：数据根统一 + legacy 迁移 + integrity FPB_DATA_DIR 对齐 + 备份覆盖。
// 纯 tmp 隔离 / 零浏览器 / 零网络。子进程验证「真正会执行的那份代码」（require 时求值）。

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else {
    let d = '';
    if (detail !== undefined) { try { d = JSON.stringify(detail); } catch (e) { d = String(detail); } }
    fail++; failures.push(name + (d ? ' :: ' + d.slice(0, 300) : '')); console.log('  FAIL ' + name + (d ? ' :: ' + d.slice(0, 300) : ''));
  }
}

const REPO = path.resolve(__dirname, '..', '..');
const SRV = path.join(REPO, 'server');

// P2 —— 迁移助手（同进程注入 dirs，纯 tmp）
(function testMigrationHelper() {
  console.log('[P2] migrateLegacyFile 注入目录矩阵');
  const { migrateLegacyFile } = require(path.join(SRV, 'dataRoot.js'));
  const t1 = fs.mkdtempSync(path.join(os.tmpdir(), 'c59mig-'));
  const legacyDir = path.join(t1, 'legacy');
  const canonicalDir = path.join(t1, 'canonical');
  fs.mkdirSync(legacyDir); fs.mkdirSync(canonicalDir);
  fs.writeFileSync(path.join(legacyDir, 'x.json'), JSON.stringify({ v: 1 }));

  // 隔离模式默认跳过（当前进程通常无 FPB_DATA_DIR，但显式 force 走注入 dirs）
  const r0 = migrateLegacyFile('x.json', { canonicalDir, legacyDir, force: true });
  assert('P2a legacy 存在 + canonical 缺失 → migrated', r0 === 'migrated', r0);
  assert('P2b 迁移后 canonical 内容与 legacy 一致',
    JSON.parse(fs.readFileSync(path.join(canonicalDir, 'x.json'), 'utf8')).v === 1);

  const r1 = migrateLegacyFile('x.json', { canonicalDir, legacyDir, force: true });
  assert('P2c canonical 已存在 → canonical-exists（幂等，绝不覆盖）', r1 === 'canonical-exists', r1);

  fs.writeFileSync(path.join(canonicalDir, 'y.json'), JSON.stringify({ v: 'canonical' }));
  fs.writeFileSync(path.join(legacyDir, 'y.json'), JSON.stringify({ v: 'legacy' }));
  const r2 = migrateLegacyFile('y.json', { canonicalDir, legacyDir, force: true });
  assert('P2d 双方都存在 → canonical-exists 且内容保留 canonical',
    r2 === 'canonical-exists' && JSON.parse(fs.readFileSync(path.join(canonicalDir, 'y.json'), 'utf8')).v === 'canonical');

  const r3 = migrateLegacyFile('z.json', { canonicalDir, legacyDir, force: true });
  assert('P2e 双方都缺失 → no-legacy（不 throw 不建文件）',
    r3 === 'no-legacy' && !fs.existsSync(path.join(canonicalDir, 'z.json')));

  // 隔离模式：FPB_DATA_DIR 在场时默认 skip（防真实数据泄入测试 tmp）
  process.env.FPB_DATA_DIR = t1;
  const r4 = migrateLegacyFile('x.json', { canonicalDir, legacyDir });
  delete process.env.FPB_DATA_DIR;
  assert('P2f FPB_DATA_DIR 隔离模式 → skipped-isolated（不碰真实 legacy）', r4 === 'skipped-isolated', r4);
})();

// 子进程模板：设置/不设置 FPB_DATA_DIR 后 require 真实模块并回显关键路径
function runChild(env, code) {
  return execFileSync(process.execPath, ['-e', code], {
    env: Object.assign({}, process.env, env),
    cwd: REPO,
    encoding: 'utf8',
  });
}

// P1 —— 隔离对齐（child，FPB_DATA_DIR=T1）：三模块 + db 全部落 T1（真实 require 求值）
(function testIsolatedAlignment() {
  console.log('[P1] FPB_DATA_DIR 隔离下四模块目录对齐（子进程真实 require）');
  const t1 = fs.mkdtempSync(path.join(os.tmpdir(), 'c59t1-'));
  const code = `
    const path = require('path');
    const db = require('${SRV.replace(/\\/g, '\\\\')}/db.js');
    const identity = require('${SRV.replace(/\\/g, '\\\\')}/identity.js');
    const audit = require('${SRV.replace(/\\/g, '\\\\')}/audit.js');
    const fpTemplates = require('${SRV.replace(/\\/g, '\\\\')}/fpTemplates.js');
    db.upsertProfile({ id: 'c59probe' });
    console.log(JSON.stringify({
      identity: identity.DATA_DIR,
      audit: audit.AUDIT_FILE,
      tpl: fpTemplates.TPL_FILE,
      dbProbe: require('fs').existsSync(path.join(process.env.FPB_DATA_DIR, 'profiles.json')),
    }));`;
  const out = JSON.parse(runChild({ FPB_DATA_DIR: t1 }, code));
  assert('P1a identity.DATA_DIR 落 T1', out.identity === t1, out.identity);
  assert('P1b audit.AUDIT_FILE 落 T1', out.audit === path.join(t1, 'identity_audit.json'), out.audit);
  assert('P1c fpTemplates.TPL_FILE 落 T1', out.tpl === path.join(t1, 'fp_templates.json'), out.tpl);
  assert('P1d db 行为探针：profiles.json 实际写入 T1', out.dbProbe === true);
})();

// P3 —— 默认根（child 无 env）：执行真实函数，无 FS 写
(function testDefaultRoot() {
  console.log('[P3] 默认根 = <repo>/data（子进程真实求值）');
  const code = `
    const { dataRoot, legacyDataRoot } = require('${SRV.replace(/\\/g, '\\\\')}/dataRoot.js');
    console.log(JSON.stringify({ root: dataRoot(), legacy: legacyDataRoot() }));`;
  const out = JSON.parse(runChild({}, code));
  assert('P3a dataRoot() === <repo>/data', out.root === path.join(REPO, 'data'), out.root);
  assert('P3b legacyDataRoot() === <repo>/server/data', out.legacy === path.join(REPO, 'server', 'data'), out.legacy);
})();

// P4 —— integrity 跟随数据根（child，FPB_DATA_DIR=T1）
(function testIntegrityAlignment() {
  console.log('[P4] integrity.profileDataDir 跟随 FPB_DATA_DIR');
  const t1 = fs.mkdtempSync(path.join(os.tmpdir(), 'c59t4-'));
  const code = `
    const integrity = require('${SRV.replace(/\\/g, '\\\\')}/integrity.js');
    console.log(JSON.stringify({ dir: integrity.profileDataDir('p1') }));`;
  const out = JSON.parse(runChild({ FPB_DATA_DIR: t1 }, code));
  assert('P4a profileDataDir 落 T1/profiles/p1', out.dir === path.join(t1, 'profiles', 'p1'), out.dir);
})();

// P5 —— 备份覆盖（真实行为）：统一后 identity 数据自动进 collectSnapshot
(function testBackupCoverage() {
  console.log('[P5] 统一根后 collectSnapshot 覆盖 identity 数据');
  const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'c59t5-'));
  fs.writeFileSync(path.join(t2, 'identity_users.json'), JSON.stringify([{ id: 'u1' }]));
  fs.writeFileSync(path.join(t2, 'profiles.json'), JSON.stringify([{ id: 'p1' }]));
  const code = `
    const backup = require('${SRV.replace(/\\/g, '\\\\')}/backup.js');
    const snap = backup.collectSnapshot();
    console.log(JSON.stringify({ files: Object.keys(snap.files).sort() }));`;
  const out = JSON.parse(runChild({ FPB_DATA_DIR: t2 }, code));
  assert('P5a 快照包含 identity_users.json（C59 前 server/data 分裂时为零覆盖）',
    out.files.includes('identity_users.json'), out.files);
  assert('P5b 快照包含 profiles.json', out.files.includes('profiles.json'), out.files);
})();

console.log('\n==== test_c59_data_root ====');
console.log('PASS=' + pass + ' FAIL=' + fail);
if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
