'use strict';

// Browser Resource Layer 入口（Phase 4.4）。
// Worker ≠ Browser：Worker 是执行实体，Browser/Profile 是可占用资源。
// 本层提供资源的权威状态、互斥闸门（RESOURCE_BUSY）、幂等释放与崩溃恢复。

module.exports = {
  resourceState: require('./resourceState'),
  browserResource: require('./browserResource'),
  browserResourcePool: require('./browserResourcePool'),
  profileBinding: require('./profileBinding'),
  resourceRecovery: require('./resourceRecovery'),
  STATUS: require('./resourceState').STATUS,
};
