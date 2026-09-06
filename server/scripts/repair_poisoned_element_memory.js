'use strict';

// 投毒记忆修复（Phase 9 P6，STEP 5 最小修复的数据层）：
//
// smoke5 rw.094 铁证：elementMemory 中语义「加购按钮」的记忆记录 pattern 为
// 「搜索」按钮（16 胜 0 败，confidence=1）——历史宽松验证时代（expectedBusinessState
// 双死、验证回退 action_success）把错误解析记为成功。该类记录跨运行把 resolveSelector
// 引向错误元素。共 3 条可证明投毒记录（购物车语义 + pattern 全部不含「购物车」）。
//
// 本脚本只做**数据修复**：将命中判据的记录 status → DEPRECATED（不删除，可审计）。
// 防复发由 runtime.js P6 失败反馈（验证失败 → recordFailure）承担。
//
// 用法：
//   node server/scripts/repair_poisoned_element_memory.js            # dry-run，只打印
//   node server/scripts/repair_poisoned_element_memory.js --apply    # 实际写入
// 隔离：支持 FPB_DATA_DIR（测试用临时目录）。
// 纪律：不触碰冻结池/fixture/benchmark 产物；elementMemory 是运行时学习数据。

const store = require('../agent/store');

// 纯判据：购物车语义记录但其全部 pattern 文本均不含「购物车」→ 语义与记忆内容矛盾（投毒）。
function findPoisoned(records) {
  return (Array.isArray(records) ? records : []).filter((r) => {
    if (!r || r.site !== '127.0.0.1') return false;
    if (r.status !== 'ACTIVE') return false;
    if (!/加购|购物车/.test(String(r.semantic || ''))) return false;
    const pats = Array.isArray(r.patterns) ? r.patterns : [];
    if (!pats.length) return false;
    return !pats.some((p) => /购物车/.test(String((p && p.text) || '')));
  });
}

function apply(records, poisoned) {
  const ids = new Set(poisoned.map((r) => r.id));
  let changed = 0;
  for (const r of records) {
    if (ids.has(r.id) && r.status === 'ACTIVE') {
      r.status = 'DEPRECATED';
      r.deprecatedReason = 'P6_DATA_REPAIR: semantic 与全部 pattern 矛盾（宽松验证时代假成功积累），smoke5 rw.094 实证';
      r.updatedAt = Date.now();
      changed++;
    }
  }
  return changed;
}

function main() {
  const doApply = process.argv.includes('--apply');
  const records = store.read('aiElementMemory', []);
  const poisoned = findPoisoned(records);
  console.log('[repair] aiElementMemory 总记录:', records.length, '| 命中投毒判据:', poisoned.length);
  for (const r of poisoned) {
    const pats = (r.patterns || []).map((p) => p.text).join(' ; ');
    console.log('  -', r.id, '| semantic:', r.semantic, '| patterns:', pats, '| confidence:', r.confidence);
  }
  if (!doApply) {
    console.log('[repair] dry-run（未写入）。加 --apply 执行弃用。');
    return;
  }
  const changed = apply(records, poisoned);
  if (changed) store.write('aiElementMemory', records);
  console.log('[repair] 已弃用', changed, '条记录（status=DEPRECATED，可审计不删除）。');
}

if (require.main === module) main();
module.exports = { findPoisoned, apply };
