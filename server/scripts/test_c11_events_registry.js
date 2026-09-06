'use strict';
// C11（2026-09-06）事件注册表对账守护。
// 背景：EVENT_TYPES 白名单与生产 emit 实发类型长期漂移（smoke6 实证每次运行刷
// 「非标准事件类型」警告 5+ 次：ai.guard.passed / task.plan_from_flow / ai.verification.*）。
// 本测试做三件事：
//   T1 静态对账：扫描 server/ 全部 `type: '<事件命名空间前缀>...'` 字面量，
//      断言全部已登记（防止未来新增事件类型再漏登记）。
//   T2 白名单健康：EVENT_TYPES 无重复项。
//   T3 emit 行为：未注册类型触发 console.warn（漂移可见性不回退）。
// 命名空间前缀 = 事件语义锁（task./agent./ai./scheduler./dispatch./worker./schedule./
// execution./observability.），业务对象字段（element type 等）天然不落此域。

const fs = require('fs');
const path = require('path');
const { EVENT_TYPES, emit } = require('../agent/events');

const NS_PREFIXES = ['task.', 'agent.', 'ai.', 'scheduler.', 'dispatch.', 'worker.', 'schedule.', 'execution.', 'observability.'];

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'scripts' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

function main() {
  let pass = 0, fail = 0;
  const failures = [];
  const assert = (name, ok, detail) => {
    if (ok) { pass++; console.log('PASS ' + name); }
    else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
  };

  // ---- T1: 静态对账 ----
  const serverDir = path.join(__dirname, '..');
  const files = walk(serverDir, []);
  const emitted = new Set();
  const re = /type:\s*'((?:task|agent|ai|scheduler|dispatch|worker|schedule|execution|observability)\.[\w.]+)'/;
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (m) emitted.add(m[1]);
    }
  }
  const missing = [...emitted].filter((t) => !EVENT_TYPES.includes(t));
  assert('C11-T1 生产 emit 类型全部已登记（静态对账 ' + emitted.size + ' 类）',
    missing.length === 0, '漏登记: ' + JSON.stringify(missing));

  // ---- T2: 白名单无重复 ----
  const dup = EVENT_TYPES.filter((t, i) => EVENT_TYPES.indexOf(t) !== i);
  assert('C11-T2 EVENT_TYPES 无重复项（' + EVENT_TYPES.length + ' 类）', dup.length === 0, JSON.stringify(dup));

  // ---- T3: 未注册类型触发 console.warn（漂移可见性） ----
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try { emit({ type: 'c11.probe.unregistered', payload: {} }); } catch (e) {}
  console.warn = origWarn;
  assert('C11-T3 未注册类型 emit 触发警告（漂移可见性）',
    warnings.some((w) => w.includes('c11.probe.unregistered')), JSON.stringify(warnings));
  const registered = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  try { emit({ type: 'ai.guard.passed', payload: {} }); } catch (e) {}
  console.warn = origWarn;
  assert('C11-T4 已注册类型 emit 零警告',
    !warnings.some((w) => w.includes('ai.guard.passed')), JSON.stringify(warnings));

  console.log('');
  console.log('RESULT pass=' + pass + ' fail=' + fail);
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
}

main();
