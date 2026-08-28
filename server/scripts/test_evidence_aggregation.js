'use strict';

// P3（Phase 2 Evidence Aggregation）纯函数单测：aggregateEvidence + analyze 附加字段守卫。
// 仅验证「可解释加权」聚合，不触碰 failureType/decision 枚举。

const vil = require('../agent/verification/verificationIntelligence');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; fails.push(msg); console.log('  ✗ FAIL: ' + msg); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

const NOW = Date.now();
const D = (ms) => new Date(NOW + ms).toISOString();

function obs(over) {
  const base = {
    url: 'http://example.com/page',
    visibleText: 'initial',
    previousObservationDiff: {
      urlChanged: false, textChanged: false, domChanged: false,
      keyTextChanged: false, elementStateChanged: false, pageStructureChanged: false,
    },
  };
  if (!over) return base;
  const o = Object.assign({}, base, over);
  if (over.previousObservationDiff) {
    o.previousObservationDiff = Object.assign({}, base.previousObservationDiff, over.previousObservationDiff);
  }
  return o;
}

// Case 1：多个强证据 → 高分
section('Case 1: 多个强证据 → 高分');
{
  const before = obs({ capturedAt: D(-5000) });
  const after = obs({
    url: 'http://example.com/dashboard',
    visibleText: '提交成功',
    capturedAt: D(0),
    previousObservationDiff: {
      urlChanged: true, keyTextChanged: true, elementStateChanged: true,
      pageStructureChanged: true, domChanged: true,
    },
  });
  const r = vil.aggregateEvidence(before, after, null);
  ok(r.evidenceScore >= 0.8, 'evidenceScore 高（多个强证据）= ' + r.evidenceScore);
  ok(r.evidenceSignals.urlChanged === true, 'urlChanged=true');
  ok(r.evidenceSignals.keyTextChanged === true, 'keyTextChanged=true');
  ok(r.evidenceSignals.elementStateChanged === true, 'elementStateChanged=true');
  ok(r.evidenceSignals.pageStructureChanged === true, 'pageStructureChanged=true');
  ok(r.evidenceSignals.freshObservation === true, 'freshObservation=true（after 更新）');
  ok(r.evidenceReasons.length >= 5, 'reasons 列出加分项（' + r.evidenceReasons.length + '）');
}

// Case 2：只有 DOM/结构变化 → 低分
section('Case 2: 只有 DOM/结构变化 → 低分');
{
  const before = obs({ capturedAt: D(-5000) });
  const after = obs({
    // 无 capturedAt → freshObservation=false，避免新鲜度加分抬高分数
    previousObservationDiff: { domChanged: true, pageStructureChanged: true },
  });
  const r = vil.aggregateEvidence(before, after, null);
  ok(r.evidenceScore < 0.3, 'evidenceScore 低（仅结构变化）= ' + r.evidenceScore);
  ok(r.evidenceSignals.pageStructureChanged === true, 'pageStructureChanged=true');
  ok(r.evidenceSignals.urlChanged === false, 'urlChanged=false');
  ok(r.evidenceSignals.keyTextChanged === false, 'keyTextChanged=false');
  ok(r.evidenceSignals.freshObservation === false, 'freshObservation=false（无时间戳）');
}

// Case 3：无变化（非新鲜观察） → 接近 0
section('Case 3: 无变化 → 接近 0');
{
  const before = obs({ capturedAt: D(-5000) });
  const after = obs({}); // 无 capturedAt、无 diff → 既非新鲜也无任何变化信号
  const r = vil.aggregateEvidence(before, after, null);
  ok(r.evidenceScore < 0.01, 'evidenceScore 接近 0 = ' + r.evidenceScore);
  ok(r.evidenceReasons.length === 0, '无加分理由');
}

// Case 4：旧 Observation（after 比 before 还旧） → fresh=false
section('Case 4: 旧 Observation → fresh=false');
{
  const before = obs({ capturedAt: D(0) });
  const after = obs({
    capturedAt: D(-10000), // 比 before 更旧
    visibleText: 'changed text',
    previousObservationDiff: { keyTextChanged: true },
  });
  const r = vil.aggregateEvidence(before, after, null);
  ok(r.evidenceSignals.freshObservation === false, 'freshObservation=false（after 更旧）');
  ok(r.evidenceSignals.keyTextChanged === true, 'keyTextChanged 仍被检测到');
}

// Case 5：verificationWindow 重观察 → verificationWindowObserved=true（+0.05）
section('Case 5: Verification Window 重观察标记');
{
  const before = obs({ capturedAt: D(-5000) });
  const after = obs({ capturedAt: D(0) });
  const r = vil.aggregateEvidence(before, after, { reobserved: true });
  ok(r.evidenceSignals.verificationWindowObserved === true, 'verificationWindowObserved=true');
  ok(r.evidenceScore >= 0.15, 'score 含新鲜 + 窗口加分 = ' + r.evidenceScore);
}

// 集成守卫：analyze 输出附加 verificationEvidence，且不破坏既有 failureType/decision
section('Case 6: analyze 附加 verificationEvidence（不破坏既有字段）');
{
  const before = obs({ capturedAt: D(-5000) });
  const after = obs({ capturedAt: D(0), previousObservationDiff: { domChanged: true } });
  const r = vil.analyze({
    beforeObservation: before, afterObservation: after,
    actionResult: { success: true }, action: { type: 'click' },
  });
  ok(r.failureType === vil.FAILURE_TYPES.DOM_CHANGED, 'failureType 不变 = ' + r.failureType);
  ok(r.decision === vil.DECISIONS.RETRY_VERIFY, 'decision 不变 = ' + r.decision);
  ok(r.verificationEvidence && typeof r.verificationEvidence.evidenceScore === 'number', '附加 verificationEvidence.score');
  ok(r.verificationEvidence.evidenceSignals.freshObservation === true, 'verificationEvidence.freshObservation=true');
  ok(Array.isArray(r.verificationEvidence.evidenceReasons), 'evidenceReasons 为数组');
  ok(r.verificationEvidence.evidenceSignals.observationAge >= 0, 'observationAge 已计算');
}

console.log('\n==== 结果：' + pass + ' passed, ' + fail + ' failed ====');
if (fail) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
