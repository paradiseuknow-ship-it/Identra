'use strict';

// C62 守护测试：identity.js 存储 facade 硬化（A 类静默清空面）+ 过期会话清扫
// + API key lastUsedAt 丢失更新。纯 tmp 隔离（FPB_DATA_DIR）/ 零浏览器 / 零网络 /
// 零 AI（mock 无关）。通过 monkey-patch fs 注入瞬时锁 / 持久锁 / 并发写，
// 确定性复现三类故障（同进程 require → fs 模块对象共享，patch 生效）。

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0; const failures = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else {
    let d = '';
    if (detail !== undefined) { try { d = JSON.stringify(detail); } catch (e) { d = String(detail); } }
    fail++; failures.push(name + (d ? ' :: ' + d.slice(0, 300) : '')); console.log('  FAIL ' + name + (d ? ' :: ' + d.slice(0, 300) : ''));
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'c62-'));
process.env.FPB_DATA_DIR = TMP; // 必须在 require identity 之前（DATA_DIR 加载期求值）
const identity = require(path.resolve(__dirname, '..', 'identity.js'));

const P = (f) => path.join(TMP, f);
const USERS = P('identity_users.json');
const SESSIONS = P('identity_sessions.json');
const APIKEYS = P('identity_apikeys.json');
const readJsonFile = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

// ---- 布景：用户 + 工作区 + API key（顺带验证基础行为链未被破坏） ----
const userA = identity.createUser({ username: 'alice', password: 'password123' });
const ws = identity.createWorkspace(userA, 'ws-a');
const { plaintext: k1Plaintext } = identity.createApiKey(userA, { workspaceId: ws.id, name: 'k1' });
assert('P0a 布景：用户/工作区/key 创建成功', !!userA.id && !!ws.id && k1Plaintext.startsWith('fpbak_'));

// fs.readFileSync patch 工具：只对目标路径生效，其余直接透传
function patchRead(targetPath, behavior) {
  const orig = fs.readFileSync;
  fs.readFileSync = function (f, ...rest) {
    if (String(f) === String(targetPath)) return behavior(f, orig, rest);
    return orig.call(fs, f, ...rest);
  };
  return () => { fs.readFileSync = orig; };
}

// ---- P1 瞬时锁重试：4 次 EBUSY 后放行 → 读取成功，磁盘零变化 ----
(function P1() {
  console.log('[P1] 瞬时锁（EBUSY×4）重试后成功，不清空不覆写');
  const before = fs.readFileSync(USERS, 'utf8');
  let calls = 0;
  const restore = patchRead(USERS, (f, orig, rest) => {
    calls++;
    if (calls <= 4) { const e = new Error('locked'); e.code = 'EBUSY'; throw e; }
    return orig.call(fs, f, ...rest);
  });
  let found = null, threw = null;
  try { found = identity.findUserByName('alice'); } catch (e) { threw = e; }
  restore();
  assert('P1a 瞬时锁耗尽前恢复 → 读取成功', !!found && found.id === userA.id, { threw: threw && threw.message, calls });
  assert('P1b 磁盘内容未被覆写', fs.readFileSync(USERS, 'utf8') === before);
})();

// ---- P2 持久锁 fail-loud：绝不吞成 fallback 覆写集合（A 类静默清空杀手） ----
(function P2() {
  console.log('[P2] 持久锁（EPERM×∞）→ fail-loud 抛出，用户集合零覆写');
  const before = fs.readFileSync(USERS, 'utf8');
  const restore = patchRead(USERS, () => { const e = new Error('perm locked'); e.code = 'EPERM'; throw e; });
  let threw = null;
  try { identity.createUser({ username: 'mallory', password: 'password456' }); }
  catch (e) { threw = e; }
  restore();
  assert('P2a 持久 fs 故障 → 抛出（不再静默 fallback）', !!threw, threw && threw.message);
  const after = fs.readFileSync(USERS, 'utf8');
  assert('P2b 用户集合未被覆写（旧代码此处会清空 alice）', after === before,
    { afterUsers: readJsonFile(USERS).map((u) => u.username) });
})();

// ---- P3 真 JSON 损坏 → fallback 契约保持（fail-closed，不抛） ----
(function P3() {
  console.log('[P3] 损坏 JSON → fallback []，身份解析 fail-closed');
  fs.writeFileSync(SESSIONS, 'not-json{{{', 'utf8');
  let r = null, threw = null;
  try { r = identity.userBySessionToken('any-token'); } catch (e) { threw = e; }
  assert('P3a 损坏会话文件 → 返回 null 不抛', r === null && !threw, { threw: threw && threw.message });
  fs.writeFileSync(SESSIONS, '[]', 'utf8');
})();

// ---- P4 写路径原子性：无 .tmp 残留 + 写失败不破坏旧文件 ----
(function P4() {
  console.log('[P4] 原子写：正常路径零 tmp 残留；tmp 写失败 → 旧文件完整');
  const leftovers = fs.readdirSync(TMP).filter((f) => f.endsWith('.tmp'));
  assert('P4a 正常写路径无 .tmp 残留', leftovers.length === 0, leftovers);

  const before = fs.readFileSync(USERS, 'utf8');
  const origWrite = fs.writeFileSync;
  fs.writeFileSync = function (f, ...rest) {
    if (String(f) === USERS + '.tmp') { const e = new Error('disk full'); e.code = 'EIO'; throw e; }
    return origWrite.call(fs, f, ...rest);
  };
  let threw = null;
  try { identity.createUser({ username: 'bob', password: 'password789' }); } catch (e) { threw = e; }
  fs.writeFileSync = origWrite;
  assert('P4b tmp 写失败 → 抛出', !!threw, threw && threw.message);
  assert('P4c 失败路径旧文件完整（未半写）', fs.readFileSync(USERS, 'utf8') === before);
})();

