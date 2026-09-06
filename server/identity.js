'use strict';

// CAP-O1：User / Workspace / Role / Permission 身份基础层（最小可商业化闭环）。
//
// 定位与边界（docs/product/CAP_O1_IDENTITY_ARCHITECTURE.md §0–§8）：
//   - 叠加在 STEP 0.5 机器级边界（auth.js）之上，不替换。双模式：
//       模式 A（本地单机，默认）：惰性 bootstrap local 用户 + 默认工作区 + OWNER；
//         loopback 请求自动挂 local 用户 → 现有行为与全部回归零变化。
//       模式 B（FPB_API_TOKEN 共享部署）：session token 优先；机器 token 持有者映射为
//         local 用户（保持既有消费方兼容）；无身份 → 401。
//   - 密码只存 scrypt hash（s1$salt$hash）；明文不落盘、不进日志/LLM/trace。
//   - 与 server/vault.js（第三方网站凭据）概念隔离：登录密码 ≠ 站点凭据。
//   - fail-open 原则的对称面：身份检查是安全边界，**fail-closed**（解析失败=无身份），
//     但解析异常绝不向上抛——返回 null 交由 requireAuth 决定 401/403。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const auth = require('./auth');
const audit = require('./audit'); // CAP-O2：安全审计流（与运行时事件总线分离）

// 数据目录：默认 server/data；FPB_DATA_DIR 供测试/部署隔离（db.js 与 agent/storage 同步支持）
const DATA_DIR = process.env.FPB_DATA_DIR
  ? path.resolve(process.env.FPB_DATA_DIR)
  : path.join(__dirname, 'data');

const FILES = {
  users: path.join(DATA_DIR, 'identity_users.json'),
  workspaces: path.join(DATA_DIR, 'identity_workspaces.json'),
  memberships: path.join(DATA_DIR, 'identity_memberships.json'),
  sessions: path.join(DATA_DIR, 'identity_sessions.json'),
  apiKeys: path.join(DATA_DIR, 'identity_apikeys.json'), // CAP-O2
};

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

// ---- 三角色权限矩阵（§3：禁止过早设计几十种细粒度权限；检查入口唯一） ----
const ROLE_PERMISSIONS = {
  OWNER: new Set([
    'profile:manage', 'profile:use', 'task:manage', 'task:create', 'task:read',
    'credential:manage', 'member:manage', 'workspace:update', 'workspace:delete',
    'audit:read', 'billing:manage',
  ]),
  ADMIN: new Set([
    'profile:manage', 'profile:use', 'task:manage', 'task:create', 'task:read',
    'credential:manage', 'member:manage', 'audit:read',
  ]),
  MEMBER: new Set(['profile:use', 'task:create', 'task:read']),
};

// ---- 存储（JSON facade，与 db.js 同款最小实现） ----
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}
const getUsers = () => readJson(FILES.users, []);
const saveUsers = (l) => writeJson(FILES.users, l);
const getWorkspaces = () => readJson(FILES.workspaces, []);
const saveWorkspaces = (l) => writeJson(FILES.workspaces, l);
const getMemberships = () => readJson(FILES.memberships, []);
const saveMemberships = (l) => writeJson(FILES.memberships, l);
const getSessions = () => readJson(FILES.sessions, []);
const saveSessions = (l) => writeJson(FILES.sessions, l);

const genId = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---- 密码（scrypt；s1$salt$hash） ----
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return 's1$' + salt.toString('hex') + '$' + hash.toString('hex');
}
function verifyPassword(pw, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 3 || parts[0] !== 's1') return false;
    const salt = Buffer.from(parts[1], 'hex');
    const expect = Buffer.from(parts[2], 'hex');
    const got = crypto.scryptSync(String(pw), salt, expect.length);
    return crypto.timingSafeEqual(got, expect);
  } catch (e) {
    return false;
  }
}

