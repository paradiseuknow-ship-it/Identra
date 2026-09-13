'use strict';
// C122 —— runtime.run() 异常结算作用域缺陷（catch 引用 try 块内 let 声明 → ReferenceError 吞掉原始异常）。
//
// 缺陷（2026-09-14，p1_smoke_r1 六 worker 实证）：
//   PHASE 17-E 在 run() 的 try 块**内**声明 `let skillSession = null`（原 :626），
//   却在 `catch (fatal)`（原 :1246）里引用它做异常结算。JS let 块级作用域下
//   **catch 块看不到 try 块内的声明** ⇒ 任何未预期异常进入 catch 时，`if (skillSession)`
//   自身抛 ReferenceError：① 异常结算（skillSession.finish 落库）被跳过；
//   ② **原始异常整体丢失** —— task 终态 error 变成 "skillSession is not defined"，
//      真实失败原因无从归因（p1_smoke_r1：6/6 任务 3.4s 内 FAILED，真因全灭）。
//
// 修复：声明提升到 run() 函数作用域（try 之前），try 内禁止重复声明。
//
// 守护三层（与 test_runtime_replan_const_regression 同范式）：
//   [A] 静态作用域断言（真实 runtime.js）：声明唯一、位置在第一个 try 之前、
//       catch (fatal) 块引用而非重声明 —— 全部经 stripComments，防注释字面量假阳/假阴。
//   [B] vm 微复现 bug 类：try 内 let + catch 引用必炸 / 函数作用域 let + catch 引用必好
//       —— 证明断言咬住的是「作用域语义」这个 bug 类，不是某行文本。
//   [C] 真实模块行为探针（in-process，tmp FPB_DATA_DIR，零浏览器）：
//       伪造 browser session（跳过真实 Chromium）+ 注入 planner 抛出探针异常，
//       断言 run() 走 fatal catch 后：不向外抛、任务终态 FAILED、error 含**原始原因**、
//       不含 "skillSession is not defined"。

const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const RUNTIME_PATH = path.join(__dirname, '..', 'agent', 'runtime.js');
const src = fs.readFileSync(RUNTIME_PATH, 'utf8');

let failures = 0;
let passCount = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('  FAIL: ' + msg); }
  else { passCount++; console.log('  PASS: ' + msg); }
}

function stripComments(s) {
  // 行注释 + 块注释（不处理字符串内的 // —— 本断言只面向结构关键字，URL 误伤不影响判定；
  // 但为稳妥先移除块注释再移除行注释，与仓内既有 stripComments 语义一致）。
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function extractFunctionBody(source, fnSig) {
  const idx = source.indexOf(fnSig);
  if (idx < 0) throw new Error('function signature not found: ' + fnSig);
  let i = source.indexOf('{', idx);
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(idx, i + 1);
    }
  }
  throw new Error('unbalanced braces in ' + fnSig);
}

function extractCatchBlock(runBody, catchMarker) {
  const idx = runBody.indexOf(catchMarker);
  if (idx < 0) return null;
  // C122 自省：游标必须 let —— 本套件自身不得复现 P0-1「Assignment to constant variable」。
  let i = runBody.indexOf('{', idx);
  let depth = 0;
  for (; i < runBody.length; i++) {
    if (runBody[i] === '{') depth++;
    else if (runBody[i] === '}') {
      depth--;
      if (depth === 0) return runBody.slice(idx, i + 1);
    }
  }
  return null;
}

// ── [A] 静态作用域断言（真实源码）────────────────────────────────────────────
console.log('[A] 静态作用域断言（真实 runtime.js，stripComments 后）');
const runBody = stripComments(extractFunctionBody(src, 'async function run('));
const declRe = /(?:let|const|var)\s+skillSession\s*=\s*null\s*;/g;
const decls = runBody.match(declRe) || [];

assert(decls.length === 1,
  'A1 skillSession 在 run() 内声明恰好 1 次（实测 ' + decls.length + '）');
assert(decls.length === 1 && /^let /.test(decls[0]),
  'A1b 声明为 let（可重赋值：handover 置 null 路径）');

const declIdx = runBody.indexOf('let skillSession');
const firstTryIdx = runBody.indexOf('try {');
assert(firstTryIdx >= 0 && declIdx >= 0 && declIdx < firstTryIdx,
  'A2 声明位于 run() 体内第一个 try 之前（函数作用域）');

const catchBody = extractCatchBlock(runBody, 'catch (fatal)');
assert(!!catchBody, 'A3a run() 存在 catch (fatal) 异常结算块');
assert(!!catchBody && /skillSession\s*\.?\s*finish|if\s*\(skillSession\)/.test(catchBody),
  'A3b catch (fatal) 仍引用 skillSession 做 17-E 异常结算（结算逻辑未被删除）');
assert(!!catchBody && !/(?:let|const|var)\s+skillSession/.test(catchBody),
  'A4 catch (fatal) 内不存在 skillSession 声明（引用而非重声明）');