// ---- P5 过期会话清扫：登录创建会话时 expired 条目被清除（无界增长修复） ----
(function P5() {
  console.log('[P5] createSession 清扫过期会话');
  const now = Date.now();
  const seed = [
    { tokenHash: 'dead1', userId: userA.id, workspaceId: ws.id, createdAt: now - 9e8, expiresAt: now - 1000 },
    { tokenHash: 'dead2', userId: userA.id, workspaceId: ws.id, createdAt: now - 9e8, expiresAt: now - 2000 },
    { tokenHash: 'dead3', userId: userA.id, workspaceId: ws.id, createdAt: now - 9e8, expiresAt: now - 3000 },
    { tokenHash: 'live0', userId: userA.id, workspaceId: ws.id, createdAt: now, expiresAt: now + 6e8 },
  ];
  fs.writeFileSync(SESSIONS, JSON.stringify(seed, null, 2), 'utf8');
  const token = identity.createSession(userA.id, ws.id);
  const after = readJsonFile(SESSIONS);
  const hashes = after.map((s) => s.tokenHash);
  assert('P5a 过期条目被清扫（3 个 dead 消失）', !hashes.includes('dead1') && !hashes.includes('dead2') && !hashes.includes('dead3'), hashes);
  assert('P5b 有效条目保留 + 新会话存在', hashes.includes('live0') && after.length === 2, { len: after.length });
  const u = identity.userBySessionToken(token);
  assert('P5c 新会话立即可解析', !!u && u.id === userA.id);
})();

// ---- P6 API key lastUsedAt 丢失更新修复：认证热路径并发新建的 key 不被回滚 ----
(function P6() {
  console.log('[P6] lastUsedAt 更新按 id 合并进新鲜快照（并发 create 不被 clobber）');
  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
  const k2Plaintext = 'fpbak_' + crypto.randomBytes(24).toString('hex');
  const k2 = {
    id: 'ak_c62_k2', name: 'k2-concurrent', prefix: k2Plaintext.slice(0, 12), keyHash: sha(k2Plaintext),
    userId: userA.id, workspaceId: ws.id, readOnly: false, createdAt: Date.now(), lastUsedAt: null, revokedAt: null,
  };
  // apiKeyByToken 内部对 apiKeys 文件恰好读两次：第 1 次初始快照，第 2 次是修复后的新鲜重读。
  // 在第 2 次读之前把 K2 并发写入磁盘 → 修复后 K2 应存活；旧代码 saveApiKeys(旧快照) 会把 K2 抹掉。
  let calls = 0;
  const restore = patchRead(APIKEYS, (f, orig, rest) => {
    calls++;
    if (calls === 2) {
      const cur = readJsonFile(APIKEYS);
      if (!cur.some((x) => x.id === k2.id)) { cur.push(k2); fs.writeFileSync(f, JSON.stringify(cur, null, 2), 'utf8'); }
    }
    return orig.call(fs, f, ...rest);
  });
  let k = null, threw = null;
  try { k = identity.apiKeyByToken(k1Plaintext); } catch (e) { threw = e; }
  restore();
  assert('P6a 认证成功返回 K1', !!k && k.id !== 'ak_c62_k2' && k.name === 'k1', { threw: threw && threw.message, calls });
  const onDisk = readJsonFile(APIKEYS);
  const dK1 = onDisk.find((x) => x.name === 'k1');
  const dK2 = onDisk.find((x) => x.id === 'ak_c62_k2');
  assert('P6b 并发新建的 K2 未被旧快照覆写（丢失更新杀手）', !!dK2, onDisk.map((x) => x.name));
  assert('P6c K1 的 lastUsedAt 已落盘', !!dK1 && typeof dK1.lastUsedAt === 'number' && dK1.lastUsedAt > 0, dK1 && dK1.lastUsedAt);
  // 撤销语义不被合并逻辑破坏：K2 可被撤销且撤销后立刻失效
  const revoked = identity.revokeApiKey('ak_c62_k2', userA);
  assert('P6d 撤销 K2 成功', !!revoked && !!revoked.revokedAt);
  assert('P6e 撤销后 K2 明文立即失效', identity.apiKeyByToken(k2Plaintext) === null);
})();

// ---- P7 行为回归：密码 / 会话 / 撤销基础契约 ----
(function P7() {
  console.log('[P7] 基础契约回归');
  const h = identity.hashPassword('secret-pw-1');
  assert('P7a hash/verify 往返', identity.verifyPassword('secret-pw-1', h) === true);
  assert('P7b 错误密码拒绝', identity.verifyPassword('wrong-pw', h) === false);
  assert('P7c 畸形 stored 拒绝（不抛）', identity.verifyPassword('x', 'garbage') === false);
  const t = identity.createSession(userA.id, ws.id);
  assert('P7d 会话往返', identity.userBySessionToken(t).id === userA.id);
  assert('P7e destroySession 首次 true / 二次 false', identity.destroySession(t) === true && identity.destroySession(t) === false);
  assert('P7f 域内 tmp 目录无 .tmp 残留（终态）', fs.readdirSync(TMP).filter((f) => f.endsWith('.tmp')).length === 0);
})();

console.log('\n==== C62 identity IO hardening: ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) { failures.forEach((f) => console.log('  FAILED: ' + f)); process.exit(1); }
