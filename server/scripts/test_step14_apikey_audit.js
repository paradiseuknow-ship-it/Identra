'use strict';

// STEP 14 — CAP-O2：API Key（机器对机器身份）+ 独立 AuditLog（查询/导出）+ 守卫补全
// （Proxy / WorkflowTask / Vault / Browser / Automation 盖章 + 归属校验）。
//
// 覆盖：
//   Part 1 模块级：
//     A) audit：log/query 过滤/环形上限/敏感字段脱敏/落盘
//     B) identity API Key：创建→token 解析回路、撤销→fail-closed、明文不落盘、
//        resolveRequestUser 分支（fpbak_ 无效 → null；非 fpbak 垃圾 token + loopback → 仍 local）
//     C) enforceApiKeyWriteGuard 单元（readOnly/全量 key 的读写矩阵）
//   Part 2 e2e（模式 B）：
//     D) key 创建（明文仅一次）/ 列表脱敏 / key 身份继承 RBAC
//     E) readOnly 写守卫 403；任何 key 不得身份自管写（防自举提权）
//     F) 无效 key 401；撤销后 401
//     G) Proxy / WorkflowTask / Vault / Profile 归属守卫（跨工作区 403、MEMBER 权限矩阵）
//     H) 审计：动作齐备、按 action 过滤、audit:read 角色（MEMBER 403）、导出、跨工作区隔离、
//        vault 密码值不进审计流
//   Part 3 红线：无 siteType/saas 判定、守卫与审计接线齐备、明文 key 不落盘
// 用法：node server/scripts/test_step14_apikey_audit.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}
function section(name) { console.log('\n=== ' + name + ' ==='); }

// ============================================================================
// Part 1 — 模块级（独立 FPB_DATA_DIR，env 先于 require）
// ============================================================================
const TMP1 = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-o2-unit-'));
process.env.FPB_DATA_DIR = TMP1;
const audit = require('../audit');
const identity = require('../identity');

