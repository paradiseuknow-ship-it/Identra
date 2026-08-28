'use strict';

// Phase 3 Benchmark Framework 测试：纯函数 computeStats + 只读 analyzeStore。
// 不依赖浏览器 / 真实跑批，仅校验聚合与 store 解析正确性，且验证不修改 success 口径。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { computeStats, analyzeStore, deriveCategory } = require('./benchmark_framework');

let pass = 0, fail = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; fails.push(msg); console.log('  ✗ FAIL: ' + msg); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

section('Phase 3.1 computeStats 聚合');
const recs = [
  { status: 'SUCCESS', isBusinessSuccess: true, failureType: null, category: 'login' },
  { status: 'SUCCESS', isBusinessSuccess: true, failureType: null, category: 'click' },
  { status: 'FAILED', isBusinessSuccess: false, failureType: 'SUBMIT_RESULT_UNKNOWN', category: 'submit' },
  { status: 'FAILED', isBusinessSuccess: false, failureType: 'DOM_CHANGED', category: 'click' },
  { status: 'FAILED', isBusinessSuccess: false, failureType: 'ASYNC_PENDING', category: 'submit' },
];
const s = computeStats(recs);
ok(s.totalTasks === 5, 'totalTasks=5');
ok(s.success === 2, 'success=2');
ok(Math.abs(s.successRate - 0.4) < 1e-9, 'successRate=0.4');
ok(s.businessSuccess === 2, 'businessSuccess=2');
ok(s.byFailureType.SUBMIT_RESULT_UNKNOWN === 1, 'byFailureType 含 SUBMIT_RESULT_UNKNOWN');
ok(s.byFailureType.ASYNC_PENDING === 1, 'byFailureType 含 ASYNC_PENDING（P4/P5 新增类型可被统计）');
ok(s.byCategory.submit === 2, 'byCategory.submit=2');

section('Phase 3.2 computeStats 空输入安全');
const e = computeStats([]);
ok(e.totalTasks === 0 && e.successRate === 0, '空记录 → total=0, rate=0 不崩溃');

section('Phase 3.3 computeStats 不修改入参（冻结边界）');
const snap = JSON.stringify(recs);
computeStats(recs);
ok(JSON.stringify(recs) === snap, '入参记录未被 mutate（success 口径未改）');

section('Phase 3.4 analyzeStore 只读统计（临时 store）');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench_'));
const tasks = [
  { id: 't1', status: 'SUCCESS', successMetrics: { isBusinessSuccess: true } },
  { id: 't2', status: 'FAILED', successMetrics: { isBusinessSuccess: false } },
  { id: 't3', status: 'FAILED', successMetrics: { isBusinessSuccess: false } },
];
const steps = [
  { id: 't1_step1', taskId: 't1' },
  { id: 't2_step1', taskId: 't2' },
  { id: 't3_step1', taskId: 't3' },
  { id: 't3_step2', taskId: 't3' },
  { id: 't3_step3', taskId: 't3' },
  { id: 't3_step4', taskId: 't3' },
  { id: 't3_step5', taskId: 't3' },
];
const attempts = [
  { id: 'a1', stepId: 't2_step1', status: 'FAILED', action: { type: 'submit' }, error: { code: 'VERIFY_FAILED', failureType: 'SUBMIT_RESULT_UNKNOWN' } },
  { id: 'a2', stepId: 't3_step1', status: 'FAILED', action: { type: 'click' }, error: { code: 'VERIFY_FAILED', failureType: 'DOM_CHANGED' } },
];
fs.writeFileSync(path.join(dir, 'aiTasks.json'), JSON.stringify(tasks));
fs.writeFileSync(path.join(dir, 'aiSteps.json'), JSON.stringify(steps));
fs.writeFileSync(path.join(dir, 'aiAttempts.json'), JSON.stringify(attempts));

const report = analyzeStore(dir);
ok(report.stats.totalTasks === 3, 'analyzeStore totalTasks=3');
ok(report.stats.success === 1, 'success=1（t1）');
ok(report.stats.businessSuccess === 1, 'businessSuccess=1');
ok(report.stats.byFailureType.SUBMIT_RESULT_UNKNOWN === 1, 't2 → SUBMIT_RESULT_UNKNOWN 统计到');
ok(report.stats.byFailureType.DOM_CHANGED === 1, 't3 → DOM_CHANGED 统计到');
ok(report.perTask.find((t) => t.taskId === 't3').category.includes('longflow'), 't3 含 longflow 类别（5 steps）');
fs.rmSync(dir, { recursive: true, force: true });

