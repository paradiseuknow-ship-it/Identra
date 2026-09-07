'use strict';
// C54 守护测试 —— backup.js 恢复链完整性（tmp 隔离、零浏览器、零网络、纯模块）。
// 缺陷背景（老模块 backup.js（C22 引入）首轮缺陷扫描，两个 B 类数据完整性缺陷）：
//   D1 部分恢复假契约：restoreSnapshot 把非法文件名校验混在写入循环里，
//      「fail-fast 一个坏名整体拒绝」不成立——坏名之前的文件已被覆写（HTTP 层
//      /api/backup/restore 直收用户上传 JSON，坏/手改备份可造成部分恢复）；
//      且拒绝路径残留 pre-restore 防呆目录。
//   D2 外部 vault 无法回滚：恢复前防呆快照只拷 data 目录内 *.json，
//      FPB_VAULT_FILE 指向目录外时当前 vault（AES-256-GCM 密文凭据）不进快照，
//      但恢复会覆写它 → 覆写后旧密文永久丢失。
// 覆盖：
//   P1 快乐路径：恢复生效（新增+覆盖）+ pre-restore 快照含旧文件
//   P2 D1：坏名整体拒绝 + 坏名之前的文件不被覆写 + 不产生 pre-restore 目录
//   P3 非法文件名族：路径穿越 / 反斜杠子目录 / 非 .json 全拒（未落盘）
//   P4 D2：外部 vault 恢复覆写生效 + 旧密文进防呆快照（可回滚）
//   P5 目录内 vault 默认路径：恢复写入 + 防呆含旧 vault（原行为保持）
//   P6 collectSnapshot：仅顶层 *.json + 外部 vault 并入 + 目录内 vault 优先（不双抓）
//   P7 format/version 拒绝发生在任何写盘之前（无 pre-restore 残留）

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

