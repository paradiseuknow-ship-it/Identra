'use strict';

// P1 targeted test：JSON parse failure 加固（2026-09-01，Final100 rw.063/rw.091 归因后）。
//
// 归因结论（token 取证）：两任务 tokensCompletion 均=18432=9×2048 —— 3 次外层 planner
// attempt × 3 次内层 deepseek 重试，9 次规划调用全部打满 max_tokens:2048 上限被截断，
// JSON 半途而废 → 提取必败 → lastHint='JSON 解析失败' → 同参数重试 → 确定性 9/9 失败。
//
// 修复契约（本测试锁定）：
//   A. 正常 JSON → 原样解析成功（recovered='RAW'）
//   B. ```json 围栏 → 成功提取（recovered='FENCE'）
//   C. JSON 前后有解释文本 → 成功提取（recovered='SLICE'）
//   D. 多余 whitespace → 成功
//   E. 非法 JSON（trailing comma 等）→ 必须拒绝（不得替模型修语义）
//   F. 截断 JSON → 必须拒绝（截断=模型未表达完整，parser 禁止恢复缺失步骤）
//   G. schema-invalid 但可解析 → parser ok:true，必须继续被 validatePlanStrict 拒绝
//   H. credentialRef/value 安全语义不得被 parser 修改（deep-equal）
//   I. 解释文本含大括号 + 围栏 JSON → 优先围栏候选，不被大括号切片污染
//   J. 末尾未闭合围栏（内含完整 JSON）→ 可恢复
//   K. 空/无 JSON 输出 → 拒绝
//   L. deepseekPlan 集成：围栏计划 → ok:true，且 maxTokens 上调为 8192
//   M. deepseekPlan 集成：finish_reason=length 截断 → 错误信息必须含「截断」标识（可审计，
//      不再伪装成 'JSON 解析失败'），且仍重试 3 次后收口
//   N. deepseekPlan 集成：可解析但 schema 违规 → 错误为 schema 文案而非解析失败
//   O. provider.structured（共用同一提取模块）：围栏输出可恢复；非法输出仍 INVALID_JSON
//
// 纪律：只做外壳规范化；不猜字段/不补字段/不 canonicalize；schema/Success Definition 零改动。

const os = require('os');
const path = require('path');
const fs = require('fs');

// 隔离 FPB_DATA_DIR：必须在 require 任何 agent 模块之前设置（避免污染真实 store）
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-json-extract-'));
process.env.FPB_DATA_DIR = tmpData;

const assert = require('assert');
const { extractJsonCandidate } = require('../agent/llm/jsonExtract');
const { deepseekPlan } = require('../agent/llm/providers/deepseek');
const { createProvider, register } = require('../agent/llm/provider');
const { validatePlanStrict } = require('../agent/schema/plan');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log('  PASS ' + name); runNext(); })
    .catch((e) => { fail++; failures.push(name + ' :: ' + String(e.message || e).slice(0, 240)); console.log('  FAIL ' + name + ' :: ' + String(e.message || e).slice(0, 240)); runNext(); });
}

const PLAN = {
  steps: [
    { action: 'navigate', target: { url: '/data_entry/form.html' }, semantic: '打开表单页', expectedResult: '表单页加载完成', verification: { type: 'url_contains', expect: 'form.html' } },
    { action: 'fill', target: { field: 'phone', semantic: '手机号输入框' }, value: '13800000001', semantic: '录入手机号', expectedResult: '已填入', verification: { type: 'element_present', expect: 'input[name="phone"]' } },
  ],
};

function validStrictPlanText() {
  return JSON.stringify({ steps: [
    { action: 'navigate', target: { url: '/x.html', semantic: '打开页面' }, semantic: '打开', expectedResult: '页面加载', verification: { type: 'url_contains', expect: 'x.html' } },
    { action: 'click', target: { field: 'btn', semantic: '按钮' }, semantic: '点击', expectedResult: '已点击', verification: { type: 'text_present', expect: 'OK' } },
  ] });
}

const tests = [];

// A. 正常 JSON
tests.push(['A 正常 JSON → RAW 解析成功', () => {
  const r = extractJsonCandidate(JSON.stringify(PLAN));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.json, PLAN);
  assert.strictEqual(r.recovered, 'RAW');
}]);

