'use strict';

// C59：数据根统一（data root unification）。
//
// ★ C116 更正：本文件此前把 stepManager 误列为「db 根（<repo>/data）」模块 —— 实测
// stepManager 与 storage 层一样用 **AI 根（<repo>/server/data）**，注释与代码不符，
// 曾误导排查方向。**设计上数据根确有两个**（.gitignore:22-23 明文）：
//   db 根 <repo>/data         —— db.js(profiles/proxies/tasks) + identity/audit/fpTemplates
//                                + vault/settings + backup
//   AI 根 <repo>/server/data  —— agent 层 JsonStore 的 FILES 集合 + archive/ + evidence/
// 两者都由 FPB_DATA_DIR 优先覆盖（隔离测试下同时落 tmp）。
//
// 历史：identity.js / audit.js / fpTemplates.js 默认数据根曾是 AI 根 server/data，
// 与 db 根分裂，后果（C59 实证）：
//   A 类——backup.js 只跟随 db 根 → identity 全套数据（users/workspaces/
//         memberships/sessions/apikeys/audit）零备份覆盖；
//   B 类——FPB_DATA_DIR 隔离测试下目录对齐靠各模块自行实现。
// C59 修复：三模块默认根切到 db 根 + 一次性 legacy 迁移
//（canonical 缺失且 legacy 存在时复制，绝不覆盖 canonical）；FPB_DATA_DIR 隔离
// 模式下不做迁移（防止把真实 identity 数据复制进测试 tmp 目录）。
//
// ★ C116：同样的 A 类缺陷以**镜像形式**仍在 —— AI 集合（ai*）本来就住 AI 根，
// 而 backup.js 只扫 db 根 ⇒ AI store 全量零备份（详见 aiStoreRoot() 上方注释）。

const fs = require('fs');
const path = require('path');

// 历史默认根（server/data）——仅迁移用
function legacyDataRoot() {
  return path.join(__dirname, 'data');
}

// canonical 数据根：FPB_DATA_DIR（测试/部署隔离）优先，否则 <repo>/data
function dataRoot() {
  return process.env.FPB_DATA_DIR
    ? path.resolve(process.env.FPB_DATA_DIR)
    : path.join(__dirname, '..', 'data');
}

// AI store 根（agent 层 JsonStore 的 FILES 集合根）。
//
// C116：设计上数据根是「两个」而不是一个，依据 .gitignore:22-23 明文：
//   # db.js   -> /data/          (profiles.json / proxies.json / tasks.json)
//   # AI store-> /server/data/   (aiCredentials / aiPaymentMethods / aiExecutions ...)
// 此前 AI 根没有具名事实源，4 处各自复制解析逻辑（storage/index.js:resolveDataDir /
// agent/stepManager.js / scripts/archiveAiStore.js / storage/migrationJsonToSqlite.js），
// 于是 backup.js 只跟随 dataRoot()（db 根）→ **AI store 全量数据零备份覆盖**（C116 D1，
// 实测 8.4MB 真实集合 vs db 根里 484 字节空桩）。故把 AI 根提升为与 dataRoot() 并列的
// 具名事实源，谁要解析 AI 根就必须走这里。
//
// FPB_DATA_DIR 优先于两者 ⇒ 隔离测试下两个根同时落到 tmp（隔离语义对两根都成立）。
function aiStoreRoot() {
  return process.env.FPB_DATA_DIR
    ? path.resolve(process.env.FPB_DATA_DIR)
    : path.join(__dirname, 'data');
}

// 一次性 legacy 迁移。返回值：
//   'migrated'          —— legacy 存在且 canonical 缺失，已复制
//   'canonical-exists'  —— canonical 已存在（绝不覆盖，legacy 成为孤儿备份）
//   'no-legacy'         —— legacy 不存在（全新部署）
//   'skipped-isolated'  —— FPB_DATA_DIR 隔离模式（不碰真实 legacy 数据）
//   'migration-error:…' —— IO 异常（不阻断模块加载，下一次启动重试）
function migrateLegacyFile(name, opts) {
  const o = opts || {};
  if (process.env.FPB_DATA_DIR && !o.force) return 'skipped-isolated';
  const canonicalDir = o.canonicalDir || dataRoot();
  const legacyDir = o.legacyDir || legacyDataRoot();
  const canonical = path.join(canonicalDir, name);
  const legacy = path.join(legacyDir, name);
  try {
    if (fs.existsSync(canonical)) return 'canonical-exists';
    if (!fs.existsSync(legacy)) return 'no-legacy';
    fs.mkdirSync(canonicalDir, { recursive: true });
    fs.copyFileSync(legacy, canonical);
    return 'migrated';
  } catch (e) {
    return 'migration-error: ' + String((e && e.message) || e).slice(0, 120);
  }
}

module.exports = { dataRoot, legacyDataRoot, aiStoreRoot, migrateLegacyFile };
