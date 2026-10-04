'use strict';

// C164 守护：三处修复的**零浏览器**契约守护。
//
// 修复 1（P1，假成功）：planner 目标覆盖守卫 + runtime 终态业务实效守卫。
//   实证 task_muslw2kpdc7of（真实用户任务，2026-10-04）：objective「注册账号并购买最便宜的
//   月付会员」，计划仅 2 步（navigate sonymaxweb.com + inspect 观察首页），两步 SUCCESS
//   ⇒ completedSteps 2 / totalSteps 2 ⇒ **任务 SUCCESS** —— 没注册、没订阅、没支付。
//
// 修复 2（P2，点错元素）：semanticResolver 在**动作目标**解析时让描述性元素
//   （form/label/h1~h3/img）结构性出局。实证：Spocket 官网营销标题
//   "500K+ Sellers Trust Spocket To"（恰好 30 字符）得 0.92 胜出 ⇒ selectorFor 兜底生成
//   text="500K+ Sellers Trust Spocket To" ⇒ 点击一个 <h2> 零业务效果 ⇒ 30s 超时 ×3
//   ⇒ 90s REPAIR_TIMEOUT。
//
// 修复 3（P3，按钮被 field 误杀）：tools 的 field 权威校验按动作类型分层 —— 只对
//   写入类动作（fill/select）生效。实证 {semantic:'Try Spocket', field:'trySpocket'}
//   在 click 上必然被拒（驼峰 vs 空格 ⇒ 不等价；按钮无该属性 ⇒ 不接地）⇒ ELEMENT_NOT_FOUND
//   ⇒ repairCount 冲到 63；同一目标去掉 field 后 0.92 命中。
//
// 每个修复都带**反向咬**（把改前行为放进同一组断言必须变红），证明守护有分辨力而非真空绿。

const os = require('os');
const path = require('path');
const fs = require('fs');

// C140 纪律：夹具一律隔离数据根，绝不写入 server/data。
process.env.FPB_DATA_DIR = path.join(os.tmpdir(), 'c164_guard_' + Date.now());

