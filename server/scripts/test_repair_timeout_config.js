'use strict';

// 修复编排超时（REPAIR_TIMEOUT_MS）可配置化 — 针对性回归测试
//
// 背景（dl240 基线 rw.026/046 新显形）：retry 耗尽后的修复编排含「真实 LLM 诊断 + 至多
// 3 次浏览器修复动作」，硬编码 90s 预算真实跑不完 → Promise.race 超时 REPAIR_TIMEOUT
// → 可修复失败被误收口 FAILED。修复：runtime 新增 FPB_REPAIR_TIMEOUT_MS 覆盖入口
// （默认 90000 零变化，解析失败/0/负数一律回退）；phase12 --task-deadline 联动推导
// max(90000, deadline/2)（用户显式 env 优先，默认路径零副作用）。
//
// 纪律：只加配置入口，不改默认值/评分语义/修复编排行为。

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-repairto-'));

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  PASS', name); })
    .catch((e) => { console.error('  FAIL', name, '-', e && e.message); process.exitCode = 1; });
}

// 纯函数解析器 = run() 内真正执行的求值代码（resolveRepairTimeoutMs(process.env.FPB_REPAIR_TIMEOUT_MS)）。
// 子进程 require runtime.js（test_replan_step_ids 已验证 FPB_DATA_DIR 隔离下 require 安全），
// 对「真实导出的解析函数」以各 env 值求值断言。
function resolveWith(envVal) {
  const code = 'process.env.FPB_DATA_DIR=' + JSON.stringify(tmpData) + ';'
    + 'const m=require(process.argv[1]);'
    + 'console.log(m.resolveRepairTimeoutMs(' + JSON.stringify(envVal) + '));';
  const r = spawnSync(process.execPath, ['-e', code, path.join(__dirname, '..', 'agent', 'runtime.js')], {
    env: Object.assign({}, process.env, { DEEPSEEK_API_KEY: 'test-dummy', FPB_REPAIR_TIMEOUT_MS: '' }),
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error('子进程退出 ' + r.status + ': ' + (r.stderr || '').slice(0, 300));
  const n = parseInt(String(r.stdout).trim(), 10);
  if (!Number.isFinite(n)) throw new Error('无法解析输出: ' + r.stdout);
  return n;
}

function src() {
  return fs.readFileSync(path.join.apply(path, [__dirname].concat(Array.prototype.slice.call(arguments))), 'utf8');
}

async function main() {
  await ok('T1 默认零变化：undefined → 90000', () => {
    const n = resolveWith(undefined);
    if (n !== 90000) throw new Error('期望 90000，实际 ' + n);
  });

  await ok('T2 env 显式覆盖：150000 → 150000', () => {
    const n = resolveWith('150000');
    if (n !== 150000) throw new Error('期望 150000，实际 ' + n);
  });

  await ok('T3 env 非法（abc）→ 90000 默认回退', () => {
    const n = resolveWith('abc');
    if (n !== 90000) throw new Error('期望 90000，实际 ' + n);
  });

  await ok('T3b env 非法（0）→ 90000 默认回退', () => {
    const n = resolveWith('0');
    if (n !== 90000) throw new Error('期望 90000，实际 ' + n);
  });

  await ok('T3c env 非法（负数）→ 90000 默认回退', () => {
    const n = resolveWith('-5000');
    if (n !== 90000) throw new Error('期望 90000，实际 ' + n);
  });

  await ok('T4 run() 内求值接线：resolveRepairTimeoutMs(process.env.FPB_REPAIR_TIMEOUT_MS)', () => {
    const s = src('..', 'agent', 'runtime.js');
    if (!/const REPAIR_TIMEOUT_MS = resolveRepairTimeoutMs\(process\.env\.FPB_REPAIR_TIMEOUT_MS\);/.test(s)) {
      throw new Error('run() 必须经解析器求值 env（否则 env 覆盖不生效）');
    }
  });

  await ok('T5 phase12：--task-deadline 联动推导 max(90000, deadline/2)', () => {
    const s = src('phase12Benchmark.js');
    if (!/Math\.max\(90000, Math\.floor\(v \/ 2\)\)/.test(s)) {
      throw new Error('联动推导公式缺失');
    }
    const presetIdx = s.indexOf('FPB_REPAIR_TIMEOUT_MS');
    const reqIdx = s.indexOf("const P9 = require('./phase10Benchmark')");
    if (presetIdx < 0 || presetIdx > reqIdx) throw new Error('推导必须在 require 之前（worker env 继承链）');
  });

  await ok('T6 phase12：用户显式 FPB_REPAIR_TIMEOUT_MS 优先不被覆盖', () => {
    const s = src('phase12Benchmark.js');
    // 推导必须在「未显式设置」分支内：Number.isFinite(cur) && cur > 0 时跳过
    if (!/if \(!\(Number\.isFinite\(cur\) && cur > 0\)\)/.test(s)) {
      throw new Error('缺少显式 env 优先守卫');
    }
  });

  await ok('T7 phase12：repair 预算写入在 v>0 分支内（R1 后默认路径按 canonical 240s 预设 120s）', () => {
    const s = src('phase12Benchmark.js');
    // 写入必须在 if (v > 0) 分支内
    const preset = s.slice(s.indexOf('(function presetTaskDeadlineEnv'), s.indexOf('})();', s.indexOf('presetTaskDeadlineEnv')));
    if (!/if \(v > 0\) \{[\s\S]*FPB_REPAIR_TIMEOUT_MS/.test(preset)) {
      throw new Error('FPB_REPAIR_TIMEOUT_MS 写入必须在 v>0 分支内（默认路径零副作用）');
    }
  });

  await ok('T8 runtime：resolveRepairTimeoutMs 导出（可审计面）', () => {
    const s = src('..', 'agent', 'runtime.js');
    if (!/module\.exports = \{[^}]*resolveRepairTimeoutMs[^}]*\}/.test(s)) throw new Error('未导出');
  });

  await ok('T9 run() 内消费点唯一：race 超时仍消费 REPAIR_TIMEOUT_MS 变量', () => {
    const s = src('..', 'agent', 'runtime.js');
    const uses = (s.match(/REPAIR_TIMEOUT_MS/g) || []).length;
    if (uses < 3) throw new Error('消费点缺失（定义+RACE_CREATED 文案+setTimeout 收口），当前 ' + uses);
  });

  console.log(`\nrepair-timeout config: ${passed} passed, ${process.exitCode ? 'FAILED' : 'all green'}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
