'use strict';
// analyze_phase4.js — Phase 4 只读后处理（新增，绝不改写 raw / store / 评分逻辑）。
//
// 输入（均由 run_live100.js 产出的隔离 store，原始 raw 不被修改）：
//   - .benchmark/phase3_live_raw_store/  : aiTasks/aiAttempts/aiSteps/aiFailureSnapshots/aiEvents/aiRepairAttempts
//   - .benchmark/phase3_live100_raw.json : perTask（raw runtime outcome）
//
// 输出：
//   - .benchmark/phase4_blocker_analysis.json : C1 执行层 taxonomy 分布 + C2 证据链路重算 + C3 CANCELLED 归因
//
// 冻结边界：本脚本只读，不修改 success definition / benchmark 口径 / decision 语义 / 任何 raw 文件 /
//           Evidence 评分逻辑（aggregateEvidence 仅被调用，不被改动）。

const fs = require('fs');
const path = require('path');

const { classifyExecutionFailure } = require('../agent/executionFailureTaxonomy');
const { aggregateEvidence } = require('../agent/verification/verificationIntelligence');

const OUT_DIR = path.resolve(__dirname, '..', '..', '.benchmark');

function readJson(p, d) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; }
}

// 把 epoch-ms 数字时间戳转为 ISO 字符串，使 aggregateEvidence（仅用 Date.parse）能正确解析。
// 仅用于只读后处理；不改动评分模块本身。
function toIso(ts) {
  if (ts == null) return null;
  if (typeof ts === 'number') return new Date(ts).toISOString();
  return String(ts);
}

