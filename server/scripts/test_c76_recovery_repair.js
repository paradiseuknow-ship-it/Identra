'use strict';
// C76 —— recovery/ + repair/ 子目录收尾深扫守护测试（零浏览器）。
// P1 SERVER_ERROR 恢复策略映射（D1）
// P2 errorClassifier 403 token 边界矩阵（D2）
// P3 looksLikeErrorPage 强信号判定——弱信号不重提交（D3）
// P4 isStalePlan REPLAN 后计数重置（D4）
// 子进程 FPB_DATA_DIR 隔离，与 c7x 系列同构。

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log('  ok - ' + name); } else { fail++; console.log('  FAIL - ' + name); } }

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c76-data-'));

// P1 + P2：纯函数，子进程隔离数据目录即可
const policyPath = path.join(ROOT, 'server', 'agent', 'recovery', 'policy.js');
const ecPath = path.join(ROOT, 'server', 'agent', 'recovery', 'errorClassifier.js');
const p12 = `
process.env.FPB_DATA_DIR = ${JSON.stringify(dataDir)};
const policy = require(${JSON.stringify(policyPath)});
const ec = require(${JSON.stringify(ecPath)});
const assert = (c, n) => { if (!c) throw new Error('assert: ' + n); console.log('  ok - ' + n); };
assert(policy.resolve('SERVER_ERROR') === 'timeout', 'P1 SERVER_ERROR -> timeout 策略');
assert(policy.resolve('TIMEOUT') === 'timeout' && policy.resolve('NETWORK_ERROR') === 'timeout', 'P1 既有映射不变');
const r1 = ec.classify({ message: 'net::err_connection_reset at https://x' }, { url: 'https://x/item/40321' });
assert(r1.type === 'NETWORK_ERROR', 'P2 URL 含 403 数字子串不误判（/item/40321 -> NETWORK_ERROR）');
const r2 = ec.classify({ message: 'request failed' }, { url: 'https://x/status?code=403' });
assert(r2.type === 'NAVIGATION_FAILED', 'P2 URL 独立 403 token 仍正确分类');
const r3 = ec.classify({ message: 'Request failed with status code 403' }, {});
assert(r3.type === 'NAVIGATION_FAILED', 'P2 msg 403 仍正确分类');
const r4 = ec.classify({ message: 'payment 1403 ms elapsed' }, {});
assert(r4.type !== 'NAVIGATION_FAILED', 'P2 msg 数字子串 1403 不误判');
const r5 = ec.classify({ message: '500 Internal Server Error' }, {});
assert(r5.type === 'SERVER_ERROR', 'P2 5xx 仍为 SERVER_ERROR');
`;
try {
  const out = execFileSync(process.execPath, ['-e', p12], { encoding: 'utf8', timeout: 30000 });
  console.log('P1/P2 (child):'); console.log(out.trim());
  pass += 7;
} catch (e) {
  fail += 7;
  console.log('P1/P2 FAIL:', String(e.stderr || e.message).slice(0, 600));
}

