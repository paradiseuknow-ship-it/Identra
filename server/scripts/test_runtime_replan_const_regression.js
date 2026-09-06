// Regression test for P0-1: `const steps` reassignment crash in runtime.run()
//
// Root cause (Phase 2 真实根因审计):
//   server/agent/runtime.js 在 run() 内声明 `const steps = await resolvePlan(task)`，
//   但 REPLAN 分支执行 `steps = stepManager.listSteps(task.id)` 对其重新赋值，
//   触发原生 V8 错误 "Assignment to constant variable"，被 run() 外层 catch 捕获后
//   任务被强制转为 FAILED 终态。最终 100-task 验收中 14 个任务命中此路径崩溃。
//
// 修复: 将声明改为 `let steps`（最小、外科手术式修复，不重写 runtime）。
//
// 本测试从两个维度守护该回归:
//   (A) 静态扫描真实 runtime.js，确认 run() 内 `steps` 以 `let` 声明且 REPLAN 分支对其重赋值;
//   (B) 在隔离 vm 中以完全相同的代码形态做功能复现，证明 `const`+重赋值抛错、
//       `let`+重赋值成功 —— 即 bug 类已被修复。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RUNTIME_PATH = path.join(__dirname, '..', 'agent', 'runtime.js');
const src = fs.readFileSync(RUNTIME_PATH, 'utf8');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('  FAIL: ' + msg); }
  else console.log('  PASS: ' + msg);
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

console.log('[A] Static scan of real runtime.js');

// run() is declared as `async function run(taskId)`
const runBody = extractFunctionBody(src, 'async function run(');
// 2026-08-31 契约更新：resolvePlan 调用点包了 try/catch（needsCredentials → escalate 路由），
// 声明形态为 `let steps;`（无初始化器）。守卫意图不变：steps 必须可重赋值（禁 const）。
const declMatch = runBody.match(/(?:const|let)\s+steps\s*(?:=|;)/);
assert(
  !!declMatch && declMatch[0].startsWith('let'),
  'runtime.run() declares `steps` with `let` (not `const`)'
);
assert(
  !/const\s+steps\s*(?:=|;)/.test(runBody),
  'runtime.run() must not declare `steps` with const'
);
assert(
  /steps\s*=\s*stepManager\.listSteps/.test(runBody),
  'runtime.run() reassigns `steps` in the REPLAN branch'
);

console.log('[B] Functional micro-reproduction of the bug class (isolated vm)');

function evalPattern(useConst) {
  const code = `
    function run() {
      ${useConst ? 'const' : 'let'} steps = [1, 2, 3];
      try {
        steps = [4, 5, 6]; // REPLAN reassignment
        return { ok: true, first: steps[0] };
      } catch (e) {
        return { ok: false, err: e.message };
      }
    }
    run();
  `;
  const ctx = {};
  vm.createContext(ctx);
  return vm.runInContext(code, ctx);
}

const withConst = evalPattern(true);
const withLet = evalPattern(false);

assert(
  withConst.ok === false && /Assignment to constant variable/.test(withConst.err || ''),
  'const + reassignment throws "Assignment to constant variable" (reproduces the original crash)'
);
assert(
  withLet.ok === true && withLet.first === 4,
  'let + reassignment succeeds (fix verified)'
);

console.log('');
if (failures === 0) {
  console.log('REGRESSION TEST PASSED — P0-1 const-steps reassignment crash is fixed.');
  process.exit(0);
} else {
  console.error('REGRESSION TEST FAILED — ' + failures + ' assertion(s) failed.');
  process.exit(1);
}
