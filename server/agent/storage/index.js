'use strict';

// Store Facade：Agent 层唯一的数据访问入口。
// 根据环境变量 STORE_DRIVER 选择后端：json（默认）| sqlite。
//
// 架构边界（Phase 4.5 硬约束）：
//   Agent / Execution 层  →  store (本 Facade)  →  StoreInterface
//                                              ├── JsonStore
//                                              └── SqliteStore
// 业务层永远只依赖 StoreInterface 契约，零 SQL；未来换 PostgresStore 也只改这里。

const path = require('path');
const { JsonStore } = require('./jsonStore');
const { SqliteStore } = require('./sqliteStore');
const { StoreInterface } = require('./store.interface');
// C116：AI store 根改为由 server/dataRoot.js 的 aiStoreRoot() 单一裁定。
// 此前本文件自持一份解析逻辑，而 agent/stepManager.js、scripts/archiveAiStore.js、
// storage/migrationJsonToSqlite.js 又各复制一份 —— 4 份同义实现（C58 D2「重复定义会
// 各自漂移」）。解析语义逐字不变：FPB_DATA_DIR 优先，否则 <repo>/server/data
//（即 aiStoreRoot() 的默认分支）⇒ 生产路径零行为变化。
const { aiStoreRoot } = require('../../dataRoot');

function resolveDataDir() {
  return aiStoreRoot();
}

function resolveSqlitePath() {
  const env = process.env.STORE_SQLITE_PATH;
  if (env) return env;
  return path.join(resolveDataDir(), 'agent.sqlite');
}

function createBackend() {
  const driver = (process.env.STORE_DRIVER || 'json').toLowerCase();
  if (driver === 'sqlite') {
    const db = new SqliteStore(resolveSqlitePath());
    db.open();
    return { driver: 'sqlite', store: db };
  }
  if (driver !== 'json') {
    throw new Error('未知 STORE_DRIVER: ' + driver + '（仅支持 json|sqlite）');
  }
  return { driver: 'json', store: new JsonStore(resolveDataDir()) };
}

const backend = createBackend();

// 统一导出：业务层通过 require('./storage') 拿到 store 实例。
// 暴露 driver 标识，便于诊断/日志。
module.exports = Object.assign(backend.store, {
  driver: backend.driver,
  backend: backend.store,
  // C116：暴露解析出的 AI store 根，供守护测试断言 FPB_DATA_DIR 隔离解析（C46 先例：
  // browserManager 同样导出 PROFILES_ROOT「供守护测试断言隔离解析」）。
  dataDir: resolveDataDir(),
  // 便于测试/切换：手动构造另一驱动实例（不污染全局）。
  JsonStore,
  SqliteStore,
  StoreInterface,
  createJsonStore: (dir) => new JsonStore(dir),
  createSqliteStore: (p) => { const s = new SqliteStore(p); s.open(p); return s; },
});
