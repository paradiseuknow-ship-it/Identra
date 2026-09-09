#!/usr/bin/env node
// C104：REPLAN 入口双重锁死修复（task_mttsa3a6bzlzm 实证驱动）
//
// 实证链：联盟链接任务 step_003「填注册邮箱」ELEMENT_NOT_FOUND（计划漏了「点击 Start for free」
// 前置步，页面停留在营销首页）→ 修复链 SEMANTIC_RELOCATE×4 耗尽 → REPAIR_TIMEOUT →
// 5.9-E3 直收 FAILED。两层缺陷：
//   D1（B 类不一致）：isReplanCandidate 只认 failureType/needsReplan，而动作工具失败只有
//      error.code——diagnoser POLICY 对元素定位族声明 'replan' 却永远到不了 replan 门。
//   D2（B 类绕过）：repairHang（REPAIR_TIMEOUT）路径直收 FAILED，完全绕过 replan 块。
// 修复：D1 = REPLAN_CANDIDATE_CODES 与 diagnoser 对齐（凭证/支付/登录仍被挡）；
//       D2 = repairHang 收口前过同一 replan 门（R5 熔断 + maxReplans 预算）。
// 红线自检：不降验证标准、凭证/支付/登录类不自动重规划、R5 熔断与 maxReplans 预算不变。

const assert = require('assert');
const fs = require('fs');
const rt = require('../agent/runtime');
const { isReplanCandidate, shouldFuseSameSigReplan } = rt;

let pass = 0, fail = 0;
function chk(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
}

// ── A 组：isReplanCandidate 认得「只有 code」的动作工具失败（D1 修复面）──
chk('A1 ELEMENT_NOT_FOUND + 普通语义字段 → replan 候选',
  isReplanCandidate({ code: 'ELEMENT_NOT_FOUND', message: '未找到元素' },
    { action: { type: 'fill', target: { semantic: '注册邮箱输入框' } } }) === true);

chk('A2 ELEMENT_NOT_INTERACTABLE → 候选',
  isReplanCandidate({ code: 'ELEMENT_NOT_INTERACTABLE' },
    { action: { type: 'click', target: { semantic: '提交按钮' } } }) === true);

chk('A3 NAVIGATION_FAILED → 候选',
  isReplanCandidate({ code: 'NAVIGATION_FAILED' },
    { action: { type: 'navigate', target: { url: 'https://x' } } }) === true);

chk('A4 密码字段 ELEMENT_NOT_FOUND → 不自动重规划（凭证红线）',
  isReplanCandidate({ code: 'ELEMENT_NOT_FOUND' },
    { action: { type: 'fill', target: { field: 'password' } } }) === false);

chk('A5 支付语义 ELEMENT_NOT_FOUND → 不自动重规划（凭证红线）',
  isReplanCandidate({ code: 'ELEMENT_NOT_FOUND' },
    { action: { type: 'click', target: { semantic: '支付提交按钮' } } }) === false);

chk('A6 登录语义 → 不自动重规划',
  isReplanCandidate({ code: 'ELEMENT_NOT_FOUND' },
    { action: { type: 'click', target: { semantic: '登录按钮' } } }) === false);

chk('A7 非 replan 族 code（TIMEOUT）→ 不是候选',
  isReplanCandidate({ code: 'TIMEOUT' },
    { action: { type: 'click', target: { semantic: '任意' } } }) === false);

chk('A8 不可重试诊断族（CAPTCHA 类 escalate code）→ 不是候选',
  isReplanCandidate({ code: 'CAPTCHA_OR_HUMAN_CHECK' },
    { action: { type: 'click' } }) === false);

// ── B 组：既有语义零回归 ──
chk('B1 failureType=DOM_CHANGED → 候选（原有）',
  isReplanCandidate({ failureType: 'DOM_CHANGED' }, { action: { type: 'click' } }) === true);
chk('B2 failureType=ACTION_REAL_FAILURE 非凭证 → 候选（原有）',
  isReplanCandidate({ failureType: 'ACTION_REAL_FAILURE' },
    { action: { type: 'click', target: { semantic: 'x' } } }) === true);
chk('B3 failureType=ACTION_REAL_FAILURE 凭证 → 否（原有）',
  isReplanCandidate({ failureType: 'ACTION_REAL_FAILURE' },
    { action: { type: 'purchase' } }) === false);
