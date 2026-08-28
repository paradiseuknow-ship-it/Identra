'use strict';

// Decision Cache（Phase 3.5）：避免每次 Chat 都重算 Router。
// key = site + objective + region + profileGroup；TTL = 24h。
// 原因：IP 变化 / 网站变化 / Flow 变化，故不宜永久缓存。
// 缓存只存「决策结果」，不存执行状态；命中后 Router 仍仅建议，不绕过 Policy。

const TTL = 24 * 3600 * 1000;

// 内存缓存（单进程；重启即冷）。如需跨进程可改用 jsonStore（aiDecisionCache）。
const mem = new Map();

function key(ctx) {
  const site = ctx.site || '*';
  const obj = (ctx.objective || '').trim().toLowerCase();
  const region = ctx.region || '*';
  const group = ctx.profileIdHint || 'auto';
  return [site, obj, region, group].join('|');
}

function get(k) {
  const e = mem.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > TTL) { mem.delete(k); return null; }
  return e.val;
}

function set(k, val) {
  // 不缓存错误结果
  if (!val || val.error) return;
  mem.set(k, { ts: Date.now(), val });
}

function clear() { mem.clear(); }

function size() { return mem.size; }

module.exports = { key, get, set, clear, size, TTL };
