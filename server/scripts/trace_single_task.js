// =============================================================================
// trace_single_task.js  —  Observation → Verification 单任务 Trace 采集器
//
// 定位：诊断工具（只读 store，不修改任何 runtime / verification / resolver 逻辑）。
// 目的：对单个真实任务，完整记录你定义的 10 个节点，回答
//       "已经发生的业务变化，到底在哪一步丢了"。
//
// 10 个节点（每个 action attempt 一条）：
//   1. Before Observation   动作前的页面状态
//   2. Planner Action       规划出的动作（type/target/verification/expectedBusinessState）
//   3. Resolved Target      解析后的目标（target + matchedBy + credentialRef）
//   4. Dispatch             动作派发结果（status / errorCode）
//   5. Raw Action Result    原始动作结果（DOM 是否变化 / failureType）
//   6. After Observation    动作后的页面状态
//   7. Verification Contract 验证契约（expectedBusinessState）
//   8. Verification Decision 验证决策（code / failureType / confidence / evidence）
//   9. Repair Decision      修复决策（strategy / actions / status）
//  10. Final Business Outcome 任务终态
//
// 关键病理标记：当 error.code === 'VERIFY_FAILED' 且 failureType === 'DOM_CHANGED'
//   → 动作确实造成了页面变化，但验证层未确认业务状态。这正是
//     "DOM_CHANGED 被天然等价成 VERIFY_FAILED" 的证据，也是 P0-4 的核心。
//
// 用法：
//   node server/scripts/trace_single_task.js --list
//   node server/scripts/trace_single_task.js --task <taskId>
//   node server/scripts/trace_single_task.js --category <login|click|submit|longflow> [--pick-lost]
//   node server/scripts/trace_single_task.js --task <taskId> --out trace.json
//   node server/scripts/trace_single_task.js --task <taskId> --store ./data
//
// 默认 store：.benchmark/_final100_store_backup （权威 100-task 数据，零新跑批成本）
// 对接未来实跑：把 --store 指向 ./data 即可（在单次真实任务跑完后）。
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_STORE = path.join(__dirname, '..', '..', '.benchmark', '_final100_store_backup');

// P6（Phase 2 Verification Trace 升级）：复用 VIL 的纯函数聚合器，派生验证证据分（不引入新逻辑）。
const { aggregateEvidence } = require('../agent/verification/verificationIntelligence');

function parseFile(p) {
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8').trim();
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { /* 可能是换行分隔 */ }
  return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}

function loadStore(storePath) {
  const read = (name) => parseFile(path.join(storePath, name + '.json'));
  return {
    tasks: read('aiTasks'),
    steps: read('aiSteps'),
    attempts: read('aiAttempts'),
    events: read('aiEvents'),
    repairs: read('aiRepairAttempts'),
    snapshots: read('aiFailureSnapshots'),
  };
}