(async () => {
  const backup = require(path.join(ROOT, 'server', 'backup.js'));
  const savedDataDir = process.env.FPB_DATA_DIR;
  const savedVaultFile = process.env.FPB_VAULT_FILE;
  const tmpRoots = [];
  const mkTmp = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'c54-' + tag + '-')); tmpRoots.push(d); return d; };

  try {
    // P1 快乐路径：恢复生效 + 防呆快照含旧文件
    {
      const dataDir = mkTmp('p1');
      process.env.FPB_DATA_DIR = dataDir;
      delete process.env.FPB_VAULT_FILE;
      fs.writeFileSync(path.join(dataDir, 'a.json'), JSON.stringify([{ v: 1 }]));
      const r = backup.restoreSnapshot({
        format: backup.BACKUP_FORMAT, version: backup.BACKUP_VERSION,
        files: { 'a.json': [{ v: 2 }], 'b.json': { fresh: true } },
      });
      chk('P1a 恢复生效（覆盖+新增）',
        readJson(path.join(dataDir, 'a.json'))[0].v === 2 && readJson(path.join(dataDir, 'b.json')).fresh === true,
        JSON.stringify(r));
      const pre = readJson(path.join(r.preRestoreDir, 'a.json'));
      chk('P1b pre-restore 快照含旧内容', Array.isArray(pre) && pre[0].v === 1, r.preRestoreDir);
    }

    // P2 D1：坏名整体拒绝，坏名之前的文件不被覆写，且不产生 pre-restore 目录
    {
      const dataDir = mkTmp('p2');
      process.env.FPB_DATA_DIR = dataDir;
      delete process.env.FPB_VAULT_FILE;
      fs.writeFileSync(path.join(dataDir, 'aaa.good.json'), JSON.stringify({ old: true }));
      let threw = null;
      try {
        backup.restoreSnapshot({
          format: backup.BACKUP_FORMAT, version: backup.BACKUP_VERSION,
          files: { 'aaa.good.json': { new: true }, 'bad name!.json': { x: 1 } }, // 坏名排在已写文件之后
        });
      } catch (e) { threw = e; }
      const untouched = readJson(path.join(dataDir, 'aaa.good.json'));
      const backupsDir = path.join(dataDir, 'backups');
      chk('P2a 坏名整体拒绝（抛错）', !!threw && /非法文件名/.test(threw.message), threw && threw.message);
      chk('P2b 坏名之前的文件未被覆写（部分恢复消除）', untouched.old === true, JSON.stringify(untouched));
      chk('P2c 拒绝路径不残留 pre-restore 目录', !fs.existsSync(backupsDir), fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).join(',') : 'absent');
    }

    // P3 非法文件名族全拒且未落盘
    {
      const dataDir = mkTmp('p3');
      process.env.FPB_DATA_DIR = dataDir;
      delete process.env.FPB_VAULT_FILE;
      const evil = ['../evil.json', 'sub\\x.json', 'x.txt', 'dir/e.json'];
      let rejected = 0;
      for (const name of evil) {
        try {
          backup.restoreSnapshot({ format: backup.BACKUP_FORMAT, version: backup.BACKUP_VERSION, files: { [name]: {} } });
        } catch (e) { if (/非法文件名/.test(e.message)) rejected++; }
      }
      chk('P3a 穿越/反斜杠/非json 全拒', rejected === evil.length, rejected + '/' + evil.length);
      chk('P3b 拒绝后 data 目录无新增文件', fs.readdirSync(dataDir).length === 0, fs.readdirSync(dataDir).join(','));
    }

    // P4 D2：外部 vault 被覆写生效 + 旧密文进防呆快照
    {
      const base = mkTmp('p4'); const dataDir = path.join(base, 'data'); const extDir = path.join(base, 'ext');
      fs.mkdirSync(dataDir); fs.mkdirSync(extDir);
      process.env.FPB_DATA_DIR = dataDir;
      const extVault = path.join(extDir, 'vault.json');
      process.env.FPB_VAULT_FILE = extVault;
      fs.writeFileSync(extVault, JSON.stringify({ cipher: 'OLD-SECRET' }));
      fs.writeFileSync(path.join(dataDir, 'aiTasks.json'), '[]');
      const r = backup.restoreSnapshot({
        format: backup.BACKUP_FORMAT, version: backup.BACKUP_VERSION,
        files: { 'vault.json': { cipher: 'NEW-SECRET' }, 'aiTasks.json': [] },
      });
      chk('P4a 外部 vault 恢复覆写生效', readJson(extVault).cipher === 'NEW-SECRET', readJson(extVault).cipher);
      const preVault = readJson(path.join(r.preRestoreDir, 'vault.json'));
      chk('P4b 旧密文进防呆快照（可回滚）', preVault.cipher === 'OLD-SECRET', JSON.stringify(preVault));
    }

    // P5 目录内 vault 默认路径：恢复写入 + 防呆含旧 vault（原行为保持）
    {
      const dataDir = mkTmp('p5');
      process.env.FPB_DATA_DIR = dataDir;
      delete process.env.FPB_VAULT_FILE; // 默认 = dataDir/vault.json
      fs.writeFileSync(path.join(dataDir, 'vault.json'), JSON.stringify({ cipher: 'OLD-IN-DIR' }));
      const r = backup.restoreSnapshot({
        format: backup.BACKUP_FORMAT, version: backup.BACKUP_VERSION,
        files: { 'vault.json': { cipher: 'NEW-IN-DIR' } },
      });
      chk('P5a 目录内 vault 恢复写入', readJson(path.join(dataDir, 'vault.json')).cipher === 'NEW-IN-DIR', '');
      chk('P5b 旧 vault 进防呆快照', readJson(path.join(r.preRestoreDir, 'vault.json')).cipher === 'OLD-IN-DIR', '');
    }

    // P6 collectSnapshot：仅顶层 *.json + 外部 vault 并入 + 目录内 vault 优先（不双抓）
    {
      const base = mkTmp('p6'); const dataDir = path.join(base, 'data'); const extDir = path.join(base, 'ext');
      fs.mkdirSync(dataDir); fs.mkdirSync(extDir); fs.mkdirSync(path.join(dataDir, 'archive'));
      process.env.FPB_DATA_DIR = dataDir;
      fs.writeFileSync(path.join(dataDir, 'top1.json'), '[1]');
      fs.writeFileSync(path.join(dataDir, 'top2.json'), '[2]');
      fs.writeFileSync(path.join(dataDir, 'notes.txt'), 'skip');
      fs.writeFileSync(path.join(dataDir, 'archive', 'inner.json'), '[skip]'); // 子目录不进快照
      fs.writeFileSync(path.join(extDir, 'vault.json'), JSON.stringify({ cipher: 'EXT' }));
      process.env.FPB_VAULT_FILE = path.join(extDir, 'vault.json');
      let snap = backup.collectSnapshot();
      chk('P6a 仅顶层 *.json（txt/子目录排除）',
        snap.files['top1.json'] && snap.files['top2.json'] && !snap.files['notes.txt'] && !snap.files['inner.json'],
        Object.keys(snap.files).join(','));
      chk('P6b 外部 vault 并入', snap.files['vault.json'] && snap.files['vault.json'].cipher === 'EXT', JSON.stringify(snap.files['vault.json']));

      // 目录内已有 vault.json → 以目录内为准（外部不双抓，与恢复端写回目标一致性留给 C22 全链）
      fs.writeFileSync(path.join(dataDir, 'vault.json'), JSON.stringify({ cipher: 'INSIDE' }));
      snap = backup.collectSnapshot();
      chk('P6c 目录内 vault 优先（不双抓）', snap.files['vault.json'].cipher === 'INSIDE', JSON.stringify(snap.files['vault.json']));
    }

    // P7 format/version 拒绝发生在任何写盘之前
    {
      const dataDir = mkTmp('p7');
      process.env.FPB_DATA_DIR = dataDir;
      delete process.env.FPB_VAULT_FILE;
      let threw = 0;
      try { backup.restoreSnapshot({ format: 'other', version: 1, files: {} }); } catch (e) { threw++; }
      try { backup.restoreSnapshot({ format: backup.BACKUP_FORMAT, version: 99, files: {} }); } catch (e) { threw++; }
      try { backup.restoreSnapshot({ format: backup.BACKUP_FORMAT, version: 1 }); } catch (e) { threw++; }
      chk('P7a 三类坏格式全拒', threw === 3, String(threw));
      chk('P7b 拒绝路径不落盘（无 backups/）', !fs.existsSync(path.join(dataDir, 'backups')), '');
    }
  } finally {
    // 环境还原
    if (savedDataDir === undefined) delete process.env.FPB_DATA_DIR; else process.env.FPB_DATA_DIR = savedDataDir;
    if (savedVaultFile === undefined) delete process.env.FPB_VAULT_FILE; else process.env.FPB_VAULT_FILE = savedVaultFile;
  }

  console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
  if (failures.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