// ---- 用户 / 工作区 / 成员 ----
function findUserByName(username) {
  const u = String(username || '').trim().toLowerCase();
  return getUsers().find((x) => (x.username || '').toLowerCase() === u) || null;
}
function createUser({ username, password, email }) {
  const name = String(username || '').trim();
  if (name.length < 3) throw bad(400, '用户名至少 3 个字符');
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw bad(400, '用户名只允许字母数字_.-');
  if (findUserByName(name)) throw bad(409, '用户名已存在');
  if (typeof password !== 'string' || password.length < 8) throw bad(400, '密码至少 8 位');
  const now = Date.now();
  const user = {
    id: genId('u'), username: name, email: email || '',
    passwordHash: hashPassword(password), status: 'active', createdAt: now, updatedAt: now,
  };
  saveUsers(getUsers().concat(user));
  return user;
}

function createWorkspace(user, name) {
  const now = Date.now();
  const ws = { id: genId('ws'), name: String(name || '').trim().slice(0, 60) || (user.username + ' 的工作区'), ownerId: user.id, planId: 'free', status: 'active', createdAt: now, updatedAt: now };
  saveWorkspaces(getWorkspaces().concat(ws));
  const m = { id: genId('m'), workspaceId: ws.id, userId: user.id, role: 'OWNER', status: 'active', createdAt: now };
  saveMemberships(getMemberships().concat(m));
  return ws;
}

function membershipsOf(userId) {
  return getMemberships().filter((m) => m.userId === userId && m.status === 'active');
}
function workspacesOf(userId) {
  const ids = new Set(membershipsOf(userId).map((m) => m.workspaceId));
  return getWorkspaces().filter((w) => ids.has(w.id) && w.status === 'active');
}
function primaryWorkspaceId(userId) {
  // CAP-O1：主工作区 = 最近一次获得成员关系的工作区（创建新工作区后当前上下文自然切换）
  const ms = membershipsOf(userId);
  if (!ms.length) return null;
  let best = ms[0];
  for (const m of ms) if ((m.createdAt || 0) >= (best.createdAt || 0)) best = m;
  return best.workspaceId;
}
function roleOf(userId, workspaceId) {
  const m = getMemberships().find((x) => x.userId === userId && x.workspaceId === workspaceId && x.status === 'active');
  return m ? m.role : null;
}

