'use strict';

// STEP 13 — CAP-C1：Profile 批量导入 / 导出（HTTP e2e，子进程生产入口，模式 B）。
// 覆盖：
//   1) 导出：全部（可见集合）/ 按 ids / 剥离 fingerprint 缓存与归属字段 / 保留 seed
//   2) 导出授权：跨工作区 id → 整体 403（fail-closed）；不存在 → 404；匿名 → 401
//   3) 导入：新 id + 重新盖章（workspaceId/createdBy=导入方）+ seed 保留（指纹连续性）
//      + 名称冲突去重（不静默覆盖）+ 逐条 fail-open 结构（errors 数组）
//   4) 权限：MEMBER（仅 profile:use）可导出不可导入（profile:manage）
//   5) 校验：空 profiles → 400；上限 200 → 400
//   6) 红线：无 siteType 判定、无硬编码 selector
// 用法：node server/scripts/test_step13_profile_transfer.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT2 = 18794;
const BASE = 'http://127.0.0.1:' + PORT2;

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ FAIL: ' + name + (extra ? ' — ' + extra : '')); }
}
function section(name) { console.log('\n=== ' + name + ' ==='); }

const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c1-e2e-'));
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: path.join(__dirname, '..', '..'),
  env: { ...process.env, PORT: String(PORT2), FPB_BIND: '127.0.0.1', FPB_API_TOKEN: 'c1-machine-token', FPB_DATA_DIR: TMP2 },
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

