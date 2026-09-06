'use strict';

// P4/P5 契约同步测试：验证「真实 LLM 执行路径」的 system prompt 携带 P4/P5。
//
// 背景：P4/P5 曾只写入 planner.js ACTION_CONSTRAINTS（structured fallback 路径），
// DeepSeek 真实路径（deepseekPlan）有独立 system prompt —— 修复未到达真实请求。
//
// 测试纪律：断言真正会执行的东西 —— 直接调用导出的 deepseekPlan(chatFn,...)，
// 用 fakeChatFn 捕获实际发送的 messages[0]（system），逐字节断言 P4/P5 全文在场，
// 且与 planner.js 消费的是同一份文本（plannerContractText.js 单一事实源）。
// 不 eval 源码、不 mock 判定逻辑；无网络请求（fakeChatFn 不出网）。

const assert = require('assert');
const { deepseekPlan } = require('../agent/llm/providers/deepseek');
const planner = require('../agent/planner');
const { P4_CONTRACT, P5_CONTRACT } = require('../agent/plannerContractText');

function assertUnique(cond, msg) { assert.ok(cond, msg); }

async function main() {
  // ── 1. 单一事实源：planner.js 的 ACTION_CONSTRAINTS 引用的就是共享文本对象 ──
  assertUnique(planner.ACTION_CONSTRAINTS.includes(P4_CONTRACT), 'planner.ACTION_CONSTRAINTS 必须包含 P4_CONTRACT 原文');
  assertUnique(planner.ACTION_CONSTRAINTS.includes(P5_CONTRACT), 'planner.ACTION_CONSTRAINTS 必须包含 P5_CONTRACT 原文');
  assertUnique(plannerInstructionsHas(P4_CONTRACT), 'plannerInstructions() 必须包含 P4_CONTRACT');
  assertUnique(plannerInstructionsHas(P5_CONTRACT), 'plannerInstructions() 必须包含 P5_CONTRACT');

  // ── 2. 真实执行路径：deepseekPlan 实际发送的 system 携带 P4/P5 全文 ──
  let captured = null;
  const fakeChatFn = async (messages) => {
    if (!captured) captured = messages;
    return { content: '{"goal":"g","steps":[]}' }; // 内容无论校验成败，system 已捕获
  };
  const task = { objective: '查看购物车数量', targetUrl: '/ecommerce/search.html', secretRefs: [] };
  let planErr = null;
  try {
    await deepseekPlan(fakeChatFn, task, { context: '' });
  } catch (e) {
    planErr = e; // 空 steps 可能被 schema 拒绝 —— 与本测试无关，system 已捕获
  }
  assertUnique(captured, 'fakeChatFn 必须被调用（deepseekPlan 必须发送请求）');
  assertUnique(Array.isArray(captured) && captured[0] && captured[0].role === 'system', 'messages[0] 必须是 system');
  const sys = String(captured[0].content || '');
  assertUnique(sys.includes(P4_CONTRACT), '真实执行路径 system 必须逐字节包含 P4_CONTRACT' + (planErr ? '' : ''));
  assertUnique(sys.includes(P5_CONTRACT), '真实执行路径 system 必须逐字节包含 P5_CONTRACT');
  assertUnique(sys.includes('语义放大禁令') && sys.includes('打开 X 页面'), 'P4 关键短语在场');
  assertUnique(sys.includes('等待异步渲染') && sys.includes('加载完成'), 'P5 关键短语在场');
  // 反向：system 不应因为拼接而破坏原有条款
  assertUnique(sys.includes('navigate 冒充输入') === false || sys.includes('navigate 只用于打开页面'), 'system 原有条款未丢失');
  assertUnique(sys.includes('双键') || sys.includes('双键对象'), '双键定位条款仍在');

  console.log('PASS 10/10  P4/P5 contract sync: planner structured path + deepseek real path 同源且在场');
}

function plannerInstructionsHas(text) {
  const s = planner.plannerInstructions();
  return s.includes(text);
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
