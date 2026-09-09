'use strict';
// C106 F15 — 分步表单推进守护（零浏览器，tmp 隔离，AI 无关）。
//
// 背景（C105 第 4 轮真实站点实证 task_mtudmyy7rg926）：
//   注册流程为分步表单（邮箱 → 继续 → 密码）。planner 假设单页表单 →
//   fill password 时字段尚未挂载 → ELEMENT_NOT_FOUND → 重试/replan 只是重放同一步
//   （实证同字段 12 次 / 473s → FAILED）。F15 把「目标尚未出现」从「目标不存在」里分出来：
//   字段类动作 + ELEMENT_NOT_FOUND 时，先点保守前进词表解析出的控件，再重查目标字段。
//
// 守护四层：
//   P1 触发面契约（纯函数）：哪些动作允许推进、词表安全、合成 id 拒用、结构合法性
//   P2 行为杀手（注入 fake 依赖，无浏览器）：推进成功 / 推进后仍缺失即停 / 无控件不点 /
//      点击失败换词 / 合成 selector 不点 / 输入框不得被当推进控件
//   P3 整类守卫：词表与危险词零重叠、字段动作族不含 click、词表禁含字段名复合词
//   注：真实浏览器行为面由 test_c106_f15_staged_fixture.js 覆盖（真实 Chromium）。

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c106-'));
process.env.FPB_DATA_DIR = TMP;

const sf = require('../agent/stagedFormAdvance');

let pass = 0; let fail = 0; const failures = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; failures.push(name); console.log('  ✘ FAIL ' + name + '  [' + JSON.stringify(detail).slice(0, 240) + ']'); }
  return !!cond;
}

// ===== P1 触发面契约 =====
console.log('\n== P1 触发面契约（纯函数） ==');
assert('P1a fill + field 允许推进', sf.isFieldTargetAction({ type: 'fill', target: { field: 'password' } }) === true);
assert('P1b fill + semantic 允许推进', sf.isFieldTargetAction({ type: 'fill', target: { semantic: 'Password' } }) === true);
assert('P1c fill 仅 selector 不推进（无法判定「尚未出现」）', sf.isFieldTargetAction({ type: 'fill', target: { selector: '#pwd' } }) === false);
assert('P1d click 不属字段动作（普通点击失败不得触发推进）', sf.isFieldTargetAction({ type: 'click', target: { semantic: 'Continue' } }) === false);
assert('P1e select/check/uncheck/upload 属字段动作', ['select', 'check', 'uncheck', 'upload'].every((t) => sf.isFieldTargetAction({ type: t, target: { field: 'x' } }) === true));
assert('P1f 空动作安全返回 false', sf.isFieldTargetAction(null) === false);

console.log('\n== P1 词表安全 ==');
assert('P1g 危险词判定：Delete account', sf.isDangerousTerm('Delete account') === true);
assert('P1h 危险词判定：Confirm order', sf.isDangerousTerm('Confirm order') === true);
assert('P1i 安全词：Continue', sf.isDangerousTerm('Continue') === false);
assert('P1j 安全词：Next step', sf.isDangerousTerm('Next step') === false);
assert('P1k 合成 selector 识别 #el-37', sf.isSyntheticSelector('#el-37') === true);
assert('P1l 真实 selector 放行 #email', sf.isSyntheticSelector('#email') === false);

console.log('\n== P1 结构合法性 isAdvanceControl（真实浏览器实证：输入框曾被误判为前进控件）==');
assert('P1m button 合法', sf.isAdvanceControl({ tag: 'button' }) === true);
assert('P1n a 合法', sf.isAdvanceControl({ tag: 'a' }) === true);
assert('P1o input[type=submit] 合法', sf.isAdvanceControl({ tag: 'input', type: 'submit' }) === true);
assert('P1p role=button 合法', sf.isAdvanceControl({ tag: 'div', role: 'button' }) === true);
assert('P1q 输入框 input[type=email] 非法（核心回归）', sf.isAdvanceControl({ tag: 'input', type: 'email' }) === false);
assert('P1r 输入框 input[type=text] 非法', sf.isAdvanceControl({ tag: 'input', type: 'text' }) === false);
assert('P1s 密码框 input[type=password] 非法', sf.isAdvanceControl({ tag: 'input', type: 'password' }) === false);
assert('P1t textarea 非法', sf.isAdvanceControl({ tag: 'textarea' }) === false);
assert('P1u select 非法', sf.isAdvanceControl({ tag: 'select' }) === false);
assert('P1v input[type=reset] 非法', sf.isAdvanceControl({ tag: 'input', type: 'reset' }) === false);