// ---- RBAC 唯一检查入口 ----
function can(userId, workspaceId, permission) {
  const role = roleOf(userId, workspaceId);
  if (!role) return false;
  const perms = ROLE_PERMISSIONS[role];
  return !!(perms && perms.has(permission));
}
// 抛出带 status 的错误供路由统一转 401/403（fail-closed）
function assertCan(userId, workspaceId, permission) {
  if (!userId) throw bad(401, '未登录');
  if (!workspaceId || !can(userId, workspaceId, permission)) {
    throw bad(403, '无权限：' + permission + ' @ ' + workspaceId);
  }
  return true;
}
function bad(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---- 会话（明文 token 只出现一次；落盘存 sha256） ----
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function createSession(userId, workspaceId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  saveSessions(getSessions().concat({
    tokenHash: sha256(token), userId, workspaceId: workspaceId || primaryWorkspaceId(userId) || null,
    createdAt: now, expiresAt: now + SESSION_TTL_MS,
  }));
  return token;
}
function destroySession(token) {
  if (!token) return false;
  const h = sha256(token);
  const before = getSessions();
  const rest = before.filter((s) => s.tokenHash !== h);
  if (rest.length === before.length) return false; // 不存在的 token：不做无意义落盘
  saveSessions(rest);
  return true;
}
function userBySessionToken(token) {
  if (!token) return null;
  const h = sha256(token);
  const s = getSessions().find((x) => x.tokenHash === h);
  if (!s || s.expiresAt < Date.now()) return null;
  return getUsers().find((u) => u.id === s.userId && u.status !== 'disabled') || null;
}

// ---- CAP-O2：API Key（机器对机器的第三种身份来源，与 session/机器 token 并列） ----
//   - 明文（fpbak_ 前缀）只在创建响应出现一次；落盘只存 sha256。
//   - key 绑定 (userId, workspaceId)：解析出的身份 = 所属用户 + 固定工作区上下文，
//     权限完全继承该用户在此工作区的 RBAC 角色 —— 不引入第二套权限体系。
//   - readOnly key 禁止一切写方法（enforceApiKeyWriteGuard，403）。
const API_KEY_PREFIX = 'fpbak_';
const API_KEY_LIMIT_PER_USER_WS = 20;

function getApiKeys() { return readJson(FILES.apiKeys, []); }
function saveApiKeys(l) { writeJson(FILES.apiKeys, l); }

function createApiKey(user, { name, workspaceId, readOnly } = {}) {
  if (!user) throw bad(401, '未登录');
  const wsId = workspaceId || user.currentWorkspaceId;
  if (!wsId) throw bad(400, '缺少 workspaceId');
  if (!roleOf(user.id, wsId)) throw bad(403, '不是该工作区成员');
  const active = getApiKeys().filter((k) => k.userId === user.id && k.workspaceId === wsId && !k.revokedAt);
  if (active.length >= API_KEY_LIMIT_PER_USER_WS) {
    throw bad(400, '该工作区 API Key 数量已达上限（' + API_KEY_LIMIT_PER_USER_WS + '）');
  }
  const plaintext = API_KEY_PREFIX + crypto.randomBytes(24).toString('hex');
  const key = {
    id: genId('ak'), name: String(name || 'api-key').slice(0, 60),
    prefix: plaintext.slice(0, 12), keyHash: sha256(plaintext),
    userId: user.id, workspaceId: wsId,
    readOnly: readOnly === true,
    createdAt: Date.now(), lastUsedAt: null, revokedAt: null,
  };
  saveApiKeys(getApiKeys().concat(key));
  audit.log({ workspaceId: wsId, actorId: user.id, actorName: user.username, actorType: 'user', action: 'apikey.create', resourceType: 'api_key', resourceId: key.id, detail: { name: key.name, readOnly: key.readOnly } });
  return { key, plaintext };
}

function apiKeyByToken(token) {
  const t = String(token || '');
  if (!t.startsWith(API_KEY_PREFIX)) return null;
  const h = sha256(t);
  const keys = getApiKeys();
  const k = keys.find((x) => x.keyHash === h);
  if (!k || k.revokedAt) return null;
  const now = Date.now();
  if (!k.lastUsedAt || now - k.lastUsedAt > 60000) { // lastUsedAt 写节流（60s），高频请求不吃 IO
    k.lastUsedAt = now;
    saveApiKeys(keys);
  }
  return k;
}

function revokeApiKey(keyId, user) {
  if (!user) throw bad(401, '未登录');
  const keys = getApiKeys();
  const k = keys.find((x) => x.id === keyId);
  if (!k || k.revokedAt) return null;
  const isCreator = k.userId === user.id;
  const role = roleOf(user.id, k.workspaceId);
  if (!isCreator && role !== 'OWNER' && role !== 'ADMIN') throw bad(403, '无权撤销该 API Key');
  k.revokedAt = Date.now();
  saveApiKeys(keys);
  audit.log({ workspaceId: k.workspaceId, actorId: user.id, actorName: user.username, actorType: 'user', action: 'apikey.revoke', resourceType: 'api_key', resourceId: k.id, detail: {} });
  return k;
}

// 列表（脱敏：不落 keyHash）：本人创建的 + 当前工作区 ADMIN/OWNER 可见本区全部
function listApiKeys(user) {
  if (!user) return [];
  return getApiKeys()
    .filter((k) => !k.revokedAt && (
      k.userId === user.id ||
      (k.workspaceId === user.currentWorkspaceId && ['OWNER', 'ADMIN'].includes(roleOf(user.id, k.workspaceId)))
    ))
    .map((k) => { const { keyHash, ...rest } = k; return rest; })
    .sort((a, b) => b.createdAt - a.createdAt);
}

// ---- 模式 A 惰性 bootstrap：local 用户 + 默认工作区（幂等） ----
let _bootstrapped = null;
function ensureLocalIdentity() {
  if (_bootstrapped) return _bootstrapped;
  let local = getUsers().find((u) => u.status === 'local');
  if (!local) {
    const now = Date.now();
    local = { id: genId('u'), username: 'local', email: '', passwordHash: '', status: 'local', createdAt: now, updatedAt: now };
    saveUsers(getUsers().concat(local));
  }
  let ws = getWorkspaces().find((w) => w.ownerId === local.id);
  if (!ws) ws = createWorkspace(local, '默认工作区');
  _bootstrapped = { user: local, workspaceId: ws.id };
  return _bootstrapped;
}

// ---- 请求身份解析（requireAuth 之前跑；结果挂 req.identityUser） ----
function extractBearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}
function resolveRequestUser(req) {
  try {
    const t = extractBearer(req);
    // 1) session token 优先（多用户语义）
    const u = userBySessionToken(t);
    if (u) return { ...u, currentWorkspaceId: primaryWorkspaceId(u.id) };
    // 2) CAP-O2：API Key（fpbak_ 前缀）。无效/已撤销的 key 明确 fail-closed，
    //    绝不静默落回 loopback / 机器 token 分支（否则坏 key 会变成 local 身份）。
    if (t.startsWith(API_KEY_PREFIX)) {
      const k = apiKeyByToken(t);
      if (!k) return null;
      const owner = getUsers().find((x) => x.id === k.userId && x.status !== 'disabled');
      if (!owner) return null;
      return { ...owner, currentWorkspaceId: k.workspaceId, __apiKey: { id: k.id, name: k.name, readOnly: !!k.readOnly } };
    }
    // 3) 模式 A：loopback → local 用户
    if (!auth.hasToken && auth.isLoopback(auth.clientIp(req))) {
      const b = ensureLocalIdentity();
      return { ...b.user, currentWorkspaceId: b.workspaceId };
    }
    // 4) 模式 B：有效机器 token → local 用户（机器信任 ≡ 本地管理员，保持既有消费方兼容）
    if (auth.hasToken && auth.tokenMatches(auth.extractToken(req))) {
      const b = ensureLocalIdentity();
      return { ...b.user, currentWorkspaceId: b.workspaceId };
    }
    return null;
  } catch (e) {
    return null; // fail-closed：解析失败=无身份，交 requireAuth 判定
  }
}
function identityResolver(req, res, next) {
  req.identityUser = resolveRequestUser(req);
  next();
}

