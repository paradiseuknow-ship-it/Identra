'use strict';

// =============================================================================
// benchmark_framework.js — Phase 3 可复用基准测试框架（封装层，不重写口径）
//
// 设计原则（对齐冻结边界）：
//   - 不修改 Business Success 定义 / benchmark 口径：success 仍由既有的成功判定与
//     task.successMetrics.isBusinessSuccess 决定；本框架只读取、聚合、汇报。
//   - 复用 phase10Benchmark 的 runScenario / aggregate（Phase 10.9 基线同口径），
//     保证与 phase12 产品级验证一致，避免重复实现导致口径漂移。
//   - 新增能力：对「既有 store（如权威 100-task 备份）」做只读统计（analyzeStore），
//     以及纯函数 computeStats，供 100-task Evaluation 直接复用。
//
// 用法：
//   node benchmark_framework.js --analyze <storePath> [--out report.json]
//   node benchmark_framework.js --tasks <scenarios.json> [--max N] [--out report.json]
// =============================================================================

const fs = require('fs');
const path = require('path');

// 单一权威「业务成功」口径（B3 / Phase 12B）：isBusinessSuccess(task) = task.status === 'SUCCESS'。
// 本框架所有统计必须从该权威派生，禁止读取可能失真的 task.successMetrics.isBusinessSuccess 原始字段。
const successMetrics = require('../agent/successMetrics');

// 复用 Phase 10.9 基线 runner / 聚合（同口径，不重定义 success）。
// 懒加载：仅在真实跑批 runBenchmark 内 require，避免模块加载时触发 phase10Benchmark 的环境守卫（如缺 API KEY 直接 exit）。
let _P9 = null;
function getP9() {
  if (!_P9) _P9 = require('./phase10Benchmark');
  return _P9;
}

// ---- 只读解析（兼容 JSON 数组 / 换行分隔）----
function parseFile(p) {
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8').trim();
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { /* 换行分隔 */ }
  return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}

// ---- 纯函数：对一组结果记录做聚合统计（不修改任何口径）----
// record: { status, isBusinessSuccess?, failureType?, category? }
// 单一权威：businessSuccess 必须由 status === 'SUCCESS' 派生（successMetrics.isBusinessSuccess），
// 不依赖记录自带的、可能失真的 isBusinessSuccess 字段。
function computeStats(records) {
  const total = records.length;
  let success = 0;
  let businessSuccess = 0;
  let conflictCount = 0; // 口径冲突计数：记录自带 isBusinessSuccess 与权威(status===SUCCESS)不一致
  const byStatus = {};
  const byFailureType = {};
  const byCategory = {};
  for (const r of records) {
    const st = r.status || 'UNKNOWN';
    byStatus[st] = (byStatus[st] || 0) + 1;
    const isBiz = (st === 'SUCCESS');
    if (isBiz) success++;
    if (isBiz) businessSuccess++;
    // 口径冲突检查（仅检测，不覆盖权威值）：若记录自带布尔字段且与权威相悖，记下冲突数。
    if (typeof r.isBusinessSuccess === 'boolean' && !!r.isBusinessSuccess !== isBiz) conflictCount++;
    const ft = r.failureType || (st !== 'SUCCESS' ? 'UNKNOWN' : null);
    if (ft) byFailureType[ft] = (byFailureType[ft] || 0) + 1;
    const cat = r.category || 'uncategorized';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  }
  const rate = (n) => (total ? n / total : 0);
  return {
    totalTasks: total,
    success,
    businessSuccess,
    successRate: rate(success),
    businessSuccessRate: rate(businessSuccess),
    conflictCount,
    byStatus,
    byFailureType,
    byCategory,
  };
}

// 失败归因收口：在既有 login/click/submit/longflow 基础上，识别 fill/navigate 等动作类型，
// 并在动作无法判定时用任务名/目标关键词兜底，使 uncategorized 收敛到「真正不可归类」的极少数。
// 不改变任务池、不改变 decision 语义，仅完善统计标签的完整性。
function deriveCategory(task, attempts, stepCount) {
  const cats = new Set();
  const taskText = (((task && (task.name || '')) + ' ' + (task && (task.objective || ''))) || '').toLowerCase();
  for (const a of (attempts || [])) {
    const act = (a.action) || {};
    if (act.credentialRef) cats.add('login');
    if ((act.expectedBusinessState || {}).stateType === 'LOGIN_SUCCESS') cats.add('login');
    if (act.type === 'click') cats.add('click');
    if (act.type === 'submit') cats.add('submit');
    if (act.type === 'fill' || act.type === 'type' || act.type === 'select') cats.add('form');
    if (act.type === 'navigate') cats.add('nav');
  }
  if (cats.size === 0) {
    if (/login|sign ?in|auth|log in|登录|鉴权|验证/.test(taskText)) cats.add('login');
    else if (/submit|pay|order|register|sign ?up|注册|提交|下单|支付|购买/.test(taskText)) cats.add('submit');
    else if (/click|press|按钮|点击|tap/.test(taskText)) cats.add('click');
    else if (/scrap|extract|collect|crawl|抓取|采集|爬|数据/.test(taskText)) cats.add('scrape');
    else cats.add('other');
  }
  const distinctSteps = new Set((attempts || []).map((a) => a.stepId)).size;
  if ((stepCount || distinctSteps) >= 5) cats.add('longflow');
  return [...cats].join(',') || 'uncategorized';
}

