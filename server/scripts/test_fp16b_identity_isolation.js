'use strict';

// Phase 16-B §10 — Identity Isolation：真实 Chromium 双 profile launch/restart/reopen 全序列。
// 断言：
//   I1 identityId A != identityId B（首建即异）
//   I2 seed A != seed B
//   SEQ A launch → B launch → A restart → B restart → A reopen → B reopen
//       每步读回：A 恒为 A、B 恒为 B（identityId/seed 字节级不漂移、不串读）
//   ISO 字节级不串读：A 的 identity.json 不含 B 的 identityId，反之亦然
// 纪律：只单文件删 identity.json（宿主 safe-delete 守卫 threshold=50/turn）；
//       Chromium profile 资产保留不清理（persistent 复用语义，不在断言依赖内）。

const fs = require('fs');
const os = require('os');
const path = require('path');

// C46 隔离：FPB_DATA_DIR → 每次运行独立 tmp 数据根（双 profile userDataDir + identity.json 全隔离），
// 消除与 launch 套件 / 其他回归实例争用固定 data/profiles/p16b_iso_a|b 的 Chrome 锁。
process.env.FPB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-p16b-iso-'));

const browserManager = require('../browserManager');
const identityStore = require('../fp/identityStore');

const A = { id: 'p16b_iso_a', os: 'Windows', browser: 'Chrome', seed: 'iso-seed-a' };
const B = { id: 'p16b_iso_b', os: 'Windows', browser: 'Chrome', seed: 'iso-seed-b' };

let pass = 0; let fail = 0; const failures = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + (detail !== undefined ? ' :: ' + String(detail).slice(0, 300) : '')); console.log('  FAIL ' + name); }
}

async function readId(p) { return identityStore.readIdentity(p.id); }

(async () => {
  // C46：独立 tmp 数据根每次运行全新，identity.json 必不存在（首建路径天然可测）；
  // 不再 rmSync（旧实现单文件删除也计入宿主 turn 级删除配额，c25 批次实证 FATAL 风险）。
  for (const p of [A, B]) {
    const f = identityStore.identityFilePath(p.id);
    if (!f.startsWith(process.env.FPB_DATA_DIR)) throw new Error('identity 路径未随 FPB_DATA_DIR 隔离: ' + f);
    if (fs.existsSync(f)) fs.renameSync(f, path.join(os.tmpdir(), 'p16b-iso-retired-' + Date.now() + '-' + p.id + '.json'));
  }

  console.log('== SEQ1: A launch ==');
  await browserManager.launch(A, null);
  const idA1 = await readId(A);
  assert('I1a A 首建 identityId 非空 idn-', typeof idA1.identityId === 'string' && idA1.identityId.startsWith('idn-'));
  await browserManager.close(A.id);

  console.log('== SEQ2: B launch ==');
  await browserManager.launch(B, null);
  const idB1 = await readId(B);
  assert('I1 identityId A != B', idA1.identityId !== idB1.identityId, { A: idA1.identityId, B: idB1.identityId });
  assert('I2 seed A != B', idA1.seed !== idB1.seed);
  await browserManager.close(B.id);

  console.log('== SEQ3: A restart ==');
  await browserManager.launch(A, null);
  const idA2 = await readId(A);
  assert('S3-A restart 后 identityId 稳定', idA2.identityId === idA1.identityId);
  assert('ISO-A restart 后 identity.json 不含 B 的 identityId',
    !fs.readFileSync(identityStore.identityFilePath(A.id), 'utf8').includes(idB1.identityId));
  await browserManager.close(A.id);

  console.log('== SEQ4: B restart ==');
  await browserManager.launch(B, null);
  const idB2 = await readId(B);
  assert('S3-B restart 后 identityId 稳定', idB2.identityId === idB1.identityId);
  assert('ISO-B restart 后 identity.json 不含 A 的 identityId',
    !fs.readFileSync(identityStore.identityFilePath(B.id), 'utf8').includes(idA1.identityId));
  await browserManager.close(B.id);

  console.log('== SEQ5: A reopen ==');
  await browserManager.launch(A, null);
  const idA3 = await readId(A);
  assert('S3-A reopen 后 identityId 稳定', idA3.identityId === idA1.identityId);
  await browserManager.close(A.id);

  console.log('== SEQ6: B reopen ==');
  await browserManager.launch(B, null);
  const idB3 = await readId(B);
  assert('S3-B reopen 后 identityId 稳定', idB3.identityId === idB1.identityId);
  await browserManager.close(B.id);

  assert('FINAL A remains A（三轮恒等）', idA1.identityId === idA2.identityId && idA2.identityId === idA3.identityId);
  assert('FINAL B remains B（三轮恒等）', idB1.identityId === idB2.identityId && idB2.identityId === idB3.identityId);

  console.log('');
  console.log('RESULT pass=' + pass + ' fail=' + fail);
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