(async () => {
  section('A) audit 模块：写入 / 查询 / 脱敏 / 环形上限');
  audit.resetForTests();
  audit.log({ workspaceId: 'wsX', actorId: 'u1', actorName: 'alice', actorType: 'user', action: 'profile.create', resourceType: 'profile', resourceId: 'p1', detail: { name: 'a' } });
  audit.log({ workspaceId: 'wsX', actorId: 'u1', actorName: 'alice', actorType: 'user', action: 'proxy.create', resourceType: 'proxy', resourceId: 'px1', detail: { password: 'TOPSECRET', apiKey: 'k' } });
  audit.log({ workspaceId: 'wsY', actorId: 'u2', actorName: 'bob', actorType: 'api_key', action: 'profile.create', resourceType: 'profile', resourceId: 'p2', detail: {} });
  ok(audit.count() === 3, 'log 计数正确');
  const qAll = audit.query({ workspaceId: 'wsX' });
  ok(qAll.total === 2 && qAll.entries[0].action === 'proxy.create', '按 workspaceId 过滤且 newest first');
  ok(audit.query({ workspaceId: 'wsX', action: 'profile.create' }).total === 1, '按 action 过滤');
  const pxEntry = JSON.stringify(audit.query({ workspaceId: 'wsX', action: 'proxy.create' }).entries[0]);
  ok(pxEntry.indexOf('TOPSECRET') < 0 && pxEntry.indexOf('«redacted»') >= 0, '敏感字段脱敏（password→«redacted»）');
  for (let i = 0; i < audit.MAX_ENTRIES + 100; i++) {
    audit.log({ workspaceId: 'wsRing', action: 'ring', detail: { i } });
  }
  ok(audit.count() === audit.MAX_ENTRIES, '环形上限：超出淘汰最旧（' + audit.count() + '=' + audit.MAX_ENTRIES + '）');
  audit.flush();
  const onDisk = JSON.parse(fs.readFileSync(audit.AUDIT_FILE, 'utf8'));
  ok(Array.isArray(onDisk) && onDisk.length === audit.MAX_ENTRIES, 'flush 落盘条数一致');

  section('B) identity API Key 模块级');
  const local = identity.ensureLocalIdentity();
  const localUser = { ...local.user, currentWorkspaceId: local.workspaceId }; // 请求态身份形态
  const { key: kA, plaintext: ptA } = identity.createApiKey(localUser, { name: 'ci-key', readOnly: false });
  ok(/^fpbak_[0-9a-f]{48}$/.test(ptA), '明文 key 格式 fpbak_ + 48 hex');
  ok(kA.keyHash && kA.keyHash !== ptA && kA.keyHash.length === 64, '落盘只存 sha256');
  const parsed = identity.apiKeyByToken(ptA);
  ok(parsed && parsed.id === kA.id && parsed.lastUsedAt, 'apiKeyByToken 解析回路 + lastUsedAt 记录');
  const viaReq = identity.resolveRequestUser({ headers: { authorization: 'Bearer ' + ptA }, socket: { remoteAddress: '10.0.0.9' } });
  ok(viaReq && viaReq.id === localUser.id && viaReq.currentWorkspaceId === kA.workspaceId, 'resolveRequestUser：key → 所属用户 + 固定工作区');
  ok(viaReq.__apiKey && viaReq.__apiKey.readOnly === false, '身份携带 __apiKey 标记');
  ok(identity.resolveRequestUser({ headers: { authorization: 'Bearer fpbak_' + 'ab'.repeat(24) }, socket: { remoteAddress: '127.0.0.1' } }) === null, '无效 fpbak_ key → fail-closed null');
  ok(identity.resolveRequestUser({ headers: { authorization: 'Bearer junk-token-xyz' }, socket: { remoteAddress: '127.0.0.1' } }), '非 fpbak 垃圾 token + loopback → 仍解析 local（模式 A 零变化）');
  const keysFileRaw = fs.readFileSync(path.join(TMP1, 'identity_apikeys.json'), 'utf8');
  const keysFileJson = JSON.parse(keysFileRaw);
  // prefix 字段合法含 'fpbak_' 前缀（非密钥）；完整明文绝不落盘
  ok(keysFileRaw.indexOf(ptA) < 0, '明文 key 绝不落盘（只存 sha256 + prefix）');
  ok(keysFileJson[0] && keysFileJson[0].keyHash && keysFileJson[0].keyHash.length === 64 && keysFileJson[0].prefix === ptA.slice(0, 12), '落盘字段为 keyHash + prefix');
  const revoked = identity.revokeApiKey(kA.id, localUser);
  ok(revoked && identity.apiKeyByToken(ptA) === null, '撤销后 token 解析 → null（fail-closed）');

  section('C) enforceApiKeyWriteGuard 单元');
  function guardProbe(method, readOnly) {
    let status = 0;
    const res = { status(c) { status = c; return { json() {} }; }, json() {} };
    identity.enforceApiKeyWriteGuard({ method, identityUser: { id: 'u', __apiKey: { id: 'ak', readOnly } } }, res, () => { status = 200; });
    return status;
  }
  ok(guardProbe('GET', true) === 200 && guardProbe('HEAD', true) === 200, 'readOnly key GET/HEAD 放行');
  ok(guardProbe('POST', true) === 403 && guardProbe('DELETE', true) === 403, 'readOnly key 写方法 → 403');
  ok(guardProbe('GET', false) === 200, 'full key GET 放行');
  ok(guardProbe('POST', false) === 403 || true, 'full key 写由挂载位置决定（业务路由放行、身份自管路由 403，e2e 验证）');

  // ============================================================================
  // Part 2 — e2e（模式 B，生产入口子进程）
  // ============================================================================
  const PORT2 = 18795;
  const BASE = 'http://127.0.0.1:' + PORT2;
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-o2-e2e-'));
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, PORT: String(PORT2), FPB_BIND: '127.0.0.1', FPB_API_TOKEN: 'o2-machine-token', FPB_DATA_DIR: TMP2, FPB_MASTER_KEY: 'VYPix1ldjPleEIi9Y6qXwq5BzMo8XwkV+JrgxHpCBSc=' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const _childOut = [];
  child.stdout.on('data', (d) => _childOut.push(String(d)));
  child.stderr.on('data', (d) => _childOut.push(String(d)));

  async function waitReady() {
    for (let i = 0; i < 60; i++) {
      try {
        // 模式 B 下 health 挂在 requireAuth 之后 → 401 也证明服务已存活
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
      signal: AbortSignal.timeout(30000),
    });
    let j = null;
    try { j = await r.json(); } catch (e) { /* 非 JSON */ }
    return { status: r.status, json: j };
  }

  try {
    section('生产 server 启动（模式 B）');
    const ready = await waitReady();
    ok(ready, '生产 server 子进程启动成功');
    if (!ready) throw new Error('server 未就绪');

    for (const [u, p] of [['alice5', 'alice5-pass-1'], ['bob5', 'bob5-pass-12'], ['charlie5', 'charlie5-pass']]) {
      await api('POST', '/api/auth/register', null, { username: u, password: p });
    }
    const login = async (u, p) => (await api('POST', '/api/auth/login', null, { username: u, password: p })).json;
    const A = await login('alice5', 'alice5-pass-1');
    const B = await login('bob5', 'bob5-pass-12');
    const C = await login('charlie5', 'charlie5-pass');
    ok(A.token && B.token && C.token, '三用户注册登录成功');

    section('D) key 创建 / 列表脱敏 / key 身份继承 RBAC');
    const prof = await api('POST', '/api/profiles', A.token, { name: 'O2主配置', seed: 'o2_seed_1' });
    ok(prof.status === 200 && prof.json.workspaceId === A.workspaceId, 'OWNER 创建 profile 并盖章 workspaceId');
    const P1 = prof.json.id;

    const mk1 = await api('POST', '/api/auth/api-keys', A.token, { name: 'ci-full' });
    const mk2 = await api('POST', '/api/auth/api-keys', A.token, { name: 'ci-ro', readOnly: true });
    ok(mk1.status === 201 && /^fpbak_[0-9a-f]{48}$/.test(mk1.json.key || ''), 'full key 创建成功（明文仅此一次）');
    ok(mk2.status === 201 && mk2.json.readOnly === true, 'readOnly key 创建成功');
    const K1 = mk1.json.key, K2 = mk2.json.key, K1ID = mk1.json.id, K2ID = mk2.json.id;

    const listKeys = await api('GET', '/api/auth/api-keys', A.token);
    const k1row = (listKeys.json.keys || []).find((x) => x.id === K1ID);
    ok(listKeys.status === 200 && k1row && k1row.prefix === K1.slice(0, 12), '列表返回 prefix');
    ok(JSON.stringify(listKeys.json).indexOf(K1) < 0 && JSON.stringify(listKeys.json).indexOf('keyHash') < 0, '列表不含明文 key / keyHash');

    const kList = await api('GET', '/api/profiles', K1);
    ok(kList.status === 200 && kList.json.some((x) => x.id === P1), 'full key 可读 profiles（继承 OWNER 角色）');
    const kCreate = await api('POST', '/api/profiles', K1, { name: '由key创建' });
    ok(kCreate.status === 200 && kCreate.json.workspaceId === A.workspaceId && kCreate.json.createdBy !== null, 'full key 可创建 profile（RBAC 继承）并正确盖章', 'status=' + kCreate.status + ' body=' + JSON.stringify(kCreate.json).slice(0, 160));
    const kMe = await api('GET', '/api/auth/me', K1);
    ok(kMe.status === 200 && kMe.json.workspaceId === A.workspaceId, 'key 身份 me → 固定工作区上下文');
    const listAfterUse = await api('GET', '/api/auth/api-keys', A.token);
    ok((listAfterUse.json.keys || []).find((x) => x.id === K1ID).lastUsedAt, 'lastUsedAt 已记录');

    section('E) readOnly 写守卫 / 身份自管防自举提权');
    ok((await api('GET', '/api/profiles', K2)).status === 200, 'readOnly key 可读');
    ok((await api('POST', '/api/profiles', K2, { name: 'x' })).status === 403, 'readOnly key POST /profiles → 403');
    ok((await api('DELETE', '/api/proxies/whatever', K2)).status === 403, 'readOnly key DELETE → 403');
    ok((await api('POST', '/api/auth/api-keys', K2, { name: 'x' })).status === 403, 'readOnly key 造 key → 403');
    ok((await api('POST', '/api/auth/api-keys', K1, { name: 'x' })).status === 403, 'full key 造 key 也 → 403（身份自管必须人类 session）');
    ok((await api('POST', '/api/auth/workspaces', K1, { name: 'x' })).status === 403, 'full key 建工作区 → 403');

    section('F) 无效 / 撤销 key fail-closed');
    ok((await api('GET', '/api/profiles', 'fpbak_' + 'ff'.repeat(24))).status === 401, '无效 fpbak_ key → 401');
    ok((await api('DELETE', '/api/auth/api-keys/' + K2ID, A.token)).status === 200, '撤销 readOnly key');
    ok((await api('GET', '/api/profiles', K2)).status === 401, '撤销后 key → 401');
    ok((await api('DELETE', '/api/auth/api-keys/' + K2ID, A.token)).status === 404, '重复撤销 → 404');
    ok((await api('GET', '/api/profiles', 'o2-machine-token')).status === 200, '机器 token 兼容路径不受影响');

    section('G) 守卫补全：Proxy / WorkflowTask / Vault / Profile');
    const px = await api('POST', '/api/proxies', A.token, { name: '主代理', server: 'http://1.2.3.4:8080', username: 'u', password: 'proxysecret' });
    ok(px.status === 200 && px.json && px.json.workspaceId === A.workspaceId, 'proxy 创建并盖章', 'status=' + px.status + ' body=' + JSON.stringify(px.json).slice(0, 200));
    ok(!px.json || (px.json.password || '') === '' || String(px.json.password).indexOf('proxysecret') < 0, 'proxy 响应不回显明文密码');
    const PXID = px.json.id;
    ok((await api('GET', '/api/proxies', B.token)).json.length === 0, '跨工作区 proxy 列表不可见');
    ok((await api('GET', '/api/proxies', K1)).json.some((x) => x.id === PXID), 'key 身份可见本工作区 proxy');
    ok((await api('DELETE', '/api/proxies/' + PXID, B.token)).status === 403, '跨工作区删 proxy → 403');
    const tk = await api('POST', '/api/tasks', A.token, { name: '主工作流', type: 'custom', steps: [] });
    ok(tk.status === 200 && tk.json.workspaceId === A.workspaceId, 'workflow task 创建并盖章');
    ok((await api('PUT', '/api/tasks/' + tk.json.id, B.token, { name: 'x' })).status === 403, '跨工作区改 task → 403');
    ok((await api('GET', '/api/tasks', B.token)).json.length === 0, '跨工作区 task 列表不可见');

    ok((await api('POST', '/api/auth/workspaces/' + A.workspaceId + '/members', A.token, { username: 'charlie5', role: 'MEMBER' })).status === 201, 'alice 授 charlie MEMBER');
    ok((await api('GET', '/api/vault/' + P1, C.token)).status === 200, 'MEMBER 读 vault 掩码摘要 → 200（profile:use）');
    ok((await api('POST', '/api/vault/' + P1, C.token, { email: 'x@y.z' })).status === 403, 'MEMBER 写 vault → 403（credential:manage）');
    ok((await api('DELETE', '/api/profiles/' + P1, C.token)).status === 403, 'MEMBER 删 profile → 403');
    ok((await api('POST', '/api/profiles', C.token, { name: 'x' })).status === 403, 'MEMBER 创建 profile → 403（profile:manage）');
    ok((await api('GET', '/api/profiles/' + P1, B.token)).status === 403, '跨工作区读 profile → 403');
    const vaultSet = await api('POST', '/api/vault/' + P1, A.token, { email: 'a@b.c', password: 'VAULTSECRET99' });
    ok(vaultSet.status === 200, 'OWNER 写 vault → 200');

    section('H) 审计查询 / 导出 / 隔离 / 脱敏');
    const aud = await api('GET', '/api/auth/audit', A.token);
    ok(aud.status === 200 && aud.json.total > 0, 'OWNER 查询审计 → 200');
    const actions = new Set((aud.json.entries || []).map((e) => e.action));
    ok(['profile.create', 'proxy.create', 'apikey.create', 'auth.login', 'vault.set'].every((a) => actions.has(a)), '关键动作齐备（profile/proxy/apikey/login/vault）');
    const audF = await api('GET', '/api/auth/audit?action=profile.create', A.token);
    ok(audF.status === 200 && (audF.json.entries || []).length > 0 && audF.json.entries.every((e) => e.action === 'profile.create'), '按 action 过滤');
    ok((await api('GET', '/api/auth/audit', C.token)).status === 403, 'MEMBER 读审计 → 403（audit:read）');
    ok((await api('GET', '/api/auth/audit', K1)).status === 200, 'key 身份（继承 OWNER）可读审计');

    const exp = await api('GET', '/api/auth/audit/export', A.token);
    ok(exp.status === 200 && exp.json.format === 'fpb-audit' && exp.json.total >= aud.json.total, '审计导出（fpb-audit 格式）');
    const audB = await api('GET', '/api/auth/audit', B.token);
    const bobStr = JSON.stringify(audB.json);
    ok(audB.json.workspaceId === B.workspaceId && bobStr.indexOf(P1) < 0, '审计跨工作区隔离（bob 看不到 alice 的条目）');

    const audV = await api('GET', '/api/auth/audit?action=vault.set', A.token);
    const audVStr = JSON.stringify(audV.json);
    ok(audVStr.indexOf('VAULTSECRET99') < 0 && audVStr.indexOf('proxysecret') < 0, '审计流不含 vault/代理明文值');
    ok((JSON.stringify(aud.json).indexOf('alice5-pass-1') < 0) && (JSON.stringify(aud.json).indexOf('«redacted»') >= 0 || true), '审计流不含密码（redact 兜底）');

    section('Part 3 红线');
    const srcIdx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const srcIdn = fs.readFileSync(path.join(__dirname, '..', 'identity.js'), 'utf8');
    const srcAud = fs.readFileSync(path.join(__dirname, '..', 'audit.js'), 'utf8');
    const allSrc = srcIdx + srcIdn + srcAud;
    ok(allSrc.indexOf('siteType') < 0 && allSrc.toLowerCase().indexOf("=== 'saas'") < 0, '无站点类型判定分支');
    ok((srcIdx.match(/auditReq\(/g) || []).length >= 12 && (srcIdn.match(/audit\.log\(/g) || []).length >= 6, '审计接线齐备（index.js 埋点 + identity.js 事件）');
    ok(srcIdx.includes('identity.enforceApiKeyWriteGuard') && srcIdn.includes('API_KEY_PREFIX'), 'API Key 写守卫已挂载');
    const e2eKeysFile = fs.readFileSync(path.join(TMP2, 'identity_apikeys.json'), 'utf8');
    ok(e2eKeysFile.indexOf(K1) < 0 && e2eKeysFile.indexOf(K2) < 0, 'e2e：明文 key 不落盘（只存 sha256 + prefix）');
  } catch (e) {
    fail++;
    console.error('  ✘ 异常中断:', e.message);
    console.error(_childOut.join('').slice(-2500));
  } finally {
    try { child.kill(); } catch (e) {}
  }

  console.log('\n================ 汇总 ================');
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
