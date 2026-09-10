'use strict';

// C105 真实站点复跑暴露的两个确定性缺陷 —— 守护测试（零浏览器）。
//
// 证据源：真实站点任务 task_mtucm6q7dbnin（F9 之后）server/data/aiAttempts.json：
//   · `locator('#el-37')` / `#el-39` / `#el-45` / `#el-48` → boundingBox 30s 超时 ×4
//     —— #el-N 是 observation 的逻辑索引，不是真实 DOM id。
//   · `humanClick: element not found: #continue-nav` ×10+ —— field 被写成臆造 DOM id /
//     CTA 文案（"Start for free"），field 走 name/id/placeholder 精确匹配必然落空。
//
// F10 合成 id 拒用：selectorFor 无真实 DOM 锚点返回 null；执行面统一拒用 #el-N（含
//     elementMemory 历史缓存 / LLM 显式 selector 等一切来源），快速失败而非 30s 超时。
// F11 计划契约：semantic 语言契约（站点原文）+ field 不得臆造 + navigate 证据不得用
//     入口 URL 已有片段 —— planner prompt 契约层（源级守护，与 test_c105_reliability 先例一致）。

const path = require('path');
const fs = require('fs');

const semanticResolver = require(path.join(__dirname, '..', 'agent', 'semanticResolver'));
const tools = require(path.join(__dirname, '..', 'agent', 'tools'));

let passed = 0, failed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  PASS', name); })
    .catch((e) => { failed++; console.error('  FAIL', name, '-', e && e.message); process.exitCode = 1; });
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const PLANNER_SRC = fs.readFileSync(path.join(__dirname, '..', 'agent', 'planner.js'), 'utf8');

