'use strict';
// analyze_live100.js — STEP 2 只读后处理（新增，绝不改写 raw）。
//
// 输入（均由 run_live100.js 产出，原始 raw 不被修改）：
//   - .benchmark/phase3_live100_raw.json   : perTask（raw runtime outcome）+ P9.aggregate summary
//   - .benchmark/phase3_live_raw_store/     : 隔离的 aiTasks/aiAttempts/aiSteps/aiFailureSnapshots/aiEvents/aiRepairAttempts/scenarios
//   - .benchmark/phase3_baseline_corrected.json : STEP 1 修正后基线（同口径 analyzeStore）
//
// 输出：
//   - .benchmark/phase3_live100_derived.json : 派生指标（只读计算）
//   - 由调用方生成 PHASE3_LIVE_100TASK_EVALUATION_REPORT.md
//
// 冻结边界：本脚本只读，不修改 success definition / benchmark 口径 / decision 语义 / 任何 raw 文件。

const fs = require('fs');
const path = require('path');

const { analyzeStore, deriveCategory, computeStats } = require('./benchmark_framework');
const { classifyVerificationFailure, RECOVERY_CATEGORIES } = require('../agent/recovery/errorClassifier');
const { aggregateEvidence } = require('../agent/verification/verificationIntelligence');
const successMetrics = require('../agent/successMetrics');

const OUT_DIR = path.resolve(__dirname, '..', '..', '.benchmark');

function readJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } }

function reconstructEvidence(taskId, snapByTask, attemptsByTask) {
  const snaps = snapByTask[taskId] || [];
  const atts = (attemptsByTask[taskId] || []).filter((a) => a.error && a.error.previousObservationDiff);
  if (!snaps.length && !atts.length) return null; // 无观察信号可重建 → 不计算（coverage 外）
  const snap = snaps[0];
  const att = atts[0];
  const diff = (att && att.error && att.error.previousObservationDiff) || {};
  const after = {
    url: (snap && snap.url) || (att && att.error && att.error.url) || null,
    visibleText: (snap && Array.isArray(snap.visibleTexts) ? snap.visibleTexts.join(' ') : '') || (att && att.error && att.error.text) || '',
    previousObservationDiff: diff,
    capturedAt: (snap && snap.timestamp) || (att && att.endedAt) || null,
  };
  const before = {
    url: diff.beforeUrl || null,
    capturedAt: null,
  };
  const ev = aggregateEvidence(before, after, null);
  return { evidenceScore: ev.evidenceScore, evidenceSignals: ev.evidenceSignals, evidenceReasons: ev.evidenceReasons };
}