section('Phase 3.5 单一权威：businessSuccess 由 status===SUCCESS 派生（STEP 1 收口）');
const recs2 = [
  { status: 'SUCCESS', isBusinessSuccess: false, failureType: null, category: 'login' }, // 自带字段失真，必须被权威纠正
  { status: 'FAILED', isBusinessSuccess: true, failureType: 'DOM_CHANGED', category: 'click' }, // 同上
  { status: 'HUMAN_ESCALATION', isBusinessSuccess: false, failureType: 'STATE_UNKNOWN', category: 'submit' },
];
const s2 = computeStats(recs2);
ok(s2.success === 1, 'success=1（仅 1 个 SUCCESS）');
ok(s2.businessSuccess === 1, 'businessSuccess=1（与 success 一致，忽略失真字段）');
ok(s2.conflictCount === 2, 'conflictCount=2（2 条记录自带字段与权威相悖，被检出）');

section('Phase 3.6 analyzeStore 使用单一权威（status 优先于失真字段）');
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bench2_'));
const tasks2 = [
  { id: 'x1', status: 'SUCCESS', successMetrics: { isBusinessSuccess: false } }, // 字段失真，权威应为 true
  { id: 'x2', status: 'FAILED', successMetrics: { isBusinessSuccess: true } },   // 字段失真，权威应为 false
];
fs.writeFileSync(path.join(dir2, 'aiTasks.json'), JSON.stringify(tasks2));
fs.writeFileSync(path.join(dir2, 'aiSteps.json'), JSON.stringify([]));
fs.writeFileSync(path.join(dir2, 'aiAttempts.json'), JSON.stringify([]));
const report2 = analyzeStore(dir2);
ok(report2.stats.businessSuccess === 1, 'businessSuccess=1（x1 SUCCESS 被权威计入，忽略失真字段）');
ok(report2.perTask.find((t) => t.taskId === 'x1').isBusinessSuccess === true, 'x1 perTask.isBusinessSuccess=true（权威派生）');
ok(report2.perTask.find((t) => t.taskId === 'x2').isBusinessSuccess === false, 'x2 perTask.isBusinessSuccess=false（权威派生）');
ok(report2.stats.conflictCount === 0, 'conflictCount=0（analyzeStore 仅输出权威值，无内部冲突）');
fs.rmSync(dir2, { recursive: true, force: true });

section('Phase 3.7 deriveCategory 收口 uncategorized（STEP 1 归因补全）');
const navTask = { id: 'n1', name: 'P9 SaaS数据查看', objective: '打开数据列表并确认出现「戴尔 U2723QE」' };
ok(deriveCategory(navTask, [{ action: { type: 'navigate' } }, { action: { type: 'inspect' } }], 2) === 'nav', 'navigate+inspect 数据任务 → nav（不再 uncategorized）');
const scrapeTask = { id: 'n2', name: '价格抓取', objective: '抓取商品列表数据' };
ok(deriveCategory(scrapeTask, [], 1) === 'scrape', '无动作但有 抓取/数据 关键词 → scrape（兜底不再 uncategorized）');
const formTask = { id: 'f1', name: '表单填写', objective: '填写注册表单' };
ok(deriveCategory(formTask, [{ action: { type: 'fill' } }], 1).includes('form'), 'fill 动作 → form 类别');
const kwTask = { id: 'k1', name: '用户登录', objective: '登录系统' };
ok(deriveCategory(kwTask, [], 1) === 'login', '无动作但有 login 关键词 → login（兜底）');
const plainTask = { id: 'p1', name: '普通任务', objective: '执行某些操作' };
ok(deriveCategory(plainTask, [{ action: { type: 'wait' } }], 1) === 'other', '完全不可归类 → other（非静默 uncategorized）');

console.log('\n==== 结果：' + pass + ' passed, ' + fail + ' failed ====');
if (fail) { console.log('失败项：\n - ' + fails.join('\n - ')); process.exit(1); }
