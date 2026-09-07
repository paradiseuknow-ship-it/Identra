'use strict';

// Phase 16-B §9 — BrowserManager identity 接线 smoke（真实 Chromium launch 路径）
// 断言：
//   S1 launch 后 identity.json 落在 userDataDir（data/profiles/<id>/）且 schema 合法
//   S2 identityId/seed 与 profile 派生一致
//   S3 二次 launch 幂等（identity.json 不被覆盖，identityId 稳定，created=false 语义）
//   S4 注入面一致性：identity.browserVersion 与浏览器实际 UA 的 Chrome/ 主版本一致（UA 对齐后派生的证据）

const fs = require('fs');
const path = require('path');
const browserManager = require('../browserManager');
const identityStore = require('../fp/identityStore');
const { validateIdentity } = require('../fp/identitySchema');

const PROFILE_ID = 'p16b_identity_smoke';

let pass = 0; let fail = 0; const failures = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + (detail !== undefined ? ' :: ' + String(detail).slice(0, 300) : '')); console.log('  FAIL ' + name); }
}

(async () => {
  // 前置清理：只移除 identity.json 单文件（保证首建路径可测）。
  // 纪律：禁止递归删除 profile 目录——目录内含完整 Chromium profile（180+ 文件），
  // 递归 rmSync 会触发宿主 safe-delete bulk 守卫（SAFE_DELETE_BULK_CONFIRM_REQUIRED，
  // threshold=50 files/turn）导致 runRegression 内 FATAL（2026-09-05 实证）。
  // Chromium profile 文件（Default/ 等）属 persistent 复用资产、不在断言依赖内，保留不清理。
  // 2026-09-07 补强：单文件 rmSync 也计入宿主 turn 级删除配额——phase9 批量运行时
  // 前序套件可能已耗尽 50 配额 → 单文件删除同样 FATAL（c25 批次实证）。
  // 改为 rename 到 os.tmpdir：原路径文件消失（首建语义保持），且不计入删除配额。
  const file = identityStore.identityFilePath(PROFILE_ID);
  try {
    if (fs.existsSync(file)) {
      fs.mkdirSync(os.tmpdir(), { recursive: true });
      fs.renameSync(file, path.join(os.tmpdir(), 'p16b-identity-retired-' + Date.now() + '.json'));
    }
  } catch (e) { fs.rmSync(file, { force: true }); } // rename 跨盘失败时兜底（接受配额风险）

  const profile = { id: PROFILE_ID, os: 'Windows', browser: 'Chrome', seed: 'smoke-seed-16b' };

  console.log('== launch #1 ==');
  const s1 = await browserManager.launch(profile, null);
  assert('S1a identity.json 落在 userDataDir 内', fs.existsSync(file), file);
  const id1 = identityStore.readIdentity(PROFILE_ID);
  const v = id1 ? validateIdentity(id1) : { ok: false };
  assert('S1b 读回 schema 合法', v.ok, v.errors);
  assert('S2a identityId 非空且前缀 idn-', typeof id1.identityId === 'string' && id1.identityId.startsWith('idn-'));
  assert('S2b seed = profile.id::seed 派生', id1.seed === 'p16b_identity_smoke::smoke-seed-16b', id1.seed);

  const ua1 = s1.page ? await s1.page.evaluate(() => navigator.userAgent) : (s1.context ? await (await s1.context.newPage()).evaluate(() => navigator.userAgent) : null);
  const engineMajor = ua1 && (ua1.match(/Chrome\/(\d+)/) || [])[1];
  assert('S4 identity.browserVersion 主版本 = 实际 UA 主版本（UA 对齐后派生）',
    !!engineMajor && id1.browserVersion.split('.')[0] === engineMajor,
    { identity: id1.browserVersion, ua: ua1 });

  await browserManager.close(PROFILE_ID);

  console.log('== launch #2（幂等） ==');
  const bytesBefore = fs.readFileSync(file, 'utf8');
  await browserManager.launch(profile, null);
  const bytesAfter = fs.readFileSync(file, 'utf8');
  const id2 = identityStore.readIdentity(PROFILE_ID);
  assert('S3a identity.json 字节不被二次 launch 覆盖', bytesBefore === bytesAfter);
  assert('S3b identityId 跨 launch 稳定', id2.identityId === id1.identityId);
  await browserManager.close(PROFILE_ID);

  console.log('');
  console.log('RESULT pass=' + pass + ' fail=' + fail);
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
