'use strict';

// Memory Evaluator：Phase 3.6 评估各类经验的「真实有效性」。
// 不删除、不修改 Memory——只输出 Memory Adjustment Proposal（提权 / 淘汰 / 保留），
// 由人工或周期任务审批后落地，避免一次异常污染经验库。
//
// 评估维度：
//  - element：命中率 / 成功率（stats.hits, memoryHits, falsePositive）
//  - flow：成功率（successRate + samples）
//  - failure：修复成功率（successRate）
// 阈值：
//  - 高命中 + 高成功 → 提权（confidence++，proposal）
//  - 低成功（<0.35，且样本≥阈值）→ 淘汰（status=DEPRECATED，保留 version history）

const store = require('../../store');
const elementMemory = require('../elementMemory');
const flowMemory = require('../flowMemory');
const failureKnowledge = require('../failure/failureKnowledge');

// 经验有效性结论
const VERDICT = { PROMOTE: 'PROMOTE', KEEP: 'KEEP', DEPRECATE: 'DEPRECATE', INSUFFICIENT: 'INSUFFICIENT' };

// ---------- Element Memory 有效性 ----------
function evaluateElement(site) {
  const recs = site ? elementMemory.listForSite(site) : elementMemory.listAll();
  const out = [];
  for (const r of recs) {
    const stats = r.stats || {};
    const hits = stats.hits || 0;
    const fp = stats.falsePositive || 0;
    const successRate = r.successRate || 0;
    const verdict = verdictFor(successRate, hits, fp);
    out.push({
      type: 'element', id: r.id, site: r.site, semantic: r.semantic,
      confidence: r.confidence, successRate, hits, falsePositive: fp,
      status: r.status, verdict,
    });
  }
  return out;
}

// ---------- Flow Memory 有效性 ----------
function evaluateFlow(site) {
  const recs = site ? flowMemory.listForSite(site) : store.read(flowMemory.COLLECTION, []);
  const out = [];
  for (const r of recs) {
    const total = (r.samples && (r.samples.success + r.samples.failed)) || 0;
    const successRate = r.successRate || 0;
    const verdict = verdictFor(successRate, total, 0);
    out.push({
      type: 'flow', id: r.id, site: r.site, goal: r.goal,
      confidence: r.confidence, successRate, samples: total, status: r.status, verdict,
    });
  }
  return out;
}

// ---------- Failure Knowledge 有效性 ----------
function evaluateFailure(site) {
  const recs = site ? failureKnowledge.getForSite(site) : failureKnowledge.listAll();
  const out = [];
  for (const r of recs) {
    const successRate = r.successRate || 0;
    const total = (r.samples && (r.samples.success + r.samples.failed)) || 0;
    // failure 经验：高修复成功率才是好经验
    const verdict = verdictFor(successRate, total, 0);
    out.push({
      type: 'failure', id: r.id, site: r.site, category: r.category,
      confidence: r.confidence, successRate, samples: total, status: r.status, verdict,
    });
  }
  return out;
}

// 判定：返回 {verdict, reason}
// minSamples：达到「可下结论」的最小样本（避免小样本误判）
function verdictFor(successRate, samples, falsePositive) {
  const minSamples = 5;
  if (samples < minSamples) return VERDICT.INSUFFICIENT;
  if (successRate >= 0.85 && falsePositive <= samples * 0.1) return VERDICT.PROMOTE;
  if (successRate < 0.35) return VERDICT.DEPRECATE;
  return VERDICT.KEEP;
}

// 全量评估报告（按 site 过滤）。
function evaluateAll(site) {
  return {
    element: evaluateElement(site),
    flow: evaluateFlow(site),
    failure: evaluateFailure(site),
  };
}

// 产出 Memory Adjustment Proposals（由 evaluator 统一收集）。
// 仅输出提案，绝不直接 store.upsert 改 Memory。
function proposals(site) {
  const report = evaluateAll(site);
  const out = [];
  for (const grp of [report.element, report.flow, report.failure]) {
    for (const m of grp) {
      if (m.verdict === 'DEPRECATE' && m.status === 'ACTIVE') {
        out.push({
          type: 'MEMORY_DEPRECATE',
          memoryType: m.type, id: m.id, site: m.site,
          reason: `${m.type} 经验成功率过低（${Math.round(m.successRate * 100)}%，样本 ${m.samples || m.hits}），建议降级为 DEPRECATED（保留 version history 不删除）`,
          suggestedStatus: 'DEPRECATED',
          createdAt: Date.now(),
        });
      } else if (m.verdict === 'PROMOTE' && m.status === 'ACTIVE') {
        out.push({
          type: 'MEMORY_PROMOTE',
          memoryType: m.type, id: m.id, site: m.site,
          reason: `${m.type} 经验高成功率（${Math.round(m.successRate * 100)}%），建议提升置信度权重`,
          suggestedStatus: 'ACTIVE',
          confidenceBoost: 0.05,
          createdAt: Date.now(),
        });
      }
    }
  }
  return out;
}

// ROI 汇总：各类经验「有效比例」（非 DEPRECATE 占比）。
function memoryROI(site) {
  const report = evaluateAll(site);
  const ratio = (arr) => {
    if (!arr.length) return 0; // 无经验记录 → 0（看板显示「尚无有效经验」，而非 null
    const good = arr.filter((m) => m.verdict === 'PROMOTE' || m.verdict === 'KEEP').length;
    return Math.round((good / arr.length) * 1000) / 1000;
  };
  return {
    element: ratio(report.element),
    flow: ratio(report.flow),
    failure: ratio(report.failure),
  };
}

module.exports = { VERDICT, evaluateElement, evaluateFlow, evaluateFailure, evaluateAll, proposals, memoryROI, verdictFor };
