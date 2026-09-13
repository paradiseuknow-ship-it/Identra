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
  // 归档最老 N 条到 archive 目录（不丢数据的水位治理，JSON 文件驱动专属：
  // 全量重写型存储才需要；SQLite 等页式存储体积不随条数线性膨胀，默认 no-op）。
  archiveOldest(name, count) { return { archived: 0, remaining: this.read(name, []) }; }
  // 按谓词归档（C117）：同为 JSON 文件驱动专属，页式存储默认 no-op。
  // 为什么不能复用 archiveOldest：它按「数组头部 + count」切分（data.slice(0, count)），
  // 对「主文件即工作集」的集合是行为破坏——队列会把仍在 PENDING 的任务移出主文件，
  // 而 dequeue() 只读主文件 ⇒ 任务静默不执行（比无界增长更糟）。
  archiveWhere(name, pred) { return { archived: 0, remaining: this.read(name, []) }; }
  // 从归档目录按 id 取回单条（C117）：支撑「归档不改变可访问性」——被 TTL 归档的会话
  // 再次被访问时须能原位恢复，否则「恢复旧会话」会静默退化成「新建会话」。
  findInArchive(name, id) { return null; }
  // 事件追加（EventStore，仅保留最近 N）
  appendEvent(evt) { throw new Error('not implemented'); }
  // 增量取事件
  eventsSince(lastEventId) { throw new Error('not implemented'); }
}

module.exports = { StoreInterface };