async function main() {
  console.log('C105 F10/F11 real-web regression guard (no browser)');

  // ── F10.1：无真实 DOM 锚点 → selectorFor 返回 null（不再编造 #el-N）──
  await ok('F10.1 selectorFor 无 id/text/aria/name/testid/href 时返回 null（零证据拒点）', () => {
    const el = { tag: 'div', role: 'generic', text: '', ariaLabel: null, name: null, id: null, cls: 'x', placeholder: null, href: null, testId: null };
    assert(semanticResolver.selectorFor(el, 37) === null, '应返回 null，实际 ' + semanticResolver.selectorFor(el, 37));
  });

  // ── F10.2：有可用锚点时仍产出可匹配 selector（不误杀）──
  await ok('F10.2 有 text/aria/name/testid 时仍产出真实可匹配 selector', () => {
    const cases = [
      { el: { tag: 'div', role: 'generic', text: 'Continue', id: null, ariaLabel: null, name: null, testId: null, href: null, placeholder: null }, want: /^text=/ },
      { el: { tag: 'div', role: 'generic', text: '', id: null, ariaLabel: 'Submit', name: null, testId: null, href: null, placeholder: null }, want: /^\[aria-label=/ },
      { el: { tag: 'input', role: 'textbox', text: '', id: null, ariaLabel: null, name: 'email', testId: null, href: null, placeholder: null, type: 'text' }, want: /^input\[name=/ },
    ];
    for (const c of cases) {
      const s = semanticResolver.selectorFor(c.el, 3);
      assert(s && c.want.test(s), '期望 ' + c.want + '，实际 ' + s);
    }
  });

  // ── F10.3：执行面统一拒用合成 id（显式 selector 来源）→ null（快速失败）──
  await ok('F10.3 resolveSelector 拒用 #el-N 合成 id：返回 null 并打 syntheticSelectorRejected', async () => {
    const meta = {};
    const r = await tools.resolveSelector(
      { type: 'click', target: { selector: '#el-37', semantic: 'next' } },
      { url: 'https://webflow.com/', elements: [] },
      meta, null,
    );
    assert(r === null, '合成 id 必须被拒用（返回 null），实际 ' + JSON.stringify(r));
    assert(meta.syntheticSelectorRejected === '#el-37', '应留痕 syntheticSelectorRejected，实际 ' + JSON.stringify(meta));
  });

  // ── F10.4：真实 selector 不受影响（不误杀）──
  await ok('F10.4 真实 selector（#real-id）照常返回', async () => {
    const r = await tools.resolveSelector(
      { type: 'click', target: { selector: '#real-id', semantic: 'next' } },
      { url: 'https://webflow.com/', elements: [] },
      {}, null,
    );
    assert(r && r.selector === '#real-id', '实际 ' + JSON.stringify(r));
  });

  // ── F10.5：解析候选不再携带合成 id（语义路径）──
  await ok('F10.5 语义解析候选的 selector 不含 #el-N 形态', () => {
    const obs = {
      url: 'https://webflow.com/',
      elements: [
        { id: null, role: 'button', tag: 'button', text: '', ariaLabel: null, placeholder: null, label: null, cls: 'btn', innerText: '', roleText: 'button', visible: true, type: null, name: null },
      ],
    };
    const cands = semanticResolver.resolve({ semantic: 'submit' }, obs);
    for (const c of cands) {
      assert(!/^#el-\d+$/.test(String(c.selector || '')), '候选不应携带合成 id，实际 ' + c.selector);
    }
  });

  // ── F11.1：semantic 语言契约（站点原文，禁止中文意译）──
  // C106 F22：契约文本已上移到 plannerContractText.js（单一事实源），planner.js 与
  // deepseek.js 同源引用 —— 因此断言「引用 + 常量内容正确」，而不是文本内联在哪个文件。
  //（原断言只看 planner.js 内联文本；文本上移后若仍查内联位置会假红，且会反向激励
  //  把共享常量抄回各路径，正是 P4/P5/F9 反复踩坑的成因。）
  await ok('F11.1 planner 契约含 semantic 语言契约（verbatim 原文，禁止中文意译）', () => {
    assert(/SEMANTIC_LANG_CONTRACT/.test(PLANNER_SRC), 'planner 未引用共享语义契约常量');
    const contract = require('../agent/plannerContractText');
    const text = String(contract.SEMANTIC_LANG_CONTRACT || '');
    assert(/semantic 语言契约/.test(text), '共享常量缺 semantic 语言契约标识');
    assert(/禁止翻译、意译或概括性中文描述/.test(text), '契约未禁止中文意译');
    assert(/verbatim/.test(text), '契约未要求站点原文 verbatim');
  });

  // ── F11.2：field 不得臆造 ──
  await ok('F11.2 planner 契约含 field 契约（禁止 CTA 文案 / 编造 DOM id 当 field）', () => {
    assert(/field 契约（硬性）/.test(PLANNER_SRC), '缺 field 契约');
    assert(/禁止编造 DOM id/.test(PLANNER_SRC), 'field 契约未禁止编造 DOM id');
    assert(/禁止把按钮\/链接文案当 field/.test(PLANNER_SRC), 'field 契约未禁止 CTA 文案');
  });

  // ── F11.3：navigate 证据不得用入口 URL 已有片段 ──
  await ok('F11.3 planner 契约含 navigate 证据契约（禁用入口域名作成功证据）', () => {
    assert(/navigate 证据契约/.test(PLANNER_SRC), '缺 navigate 证据契约');
    assert(/不得是入口地址已有的域名或路径片段/.test(PLANNER_SRC), '契约未禁止入口片段');
  });

  // ── F11.4：prompt 示例不得再示范中文意译 semantic ──
  await ok('F11.4 planner 输出示例的 semantic/expect 为站点原文（无中文意译示例）', () => {
    const bad = PLANNER_SRC.match(/semantic[」"]?\s*[:：]\s*[\\]?["'][^"']*[一-龥]/g);
    assert(!bad, '示例仍含中文意译 semantic: ' + JSON.stringify(bad));
    assert(/semantic[\\]?["']\s*:\s*[\\]?["'](Work email|Sign in|Get started|Sign up)/.test(PLANNER_SRC)
      || /"semantic":"Work email"/.test(PLANNER_SRC), '示例应给出英文原文 semantic');
  });

  // ── F11.5：首步导航契约 ──
  await ok('F11.5 planner 契约含首步导航契约（入口地址必须先 navigate）', () => {
    assert(/首步导航契约/.test(PLANNER_SRC), '缺首步导航契约');
  });

  // ── F13：熔断签名必须抗「变体轮换」（真实站点实证：field 恒定、semantic 轮换 → 熔断失效）──
  await ok('F13.1 flapping 签名以 field 为稳定键（不再被 semantic 变体轮换绕过）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'runtime.js'), 'utf8');
    assert(/field:' \+ String\(_att\.field\)/.test(src), 'runtime 未以 field 作为稳定签名键');
    assert(/C105 F13/.test(src), 'runtime 缺 F13 注记');
  });

  console.log(`\nF10/F11/F13 guard: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
