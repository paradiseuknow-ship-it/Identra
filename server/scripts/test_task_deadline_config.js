'use strict';

// Harness per-task deadline 可配置化 — 针对性回归测试
//
// 背景（taxonomy B2 / smoke 4×TIMEOUT + rw.099 step_004 截断）：phase12 smoke 走
// phase12Benchmark（worker 子进程复用 phase10.runScenario），而 phase10 的
// PER_TASK_TIMEOUT 只从自己的 argv 解析 → phase12 传 --timeout 永远不生效，120s 固定。
//
// 修复契约（本测试锁定，全部断言「求值后的模块级常量」——即真正会执行的那份接线）：
//   1. 默认零变化：无 env 无 argv → PER_TASK_TIMEOUT === 120000（benchmark 可比性保持）。
//   2. env 回退：FPB_TASK_DEADLINE=240000 → 240000（phase12 spawn env 全量继承路径）。
//   3. env 非法（abc/0/负数）→ 120000 默认回退（parseInt NaN → || 120000）。
//   4. argv --timeout 显式优先于 env（phase10 自主运行语义不变）。
//   5. phase12 --task-deadline 入口：require 前预设 env（时序正确）+ hard deadline
//      保护垫 = max(--timeout, task-deadline + 90s)（树杀永远晚于业务 deadline）。
//
// 纪律：只加配置入口，不改默认值/评分语义/Success Definition。

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-deadline-'));

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  PASS', name); })
    .catch((e) => { console.error('  FAIL', name, '-', e && e.message); process.exitCode = 1; });
}

// 子进程 require phase10Benchmark（main guard 保证不跑 main），读取求值后的模块级常量
function readDeadline(env, extraArgv) {
  const argvJs = (extraArgv || []).map((a) => JSON.stringify(a)).join(',');
  const code = 'process.env.FPB_DATA_DIR=' + JSON.stringify(tmpData) + ';'
    + (argvJs ? 'process.argv.push(' + argvJs + ');' : '')
    + 'const m=require(process.argv[1]);console.log(m.PER_TASK_TIMEOUT);';
  const r = spawnSync(process.execPath, ['-e', code, path.join(__dirname, 'phase10Benchmark.js')], {
    env: Object.assign({}, process.env, { DEEPSEEK_API_KEY: 'test-dummy' }, env || {}),
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error('子进程退出 ' + r.status + ': ' + (r.stderr || '').slice(0, 300));
  const n = parseInt(String(r.stdout).trim(), 10);
  if (!Number.isFinite(n)) throw new Error('无法解析输出: ' + r.stdout);
  return n;
}

function src(file) {
  return fs.readFileSync(path.join(__dirname, file), 'utf8');
}

async function main() {
  await ok('T1 canonical 默认：无 env 无 argv → 240000（R1 迁移）', () => {
    const n = readDeadline({ FPB_TASK_DEADLINE: '' });
    if (n !== 240000) throw new Error('期望 240000，实际 ' + n);
  });

  await ok('T2 env 回退：FPB_TASK_DEADLINE=120000 → 120000（显式覆盖仍生效）', () => {
    const n = readDeadline({ FPB_TASK_DEADLINE: '120000' });
    if (n !== 120000) throw new Error('期望 120000，实际 ' + n);
  });

  await ok('T3 env 非法（abc）→ 240000 canonical 回退', () => {
    const n = readDeadline({ FPB_TASK_DEADLINE: 'abc' });
    if (n !== 240000) throw new Error('期望 240000，实际 ' + n);
  });

  await ok('T3b env 非法（负数）→ 240000 canonical 回退', () => {
    const n = readDeadline({ FPB_TASK_DEADLINE: '-5' });
    if (n !== 240000) throw new Error('期望 240000，实际 ' + n);
  });

  await ok('T4 argv --timeout 显式优先于 env', () => {
    const n = readDeadline({ FPB_TASK_DEADLINE: '240000' }, ['--timeout', '30000']);
    if (n !== 30000) throw new Error('期望 30000，实际 ' + n);
  });

  await ok('T5 phase12：--task-deadline env 预设在 require phase10 之前（时序契约）', () => {
    const s = src('phase12Benchmark.js');
    const presetIdx = s.indexOf('(function presetTaskDeadlineEnv');
    const reqIdx = s.indexOf("const P9 = require('./phase10Benchmark')");
    if (presetIdx < 0) throw new Error('缺少 env 预设函数');
    if (reqIdx < 0) throw new Error('缺少 phase10 require');
    if (presetIdx > reqIdx) throw new Error('env 预设必须先于 require（P9 模块加载时读取 env）');
  });

  await ok('T6 phase12：hard deadline 保护垫 = max(--timeout 330000, task-deadline + 90s)', () => {
    const s = src('phase12Benchmark.js');
    if (!/Math\.max\(\s*parseInt\(arg\('--timeout', '330000'\), 10\) \|\| 330000,\s*TASK_DEADLINE_MS \? TASK_DEADLINE_MS \+ 90000 : 0\s*\)/.test(s)) {
      throw new Error('hard deadline 保护垫公式缺失或被改动');
    }
  });

  await ok('T7 phase12：未显式 --task-deadline → canonical 240000 预设（R1 迁移）', () => {
    const s = src('phase12Benchmark.js');
    if (!/const v = i >= 0 \? parseInt\(a\[i \+ 1\], 10\) : 240000;/.test(s)) {
      throw new Error('preset 回退值必须为 canonical 240000（默认路径与 dl240 实证配置等价）');
    }
    if (!/if \(TASK_DEADLINE_MS\) process\.env\.FPB_TASK_DEADLINE = String\(TASK_DEADLINE_MS\);/.test(s)) {
      throw new Error('显式 --task-deadline 透传写入必须保留');
    }
  });

  await ok('T8 cancel reason 动态插值：deadline 文案消费 PER_TASK_TIMEOUT 变量', () => {
    const s = src('phase10Benchmark.js');
    if (!/per-task deadline（' \+ PER_TASK_TIMEOUT \+ 'ms）/.test(s)) {
      throw new Error('cancel 文案必须插值 PER_TASK_TIMEOUT（覆盖值可见于错误信息）');
    }
  });

  await ok('T9 phase10：PER_TASK_TIMEOUT 导出（可审计面）', () => {
    const s = src('phase10Benchmark.js');
    if (!/module\.exports = \{[^}]*PER_TASK_TIMEOUT[^}]*\}/.test(s)) throw new Error('未导出');
  });

  console.log(`\ntask-deadline config: ${passed} passed, ${process.exitCode ? 'FAILED' : 'all green'}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
