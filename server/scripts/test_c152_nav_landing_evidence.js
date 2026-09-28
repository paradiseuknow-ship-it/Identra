'use strict';

// C152 守护：导航落点正向证据（修复再验证的「同一 step 内跨尝试」因果口径）。
//
// 缺陷（A 类真缺陷，实测 C152-ATTRIB）：
//   NAVIGATE 首访在 load 等待窗内超时，但**导航已提交**（URL 已成目标页）⇒ 本步失败进入恢复；
//   重试时 `page_change` 的 before 已包含上次尝试的效果（runtime 用 post-action 观测覆盖了
//   beforeObs）⇒ before/after 都是目标页 ⇒ `url 变化=false 内容变化=false` ⇒ 3 次重试 +
//   3 次 VERIFY_RETRY 全部同因失败 ⇒ HUMAN_ESCALATION。
//   业务事实：页面**已到达目标 URL**。旧行为（before=null）之所以「绿」靠的是 `page_change`
//   的 fail-open 假成功通道 —— 那是伪证。
//
// 修复口径（**正向证据，绝不 fail-open**）：修复再验证中，若当前观测 URL 已达成**本步自己的**
//   navigate 目标（且不在错误页）⇒ 通过；否则一律回落契约验证。
//
// 本守护四层：
//   A 判据面：landingEvidence 的真实行为（含 6 条反向：无关 URL / 错误页 / 无 url / 非 navigate /
//     缺 target / 缺 expect）—— 反向断言证明它**不是**无条件放行。
//   B 入口面：reverify 唯一入口的双向（契约已过→用契约；契约未过+落点达成→通过；
//     契约未过+落点未达成→**仍失败**，这是「不放宽」的核心咬合点）。
//   C 形状面：源码形状防漂移 —— 三处 recheckAndVerify 调用点**必须都带 step**（本次踩到
//     `replace_all` 因缩进不同静默漏过一处），且除唯一入口外不得再有裸 verifyWithAlternatives。
//   D 分辨力对照：用三个**错误实现**逐条证明本测试咬得住（否则是真空绿）。

const fs = require('fs');
const os = require('os');
const path = require('path');

// C140 纪律：入集前提 = 已做数据根隔离（必须在**任何** require 之前）。
process.env.FPB_DATA_DIR = path.join(os.tmpdir(), 'c152_nav_landing_' + Date.now());

