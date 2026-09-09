'use strict';

// C105 REAL-WEB AGENT RELIABILITY 守护测试（回放 fixture，零浏览器）。
//
// 证据源：att_mtttyayzw3f6.observationBefore.json —— 联盟落地页（法语）真实 80 元素快照。
// 五缺陷回放断言：
//   F1 语义兜底收紧   ：semantic continue/submit 在法语页不得命中零词法关联的 Plateforme 按钮
//   F2 selector 接地   ：过期 #continue-nav 不接地；页内真实 id/text/复合 CSS 接地
//   F3 P2 守卫表面化   ：pscd=try.webflow.com query 注入不再把真导航证据误判为恒真；
//                        run6 原始场景（path 内 saas）恒真拒绝保持
//   F5 恢复预算纪律    ：reload 每 step 上限 1 次（runPreAction 行为级）；runtime flapping
//                        熔断源级守护（与 repo 既有源断言先例一致，见 test_repair_variant_cap T6）
//   F6 恢复词源接地   ：法语页上词典轮播变体全部出局 → 只回原动作；英语页真实存在词保留
//   F4 replan 接地    ：replan 产出的过期 selector 被剥离、语义键保留、接地 selector 不动

const path = require('path');
const fs = require('fs');

const semanticResolver = require(path.join(__dirname, '..', 'agent', 'semanticResolver'));
const verification = require(path.join(__dirname, '..', 'agent', 'verification'));
const elementMissing = require(path.join(__dirname, '..', 'agent', 'recovery', 'strategies', 'elementMissing'));
const recoveryManager = require(path.join(__dirname, '..', 'agent', 'recovery', 'recoveryManager'));
const planner = require(path.join(__dirname, '..', 'agent', 'planner'));

const FIXTURE = path.join(__dirname, '..', 'data', 'evidence', 'attempt_errors', 'att_mtttyayzw3f6.observationBefore.json');
const frObs = require(FIXTURE).value; // { url, elements[80], ... }

let passed = 0, failed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  PASS', name); })
    .catch((e) => { failed++; console.error('  FAIL', name, '-', e && e.message); process.exitCode = 1; });
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ── fixtures 派生 ──
const platEl = frObs.elements.find((e) => e.id === 'dropdown_toggle_0');
const ctaEl = frObs.elements.find((e) => e.id === 'continue-nav');
const BEFORE_URL = frObs.url; // 含 pscd=try.webflow.com 联盟参数
// C105 实录的「真成功导航」after URL：点击 CTA 后落在 webflow.com 注册页
const AFTER_URL = 'https://webflow.com/signup?utm_medium=affiliate&utm_source=jimramsden2430';

// 合成英语页（恢复词源正例）：页面上真实存在 Next / Submit 按钮
const enObs = {
  url: 'https://example.com/en/checkout',
  textSummary: 'checkout page',
  elements: [
    { id: 'btn-next', role: 'button', tag: 'button', text: 'Next', ariaLabel: null, placeholder: null, label: null, cls: 'btn', innerText: 'Next', roleText: 'button: Next' },
    { id: 'btn-submit', role: 'button', tag: 'button', text: 'Submit order', ariaLabel: null, placeholder: null, label: null, cls: 'btn primary', innerText: 'Submit order', roleText: 'button: Submit order' },
  ],
};

// 导航后观察（D-B 死循环真实发生点）：点击 CTA 离开落地页后，#continue-nav 不再存在。
// 死循环 = 导航后仍复用落地页 selector #continue-nav → humanClick 找不到 → reload ×3。
const postNavObs = {
  ...frObs,
  url: AFTER_URL,
  elements: frObs.elements.filter((e) => e.id !== 'continue-nav'),
};