console.log('\n== P1 prefer 谓词（C105 D-A：submit 类须优先于 catch-all role=button） ==');
assert('P1w prefer: type=submit', sf.preferSubmitLike({ type: 'submit' }) === true);
assert('P1x prefer: tag=button', sf.preferSubmitLike({ tag: 'button' }) === true);
assert('P1y prefer: 泛化 div[role=button] 不优先', sf.preferSubmitLike({ tag: 'div' }) === false);

// ===== P2 行为杀手（fake 依赖，零浏览器） =====
// advanceMap: term -> { selector, el }；el 缺省视为 button[type=submit]
function makeDeps(opts) {
  const o = opts || {};
  const state = { clicks: [], inspects: 0 };
  const page = { fake: true };
  return {
    state,
    deps: {
      task: { id: 't1', profileId: 'p1', currentExecutionId: 'e1' },
      step: { id: 's1' },
      action: o.action || { type: 'fill', target: { field: 'password' } },
      browserManager: { getPage: async () => (o.noPage ? null : page) },
      observation: {
        inspect: async () => {
          state.inspects++;
          return { ok: true, observation: { url: 'https://x.test/s' + state.inspects } };
        },
      },
      // 前进控件解析（结构过滤 + 排序发生在此结果之上）
      resolver: {
        resolve: (target) => {
          const hit = (o.advanceMap || {})[target.semantic];
          if (!hit) return [];
          return [{ selector: hit.selector, el: hit.el || { tag: 'button', type: 'submit' } }];
        },
      },
      tools: {
        // 目标字段重查（完整链路，含记忆/合成 id 拒用）
        resolveSelector: async (action) => {
          const sem = (action.target || {}).semantic;
          if (!sem && o.fieldAppears && state.inspects >= 2) return { selector: '#password', pattern: null, semantic: 'password' };
          return null;
        },
        execute: async ({ action }) => {
          state.clicks.push({ semantic: (action.target || {}).semantic, selector: (action.target || {}).selector });
          const ok = o.clickOk ? o.clickOk((action.target || {}).semantic) : true;
          return ok ? { success: true, observation: {} } : { success: false, error: { code: 'ELEMENT_NOT_FOUND', message: 'click failed' } };
        },
      },
    },
  };
}
const btn = (sel) => ({ selector: sel, el: { tag: 'button', type: 'submit' } });