chk('B4 证据契约族 VERIFICATION_FAILED 非凭证 → 候选（原有）',
  isReplanCandidate({ failureType: 'VERIFICATION_FAILED' },
    { action: { type: 'click', target: { semantic: 'x' } } }) === true);
chk('B5 needsReplan 显式标记 → 候选（原有）',
  isReplanCandidate({ needsReplan: true }, { action: { type: 'click' } }) === true);
chk('B6 null error → false', isReplanCandidate(null, { action: { type: 'click' } }) === false);
chk('B7 VERIFY_FAILED 非凭证 → 候选（C104b：修复耗尽后验证契约错配 = plan 过期）',
  isReplanCandidate({ code: 'VERIFY_FAILED', failureType: 'EVENTUAL_CONSISTENCY' },
    { action: { type: 'click', target: { semantic: 'Start for free 按钮' } } }) === true);
chk('B8 VERIFY_FAILED 凭证语义 → 否（红线）',
  isReplanCandidate({ code: 'VERIFY_FAILED' },
    { action: { type: 'fill', target: { field: 'card' } } }) === false);
chk('B9 VERIFY_FAILED 支付语义 → 否（红线）',
  isReplanCandidate({ code: 'VERIFY_FAILED' },
    { action: { type: 'click', target: { semantic: '支付提交按钮' } } }) === false);

// ── C 组：R5 熔断纯函数（预算约束不因新入口放宽）──
chk('C1 首次允许', shouldFuseSameSigReplan(0) === false);
chk('C2 连续第 2 次同签名熔断', shouldFuseSameSigReplan(1) === true);

// ── D 组：repairHang replan 兜底接线（D2 修复面，源码结构断言）──
chk('D1 repairHang catch 内存在 C104 replan 兜底', () => {
  const src = fs.readFileSync(require.resolve('../agent/runtime'), 'utf-8');
  assert.ok(src.includes('repair orchestration timeout → regenerate remaining steps (C104)'), 'C104 事件标记缺失');
  // catch 块内：先 replan 兜底，失败才走 5.9-E3 收口
  const catchIdx = src.indexOf('[runtime][5.9-E3] repair 编排超时/异常，收口 FAILED');
  assert.ok(catchIdx > 0, 'E3 收口点缺失');
  const before = src.slice(Math.max(0, catchIdx - 3500), catchIdx);
  assert.ok(/tryReplan\(task, beforeObs, steps, index\)/.test(before), 'E3 收口前未尝试 tryReplan');
  assert.ok(/isReplanCandidate\(r\.error, step\)/.test(before), '兜底未过 replan 候选门');
  assert.ok(/maxReplansFor\(task\)/.test(before), '兜底未受 maxReplans 预算约束');
  assert.ok(/shouldFuseSameSigReplan/.test(before), '兜底未受 R5 熔断约束');
  assert.ok(/if \(!_replanned\)/.test(src.slice(catchIdx - 200, catchIdx + 200) ), 'replan 失败后未保留 FAILED 收口');
});

// ── E 组：REPLAN_CANDIDATE_CODES 与 diagnoser POLICY 对齐（防再漂移）──
chk('E1 diagnoser 元素定位族声明 replan 的 code 均已纳入候选', () => {
  const diagSrc = fs.readFileSync(require.resolve('../agent/diagnosis/failureDiagnoser'), 'utf-8');
  const rtSrc = fs.readFileSync(require.resolve('../agent/runtime'), 'utf-8');
  const codesInRuntime = (rtSrc.match(/'([A-Z_]+)'/g) || [])
    .map((s) => s.slice(1, -1));
  for (const c of ['ELEMENT_NOT_FOUND', 'ELEMENT_NOT_INTERACTABLE', 'ELEMENT_CHANGED', 'NAVIGATION_FAILED', 'DOM_CHANGED']) {
    assert.ok(diagSrc.includes(`'${c}'`), `diagnoser 缺 ${c}（前提变化，需同步本测试）`);
    assert.ok(codesInRuntime.includes(c), `runtime REPLAN_CANDIDATE_CODES 缺 ${c}`);
  }
});

console.log(`\nRESULT: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
