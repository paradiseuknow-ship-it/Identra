'use strict';

// C59：数据根统一（data root unification）。
//
// 历史：identity.js / audit.js / fpTemplates.js 默认数据根是 server/data，
// 而其余 10+ 模块（db/browserManager/vault/settings/backup/systemStorage/stepManager…）
// 默认是 <repo>/data。分裂后果（C59 实证）：
//   A 类——backup.js 只跟随 canonical 根 → identity 全套数据（users/workspaces/
//         memberships/sessions/apikeys/audit）零备份覆盖；
//   B 类——FPB_DATA_DIR 隔离测试下目录对齐靠各模块自行实现，integrity.js 甚至
//         完全不跟随（storage 层检查错目录）。
// 修复：三模块默认根切到 canonical（<repo>/data）+ 一次性 legacy 迁移
//（canonical 缺失且 legacy 存在时复制，绝不覆盖 canonical）；FPB_DATA_DIR 隔离
// 模式下不做迁移（防止把真实 identity 数据复制进测试 tmp 目录）。

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

module.exports = { dataRoot, legacyDataRoot, migrateLegacyFile };
