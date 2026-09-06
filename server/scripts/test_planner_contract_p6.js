'use strict';

// P6 未来状态证据锚定契约测试（P5.2 OPT-A）。
// 断言纪律与 test_planner_contract_sync.js 一致：断言「真正会执行的那份东西」——
// 直接调用导出的 deepseekPlan(chatFn,...) 用 fakeChatFn 捕获真实发送的 system，
// 逐字节断言 P6 全文在场；planner 结构化路径经 ACTION_CONSTRAINTS / plannerInstructions
// 断言同一份文本对象（plannerContractText.js 单一事实源）。不 eval 源码、不出网。
//
// Test A — CSS hallucination ban（禁止臆测 .product-item 类 selector）
// Test B — Text hallucination ban（禁止臆测 text_present "价格" 类文案）
// Test C — Future DOM hallucination ban（未来状态必须有锚点规则）
// Test D — Known selector allowed（observation/schema 提供的事实仍可用）
// Test E — action_success allowed（动作成功语义仍是合法锚点）
// Test F — AND poison prevention（禁止经 AND 追加猜测条件）
// Test G — sync（planner fallback 路径 + deepseek 真实路径双在场）

const assert = require('assert');
const { deepseekPlan } = require('../agent/llm/providers/deepseek');
const planner = require('../agent/planner');
const { P4_CONTRACT, P5_CONTRACT, P6_CONTRACT } = require('../agent/plannerContractText');

function assertUnique(cond, msg) { assert.ok(cond, msg); }

async function main() {
  // ── 0. 事实源导出 ──
  assertUnique(typeof P6_CONTRACT === 'string' && P6_CONTRACT.length > 100, 'P6_CONTRACT 必须从 plannerContractText.js 导出且非空');

  // ── Test A: CSS hallucination ban ──
  assertUnique(P6_CONTRACT.includes('禁止臆测 CSS 类名'), 'A: 必须明文禁止凭语义名称臆测 CSS 类名/选择器');
  assertUnique(P6_CONTRACT.includes('.product-item'), 'A: 必须包含 .product-item 类幻觉实例');
  assertUnique(P6_CONTRACT.includes('一律视为不存在'), 'A: 必须声明「未提供的选择器一律视为不存在」');
  assertUnique(P6_CONTRACT.includes('语义合理') && P6_CONTRACT.includes('DOM 事实'), 'A: 必须声明「语义合理≠DOM 事实」');
  assertUnique(P6_CONTRACT.includes('商品列表容器') && P6_CONTRACT.includes('商品价格元素'), 'A: 必须点名容器/价格元素类反例');

  // ── Test B: Text hallucination ban ──
  assertUnique(P6_CONTRACT.includes('不得转成 text_present'), 'B: 必须明文禁止把类目词转成 text_present 文案证据');
  assertUnique(P6_CONTRACT.includes('价格'), 'B: 必须包含「价格」文案幻觉实例');
  assertUnique(P6_CONTRACT.includes('¥1599'), 'B: 必须说明页面可能只显示 ¥1599（语义词≠字面文本）');

  // ── Test C: Future state anchor rules ──
  assertUnique(P6_CONTRACT.includes('动作执行后才可能出现的状态'), 'C: 必须覆盖未来状态（SEARCH_SUCCESS/CLICK_SUCCESS 类）');
  assertUnique(P6_CONTRACT.includes('SEARCH_SUCCESS') && P6_CONTRACT.includes('CLICK_SUCCESS'), 'C: 必须点名未来状态类型');
  assertUnique(P6_CONTRACT.includes('事实锚点'), 'C: 必须要求每个证据子句有事实锚点');

  // ── Test D: Known facts still allowed ──
  assertUnique(P6_CONTRACT.includes('元素清单取真实存在的'), 'D: 当前 observation 元素清单中的真实事实必须仍被允许');
  assertUnique(P6_CONTRACT.includes('明确提供的具体专有名词或型号'), 'D: schema/observation 提供的专有名词事实必须仍被允许');

  // ── Test E: action_success allowed ──
  assertUnique(P6_CONTRACT.includes('action_success'), 'E: action_success 必须是合法锚点');

  // ── Test F: AND poison prevention ──
  assertUnique(P6_CONTRACT.includes('AND 追加猜测条件'), 'F: 必须禁止经 AND 追加猜测条件');
  assertUnique(P6_CONTRACT.includes('毒杀') || P6_CONTRACT.includes('A AND 臆造'), 'F: 必须说明 AND 投毒机制');
  assertUnique(P6_CONTRACT.includes('宁缺毋滥'), 'F: 必须包含宁缺毋滥原则');
  assertUnique(P6_CONTRACT.includes('action_success 不能作为 fill 的唯一完成证据'), 'E2: fill 例外必须显式声明（防 action_success 过度泛化）');
  assertUnique(P6_CONTRACT.includes('禁止自行发明任务与 observation 中都未出现的商品名'), 'B2: 禁止发明商品名作为 text_present 证据');

  // ── Test G: sync — planner structured path ──
  assertUnique(planner.ACTION_CONSTRAINTS.includes(P6_CONTRACT), 'G: planner.ACTION_CONSTRAINTS 必须包含 P6_CONTRACT 原文（同一文本对象）');
  assertUnique(planner.plannerInstructions().includes(P6_CONTRACT), 'G: plannerInstructions() 必须包含 P6_CONTRACT');

  // ── Test G: sync — deepseek 真实执行路径（行为级捕获）──
  let captured = null;
  const fakeChatFn = async (messages) => {
    if (!captured) captured = messages;
    return { content: '{"goal":"g","steps":[{"type":"navigate","semantic":"打开页面","expectedResult":"页面打开","verification":{"type":"action_success"}}]}' };
  };
  const task = { objective: '搜索「显示器」确认结果中包含商品价格信息', targetUrl: '/ecommerce/search.html', secretRefs: [] };
  let planErr = null;
  try {
    await deepseekPlan(fakeChatFn, task, { context: '' });
  } catch (e) { planErr = e; }
  assertUnique(captured, 'fakeChatFn 必须被调用（deepseekPlan 必须发送请求）');
  assertUnique(Array.isArray(captured) && captured[0] && captured[0].role === 'system', 'messages[0] 必须是 system');
  const sys = String(captured[0].content || '');
  assertUnique(sys.includes(P6_CONTRACT), 'G: 真实执行路径 system 必须逐字节包含 P6_CONTRACT' + (planErr ? '' : ''));
  // 既有契约不被 P6 引入而丢失（不削弱）
  assertUnique(sys.includes(P4_CONTRACT) && sys.includes(P5_CONTRACT), 'G: P4/P5 契约仍完整在场（不削弱）');

  console.log('PASS 17/17  P6 contract: CSS/文案/未来状态幻觉禁令 + 事实锚点白名单 + AND 投毒禁令 + 双路径同步全绿');
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
