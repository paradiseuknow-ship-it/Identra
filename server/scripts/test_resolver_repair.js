'use strict';

// 纯单元测试（无浏览器）：覆盖 Feature-Complete 三处增强——
//   (a) semanticResolver 的 nearby_text / dom_relationship / field 命中（matchedBy 已规范为 4 类 canonical：text/attribute/semantic/fallback）
//   (b) repairSchema.REPAIR_STRATEGIES 含 REPLAN
//   (c) verifyFailed 对 DOM_CHANGED（plan 过期）可返回 needsReplan 标志
// 注：matchedBy 规范化断言的权威覆盖见 test_resolver_matchedby.js
// 运行：node server/scripts/test_resolver_repair.js

const assert = require('assert');

const { resolve } = require('../agent/semanticResolver');
const repairSchema = require('../agent/repair/repairSchema');
const verifyFailed = require('../agent/repair/strategies/verifyFailed');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ FAIL: ' + msg); }
}
function section(name) { console.log('\n=== ' + name + ' ==='); }

async function main() {
  // ---------------------------------------------------------------
  section('(a) semanticResolver — nearby_text / dom_relationship / field 命中（canonical matchedBy）');
  // 元素自身无 name/id/placeholder，但 nearbyText 含目标语义 → nearby_text
  {
    const obs = {
      elements: [
        { id: 'b1', role: 'button', text: '提交', nearbyText: '请确认订单信息后提交' },
      ],
    };
    const out = resolve({ semantic: '确认订单' }, obs);
    ok(out.length >= 1, 'nearby_text 场景有候选返回');
    ok(out[0] && out[0].matchedBy === 'text', 'nearby_text 命中规范为 canonical matchedBy === "text" (得到 ' + (out[0] && out[0].matchedBy) + ')');
  }
  // 父/兄弟文本仅部分重叠（bigram 重叠 1/3）→ dom_relationship
  {
    const obs = {
      elements: [
        { id: 'b2', role: 'button', text: '提交', siblingText: '确认下单', parentText: '确认下单页面' },
      ],
    };
    const out = resolve({ semantic: '确认订单' }, obs);
    ok(out.length >= 1, 'dom_relationship 场景有候选返回');
    ok(out[0] && out[0].matchedBy === 'text', 'dom_relationship 命中规范为 canonical matchedBy === "text" (得到 ' + (out[0] && out[0].matchedBy) + ')');
  }
  // 回归：原 field 信号仍优先（不被 nearby 淹没）
  {
    const obs = {
      elements: [
        { id: 'el1', name: 'email', text: '邮箱', nearbyText: '其它说明' },
        { id: 'el2', text: '邮箱', nearbyText: '请输入email地址' },
      ],
    };
    const out = resolve({ field: 'email' }, obs);
    ok(out.length >= 1 && out[0].elementId === 'el1', 'field 优先级命中 email（得到 ' + (out[0] && out[0].elementId) + '）');
    ok(out[0] && out[0].matchedBy === 'attribute', 'field 命中规范为 canonical matchedBy === "attribute" (得到 ' + (out[0] && out[0].matchedBy) + ')');
  }

  // ---------------------------------------------------------------
  section('(b) repairSchema — REPLAN 枚举');
  ok(Array.isArray(repairSchema.REPAIR_STRATEGIES), 'REPAIR_STRATEGIES 为数组');
  ok(repairSchema.REPAIR_STRATEGIES.includes('REPLAN'), 'REPAIR_STRATEGIES 包含 "REPLAN"');

  // ---------------------------------------------------------------
  section('(c) verifyFailed — DOM_CHANGED 返回 needsReplan');
  {
    const res = await verifyFailed.execute({
      task: { id: 't1', objective: '下单' },
      step: { id: 's1', action: { type: 'click', target: { field: 'submit', semantic: '提交' } } },
      ctx: {
        error: { failureType: 'DOM_CHANGED', stalePlan: true },
        runAction: async () => ({ success: false }),
      },
    });
    ok(res && res.needsReplan === true, 'verifyFailed 对 DOM_CHANGED 返回 needsReplan=true');
    ok(res && res.strategy === 'REPLAN', 'verifyFailed 返回 strategy === "REPLAN"');
  }
  // 对照：非过期 DOM_CHANGED（首次进入）不应立刻 needsReplan
  {
    const res = await verifyFailed.execute({
      task: { id: 't2', objective: '下单' },
      step: { id: 's2', action: { type: 'click', target: { semantic: '提交' } } },
      ctx: {
        error: { failureType: 'DOM_CHANGED' },
        runAction: async () => ({ success: false }),
      },
    });
    ok(res && res.needsReplan !== true, '首次 DOM_CHANGED（未 stale）不返回 needsReplan');
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
