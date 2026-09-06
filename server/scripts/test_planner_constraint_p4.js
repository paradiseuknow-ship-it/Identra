'use strict';

// test_planner_constraint_p4.js — P4 语义放大禁令 + P5 等待证据契约 targeted test（×2）。
// 断言「真正会执行的那份东西」：spawn 子进程 require 真实 planner 模块，
// 求值 plannerInstructions() 实际产出文本（不 eval 源码）。

const { execFileSync } = require('child_process');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' | got: ' + String(extra).slice(0, 120) : '')); }
}

const SNIPPET = [
  "const p = require(" + JSON.stringify(path.join(__dirname, '..', 'agent', 'planner.js')) + ");",
  "const t = p.plannerInstructions ? p.plannerInstructions() : p.PLANNER_INSTRUCTIONS;",
  "console.log('HAS_P4=' + t.includes('P4 语义放大禁令'));",
  "console.log('HAS_P5=' + t.includes('P5 等待/观察证据契约'));",
  "console.log('P4_GRADE=' + t.includes('查看/确认 X 数量/状态/文本'));",
  "console.log('P5_FAB=' + t.includes('加载完成'));",
  "console.log('AC_P4=' + p.ACTION_CONSTRAINTS.includes('P4 语义放大禁令'));",
  "console.log('AC_P5=' + p.ACTION_CONSTRAINTS.includes('P5 等待/观察证据契约'));",
].join('\n');

function runOnce(round) {
  console.log('--- round ' + round + ' ---');
  let out = '';
  try {
    out = execFileSync(process.execPath, ['-e', SNIPPET], { encoding: 'utf8', timeout: 20000 });
  } catch (e) {
    check('round' + round + ' 子进程执行成功', false, e.message);
    return;
  }
  const get = (k) => { const m = out.match(new RegExp(k + '=(true|false)')); return m ? m[1] === 'true' : null; };

  check('round' + round + ' 求值后 instructions 含 P4 语义放大禁令', get('HAS_P4') === true, out);
  check('round' + round + ' 求值后 instructions 含 P5 等待/观察证据契约', get('HAS_P5') === true);
  check('round' + round + ' P4 含观察目标同粒度示例', get('P4_GRADE') === true);
  check('round' + round + ' P5 含臆造文案禁令', get('P5_FAB') === true);
  check('round' + round + ' ACTION_CONSTRAINTS 导出含 P4', get('AC_P4') === true);
  check('round' + round + ' ACTION_CONSTRAINTS 导出含 P5', get('AC_P5') === true);
}

runOnce(1);
runOnce(2);
console.log('==== test_planner_constraint_p4: ' + pass + ' pass / ' + fail + ' fail ====');
process.exit(fail ? 1 : 0);
