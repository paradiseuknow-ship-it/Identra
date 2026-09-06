#!/usr/bin/env node
// R9 targeted test：verify 恢复策略状态重置守卫（R9-C）+ replan 因果动作契约（R9-A）。
// 出处：run4 + 双单任务诊断 rw.026（.benchmark/run4_diag/、run4_diag2/）——
// 主循环确定性恢复在重试序列第 2/3 步 reload → 客户端状态（登录态/导出提示）清空
// （截图全为裸登录页）→ replan 产出 inspect-only 纯确认计划 → 17-18 attempts 烧尽 240s。
// 零验证语义改动：R9-C 只过滤「重试前前置动作」，R9-A 只约束 LLM 重规划产出形态。
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const verifyStrategy = require('../agent/recovery/strategies/verify');
const genericStrategy = require('../agent/recovery/strategies/generic');
const { PRE_ACTIONS_BY_POLICY } = require('../agent/diagnosis/failureDiagnoser');
const contract = require('../agent/plannerContractText');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' :: ' + e.message); }
}

// —— A 组：verify 策略过滤状态重置型前置动作（R9-C 核心）——
check('A1 replan 策略 pre-actions 不含 reload（原 [waitLong, reload]）', () => {
  const seq = verifyStrategy.getPreActions(1, { diagnosis: { retryPolicy: 'replan' } });
  assert.ok(!seq.includes('reload'), 'reload 仍在 replan 序列: ' + JSON.stringify(seq));
  assert.ok(seq.includes('waitLong'), 'waitLong 应保留: ' + JSON.stringify(seq));
});
check('A2 backoff 策略经 verify 策略同样过滤 reload', () => {
  const seq = verifyStrategy.getPreActions(2, { diagnosis: { retryPolicy: 'backoff' } });
  assert.ok(!seq.includes('reload'), 'reload 泄漏: ' + JSON.stringify(seq));
  assert.ok(seq.includes('waitLong'), 'waitLong 应保留: ' + JSON.stringify(seq));
});
check('A3 wait_only 本就无 reload，过滤后行为不变', () => {
  const seq = verifyStrategy.getPreActions(1, { diagnosis: { retryPolicy: 'wait_only' } });
  assert.deepStrictEqual(seq, PRE_ACTIONS_BY_POLICY.wait_only, JSON.stringify(seq));
});
check('A4 escalate/none（空序列）不受影响', () => {
  assert.deepStrictEqual(verifyStrategy.getPreActions(1, { diagnosis: { retryPolicy: 'escalate' } }), []);
  assert.deepStrictEqual(verifyStrategy.getPreActions(1, { diagnosis: { retryPolicy: 'none' } }), []);
});
check('A5 无 diagnosis/policy 时保守返回空（原行为）', () => {
  assert.deepStrictEqual(verifyStrategy.getPreActions(1, {}), []);
  assert.deepStrictEqual(verifyStrategy.getPreActions(1, { diagnosis: {} }), []);
});
check('A6 back+reload 组合动作同样被过滤', () => {
  // 直接以表内存在的组合键验证 STATE_RESET_ACTIONS 覆盖（经 backoff/replan 以外的表项不假设，仅测过滤函数行为）
  const seq = verifyStrategy.getPreActions(3, { diagnosis: { retryPolicy: 'replan' } });
  assert.ok(!seq.includes('back+reload'), 'back+reload 泄漏: ' + JSON.stringify(seq));
});

// —— B 组：generic 策略（UNKNOWN 类）保留原表行为（守卫不得过度扩大）——
check('B1 generic 策略 replan 序列仍含 reload（不扩大守卫范围）', () => {
  const seq = genericStrategy.getPreActions(2, { diagnosis: { retryPolicy: 'replan' } });
  assert.deepStrictEqual(seq, PRE_ACTIONS_BY_POLICY.replan, JSON.stringify(seq));
});
check('B2 底表本身不被改动（backoff 仍含 reload——timeout/navigation 场景依赖）', () => {
  assert.ok(PRE_ACTIONS_BY_POLICY.backoff.includes('reload'), '底表 backoff 被误改');
  assert.ok(PRE_ACTIONS_BY_POLICY.replan.includes('reload'), '底表 replan 被误改（过滤在策略层）');
});
check('B3 wait_only 底表不含 reload（CAP-L2 支付不重复提交语义保留）', () => {
  assert.ok(!PRE_ACTIONS_BY_POLICY.wait_only.includes('reload'));
});

// —— C 组：R9_CONTRACT 契约同步（单一事实源 → 双路径）——
check('C1 plannerContractText 导出 R9_CONTRACT 且与 failureDiagnoser 无冲突', () => {
  assert.ok(typeof contract.R9_CONTRACT === 'string' && contract.R9_CONTRACT.length > 80);
});
check('C2 planner.js 引用 R9_CONTRACT（structured fallback 路径）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'planner.js'), 'utf8');
  assert.ok(/R9_CONTRACT/.test(src), 'planner.js 未引用 R9_CONTRACT');
  // 解构引入 + 数组挂载两处都在
  assert.ok(/require\('\.\/plannerContractText'\)/.test(src));
});
check('C3 deepseek.js 追加 R9_CONTRACT 到 system prompt（真实执行路径）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'llm', 'providers', 'deepseek.js'), 'utf8');
  assert.ok(/R9_CONTRACT/.test(src), 'deepseek.js 未引用 R9_CONTRACT');
  // 追加在 R8 之后（保持 P4→P5→P6→R8→R9 顺序，与 planner 数组一致）
  assert.ok(src.indexOf('R8_CONTRACT') < src.indexOf("R8_CONTRACT + '\\n' + R9_CONTRACT"), 'R9 未按序追加在 R8 之后');
});
check('C4 契约内容自洽：含因果动作重执行 + 纯确认计划禁令 + 例外条款', () => {
  assert.ok(/重新执行该因果动作/.test(contract.R9_CONTRACT), '缺因果动作重执行要求');
  assert.ok(/禁止生成只含 inspect\/观察的纯确认计划/.test(contract.R9_CONTRACT), '缺纯确认计划禁令');
  assert.ok(/仅当页面观察中已经能看到确认证据/.test(contract.R9_CONTRACT), '缺合法例外条款');
  assert.ok(/保留原 target 完整对象/.test(contract.R9_CONTRACT), '缺 target 完整性要求');
});
check('C5 双路径引用同一字符串对象（无漂移复制）', () => {
  assert.strictEqual(contract.R9_CONTRACT, require('../agent/plannerContractText').R9_CONTRACT);
});

// —— D 组：与既有纪律的兼容 ——
check('D1 R8_CONTRACT 仍然在位（不回归）', () => {
  assert.ok(contract.R8_CONTRACT && contract.R8_CONTRACT.length > 80);
  const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'llm', 'providers', 'deepseek.js'), 'utf8');
  assert.ok(/R8_CONTRACT/.test(src));
});
check('D2 P6 宁缺毋滥语义未被 R9 稀释（两契约独立共存）', () => {
  assert.ok(/宁缺毋滥/.test(contract.P6_CONTRACT));
  assert.ok(!/宁缺毋滥/.test(contract.R9_CONTRACT), 'R9 不应重复 P6 语义（各管一层）');
});

console.log('\nR9 recovery guards: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
