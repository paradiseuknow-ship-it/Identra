'use strict';

// test_analyze_phase12.js — B1 双口径分析器 targeted test（×2 顺序执行）。
// 断言「真正会执行的那份东西」：spawn 子进程跑 analyze_phase12.js，对真实 dl240 产物
// 做只读分析，校验 Nominal 保真 + Adjusted provisional 数学 + 只读纪律。

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SCRIPT = path.join(__dirname, 'analyze_phase12.js');
const DL240 = path.join(__dirname, '..', '..', '.benchmark', 'phase12_tag_fixes_baseline_dl240_1788229276002.json');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' | got: ' + JSON.stringify(extra) : '')); }
}

function runOnce(round) {
  console.log('--- round ' + round + ' ---');
  const outPath = path.join(os.tmpdir(), 'p12test_analysis_' + round + '_' + Date.now() + '.json');
  const st0 = fs.statSync(DL240);

  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [SCRIPT, '--file', DL240, '--out', outPath], { encoding: 'utf8', timeout: 30000 });
  } catch (e) {
    check('round' + round + ' 分析器退出码 0', false, e.message);
    return;
  }
  check('round' + round + ' 分析器退出码 0', true);

  // 只读纪律：输入 bytes+mtime 不变
  const st1 = fs.statSync(DL240);
  check('round' + round + ' 输入文件只读未动（size+mtime）', st0.size === st1.size && st0.mtimeMs === st1.mtimeMs);
  // 输入内不得出现输出文件痕迹（防写穿）
  check('round' + round + ' 输入仍为合法 JSON 且不含 analysis 键', (() => { try { return JSON.parse(fs.readFileSync(DL240, 'utf8')).nominal === undefined; } catch (e) { return false; } })());

  const out = JSON.parse(fs.readFileSync(outPath, 'utf8'));

  // ---- Nominal（历史口径逐字段保真）----
  const n = out.nominal;
  check('round' + round + ' nominal.totalTasks=100', n.totalTasks === 100, n.totalTasks);
  check('round' + round + ' nominal.statusCounts 66/30/3/1', n.statusCounts.SUCCESS === 66 && n.statusCounts.HUMAN_ESCALATION === 30 && n.statusCounts.FAILED === 3 && n.statusCounts.CANCELLED === 1, n.statusCounts);
  check('round' + round + ' nominal.successRate=0.66', n.successRate === 0.66, n.successRate);
  check('round' + round + ' nominal.humanEscalationRate=0.3', n.humanEscalationRate === 0.3, n.humanEscalationRate);
  check('round' + round + ' nominal.escalationCredibleRate=0.12', n.escalationCredibleRate === 0.12, n.escalationCredibleRate);
  check('round' + round + ' nominal.escalationRealRate=0', n.escalationRealRate === 0, n.escalationRealRate);
  check('round' + round + ' nominal.plannerSuccessRate=0.91', n.plannerSuccessRate === 0.91, n.plannerSuccessRate);
  check('round' + round + ' nominal.agentScore.overall=84', n.agentScore && n.agentScore.overall === 84, n.agentScore && n.agentScore.overall);
  check('round' + round + ' nominal.escalationClasses CREDIBLE 12/VERIFY_RETRY 18/TIMEOUT 1/ENG 3/REAL 0', n.escalationClasses && n.escalationClasses.CREDIBLE_BUSINESS === 12 && n.escalationClasses.VERIFY_RETRY === 18 && n.escalationClasses.TIMEOUT === 1 && n.escalationClasses.ENGINEERING_FAILURE === 3 && n.escalationClasses.REAL === 0, n.escalationClasses);

  // ---- Adjusted（provisional 分析视图；v2 快照：mismatch 55）----
  const a = out.adjusted;
  check('round' + round + ' adjusted.provisional=true', a.provisional === true);
  check('round' + round + ' adjusted.mismatchCount=55', a.mismatchCount === 55, a.mismatchCount);
  check('round' + round + ' adjusted.grayZoneCount=6', a.grayZoneCount === 6, a.grayZoneCount);
  check('round' + round + ' adjusted.feasibleDenominator=45', a.feasibleDenominator === 45, a.feasibleDenominator);
  check('round' + round + ' adjusted.successAmongFeasible=40', a.successAmongFeasible === 40, a.successAmongFeasible);
  check('round' + round + ' adjusted.successRate=40/45=0.889', a.adjustedSuccessRate === 0.889, a.adjustedSuccessRate);
  check('round' + round + ' adjusted 与历史报告口径差异显式标注', a.reportCrossCheck && typeof a.reportCrossCheck.deltaExplanation === 'string' && a.reportCrossCheck.deltaExplanation.length > 10);

  // 假阳性候选 = B2 v2 裁定 26 人名单（历史 19 + 新增 7：014/022/025/036/039/040/078）
  const expectedFP = 'rw.006,rw.014,rw.015,rw.016,rw.018,rw.021,rw.022,rw.025,rw.027,rw.028,rw.029,rw.030,rw.036,rw.037,rw.039,rw.040,rw.043,rw.045,rw.047,rw.048,rw.067,rw.077,rw.078,rw.093,rw.096,rw.098'.split(',').sort();
  check('round' + round + ' 假阳性候选=26 人名单', JSON.stringify(a.falsePositiveCandidates.slice().sort()) === JSON.stringify(expectedFP), a.falsePositiveCandidates);

  // removed 终态交叉表：26S/10C/16V/2E/1T = 55
  const rt = a.removedTerminalStates;
  check('round' + round + ' removed 终态 26S/10C/16V/2E/1T', rt['SUCCESS/-'] === 26 && rt['HUMAN_ESCALATION/CREDIBLE_BUSINESS'] === 10 && rt['HUMAN_ESCALATION/VERIFY_RETRY'] === 16 && rt['FAILED/ENGINEERING_FAILURE'] === 2 && rt['CANCELLED/TIMEOUT'] === 1, rt);
  // removed 每条都带 mismatch reason
  check('round' + round + ' removed 全部带 missing 理由', a.removedDetail.every((r) => r.missing && r.missing.length > 0));
  // grayZone watchlist：灰区 SUCCESS 单列（B2 复核清单）
  check('round' + round + ' grayZoneWatchlist 为数组且 grayZoneDetail=6', Array.isArray(a.grayZoneWatchlist) && a.grayZoneDetail.length === 6);

  // nominal 与 adjusted 分离：adjusted 绝不回写 nominal
  check('round' + round + ' nominal 与 adjusted 结构分离', out.nominal && out.adjusted && out.nominal.successRate === 0.66);

  fs.unlinkSync(outPath);
}

runOnce(1);
runOnce(2);

console.log('==== test_analyze_phase12: ' + pass + ' pass / ' + fail + ' fail ====');
process.exit(fail ? 1 : 0);