const AGENT = path.join(__dirname, '..', 'agent');
const planner = require(path.join(AGENT, 'planner'));
const sr = require(path.join(AGENT, 'semanticResolver'));
const tools = require(path.join(AGENT, 'tools'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  << ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

// ─────────────────────────────────────────────────────────────────────────────
section('A. P1 目标覆盖守卫（planner.goalCoverageViolations）');

// 本次实证的塌缩计划（逐步复刻 aiSteps.json 里那 2 步）
const COLLAPSED = [
  { id: 'step_001', type: 'NAVIGATE', action: { type: 'navigate', target: { url: 'https://sonymaxweb.com' } } },
  { id: 'step_002', type: 'ACT', action: { type: 'inspect', target: { semantic: '注册入口' } } },
];
// 含真实业务动作的完整计划；★以 extract 收尾 —— 「提交后提取/观察验证结果」是正当模式
const REAL_PLAN = [
  { id: 'step_001', type: 'NAVIGATE', action: { type: 'navigate' } },
  { id: 'step_002', type: 'ACT', action: { type: 'click' } },
  { id: 'step_003', type: 'ACT', action: { type: 'fill' } },
  { id: 'step_004', type: 'ACT', action: { type: 'submit' } },
  { id: 'step_005', type: 'ACT', action: { type: 'extract' } },
];

ok('A1 塌缩计划（navigate+inspect）+ 中文业务目标 → 必须违规',
  planner.goalCoverageViolations(COLLAPSED, '注册账号并购买最便宜的月付会员').length > 0);
ok('A2 同一塌缩计划 + 英文业务目标 → 必须违规',
  planner.goalCoverageViolations(COLLAPSED, 'Sign up and purchase the cheapest monthly membership').length > 0);
ok('A3 含 click/fill/submit 的完整计划 → 通过',
  planner.goalCoverageViolations(REAL_PLAN, '注册账号并购买最便宜的月付会员').length === 0);
ok('A4 ★零误杀：纯观察型目标（不含业务阶段词）→ 完全跳过本守卫',
  planner.goalCoverageViolations(COLLAPSED, '打开首页看看标题').length === 0);
ok('A5 ★反向咬：以 extract 收尾的合法计划必须通过 —— 证明没有误杀「提交后提取验证」模式',
  planner.goalCoverageViolations(REAL_PLAN, '注册账号').length === 0);
ok('A6 空 steps → 通过（不产生空指针式误判）',
  planner.goalCoverageViolations([], '注册账号').length === 0);
ok('A7 fail-closed：步骤缺 action 时同样判违规（真实路径上 schema 门已保证 action 存在）',
  planner.goalCoverageViolations([{ id: 's1' }, { id: 's2' }], '注册账号').length > 0);
ok('A8 无业务阶段词的目标 + 塌缩计划 → 通过（守卫只在目标确实是业务动作时生效）',
  planner.goalCoverageViolations(COLLAPSED, 'Extract the page title').length === 0);

section('A9-A11 isNonEffectAction / goalHasBusinessStage（判据事实源）');
const NON_EFFECT_SAMPLES = ['navigate', 'reload', 'back', 'forward', 'openTab', 'switchTab', 'scroll', 'inspect', 'extract', 'screenshot', 'getUrl', 'getTitle', 'wait'];
const EFFECT_SAMPLES = ['click', 'fill', 'select', 'press', 'check', 'uncheck', 'submit', 'login', 'logout', 'hover', 'drag', 'upload', 'download', 'purchase', 'payment', 'password_change', 'update_account_settings', 'delete'];
ok('A9 导航族 + 观察族一律判「无业务效果」（' + NON_EFFECT_SAMPLES.length + ' 例）',
  NON_EFFECT_SAMPLES.every((t) => planner.isNonEffectAction(t) === true),
  NON_EFFECT_SAMPLES.filter((t) => planner.isNonEffectAction(t) !== true));
ok('A10 业务动作一律判「有效果」（' + EFFECT_SAMPLES.length + ' 例）',
  EFFECT_SAMPLES.every((t) => planner.isNonEffectAction(t) === false),
  EFFECT_SAMPLES.filter((t) => planner.isNonEffectAction(t) !== false));
ok('A11 大小写归一（OBSERVE_ACTION_TYPES 是 camelCase，schema 侧也是）',
  planner.isNonEffectAction('GETURL') === true && planner.isNonEffectAction('GetTitle') === true
  && planner.isNonEffectAction('') === false && planner.isNonEffectAction(null) === false);
ok('A12 goalHasBusinessStage 正例（中/英）',
  ['注册账号', '购买会员', '订阅套餐', 'Sign up', 'subscribe to the plan', 'checkout', 'payment']
    .every((s) => planner.goalHasBusinessStage(s) === true));
ok('A13 goalHasBusinessStage 负例（纯观察/无关目标）',
  ['打开首页', 'Extract the page title', 'take a screenshot', 'scroll to the bottom']
    .every((s) => planner.goalHasBusinessStage(s) === false));

// ─────────────────────────────────────────────────────────────────────────────
section('B. P1-b runtime 终态业务实效守卫（形状 + 顺序：必须在 complete 之前）');
const rtSrc = fs.readFileSync(path.join(AGENT, 'runtime.js'), 'utf8');
const iGuard = rtSrc.indexOf('planner.isNonEffectAction');
const iComplete = rtSrc.indexOf('taskManager.complete(taskId, { completedSteps');
ok('B1 runtime 的成功收口路径引用了 planner.isNonEffectAction', iGuard >= 0);
ok('B2 该守卫位于 taskManager.complete 之前（同一收口路径内）', iGuard > 0 && iComplete > iGuard,
  { iGuard, iComplete });
ok('B3 同处引用 planner.goalHasBusinessStage（判据与规划期同源，唯一实现）',
  rtSrc.indexOf('planner.goalHasBusinessStage') > 0);
ok('B4 ★未在 runtime 内另立第二份动作清单（不得出现 NON_EFFECT 集合的小写字面）',
  !/'closetab'/.test(rtSrc) && !/'opentab'/.test(rtSrc));

// ─────────────────────────────────────────────────────────────────────────────
section('C. P2 描述性元素不得作为动作目标（semanticResolver）');

// 复刻实证页面：营销标题（descriptive）得分 0.92 严格高于唯一的可操作控件（0.7 ≤ 封顶线 0.75）
// —— 这正是旧「描述性封顶」**条件封顶**失效的场景。
const OBS_MARKETING = {
  url: 'https://www.spocket.co/',
  elements: [
    { tag: 'h2', text: '500K+ Sellers Trust Spocket To', visible: true },
    { tag: 'div', role: 'button', text: 'Go', visible: true },
  ],
};
const TARGET_MARKETING = { semantic: '500K+ Sellers Trust Spocket To', role: 'button' };

const c1 = sr.resolve(TARGET_MARKETING, OBS_MARKETING);
ok('C1 存在可操作控件时，描述性元素（h2）不得出现在候选池（改前 h2 以 0.92 胜出）',
  c1.length > 0 && c1.every((c) => String(c.el.tag) !== 'h2'),
  c1.map((c) => [c.el.tag, c.score, c.blockedBy]));
ok('C2 胜出候选是真正的可操作控件（role=button 的 div）',
  c1.length > 0 && String(c1[0].el.tag) === 'div' && String(c1[0].el.role) === 'button',
  c1[0] && [c1[0].el.tag, c1[0].el.role, c1[0].score]);

const OBS_ONLY_H2 = {
  url: 'https://x.test/',
  elements: [{ tag: 'h2', text: '500K+ Sellers Trust Spocket To', visible: true }],
};
const c3 = sr.resolve(TARGET_MARKETING, OBS_ONLY_H2);
ok('C3 ★全阻断回落：池中只有描述性元素时保留并打 blockedBy 标记（不谎报「元素不存在」）',
  c3.length === 1 && c3[0].blockedBy === 'non-interactive', c3.map((c) => [c.el.tag, c.blockedBy]));

const c4 = sr.resolve({ semantic: '500K+ Sellers Trust Spocket To' }, OBS_ONLY_H2, { requireActionable: false });
ok('C4 ★零放宽：存在性通道（requireActionable:false）不受影响，描述性元素仍正常命中',
  c4.length >= 1 && !c4[0].blockedBy, c4.map((c) => [c.el.tag, c.blockedBy]));

const OBS_PASSIVE = { url: 'https://x.test/', elements: [{ tag: 'div', text: 'Spocket', visible: true }] };
const c5 = sr.resolve({ semantic: 'Spocket' }, OBS_PASSIVE);
ok('C5 ★零误杀边界：passive 元素（无 role 的可点容器 <div class="btn"> 族）不被本判据出局',
  c5.length === 1 && !c5[0].blockedBy, c5.map((c) => [c.el.tag, c.blockedBy]));

// ─────────────────────────────────────────────────────────────────────────────
section('D. P3 field 权威校验按动作类型分层（tools.resolveSelector）');

(async () => {
  const OBS_BTN = {
    url: 'https://x.test/',
    elements: [{ tag: 'a', role: 'link', text: 'Try Spocket', href: '/signup', visible: true }],
  };
  const d1 = await tools.resolveSelector(
    { type: 'click', target: { semantic: 'Try Spocket', field: 'trySpocket' } }, OBS_BTN, {}, null, {});
  ok('D1 click + 模型自造 field → 不再被 field 权威校验误杀（改前恒 null，实证 repairCount=63）',
    !!d1, d1);

  const d2 = await tools.resolveSelector(
    { type: 'click', target: { semantic: 'Nonexistent Widget' } }, OBS_BTN, {}, null, {});
  ok('D2 ★零放宽：click 目标真的不存在时仍返回 null（不是把守卫整个关掉）', !d2, d2);

  const OBS_EMAIL = {
    url: 'https://x.test/',
    elements: [{ tag: 'input', type: 'email', name: 'email', placeholder: 'Email', visible: true }],
  };
  const d3 = await tools.resolveSelector(
    { type: 'fill', target: { semantic: 'email', field: 'password' } }, OBS_EMAIL, {}, null, {});
  ok('D3 ★反向咬：fill 场景（C106 F16 核心）仍然拒绝 —— semantic=email + field=password 绝不允许填进 email 框',
    !d3, d3);

  const d4 = await tools.resolveSelector(
    { type: 'select', target: { semantic: 'email', field: 'password' } }, OBS_EMAIL, {}, null, {});
  ok('D4 select 属「写入字段」面 → 同样维持强校验（拒绝）', !d4, d4);

  console.log('\n=== C164 守护: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail ? 1 : 0);
})();