(async () => {
  section('生产 server 启动');
  const ready = await waitReady();
  ok(ready, '生产 server 子进程启动成功（模式 B）');
  if (!ready) {
    console.error('--- 子进程输出 ---\n' + _childOut.join('').slice(-3000));
    finish(); return;
  }

  // 注册登录
  for (const [u, p] of [['alice4', 'alice4-pass-1'], ['bob4', 'bob4-pass-12'], ['charlie4', 'charlie4-pass']]) {
    await api('POST', '/api/auth/register', null, { username: u, password: p });
  }
  const login = async (u, p) => (await api('POST', '/api/auth/login', null, { username: u, password: p })).json;
  const A = await login('alice4', 'alice4-pass-1'); // alice：建 3 个 profile
  const B = await login('bob4', 'bob4-pass-12');    // bob：独立工作区（迁移目标）
  const C = await login('charlie4', 'charlie4-pass'); // charlie：稍后成为 bob 工作区 MEMBER

  section('1) 准备：alice 建 3 个 profile（含固定 seed 与 inline 代理）');
  const mk = await api('POST', '/api/profiles', A.token, { name: '店铺A', os: 'Windows', browser: 'Chrome' });
  const mk2 = await api('POST', '/api/profiles', A.token, { name: '店铺B', seed: 'seed_fixed_123', proxyMode: 'inline', proxyInline: { host: '1.2.3.4', port: 8080, username: 'u1', password: 'pw1' } });
  const mk3 = await api('POST', '/api/profiles', A.token, { name: '店铺C', tags: ['vip'] });
  ok(mk.status === 200 && mk2.status === 200 && mk3.status === 200, '3 个 profile 创建成功');
  const ids = [mk.json.id, mk2.json.id, mk3.json.id];

  section('2) 导出：全部 / 按 ids / 结构剥离');
  const exAll = await api('GET', '/api/profiles/export', A.token);
  ok(exAll.status === 200 && exAll.json.format === 'fpb-profiles' && exAll.json.version === 1, '导出格式 fpb-profiles v1');
  ok(exAll.json.count === 3 && Array.isArray(exAll.json.profiles) && exAll.json.profiles.length === 3, '无 ids → 导出可见全部（3 条）');
  const itemB = exAll.json.profiles.find((x) => x.name === '店铺B');
  ok(!('fingerprint' in itemB), '剥离指纹缓存（导入按 seed 重算）');
  ok(!('workspaceId' in itemB) && !('createdBy' in itemB) && !('updatedBy' in itemB), '剥离归属字段（导入方重新盖章）');
  ok(itemB.seed === 'seed_fixed_123', 'seed 保留（指纹连续性）');
  ok(itemB.proxyInline && itemB.proxyInline.host === '1.2.3.4', 'inline 代理配置随文件迁移（用户自有数据）');
  const exIds = await api('GET', '/api/profiles/export?ids=' + ids[0] + ',' + ids[2], A.token);
  ok(exIds.status === 200 && exIds.json.count === 2, '按 ids → 只导出指定 2 条');

  section('3) 导出授权：fail-closed');
  const anyOther = await api('GET', '/api/profiles/export', B.token); // bob 工作区无 profile
  ok(anyOther.status === 200 && anyOther.json.count === 0, '其他工作区导出全部 → 空集 200');
  ok((await api('GET', '/api/profiles/export?ids=' + ids[0], B.token)).status === 403, '跨工作区 id → 403（整体拒绝）');
  ok((await api('GET', '/api/profiles/export?ids=p_nope', A.token)).status === 404, '不存在的 id → 404');
  ok((await api('GET', '/api/profiles/export')).status === 401, '匿名导出 → 401');

  section('4) 跨工作区迁移导入：新 id / 重新盖章 / seed 保留');
  const imp1 = await api('POST', '/api/profiles/import', B.token, { profiles: exAll.json.profiles });
  ok(imp1.status === 200 && imp1.json.importedCount === 3 && imp1.json.errors.length === 0, 'bob 导入 alice 的 3 条 → 全部成功');
  const bobList = (await api('GET', '/api/profiles', B.token)).json;
  ok(bobList.length === 3, 'bob 列表出现 3 条（alice 仍 3 条，无串扰）');
  ok(imp1.json.imported.every((x) => !ids.includes(x.id) && x.sourceId), '新 id（不与源冲突）+ sourceId 可追溯');
  ok(bobList.every((p) => p.workspaceId === B.workspaceId && p.createdBy === B.user.id), '重新盖章：workspaceId/createdBy = 导入方');
  const bobB = bobList.find((p) => p.seed === 'seed_fixed_123');
  ok(!!bobB && bobB.name === '店铺B', 'seed 连续性迁移成功（同名不冲突时保持原名）');
  ok(!!bobB && typeof bobB.fingerprint === 'object' && bobB.fingerprint !== null, '导入后指纹按 seed 重算（非空缓存）');
  // alice 侧归属未被导入影响
  const aliceList = (await api('GET', '/api/profiles', A.token)).json;
  ok(aliceList.every((p) => p.workspaceId === A.workspaceId), '源工作区归属不变');

  section('5) 名称冲突去重（不静默覆盖）');
  const imp2 = await api('POST', '/api/profiles/import', B.token, { profiles: exAll.json.profiles });
  ok(imp2.status === 200 && imp2.json.importedCount === 3, '重复导入 → 全部成功（不覆盖既有）');
  const bobList2 = (await api('GET', '/api/profiles', B.token)).json;
  ok(bobList2.length === 6, 'bob 现有 6 条（3 旧 + 3 新）');
  ok(imp2.json.imported.every((x) => / \(导入\)/.test(x.name)), '冲突名称自动加 (导入) 后缀');
  const aliceList2 = (await api('GET', '/api/profiles', A.token)).json;
  ok(aliceList2.length === 3, 'alice 始终 3 条（重名未写回源）');

  section('6) 权限：MEMBER 可导出不可导入');
  ok((await api('POST', '/api/auth/workspaces/' + B.workspaceId + '/members', B.token, { username: 'charlie4', role: 'MEMBER' })).status === 201, 'bob 授 charlie MEMBER');
  const cList = (await api('GET', '/api/profiles/export', C.token)).json;
  ok(cList.status !== 403 && cList.count === 6, 'MEMBER 可导出本工作区（profile:use，6 条）');
  const cImp = await api('POST', '/api/profiles/import', C.token, { profiles: [{ name: 'x', seed: 's1' }] });
  ok(cImp.status === 403, 'MEMBER 导入 → 403（profile:manage 不具备）');
  ok((await api('GET', '/api/profiles', C.token)).json.length === 6, '拒绝后未产生半成品');

  section('7) 校验与上限');
  ok((await api('POST', '/api/profiles/import', B.token, { profiles: [] })).status === 400, '空 profiles → 400');
  ok((await api('POST', '/api/profiles/import', B.token, {})).status === 400, '缺 profiles → 400');
  ok((await api('POST', '/api/profiles/import', B.token, { profiles: new Array(201).fill({ name: 'x' }) })).status === 400, '超上限 201 条 → 400');
  ok((await api('POST', '/api/profiles/import', null, { profiles: [{ name: 'x' }] })).status === 401, '匿名导入 → 401');

  section('8) 逐条 fail-open（坏条目不阻断好条目）');
  const imp3 = await api('POST', '/api/profiles/import', B.token, { profiles: [{ name: '好条目', seed: 'ok_seed_1' }, { name: 12345, seed: { bad: 'object' } }] });
  ok(imp3.status === 200, '含坏条目仍返回 200（逐条处理）');
  ok(imp3.json.importedCount + imp3.json.errors.length === 2, '每条要么 imported 要么 errors（结构完整）');

  finish();
})().catch((e) => {
  console.error('e2e 异常:', e && e.message);
  ok(false, 'e2e 未抛异常', String(e && e.message));
  finish();
});

function finish() {
  try { child.kill(); } catch (e) { /* 已退出 */ }
  setTimeout(() => {
    try { fs.rmSync(TMP2, { recursive: true, force: true }); } catch (e) {}
    section('红线扫描');
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const m = src.match(/\/\/ CAP-C1[\s\S]*?router\.post\('\/profiles\/import'[\s\S]*?\n\}\);/);
    const c1src = m ? m[0] : src;
    ok(!/siteType\s*===/.test(c1src), 'CAP-C1 不引入 siteType 判定');
    ok(!/(querySelector|css\s*[:=]\s*['"]#)/.test(c1src), 'CAP-C1 无硬编码 selector');
    console.log('\n===== STEP 13 结果: ' + pass + ' passed, ' + fail + ' failed =====');
    process.exit(fail ? 1 : 0);
  }, 500);
}
