'use strict';

// Store Interface：AI 数据存储契约。
// 现状 JsonStore（JSON 文件，同步原子写）；未来可替换 SQLiteStore（异步事务）无需改调用方。
// 所有集合操作都走统一接口；禁止业务代码直接操作文件。

class StoreInterface {
  // 读取整个集合（数组）
  read(name, fallback) { throw new Error('not implemented'); }
  // 覆盖写集合
  write(name, data) { throw new Error('not implemented'); }
  // 按 id 查找单条
  find(name, id) { throw new Error('not implemented'); }
  // 按条件过滤
  findWhere(name, pred) { throw new Error('not implemented'); }
  // 追加（不允许重复 id 时用 insert）
  insert(name, obj) { throw new Error('not implemented'); }
  // 按 id 插入或更新
  upsert(name, obj) { throw new Error('not implemented'); }
  // 按 id 删除
  remove(name, id) { throw new Error('not implemented'); }
  // delete 是 remove 的显式别名（契约统一）
  delete(name, id) { return this.remove(name, id); }
  // 按 id 局部更新（仅变更提供的字段，保留其余）
  update(name, id, patch) { throw new Error('not implemented'); }
  // 事务包裹：fn(txStore) 内部操作在单事务内提交；异常回滚
  transaction(fn) { throw new Error('not implemented'); }
  // 只保留最近 N 条
  trimCollection(name, keep) { throw new Error('not implemented'); }
  // 事件追加（EventStore，仅保留最近 N）
  appendEvent(evt) { throw new Error('not implemented'); }
  // 增量取事件
  eventsSince(lastEventId) { throw new Error('not implemented'); }
}

module.exports = { StoreInterface };