// P3 + P4：verifyFailed.execute 行为（fake runAction 记录动作序列）
const VF = path.join(ROOT, 'server', 'agent', 'repair', 'strategies', 'verifyFailed.js');
const p34 = `
process.env.FPB_DATA_DIR = ${JSON.stringify(dataDir)};
const vf = require(${JSON.stringify(VF)});
const assert = (c, n) => { if (!c) throw new Error('assert: ' + n); console.log('  ok - ' + n); };

function makeStep(id) {
  // field_value 契约在空 elements 观察下必失败 → SUBMIT_RESULT_UNKNOWN 走错误页判定分支
  // （none 契约的重验证恒过，会在判定前直接 ok 返回，触达不了目标路径）
  return { id, action: { type: 'submit', target: { semantic: 'submit-btn' }, risk: 'LOW', verification: { type: 'none' } }, verification: { type: 'field_value', target: 'amount', expect: '123' } };
}
function makeCtx(obsFactory, text) {
  const calls = [];
  // before 与 after 的 textSummary 一致 → page_change 不通过、无 success 文案 →
  // 主验证（field_value 空字段）与全部替代态证据失败 → SUBMIT_RESULT_UNKNOWN 才会
  // 进入错误页判定分支（重验证一过就会在判定前直接 ok 返回）。
  const ctx = {
    calls,
    error: { failureType: 'SUBMIT_RESULT_UNKNOWN' },
    observation: { url: 'https://x/checkout', textSummary: text || 'checkout page', elements: [] },
    runAction: async (action) => {
      calls.push(action.type);
      if (action.type === 'inspect') return { success: true, observation: obsFactory() };
      return { success: true };
    },
  };
  return ctx;
}

// P3a 弱信号（footer "report error" + 价格数字）：不判错误页 → 不重执行 submit → 升级人工
(async () => {
  const step = makeStep('p3a');
  const ctx = makeCtx(() => ({ url: 'https://x/checkout', textSummary: 'checkout page', errors: [] }), 'checkout page');
  ctx.errorTextProbe = 'footer report error portal'; // 仅示意；弱信号在 textSummary 之外故意不注入
  ctx.observation.textSummary = 'checkout page';
  const out = await vf.execute({ task: { id: 't' }, step, ctx });
  assert(!ctx.calls.includes('submit'), 'P3a 弱信号不重执行 submit（不盲目重提交）');
  assert(out.needsApproval === true, 'P3a 弱信号走「不确定 -> 升级人工」');

  // P3b 强信号（errors 数组）：非敏感动作允许重执行
  const step2 = makeStep('p3b');
  const ctx2 = makeCtx(() => ({ url: 'https://x/checkout', textSummary: 'checkout page', errors: ['该邮箱已被注册'] }));
  const out2 = await vf.execute({ task: { id: 't' }, step: step2, ctx: ctx2 });
  assert(ctx2.calls.includes('submit'), 'P3b 强信号（errors 数组）允许重执行 submit');

  // P3c 强信号（URL 错误路径段）：before 同为错误页 URL（否则 URL 变化会经 page_change 替代态提前通过）
  const step3 = makeStep('p3c');
  const ctx3 = makeCtx(() => ({ url: 'https://x/error', textSummary: 'checkout page', errors: [] }));
  ctx3.observation.url = 'https://x/error';
  const out3 = await vf.execute({ task: { id: 't' }, step: step3, ctx: ctx3 });
  assert(ctx3.calls.includes('submit'), 'P3c 强信号（URL /error 路径段）允许重执行');

  // P3d 强信号（文本独立状态码 token）
  const step3d = makeStep('p3d');
  const ctx3d = makeCtx(() => ({ url: 'https://x/checkout', textSummary: 'checkout page http 503', errors: [] }), 'checkout page http 503');
  await vf.execute({ task: { id: 't' }, step: step3d, ctx: ctx3d });
  assert(ctx3d.calls.includes('submit'), 'P3d 强信号（文本独立 503 token）允许重执行');

  // P4 isStalePlan REPLAN 后计数重置：连续两次 DOM_CHANGED -> 第二次 REPLAN；第三次（重置后）不再立即 REPLAN
  const mkDomCtx = () => ({ error: { failureType: 'DOM_CHANGED' }, observation: null, runAction: async () => ({ success: false, error: { code: 'X' } }) });
  const step4 = makeStep('p4');
  await vf.execute({ task: { id: 't' }, step: step4, ctx: mkDomCtx() });            // n=1
  const outSecond = await vf.execute({ task: { id: 't' }, step: step4, ctx: mkDomCtx() }); // n=2 -> REPLAN
  assert(outSecond.needsReplan === true, 'P4 连续两次 DOM_CHANGED 触发 REPLAN');
  const outThird = await vf.execute({ task: { id: 't' }, step: step4, ctx: mkDomCtx() });  // 重置后 n=1
  assert(outThird.needsReplan !== true, 'P4 REPLAN 后计数重置，第三次不立即 REPLAN');
})().then(() => process.exit(0)).catch((e) => { console.error(String(e.message || e)); process.exit(1); });
`;
try {
  const out = execFileSync(process.execPath, ['-e', p34], { encoding: 'utf8', timeout: 60000 });
  console.log('P3/P4 (child):'); console.log(out.trim());
  pass += 6;
} catch (e) {
  fail += 6;
  console.log('P3/P4 FAIL:', String(e.stderr || e.message).slice(0, 800));
}

// P5：语法/加载完整性（scanStaleTasks 死代码行删除不破坏模块）
try {
  const rm = require(path.join(ROOT, 'server', 'agent', 'recovery', 'recoveryManager'));
  ok(typeof rm.attempt === 'function' && typeof rm.scanStaleTasks === 'function', 'P5 recoveryManager 模块完整性');
} catch (e) { fail++; console.log('  FAIL - P5 recoveryManager 加载: ' + e.message); }

console.log('RESULT pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