// B. ```json 围栏
tests.push(['B json 围栏 → FENCE 提取', () => {
  const r = extractJsonCandidate('```json\n' + JSON.stringify(PLAN) + '\n```');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.json, PLAN);
  assert.strictEqual(r.recovered, 'FENCE');
}]);

// C. 前后解释文本
tests.push(['C 前后解释文本 → SLICE 提取', () => {
  const r = extractJsonCandidate('好的，以下是计划：\n' + JSON.stringify(PLAN) + '\n以上计划请确认。');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.json, PLAN);
  assert.strictEqual(r.recovered, 'SLICE');
}]);

// D. whitespace
tests.push(['D 多余 whitespace → 成功', () => {
  const r = extractJsonCandidate('\n\n   \n' + JSON.stringify(PLAN, null, 4) + '  \n\n');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.json, PLAN);
}]);

// E. 非法 JSON（trailing comma）→ 拒绝
tests.push(['E 非法 JSON trailing comma → 拒绝', () => {
  const bad = '{"steps":[{"action":"click","verification":{"type":"text_present","expect":"OK",},}],}';
  const r = extractJsonCandidate(bad);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'UNPARSEABLE');
}]);

// F. 截断 JSON → 拒绝（模拟 max_tokens 半途截断）
tests.push(['F 截断 JSON → 必须拒绝', () => {
  const full = JSON.stringify(PLAN);
  const truncated = full.slice(0, Math.floor(full.length * 0.6)); // 半途切断
  const r = extractJsonCandidate(truncated);
  assert.strictEqual(r.ok, false, '截断输出不得被恢复');
}]);

// G. 可解析但 schema 违规 → parser ok，schema gate 拒绝
tests.push(['G schema-invalid 可解析 → parser ok 且 schema 拒绝', () => {
  const bad = JSON.stringify({ steps: [{ foo: 'bar' }] });
  const r = extractJsonCandidate(bad);
  assert.strictEqual(r.ok, true, 'parser 层只负责外壳，解析应当成功');
  const vr = validatePlanStrict(r.json);
  assert.strictEqual(vr.ok, false, 'schema gate 必须继续拒绝');
  assert.ok((vr.errors || []).length > 0);
}]);

// H. credentialRef/value 语义零修改
tests.push(['H credentialRef/value 语义不被 parser 修改', () => {
  const obj = {
    steps: [
      { action: 'fill', target: { field: 'password', semantic: '密码' }, credentialRef: 'cred_abc123', semantic: '填密码', expectedResult: '已填入', verification: { type: 'element_present', expect: 'input[type="password"]' } },
      { action: 'fill', target: { field: 'email', semantic: '邮箱' }, value: 'user@example.com', semantic: '填邮箱', expectedResult: '已填入', verification: { type: 'element_present', expect: 'input[name="email"]' } },
    ],
  };
  const wrapped = '```json\n' + JSON.stringify(obj) + '\n```\n计划如上';
  const r = extractJsonCandidate(wrapped);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.json.steps[0].credentialRef, 'cred_abc123');
  assert.strictEqual(r.json.steps[1].value, 'user@example.com');
  assert.deepStrictEqual(r.json, obj, '解析结果必须与原对象逐字 deep-equal');
}]);

// I. 解释文本含大括号 + 围栏 JSON → 优先围栏
tests.push(['I 前置文本含大括号 + 围栏 → 不被污染', () => {
  const r = extractJsonCandidate('配置格式参考 {field: xx, semantic: yy}，实际计划如下：\n```json\n' + JSON.stringify(PLAN) + '\n```');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.json, PLAN);
  assert.strictEqual(r.recovered, 'FENCE');
}]);

// J. 末尾未闭合围栏
tests.push(['J 未闭合围栏内完整 JSON → 可恢复', () => {
  const r = extractJsonCandidate('```json\n' + JSON.stringify(PLAN)); // 生成被截断在围栏未闭合处（但 JSON 本体完整）
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.json, PLAN);
}]);

