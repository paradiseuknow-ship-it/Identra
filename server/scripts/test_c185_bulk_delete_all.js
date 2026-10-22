'use strict';

// C185 守护：「全部环境 → 全部删除」。
//
// 需求（用户 2026-10-19）：浏览器环境列表「全部环境」下增加「全部删除」。
// 批量删除是**不可逆面**，本守护钉住的不是「路由里出现过某行字」，而是四类真实行为：
//   ① 确认令牌：body.confirm 必须等于 DELETE_ALL，缺失/近似值一律 400 且**零副作用**；
//   ② 授权 fail-closed：目标集合任一不可见/不可管理 ⇒ 403 且**零副作用**（绝不部分删除）；
//   ③ 顺序：先关闭运行实例 → 再清凭据 → 最后删库；凭据/关闭失败不阻断删库（与单条同口径）；
//   ④ 落盘 O(1)：批量删除只能各调用一次 db.deleteProfiles / vault.deleteManyProfileSecrets
//      （循环单条实现是 O(n²)：n 个环境 = n 次全量重写）。
//
// 运行：node server/scripts/test_c185_bulk_delete_all.js

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// C140 纪律：夹具一律隔离数据根（数据根在模块加载期解析，故必须在首个 require 之前设置）。
const TMP = path.join(os.tmpdir(), 'c185_bulk_delete_' + Date.now());
process.env.FPB_DATA_DIR = TMP;
process.env.FPB_VAULT_FILE = path.join(TMP, 'vault.json');
process.env.FPB_MASTER_KEY = crypto.randomBytes(32).toString('base64');

fs.mkdirSync(TMP, { recursive: true });

const ROOT = path.join(__dirname, '..', '..');
const policy = require(path.join(__dirname, '..', 'profilesBulkDelete.js'));
const db = require(path.join(__dirname, '..', 'db.js'));
const vault = require(path.join(__dirname, '..', 'vault.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  [' + extra + ']' : '')); }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), 'got=' + JSON.stringify(got));
}
function section(t) { console.log('\n' + t); }

// ---------------------------------------------------------------- fakes
const WS = 'ws_1';
const USER = { id: 'u1', currentWorkspaceId: WS };

function makeDeps(opts = {}) {
  const events = [];
  const profiles = opts.profiles || [
    { id: 'p1', workspaceId: WS },
    { id: 'p2', workspaceId: WS },
    { id: 'p3', workspaceId: WS },
  ];
  const running = new Set(opts.running || ['p2']);
  const counts = { db: 0, vault: 0 };
  const deps = {
    events,
    calls: counts,
    db: {
      getProfiles: () => { events.push('getProfiles'); return profiles; },
      deleteProfiles: (ids) => {
        events.push('db');
        counts.db++;
        const set = new Set(ids);
        const kept = profiles.filter((p) => !set.has(p.id)).length;
        return { removed: ids.length, remaining: kept, ids: ids.slice() };
      },
    },
    vault: {
      deleteManyProfileSecrets: (ids) => {
        events.push('vault');
        counts.vault++;
        deps.lastVaultIds = ids.slice();
        if (opts.vaultThrows) throw new Error('vault boom');
        return ids.length;
      },
    },
    browserManager: {
      isRunning: (id) => { events.push('isRunning:' + id); return running.has(id); },
      close: (id) => { events.push('close:' + id); if (opts.closeThrows === id) throw new Error('close boom'); },
    },
    assertCan: opts.assertCan || (() => {}),
    filterByWorkspace: opts.filterByWorkspace || ((list) => list.filter((p) => p.workspaceId === WS)),
  };
  return deps;
}

function run(over = {}, opts = {}) {
  const deps = makeDeps(opts);
  const r = policy.runBulkDelete({
    identityUser: 'identityUser' in over ? over.identityUser : USER,
    body: 'body' in over ? over.body : { confirm: 'DELETE_ALL' },
    db: deps.db, vault: deps.vault, browserManager: deps.browserManager,
    assertCan: deps.assertCan, filterByWorkspace: deps.filterByWorkspace,
  });
  return { r, deps };
}

// ---------------------------------------------------------------- A. 策略层：闸门与零副作用
section('A. 策略层：确认令牌 / 授权 fail-closed / 顺序 / 落盘次数');

{
  const { r, deps } = run({ body: {} });
  eq('A1 缺令牌 → 400', r.status, 400);
  eq('A1 error=CONFIRM_REQUIRED', r.body.error, 'CONFIRM_REQUIRED');
  eq('A1 expected=DELETE_ALL', r.body.expected, 'DELETE_ALL');
  ok('A1 零副作用（未读未删未清）', deps.events.length === 0, deps.events.join(','));
}

{
  const { r, deps } = run({ body: { confirm: 'delete_all' } });
  eq('A2 令牌大小写不符 → 400', r.status, 400);
  ok('A2 零副作用', deps.events.length === 0, deps.events.join(','));
}
{
  const { r } = run({ body: { confirm: 'DELETE_ALL_EXTRA' } });
  eq('A2b 令牌必须严格相等（尾部多余字符也拒）', r.status, 400);
}

