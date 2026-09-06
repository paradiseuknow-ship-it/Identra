'use strict';

// test_task_actions_summary.js — E1 步骤级动作摘要 targeted test（×2）。
// 断言「真正会执行的那份东西」：
//   1) spawn 子进程 require 真实 phase10Benchmark.buildActionsSummary 求值；
//   2) 接线断言：runScenario 的返回记录确实调用 actions: buildActionsSummary(steps)（恰好一处），
//      使 jsonl / 最终 JSON / worker WORKER_RESULT 全链路自动携带。

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MOD = path.join(__dirname, 'phase10Benchmark.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' | got: ' + JSON.stringify(extra) : '')); }
}

const SAMPLE = [
  { index: 0, description: '打开目标页面', status: 'SUCCESS', action: { type: 'navigate', target: { url: '/' } }, verification: { type: 'none' } },
  { index: 1, description: '这是一个超过六十个字符上限的长描述样本用于验证截断行为abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ', status: 'FAILED', action: { type: 'fill', target: { field: 'q' }, value: 'SECRET_TEXT_SHOULD_NOT_LEAK' }, verification: { type: 'text_present', expect: 'x' } },
  { index: 2, description: '', status: 'PENDING', action: null, verification: null },
];

const SNIPPET = [
  "const m = require(" + JSON.stringify(MOD) + ");",
  "const r = m.buildActionsSummary(" + JSON.stringify(SAMPLE) + ");",
  "console.log('LEN=' + r.length);",
  "console.log('T0=' + r[0].type);",
  "console.log('T1=' + r[1].type);",
  "console.log('LEAK=' + JSON.stringify(r).includes('SECRET_TEXT_SHOULD_NOT_LEAK'));",
  "console.log('DESC1_LEN=' + r[1].desc.length);",
  "console.log('T2=' + String(r[2].type));",
  "console.log('EMPTY=' + JSON.stringify(m.buildActionsSummary([])));",
  "console.log('NONARR=' + JSON.stringify(m.buildActionsSummary(null)));",
].join('\n');

function runOnce(round) {
  console.log('--- round ' + round + ' ---');
  let out = '';
  try {
    // 仅注入 dummy key 以通过模块加载门禁——测试只调用纯函数 buildActionsSummary，绝不执行 benchmark。
    out = execFileSync(process.execPath, ['-e', SNIPPET], { encoding: 'utf8', timeout: 20000, env: Object.assign({}, process.env, { DEEPSEEK_API_KEY: 'test-gate-only' }) });
  } catch (e) {
    check('round' + round + ' 子进程执行成功', false, e.message);
    return;
  }
  const get = (k) => { const m = out.match(new RegExp(k + '=(.*)')); return m ? m[1] : null; };

  check('round' + round + ' 摘要长度=步数', get('LEN') === '3', out);
  check('round' + round + ' action.type 透出（navigate/fill）', get('T0') === 'navigate' && get('T1') === 'fill');
  check('round' + round + ' 摘要不含 value 明文（敏感/普通一概不透出）', get('LEAK') === 'false');
  check('round' + round + ' desc 截断到 60 字符', Number(get('DESC1_LEN')) === 60, get('DESC1_LEN'));
  check('round' + round + ' 无 action 容错（type=null）', get('T2') === 'null');
  check('round' + round + ' 空数组 → []', get('EMPTY') === '[]');
  check('round' + round + ' 非数组 → []', get('NONARR') === '[]');

  // 接线：runScenario 返回记录使用 buildActionsSummary（恰好一处），保证 jsonl/JSON/worker 全链路携带
  const src = fs.readFileSync(MOD, 'utf8');
  const hits = (src.match(/actions: buildActionsSummary\(steps\)/g) || []).length;
  check('round' + round + ' runScenario 返回接线恰好一处', hits === 1, hits);
  check('round' + round + ' buildActionsSummary 已导出', /module\.exports = \{[^}]*buildActionsSummary[^}]*\}/.test(src));
}

runOnce(1);
runOnce(2);
console.log('==== test_task_actions_summary: ' + pass + ' pass / ' + fail + ' fail ====');
process.exit(fail ? 1 : 0);
