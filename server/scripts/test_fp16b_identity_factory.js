'use strict';

// Phase 16-B1 — identityFactory 测试
// 断言纪律：schema/store 行为走真实模块；确定性断言用 canonicalIdentityString 字节比较。

const { generateFingerprint } = require('../fp/generate');
const D = require('../fp/data');
const F = require('../fp/identityFactory');
const { canonicalIdentityString, validateIdentity } = require('../fp/identitySchema');

let pass = 0; let fail = 0;
const failures = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); } else { fail++; failures.push(name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); console.log('  FAIL ' + name); }
}
function expectThrow(fn, code) {
  try { fn(); return false; } catch (e) { return !code || (e.code === code); }
}

console.log('== FT1 确定性：同 seed 同 fp → 字节恒等 ==');
const fpA1 = generateFingerprint('factory::seedA', { os: 'Windows', browser: 'Chrome' }, null);
const fpA2 = generateFingerprint('factory::seedA', { os: 'Windows', browser: 'Chrome' }, null);
const idA1 = F.buildIdentity('factory::seedA', fpA1);
const idA2 = F.buildIdentity('factory::seedA', fpA2);
assert('FT1a 两次生成 → canonicalIdentityString 字节相同', canonicalIdentityString(idA1) === canonicalIdentityString(idA2));
assert('FT1b identityId 相同', idA1.identityId === idA2.identityId);

console.log('== FT2 模板池 7 组合全覆盖 → schema 合规 ==');
const combos = [...new Set(D.USER_AGENTS.map((u) => u.os + '|' + u.browser))];
assert('FT2a 模板池组合数 = 7', combos.length === 7, combos.length);
for (const c of combos) {
  const [os, browser] = c.split('|');
  const fp = generateFingerprint('factory::combo::' + c, { os, browser }, null);
  const id = F.buildIdentity('factory::combo::' + c, fp);
  const v = validateIdentity(id);
  assert('FT2 ' + c + ' → schema ok', v.ok, v.errors);
}

console.log('== FT3 派生一致性 ==');
{
  const fp = generateFingerprint('factory::derive', { os: 'Windows', browser: 'Chrome' }, null);
  const id = F.buildIdentity('factory::derive', fp);
  const uaMajor = fp.userAgent.match(/Chrome\/(\d+)/)[1];
  assert('FT3a browserVersion 从 UA 派生（主版本一致）', id.browserVersion.startsWith(uaMajor + '.') || id.browserVersion === uaMajor, { ua: fp.userAgent.slice(0, 60), bv: id.browserVersion });
  assert('FT3b osVersion 来自派生表且为 10.0.0（Windows）', id.osVersion === F.OS_VERSION_TABLE.Windows && id.osVersion === '10.0.0', id.osVersion);
  assert('FT3c locale/languages/timezone 与 fp 恒等', id.locale === fp.language && JSON.stringify(id.languages) === JSON.stringify(fp.languages) && id.timezone === fp.timezone);
  assert('FT3d fontProfile = fp.fonts 拷贝', JSON.stringify(id.fontProfile.families) === JSON.stringify(fp.fonts));
  assert('FT3e gpuProfile 携带 webgl vendor/renderer', id.gpuProfile.webglVendor === fp.webgl.vendor && id.gpuProfile.webglRenderer === fp.webgl.renderer);
  assert('FT3f identityId 跨 seed 不同', id.identityId !== idA1.identityId);
}

console.log('== FT4 fail-fast（V 家族）==');
{
  const fp = generateFingerprint('factory::ff', { os: 'Windows', browser: 'Chrome' }, null);
  assert('FT4a 空种子 → IDENTITY_MALFORMED', expectThrow(() => F.buildIdentity('', fp), 'IDENTITY_MALFORMED'));
  assert('FT4b fp=null → IDENTITY_MALFORMED', expectThrow(() => F.buildIdentity('x', null), 'IDENTITY_MALFORMED'));
  assert('FT4c fp.os 非法 → IDENTITY_UNKNOWN_OS（不猜 osVersion）', expectThrow(() => F.buildIdentity('x', Object.assign({}, fp, { os: 'Solaris' })), 'IDENTITY_UNKNOWN_OS'));
  assert('FT4d UA 无版本 → IDENTITY_INVALID_VERSION', expectThrow(() => F.buildIdentity('x', Object.assign({}, fp, { userAgent: 'NotABrowserUA' })), 'IDENTITY_INVALID_VERSION'));
  assert('FT4e UA 为空 → IDENTITY_INVALID_VERSION', expectThrow(() => F.buildIdentity('x', Object.assign({}, fp, { userAgent: '' })), 'IDENTITY_INVALID_VERSION'));
}

console.log('== FT5 纯函数：fp 不被突变 ==');
{
  const fp = generateFingerprint('factory::pure', { os: 'Windows', browser: 'Chrome' }, null);
  const before = JSON.stringify(fp);
  F.buildIdentity('factory::pure', fp);
  assert('FT5 buildIdentity 后 fp 逐字节不变', JSON.stringify(fp) === before);
}

console.log('== FT6 identity 内嵌对象与 fp 解引用（拷贝隔离）==');
{
  const fp = generateFingerprint('factory::clone', { os: 'Windows', browser: 'Chrome' }, null);
  const id = F.buildIdentity('factory::clone', fp);
  id.fontProfile.families.push('__MUTATED__');
  id.networkProfile.geolocation.lat = 999;
  assert('FT6a fonts 拷贝隔离', !fp.fonts.includes('__MUTATED__'));
  assert('FT6b geolocation 拷贝隔离', fp.geolocation.lat !== 999);
}

console.log('== FT7 store 链路集成：factory → identityStore 落盘读回一致 ==');
{
  const os = require('os'); const path = require('path'); const fs = require('fs');
  const identityStore = require('../fp/identityStore');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fp16b-factory-'));
  const fp = generateFingerprint('factory::store', { os: 'Windows', browser: 'Chrome' }, null);
  const id = F.buildIdentity('factory::store', fp);
  const canonical = identityStore.writeIdentity('p_factory_chain', id, { root: tmpRoot });
  const p = identityStore.identityFilePath('p_factory_chain', tmpRoot);
  const back = identityStore.readIdentity('p_factory_chain', { root: tmpRoot });
  assert('FT7a 落盘路径在 profile 目录内', p.includes('p_factory_chain') && p.endsWith('identity.json'), p);
  assert('FT7b 落盘→读回 canonical 字节恒等（写即确定性序列化）', canonical === canonicalIdentityString(id) && canonicalIdentityString(back) === canonicalIdentityString(id));
  assert('FT7c 读回对象仍 schema 合规', validateIdentity(back).ok);
}

console.log('');
console.log('RESULT pass=' + pass + ' fail=' + fail);
if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
