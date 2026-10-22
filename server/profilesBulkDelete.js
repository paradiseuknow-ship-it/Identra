'use strict';

// C185：「全部环境 → 全部删除」的服务端策略层（依赖注入，纯逻辑，无 IO）。
//
// 为什么单独抽一层：批量删除是**不可逆面**，真正要守住的不是「路由里出现过某行代码」，
// 而是四件事的**顺序与闸门**：
//   ① 能力闸 —— profile:manage（与单条删除同口径）；
//   ② 确认令牌 —— body.confirm 必须严格等于 DELETE_ALL，否则 400 且**零副作用**
//      （防误发 / 脚本 / 手滑 curl 整表清空）；
//   ③ 授权 fail-closed —— 目标集合必须**全部**可见且可管理，任一不满足即 403 且**零副作用**
//      （与 CAP-C1 批量导出「授权不 fail-open」同口径，绝不做部分删除）；
//   ④ 顺序 —— 先 close 运行实例，再清凭据，最后删库；每一步各自**一次落盘**
//      （循环调用单条实现是 O(n²)，n 个环境＝n 次全量重写）。
//   ⑤ 可选清盘（C189）—— body.deleteFiles === true 时，把每个环境的本地数据目录一并删除；
//      默认 false＝沿用旧行为（只删库记录留目录），因为清盘会连带删掉 Cookie/登录态，不可逆。
//      清盘失败**不阻断删库**（与 vault 同口径：否则被占用的目录会永久锁死删除能力），
//      但必须逐条记进 failed，绝不静默成功。
// 这些只有靠「可被测试真实执行」才守得住，所以策略在此、路由只做转发。

const CONFIRM_TOKEN = 'DELETE_ALL';
const PERMISSION = 'profile:manage';

function fail(status, body) {
  return { status, body };
}

// deps: { db, vault, browserManager, assertCan, filterByWorkspace, removeProfileData, now }
// 返回 { status, body, audit } —— route 只负责 res.status(...).json(body) 与 audit 落点。
function runBulkDelete({ identityUser, body, db, vault, browserManager, assertCan, filterByWorkspace, removeProfileData }) {
  const b = body || {};

  // ① 能力闸（先鉴权后确认：未授权者不该从错误码里探出「令牌长什么样」）
  try {
    assertCan(identityUser && identityUser.id, identityUser && identityUser.currentWorkspaceId, PERMISSION);
  } catch (e) {
    return fail(e.status || 403, {
      ok: false,
      error: e.status === 401 ? 'UNAUTHORIZED' : String(e.message || e),
    });
  }

  // ② 确认令牌：缺失/不符 ⇒ 400，且此刻尚未触碰 db/vault/browser
  if (b.confirm !== CONFIRM_TOKEN) {
    return fail(400, { ok: false, error: 'CONFIRM_REQUIRED', expected: CONFIRM_TOKEN });
  }

  // ③ 目标集合 + 授权 fail-closed（先整体校验，再动手）
  const visible = filterByWorkspace(db.getProfiles(), identityUser) || [];
  const byId = new Map(visible.map((p) => [p.id, p]));
  const explicit = Array.isArray(b.ids) && b.ids.length ? b.ids.map(String) : null;
  const requested = explicit || visible.map((p) => p.id);
  const denied = requested.filter((id) => !byId.has(id));
  if (denied.length) {
    return fail(403, {
      ok: false, error: 'FORBIDDEN_OR_NOT_FOUND', ids: denied.slice(0, 20), deniedCount: denied.length,
    });
  }
  if (!requested.length) {
    return { status: 200, body: { ok: true, deleted: 0, closed: 0, secrets: 0, filesRemoved: 0, remaining: 0, failed: [] }, audit: null };
  }

  // ④ 顺序执行：close → vault → db
  let closed = 0;
  const failed = [];
  for (const id of requested) {
    try {
      if (browserManager.isRunning(id)) { browserManager.close(id); closed++; }
    } catch (e) {
      failed.push({ id, stage: 'close', error: String(e.message || e).slice(0, 120) });
    }
  }

  let secrets = 0;
  try {
    secrets = vault.deleteManyProfileSecrets(requested) || 0;
  } catch (e) {
    // 与单条删除一致：凭据清理失败只记告警，不阻断删除（否则脏 vault 会永久锁死删除能力）
    failed.push({ id: null, stage: 'vault', error: String(e.message || e).slice(0, 120) });
  }

  // ⑤ 可选清盘（C189）：必须在 db 删除**之前** —— 一旦记录没了，UI 上再也定位不到这个目录，
  // 清盘失败就永久退化成孤儿目录（正是 1181 个 / 16 GB 的成因）。删库前失败 ⇒ 记录仍在，
  // 用户可在界面上重试，不会出现「库里没有、盘上有」的幽灵。
  const deleteFiles = b.deleteFiles === true;
  let filesRemoved = 0;
  if (deleteFiles) {
    if (typeof removeProfileData !== 'function') {
      failed.push({ id: null, stage: 'files', error: 'REMOVE_IMPL_MISSING' });
    } else {
      for (const id of requested) {
        try {
          const r = removeProfileData(id);
          if (r && r.removed) filesRemoved++;
        } catch (e) {
          failed.push({ id, stage: 'files', error: String(e.message || e).slice(0, 120) });
        }
      }
    }
  }

  const r = db.deleteProfiles(requested);

  return {
    status: 200,
    body: { ok: true, deleted: r.removed, closed, secrets, filesRemoved, remaining: r.remaining, failed },
    audit: {
      action: 'profile.bulk_delete',
      resourceType: 'profile',
      resourceId: null,
      detail: { count: r.removed, closed, secrets, filesRemoved, deleteFiles, scope: explicit ? 'ids' : 'all' },
    },
  };
}

module.exports = { runBulkDelete, CONFIRM_TOKEN, PERMISSION };