// ---- 只读：从既有 store 还原每任务结果并统计 ----
function analyzeStore(storePath) {
  const tasks = parseFile(path.join(storePath, 'aiTasks.json')) || [];
  const attempts = parseFile(path.join(storePath, 'aiAttempts.json')) || [];
  const steps = parseFile(path.join(storePath, 'aiSteps.json')) || [];

  const stepTask = {};
  steps.forEach((s) => { stepTask[s.id] = s.taskId; });
  const taskAttempts = {};
  attempts.forEach((a) => {
    const tid = stepTask[a.stepId] || (a.stepId && a.stepId.split('_step')[0]) || null;
    if (tid) (taskAttempts[tid] = taskAttempts[tid] || []).push(a);
  });

  const records = tasks.map((t) => {
    const tas = taskAttempts[t.id] || [];
    const stepCount = steps.filter((s) => s.taskId === t.id).length;
    const failed = tas.find((a) => (a.error || {}).code) || tas.find((a) => a.status === 'FAILED');
    const ft = failed ? ((failed.error || {}).failureType || null) : null;
    return {
      taskId: t.id,
      status: t.status,
      // 单一权威：业务成功 = 终态 SUCCESS（successMetrics.isBusinessSuccess），不再读可能失真的原始字段。
      isBusinessSuccess: successMetrics.isBusinessSuccess(t),
      failureType: ft,
      category: deriveCategory(t, tas, stepCount),
    };
  });

  return {
    storePath,
    generatedAt: new Date().toISOString(),
    stats: computeStats(records),
    perTask: records,
  };
}

// ---- 真实跑批编排（委托 P9，不重写 runner）----
async function runBenchmark(scenarios, { max = 0, onTask } = {}) {
  const P9 = getP9();
  const list = max > 0 ? scenarios.slice(0, max) : scenarios;
  const mock = await P9.startMockServer();
  const baseUrl = `http://127.0.0.1:${mock.port}`;
  const results = [];
  for (const scn of list) {
    let rec;
    try { rec = await P9.runScenario(scn, baseUrl); }
    catch (e) {
      rec = { id: scn.id, name: scn.name, category: scn.category, status: 'RUNNER_ERROR', error: String((e && e.message) || e) };
    }
    results.push(rec);
    if (onTask) onTask(rec);
  }
  return { summary: P9.aggregate(results), perTask: results };
}

function pct(x) { return x == null ? '-' : (x * 100).toFixed(1) + '%'; }

function printSummary(report) {
  const s = report.stats || report.summary;
  if (!s) return;
  console.log('\n──────── Benchmark Summary ────────');
  console.log('Total tasks        :', s.totalTasks);
  if (s.successRate != null) console.log('Success rate       :', pct(s.successRate));
  if (s.businessSuccessRate != null) console.log('Business success   :', pct(s.businessSuccessRate));
  console.log('By status          :', JSON.stringify(s.byStatus || {}));
  if (s.byFailureType) console.log('By failureType     :', JSON.stringify(s.byFailureType));
  if (s.byCategory) console.log('By category        :', JSON.stringify(s.byCategory));
  console.log('────────────────────────────────────');
}

function main() {
  const args = process.argv.slice(2);
  const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const has = (k) => args.includes(k);

  if (has('--analyze')) {
    const storePath = get('--analyze');
    if (!fs.existsSync(storePath)) { console.error('store 不存在: ' + storePath); process.exit(1); }
    const report = analyzeStore(storePath);
    printSummary(report);
    const out = get('--out', null);
    if (out) { fs.writeFileSync(out, JSON.stringify(report, null, 2)); console.log('report written to ' + out); }
    return;
  }

  if (has('--tasks')) {
    const f = get('--tasks');
    const list = parseFile(f);
    if (!list.length) { console.error('未加载到 scenarios: ' + f); process.exit(1); }
    const max = parseInt(get('--max', '0'), 10) || 0;
    return runBenchmark(list, {
      max,
      onTask: (rec) => console.log(`[bench] ${rec.name || rec.id} status=${rec.status}`),
    }).then((res) => {
      printSummary(res);
      const out = get('--out', null);
      if (out) { fs.writeFileSync(out, JSON.stringify(res, null, 2)); console.log('report written to ' + out); }
    });
  }

  console.error('用法: --analyze <storePath> [--out report.json] | --tasks <scenarios.json> [--max N] [--out report.json]');
  process.exit(1);
}

if (require.main === module) main();

module.exports = { computeStats, analyzeStore, runBenchmark, parseFile, deriveCategory };
