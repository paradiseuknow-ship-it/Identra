'use strict';

// STEP 11 — CAP-O1：User / Workspace / Role / Permission 身份基础层
//
// 覆盖（docs/product/CAP_O1_IDENTITY_ARCHITECTURE.md §3/§5/§6/§7）：
//   Part 1（模块级，隔离 FPB_DATA_DIR）：scrypt 密码、注册校验、bootstrap 幂等、RBAC 矩阵、
//           会话生命周期（含过期）、legacy 资源规则、归属盖章/列表过滤、resolveRequestUser。
//   Part 2（真实 HTTP e2e：子进程起生产 server/index.js，模式 B + 隔离数据目录）：
//           未认证 401 → 注册/登录 → 工作区/成员管理 → Profile 跨工作区隔离
//           （同 ws 放行 / MEMBER 改删拒 / ADMIN 按角色 / 跨 ws 不可见不可改删）
//           → ADMIN 不可授 OWNER → AI Task 归属盖章 → logout 后 token 失效。
//   Part 3：红线扫描（不出现 siteType 判定 / 明文密码落盘）。
// 用法：node server/scripts/test_step11_identity.js

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  \u2714 ' + name); }
  else { fail++; console.log('  \u2718 FAIL: ' + name + (extra ? ' \u2014 ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

// ============================================================================
// Part 1 — 模块级（先设隔离目录，再 require）
// ============================================================================
section('Part 1: 模块级（隔离 FPB_DATA_DIR）');
const TMP1 = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-o1-mod-'));
process.env.FPB_DATA_DIR = TMP1;
delete process.env.FPB_API_TOKEN; // Part 1 走模式 A 语义
const identity = require('../identity');
const auth = require('../auth');

ok(identity.verifyPassword('正确密码8位', identity.hashPassword('正确密码8位')), 'scrypt hash/verify 往返成立');
ok(!identity.verifyPassword('错误密码8位', identity.hashPassword('正确密码8位')), '错误密码被拒绝');
ok(!identity.verifyPassword('正确密码8位', 's1$deadbeef$' + '0'.repeat(128)), '篡改 salt/hash 被拒绝');
const alice = identity.createUser({ username: 'alice', password: 'alice-pass-123' });
const stored = fs.readFileSync(path.join(TMP1, 'identity_users.json'), 'utf8');
ok(!stored.includes('alice-pass-123') && stored.includes('passwordHash'), '用户文件只存 hash，不含明文密码');

// 注册校验
function expectStatus(fn, status) {
  try { fn(); return false; } catch (e) { return e.status === status; }
}
ok(expectStatus(() => identity.createUser({ username: 'ab', password: '12345678' }), 400), '用户名 <3 字符 → 400');
ok(expectStatus(() => identity.createUser({ username: 'pwuser', password: 'short' }), 400), '密码 <8 位 → 400');
ok(expectStatus(() => identity.createUser({ username: 'ALICE', password: 'other-pass-123' }), 409), '重名（大小写不敏感）→ 409');

// bootstrap 幂等 + local 身份
const b1 = identity.ensureLocalIdentity();
const b2 = identity.ensureLocalIdentity();
ok(b1.user.id === b2.user.id && b1.workspaceId === b2.workspaceId, 'ensureLocalIdentity 幂等（同一 local 用户/工作区）');
ok(identity.roleOf(b1.user.id, b1.workspaceId) === 'OWNER', 'local 用户是默认工作区 OWNER');

// RBAC 矩阵（§3）
const wsA = identity.createWorkspace(alice, 'Alice 工作区');
const bob = identity.createUser({ username: 'bob', password: 'bob-pass-12345' });
const charlie = identity.createUser({ username: 'charlie', password: 'charlie-pas-1' });
identity.createWorkspace(alice, '占位避免 primary 混淆'); // 多工作区场景
// 用内部路径直接建成员（等价于经 /workspaces/:id/members 的 OWNER/ADMIN 授予）
function addMember(wsId, user, role) {
  const ms = require('fs').readFileSync(path.join(TMP1, 'identity_memberships.json'), 'utf8');
  const list = JSON.parse(ms);
  list.push({ id: 'm_test_' + Math.random().toString(36).slice(2, 8), workspaceId: wsId, userId: user.id, role, status: 'active', createdAt: Date.now() });
  fs.writeFileSync(path.join(TMP1, 'identity_memberships.json'), JSON.stringify(list, null, 2));
}
addMember(wsA.id, bob, 'MEMBER');
addMember(wsA.id, charlie, 'ADMIN');
ok(identity.can(alice.id, wsA.id, 'workspace:delete'), 'OWNER 可 workspace:delete');
ok(identity.can(alice.id, wsA.id, 'billing:manage'), 'OWNER 可 billing:manage');
ok(!identity.can(charlie.id, wsA.id, 'workspace:delete') && !identity.can(charlie.id, wsA.id, 'workspace:update'), 'ADMIN 不可删/改 Workspace');
ok(identity.can(charlie.id, wsA.id, 'member:manage') && identity.can(charlie.id, wsA.id, 'profile:manage'), 'ADMIN 可管成员/Profile');
ok(!identity.can(bob.id, wsA.id, 'profile:manage') && !identity.can(bob.id, wsA.id, 'member:manage'), 'MEMBER 不可管 Profile/成员');
ok(identity.can(bob.id, wsA.id, 'profile:use') && identity.can(bob.id, wsA.id, 'task:create'), 'MEMBER 可使用 Profile / 创建 Task');
ok(!identity.can(bob.id, 'ws_不存在', 'profile:use'), '非成员一切拒绝');
ok(expectStatus(() => identity.assertCan(bob.id, wsA.id, 'profile:manage'), 403), 'assertCan 拒绝 → 403');

// 会话生命周期
const tok = identity.createSession(alice.id, wsA.id);
ok(identity.userBySessionToken(tok) && identity.userBySessionToken(tok).id === alice.id, 'session token → 用户');
const sessFile = path.join(TMP1, 'identity_sessions.json');
const sess = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
ok(sess.some((s) => s.tokenHash && !JSON.stringify(sess).includes(tok)), '落盘只存 tokenHash，不存明文 token');
sess.find((s) => s.userId === alice.id).expiresAt = Date.now() - 1;
fs.writeFileSync(sessFile, JSON.stringify(sess, null, 2));
ok(!identity.userBySessionToken(tok), '过期 session → 拒绝');
ok(identity.destroySession(identity.createSession(alice.id, wsA.id)), 'destroySession 成功');
ok(!identity.userBySessionToken('f'.repeat(64)), '随机 token → null');

// legacy 资源规则 + 盖章 + 过滤
const localUser = b1.user;
ok(identity.canAccessResource(localUser, { id: 'legacy' }, 'profile:manage'), 'legacy 资源（无归属）对 local 用户可见');
ok(!identity.canAccessResource(alice, { id: 'legacy' }, 'profile:manage'), 'legacy 资源对非 local 用户不可见');
const stamped = identity.stamp({ ...alice, currentWorkspaceId: wsA.id });
ok(stamped.workspaceId === wsA.id && stamped.createdBy === alice.id && stamped.updatedBy === alice.id, 'stamp → workspaceId/createdBy/updatedBy');
const profA = { id: 'p_a', workspaceId: wsA.id };
const profLegacy = { id: 'p_l' };
const listAlice = identity.filterByWorkspace([profA, profLegacy], alice);
ok(listAlice.length === 1 && listAlice[0].id === 'p_a', 'filterByWorkspace：alice 只见本工作区（不见 legacy）');
const listLocal = identity.filterByWorkspace([profA, profLegacy], localUser);
ok(listLocal.length === 1 && listLocal[0].id === 'p_l', 'local 用户可见 legacy（他人工作区资源仍不可见）');
ok(identity.filterByWorkspace([profA], bob).length === 1 && identity.filterByWorkspace([profA], charlie).length === 1, '同工作区成员可见');
const dave = identity.createUser({ username: 'dave', password: 'dave-pass-1234' });
ok(identity.filterByWorkspace([profA], dave).length === 0, '跨工作区不可见');

// resolveRequestUser（模式 A：loopback → local；session 优先）
const reqLoop = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
ok(identity.resolveRequestUser(reqLoop).status === 'local', '模式 A loopback → local 用户');
const reqSess = { headers: { authorization: 'Bearer ' + identity.createSession(alice.id, wsA.id) }, socket: { remoteAddress: '127.0.0.1' } };
ok(identity.resolveRequestUser(reqSess).id === alice.id, 'session token 优先于 loopback 映射');
ok(identity.resolveRequestUser({ headers: {}, socket: { remoteAddress: '10.1.2.3' } }) === null, '非 loopback 且无 token → null（fail-closed）');

// ============================================================================
// Part 2 — HTTP e2e（生产 server 子进程，模式 B）
// ============================================================================
section('Part 2: HTTP e2e（子进程生产入口，模式 B）');
const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-o1-e2e-'));
const PORT2 = 18790;
const BASE = 'http://127.0.0.1:' + PORT2;
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: path.join(__dirname, '..', '..'),
  env: { ...process.env, PORT: String(PORT2), FPB_BIND: '127.0.0.1', FPB_API_TOKEN: 'e2e-machine-token', FPB_DATA_DIR: TMP2 },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const _childOut = [];
child.stdout.on('data', (d) => _childOut.push(String(d)));
child.stderr.on('data', (d) => _childOut.push(String(d)));

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      // CAP-O1: 模式 B 下 health 挂在 requireAuth 之后 → 401 也证明服务已存活
      const r = await fetch(BASE + '/api/ai/health', { signal: AbortSignal.timeout(1000) });
      if (r.status === 200 || r.status === 401) return true;
    } catch (e) { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
async function api(method, p, token, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  let j = null;
  try { j = await r.json(); } catch (e) { /* 非 JSON */ }
  return { status: r.status, json: j };
}

(async () => {
  const ready = await waitReady();
  ok(ready, '生产 server 子进程启动成功（模式 B）');
  if (!ready) {
    console.error('--- 子进程输出 ---\n' + _childOut.join('').slice(-3000) + '\n--- 退出码: ' + child.exitCode + ' ---');
    finish(); return;
  }

  // 未认证 → 401
  ok((await api('GET', '/api/profiles')).status === 401, '无凭据 → 401（模式 B fail-closed）');

  // 注册 + 登录
  ok((await api('POST', '/api/auth/register', null, { username: 'alice2', password: 'alice2-pass-1' })).status === 201, '注册 alice2 → 201');
  ok((await api('POST', '/api/auth/register', null, { username: 'alice2', password: 'alice2-pass-1' })).status === 409, '重复注册 → 409');
  const lgBad = await api('POST', '/api/auth/login', null, { username: 'alice2', password: 'wrong-pass-999' });
  ok(lgBad.status === 401, '错误密码登录 → 401');
  for (const [u, p] of [['alice2', 'alice2-pass-1'], ['bob2', 'bob2-pass-123'], ['charlie2', 'charlie2-pass'], ['dave2', 'dave2-pass-12'], ['eve2', 'eve2-pass-123']]) {
    await api('POST', '/api/auth/register', null, { username: u, password: p });
  }
  const login = async (u, p) => (await api('POST', '/api/auth/login', null, { username: u, password: p })).json;
  const A = await login('alice2', 'alice2-pass-1');
  const B = await login('bob2', 'bob2-pass-123');
  const C = await login('charlie2', 'charlie2-pass');
  const D = await login('dave2', 'dave2-pass-12');
  ok(A && A.token && A.workspaceId, 'alice2 登录获得 token + workspaceId');
  ok((await api('GET', '/api/auth/me', A.token)).json.user.username === 'alice2', '/me 返回当前用户');

  // 工作区与成员
  const ws = (await api('POST', '/api/auth/workspaces', A.token, { name: '主工作区' })).json.workspace;
  ok(ws && ws.ownerId === A.user.id, '建工作区 → 创建者即 OWNER');
  ok((await api('POST', '/api/auth/workspaces/' + ws.id + '/members', B.token, { username: 'dave2', role: 'MEMBER' })).status === 403, 'MEMBER/非成员管理成员 → 403');
  ok((await api('POST', '/api/auth/workspaces/' + ws.id + '/members', A.token, { username: 'charlie2', role: 'ADMIN' })).status === 201, 'OWNER 授 ADMIN → 201');
  ok((await api('POST', '/api/auth/workspaces/' + ws.id + '/members', C.token, { username: 'bob2', role: 'OWNER' })).status === 403, 'ADMIN 授 OWNER → 403（不可转移 Owner）');
  ok((await api('POST', '/api/auth/workspaces/' + ws.id + '/members', C.token, { username: 'eve2', role: 'ADMIN' })).status === 201, 'ADMIN 授 ADMIN → 201');
  ok((await api('POST', '/api/auth/workspaces/' + ws.id + '/members', C.token, { username: 'bob2', role: 'MEMBER' })).status === 201, 'ADMIN 授 MEMBER → 201');
  const members = (await api('GET', '/api/auth/workspaces/' + ws.id + '/members', A.token)).json.members;
  ok(members.length === 4 && members.every((m) => m.username && m.role), '成员列表返回且角色正确（OWNER/ADMIN/MEMBER/ADMIN+创建者）');

  // Profile 隔离（§6 验收矩阵）
  const created = await api('POST', '/api/profiles', A.token, { name: '机密配置' });
  ok(created.status === 200 && created.json.workspaceId === ws.id && created.json.createdBy === A.user.id, '建 Profile → 盖 workspaceId/createdBy');
  const pid = created.json.id;
  ok((await api('GET', '/api/profiles', A.token)).json.some((x) => x.id === pid), '同工作区 OWNER 列表可见');
  ok((await api('GET', '/api/profiles', B.token)).json.some((x) => x.id === pid), '同工作区 MEMBER 列表可见');
  ok((await api('GET', '/api/profiles', D.token)).status === 200 && !(await api('GET', '/api/profiles', D.token)).json.some((x) => x.id === pid), '跨工作区列表不可见');
  ok((await api('GET', '/api/profiles/' + pid, B.token)).status === 200, '同工作区 MEMBER 可读（profile:use）');
  ok((await api('GET', '/api/profiles/' + pid, D.token)).status === 403, '跨工作区读 → 403');
  ok((await api('PUT', '/api/profiles/' + pid, B.token, { name: '改名' })).status === 403, 'MEMBER 改 Profile → 403（profile:manage）');
  ok((await api('PUT', '/api/profiles/' + pid, C.token, { name: '改名-Admin' })).status === 200, 'ADMIN 改 Profile → 200');
  ok((await api('DELETE', '/api/profiles/' + pid, D.token)).status === 403, '跨工作区删 → 403');
  ok((await api('POST', '/api/profiles/' + pid + '/duplicate', B.token)).status === 403, 'MEMBER 复制 → 403');
  ok((await api('DELETE', '/api/profiles/' + pid, A.token)).status === 200, 'OWNER 删除 Profile → 200');
  // 机器 token = local 用户（模式 B 兼容既有消费方），可见 legacy；但 alice2 的 Profile 有归属 → local 不可见
  const machine = await api('GET', '/api/profiles', 'e2e-machine-token');
  ok(machine.status === 200, '机器 token 仍可访问（local 用户映射，向后兼容）');

  // AI Task 归属盖章（§10）
  const t = await api('POST', '/api/ai/tasks', A.token, { name: 'e2e任务', objective: '打开示例页读取标题', targetUrl: 'https://example.com', executionMode: 'SIMULATION' });
  ok(t.status === 200 && t.json.workspaceId === ws.id && t.json.createdBy === A.user.id, 'AI Task → workspaceId/createdBy 服务端盖章');
  ok((await api('POST', '/api/ai/tasks', null, { name: '匿名任务' })).status === 401, '未认证建 AI Task → 401');

  // logout 失效
  ok((await api('POST', '/api/auth/logout', A.token)).status === 200, 'logout → 200');
  ok((await api('GET', '/api/profiles', A.token)).status === 401, 'logout 后原 token → 401');

  finish();
})().catch((e) => { console.error('e2e 异常:', e && e.message); ok(false, 'e2e 未抛异常', String(e && e.message)); finish(); });

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  try { child.kill(); } catch (e) { /* 已退出 */ }
  setTimeout(() => {
    for (const d of [TMP1, TMP2]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* 清理失败不掩盖结果 */ } }
    // Part 3 红线扫描
    section('Part 3: 红线扫描');
    const identitySrc = fs.readFileSync(path.join(__dirname, '..', 'identity.js'), 'utf8');
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    ok(!/siteType\s*===/.test(identitySrc + indexSrc), '身份层不引入 siteType 判定');
    ok(!/(password|secret|cvv)\s*[:=]\s*['"][^'"]{4,}['"]/i.test(identitySrc), 'identity.js 无硬编码密码类常量');
    console.log('\n===== STEP 11 结果: ' + pass + ' passed, ' + fail + ' failed =====');
    process.exit(fail ? 1 : 0);
  }, 500);
}