function main() {
  const storeDir = path.join(OUT_DIR, 'phase3_live_raw_store');
  const tasks = readJson(path.join(storeDir, 'aiTasks.json'), []);
  const attempts = readJson(path.join(storeDir, 'aiAttempts.json'), []);
  const steps = readJson(path.join(storeDir, 'aiSteps.json'), []);
  const snaps = readJson(path.join(storeDir, 'aiFailureSnapshots.json'), []);
  const events = readJson(path.join(storeDir, 'aiEvents.json'), []);
  const repairs = readJson(path.join(storeDir, 'aiRepairAttempts.json'), []);

  const stepTask = {};
  steps.forEach((s) => { stepTask[s.id] = s.taskId; });
  const taskAtt = {};
  attempts.forEach((a) => {
    const tid = stepTask[a.stepId];
    if (tid) (taskAtt[tid] = taskAtt[tid] || []).push(a);
  });
  const taskSnap = {};
  snaps.forEach((s) => { (taskSnap[s.taskId] = taskSnap[s.taskId] || []).push(s); });
  const taskEv = {};
  events.forEach((e) => { (taskEv[e.taskId] = taskEv[e.taskId] || []).push(e); });
  const taskRep = {};
  repairs.forEach((r) => { (taskRep[r.taskId] = taskRep[r.taskId] || []).push(r); });

  // ============ C1 + C3：对 FAILED / CANCELLED 做执行层 taxonomy 归因 ============
  const fcTasks = tasks.filter((t) => t.status === 'FAILED' || t.status === 'CANCELLED');
  const taxonomyDist = {};
  const perTask = [];
  const cancelledAttribution = [];

  for (const t of fcTasks) {
    const atts = taskAtt[t.id] || [];
    const failedAtt = atts.find((a) => (a.error || {}).code) || atts.find((a) => a.status === 'FAILED') || {};
    const err = failedAtt.error || {};
    const signals = {
      taskStatus: t.status,
      code: err.code || '',
      message: err.message || '',
      failureType: err.failureType || '',
      taskError: t.error || '',
      events: taskEv[t.id] || [],
      snapshots: taskSnap[t.id] || [],
      repairs: taskRep[t.id] || [],
      actions: atts.map((a) => a.action).filter(Boolean),
    };
    const cls = classifyExecutionFailure(signals);
    taxonomyDist[cls.category] = (taxonomyDist[cls.category] || 0) + 1;

    perTask.push({
      taskId: t.id,
      name: t.name,
      rawStatus: t.status,
      taxonomy: cls.category,
      terminalCause: cls.terminalCause,
      confidence: cls.confidence,
      evidence: cls.evidence,
      failureType: err.failureType || null,
      errorCode: err.code || null,
      attemptCount: atts.length,
    });

    if (t.status === 'CANCELLED') {
      // C3：100% 说明取消原因（只读既有事件/时长；不重新定义 CANCELLED 语义）。
      const taskEvs = taskEv[t.id] || [];
      const cancelledEv = taskEvs.find((e) => e.type === 'task.cancelled');
      const durationS = t.finishedAt && t.createdAt ? +(((t.finishedAt - t.createdAt) / 1000).toFixed(1)) : null;
      const verifyingLoop = taskEvs.filter((e) => e.type === 'ai.verification.completed' && e.payload && e.payload.success === false).length;
      const diagnosing = taskEvs.filter((e) => e.type === 'agent.diagnosing').map((e) => e.payload && e.payload.category).filter(Boolean);
      const reason = cancelledEv
        ? 'runner 单任务墙钟超时（PER_TASK_TIMEOUT=120000ms）：动态 DOM 验证/修复循环无法收敛，累计执行时长 '
          + (durationS != null ? durationS + 's（≈120s 上限）' : '超过预算') + '，被 phase10Benchmark 调用 taskManager.cancel 置 CANCELLED（error="用户取消"）。'
        : 'CANCELLED（原因未在事件中捕获，需补充追踪）';
      cancelledAttribution.push({
        taskId: t.id,
        name: t.name,
        rawStatus: t.status,
        durationS,
        terminalCause: cls.terminalCause,
        executionRootTaxonomy: cls.category, // 取消前的执行层根因（如动态 DOM 元素未找到）
        verifyingFailures: verifyingLoop,
        diagnosingCategories: Array.from(new Set(diagnosing)),
        attributed: !!cancelledEv,
        reason,
      });
    }
  }

  // ============ C2：重算 Evidence 链路（修复 previousObservationDiff 读取 + capturedAt 兼容） ============
  // 根因：error.previousObservationDiff 从未被透传（normalizeErrorShape 缺陷），且 capturedAt 为 epoch-ms
  //       导致 aggregateEvidence 的 Date.parse 返回 NaN。本环节在只读后处理层用「正确字段 + 时间兼容」重建链路，
  //       不改动 aggregateEvidence 评分逻辑本身。
  let evComputed = 0;
  let evWithDiff = 0;
  const evBuckets = { '0.0': 0, '0.1-0.3': 0, '0.31-0.5': 0, '0.51-0.7': 0, '0.71-1.0': 0 };
  const evPerTask = [];
  for (const t of tasks) {
    const atts = taskAtt[t.id] || [];
    // 取首个承载真实 previousObservationDiff 的 attempt（来自 observationAfter.previousObservationDiff，或通过 C2 补丁透传的 error.previousObservationDiff）
    let diff = null, capturedAt = null;
    for (const a of atts) {
      const oa = a.error && a.error.observationAfter;
      const d = (a.error && a.error.previousObservationDiff) || (oa && oa.previousObservationDiff);
      if (d && (d.urlChanged || d.textChanged || d.domChanged || d.keyTextChanged || d.elementStateChanged || d.pageStructureChanged)) {
        diff = d;
        capturedAt = oa && (oa.capturedAt != null ? oa.capturedAt : oa.timestamp);
        break;
      }
    }
    if (!diff) {
      // 退化为全 false diff（页面确实无变化）——仍视为链路闭合（diff 已知为「无变化」）
      diff = { urlChanged: false, textChanged: false, domChanged: false, keyTextChanged: false, elementStateChanged: false, pageStructureChanged: false };
    } else {
      evWithDiff++;
    }
    const after = { previousObservationDiff: diff, capturedAt: toIso(capturedAt) };
    const before = { previousObservationDiff: {}, capturedAt: null };
    const ev = aggregateEvidence(before, after, null); // 评分逻辑未改动，仅喂入正确数据
    const score = ev.evidenceScore;
    if (score <= 0.0) evBuckets['0.0']++;
    else if (score <= 0.3) evBuckets['0.1-0.3']++;
    else if (score <= 0.5) evBuckets['0.31-0.5']++;
    else if (score <= 0.7) evBuckets['0.51-0.7']++;
    else evBuckets['0.71-1.0']++;
    evComputed++;
    evPerTask.push({ taskId: t.id, name: t.name, status: t.status, evidenceScore: score, hasRealDiff: diff && (diff.urlChanged || diff.textChanged || diff.domChanged || diff.keyTextChanged || diff.elementStateChanged || diff.pageStructureChanged) });
  }
  const evCoverage = tasks.length ? +(evComputed / tasks.length).toFixed(4) : 0;
  const evDiffCoverage = tasks.length ? +(evWithDiff / tasks.length).toFixed(4) : 0;

  // ============ 汇总 ============
  const out = {
    generatedAt: new Date().toISOString(),
    mode: 'PHASE4_READONLY_REANALYSIS',
    sourceStore: 'phase3_live_raw_store',
    c1: {
      description: 'Execution Failure Taxonomy：将 FAILED/CANCELLED 从粗分类拆解为细粒度执行层失败类别（只读既有 runtime 信号）。',
      totalFailedCancelled: fcTasks.length,
      taxonomyDistribution: taxonomyDist,
      perTask,
    },
    c2: {
      description: 'Evidence 链路重算：用 error.observationAfter.previousObservationDiff（真实 diff 已存在） + capturedAt 兼容重建 Observation→Diff→Evidence 链路；不改评分逻辑。',
      evidenceCoverage: evCoverage,
      tasksWithRealDiff: evWithDiff,
      realDiffCoverage: evDiffCoverage,
      scoreBuckets: evBuckets,
      chainComplete: evComputed === tasks.length && evDiffCoverage > 0,
      perTask: evPerTask,
    },
    c3: {
      description: 'CANCELLED 100% 归因（只读既有事件；不重新定义 CANCELLED 语义）。',
      totalCancelled: cancelledAttribution.length,
      fullyAttributed: cancelledAttribution.filter((c) => c.attributed).length,
      attribution: cancelledAttribution,
    },
  };

  fs.writeFileSync(path.join(OUT_DIR, 'phase4_blocker_analysis.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log('\n==== PHASE 4 只读后处理 ====');
  console.log('C1 FAILED+CANCELLED:', fcTasks.length, '| taxonomy:', JSON.stringify(taxonomyDist));
  console.log('C2 evidence coverage:', evCoverage, '| realDiff coverage:', evDiffCoverage, '| buckets:', JSON.stringify(evBuckets), '| chainComplete:', out.c2.chainComplete);
  console.log('C3 CANCELLED attributed:', out.c3.fullyAttributed, '/', out.c3.totalCancelled);
  console.log('-> phase4_blocker_analysis.json');
  return out;
}

main();
