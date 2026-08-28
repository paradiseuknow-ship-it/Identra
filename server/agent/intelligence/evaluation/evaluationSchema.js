'use strict';

// Evaluation Schema：Phase 3.6 Experience Evaluation & Optimization Layer。
// 定义「一次决策结果」的记录结构（落 aiIntelligenceEvaluations）。
//
// 设计原则（与 Phase 3.1~3.5 一致）：
//  - 评估层**只读经验 + 记录结果 + 产出提案**，**绝不直接改写 Memory**；
//  - 所有置信度调整以「Memory Adjustment Proposal」形式输出，由人工 / 周期任务审批后落地，
//    避免一次异常污染经验。
//
// 记录示例：
// {
//   "id": "eval_001",
//   "taskId": "task_xxx",
//   "site": "stripe.com",
//   "decision": { "source": "FLOW_MEMORY", "strategy": "signup_flow_v2", "confidence": 0.91 },
//   "prediction": { "expectedSuccess": 0.91 },
//   "actual": { "success": true, "durationMs": 42000, "llmCalls": 0, "repairCount": 0 },
//   "metrics": { "accuracy": 1, "costSaved": true, "timeSaved": true },
//   "createdAt": 0
// }

const DECISION_SOURCES = ['FLOW_MEMORY', 'PROFILE_MEMORY', 'ELEMENT_MEMORY', 'FAILURE_MEMORY', 'SITE_MEMORY', 'PLANNER_LLM', 'ROUTER_FALLBACK'];

const COLLECTION = 'aiIntelligenceEvaluations';

let _seq = 0;
function uid() {
  _seq += 1;
  return 'eval_' + Date.now().toString(36) + '_' + _seq.toString(36);
}

// 构建一条评估记录（写库前做轻量校验 + 默认填充）。
// input: { taskId, site, decision:{source,strategy,confidence}, prediction:{expectedSuccess},
//          actual:{success,durationMs,llmCalls,repairCount}, metrics? }
function buildRecord(input) {
  input = input || {};
  const decision = input.decision || {};
  const prediction = input.prediction || {};
  const actual = input.actual || {};
  const rec = {
    id: input.id || uid(),
    taskId: input.taskId || null,
    site: input.site || null,
    decision: {
      source: DECISION_SOURCES.includes(decision.source) ? decision.source : 'ROUTER_FALLBACK',
      strategy: decision.strategy || null,
      confidence: typeof decision.confidence === 'number' ? decision.confidence : 0,
    },
    prediction: {
      expectedSuccess: typeof prediction.expectedSuccess === 'number' ? prediction.expectedSuccess : 0,
    },
    actual: {
      success: !!actual.success,
      durationMs: typeof actual.durationMs === 'number' ? actual.durationMs : 0,
      llmCalls: typeof actual.llmCalls === 'number' ? actual.llmCalls : 0,
      repairCount: typeof actual.repairCount === 'number' ? actual.repairCount : 0,
    },
    metrics: input.metrics || {},
    createdAt: Date.now(),
  };
  // accuracy：预测成功率与结果的一致度（成功=1，失败=0；预测越接近结果越准）
  rec.metrics.accuracy = calcAccuracy(rec.prediction.expectedSuccess, rec.actual.success);
  return rec;
}

// 校准精度：预测 p∈[0,1]，实际 success∈{0,1}。
//  - 预测 0.9 + 成功 → accuracy 1（good prediction）
//  - 预测 0.95 + 失败 → accuracy 0（over-confident，应降权）
function calcAccuracy(p, success) {
  p = Math.max(0, Math.min(1, p));
  // 用 |p - actual| 作为误差，accuracy = 1 - error
  const actual = success ? 1 : 0;
  return Math.round((1 - Math.abs(p - actual)) * 1000) / 1000;
}

// 把 confidence 归到 bucket（用于校准表）。
function confidenceBucket(c) {
  c = Math.max(0, Math.min(1, c));
  if (c >= 0.9) return '0.9-1.0';
  if (c >= 0.8) return '0.8-0.9';
  if (c >= 0.7) return '0.7-0.8';
  if (c >= 0.6) return '0.6-0.7';
  if (c >= 0.5) return '0.5-0.6';
  return '<0.5';
}

function validateRecord(rec) {
  const errs = [];
  if (!rec || typeof rec !== 'object') return { ok: false, errors: ['evaluation 必须是对象'] };
  if (!rec.taskId) errs.push('taskId 缺失');
  if (!rec.site) errs.push('site 缺失');
  if (typeof rec.prediction.expectedSuccess !== 'number') errs.push('prediction.expectedSuccess 必须是数字');
  return { ok: errs.length === 0, errors: errs };
}

module.exports = { DECISION_SOURCES, COLLECTION, buildRecord, calcAccuracy, confidenceBucket, validateRecord };
