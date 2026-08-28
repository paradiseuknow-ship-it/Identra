'use strict';

// Repair Knowledge / Site Memory（简单持久化，暂不用向量检索）。
// 记录：site / taskType / error / strategy / success，为自愈提供历史成功策略优先。

const store = require('./store');

function record({ site, taskType, error, strategy, success, durationMs }) {
  const rec = {
    id: 'kn_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    site: String(site || '').slice(0, 200),
    taskType: taskType || 'unknown',
    error: error || 'UNKNOWN',
    strategy: strategy || 'retry',
    success: !!success,
    durationMs: durationMs || 0,
    timestamp: Date.now(),
  };
  store.insert('aiKnowledge', rec);
  store.trimCollection('aiKnowledge', 2000);
  return rec;
}

// 对某站点 + 错误类型，给出历史成功率最高的策略
function suggest(site, errorType) {
  if (!site) return null;
  const host = safeHost(site);
  const all = store.read('aiKnowledge', []).filter((k) => k.site && safeHost(k.site) === host);
  const scoped = errorType ? all.filter((k) => k.error === errorType) : all;
  const pool = scoped.length ? scoped : all;
  if (!pool.length) return null;
  const stats = {};
  for (const r of pool) {
    stats[r.strategy] = stats[r.strategy] || { ok: 0, total: 0 };
    stats[r.strategy].total += 1;
    if (r.success) stats[r.strategy].ok += 1;
  }
  const best = Object.entries(stats)
    .map(([strategy, s]) => ({ strategy, rate: s.total ? s.ok / s.total : 0, total: s.total }))
    .sort((a, b) => b.rate - a.rate || b.total - a.total)[0];
  return best ? { strategy: best.strategy, successRate: Math.round(best.rate * 100) / 100, samples: best.total } : null;
}

function safeHost(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (e) { return String(url || '').toLowerCase(); }
}

module.exports = { record, suggest };
