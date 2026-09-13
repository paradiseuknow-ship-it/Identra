'use strict';
// C22：数据备份 / 恢复（全量 JSON 快照）。
//
// 设计：
//  - 范围 = 数据根顶层全部 *.json（profiles/proxies/vault/identity 全家 + ai* 全家）
//    + 独立路径的 vault 文件（FPB_VAULT_FILE 指向 data 外时附加）。vault.json 内容是
//    AES-256-GCM 密文——离开主密钥不可解，随包备份不泄密，且恢复时必须有它凭据才能还原。
//  - 导出 = 纯内存组装 { format, version, createdAt, files, fileRoots, roots }，由 HTTP 层
//    流式下载；不做磁盘落盘（避免双写一致性问题）。
//  - 恢复 = fail-fast 校验（format/version/文件名白名单）→ 现有两个数据根整体快照到
//    <root>/backups/pre-restore-<ts>/（防呆：恢复出错可回滚）→ 逐文件写回。
//  - 文件名白名单 /^[A-Za-z0-9._-]+\.json$/：路径穿越防护。
//
// ★ C116 D3（边界登记 · 子目录不进快照）——**保留为设计边界，不修**：
//   快照范围恒为「数据根顶层的 *.json」，任何子目录一律不进。2026-09-12 实测规模：
//     db 根  <repo>/data/profiles           76,185 文件 / 24,470 目录 / 5,100,520,648 B
//            <repo>/data/evidence            12,251 文件 /    786 目录 /   753,310,908 B
//            <repo>/data/_p6_repair_backup        1 文件 /           —  /           739 B
//     AI 根  <repo>/server/data/archive          17 文件 /      7 目录 /    76,060,964 B
//            <repo>/server/data/evidence        214 文件 /      1 目录 /    11,316,336 B
//            <repo>/server/data/_final100_backup 20 文件 /      2 目录 /    18,555,641 B
//            <repo>/server/data/_phase12_backup   6 文件 /           —  /    11,541,221 B
//   ⇒ 合计约 5.9 GB 的子目录内容**永不进入备份**（其中 profiles ~4.75 GiB 占绝对多数）。
//   为何不修：① profiles 是可重建的 Chrome user-data 目录（体量大、含 SingletonLock 等
//   运行态文件、跨机不可迁移）；② evidence 快照是体量无界的观测产物，塞进「纯内存组装 +
//   HTTP 流式下载」的 JSON 备份会把导出推到不现实的量级；③ 快照的定位本就是
//   **JSON 状态备份**，不是全盘灾备镜像。
//   ⚠️ 因此风险定性必须写清：**本备份不构成完整灾备**——换机恢复后 profiles 与 evidence
//   子目录为空，需要重新生成。调用方不得把「恢复成功」理解为「回到故障前全量状态」。
//
// ★ C116 D1（A 类 · AI store 零备份覆盖）：
//   此前 dataDir() 只解析 db 根 <repo>/data，而 AI 集合（JsonStore 的 FILES：aiExecutions /
//   aiAttempts / aiTasks / aiSteps / aiPlannerEvidence / aiSkill* …）按设计住在 AI 根
//   <repo>/server/data（.gitignore:22-23）。实测两侧差距：AI 根 8,785,767 字节真实集合
//   vs db 根同名文件全是 2 字节空桩（`[]`）——于是「导出」得到的是空集合，「恢复」又把空集合
//   写回，流程全程报成功。最坏情况：换机/重装后恢复，agent 全量记忆、证据链、执行记录、
//   Skill 库静默蒸发，且备份文件看起来完好。原注释「含 ai* 全家」是**假陈述**。
//   修复 = 快照覆盖两个根 + 每文件记录所属根（fileRoots，v2）。
//
//   ★ v1 兼容必须保持语义**不变**（全部回 db 根）：旧版导出的 ai*.json 是 db 根里的空桩，
//   若按集合名把它们路由回 AI 根，就会用 `[]` 覆盖 1.7MB 的真实集合 —— 那会从
//   「备份缺数据」升级成「恢复毁数据」。宁可旧备份继续少数据，也绝不毁数据。

const fs = require('fs');
const path = require('path');
// C115：恢复写回改用共享原子写原语（瞬时锁退避 + tmp/rename）
const { atomicWriteFileSync } = require('./fsSafe');
const { dataRoot, aiStoreRoot } = require('./dataRoot');
const { FILES } = require('./agent/storage/jsonStore');

const BACKUP_FORMAT = 'identra-backup';
// C116：1 → 2。v2 新增 fileRoots/roots；恢复端同时接受 v1（旧备份语义不变）与 v2。
const BACKUP_VERSION = 2;
const ACCEPTED_VERSIONS = [1, 2];
const FILE_RE = /^[A-Za-z0-9._-]+\.json$/;

