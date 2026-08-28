'use strict';

// Phase 4.5 SQLite Migration 测试。
// 验证 StoreInterface 真正解耦：JsonStore 与 SqliteStore 语义一致，业务层零 SQL，
// 通过环境变量 + Facade 切换，覆盖历史踩坑点（重复占用/幽灵锁/共享引用）。

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const storageDir = path.join(__dirname, '..', 'agent', 'storage');
const { JsonStore, SqliteStore, StoreInterface } = require(storageDir);

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

function tmpSqlite() {
  return path.join(os.tmpdir(), 'p45_sqlite_' + Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.sqlite');
}
function tmpJson() {
  return path.join(os.tmpdir(), 'p45_json_' + Date.now() + '_' + Math.floor(Math.random() * 1e6));
}

console.log('Phase 4.5 SQLite Migration 测试');

// Case1：两后端共享同一 StoreInterface（契约一致）
console.log('Case1 共享 StoreInterface');
{
  ok(new JsonStore(tmpJson()) instanceof StoreInterface, 'JsonStore 实现 StoreInterface');
  ok(new SqliteStore(':memory:') instanceof StoreInterface, 'SqliteStore 实现 StoreInterface');
  const ifaceMethods = ['read', 'write', 'find', 'findWhere', 'insert', 'upsert', 'remove', 'delete', 'update', 'transaction', 'trimCollection', 'appendEvent', 'eventsSince'];
  const jProto = JsonStore.prototype, sProto = SqliteStore.prototype;
  ok(ifaceMethods.every((m) => typeof jProto[m] === 'function' && typeof sProto[m] === 'function'),
    '两后端均实现全部契约方法');
}

// Case2：基础 CRUD 语义一致（find/findWhere/insert/upsert/update/delete）
console.log('Case2 CRUD 语义一致');
function crudSuite(label, makeStore) {
  const s = makeStore();
  s.clear && s.clear();
  s.insert('aiTasks', { id: 't1', name: 'a', status: 'QUEUED' });
  s.insert('aiTasks', { id: 't2', name: 'b', status: 'RUNNING' });
  ok(s.find('aiTasks', 't1').name === 'a', label + ': insert+find');
  ok(s.findWhere('aiTasks', (x) => x.status === 'RUNNING').length === 1, label + ': findWhere');
  // upsert 更新同 id（非新增）
  s.upsert('aiTasks', { id: 't1', name: 'a2', status: 'DONE' });
  ok(s.find('aiTasks', 't1').name === 'a2', label + ': upsert 更新');
  ok(s.read('aiTasks', []).length === 2, label + ': upsert 不新增');
  // update 局部
  const u = s.update('aiTasks', 't2', { status: 'FAILED' });
  ok(u.status === 'FAILED' && u.name === 'b', label + ': update 局部字段');
  ok(s.find('aiTasks', 't2').status === 'FAILED', label + ': update 落库');
  // delete / remove 别名
  s.remove('aiTasks', 't1');
  ok(s.find('aiTasks', 't1') === null, label + ': remove');
  s.delete('aiTasks', 't2');
  ok(s.find('aiTasks', 't2') === null, label + ': delete 别名');
  ok(s.read('aiTasks', []).length === 0, label + ': 清空');
  s.close && s.close();
}
crudSuite('JsonStore', () => new JsonStore(tmpJson()));
crudSuite('SqliteStore', () => new SqliteStore(':memory:'));

// Case3：共享引用隔离（读出来改不动库）
console.log('Case3 共享引用隔离');
function sharedRef(label, makeStore) {
  const s = makeStore();
  s.clear && s.clear();
  s.insert('aiTasks', { id: 't1', tags: ['x'] });
  const a = s.find('aiTasks', 't1');
  a.tags.push('y'); // 就地改副本
  const b = s.find('aiTasks', 't1');
  ok(b.tags.length === 1 && b.tags[0] === 'x', label + ': 读返回深拷贝，就地改不影响存储');
  s.close && s.close();
}
sharedRef('JsonStore', () => new JsonStore(tmpJson()));
sharedRef('SqliteStore', () => new SqliteStore(':memory:'));

// Case4：唯一键真正下沉（insert 重复 id 必须失败）
console.log('Case4 唯一键下沉');
{
  const s = new SqliteStore(':memory:');
  s.insert('aiTasks', { id: 'dup', v: 1 });
  let threw = false;
  try { s.insert('aiTasks', { id: 'dup', v: 2 }); } catch (e) { threw = true; }
  ok(threw, 'SqliteStore insert 重复 id 抛错（唯一键下沉）');
  ok(s.find('aiTasks', 'dup').v === 1, 'SqliteStore 重复 insert 不覆盖');
  // JsonStore 无强制唯一（insert 直接 push），但契约上以 upsert 为准；这里验证 upsert 幂等
  const j = new JsonStore(tmpJson());
  j.clear();
  j.insert('aiTasks', { id: 'u', v: 1 });
  j.upsert('aiTasks', { id: 'u', v: 9 });
  ok(j.read('aiTasks', []).length === 1 && j.find('aiTasks', 'u').v === 9, 'JsonStore upsert 幂等');
  s.close();
}

// Case5：事务化写入（异常回滚）
console.log('Case5 事务回滚');
{
  const s = new SqliteStore(':memory:');
  s.clear();
  s.insert('aiTasks', { id: 'keep', v: 1 });
  let rolled = false;
  try {
    s.transaction(() => {
      s.insert('aiTasks', { id: 'tmp', v: 2 });
      throw new Error('boom');
    });
  } catch (e) { rolled = true; }
  ok(rolled, 'transaction 异常抛出');
  ok(s.find('aiTasks', 'tmp') === null, 'SqliteStore 事务回滚：tmp 不存在');
  ok(s.find('aiTasks', 'keep').v === 1, 'SqliteStore 事务回滚：原数据保留');
  s.close();
}

// Case6：并发写（多轮交替 insert/upsert 不丢数据、不重复）
console.log('Case6 并发写');
{
  const s = new SqliteStore(':memory:');
  s.clear();
  // 同步串行模拟并发：100 次交替 upsert 不同/相同 id
  for (let i = 0; i < 100; i++) {
    s.upsert('aiTasks', { id: 'c' + (i % 10), n: i });
  }
  ok(s.read('aiTasks', []).length === 10, '并发 upsert 后仅 10 个唯一 id（无重复）');
  for (let i = 0; i < 50; i++) s.insert('aiQueue', { id: 'q' + i, p: i });
  ok(s.read('aiQueue', []).length === 50, '批量 insert 无丢失');
  s.close();
}

// Case7：Node 重启恢复（持久化文件重新打开仍可读）
console.log('Case7 重启恢复（文件持久化）');
{
  const file = tmpSqlite();
  const w = new SqliteStore(file);
  w.open(file);
  w.clear();
  w.insert('aiTasks', { id: 't1', status: 'RUNNING' });
  w.insert('aiBrowserResources', { id: 'b1', status: 'BUSY', profileId: 'p1' });
  w.insert('aiProfileBindings', { id: 'p1', ownerTaskId: 't1', status: 'ACTIVE' });
  w.close();
  // 模拟重启：新实例重开同一文件
  const r = new SqliteStore(file);
  r.open(file);
  ok(r.find('aiTasks', 't1').status === 'RUNNING', '重启后 Task 恢复');
  ok(r.find('aiBrowserResources', 'b1').status === 'BUSY', '重启后 Browser Resource 恢复');
  ok(r.find('aiProfileBindings', 'p1').ownerTaskId === 't1', '重启后 Profile 绑定恢复（无幽灵锁）');
  ok(r.listCollections().length >= 3, '重启后可枚举集合');
  r.close();
  fs.unlinkSync(file);
  try { fs.unlinkSync(file + '-wal'); } catch (e) {}
  try { fs.unlinkSync(file + '-shm'); } catch (e) {}
}

// Case8：历史踩坑点——duplicate task / profile binding / execution / stale worker / browser
console.log('Case8 重复占用与幽灵锁隔离');
{
  const s = new SqliteStore(':memory:');
  s.clear();
  // duplicate task id
  s.upsert('aiTasks', { id: 't1', name: 'a' });
  s.upsert('aiTasks', { id: 't1', name: 'b' }); // 覆盖非重复
  ok(s.read('aiTasks', []).length === 1, 'duplicate task id 被 upsert 合并（无重复）');
  // duplicate profile binding：Profile 同一时刻仅 1 个 ACTIVE
  s.upsert('aiProfileBindings', { id: 'p1', ownerTaskId: 't1', status: 'ACTIVE' });
  const before = s.read('aiProfileBindings', []).length;
  s.upsert('aiProfileBindings', { id: 'p1', ownerTaskId: 't2', status: 'ACTIVE' }); // 覆盖（同 profile）
  ok(s.read('aiProfileBindings', []).length === before, 'duplicate profile binding 被 upsert 合并（无重复）');
  // duplicate execution
  s.upsert('aiDispatchExecutions', { id: 'e1', taskId: 't1', status: 'STARTED' });
  s.upsert('aiDispatchExecutions', { id: 'e1', taskId: 't1', status: 'COMPLETED' });
  ok(s.read('aiDispatchExecutions', []).length === 1, 'duplicate execution 被 upsert 合并');
  // stale worker / browser：状态机由上层维护，store 仅持久化；验证可写可读不冲突
  s.upsert('aiWorkers', { id: 'w1', status: 'DEAD' });
  s.upsert('aiBrowserResources', { id: 'b1', status: 'DEAD' });
  ok(s.find('aiWorkers', 'w1').status === 'DEAD' && s.find('aiBrowserResources', 'b1').status === 'DEAD',
    'stale worker/browser 状态可持久化恢复');
  s.close();
}

// Case9：migration 可重复执行无重复
console.log('Case9 Migration 幂等');
{
  const jsonDir = tmpJson();
  fs.mkdirSync(jsonDir, { recursive: true });
  const j = new JsonStore(jsonDir);
  j.clear();
  j.insert('aiTasks', { id: 't1', v: 1 });
  j.insert('aiQueue', { id: 'q1', v: 1 });
  const target = tmpSqlite();
  const migrate = require(path.join(storageDir, 'migrationJsonToSqlite'));
  const r1 = migrate.run({ jsonDir, sqlitePath: target });
  ok(r1.ok && r1.total === 2, '首次 migration 写入 2 条', r1.total);
  const r2 = migrate.run({ jsonDir, sqlitePath: target }); // 重复执行
  ok(r2.ok && r2.total === 2, '重复 migration 仍 2 条（幂等无重复）', r2.total);
  const verify = new SqliteStore(target);
  verify.open(target);
  ok(verify.read('aiTasks', []).length === 1 && verify.read('aiQueue', []).length === 1, 'migration 后数据完整无重复');
  verify.close();
  fs.unlinkSync(target);
  try { fs.unlinkSync(target + '-wal'); } catch (e) {}
  try { fs.unlinkSync(target + '-shm'); } catch (e) {}
  // 清理 jsonDir
  for (const f of fs.readdirSync(jsonDir)) fs.unlinkSync(path.join(jsonDir, f));
  fs.rmdirSync(jsonDir);
}

// Case10：事件存储语义一致（taskId/type/payload 完整，recent/eventsSince 可用）
console.log('Case10 事件存储一致性');
{
  const s = new SqliteStore(':memory:');
  s.clear();
  const e1 = s.appendEvent({ type: 'task.completed', taskId: 't1', payload: { a: 1 } });
  const e2 = s.appendEvent({ type: 'task.failed', taskId: 't1', payload: { b: 2 } });
  ok(s.find('aiEvents', e1.eventId) === null, 'aiEvents 不进 ai_store 集合表（独立事件表）');
  const all = s.read('aiEvents', []);
  ok(all.length === 2 && all[0].taskId === 't1' && all[0].payload.a === 1, 'SqliteStore read(aiEvents) 保留 taskId/payload 完整');
  const since = s.eventsSince(e1.eventId);
  ok(since.length === 1 && since[0].eventId === e2.eventId, 'SqliteStore eventsSince 增量正确');
  s.close();
}

// Case11：Facade 驱动切换（环境因素，验证 STORE_DRIVER 选择逻辑不崩）
console.log('Case11 Store Facade 驱动可用');
{
  // 默认 json
  const facade = require(path.join(storageDir, 'index'));
  ok(typeof facade.read === 'function' && typeof facade.upsert === 'function', 'Facade 暴露统一接口');
  ok(['json', 'sqlite'].indexOf(facade.driver) >= 0, 'Facade 含 driver 标识: ' + facade.driver);
  // 手动构造 sqlite 驱动实例（不依赖全局 env）
  const sq = facade.createSqliteStore(':memory:');
  sq.clear();
  sq.upsert('aiTasks', { id: 'x', v: 1 });
  ok(sq.find('aiTasks', 'x').v === 1, 'Facade.createSqliteStore 可用');
  sq.close();
}

console.log('\nPhase 4.5 结果: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail === 0 ? 0 : 1);