{
  const denied = () => { const e = new Error('forbidden'); e.status = 403; throw e; };
  const { r, deps } = run({ assertCan: denied }, { assertCan: denied });
  eq('A3 无 profile:manage → 403', r.status, 403);
  ok('A3 零副作用（鉴权先于一切）', deps.events.length === 0, deps.events.join(','));
}

{
  const unauth = () => { const e = new Error('nope'); e.status = 401; throw e; };
  const { r } = run({ assertCan: unauth }, { assertCan: unauth });
  eq('A4 未登录 → 401 UNAUTHORIZED', [r.status, r.body.error], [401, 'UNAUTHORIZED']);
}

{
  const { r, deps } = run({ body: { confirm: 'DELETE_ALL', ids: ['p1', 'ghost'] } });
  eq('A5 含不可见 id → 403', r.status, 403);
  eq('A5 error=FORBIDDEN_OR_NOT_FOUND', r.body.error, 'FORBIDDEN_OR_NOT_FOUND');
  eq('A5 列出违规 id', r.body.ids, ['ghost']);
  ok('A5 绝不部分删除（零副作用）', deps.events.filter((e) => e === 'db' || e === 'vault').length === 0, deps.events.join(','));
}

{
  const { r, deps } = run({ body: { confirm: 'DELETE_ALL', ids: ['p2'] } }, { profiles: [{ id: 'p1', workspaceId: WS }, { id: 'p2', workspaceId: 'other' }] });
  eq('A5b 跨工作区 id → 403', r.status, 403);
  ok('A5b 零副作用', deps.events.filter((e) => e === 'db').length === 0);
}

{
  const { r, deps } = run();
  eq('A6 全量删除 → 200', r.status, 200);
  eq('A6 deleted=3', r.body.deleted, 3);
  eq('A6 closed=1（仅 p2 在运行）', r.body.closed, 1);
  eq('A6 secrets=3', r.body.secrets, 3);
  const seq = deps.events.filter((e) => e === 'vault' || e === 'db' || e.startsWith('close:'));
  eq('A6 顺序 = close → vault → db', seq, ['close:p2', 'vault', 'db']);
  ok('A6 close 发生在 isRunning 之后', deps.events.indexOf('isRunning:p2') < deps.events.indexOf('close:p2'));
}

{
  const { deps } = run();
  eq('A7 db.deleteProfiles 只调用 1 次（O(1) 落盘）', deps.calls.db, 1);
  eq('A7 vault.deleteManyProfileSecrets 只调用 1 次', deps.calls.vault, 1);
  eq('A7 vault 收到全部目标 id', deps.lastVaultIds, ['p1', 'p2', 'p3']);
}

{
  const { r, deps } = run({}, { profiles: [] });
  eq('A8 空环境 → 200 deleted 0', [r.status, r.body.deleted], [200, 0]);
  eq('A8 空环境零副作用', deps.events.filter((e) => e === 'db' || e === 'vault').length, 0);
  ok('A8 空环境不产生审计', r.audit === null, JSON.stringify(r.audit));
}

{
  const { r } = run();
  ok('A9 审计动作 = profile.bulk_delete', r.audit && r.audit.action === 'profile.bulk_delete', JSON.stringify(r.audit));
  // C189 同步：审计 detail 新增 filesRemoved / deleteFiles（记录是否清盘，属审计要素）。
  // 这里由「整对象全等」改为「逐字段精确断言」——覆盖面不减：原四字段仍要求值完全相等，
  // 新增两字段同样要求精确值；只是不再因新增审计字段而误红。
  eq('A9 审计 detail.count/closed/secrets/scope',
    r.audit && { count: r.audit.detail.count, closed: r.audit.detail.closed, secrets: r.audit.detail.secrets, scope: r.audit.detail.scope },
    { count: 3, closed: 1, secrets: 3, scope: 'all' });
  eq('A9 审计 detail 记录清盘口径（缺省不清盘）',
    r.audit && { deleteFiles: r.audit.detail.deleteFiles, filesRemoved: r.audit.detail.filesRemoved },
    { deleteFiles: false, filesRemoved: 0 });
}

{
  const { r } = run({ body: { confirm: 'DELETE_ALL', ids: ['p1', 'p2'] } });
  eq('A9b 显式 ids 的 scope=ids', r.audit && r.audit.detail.scope, 'ids');
  eq('A9b 显式 ids 只删这两个', r.body.deleted, 2);
}

{
  const { r, deps } = run({}, { closeThrows: 'p2' });
  eq('A10 close 抛错仍完成删除', [r.status, r.body.deleted], [200, 3]);
  ok('A10 close 失败被记录（stage=close）', r.body.failed.some((f) => f.stage === 'close' && f.id === 'p2'), JSON.stringify(r.body.failed));
  ok('A10 close 失败不阻断 db', deps.events.includes('db'));
}

{
  const { r, deps } = run({}, { vaultThrows: true });
  eq('A11 vault 抛错仍完成删除', [r.status, r.body.deleted], [200, 3]);
  ok('A11 vault 失败被记录（stage=vault）', r.body.failed.some((f) => f.stage === 'vault'), JSON.stringify(r.body.failed));
  ok('A11 vault 失败不阻断 db', deps.events.includes('db'));
}