function main() {
  const raw = readJson(path.join(OUT_DIR, 'phase3_live100_raw.json'), null);
  if (!raw) { console.error('缺少 raw 文件，请先运行 run_live100.js'); process.exit(1); }
  const storeDir = path.join(OUT_DIR, 'phase3_live_raw_store');
  const baseline = readJson(path.join(OUT_DIR, 'phase3_baseline_corrected.json'), null);

  // 1) 复用 analyzeStore（与 baseline 同口径）得到基础记录：status / businessSuccess(权威) / failureType / category
  const storeReport = analyzeStore(storeDir);
  const baseRecords = storeReport.perTask; // [{taskId,status,isBusinessSuccess,failureType,category}]
  const baseById = {};
  baseRecords.forEach((r) => { baseById[r.taskId] = r; });

  // 2) raw runtime outcome（perTask）—— 真实终态，不被任何派生覆盖
  const perTask = raw.perTask || [];
  const rawById = {};
  perTask.forEach((r) => { rawById[r.id] = r; });

  // 3) 自包含关联：perTask 已含 name / credentialRequirement / id(rw.xxx)；store 任务名 = "P9 " + scenario.name
  const nameToRwId = {};
  perTask.forEach((r) => { if (r && r.name) nameToRwId['P9 ' + r.name] = r.id; });
  const storeTaskToRwId = (storeName) => nameToRwId[storeName] || null;
  // analyzeStore 的 baseRecords 不带 name，需从 store aiTasks 取 store 任务名做关联
  const storeTasks = readJson(path.join(storeDir, 'aiTasks.json'), []);
  const storeNameById = {};
  storeTasks.forEach((t) => { storeNameById[t.id] = t.name; });
  const snapsAll = readJson(path.join(storeDir, 'aiFailureSnapshots.json'), []);
  const snapByTask = {};
  snapsAll.forEach((s) => { (snapByTask[s.taskId] = snapByTask[s.taskId] || []).push(s); });
  const attemptsAll = readJson(path.join(storeDir, 'aiAttempts.json'), []);
  const stepsAll = readJson(path.join(storeDir, 'aiSteps.json'), []);
  const stepTask = {};
  stepsAll.forEach((s) => { stepTask[s.id] = s.taskId; });
  const attemptsByTask = {};
  attemptsAll.forEach((a) => {
    const tid = stepTask[a.stepId];
    if (tid) (attemptsByTask[tid] = attemptsByTask[tid] || []).push(a);
  });
  const repairsAll = readJson(path.join(storeDir, 'aiRepairAttempts.json'), []);
  const repairByTask = {};
  repairsAll.forEach((r) => { (repairByTask[r.taskId] = repairByTask[r.taskId] || []).push(r); });

  // 4) 逐任务派生（只读）
  const derived = [];
  let errorClassifierRecognized = 0, errorClassifierTotal = 0;
  let evidenceComputed = 0; const evidenceBuckets = { '0.0': 0, '0.1-0.3': 0, '0.31-0.5': 0, '0.51-0.7': 0, '0.71-1.0': 0 };
  let conflictCount = 0;
  const rawVsDerivedMismatch = [];
  const falseSuccess = [];
  const sensitiveTasks = [];
  let repairTotal = 0, repairOk = 0;

  for (const rec of baseRecords) {
    const tid = rec.taskId;
    const storeName = storeNameById[tid] || rec.name || '';
    const rwId = storeTaskToRwId(storeName) || tid;
    const rawRec = rawById[rwId] || {};
    const rawStatus = rawRec.status || rec.status;
    // raw vs derived 一致性（B3）：derive 的 status 必须 == raw runtime outcome
    if (rawStatus && rec.status && rawStatus !== rec.status) rawVsDerivedMismatch.push({ taskId: tid, raw: rawStatus, derived: rec.status });

    const failureType = rec.failureType || null;
    // ErrorClassifier 覆盖
    let ec = null;
    if (failureType) {
      errorClassifierTotal++;
      const c = classifyVerificationFailure(failureType, {});
      ec = { recognized: c.recognized, category: c.category, confidence: c.confidence, evidence: c.evidence };
      if (c.recognized) errorClassifierRecognized++;
    }
    // Evidence Score（重建自 store 信号，标注 reconstructed）
    const ev = reconstructEvidence(tid, snapByTask, attemptsByTask);
    if (ev) {
      evidenceComputed++;
      const s = ev.evidenceScore;
      if (s <= 0.0) evidenceBuckets['0.0']++;
      else if (s <= 0.3) evidenceBuckets['0.1-0.3']++;
      else if (s <= 0.5) evidenceBuckets['0.31-0.5']++;
      else if (s <= 0.7) evidenceBuckets['0.51-0.7']++;
      else evidenceBuckets['0.71-1.0']++;
    }
    // conflictCount：记录自带 isBusinessSuccess 与权威相悖
    const rawTask = (storeReport.perTask.find((x) => x.taskId === tid));
    // 从 store aiTasks 取 successMetrics（若有）
    const taskObj = (readJson(path.join(storeDir, 'aiTasks.json'), [])).find((t) => t.id === tid);
    if (taskObj && taskObj.successMetrics && typeof taskObj.successMetrics.isBusinessSuccess === 'boolean') {
      const auth = successMetrics.isBusinessSuccess(taskObj);
      if (!!taskObj.successMetrics.isBusinessSuccess !== auth) conflictCount++;
    }
    // Repair
    const repList = repairByTask[tid] || [];
    const rCount = repList.length || rawRec.repairCount || 0;
    const rOk = repList.filter((r) => r.status === 'SUCCESS').length || rawRec.repairSuccess || 0;
    repairTotal += rCount; repairOk += rOk;

    // Sensitive 安全检查（rawRec 已含 credentialRequirement / name）
    const isSensitive = rawRec && (rawRec.credentialRequirement === 'required' || /pay|支付|购买|下单|payment/i.test(rawRec.name || ''));
    if (isSensitive) {
      sensitiveTasks.push({ taskId: rwId || tid, name: rawRec.name || tid, credentialRequirement: rawRec.credentialRequirement, finalStatus: rawStatus, autoSuccess: rawStatus === 'SUCCESS' });
    }
    // false SUCCESS / silent pass
    if (rawStatus === 'SUCCESS') {
      const vTotal = rawRec.verificationTotal || 0;
      const vPass = rawRec.verificationPassed || 0;
      if (vTotal === 0 || vPass === 0) falseSuccess.push({ taskId: tid, name: rawRec.name || tid, verificationTotal: vTotal, verificationPassed: vPass });
    }

    derived.push({
      taskId: tid,
      name: rawRec.name || tid,
      rawStatus,                       // RAW runtime outcome（不被覆盖）
      businessSuccess: successMetrics.isBusinessSuccess({ status: rawStatus }), // 单一权威
      failureType,                    // DERIVED classification（来自 store error.failureType）
      category: rec.category,
      errorClassifier: ec,
      evidenceScore: ev ? ev.evidenceScore : null, // RECONSTRUCTED evidence
      evidenceSignals: ev ? ev.evidenceSignals : null,
      repairCount: rCount,
      repairSuccess: rOk,
      taxonomy: rawRec.taxonomy || null,
      escalationKind: rawRec.escalationKind || null,
      verificationTotal: rawRec.verificationTotal || 0,
      verificationPassed: rawRec.verificationPassed || 0,
    });
  }

  // 5) 聚合
  const stats = computeStats(baseRecords); // byStatus/byFailureType/byCategory/businessSuccess/conflictCount
  const ecCoverage = errorClassifierTotal ? +(errorClassifierRecognized / errorClassifierTotal).toFixed(4) : null;
  const repairSuccessRate = repairTotal ? +(repairOk / repairTotal).toFixed(4) : null;
  const evidenceCoverage = baseRecords.length ? +(evidenceComputed / baseRecords.length).toFixed(4) : null;

  // 6) 与基线对比
  const base = baseline && baseline.stats ? baseline.stats : null;
  let comparison = null;
  if (base) {
    const d = (a, b) => (a == null || b == null ? null : +(a - b).toFixed(4));
    const pct = (a, b) => (b ? (((a - b) / b) * 100).toFixed(1) + '%' : '-');
    const liveHE = (stats.byStatus.HUMAN_ESCALATION || 0);
    const baseHE = (base.byStatus.HUMAN_ESCALATION || 0);
    const liveUNK = (stats.byStatus.UNKNOWN || 0);
    const baseUNK = (base.byStatus.UNKNOWN || 0);
    const liveSTATE = (stats.byFailureType.STATE_UNKNOWN || 0);
    const baseSTATE = (base.byFailureType.STATE_UNKNOWN || 0);
    comparison = {
      businessSuccess: { baseline: base.businessSuccess, live: stats.businessSuccess, delta: d(stats.businessSuccess, base.businessSuccess), deltaPct: pct(stats.businessSuccess, base.businessSuccess) },
      success: { baseline: base.success, live: stats.success, delta: d(stats.success, base.success) },
      humanEscalation: { baseline: baseHE, live: liveHE, reduction: d(baseHE, liveHE), reductionPct: pct(baseHE - liveHE, baseHE) },
      unknown: { baseline: baseUNK, live: liveUNK, reduction: d(baseUNK, liveUNK), reductionPct: pct(baseUNK - liveUNK, baseUNK) },
      stateUnknown: { baseline: baseSTATE, live: liveSTATE, reduction: d(baseSTATE, liveSTATE), reductionPct: pct(baseSTATE - liveSTATE, baseSTATE) },
      asyncPending: { live: (stats.byFailureType.ASYNC_PENDING || 0) },
      byStatusLive: stats.byStatus,
      byStatusBaseline: base.byStatus,
      byFailureTypeLive: stats.byFailureType,
      byFailureTypeBaseline: base.byFailureType,
      byCategoryLive: stats.byCategory,
      byCategoryBaseline: base.byCategory,
    };
  }

  const out = {
    generatedAt: new Date().toISOString(),
    mode: 'LIVE',
    note: '派生指标均为只读后处理；raw runtime outcome 见 phase3_live100_raw.json，未被本脚本修改。',
    stats,
    errorClassifier: { recognized: errorClassifierRecognized, total: errorClassifierTotal, coverage: ecCoverage },
    evidenceScore: { computed: evidenceComputed, coverage: evidenceCoverage, buckets: evidenceBuckets },
    repair: { total: repairTotal, ok: repairOk, successRate: repairSuccessRate },
    conflictCount,
    rawVsDerivedMismatch,
    falseSuccess,
    sensitiveTasks,
    comparison,
    perTask: derived,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'phase3_live100_derived.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log('\n==== LIVE 100-task 派生指标（只读）====');
  console.log('businessSuccess:', stats.businessSuccess, '| success:', stats.success);
  console.log('byStatus:', JSON.stringify(stats.byStatus));
  console.log('byFailureType:', JSON.stringify(stats.byFailureType));
  console.log('ErrorClassifier coverage:', ecCoverage, '(', errorClassifierRecognized, '/', errorClassifierTotal, ')');
  console.log('Evidence coverage:', evidenceCoverage, '| buckets:', JSON.stringify(evidenceBuckets));
  console.log('Repair success:', repairSuccessRate, '(', repairOk, '/', repairTotal, ')');
  console.log('conflictCount:', conflictCount, '| rawVsDerivedMismatch:', rawVsDerivedMismatch.length, '| falseSuccess:', falseSuccess.length, '| sensitiveTasks:', sensitiveTasks.length);
  console.log('derived JSON ->', path.join(OUT_DIR, 'phase3_live100_derived.json'));
  return out;
}

main();
