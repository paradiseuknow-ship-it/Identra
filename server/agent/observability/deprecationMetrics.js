'use strict';
// deprecationMetrics（C44）：遗留端点（RFC 8594 Deprecation 标记，C36）命中计数。
// 目的：legacy 端点保留兼容，但需要可观测的"还在被谁调用"信号——
//   当某路由命中数长期为 0 时即可安全下线；命中上升则是迁移未完成的告警。
// 数据源：markDeprecated() 每次命中调用 hit()；持久化到 store 集合 deprecationHits。

const store = require('../store');

const COLLECTION = 'deprecationHits';

// 记录一次命中（route 为唯一键）
function hit(route, { user, successor } = {}) {
  if (!route) return null;
  const rows = store.read(COLLECTION, []);
  const now = Date.now();
  const existing = rows.find((r) => r.route === route);
  if (existing) {
    existing.count += 1;
    existing.lastAt = now;
    existing.lastUser = user || existing.lastUser || null;
    if (successor) existing.successor = successor;
    store.write(COLLECTION, rows);
    return existing;
  }
  const rec = { id: route, route, count: 1, firstAt: now, lastAt: now, lastUser: user || null, successor: successor || null };
  rows.push(rec);
  store.write(COLLECTION, rows);
  return rec;
}

// Dashboard 快照：命中数降序（0 命中的已登记路由也保留——下线决策依据）
function snapshot() {
  const rows = store.read(COLLECTION, []);
  const routes = rows
    .slice()
    .sort((a, b) => b.count - a.count || (b.lastAt || 0) - (a.lastAt || 0))
    .map((r) => ({ route: r.route, count: r.count, firstAt: r.firstAt, lastAt: r.lastAt, lastUser: r.lastUser || null, successor: r.successor || null }));
  return { total: routes.reduce((s, r) => s + r.count, 0), routes };
}

// 测试辅助：清空集合
function resetForTests() { store.write(COLLECTION, []); }

module.exports = { hit, snapshot, resetForTests, COLLECTION };
