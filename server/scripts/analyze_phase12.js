'use strict';

// Phase12 双口径分析器（B1，2026-09-01）。
//
// 纪律边界：
//   - 只读：绝不修改输入 JSON / 池 / fixture / 任何 runtime 代码。
//   - Nominal Benchmark 视图完全保持历史口径（与 summary 权威字段互为校验）。
//   - Feasible-Task Adjusted View 仅作附加分析视图，绝不覆盖 nominal，
//     且一切 adjusted 数字标记 provisional（B2 逐任务四分类审计后才正式定案）。
//
// 用法：
//   node analyze_phase12.js [--file <path>] [--tag <tag>] [--out <path>]
//   默认选 .benchmark 下最新 phase12_*.json；--tag 匹配 phase12_tag_<tag>_*.json。

const fs = require('fs');
const path = require('path');

const benchDir = path.join(__dirname, '..', '..', '.benchmark');
const mismatchListPath = path.join(__dirname, 'pool_fixture_mismatch_list.json');

// ---------- CLI ----------
const argv = process.argv.slice(2);
function argOf(name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}
const fileArg = argOf('--file');
const tagArg = argOf('--tag');
const outArg = argOf('--out');

// ---------- 输入选择 ----------
function pickInput() {
  if (fileArg) return path.resolve(fileArg);
  const files = fs.readdirSync(benchDir).filter((f) => f.startsWith('phase12_') && f.endsWith('.json') && !f.includes('analysis'));
  if (!files.length) throw new Error('.benchmark 下未找到 phase12_*.json');
  let chosen = null;
  if (tagArg) {
    const hit = files.filter((f) => f.startsWith('phase12_tag_' + tagArg + '_'));
    if (!hit.length) throw new Error('未找到 tag=' + tagArg + ' 的 phase12 产物');
    chosen = hit.sort().slice(-1)[0];
  } else {
    // 按 mtime 最新
    chosen = files.map((f) => ({ f, m: fs.statSync(path.join(benchDir, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0].f;
  }
  return path.join(benchDir, chosen);
}

const inputPath = pickInput();

// ---------- 只读保障：记录输入指纹，结束后校验 ----------
const st0 = fs.statSync(inputPath);
const fp0 = { size: st0.size, mtimeMs: st0.mtimeMs };

const j = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const PT = Array.isArray(j.perTask) ? j.perTask : [];
if (!PT.length) throw new Error('输入产物 perTask 为空');
const S = j.summary || {};

// ---------- 视图一：Nominal Benchmark（历史口径，逐字段保真） ----------
const statusCounts = {};
PT.forEach((t) => { statusCounts[t.status] = (statusCounts[t.status] || 0) + 1; });
const escClassCounts = {};
PT.forEach((t) => { const k = t.escalationClass || (t.status === 'SUCCESS' ? 'SUCCESS' : 'UNKNOWN'); escClassCounts[k] = (escClassCounts[k] || 0) + 1; });

// summary 权威字段透出 + perTask 复算交叉校验（不一致即报错，绝不静默改数）
const recomputed = {
  successRate: Math.round((statusCounts.SUCCESS || 0) / PT.length * 1000) / 1000,
  humanEscalationRate: Math.round((statusCounts.HUMAN_ESCALATION || 0) / PT.length * 1000) / 1000,
  escalationCredibleRate: Math.round((escClassCounts.CREDIBLE_BUSINESS || 0) / PT.length * 1000) / 1000,
  escalationRealRate: Math.round((escClassCounts.REAL || 0) / PT.length * 1000) / 1000,
};
for (const k of Object.keys(recomputed)) {
  if (typeof S[k] === 'number' && Math.abs(S[k] - recomputed[k]) > 0.0005) {
    throw new Error('Nominal 校验失败: summary.' + k + '=' + S[k] + ' 与 perTask 复算 ' + recomputed[k] + ' 不一致（拒绝输出，防止静默漂移）');
  }
}

const nominal = {
  source: path.basename(inputPath),
  totalTasks: PT.length,
  statusCounts,
  escalationClasses: S.escalationClasses || escClassCounts,
  failureTaxonomy: S.failureTaxonomy || null,
  successRate: S.successRate != null ? S.successRate : recomputed.successRate,
  humanEscalationRate: S.humanEscalationRate != null ? S.humanEscalationRate : recomputed.humanEscalationRate,
  escalationCredibleRate: S.escalationCredibleRate != null ? S.escalationCredibleRate : recomputed.escalationCredibleRate,
  escalationRealRate: S.escalationRealRate != null ? S.escalationRealRate : recomputed.escalationRealRate,
  plannerSuccessRate: S.plannerSuccessRate != null ? S.plannerSuccessRate : null,
  executionSuccessRate: S.executionSuccessRate != null ? S.executionSuccessRate : null,
  agentScore: S.agentScore || null,
  caliber: '历史口径原样透出，未做任何修正',
};

// ---------- 视图二：Feasible-Task Adjusted View（仅分析视图，provisional） ----------
const ML = JSON.parse(fs.readFileSync(mismatchListPath, 'utf8'));
const mismatchIds = new Set(ML.mismatches.map((m) => m.id));
const grayIds = new Set(ML.grayZones.map((g) => g.id));
const byId = new Map(PT.map((t) => [t.id, t]));

// 数据卫生：快照中的 id 必须都存在于该产物（池 tag 变更时显式失败，不静默吞掉）
const unknownIds = [...mismatchIds].filter((id) => !byId.has(id));
if (unknownIds.length) throw new Error('错配快照含产物中不存在的任务: ' + unknownIds.join(','));

const removed = ML.mismatches.map((m) => {
  const t = byId.get(m.id);
  return { id: m.id, fixture: m.fixture, missing: m.missing, note: m.note || null, dl240Status: t.status, dl240EscalationClass: t.escalationClass || null };
});
const grayZoneTasks = ML.grayZones.map((g) => {
  const t = byId.get(g.id);
  return { id: g.id, fixture: g.fixture, reason: g.reason, dl240Status: t.status, dl240EscalationClass: t.escalationClass || null };
});

// removed 内部交叉表
const removedTerminal = {};
removed.forEach((r) => { const k = r.dl240Status + '/' + (r.dl240EscalationClass || '-'); removedTerminal[k] = (removedTerminal[k] || 0) + 1; });

const feasible = PT.filter((t) => !mismatchIds.has(t.id));
const feasibleSuccess = feasible.filter((t) => t.status === 'SUCCESS');
const graySuccess = grayZoneTasks.filter((g) => g.dl240Status === 'SUCCESS');
const adjustedSuccessRate = Math.round((feasibleSuccess.length / feasible.length) * 1000) / 1000;

const adjusted = {
  provisional: true,
  caliberNote: 'adjusted 仅作分析视图，绝不覆盖 nominal；B2 逐任务四分类（TRUE_SUCCESS/VERIFIABLE_SUCCESS/SUSPECT_FALSE_POSITIVE/STRUCTURALLY_INFEASIBLE）完成后数字才正式定案',
  poolMismatchSnapshot: 'server/scripts/pool_fixture_mismatch_list.json',
  mismatchCount: removed.length,
  grayZoneCount: grayZoneTasks.length,
  feasibleDenominator: feasible.length,
  successAmongFeasible: feasibleSuccess.length,
  adjustedSuccessRate,
  reportCrossCheck: {
    reportClaimedMismatchCount: 43,
    reportClaimedAdjustedSuccessRate: 0.825,
    deltaExplanation: '当前审计快照为 ' + removed.length + ' 个错配（报告口径 43 差 ' + (removed.length - 43) + ' 个 VERIFY_RETRY 任务，词典扩充后新增命中）；SUCCESS among feasible 不变，分母 57→' + feasible.length + '，故 adjusted 率与报告 82.5% 存在偏差。以原始 evidence 为准，不强撑报告数字。',
  },
  removedTerminalStates: removedTerminal,
  falsePositiveCandidates: removed.filter((r) => r.dl240Status === 'SUCCESS').map((r) => r.id),
  honestFailureAmongMismatch: removed.filter((r) => r.dl240EscalationClass === 'VERIFY_RETRY').map((r) => r.id),
  credibleAmongMismatch: removed.filter((r) => r.dl240EscalationClass === 'CREDIBLE_BUSINESS').map((r) => r.id),
  engineeringAmongMismatch: removed.filter((r) => r.dl240EscalationClass === 'ENGINEERING_FAILURE').map((r) => r.id),
  grayZoneWatchlist: graySuccess.map((g) => g.id),
  removedDetail: removed,
  grayZoneDetail: grayZoneTasks,
};

// ---------- 输出 ----------
const out = {
  generatedAt: new Date().toISOString(),
  input: inputPath,
  inputFingerprint: fp0,
  nominal,
  adjusted,
};
const defaultOut = path.join(benchDir, 'phase12_analysis_' + path.basename(inputPath).replace(/\.json$/, '') + '.json');
const outPath = outArg ? path.resolve(outArg) : defaultOut;
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

// ---------- 只读校验 ----------
const st1 = fs.statSync(inputPath);
if (st1.size !== fp0.size || st1.mtimeMs !== fp0.mtimeMs) {
  console.error('FATAL: 输入文件被修改——违反只读纪律');
  process.exit(2);
}

console.log('输入: ' + path.basename(inputPath) + ' (perTask=' + PT.length + ')');
console.log('[Nominal] Business Success ' + nominal.successRate + ' | ESC ' + nominal.humanEscalationRate + ' | Planner ' + nominal.plannerSuccessRate + ' | Agent Score ' + (nominal.agentScore ? nominal.agentScore.overall : '-'));
console.log('[Adjusted/provisional] mismatch ' + adjusted.mismatchCount + ' + gray ' + adjusted.grayZoneCount + ' → feasible ' + adjusted.feasibleDenominator + ' | SUCCESS among feasible ' + adjusted.successAmongFeasible + ' → ' + Math.round(adjustedSuccessRate * 1000) / 10 + '%');
console.log('假阳性候选(SUCCESS among mismatch): ' + adjusted.falsePositiveCandidates.length + ' 个');
console.log('已写出: ' + outPath);