// K. 空/无 JSON
tests.push(['K 空输出与无 JSON 文本 → 拒绝', () => {
  assert.strictEqual(extractJsonCandidate('').ok, false);
  assert.strictEqual(extractJsonCandidate('  ').ok, false);
  const r = extractJsonCandidate('抱歉，我无法完成该任务。');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'UNPARSEABLE');
}]);

// ---- deepseekPlan 集成 ----

function strictPlanText() { return validStrictPlanText(); }

// L. 围栏计划 → ok:true + maxTokens=8192
tests.push(['L deepseekPlan 围栏计划成功 + maxTokens=8192', async () => {
  const calls = [];
  const chatFn = async (messages, opts) => { calls.push(opts); return { content: '```json\n' + strictPlanText() + '\n```', finishReason: 'stop' }; };
  const r = await deepseekPlan(chatFn, { objective: '打开页面并点击按钮', targetUrl: '/x.html' }, {});
  assert.strictEqual(r.ok, true, '围栏计划应成功: ' + JSON.stringify(r));
  assert.strictEqual(r.plan.steps.length, 2);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].maxTokens, 8192, '规划调用 maxTokens 必须是 8192（截断根因修复）');
}]);

// M. finish_reason=length → 截断标识可审计
tests.push(['M deepseekPlan 截断 → 错误含截断标识且重试收口', async () => {
  const full = strictPlanText();
  let calls = 0;
  const chatFn = async () => { calls++; return { content: full.slice(0, Math.floor(full.length * 0.5)), finishReason: 'length' }; };
  const r = await deepseekPlan(chatFn, { objective: '长流程任务' }, {});
  assert.strictEqual(r.ok, false);
  assert.ok(/截断/.test(r.error), '错误必须携带截断标识（可审计），实际: ' + r.error);
  assert.ok(!/JSON 解析失败$/.test(r.error), '截断不得伪装成纯解析失败');
  assert.strictEqual(calls, 3, '内层仍重试 3 次后收口');
}]);

// N. 可解析但 schema 违规 → schema 文案
tests.push(['N deepseekPlan schema 违规 → schema 错误文案', async () => {
  const chatFn = async () => ({ content: JSON.stringify({ steps: [{ foo: 'bar' }] }), finishReason: 'stop' });
  const r = await deepseekPlan(chatFn, { objective: 'x' }, {});
  assert.strictEqual(r.ok, false);
  assert.ok(!/JSON 解析失败/.test(r.error), '可解析输出不得报解析失败，实际: ' + r.error);
  assert.ok(!/截断/.test(r.error));
  assert.ok(r.error.length > 0);
}]);

// O. provider.structured 共用提取模块
tests.push(['O provider.structured 围栏可恢复 / 非法仍拒绝', async () => {
  register('stub-json-extract', () => ({
    name: 'stub', model: 'stub',
    async chat() { return { content: '```json\n{"ok":true}\n```', usage: {} }; },
  }));
  const p = createProvider('stub-json-extract');
  const schema = { validate: (j) => ({ ok: true, plan: j }), instructions: 'x' };
  const out = await p.structured({ taskId: null, executionId: null }, { system: 's', prompt: 'p', schema });
  assert.deepStrictEqual(out, { ok: true });

  register('stub-json-bad', () => ({
    name: 'stub', model: 'stub',
    async chat() { return { content: '{"broken": ', usage: {} }; },
  }));
  const p2 = createProvider('stub-json-bad');
  let threw = null;
  try { await p2.structured({ taskId: null, executionId: null }, { system: 's', prompt: 'p', schema, maxRetries: 0 }); } catch (e) { threw = e; }
  assert.ok(threw, '非法 JSON 必须抛错');
  assert.strictEqual(threw.code, 'INVALID_JSON');
}]);

// ---- runner（顺序执行）----
let idx = 0;
function runNext() {
  if (idx >= tests.length) {
    console.log('\n==== test_json_extract ====');
    console.log('PASS=' + pass + ' FAIL=' + fail);
    if (failures.length) { console.log(failures.join('\n')); process.exit(1); }
    process.exit(0);
  }
  const [name, fn] = tests[idx++];
  console.log('[' + idx + '/' + tests.length + '] ' + name);
  check(name, fn);
}
runNext();
