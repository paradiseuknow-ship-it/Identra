'use strict';

// Phase 3.6 Intelligence Evaluation Layer 测试：纯逻辑，不启动 server。
// 覆盖：
//  Case1 Router 预测准确（FLOW_MEMORY confidence 0.9 + success → accurate）
//  Case2 过度自信降权（flow confidence 0.95 连续失败 → warning + 降权 proposal）
//  Case3 LLM 节省（Control planner=1/diagnosis=1 vs Router 0/0 → llmAvoidance=true）
//  Case4 错误经验淘汰（Element 100 hits / 30 success → DEPRECATED proposal）
//  Case5 A/B 实验（control 70% vs treatment 90% → router wins）

const store = require('../agent/store');
const elementMemory = require('../agent/intelligence/elementMemory');
const flowMemory = require('../agent/intelligence/flowMemory');
const evaluation = require('../agent/intelligence/evaluation');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra != null ? '  [' + extra + ']' : '')); }
}

const EVAL = 'aiIntelligenceEvaluations';
function clean() {
  store.write(EVAL, []);
  store.write('aiElementMemory', store.read('aiElementMemory', []).filter((r) => !(r.id || '').startsWith('elem_mt')));
  store.write('aiFlowMemory', store.read('aiFlowMemory', []).filter((r) => !(r.id || '').startsWith('flow_mt')));
  store.write('aiFailureKnowledge', store.read('aiFailureKnowledge', []).filter((r) => !(r.id || '').startsWith('fk_mt')));
}

// ============================================================
console.log('\n[Case1] Router 预测准确：FLOW_MEMORY confidence 0.9 + success → accurate');
clean();
{
  const r = evaluation.collector.collect({
    taskId: 't1', site: 'stripe.com',
    decision: { source: 'FLOW_MEMORY', strategy: 'signup_flow_v2', confidence: 0.9 },
    prediction: { expectedSuccess: 0.9 },
    actual: { success: true, durationMs: 42000, llmCalls: 0, repairCount: 0 },
  });
  ok(r.ok, 'collect 成功', r.error);
  ok(r.record.metrics.accuracy >= 0.5, 'accuracy 高（预测 0.9 + 成功 = good prediction）', r.record.metrics.accuracy);
  const acc = evaluation.routerEvaluator.routerAccuracy(evaluation.routerEvaluator.listEvaluations({}));
  ok(acc.accuracy >= 0.5, 'Router 整体准确率合理', acc.accuracy);
  const bySrc = evaluation.routerEvaluator.accuracyBySource(evaluation.routerEvaluator.listEvaluations({}));
  ok(bySrc.find((x) => x.source === 'FLOW_MEMORY').accuracy === 1, 'FLOW_MEMORY 准确率=1');
}

// ============================================================
console.log('\n[Case2] 过度自信降权：flow confidence 0.95 连续失败 → warning + 降权 proposal');
clean();
{
  // 模拟 6 次 flow 经验预测 0.95 但全部失败（过度自信）
  for (let i = 0; i < 6; i++) {
    evaluation.collector.collect({
      taskId: 't_fail_' + i, site: 'overconf.com',
      decision: { source: 'FLOW_MEMORY', strategy: 'agg_flow', confidence: 0.95 },
      prediction: { expectedSuccess: 0.95 },
      actual: { success: false, durationMs: 30000, llmCalls: 0, repairCount: 2 },
    });
  }
  const records = evaluation.routerEvaluator.listEvaluations({ site: 'overconf.com' });
  const props = evaluation.routerEvaluator.downweightProposals(records, { site: 'overconf.com' });
  ok(props.length > 0, '产出降权 proposal', JSON.stringify(props));
  ok(props[0].type === 'CONFIDENCE_DOWNGRADE', 'proposal 类型为降权', props[0] && props[0].type);
  ok(props[0].suggestedWeightDelta < 0, '建议权重为负（降权）', props[0] && props[0].suggestedWeightDelta);
  // 校准应标记为 OVER_CONFIDENT
  const cal = evaluation.calculator.calibration(records);
  ok(cal.some((c) => c.status === 'OVER_CONFIDENT'), '校准表标记 OVER_CONFIDENT', JSON.stringify(cal));
}