async function p2() {
  console.log('\n== P2 行为杀手（fake 依赖） ==');

  // A：字段缺失 + 有 Continue → 点击后字段出现 → advanced
  {
    const { deps, state } = makeDeps({ advanceMap: { Continue: btn('#continue-btn') }, fieldAppears: true });
    const r = await sf.tryAdvance(deps);
    assert('A 推进成功 advanced=true', r.advanced === true, r);
    assert('A 点击了 Continue', state.clicks.length === 1 && state.clicks[0].semantic === 'Continue', state.clicks);
    assert('A 携带 selector', r.selector === '#continue-btn', r);
  }

  // B：点击成功但字段仍未出现 → 立即停止（绝不连点第二个前进词）
  {
    const { deps, state } = makeDeps({ advanceMap: { Continue: btn('#continue-btn'), Next: btn('#next-btn') }, fieldAppears: false });
    const r = await sf.tryAdvance(deps);
    assert('B 字段仍缺失 → advanced=false', r.advanced === false, r);
    assert('B reason=field_still_absent', r.reason === 'field_still_absent', r);
    assert('B 只点击一次（不连点第二个前进词）', state.clicks.length === 1, state.clicks);
  }

  // C：无任何前进控件 → 零点击
  {
    const { deps, state } = makeDeps({ advanceMap: {}, fieldAppears: false });
    const r = await sf.tryAdvance(deps);
    assert('C 无前进控件 → advanced=false', r.advanced === false, r);
    assert('C reason=no_advance_control', r.reason === 'no_advance_control', r);
    assert('C 零点击', state.clicks.length === 0, state.clicks);
  }

  // D：首个词点击失败 → 换下一个词（未产生推进，可继续尝试）
  {
    const { deps, state } = makeDeps({
      advanceMap: { Continue: btn('#continue-btn'), Next: btn('#next-btn') },
      clickOk: (sem) => sem !== 'Continue',
      fieldAppears: true,
    });
    const r = await sf.tryAdvance(deps);
    assert('D 换词后推进成功', r.advanced === true, r);
    assert('D 首个词失败仍尝试了第二个', state.clicks.length === 2, state.clicks);
  }

  // E：合成 selector（observation 逻辑索引）不得被点击（C105 F10 同源契约）
  {
    const { deps, state } = makeDeps({ advanceMap: { Continue: btn('#el-12') }, fieldAppears: true });
    const r = await sf.tryAdvance(deps);
    assert('E 合成 selector 被拒绝', r.advanced === false, r);
    assert('E 零点击', state.clicks.length === 0, state.clicks);
  }

  // F：输入框候选必须被结构过滤掉（真实浏览器实证：email 输入框曾被当 Continue 点击）
  {
    const { deps, state } = makeDeps({
      advanceMap: { Continue: { selector: '#email', el: { tag: 'input', type: 'email' } } },
      fieldAppears: true,
    });
    const r = await sf.tryAdvance(deps);
    assert('F 输入框候选被过滤 → advanced=false', r.advanced === false, r);
    assert('F reason=no_advance_control（无合法推进控件）', r.reason === 'no_advance_control', r);
    assert('F 零点击（绝不点输入框）', state.clicks.length === 0, state.clicks);
  }

  // G：无 page → 安全返回（不抛）
  {
    const { deps, state } = makeDeps({ noPage: true, advanceMap: { Continue: btn('#c') } });
    const r = await sf.tryAdvance(deps);
    assert('G 无 page → advanced=false 且 reason=no_page', r.advanced === false && r.reason === 'no_page', r);
    assert('G 零点击', state.clicks.length === 0, state.clicks);
  }

  // H：依赖缺失 → 安全返回（不抛）
  {
    const r = await sf.tryAdvance({});
    assert('H 依赖缺失 → 安全返回', r.advanced === false && r.reason === 'missing_deps', r);
  }
}

(async () => {
  await p2();

  // ===== P3 整类守卫 =====
  console.log('\n== P3 整类守卫 ==');
  const dangerousInTerms = sf.ADVANCE_TERMS.filter((t) => sf.isDangerousTerm(t));
  assert('P3a 词表与危险词零重叠（副作用词永不进词表）', dangerousInTerms.length === 0, dangerousInTerms);
  assert('P3b 字段动作族不含 click（普通点击失败不得触发推进）', !sf.FIELD_ACTION_TYPES.includes('click'), sf.FIELD_ACTION_TYPES);
  assert('P3c 每 step 推进上限 ≥1 且 ≤3（有界）', sf.MAX_ADVANCE_PER_STEP >= 1 && sf.MAX_ADVANCE_PER_STEP <= 3, sf.MAX_ADVANCE_PER_STEP);
  // 真实浏览器实证：含字段名的复合词（Continue with email）会与输入框词法交集 → 禁止入表
  const FIELDISH_RE = /\b(email|e-mail|mail|password|passwd|pwd|phone|tel|card|cvv|name|address)\b/i;
  const fieldishInTerms = sf.ADVANCE_TERMS.filter((t) => FIELDISH_RE.test(t));
  assert('P3d 词表禁含字段名复合词（防与输入框词法交集）', fieldishInTerms.length === 0, fieldishInTerms);
  assert('P3e advanceTerms 已过滤危险词', sf.advanceTerms().every((t) => !sf.isDangerousTerm(t)), sf.advanceTerms());

  console.log('\nPASS=' + pass + ' FAIL=' + fail + ' => ' + (fail === 0 ? 'TEST_OK' : 'TEST_FAILED'));
  if (fail > 0) { console.log('失败项: ' + failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
