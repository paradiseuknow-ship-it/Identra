'use strict';

// C189：孤儿环境目录的「清点 / 清理」策略层（依赖注入，IO 由调用方提供）。
//
// 背景（真实数据）：data/profiles 下曾有 1181 个目录不在库内、约 16 GB / 25 万文件。
// 成因：历史上单条删除与批量删除都只删库记录、不删本地数据目录；测试夹具与异常退出
// （Chrome 崩溃、进程被杀）也会留下目录。库记录一旦消失，这些目录就再无 UI 入口，
// 只能靠手工清盘 —— 于是必须给产品一个可复用的出口。
//
// 安全边界（每条都由本层强制，路由只做转发）：
//   ① 能力闸：profile:manage（与删除同口径）；
//   ② 确认令牌：body.confirm 必须严格等于 PURGE_ORPHANS，否则 400 且**零副作用**；
//   ③ 判定口径唯一：孤儿 =「profilesRoot 下的直接子目录」−「库内 profile id 全量集合」，
//      不看运行态、不看 workspace —— 库内存在即永不删除（宁可漏删，不可误删）；
//   ④ 逐个删除前**实时复核** db.getProfile(id)，防止扫描后用户新建了同 id 环境；
//   ⑤ 只处理直接子目录，路径一律交给调用方的 deleteProfileData（内部再次过
//      assertSafeName + resolveWithin），本层不拼接任何路径；
//   ⑥ 单个目录失败不中断整批，逐条记 failed（占用中的目录下次还能清）。

const CONFIRM_TOKEN = 'PURGE_ORPHANS';
const PERMISSION = 'profile:manage';

function fail(status, body) {
  return { status, body };
}

// deps: { db, assertCan, listProfileDirs, deleteProfileData }
// listProfileDirs() -> string[]（profilesRoot 的直接子目录名，IO 在调用方）
function scanOrphans({ identityUser, db, assertCan, listProfileDirs }) {
  try {
    assertCan(identityUser && identityUser.id, identityUser && identityUser.currentWorkspaceId, PERMISSION);
  } catch (e) {
    return fail(e.status || 403, { ok: false, error: e.status === 401 ? 'UNAUTHORIZED' : String(e.message || e) });
  }
  const inDb = new Set((db.getProfiles() || []).map((p) => String(p.id)));
  const dirs = (listProfileDirs() || []).map(String);
  const orphans = dirs.filter((d) => !inDb.has(d));
  return {
    status: 200,
    body: {
      ok: true,
      orphanCount: orphans.length,
      totalDirs: dirs.length,
      inDbCount: inDb.size,
      ids: orphans.slice(0, 200),
      truncated: orphans.length > 200,
    },
  };
}

function runPurgeOrphans({ identityUser, body, db, assertCan, listProfileDirs, deleteProfileData }) {
  const b = body || {};

  // ① 能力闸（先鉴权后确认：未授权者不该从错误码探出令牌形状）
  try {
    assertCan(identityUser && identityUser.id, identityUser && identityUser.currentWorkspaceId, PERMISSION);
  } catch (e) {
    return fail(e.status || 403, { ok: false, error: e.status === 401 ? 'UNAUTHORIZED' : String(e.message || e) });
  }

  // ② 确认令牌：缺失/不符 ⇒ 400，此刻尚未触碰任何目录
  if (b.confirm !== CONFIRM_TOKEN) {
    return fail(400, { ok: false, error: 'CONFIRM_REQUIRED', expected: CONFIRM_TOKEN });
  }

  const inDb = new Set((db.getProfiles() || []).map((p) => String(p.id)));
  const dirs = (listProfileDirs() || []).map(String);
  const orphans = dirs.filter((d) => !inDb.has(d));

  if (typeof deleteProfileData !== 'function') {
    return fail(500, { ok: false, error: 'REMOVE_IMPL_MISSING' });
  }

  let removed = 0;
  const failed = [];
  const skippedInDb = [];
  for (const id of orphans) {
    // ④ 删除前实时复核（扫描是快照，库可能刚变）
    try {
      if (db.getProfile(id)) { skippedInDb.push(id); continue; }
    } catch (e) {
      skippedInDb.push(id);
      continue;
    }
    try {
      const r = deleteProfileData(id);
      if (r && r.removed) removed++;
    } catch (e) {
      failed.push({ id, error: String(e.message || e).slice(0, 120) });
    }
  }

  return {
    status: 200,
    body: { ok: true, orphanCount: orphans.length, removed, failed, skippedInDb, remainingDirs: Math.max(0, dirs.length - removed) },
    audit: {
      action: 'profile.purge_orphans',
      resourceType: 'profile',
      resourceId: null,
      detail: { orphanCount: orphans.length, removed, failed: failed.length },
    },
  };
}

module.exports = { scanOrphans, runPurgeOrphans, CONFIRM_TOKEN, PERMISSION };