async function main() {
  console.log('C105 reliability guard (replay fixture, no browser)');

  // ── F1：语义兜底收紧 ──
  await ok('F1.1 semantic=continue 在法语页不命中 Plateforme（零词法关联出局）', () => {
    const cands = semanticResolver.resolve({ semantic: 'continue' }, frObs);
    const hit = cands.find((c) => c.el && c.el.id === 'dropdown_toggle_0');
    assert(!hit, 'Plateforme 不应成为 continue 的候选，实际命中 reason=' + (hit && hit.reason));
  });
  await ok('F1.2 semantic=submit/next 同样不命中 Plateforme', () => {
    for (const s of ['submit', 'next', 'proceed', 'sign up']) {
      const cands = semanticResolver.resolve({ semantic: s }, frObs);
      const hit = cands.find((c) => c.el && c.el.id === 'dropdown_toggle_0');
      assert(!hit, 'semantic=' + s + ' 不应命中 Plateforme');
    }
  });
  await ok('F1.3 词法关联成立的兜底仍保留（aria=Submit 的图标按钮对 semantic=submit）', () => {
    const obs = { url: 'https://x/', elements: [
      { id: 'icon-btn', role: 'button', tag: 'button', text: '', ariaLabel: 'Submit search', cls: 'icon', placeholder: null, label: null, innerText: '', roleText: 'button' },
    ] };
    const cands = semanticResolver.resolve({ semantic: 'submit' }, obs);
    const hit = cands.find((c) => c.el && c.el.id === 'icon-btn');
    assert(hit, 'aria 含 Submit 的按钮应保留兜底候选');
  });
  await ok('F1.4 中文语义「提交」对英文按钮（零词法关联）不出局（语言中立信号边界）', () => {
    const cands = semanticResolver.resolve({ semantic: '提交' }, enObs);
    const hit = cands.find((c) => c.el && c.el.id === 'btn-submit');
    assert(!hit, '跨语言臆测兜底应出局（真实信号是页面原文，不是翻译表）');
  });

  // ── F2：selector 接地判定 ──
  await ok('F2.1 导航后过期 selector #continue-nav 不接地（D-B 死循环燃料）', () => {
    assert(semanticResolver.selectorGrounded('#continue-nav', postNavObs) === false, '#continue-nav 在导航后页面应判不接地');
  });
  await ok('F2.1b 落地页本体上 #continue-nav 真实存在 → 必须接地（不误杀真目标）', () => {
    assert(semanticResolver.selectorGrounded('#continue-nav', frObs) === true, '落地页上 #continue-nav 应接地');
  });
  await ok('F2.2 页内真实 id / text / 复合 CSS 接地', () => {
    assert(semanticResolver.selectorGrounded('#dropdown_toggle_0', frObs) === true, 'id 形态应接地');
    assert(semanticResolver.selectorGrounded('text="Plateforme"', frObs) === true, 'text= 形态应接地');
    assert(semanticResolver.selectorGrounded('button[name="platform-menu"]', frObs) === false, '页内不存在的 name 应不接地');
  });
  await ok('F2.3 tools.resolveSelector F2 守卫：接地疑点只标记不弃用（源级契约，R-F2 修订）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'tools.js'), 'utf8');
    assert(/staleSelectorSuspected/.test(src), 'tools.js 缺少接地疑点标记（staleSelectorSuspected）');
    assert(!/staleSelectorDiscarded/.test(src), 'tools.js 不得再弃用过期 selector（step22 Scenario E 延时挂载实证：弃用会误杀尚未挂载的合法目标）');
    assert(/selectorGrounded\(t\.selector, obs\)/.test(src), 'tools.js 显式 selector 路径未接 selectorGrounded 守卫');
    // 弃用路径被移除后，显式 selector 必须无条件返回（保留基线 humanClick 快速失败语义）
    assert(/matchedBy = 'explicit_selector'[\s\S]{0,120}return \{ selector: t\.selector/.test(src), '显式 selector 必须保留返回（不弃用）');
  });

  // ── F3：P2 守卫表面化 ──
  await ok('F3.1 pscd query 注入不再把真导航证据误判为恒真（C105 主诉）', () => {
    const before = { url: BEFORE_URL, textSummary: 'fr landing' };
    const after = { url: AFTER_URL, textSummary: 'signup' };
    const r = verification.verify({ type: 'url_contains', expect: 'webflow.com' }, after, before);
    assert(r.success === true, 'after 已真实落在 webflow.com，应判成功；实际 evidence=' + JSON.stringify(r.evidence));
    assert(r.invalidEvidence !== 'precondition_true', '不得触发 precondition_true');
  });
  await ok('F3.2 run6 原始恒真场景保持拒绝（path 内 saas）', () => {
    const before = { url: 'https://site/saas/login.html', textSummary: '' };
    const after = { url: 'https://site/saas/login.html', textSummary: '' };
    const r = verification.verify({ type: 'url_contains', expect: 'saas' }, after, before);
    assert(r.success === false && r.invalidEvidence === 'precondition_true', 'path 恒真场景必须保持拒绝');
  });
  await ok('F3.3 动作后确无变化时仍拒绝（守卫主体语义未松动）', () => {
    const u = 'https://webflowmarketingmain.com/fr?pscd=try.webflow.com';
    const r = verification.verify({ type: 'url_contains', expect: 'webflowmarketingmain.com' }, { url: u }, { url: u });
    assert(r.success === false && r.invalidEvidence === 'precondition_true', 'host 在 before 表面已成立应拒绝');
  });
  await ok('F3.4 url_pattern P2 守卫同源表面化', () => {
    const before = { url: BEFORE_URL };
    const after = { url: AFTER_URL };
    const r = verification.verify({ type: 'url_pattern', pattern: 'webflow\\.com' }, after, before);
    assert(r.success === true, 'pscd 注入不应触发 url_pattern 恒真拒绝；evidence=' + JSON.stringify(r.evidence));
  });

  // ── F5：恢复预算纪律 ──
  await ok('F5.1 reload 每 step 上限 1 次（runPreAction 行为级）', async () => {
    const toolsPath = require.resolve(path.join(__dirname, '..', 'agent', 'tools'));
    const tools = require(toolsPath);
    const orig = tools.execute;
    let execTypes = [];
    tools.execute = async (req) => { execTypes.push(req.action.type); return { ok: true }; };
    try {
      const task = { id: 't_c105', currentExecutionId: 'e_c105' };
      const step = { id: 's_c105', action: { type: 'click' } };
      await recoveryManager.runPreAction(task, step, 1, ['reload']);
      await recoveryManager.runPreAction(task, step, 2, ['reload', 'reload']);
      await recoveryManager.runPreAction(task, step, 3, ['back+reload']);
      const reloads = execTypes.filter((t) => t === 'reload').length;
      assert(reloads === 1, '3 轮含 reload 的恢复序列实际 reload 应恰 1 次，实际 ' + reloads + '（' + execTypes.join(',') + '）');
      assert(execTypes.includes('back'), 'back 不受 reload 预算影响');
    } finally { tools.execute = orig; }
  });
  await ok('F5.2 runtime flapping 熔断源级契约（agent.flapping_detected + 阈值 4，R-F5 修订）', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'runtime.js'), 'utf8');
    assert(/agent\.flapping_detected/.test(src), 'runtime 缺 flapping 事件');
    assert(/FLAP_THRESHOLD = 4/.test(src), 'flapping 阈值应为 FLAP_THRESHOLD = 4（保留 maxRetries 3 内合法瞬时重试窗口，step22 Scenario E 契约）');
    assert(/_sameFailCount >= FLAP_THRESHOLD/.test(src), 'flapping 判定必须消费 FLAP_THRESHOLD 常量');
    assert(/canRetry && !flapping/.test(src), 'flapping 必须绕过确定性重试分支');
  });

  // ── F6：恢复词源接地 ──
  await ok('F6.1 法语页：词典轮播变体全部出局 → 恢复只回原动作', () => {
    const step = { id: 's1', action: { type: 'click', target: { semantic: 'continue' }, verification: { type: 'none' } } };
    for (let attempts = 1; attempts <= 5; attempts++) {
      const a = elementMissing.getAction(step, attempts, { observation: frObs, diagnosis: null });
      const sem = a.target.semantic || a.target.field || '';
      assert(sem === 'continue', 'attempts=' + attempts + ' 法语页上变体应全部出局只回原动作，实际尝试语义 ' + sem);
    }
  });
  await ok('F6.2 英语页：真实存在词保留（Next/Submit 均可解析），缺席词出局', () => {
    const step = { id: 's2', action: { type: 'click', target: { semantic: 'continue' }, verification: { type: 'none' } } };
    const a1 = elementMissing.getAction(step, 1, { observation: enObs, diagnosis: null });
    const sems = [];
    const seq = [];
    let cur = step;
    for (let i = 1; i <= 4; i++) {
      const a = elementMissing.getAction(step, i, { observation: enObs, diagnosis: null });
      seq.push(a.target.semantic);
    }
    // enObs 只有 Next/Submit：continue 出局，submit/next 应保留（顺序按词典序）
    assert(seq.every((s) => s !== 'continue'), 'continue 在英语页同样出局（页面无该词）');
    assert(seq.includes('submit') || seq.includes('next'), '页面真实存在的 submit/next 应保留，实际 ' + JSON.stringify(seq));
  });
  await ok('F6.3 无观察时行为不变（test_repair_variant_cap 契约兼容）', () => {
    const a = { type: 'click', target: { semantic: '数据列表区域' }, verification: { type: 'none' } };
    const v = elementMissing.buildElementVariants(a);
    assert(v.length === 12, '无 observation 时应保持 12 变体旧行为，实际 ' + v.length);
  });

  // ── F4：replan 接地净化 ──
  await ok('F4.1 replan 产出过期 selector 被剥离、语义键保留', () => {
    const steps = [
      { id: 'st1', type: 'click', action: { type: 'click', target: { semantic: 'continue', selector: '#continue-nav' }, verification: { type: 'none' } } },
      { id: 'st2', type: 'click', action: { type: 'click', target: { semantic: 'plateforme', selector: '#dropdown_toggle_0' }, verification: { type: 'none' } } },
      { id: 'st3', type: 'click', action: { type: 'click', target: { selector: 'input[name="q"]' }, verification: { type: 'none' } } }, // selector-only 不动
    ];
    const n = planner.groundReplannedSteps(steps, postNavObs);
    assert(n === 1, '应恰好剥离 1 个过期 selector，实际 ' + n);
    assert(steps[0].action.target.selector === undefined && steps[0].action.target.semantic === 'continue', 'st1 应剥离 selector 保留 semantic');
    assert(steps[1].action.target.selector === '#dropdown_toggle_0', 'st2 接地 selector 不得被动');
    assert(steps[2].action.target.selector === 'input[name="q"]', 'selector-only target 不动（CSS fallback 边界）');
    assert(/C105 F4/.test(steps[0].action.reason || ''), '剥离动作必须留痕 reason');
  });
  await ok('F4.2 replan 端到端：伪 provider 产出毒 selector → 返回步骤已净化', async () => {
    const fakeProvider = { plan: async () => ([
      // strict Step 契约：action=类型字符串，target 携带毒 selector
      { action: 'click', semantic: 'continue', target: { selector: '#continue-nav', semantic: 'continue' }, verification: { type: 'url_contains', expect: 'webflow.com' } },
    ]) };
    const task = { id: 'task_c105_f4', objective: '注册', targetUrl: BEFORE_URL };
    const r = await planner.replan(task, postNavObs, [], fakeProvider);
    if (!r.ok) throw new Error('replan 应成功：' + r.error);
    assert(r.strippedSelectors === 1, '应报告剥离 1 个 selector，实际 ' + r.strippedSelectors);
    assert(r.steps[0].action.target.selector === undefined, '毒 selector 应已剥离，实际 target=' + JSON.stringify(r.steps[0].action.target));
    assert(r.steps[0].action.target.semantic === 'continue', '语义键必须保留');
  });

  console.log('\nc105 reliability guard: ' + passed + ' passed, ' + (failed ? failed + ' FAILED' : 'all green'));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