// CAP-O2：API Key 写守卫（业务路由，挂在 requireAuth 之后）。
// readOnly key：一切非读方法（POST/PUT/DELETE/PATCH）→ 403；
// full key：业务写放行（RBAC 继承所属用户角色）——这正是 full key 的存在意义。
function enforceApiKeyWriteGuard(req, res, next) {
  const u = req.identityUser;
  if (u && u.__apiKey && u.__apiKey.readOnly && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return res.status(403).json({ ok: false, error: 'API Key 为只读（readOnly），禁止写操作' });
  }
  next();
}

// CAP-O2：身份自管端点专用（/api/auth 路由内）。一切 API Key（含 full）禁止写操作——
// 防止「用 key 造 key」的自举提权；身份管理必须由人类 session 完成。
function enforceNoApiKeyWriteGuard(req, res, next) {
  const u = req.identityUser;
  if (u && u.__apiKey && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return res.status(403).json({ ok: false, error: '身份自管端点不接受 API Key 写操作' });
  }
  next();
}

// ---- 资源归属（§4 矩阵落点） ----
// 盖章：workspaceId + createdBy/updatedBy
function stamp(user, workspaceId) {
  return { workspaceId: workspaceId || (user && user.currentWorkspaceId) || null, createdBy: user ? user.id : null, updatedBy: user ? user.id : null };
}
// legacy 规则：无 workspaceId 的资源 = 本地默认工作区，仅 local 用户可见可改
function canAccessResource(user, resource, permission) {
  if (!user) return false;
  if (!resource.workspaceId) return user.status === 'local';
  return can(user.id, resource.workspaceId, permission);
}
function assertCanAccessResource(user, resource, permission) {
  if (!user) throw bad(401, '未登录');
  if (!canAccessResource(user, resource, permission)) {
    throw bad(403, '无权访问该资源（跨工作区或权限不足）');
  }
  return true;
}
// 列表过滤：本地用户额外可见 legacy（无归属）资源
function filterByWorkspace(list, user) {
  if (!user) return [];
  const wsIds = new Set(membershipsOf(user.id).map((m) => m.workspaceId));
  return (list || []).filter((x) => (x.workspaceId ? wsIds.has(x.workspaceId) : user.status === 'local'));
}

// ---- 公开脱敏 ----
function publicUser(u) { return u ? { id: u.id, username: u.username, email: u.email, status: u.status } : null; }