function shortText(s, n = 200) {
  if (!s) return null;
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function obsSummary(o) {
  if (!o) return null;
  return {
    url: o.url || null,
    title: o.title || null,
    visibleText: shortText(o.visibleText || o.textSummary, 200),
  };
}

// P6 增强纯函数（只读既有 store 数据，不修改 runtime / verification / resolver 逻辑）。
// 观测血缘：抽取可审计的标识与时间链（防御性处理缺字段）。
function obsLineage(o) {
  if (!o) return null;
  return {
    observationId: o.observationId || null,
    parentObservationId: o.parentObservationId || null,
    source: o.source || null,
    capturedAt: o.capturedAt || null,
    fresh: typeof o.fresh === 'boolean' ? o.fresh : null,
    url: o.url || null,
  };
}

// 观测血缘图：before → after 两点 + 血缘边（parent / source）。
function buildLineageGraph(beforeObs, afterObs) {
  const b = obsLineage(beforeObs);
  const a = obsLineage(afterObs);
  const nodes = [];
  if (b) nodes.push({ role: 'before', ...b });
  if (a) nodes.push({ role: 'after', ...a });
  const edges = [];
  if (a && b && a.parentObservationId) {
    edges.push({ from: b.observationId || 'before', to: a.observationId || 'after', kind: 'parent', label: 'parentObservationId' });
  }
  if (a && a.source) {
    edges.push({ from: a.parentObservationId || 'before', to: a.observationId || 'after', kind: 'source', label: a.source });
  }
  return { nodes, edges };
}

// 证据时间线：把一次 attempt 的关键时点串成可解释时间链。
function buildEvidenceTimeline(att, ctx) {
  const a = att.action || {};
  const err = att.error || {};
  const beforeObs = err.observationBefore || null;
  const afterObs = err.observationAfter || null;
  const tl = [];
  if (beforeObs && beforeObs.capturedAt) tl.push({ t: beforeObs.capturedAt, label: 'before_observation', detail: beforeObs.url || '' });
  if (att.startedAt) tl.push({ t: att.startedAt, label: 'action_start', detail: a.type });
  if (att.finishedAt) tl.push({ t: att.finishedAt, label: 'action_finished', detail: att.status });
  if (afterObs && afterObs.capturedAt) tl.push({ t: afterObs.capturedAt, label: 'after_observation', detail: afterObs.url || '' });
  if (err.failureType) tl.push({ t: att.finishedAt || null, label: 'verification_decision', detail: (err.code || '') + '/' + err.failureType + (err.confidence ? ' conf=' + err.confidence : '') });
  ctx.repairs.filter((r) => r.stepId === att.stepId).forEach((r, i) => {
    if (r.startedAt) tl.push({ t: r.startedAt, label: 'repair_' + i + '_start', detail: r.strategy + ':' + r.status });
  });
  tl.sort((x, y) => (x.t ? new Date(x.t).getTime() : 0) - (y.t ? new Date(y.t).getTime() : 0));
  return tl;
}

// 对单个 attempt 重建 10 节点
function attemptTrace(att, ctx) {
  const a = att.action || {};
  const err = att.error || {};
  const ebs = a.expectedBusinessState || null;
  const beforeObs = err.observationBefore || null;
  const afterObs = err.observationAfter || null;

  const repairs = ctx.repairs
    .filter((r) => r.stepId === att.stepId)
    .map((r) => ({
      strategy: r.strategy,
      strategyType: r.strategyType,
      status: r.status,
      reason: r.reason || r.message || null,
      actions: (r.actions || []).map((ac) => ({ tool: ac.tool, ok: ac.ok })),
    }));

  // P6：验证证据聚合（复用 VIL aggregateEvidence，纯函数，不引入新判定逻辑）
  const verificationEvidence = (beforeObs || afterObs) ? aggregateEvidence(beforeObs, afterObs, null) : null;
  const evidenceTimeline = buildEvidenceTimeline(att, ctx);
  const observationLineage = buildLineageGraph(beforeObs, afterObs);

  // verification decision：优先 attempt.error，其次 aiEvents 中该 step 的 verification 事件
  const vEvents = ctx.events
    .filter((e) => e.stepId === att.stepId && /verif/i.test(e.type || ''))
    .map((e) => ({ type: e.type, payload: e.payload || {} }));

  const lost = (err.code === 'VERIFY_FAILED' && err.failureType === 'DOM_CHANGED');

  return {
    stepId: att.stepId,
    attemptId: att.id,
    '1_beforeObservation': obsSummary(beforeObs),
    '2_plannerAction': {
      type: a.type,
      target: a.target || null,
      reason: a.reason || null,
      expectedState: ebs ? ebs.stateType : null,
      verification: a.verification || null,
    },
    '3_resolvedTarget': {
      target: a.target || null,
      matchedBy: att.matchedBy || '(n/a)',
      credentialRef: a.credentialRef || null,
    },
    '4_dispatch': {
      status: att.status,
      errorCode: err.code || null,
      errorMessage: shortText(err.message, 160),
    },
    '5_rawActionResult': {
      failureType: err.failureType || null,
      domChanged: err.failureType === 'DOM_CHANGED' ? true : (err.evidence ? /DOM|domChanged/.test(err.evidence.join(' ')) : null),
    },
    '6_afterObservation': obsSummary(afterObs),
    '7_verificationContract': ebs || a.verification || null,
    '8_verificationDecision': {
      code: err.code || null,
      failureType: err.failureType || null,
      confidence: err.confidence || null,
      evidenceScore: verificationEvidence ? verificationEvidence.evidenceScore : null,
      evidence: err.evidence || null,
      vEvents,
    },
    '9_repairDecision': repairs,
    '10_finalOutcome': ctx.task.status,
    evidenceTimeline,
    observationLineage,
    verificationEvidence,
    LOST_BUSINESS_CHANGE: lost,
  };
}

function buildTrace(taskId, store) {
  const task = store.tasks.find((t) => t.id === taskId);
  if (!task) return null;
  const ctx = {
    task,
    repairs: store.repairs.filter((r) => r.taskId === taskId),
    events: store.events.filter((e) => e.taskId === taskId),
  };
  const attempts = store.attempts
    .filter((a) => a.stepId && (a.stepId.startsWith(taskId + '_step') || (task.steps || []).some((s) => s.id === a.stepId)))
    .sort((x, y) => (x.startedAt || 0) - (y.startedAt || 0));

  return {
    taskId,
    taskStatus: task.status,
    businessSuccess: !!(task.successMetrics && task.successMetrics.isBusinessSuccess),
    error: task.error ? shortText(JSON.stringify(task.error).slice(0, 200)) : null,
    attempts: attempts.map((a) => attemptTrace(a, ctx)),
    summary: {
      attempts: attempts.length,
      lostBusinessChange: attempts.filter((a) => {
        const e = a.error || {};
        return e.code === 'VERIFY_FAILED' && e.failureType === 'DOM_CHANGED';
      }).length,
    },
  };
}

function printTrace(trace) {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('TASK ' + trace.taskId + '   status=' + trace.taskStatus + '   businessSuccess=' + trace.businessSuccess);
  console.log('attempts=' + trace.summary.attempts + '   LOST_BUSINESS_CHANGE(VERIFY_FAILED+DOM_CHANGED)=' + trace.summary.lostBusinessChange);
  console.log('══════════════════════════════════════════════════════════════');
  for (const att of trace.attempts) {
    const a = att['2_plannerAction'];
    const d = att['4_dispatch'];
    const flag = att.LOST_BUSINESS_CHANGE ? '  ⚠️ DOM_CHANGED→VERIFY_FAILED (业务变化在验证层丢失)' : '';
    console.log(`\n[${a.type}] step=${att.stepId}`);
    console.log(`  target      : ${JSON.stringify(a.target)}  matchedBy=${att['3_resolvedTarget'].matchedBy}  credRef=${att['3_resolvedTarget'].credentialRef || '-'}`);
    console.log(`  dispatch    : ${d.status} ${d.errorCode || ''}${flag}`);
    if (att['1_beforeObservation']) console.log(`  beforeObs   : ${att['1_beforeObservation'].url} | ${shortText(att['1_beforeObservation'].visibleText, 80)}`);
    if (att['6_afterObservation']) console.log(`  afterObs    : ${att['6_afterObservation'].url} | ${shortText(att['6_afterObservation'].visibleText, 80)}`);
    else if (att['5_rawActionResult'].failureType) console.log(`  rawResult   : failureType=${att['5_rawActionResult'].failureType} domChanged=${att['5_rawActionResult'].domChanged}`);
    console.log(`  verify      : contract=${att['7_verificationContract'] ? (att['7_verificationContract'].stateType || JSON.stringify(att['7_verificationContract'])) : '-'} decision=${att['8_verificationDecision'].code}/${att['8_verificationDecision'].failureType} conf=${att['8_verificationDecision'].confidence}`);
    if (att.verificationEvidence) console.log(`  evidenceScore: ${att.verificationEvidence.evidenceScore}  signals=${JSON.stringify(att.verificationEvidence.evidenceSignals)}`);
    if (att['9_repairDecision'].length) {
      console.log(`  repair      : ` + att['9_repairDecision'].map((r) => `${r.strategy}:${r.status}${r.reason ? ' (' + shortText(r.reason, 60) + ')' : ''}`).join(', '));
    }
    if (att.observationLineage && att.observationLineage.nodes.length) {
      console.log(`  lineage     : ` + att.observationLineage.nodes.map((n) => `${n.role}:${n.observationId || n.url || '-'}${n.source ? '(' + n.source + ')' : ''}`).join(' → '));
    }
    if (att.evidenceTimeline && att.evidenceTimeline.length) {
      console.log(`  timeline    : ` + att.evidenceTimeline.map((e) => `${e.label}@${e.t || '?'}`).join(' | '));
    }
  }
  console.log('\n────────────────────────────────────────────────────────────');
}

function attemptsForTask(store, taskId) {
  return store.attempts.filter((a) => a.stepId && a.stepId.startsWith(taskId + '_step'));
}

function listTasks(store) {
  console.log('TASK LIST (status / category / LOST_BUSINESS_CHANGE count):');
  const byCat = {};
  for (const t of store.tasks) {
    const attempts = attemptsForTask(store, t.id);
    const lost = attempts.filter((a) => { const e = a.error || {}; return e.code === 'VERIFY_FAILED' && e.failureType === 'DOM_CHANGED'; }).length;
    const cats = new Set();
    attempts.forEach((a) => {
      const act = a.action || {};
      if (act.credentialRef) cats.add('login');
      if (act.type === 'click') cats.add('click');
      if (act.type === 'submit') cats.add('submit');
    });
    if (new Set(attempts.map((a) => a.stepId)).size >= 5) cats.add('longflow');
    const catStr = [...cats].join(',') || '(none)';
    console.log(`  ${t.id}  ${t.status.padEnd(16)} cats=[${catStr.padEnd(28)}] LOST=${lost}`);
    cats.forEach((c) => { (byCat[c] = byCat[c] || []).push(t.id); });
  }
  console.log('\nBy category (failed-preferred):');
  Object.entries(byCat).forEach(([c, ids]) => console.log(`  ${c}: ${ids.length} tasks`));
}

function pickCategory(store, category, onlyLost) {
  const failed = store.tasks.filter((t) => t.status !== 'SUCCESS');
  const pool = onlyLost ? failed : store.tasks;
  for (const t of pool) {
    const attempts = attemptsForTask(store, t.id);
    const match = attempts.some((a) => {
      const act = a.action || {};
      const e = a.error || {};
      const lost = e.code === 'VERIFY_FAILED' && e.failureType === 'DOM_CHANGED';
      if (category === 'login') return !!act.credentialRef || (act.expectedBusinessState || {}).stateType === 'LOGIN_SUCCESS';
      if (category === 'click') return act.type === 'click';
      if (category === 'submit') return act.type === 'submit';
      if (category === 'longflow') return new Set(attempts.map((a) => a.stepId)).size >= 5;
      return false;
    });
    if (match) {
      if (onlyLost) {
        const hasLost = attempts.some((a) => { const e = a.error || {}; return e.code === 'VERIFY_FAILED' && e.failureType === 'DOM_CHANGED'; });
        if (!hasLost) continue;
      }
      return t.id;
    }
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);
  const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const has = (k) => args.includes(k);
  const storePath = get('--store', DEFAULT_STORE);

  if (!fs.existsSync(storePath)) {
    console.error('store 不存在: ' + storePath);
    process.exit(1);
  }
  const store = loadStore(storePath);

  if (has('--list')) { listTasks(store); return; }

  let taskId = get('--task', null);
  if (!taskId) {
    const cat = get('--category', null);
    if (cat) {
      taskId = pickCategory(store, cat, has('--pick-lost'));
      if (!taskId) { console.error('未找到 category=' + cat + ' 的任务'); process.exit(1); }
      console.log('auto-picked task for category ' + cat + ': ' + taskId + (has('--pick-lost') ? ' (含 LOST_BUSINESS_CHANGE)' : ''));
    }
  }
  if (!taskId) {
    console.error('用法: --task <id> | --category <login|click|submit|longflow> [--pick-lost] | --list');
    process.exit(1);
  }

  const trace = buildTrace(taskId, store);
  if (!trace) { console.error('任务不存在: ' + taskId); process.exit(1); }
  printTrace(trace);
  const out = get('--out', null);
  if (out) { fs.writeFileSync(out, JSON.stringify(trace, null, 2)); console.log('\nJSON trace written to ' + out); }
}

if (require.main === module) main();
module.exports = { loadStore, buildTrace, attemptTrace, obsLineage, buildLineageGraph, buildEvidenceTimeline };