// ── [B] vm 微复现 bug 类 ────────────────────────────────────────────────────
console.log('[B] vm 微复现：作用域语义（bug 类，而非某行文本）');
function evalScopePattern(declareInsideTry) {
  const code = `
    function runShape() {
      ${declareInsideTry ? '' : 'let skillSession = null;'}
      try {
        ${declareInsideTry ? 'let skillSession = null;' : ''}
        skillSession = { finish() { return 'settled'; } };
        throw new Error('ORIGINAL_CAUSE');
      } catch (fatal) {
        if (skillSession) { skillSession.finish(); skillSession = null; }
        return { caught: fatal.message };
      }
    }
    runShape();
  `;
  const ctx = {};
  vm.createContext(ctx);
  try { return { ok: true, ret: vm.runInContext(code, ctx) }; }
  catch (e) { return { ok: false, err: e }; }
}

const buggy = evalScopePattern(true);
assert(!buggy.ok && /skillSession is not defined/.test(String(buggy.err && buggy.err.message)),
  'B1 try 内声明 + catch 引用 → ReferenceError（17-E 缺陷形态复现，原始异常 ORIGINAL_CAUSE 被吞）');
const fixedShape = evalScopePattern(false);
assert(fixedShape.ok && fixedShape.ret.caught === 'ORIGINAL_CAUSE',
  'B2 函数作用域声明 + catch 引用 → 正常结算并保留原始异常（修复语义）');

// ── [C] 真实模块行为探针（零浏览器）────────────────────────────────────────
console.log('[C] 真实模块行为探针：planner 抛出探针异常 → fatal catch 必须保留原始原因');
(async () => {
  // FPB_DATA_DIR 必须在 require 任何 server 模块之前设置（dataRoot 启动期解析）。
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'c122-probe-'));
  process.env.FPB_DATA_DIR = tmpData;

  const browserManager = require('../browserManager');
  const db = require('../db');
  const taskManager = require('../agent/taskManager');
  const planner = require('../agent/planner');
  const contextBuilder = require('../agent/contextBuilder');
  // runtime 在 require 时把自身注册为 taskManager executor —— 必须真实加载。
  const runtime = require('../agent/runtime');

  // 探针注入点（均为模块级 require 缓存替换；run()/catch 是被测真实代码）：
  //   ① 假 session：ensureBrowser 命中「会话已存在」分支 ⇒ 零 Chromium 启动。
  //   ② 空上下文：resolvePlan 的 ContextBuilder 直接通过 ⇒ 探针异常只可能来自 planner。
  //   ③ planner.planObjective 抛出唯一探针标记 PROBE_FATAL_CAUSE_XYZ。
  browserManager.getSession = () => ({ context: {} });
  browserManager.getPage = async () => null;
  contextBuilder.build = () => ({});
  planner.planObjective = async () => { throw new Error('PROBE_FATAL_CAUSE_XYZ'); };

  const profileId = 'p_c122_probe';
  db.upsertProfile({
    id: profileId, name: 'c122-probe', group: 'default', tags: [], notes: '',
    seed: 'probe', headless: true, proxyMode: 'none', proxyId: null, proxyInline: null,
    os: 'Windows', browser: 'Chrome', startupUrls: [], launchArgs: [],
    launchBehavior: { restoreLastSession: false, blockVideo: false, blockImages: false, clearCacheOnLaunch: false, cacheClearMode: 'none', clearCookies: false },
    fingerprintOverride: {}, fingerprint: null, lastSessionUrls: [], createdAt: Date.now(),
  });

  const task = taskManager.createTask({
    name: 'c121 probe',
    objective: 'probe: fatal catch must preserve original cause',
    targetUrl: '',
    profileId,
    executionMode: 'AUTONOMOUS',
  });
  // 直调 store 落 RUNNING（绕过 start() 的队列编排；被测对象是 run() 本身）。
  const store = require('../agent/store');
  store.upsert('aiTasks', Object.assign({}, task, { status: 'RUNNING' }));
  const t0 = taskManager.getTask(task.id);
  assert(!!t0 && t0.status === 'RUNNING', 'C0 探针任务已构造并处于 RUNNING');

  let threw = null;
  let finalTask = null;
  try {
    await runtime.run(task.id);
    finalTask = taskManager.getTask(task.id);
  } catch (e) { threw = e; }

  assert(!threw, 'C1 run() 走 fatal catch 后不向调用方抛出（修复前此处抛 ReferenceError）');
  assert(!!finalTask && finalTask.status === 'FAILED',
    'C2 未预期异常落为显式 FAILED 终态（Phase 5.8 防御语义未被破坏），实测=' +
    (finalTask ? finalTask.status : 'null'));
  // taskManager.fail 把原因落为 task.error **字符串**（String(error.message).slice(0,500)）。
  const errMsg = String((finalTask && finalTask.error) || '');
  assert(errMsg.includes('PROBE_FATAL_CAUSE_XYZ'),
    'C3 终态 error 保留**原始异常原因**（取证链不再被吞），实际=' + errMsg.slice(0, 120));
  assert(!/skillSession is not defined/.test(errMsg),
    'C4 终态 error 不再是 ReferenceError 形态');

  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch (e) {}

  console.log('');
  if (failures === 0) {
    console.log('C122 GUARD PASSED — ' + passCount + ' assertions. catch (fatal) 作用域缺陷已修复且被咬住。');
    process.exit(0);
  } else {
    console.error('C122 GUARD FAILED — ' + failures + ' assertion(s) failed.');
    process.exit(1);
  }
})().catch((e) => {
  console.error('C122 probe crashed:', (e && e.stack) || e);
  process.exit(1);
});
