'use strict';
// C22：数据备份 / 恢复（全量 JSON 快照）。
//
// 设计：
//  - 范围 = data 目录全部 *.json（含 profiles/proxies/vault/ai* 全家）+ 独立路径的 vault 文件
//    （FPB_VAULT_FILE 指向 data 外时附加）。vault.json 内容是 AES-256-GCM 密文——离开主密钥不可解，
//    随包备份不泄密，且恢复时必须有它凭据才能还原。
//  - 导出 = 纯内存组装 { format, version, createdAt, files: { <name>.json: <parsed> } }，
//    由 HTTP 层流式下载；不做磁盘落盘（避免双写一致性问题）。
//  - 恢复 = fail-fast 校验（format/version/文件名白名单）→ 现有 data 目录整体快照到
//    <data>/backups/pre-restore-<ts>/（防呆：恢复出错可回滚）→ 逐文件写回。
//  - 文件名白名单 /^[A-Za-z0-9._-]+\.json$/：路径穿越防护；子目录（如 _p6_repair_backup）不进快照。

const fs = require('fs');
const path = require('path');

const BACKUP_FORMAT = 'identra-backup';
const BACKUP_VERSION = 1;
const FILE_RE = /^[A-Za-z0-9._-]+\.json$/;

function dataDir() {
  return process.env.FPB_DATA_DIR ? path.resolve(process.env.FPB_DATA_DIR) : path.join(__dirname, '..', 'data');
}

// 收集快照。vault 独立路径时以 'vault.json' 名并入（恢复端按 vault 实际路径写回）。
function collectSnapshot() {
  const dir = dataDir();
  const files = {};
  const list = fs.readdirSync(dir).filter((f) => FILE_RE.test(f));
  for (const f of list) {
    files[f] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  // vault 可能独立于 data 目录（FPB_VAULT_FILE）——未包含则补抓
  const vaultFile = process.env.FPB_VAULT_FILE ? path.resolve(process.env.FPB_VAULT_FILE) : path.join(dir, 'vault.json');
  if (!files['vault.json'] && fs.existsSync(vaultFile)) {
    files['vault.json'] = JSON.parse(fs.readFileSync(vaultFile, 'utf8'));
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: Date.now(),
    files,
  };
}

// 恢复。返回 { restored: [文件名], preRestoreDir }。
function restoreSnapshot(snapshot) {
  if (!snapshot || snapshot.format !== BACKUP_FORMAT) throw new Error('备份文件格式不识别（缺 format=identra-backup）');
  if (snapshot.version !== BACKUP_VERSION) throw new Error('备份版本不兼容: ' + snapshot.version);
  if (!snapshot.files || typeof snapshot.files !== 'object') throw new Error('备份缺 files 字段');

  const dir = dataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // 防呆：恢复前把当前 data 全量快照到 backups/pre-restore-<ts>/
  const preDir = path.join(dir, 'backups', 'pre-restore-' + Date.now());
  fs.mkdirSync(preDir, { recursive: true });
  for (const f of fs.readdirSync(dir).filter((f) => FILE_RE.test(f))) {
    fs.copyFileSync(path.join(dir, f), path.join(preDir, f));
  }
  const vaultFile = process.env.FPB_VAULT_FILE ? path.resolve(process.env.FPB_VAULT_FILE) : path.join(dir, 'vault.json');

  const restored = [];
  for (const [name, content] of Object.entries(snapshot.files)) {
    if (!FILE_RE.test(name)) throw new Error('备份含非法文件名: ' + name); // fail-fast：一个坏名整体拒绝
    const target = name === 'vault.json' ? vaultFile : path.join(dir, name);
    fs.writeFileSync(target, JSON.stringify(content, null, 2));
    restored.push(name);
  }
  return { restored, preRestoreDir: preDir };
}

module.exports = { collectSnapshot, restoreSnapshot, BACKUP_FORMAT, BACKUP_VERSION };