// ---- 身份路由（挂 /api/auth，位于 requireAuth 之前；register/login 公开，其余自管） ----
const router = express.Router();
router.use(express.json({ limit: '256kb' }));

router.post('/register', (req, res) => {
  try {
    const u = createUser({ username: req.body.username, password: req.body.password, email: req.body.email });
    // CAP-O1：注册即赠送个人工作区（新用户必须拥有可归属资源的空间，否则登录后 workspaceId 为 null）
    const ws = createWorkspace(u, u.username + ' 的工作区');
    audit.log({ workspaceId: ws.id, actorId: u.id, actorName: u.username, actorType: 'user', action: 'auth.register', resourceType: 'user', resourceId: u.id, detail: { workspaceId: ws.id } });
    res.status(201).json({ ok: true, user: publicUser(u), workspaceId: ws.id });
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
});

router.post('/login', (req, res) => {
  try {
    const u = findUserByName(req.body.username);
    if (!u || u.status === 'disabled' || !u.passwordHash || !verifyPassword(req.body.password, u.passwordHash)) {
      // 审计失败尝试（不含密码；不区分「不存在」与「密码错」的响应语义保持不变）
      audit.log({ workspaceId: null, actorId: u ? u.id : null, actorName: String(req.body.username || '').slice(0, 60), actorType: 'user', action: 'auth.login_failed', resourceType: 'user', resourceId: u ? u.id : null, detail: {} });
      return res.status(401).json({ ok: false, error: '用户名或密码错误' }); // 不区分「不存在」与「密码错」
    }
    const token = createSession(u.id);
    audit.log({ workspaceId: primaryWorkspaceId(u.id), actorId: u.id, actorName: u.username, actorType: 'user', action: 'auth.login', resourceType: 'user', resourceId: u.id, detail: {} });
    res.json({ ok: true, token, user: publicUser(u), workspaceId: primaryWorkspaceId(u.id) });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
});

// 以下端点要求已解析身份（session / loopback / 机器 token 任一）
// 注意：/api/auth 挂载点在全局 identityResolver 之前，自管端点需在路由内自行解析
router.use(identityResolver);
function requireUser(req, res, next) {
  if (!req.identityUser) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  next();
}
router.use(requireUser);
router.use(enforceNoApiKeyWriteGuard); // CAP-O2：API key 不得进行身份自管写操作（防自举提权）

router.post('/logout', (req, res) => {
  const t = extractBearer(req);
  destroySession(t);
  audit.log({ workspaceId: req.identityUser.currentWorkspaceId, actorId: req.identityUser.id, actorName: req.identityUser.username, actorType: 'user', action: 'auth.logout', resourceType: 'user', resourceId: req.identityUser.id, detail: {} });
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const u = req.identityUser;
  res.json({ ok: true, user: publicUser(u), workspaceId: u.currentWorkspaceId, workspaces: workspacesOf(u.id) });
});

router.post('/workspaces', (req, res) => {
  const ws = createWorkspace(req.identityUser, req.body.name);
  audit.log({ workspaceId: ws.id, actorId: req.identityUser.id, actorName: req.identityUser.username, actorType: 'user', action: 'workspace.create', resourceType: 'workspace', resourceId: ws.id, detail: { name: ws.name } });
  res.status(201).json({ ok: true, workspace: ws });
});

router.get('/workspaces', (req, res) => {
  res.json({ ok: true, workspaces: workspacesOf(req.identityUser.id) });
});

router.post('/workspaces/:id/members', (req, res) => {
  try {
    const wsId = req.params.id;
    const role = String(req.body.role || 'MEMBER').toUpperCase();
    if (!['OWNER', 'ADMIN', 'MEMBER'].includes(role)) throw bad(400, '非法角色');
    // ADMIN 可管成员但不能授予 OWNER（§3：不能转移 Owner）；授 OWNER 需 workspace:update（仅 OWNER）
    assertCan(req.identityUser.id, wsId, 'member:manage');
    if (role === 'OWNER') assertCan(req.identityUser.id, wsId, 'workspace:update');
    const target = findUserByName(req.body.username);
    if (!target) throw bad(404, '目标用户不存在');
    const all = getMemberships();
    if (all.some((m) => m.workspaceId === wsId && m.userId === target.id && m.status === 'active')) {
      throw bad(409, '已是成员');
    }
    const m = { id: genId('m'), workspaceId: wsId, userId: target.id, role, status: 'active', createdAt: Date.now() };
    saveMemberships(all.concat(m));
    audit.log({ workspaceId: wsId, actorId: req.identityUser.id, actorName: req.identityUser.username, actorType: 'user', action: 'member.add', resourceType: 'membership', resourceId: m.id, detail: { targetUserId: target.id, targetUsername: target.username, role } });
    res.status(201).json({ ok: true, membership: { ...m, userId: undefined, username: target.username, role: m.role } });
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
});

router.get('/workspaces/:id/members', (req, res) => {
  try {
    assertCan(req.identityUser.id, req.params.id, 'task:read'); // 任意成员可读成员列表
    const users = getUsers();
    const members = getMemberships()
      .filter((m) => m.workspaceId === req.params.id && m.status === 'active')
      .map((m) => { const u = users.find((x) => x.id === m.userId); return { userId: m.userId, username: u ? u.username : m.userId, role: m.role, createdAt: m.createdAt }; });
    res.json({ ok: true, members });
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
});

// ---- CAP-O2：API Key 自管端点（身份自管写已被 enforceApiKeyWriteGuard 对一切 API key 关闭，
//      因此这里只会被 session / loopback / 机器 token 身份调用） ----
router.post('/api-keys', (req, res) => {
  try {
    const u = req.identityUser;
    const { key, plaintext } = createApiKey(u, { name: req.body.name, workspaceId: req.body.workspaceId, readOnly: req.body.readOnly });
    // 明文只在此响应出现一次；之后任何接口/落盘都只有 prefix + sha256
    res.status(201).json({ ok: true, id: key.id, name: key.name, prefix: key.prefix, workspaceId: key.workspaceId, readOnly: key.readOnly, key: plaintext });
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
});

router.get('/api-keys', (req, res) => {
  res.json({ ok: true, keys: listApiKeys(req.identityUser) });
});

router.delete('/api-keys/:id', (req, res) => {
  try {
    const k = revokeApiKey(req.params.id, req.identityUser);
    if (!k) return res.status(404).json({ ok: false, error: 'API Key 不存在或已撤销' });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
});

// ---- CAP-O2：审计查询 / 导出（audit:read = OWNER/ADMIN 专属） ----
function auditQueryFromReq(req) {
  const u = req.identityUser;
  const wsId = String(req.query.workspaceId || '') || u.currentWorkspaceId;
  assertCan(u.id, wsId, 'audit:read');
  return { workspaceId: wsId, ...audit.query({ workspaceId: wsId, action: req.query.action || '', resourceType: req.query.resourceType || '', actorId: req.query.actorId || '', limit: Number(req.query.limit) || 200 }) };
}

router.get('/audit', (req, res) => {
  try {
    const r = auditQueryFromReq(req);
    res.json({ ok: true, workspaceId: r.workspaceId, total: r.total, entries: r.entries });
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
});

router.get('/audit/export', (req, res) => {
  try {
    const r = auditQueryFromReq(req);
    res.setHeader('Content-Disposition', 'attachment; filename="fpb-audit-export.json"');
    res.json({ format: 'fpb-audit', version: 1, exportedAt: new Date().toISOString(), workspaceId: r.workspaceId, total: r.total, entries: r.entries });
  } catch (e) {
    res.status(e.status || 400).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
});

module.exports = {
  router,
  identityResolver,
  enforceApiKeyWriteGuard,
  // 供测试与资源守卫使用
  can, assertCan, assertCanAccessResource, canAccessResource, filterByWorkspace, stamp,
  hashPassword, verifyPassword, createUser, createWorkspace, createSession, destroySession,
  userBySessionToken, findUserByName, membershipsOf, workspacesOf, primaryWorkspaceId, roleOf,
  ensureLocalIdentity, resolveRequestUser, ROLE_PERMISSIONS, bad,
  // CAP-O2
  createApiKey, apiKeyByToken, revokeApiKey, listApiKeys, getApiKeys, API_KEY_PREFIX,
  enforceNoApiKeyWriteGuard,
};