// ============================================================
console.log('\n[Case3] LLM 节省：Control(planner=1/diagnosis=1) vs Router(0/0) → llmAvoidance=true');
clean();
{
  for (let i = 0; i < 5; i++) {
    evaluation.collector.collect({
      taskId: 'c_' + i, site: 'site.com',
      decision: { source: 'PLANNER_LLM', strategy: 'llm_plan', confidence: 0.5 },
      prediction: { expectedSuccess: 0.5 },
      actual: { success: true, durationMs: 60000, llmCalls: 2, repairCount: 1 },
      experiment: { group: 'control', label: 'exp_llm' },
    });
  }
  for (let i = 0; i < 5; i++) {
    evaluation.collector.collect({
      taskId: 't_' + i, site: 'site.com',
      decision: { source: 'FLOW_MEMORY', strategy: 'reuse', confidence: 0.9 },
      prediction: { expectedSuccess: 0.9 },
      actual: { success: true, durationMs: 20000, llmCalls: 0, repairCount: 0 },
      experiment: { group: 'treatment', label: 'exp_llm' },
    });
  }
  const exp = evaluation.experiment.runExperiment('exp_llm');
  ok(exp.llmAvoidance.rate >= 0.8, 'LLM 节省率≥80%', exp.llmAvoidance && exp.llmAvoidance.rate);
  ok(exp.llmAvoidance.treatmentPerTask === 0, 'treatment 平均每次 LLM=0', exp.llmAvoidance && exp.llmAvoidance.treatmentPerTask);
  ok(exp.successRetention.retained, '成功率保持（未因省 LLM 下降）', JSON.stringify(exp.successRetention));
}

// ============================================================
console.log('\n[Case4] 错误经验淘汰：Element 100 hits / 30 success → DEPRECATED proposal');
clean();
{
  // 落一条 element 记忆：successRate 低（30/100），hits=100
  const rec = elementMemory.recordSuccess('deprecate.com', 'continue', { text: 'Continue', role: 'button' }, { type: 'ai_success' });
  // 强行注入低成功率统计（模拟 100 hits / 30 success）
  rec.stats = { hits: 100, memoryHits: 100, semanticFallback: 0, falsePositive: 70 };
  // 让 successRate 落到 0.3：samples 30 成功 / 70 失败
  rec.samples = { success: 30, failed: 70 };
  rec.successRate = 0.3;
  rec.confidence = 0.3;
  rec.version = 5;
  store.upsert('aiElementMemory', rec);

  const memRep = evaluation.memoryEvaluator.evaluateElement('deprecate.com');
  const target = memRep.find((m) => m.id === rec.id);
  ok(target && target.verdict === 'DEPRECATE', '该 element 被判定 DEPRECATE', target && target.verdict);
  const props = evaluation.memoryEvaluator.proposals('deprecate.com');
  ok(props.some((p) => p.type === 'MEMORY_DEPRECATE' && p.id === rec.id), '产出 DEPRECATED proposal（不删除）');
  // 验证未被直接删除/改写
  const still = elementMemory.listForSite('deprecate.com').find((r) => r.id === rec.id);
  ok(still && still.status === 'ACTIVE', '经验未被直接改状态（仅提案）', still && still.status);
}

// ============================================================
console.log('\n[Case5] A/B 实验：control 70% vs treatment 90% → router wins');
clean();
{
  for (let i = 0; i < 10; i++) {
    evaluation.collector.collect({
      taskId: 'cc_' + i, site: 'ab.com',
      decision: { source: 'PLANNER_LLM', strategy: 'llm', confidence: 0.6 },
      prediction: { expectedSuccess: 0.6 },
      actual: { success: i < 7, durationMs: 50000, llmCalls: 2, repairCount: 1 },
      experiment: { group: 'control', label: 'exp_ab' },
    });
  }
  for (let i = 0; i < 10; i++) {
    evaluation.collector.collect({
      taskId: 'tt_' + i, site: 'ab.com',
      decision: { source: 'FLOW_MEMORY', strategy: 'reuse', confidence: 0.9 },
      prediction: { expectedSuccess: 0.9 },
      actual: { success: i < 9, durationMs: 15000, llmCalls: 0, repairCount: 0 },
      experiment: { group: 'treatment', label: 'exp_ab' },
    });
  }
  const exp = evaluation.experiment.runExperiment('exp_ab');
  ok(exp.summary.control.successRate === 0.7, 'control 成功率=70%', exp.summary.control.successRate);
  ok(exp.summary.treatment.successRate === 0.9, 'treatment 成功率=90%', exp.summary.treatment.successRate);
  ok(exp.routerWins, 'Router 胜出（成功率更高且 LLM 更少）', JSON.stringify(exp.summary));
  ok(exp.conclusion.indexOf('优于') >= 0, '结论为 Router 优于 Control', exp.conclusion);
}

// ============================================================
console.log('\n[Report] 健康看板聚合');
clean();
{
  evaluation.collector.collect({
    taskId: 'rp1', site: 'dash.com',
    decision: { source: 'FLOW_MEMORY', strategy: 's', confidence: 0.9 },
    prediction: { expectedSuccess: 0.9 },
    actual: { success: true, durationMs: 20000, llmCalls: 0, repairCount: 0 },
  });
  const rep = evaluation.evaluator.report({});
  ok(typeof rep.routerAccuracy === 'number', 'routerAccuracy 存在', rep.routerAccuracy);
  ok(rep.memoryROI && typeof rep.memoryROI.element === 'number', 'memoryROI.element 存在', JSON.stringify(rep.memoryROI));
  ok(Array.isArray(rep.weakAreas), 'weakAreas 为数组', rep.weakAreas);
}

// ============================================================
console.log('\n结果: 通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail === 0 ? 0 : 1);
