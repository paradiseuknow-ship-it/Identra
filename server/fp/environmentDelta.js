'use strict';

// Phase 14.4 — Environment Delta（受控实验的归因基座）
//
// 目标（Phase 14 规格 §五）：attempt N vs attempt N+1 精确比较，输出 CHANGED / UNCHANGED / UNKNOWN。
// 核心纪律：「后续真实站点实验必须知道到底改变了什么」——禁止隐式环境变化。
//
// 输出：
// {
//   status: 'CHANGED' | 'UNCHANGED' | 'UNKNOWN',  // 有变化→CHANGED；无变化但有未知→UNKNOWN；否则 UNCHANGED
//   fields: [{ path, before, after, state }],      // 逐字段（UNCHANGED 的字段默认省略，除非 includeUnchanged）
//   changedSections: ['network', ...]              // 变化涉及的顶层 section 汇总
// }

const DEFAULT_EXCLUDE = ['task', 'timestamp', 'snapshotVersion']; // task 标识跨 attempt 必然不同，属元数据非环境

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function leafPaths(obj, prefix = '') {
  const out = [];
  for (const k of Object.keys(obj || {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    const v = obj[k];
    if (isPlainObject(v)) out.push(...leafPaths(v, path));
    else out.push(path);
  }
  return out;
}

function valueAtPath(obj, path) {
  let cur = obj;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

function valuesEqual(a, b) {
  if (a === b) return true;
  if (a === null && b === null) return true;
  // null/undefined 视为等价缺失（快照降级字段不构成「变化」证据，但会以 UNKNOWN 记录）
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function computeEnvironmentDelta(before, after, opts = {}) {
  const exclude = opts.excludeSections || DEFAULT_EXCLUDE;
  const includeUnchanged = opts.includeUnchanged === true;
  const b = before || {};
  const a = after || {};
  const paths = [...new Set([...leafPaths(b), ...leafPaths(a)])].filter(
    (p) => !exclude.some((sec) => p === sec || p.startsWith(sec + '.'))
  );

  const fields = [];
  const nullish = (v) => v === null || v === undefined;
  for (const p of paths) {
    const bv = valueAtPath(b, p);
    const av = valueAtPath(a, p);
    const missing = bv === undefined || av === undefined;
    // 单侧缺失/降级为 null = 观测缺口（UNKNOWN），不武断判变化也不静默
    const observabilityGap = missing || (nullish(bv) !== nullish(av));
    const state = observabilityGap ? 'UNKNOWN' : valuesEqual(bv, av) ? 'UNCHANGED' : 'CHANGED';
    if (state === 'UNCHANGED' && !includeUnchanged) continue;
    fields.push({ path: p, before: nullish(bv) ? null : bv, after: nullish(av) ? null : av, state });
  }

  const changed = fields.filter((f) => f.state === 'CHANGED');
  const unknown = fields.filter((f) => f.state === 'UNKNOWN');
  const status = changed.length ? 'CHANGED' : unknown.length ? 'UNKNOWN' : 'UNCHANGED';
  const changedSections = [...new Set(changed.map((f) => f.path.split('.')[0]))];
  return { status, fields, changedSections, changedCount: changed.length, unknownCount: unknown.length };
}

module.exports = { computeEnvironmentDelta };