// 集合名 → 所属数据根。AI 集合的归属由 JsonStore 的 FILES 注册表**唯一裁定**，
// 因此「同名文件同时出现在两个根」时不会产生歧义（会优先取 AI 根）。
// 不变量：FILES 名与 db 根自有名（profiles/proxies/tasks/identity*/vault/settings）不重名——
// 由 test_c116 的注册表不相交断言守护。
const AI_STORE_NAMES = new Set(Object.values(FILES));
// 根标识（写进快照的 fileRoots，保持自描述：恢复端不依赖路径也不依赖当前注册表）
const ROOT_DB = 'db';
const ROOT_AI = 'ai';

function rootOf(name) {
  return AI_STORE_NAMES.has(name) ? ROOT_AI : ROOT_DB;
}

function listTopJson(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => FILE_RE.test(f));
  } catch (e) {
    return [];
  }
}

// 解析两个数据根。opts.roots 是**测试注入面**：生产恒定走 dataRoot()/aiStoreRoot()，
// 但隔离测试下两者都等于 FPB_DATA_DIR ⇒ 两个根塌缩成一个，**双根语义无法被隔离测试覆盖**
//（这正是 C116 D1 长期未被发现的原因）。故提供与 migrationJsonToSqlite.run({jsonDir})、
// identityFilePath(rootOverride) 同风格的最小注入面，让守护测试能真实执行非隔离语义。
function resolveRoots(opts) {
  const o = (opts && opts.roots) || null;
  return {
    [ROOT_DB]: (o && o.db) ? path.resolve(o.db) : dataRoot(),
    [ROOT_AI]: (o && o.ai) ? path.resolve(o.ai) : aiStoreRoot(),
  };
}


// 收集快照（C116：覆盖两个数据根）。vault 独立路径时以 'vault.json' 名并入
// （恢复端按 vault 实际路径写回）。
function collectSnapshot(opts) {
  const roots = resolveRoots(opts);
  const available = {
    [ROOT_DB]: new Set(listTopJson(roots[ROOT_DB])),
    [ROOT_AI]: new Set(listTopJson(roots[ROOT_AI])),
  };

  const files = {};
  const fileRoots = {};
  const names = new Set([...available[ROOT_DB], ...available[ROOT_AI]]);
  for (const f of names) {
    // 首选由注册表裁定的根；该根没有此文件时回落到另一根（不丢数据优先于路径洁癖——
    // 例如某 AI 集合被误放在 db 根，仍应进备份而不是被静默丢弃）。
    const primary = rootOf(f);
    const secondary = primary === ROOT_AI ? ROOT_DB : ROOT_AI;
    const which = available[primary].has(f) ? primary : (available[secondary].has(f) ? secondary : null);
    if (!which) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(roots[which], f), 'utf8'));
    } catch (e) {
      continue; // 坏文件不进快照：不让单个损坏文件使整份导出失败（与既有容错一致）
    }
    files[f] = parsed;
    fileRoots[f] = which;
  }

  // vault 可能独立于数据根（FPB_VAULT_FILE）——未包含则补抓，归属 db 根（恢复端按实际路径写回）
  const dbDir = roots[ROOT_DB];
  const vaultFile = process.env.FPB_VAULT_FILE ? path.resolve(process.env.FPB_VAULT_FILE) : path.join(dbDir, 'vault.json');
  if (!files['vault.json'] && fs.existsSync(vaultFile)) {
    files['vault.json'] = JSON.parse(fs.readFileSync(vaultFile, 'utf8'));
    fileRoots['vault.json'] = ROOT_DB;
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: Date.now(),
    files,
    // v2 新增：每文件所属数据根（恢复端据此写回原位）+ 两个根的绝对路径（仅诊断，恢复不依赖它）
    fileRoots,
    roots,
  };
}