// ---------------------------------------------------------------- B. 真实原语
section('B. 真实原语：db.deleteProfiles / vault.deleteManyProfileSecrets');

{
  db.saveProfiles([
    { id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }, { id: 'p3', name: 'C' },
  ]);
  const r1 = db.deleteProfiles(['p1', 'p3']);
  eq('B1 removed=2', r1.removed, 2);
  eq('B1 remaining=1', r1.remaining, 1);
  eq('B1 返回被删 id', r1.ids.slice().sort(), ['p1', 'p3']);
  eq('B1 落盘后只剩 p2', db.getProfiles().map((p) => p.id), ['p2']);
  const r2 = db.deleteProfiles(['ghost']);
  eq('B2 不存在的 id → removed=0', r2.removed, 0);
  eq('B2 未误删已有记录', db.getProfiles().map((p) => p.id), ['p2']);
  eq('B3 空输入 no-op', db.deleteProfiles([]).removed, 0);
}

{
  vault.setProfileSecrets('p1', { email: 'a@x.com', password: 'pw1' });
  vault.setProfileSecrets('p2', { email: 'b@x.com', password: 'pw2' });
  vault.setProfileSecrets('keep', { email: 'k@x.com', password: 'pw3' });
  const n = vault.deleteManyProfileSecrets(['p1', 'p2', 'absent']);
  eq('B4 只删命中条目（absent 不计）', n, 2);
  ok('B4 p1 已清', !vault.getProfileSecrets('p1'));
  ok('B4 p2 已清', !vault.getProfileSecrets('p2'));
  ok('B5 未选中的条目必须保留（绝不整表清空）', !!vault.getProfileSecrets('keep'));
  eq('B6 空输入 no-op', vault.deleteManyProfileSecrets([]), 0);
  ok('B6 空输入后 keep 仍在', !!vault.getProfileSecrets('keep'));
}

// ---------------------------------------------------------------- C. 接线（防策略被旁路另写一份）
section('C. 接线：路由只转发、前端闸门在位');

const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'api.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'App.jsx'), 'utf8');

ok('C1 DELETE /profiles 委托 profilesBulkDelete.runBulkDelete',
  /router\.delete\('\/profiles',\s*\(req,\s*res\)\s*=>\s*\{[\s\S]{0,600}profilesBulkDelete\.runBulkDelete\(/.test(indexSrc));
ok('C2 只存在一个 DELETE /profiles 定义（无重复注册）',
  (indexSrc.match(/router\.delete\('\/profiles',/g) || []).length === 1);
ok('C3 路由层不再自行实现删除序列（无双份实现）',
  !/router\.delete\('\/profiles',[\s\S]{0,900}db\.deleteProfiles\(/.test(indexSrc));
ok('C4 api.js 映射 DELETE /profiles', /deleteAllProfiles:\s*\(b\)\s*=>\s*req\('DELETE',\s*'\/profiles',\s*b\)/.test(apiSrc));
ok('C5 App 定义确认词常量', /const PURGE_CONFIRM_WORD = '全部删除'/.test(appSrc));
// C189 同步：调用点新增 deleteFiles 参数，故正则由「整串字面量」放宽为「两要素必须存在且顺序不限」。
// 覆盖面不减：all:true 与 confirm:'DELETE_ALL' 仍是硬性要求（缺任一条即红）。
ok('C6 App 调用服务端令牌 DELETE_ALL', /deleteAllProfiles\(\{[^}]*\ball:\s*true\b[^}]*\bconfirm:\s*'DELETE_ALL'[^}]*\}/.test(appSrc));
ok('C6b App 显式传递清盘开关 deleteFiles', /deleteAllProfiles\(\{[^}]*\bdeleteFiles:\s*purgeFiles\b[^}]*\}/.test(appSrc));
ok('C7 确认按钮在未输入确认词时不可点',
  /disabled=\{purging \|\| purgeTyped\.trim\(\) !== PURGE_CONFIRM_WORD\}/.test(appSrc));
// C189 同步：ProfilesTab 形参新增 onPurgeOrphans（残留清理入口），onRemoveAll 仍是必须项。
ok('C8 ProfilesTab 收到 onRemoveAll', /onRemoveAll=\{openPurgeAll\}/.test(appSrc) && /onRemoveAll,\s*onPurgeOrphans,\s*notify\s*\}/.test(appSrc));
ok('C9 「全部删除」按钮仅在存在环境时出现',
  /\{profiles\.length > 0 && \(\s*<button onClick=\{onRemoveAll\}/.test(appSrc));
ok('C10 弹窗展示数量与运行中数量（不盲删）',
  /profiles\.length\}<\/b> 个环境/.test(appSrc) && /runningCount/.test(appSrc));

// ---------------------------------------------------------------- summary
console.log('\n' + '='.repeat(52));
console.log('C185 bulk-delete  pass=' + pass + ' fail=' + fail);
if (fail) { console.log('FAILED'); process.exitCode = 1; } else { console.log('ALL GREEN'); }
