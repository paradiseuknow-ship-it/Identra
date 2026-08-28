'use strict';

// AI 数据持久层门面（Phase 4.5）。
// 委托给 storage/index.js 的 Store Facade，按 STORE_DRIVER 选择 JsonStore / SqliteStore。
// 业务代码无需改动；切换后端仅依赖环境变量（STORE_DRIVER=json|sqlite），
// 满足「Agent → Store Facade → StoreInterface → {JsonStore|SqliteStore}」的架构边界。

module.exports = require('./storage');