// 恢复。返回 { restored: [文件名], preRestoreDir, preRestoreDirs }。
function restoreSnapshot(snapshot, opts) {
  if (!snapshot || snapshot.format !== BACKUP_FORMAT) throw new Error('备份文件格式不识别（缺 format=identra-backup）');
  if (ACCEPTED_VERSIONS.indexOf(snapshot.version) < 0) throw new Error('备份版本不兼容: ' + snapshot.version);
  if (!snapshot.files || typeof snapshot.files !== 'object') throw new Error('备份缺 files 字段');

  // v1（C116 之前的导出）只有 files、没有根标记，其内容一律来自 db 根（当时实现只扫该根）。
  // ★ 必须保持「回 db 根」——v1 里的 ai*.json 是 db 根的空桩（[]），若改按集合名路由到 AI 根，
  // 就会用空集合覆盖真实集合：从「备份缺数据」升级为「恢复毁数据」。少数据可接受，毁数据不可接受。
  const isV2 = snapshot.version >= 2 && snapshot.fileRoots && typeof snapshot.fileRoots === 'object';
  const targetRootOf = (name) => {
    if (isV2) {
      const w = snapshot.fileRoots[name];
      if (w === ROOT_AI || w === ROOT_DB) return w;
    }
    return ROOT_DB;
  };

  // C54 / D1：两遍式——先全量校验文件名与内容可序列化，再写盘。
  // 原实现把非法文件名校验混在写入循环里，「fail-fast 一个坏名整体拒绝」是假契约：
  // 坏名之前的文件已被覆写（部分恢复），且拒绝路径残留 pre-restore 防呆目录。
  // 现在任一非法 → 未落任何盘即拒绝，也不创建防呆目录（拒绝的恢复不留垃圾）。
  for (const [name, content] of Object.entries(snapshot.files)) {
    if (!FILE_RE.test(name)) throw new Error('备份含非法文件名: ' + name);
    if (content === undefined) throw new Error('备份文件内容非法（undefined 不可序列化）: ' + name);
  }

  const dirs = resolveRoots(opts);
  const dbDir = dirs[ROOT_DB];
  const vaultFile = process.env.FPB_VAULT_FILE ? path.resolve(process.env.FPB_VAULT_FILE) : path.join(dbDir, 'vault.json');
  const vaultOutside = (() => {
    const rel = path.relative(dbDir, vaultFile);
    return rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel));
  })();

  // 实际会被写到的根（只对这些根做防呆，避免为「本次恢复根本不会碰的根」白复制一份，
  // 例如把 v1 旧备份恢复到一个 8MB 的 AI store 上时不该无谓地整目录复制）。
  const touched = new Set(Object.keys(snapshot.files).map(targetRootOf));
  if (!vaultOutside) touched.add(ROOT_DB);
  for (const w of touched) {
    if (!fs.existsSync(dirs[w])) fs.mkdirSync(dirs[w], { recursive: true });
  }

  // 防呆：把会被覆写的根整体快照到 <root>/backups/pre-restore-<ts>/
  // C116：此前只快照 db 根 ⇒ 恢复会覆写 AI 集合却没有任何回滚点（C54/D2 同类缺陷：
  // 「外部 vault 被覆写后旧密文无法回滚」）。现在逐根快照 + 统一时间戳，可整体回滚。
  const ts = Date.now();
  const preDirs = {};
  for (const w of touched) {
    const pre = path.join(dirs[w], 'backups', 'pre-restore-' + ts);
    fs.mkdirSync(pre, { recursive: true });
    for (const f of listTopJson(dirs[w])) {
      fs.copyFileSync(path.join(dirs[w], f), path.join(pre, f));
    }
    preDirs[w] = pre;
  }
  // C54 / D2：外部 vault（FPB_VAULT_FILE 指向数据根外）也必须进防呆快照——
  // 恢复会覆写它，原实现只快照根内 *.json，外部 vault 被覆写后旧密文无法回滚。
  if (vaultOutside && fs.existsSync(vaultFile)) {
    const anchor = preDirs[ROOT_DB] || preDirs[ROOT_AI];
    fs.copyFileSync(vaultFile, path.join(anchor, 'vault.json'));
  }

  const restored = [];
  for (const [name, content] of Object.entries(snapshot.files)) {
    const target = name === 'vault.json' ? vaultFile : path.join(dirs[targetRootOf(name)], name);
    // C115：原子写（tmp + rename）。此前裸 writeFileSync——恢复被中断（崩溃/断电/文件锁）
    // 会留下半截 JSON；而该半截文件正是 jsonStore.read() 损坏分支的输入，会串成
    // 「备份恢复中断 → 该集合被下一次 RMW 静默清空」。D1 给损坏文件加了侧车保全，
    // 但源头（非原子写）必须一并堵住，否则每次中断都要靠人工从侧车恢复。
    atomicWriteFileSync(target, JSON.stringify(content, null, 2));
    restored.push(name);
  }
  // preRestoreDir 保持 = db 根（C22/C54 既有契约，不动）；v2 另给 preRestoreDirs 全量视图
  return { restored, preRestoreDir: preDirs[ROOT_DB] || null, preRestoreDirs: preDirs };
}

module.exports = {
  collectSnapshot,
  restoreSnapshot,
  BACKUP_FORMAT,
  BACKUP_VERSION,
  ACCEPTED_VERSIONS,
  AI_STORE_NAMES,
  rootOf,
};
