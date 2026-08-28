'use strict';

// Memory Isolation 测试：验证 Store 读取零副作用 + Evaluation 层只读（Phase 3.6 架构风险防护）。
// 这是 Phase 4 多 Worker 并发前的必要地基。
// 覆盖：
//  Case A：读取不会改变 store 中的状态（before === after）
//  Case B：Evaluation proposal 不污染 Memory（proposal 后 store 仍 ACTIVE）
//  Case C：Store 返回深拷贝隔离（修改副本不影响下次读取）

const store = require('../agent/store');
const elementMemory = require('../agent/intelligence/elementMemory');
const evaluation = require('../agent/intelligence/evaluation');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra != null ? '  [' + extra + ']' : '')); }
}

function clean() {
  store.write('aiElementMemory', store.read('aiElementMemory', []).filter((r) => !(r.id || '').startsWith('iso_mt')));
}

// ============================================================
console.log('\n[Case A] 读取不改变 store 状态');
clean();
{
  const rec = elementMemory.recordSuccess('iso-a.com', 'submit', { text: 'Submit', role: 'button' }, { type: 'ai_success' });
  rec.id = 'iso_mt_a';
  store.upsert('aiElementMemory', rec);
  const before = store.find('aiElementMemory', 'iso_mt_a');

  // 模拟「评估层读取并就地修改副本」的行为
  const readCopy = store.find('aiElementMemory', 'iso_mt_a');
  readCopy.status = 'DEPRECATED';
  readCopy.confidence = 0.99;

  const after = store.find('aiElementMemory', 'iso_mt_a');
  ok(after.status === before.status, '读取+副本修改后，store 状态不变', after.status + ' vs ' + before.status);
  ok(after.confidence === before.confidence, 'store confidence 未被副本污染', after.confidence + ' vs ' + before.confidence);
}

// ============================================================
console.log('\n[Case B] Evaluation proposal 不污染 Memory（仅提案，不改 store）');
clean();
{
  const rec = elementMemory.recordSuccess('iso-b.com', 'continue', { text: 'Continue', role: 'button' }, { type: 'ai_success' });
  rec.id = 'iso_mt_b';
  // 注入低成功率：100 hits / 30 success → 应判 DEPRECATE
  rec.stats = { hits: 100, memoryHits: 100, semanticFallback: 0, falsePositive: 70 };
  rec.samples = { success: 30, failed: 70 };
  rec.successRate = 0.3; rec.confidence = 0.3; rec.version = 5;
  store.upsert('aiElementMemory', rec);

  const props = evaluation.memoryEvaluator.proposals('iso-b.com');
  ok(props.some((p) => p.type === 'MEMORY_DEPRECATE' && p.id === 'iso_mt_b'), '产出 DEPRECATED 提案', JSON.stringify(props.map(p => p.type)));
  const still = store.find('aiElementMemory', 'iso_mt_b');
  ok(still && still.status === 'ACTIVE', '经验未被直接改状态（仅提案）', still && still.status);
  ok(still.successRate === 0.3, '成功率字段未被提案改动', still && still.successRate);
}

// ============================================================
console.log('\n[Case C] Store 深拷贝隔离：修改副本不影响下次读取');
clean();
{
  const rec = elementMemory.recordSuccess('iso-c.com', 'next', { text: 'Next', role: 'button' }, { type: 'ai_success' });
  rec.id = 'iso_mt_c';
  store.upsert('aiElementMemory', rec);

  const a = store.find('aiElementMemory', 'iso_mt_c');
  a.status = 'XXX';
  a.nested = { deep: 'mutated' };

  const b = store.find('aiElementMemory', 'iso_mt_c');
  ok(b.status !== 'XXX', '副本修改不污染后续读取', b.status);
  ok(!b.nested, '嵌套对象也隔离', JSON.stringify(b.nested));
}

// ============================================================
console.log('\n[Case D] findWhere 同样隔离（批量读取副本不被外层修改污染）');
clean();
{
  const rec = elementMemory.recordSuccess('iso-d.com', 'ok', { text: 'OK', role: 'button' }, { type: 'ai_success' });
  rec.id = 'iso_mt_d';
  store.upsert('aiElementMemory', rec);

  const list = elementMemory.listForSite('iso-d.com');
  list.forEach((r) => { r.status = 'TAMPERED'; });
  const again = elementMemory.listForSite('iso-d.com');
  ok(again[0].status === 'ACTIVE', 'listForSite 副本修改不影响再次读取', again[0] && again[0].status);
}

// ============================================================
console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