const ROOT = path.join(__dirname, '..', '..');
const vf = require('../agent/repair/strategies/verifyFailed');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('  ✔ ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('  ✘ FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}
const src = fs.readFileSync(path.join(ROOT, 'server/agent/repair/strategies/verifyFailed.js'), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const srcStripped = stripComments(src);

const TARGET = 'http://localhost:9555/flaky';
const obsLanded = { url: TARGET, visibleText: 'loading ok', title: 'flaky' };
const obsOtherPage = { url: 'http://localhost:9555/other', visibleText: 'x', title: 'o' };
const obsErrorPage = { url: TARGET, visibleText: 'Internal Server Error 500', title: 'e' };
const obsNoUrl = { visibleText: 'x', title: 'n' };

const stepNav = { id: 's1', type: 'NAVIGATE', action: { type: 'navigate', target: { url: TARGET }, risk: 'LOW' }, verification: { type: 'page_change' } };
const stepClick = { id: 's2', type: 'CLICK', action: { type: 'click', target: { semantic: 'Submit' }, risk: 'LOW' } };
const stepFill = { id: 's3', type: 'FILL', action: { type: 'fill', target: { field: 'email' }, risk: 'LOW' } };
const stepNoTargetUrl = { id: 's4', type: 'NAVIGATE', action: { type: 'navigate', target: {}, risk: 'LOW' } };

// 一个**必然不通过**的契约：与 before/after 无关，排除 page_change 在 before===after 下的
// 边界语义干扰（本测试要测的是落点证据，不是契约自身）。
const FAILING_CONTRACT = { type: 'text_present', expect: 'ZZZ_C152_NO_SUCH_TEXT' };

console.log('\n=== A 判据面：landingEvidence 真实行为 ===');
const a1 = vf.landingEvidence(stepNav, obsLanded);
chk('A1 navigate 步 + 当前 URL 达成目标 → 正向证据成立', !!(a1 && a1.ok === true), JSON.stringify(a1));
chk('A2 无关页面 → 不成立（分辨力）', vf.landingEvidence(stepNav, obsOtherPage) == null);
chk('A3 落点在错误页 → 不成立（落点达成 ≠ 落点在错误页）', vf.landingEvidence(stepNav, obsErrorPage) == null);
chk('A4 观测无 url → 不成立', vf.landingEvidence(stepNav, obsNoUrl) == null);
chk('A5 非 navigate 步（click）→ 不成立（不跨动作类型放宽）', vf.landingEvidence(stepClick, obsLanded) == null);
chk('A6 非 navigate 步（fill）→ 不成立', vf.landingEvidence(stepFill, obsLanded) == null);
chk('A7 缺 target.url → 不成立（fail-closed）', vf.landingEvidence(stepNoTargetUrl, obsLanded) == null);
chk('A8 观测为 null → 不成立', vf.landingEvidence(stepNav, null) == null);
chk('A9 target 只取自 step 自身（不读 task/ctx 等外部注入）',
  vf.navigateLandingTarget(stepNav) === TARGET
  && vf.navigateLandingTarget({ action: { type: 'navigate', target: { url: TARGET } }, taskTargetUrl: 'http://evil.test/' }) === TARGET
  && vf.navigateLandingTarget({ action: { type: 'navigate', target: {} }, taskTargetUrl: 'http://evil.test/' }) === null);
chk('A10 URL 判据委托唯一实现（源码含 clause.evalUrlContains，且无第二份 URL 比较）',
  srcStripped.includes('clause.evalUrlContains(')
  && !/\.includes\(\s*want/.test(srcStripped)
  && !/new URL\(/.test(srcStripped));

console.log('\n=== B 入口面：reverify 唯一入口双向 ===');
const b1 = vf.reverify({ type: 'url_contains', expect: 'localhost:9555' }, obsLanded, null, stepClick);
chk('B1 契约本来就通过 → 用契约结果（不接管）', !!(b1 && b1.success === true && b1.used !== 'landing_target'), JSON.stringify(b1 && b1.used));
const b2 = vf.reverify(FAILING_CONTRACT, obsLanded, obsLanded, stepNav);
chk('B2 契约不通过 + 落点达成 → 通过且 used=landing_target', !!(b2 && b2.success === true && b2.used === 'landing_target'), JSON.stringify(b2));
const b3 = vf.reverify(FAILING_CONTRACT, obsOtherPage, obsOtherPage, stepNav);
chk('B3 契约不通过 + 落点未达成 → **仍失败**（核心不放宽咬合点）', !!(b3 && b3.success === false), JSON.stringify(b3));
const b4 = vf.reverify(FAILING_CONTRACT, obsLanded, obsLanded, stepClick);
chk('B4 落点达成但步不是 navigate → 仍失败（不得泛化）', !!(b4 && b4.success === false), JSON.stringify(b4));
const b5 = vf.reverify(FAILING_CONTRACT, null, null, stepNav);
chk('B5 观测为 null → 仍失败（不 fail-open）', !!(b5 && b5.success === false), JSON.stringify(b5));
const b6 = vf.reverify(FAILING_CONTRACT, obsErrorPage, obsErrorPage, stepNav);
chk('B6 落点在错误页 → 仍失败', !!(b6 && b6.success === false), JSON.stringify(b6));

console.log('\n=== C 形状面：源码防漂移 ===');
const callsNoStep = (srcStripped.match(/await\s+recheckAndVerify\(\{\s*ctx,\s*verificationContract,\s*beforeObs\s*\}\)/g) || []).length;
const callsWithStep = (srcStripped.match(/await\s+recheckAndVerify\(\{\s*ctx,\s*verificationContract,\s*beforeObs,\s*step\s*\}\)/g) || []).length;
chk('C1 三处 recheckAndVerify 调用点**全部**带 step（缩进差异不得静默漏过）',
  callsNoStep === 0 && callsWithStep === 3, 'noStep=' + callsNoStep + ' withStep=' + callsWithStep);
const bareVwa = (srcStripped.match(/verifyWithAlternatives\(/g) || []).length;
chk('C2 裸 verifyWithAlternatives 只剩唯一入口 reverify 内 1 处', bareVwa === 1, 'count=' + bareVwa);
chk('C3 reverify 出口显式声明 used=landing_target（可观测性：证据可被取证）', srcStripped.includes("used: 'landing_target'"));
chk('C4 未把该判据写进共享验证层（verification.js / verificationWindow.js 不得出现 landing_target）',
  !fs.readFileSync(path.join(ROOT, 'server/agent/verification.js'), 'utf8').includes('landing_target')
  && !fs.readFileSync(path.join(ROOT, 'server/agent/verification/verificationWindow.js'), 'utf8').includes('landing_target'));
chk('C5 落点判据只存在于 verifyFailed.js（全 agent 面唯一）',
  (() => {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
        else if (/\.js$/.test(e.name) && fs.readFileSync(p, 'utf8').includes('landing_target')) out.push(path.relative(ROOT, p).replace(/\\/g, '/'));
      }
    };
    walk(path.join(ROOT, 'server', 'agent'));
    return out.length === 1 && out[0] === 'server/agent/repair/strategies/verifyFailed.js';
  })());
chk('C6 未触碰 P2 无效证据守卫本体（clause.evalUrlContains 仍带 precondition_true 分支）',
  fs.readFileSync(path.join(ROOT, 'server/agent/verification/clause.js'), 'utf8').includes('precondition_true'));

console.log('\n=== D 双向分辨力对照（错误实现必须被咬住）===');
// D1：忽略**动作类型**的错误实现（只看 URL 是否包含）。
// 对照形状必须是「非 navigate 但 target 带 url」（真实形态：带 url 线索的链接 click）——
// 否则对照实现自身退化成 null，测不出差异（本测试首跑即踩到，属「判据要能咬住」的自检）。
const stepClickWithUrl = { id: 's5', type: 'CLICK', action: { type: 'click', target: { url: TARGET, semantic: 'Open page' }, risk: 'LOW' } };
const wrongIgnoreType = (step, obs) => {
  const want = (step && step.action && step.action.target && (step.action.target.url || step.action.target.value)) || null;
  if (!want || !obs || !obs.url) return null;
  return String(obs.url).includes(String(want)) ? { ok: true } : null;
};
// D2：不排除错误页的错误实现
const wrongNoErrorPage = (step, obs) => {
  const want = (step && step.action && step.action.target && (step.action.target.url || step.action.target.value)) || null;
  if (!want || !obs || !obs.url) return null;
  return String(obs.url).includes(String(want)) ? { ok: true } : null;
};
// D3：契约不通过时无条件视为成功（fail-open）
const wrongFailOpen = () => ({ success: true, used: 'fail_open' });

const d1 = wrongIgnoreType(stepClickWithUrl, obsLanded);
chk('D1 「忽略动作类型」实现被 A5 同形断言咬住（它会对带 url 的 click 步成立）',
  !!(d1 && d1.ok === true) && vf.landingEvidence(stepClickWithUrl, obsLanded) == null
  && vf.landingEvidence(stepClick, obsLanded) == null);
const d2 = wrongNoErrorPage(stepNav, obsErrorPage);
chk('D2 「不排除错误页」实现被 A3 同形断言咬住（它会对错误页成立）', !!(d2 && d2.ok === true) && vf.landingEvidence(stepNav, obsErrorPage) == null);
chk('D3 「fail-open」实现被 B3/B5 咬住（落点未达成时它会给成功）',
  wrongFailOpen().success === true && vf.reverify(FAILING_CONTRACT, obsOtherPage, obsOtherPage, stepNav).success === false);

console.log('\n== C152 结果: ' + pass + ' passed, ' + fail + ' failed ==');
if (fail) { console.log('FAILURES:\n  ' + failures.join('\n  ')); }
process.exit(fail ? 1 : 0);
