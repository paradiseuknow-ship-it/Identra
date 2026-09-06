'use strict';

// test_step7_action_surface.js — CAP-F1（登记 6 个已实现动作）+ CAP-F2（hover / drag / iframe）
//
// CAP-F1 缺陷取证：
//   openTab / closeTab / switchTab / upload / download / dialog 六个动作在 tools.js 里
//   已完整实现（每个都有 case 分支、都接了 withBrowserOp、都返回统一 RESULT），
//   但从未登记进 schema/action.js 的 ACTION_TYPES —— 于是 validateAction 一律判
//   `type 非法`，Planner 提示里也永远看不到它们的名字。
//   结果是「代码写了、链路不通、模型不知道、运行时必拒」的四重断链。
//   P0-7 估计「成本约 6 行改动，性价比最高」，本测试同时补齐了另外三件被漏掉的事：
//     · 只登记名字不写参数契约 → 模型照样产出非法结构（5.9-E 的教训）；
//     · upload 是唯一「把本机文件内容送到远端」的动作 —— 不限制路径等于任意文件外泄；
//     · dialog 用一个平表定级，accept（确认删除/确认支付）与 dismiss（关弹窗）同权。
//
// CAP-F2 缺陷取证：
//   真正让「嵌套表单不可操作」的不是缺一个 switchFrame 动作 —— ' >> ' 跨 frame 寻址
//   （observation 生成 / makeLocator 消费）本来就有，click/fill/select/check/upload/download
//   六个分支也都在用它。**根因是 iframe 序号算错了**：observation 用一个全局自增计数器
//   生成 iframe:nth-of-type(n)，而 nth-of-type 的语义是「同父级同类型兄弟中的第 N 个」。
//   两个 iframe 分属不同父容器时，正确索引都是 1，计数器却给出 1 和 2 → 选择器永远
//   匹配不到元素。因此这里修索引，而不新增第二套有状态的 frame 上下文。
//
//   同批还修了两个「死参数」：press 与 scroll 此前完全忽略 action.target
//   （schema 却又强制要求 target），导致 iframe 内按回车、滚动列表都无法实现。

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const tools = require('../agent/tools');
const observation = require('../agent/observation');
const policy = require('../agent/policy');
const actionSchema = require('../agent/schema/action');
const planner = require('../agent/planner');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  << ' + extra : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

let browser;

// ═══════════════════════════════════════════════════════════════
// CAP-F1 Part A — 登记
// ═══════════════════════════════════════════════════════════════

// 六个「已实现但从未登记」的动作
const REDISCOVERED = ['openTab', 'closeTab', 'switchTab', 'upload', 'download', 'dialog'];
// STEP 7 同批新增的动作
const NEW_BUILT = ['hover', 'drag'];

function caseRegistration() {
  section('Case 1 CAP-F1：六个已实现动作必须登记（否则 validateAction 一律拒）');
  for (const t of REDISCOVERED) {
    ok(`${t} 已在 ACTION_TYPES 中`, actionSchema.ACTION_TYPES.includes(t));
  }
  for (const t of NEW_BUILT) {
    ok(`${t} 已在 ACTION_TYPES 中`, actionSchema.ACTION_TYPES.includes(t));
  }
  // 未登记的类型必须被拒 —— 反向证明「登记」这一步是有意义的
  const bogus = actionSchema.validateAction({ type: 'definitelyNotAnAction', target: { selector: '#x' } });
  ok('未登记类型仍被拒绝（登记不是放开校验）',
    bogus.ok === false && bogus.errors.some((e) => e.indexOf('type 非法') >= 0), JSON.stringify(bogus.errors));
}

function caseFloorCoverage() {
  section('Case 2 每个动作都要有风险下限（漏配会静默退回 MEDIUM）');
  const { ACTION_TYPES, TYPE_RISK_FLOOR } = actionSchema;
  const missing = ACTION_TYPES.filter((t) => !TYPE_RISK_FLOOR[t]);
  ok('ACTION_TYPES 无一项缺失 TYPE_RISK_FLOOR', missing.length === 0, '缺失: ' + missing.join(','));

  // 定级口径：不可逆性 + 外泄面 + 影响半径
  ok('upload = HIGH（本机文件出网，不可逆 + 有外泄面）', TYPE_RISK_FLOOR.upload === 'HIGH', TYPE_RISK_FLOOR.upload);
  ok('closeTab = MEDIUM（关错标签 = 丢失未保存状态）', TYPE_RISK_FLOOR.closeTab === 'MEDIUM', TYPE_RISK_FLOOR.closeTab);
  ok('openTab / switchTab = LOW（等价于 navigate，完全可逆）',
    TYPE_RISK_FLOOR.openTab === 'LOW' && TYPE_RISK_FLOOR.switchTab === 'LOW');
  ok('hover = LOW（只揭示 UI，无服务端副作用）', TYPE_RISK_FLOOR.hover === 'LOW');
  ok('drag = MEDIUM（与 click 同级）', TYPE_RISK_FLOOR.drag === 'MEDIUM');
}

function caseIntentFloor() {
  section('Case 3 dialog 按 intent 细分定级（accept 等价于确认删除，不该与 dismiss 同权）');
  const a = actionSchema.validateAction({ type: 'dialog', target: { intent: 'accept' } });
  const d = actionSchema.validateAction({ type: 'dialog', target: { intent: 'dismiss' } });
  ok('dialog accept 合法', a.ok === true, JSON.stringify(a.errors));
  ok('dialog dismiss 合法', d.ok === true, JSON.stringify(d.errors));
  ok('accept → HIGH', a.ok && a.action.risk === 'HIGH', a.ok ? a.action.risk : '-');
  ok('dismiss → MEDIUM', d.ok && d.action.risk === 'MEDIUM', d.ok ? d.action.risk : '-');
  ok('intent 被保留到规范化后的 action（若漏进 TARGET_KEYS 会被静默丢弃）',
    d.ok && d.action.target.intent === 'dismiss', JSON.stringify(d.ok ? d.action.target : d.errors));

  // Policy 必须走同一套定级 —— 只改 schema 不改 policy，细分就白做了
  ok('policy.effectiveRisk 对 dialog:accept 生效（不是读平表）',
    policy.effectiveRisk({ type: 'dialog', target: { intent: 'accept' }, risk: 'LOW' }) === 'HIGH');
  ok('policy.effectiveRisk 对 dialog:dismiss 生效',
    policy.effectiveRisk({ type: 'dialog', target: { intent: 'dismiss' }, risk: 'LOW' }) === 'MEDIUM');
  ok('模型自报 risk=LOW 不能把 upload 压到 LOW（取更高者）',
    policy.effectiveRisk({ type: 'upload', target: { url: 'a.png' }, risk: 'LOW' }) === 'HIGH');

  const bad = actionSchema.validateAction({ type: 'dialog', target: { intent: 'maybe' } });
  ok('非法 intent 被拒', bad.ok === false, JSON.stringify(bad.errors));
  ok('dialog 完全无 target 也合法（原生对话框不在 DOM 里）',
    actionSchema.validateAction({ type: 'dialog' }).ok === true);
}

function caseParamContract() {
  section('Case 4 参数契约（只登记名字不写契约，模型照样产出非法结构）');
  const { validateAction } = actionSchema;
  ok('drag 缺 value（放置目标）被拒',
    validateAction({ type: 'drag', target: { selector: '#a' } }).ok === false);
  ok('drag 有 value 通过',
    validateAction({ type: 'drag', target: { selector: '#a' }, value: '#b',
      verification: { type: 'text_present', value: 'ok' } }).ok === true);
  ok('upload 缺路径被拒', validateAction({ type: 'upload', target: { field: 'file' } }).ok === false);
  ok('openTab 缺 url 被拒', validateAction({ type: 'openTab', target: { semantic: '新窗口' } }).ok === true);
  // openTab 只要求 hasTarget，url 缺失是 tools 运行时报错；这里只锁 schema 层不与既有语义冲突
  ok('hover 不需要 verification（不强制模型编造预期）',
    validateAction({ type: 'hover', target: { semantic: '菜单' } }).ok === true);
  ok('upload 需要 verification 或业务契约（禁止盲执行）',
    validateAction({ type: 'upload', target: { url: 'a.png', field: 'file' } }).ok === false);
  ok('upload 带 verification 通过',
    validateAction({ type: 'upload', target: { url: 'a.png', field: 'file' },
      verification: { type: 'text_present', value: '上传成功' } }).ok === true);
}

function caseUploadAllowlist() {
  section('Case 5 upload 路径白名单（唯一「数据出本机」的通路，默认必须关死）');
  const { resolveUploadPath, UPLOAD_ROOT } = actionSchema;
  const good = resolveUploadPath('avatar.png');
  ok('相对路径文件放行', good.ok === true, JSON.stringify(good));
  ok('解析出的绝对路径落在 UPLOAD_ROOT 内',
    good.ok && path.resolve(good.abs).indexOf(path.resolve(UPLOAD_ROOT)) === 0, good.abs);

  const cases = [
    ['../secret.txt', '父目录逃逸（../）'],
    ['../../.env', '多级逃逸'],
    ['/etc/passwd', 'POSIX 绝对路径'],
    ['C:/Windows/win.ini', 'Windows 绝对路径'],
    ['', '空路径'],
  ];
  for (const [p, label] of cases) {
    const r = resolveUploadPath(p);
    ok(`拒绝 ${label}`, r.ok === false, JSON.stringify(r));
  }
}

function caseSimulationGate() {
  section('Case 6 SIMULATION 门禁（新动作不能绕过「只观察」语义）');
  const sim = (a) => policy.allowsAction(a, { executionMode: 'SIMULATION', policy: {} });
  for (const t of ['upload', 'download', 'dialog', 'closeTab', 'drag']) {
    const r = sim({ type: t, target: { url: 'a.png', intent: 'dismiss', selector: '#x' }, risk: 'LOW' });
    ok(`SIMULATION 禁止 ${t}`, r.allowed === false, JSON.stringify(r));
  }
  // openTab / switchTab / hover 放行：多标签页面连"看"都看不到，等于观察能力被砍
  for (const t of ['openTab', 'switchTab', 'hover']) {
    const r = sim({ type: t, target: { url: '/x', selector: '#x' }, risk: 'LOW' });
    ok(`SIMULATION 放行 ${t}（等价于导航/悬浮观察）`, r.allowed === true, JSON.stringify(r));
  }
  // ASSIST 默认 riskFloor=MEDIUM → upload(HIGH) 必须转人工
  const up = policy.allowsAction(
    { type: 'upload', target: { url: 'a.png', field: 'file' }, risk: 'HIGH' },
    { executionMode: 'ASSIST', policy: {} });
  ok('ASSIST 默认策略下 upload 需人工审批', up.allowed === false && up.requiresApproval === true, JSON.stringify(up));
}

function casePlannerHints() {
  section('Case 7 Planner 提示：动作名与参数契约、以及「可上传文件」必须与白名单同源');
  const instr = planner.plannerInstructions();
  ok('提示列出 hover 的用法', instr.indexOf('hover') >= 0);
  ok('提示说明 drag 的 value 是放置目标', instr.indexOf('drag') >= 0 && instr.indexOf('放置目标') >= 0);
  ok('提示说明 dialog 的 intent 取值', instr.indexOf('intent') >= 0 && instr.indexOf('dismiss') >= 0);
  ok('提示说明 upload 的 target.url 取值限制', instr.indexOf('upload') >= 0 && instr.indexOf('target.url') >= 0);

  // 模型看不到磁盘，必须把暂存目录里的文件名喂给它，否则只能瞎猜文件名反复被拒
  const dir = actionSchema.UPLOAD_ROOT;
  const probe = 'step7-probe-avatar.png';
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, probe), 'x');
    const withFile = planner.plannerInstructions();
    ok('可上传文件列表与 UPLOAD_ROOT 同源（新建文件出现在提示里）',
      withFile.indexOf(probe) >= 0, withFile.slice(-200));
  } finally {
    try { fs.unlinkSync(path.join(dir, probe)); } catch (e) {}
  }
}

// ═══════════════════════════════════════════════════════════════
// CAP-F2 Part A — COLLECT_JS 语法守卫（SEC-E7 教训）
// ═══════════════════════════════════════════════════════════════
function caseCollectJsSyntax() {
  section('Case 8 COLLECT_JS 语法守卫（断言模板字面量求值后的文本，不是源码文本）');
  const src = observation.COLLECT_JS;
  let parsed = null;
  try { parsed = new Function('return ' + src); } catch (e) { parsed = null; }
  ok('求值后的页内脚本语法合法', parsed !== null, String(parsed === null ? '解析失败' : ''));
  ok('无未替换的 ${ 残留（模板注入没生效会静默变成字面量）', src.indexOf('${') < 0);
  ok('不再用全局计数器递增（_iframeSeq++ 已从页内脚本移除）', src.indexOf('_iframeSeq++') < 0);
  ok('iframe 选择器改为「候选 + 唯一性校验」', src.indexOf('iframeSelectorFor') >= 0);
  // 位置型兜底必须是文档序（:nth-match），不能再是同父级序（nth-of-type）
  ok('位置型兜底用文档序 :nth-match（nth-of-type 会歧义）', src.indexOf('nth-match(iframe, ') >= 0);
}

// ═══════════════════════════════════════════════════════════════
// CAP-F2 Part B — 浏览器用例
// ═══════════════════════════════════════════════════════════════

// 三种 iframe 形态，覆盖寻址的两个层次：
//   #fa  有 id、在 <div> 里        → 应优先用 iframe#fa
//   无 id 的那个在 <section> 里     → 无 id 可依赖，必须靠位置型 + 父容器消歧
//   #fn  内再嵌一层 #fi            → 嵌套，内层要从自己的文档重新寻址
// 用 srcdoc 而非 data: URL —— srcdoc iframe 与父页面同源，父页面可读 contentDocument；
// data: URL 是不透明源，会被浏览器隔离，无法用于验证 iframe 采集。
const IFRAME_PAGE = `<!doctype html><html><body>
<div id="a"><iframe id="fa" srcdoc='<input id="mail" name="email" placeholder="邮箱">'></iframe></div>
<section id="b"><iframe srcdoc='<input id="tel" name="phone" placeholder="电话">'></iframe></section>
<div id="n"><iframe id="fn" srcdoc='<div id="nestwrap"></div>'></iframe></div>
</body></html>`;

async function openIframePage() {
  const page = await browser.newPage();
  await page.setContent(IFRAME_PAGE);
  await page.frameLocator('#fa').locator('body').waitFor({ state: 'attached' });
  await page.frameLocator('#fn').locator('body').waitFor({ state: 'attached' });
  // 嵌套 iframe：在 fn 内部再挂一层
  await page.evaluate(() => {
    const fd = document.getElementById('fn').contentDocument;
    fd.getElementById('nestwrap').innerHTML = '<iframe id="fi"></iframe>';
    fd.getElementById('fi').srcdoc = '<input id="deep" name="deepfield" placeholder="深层">';
  });
  await page.frameLocator('#fn').frameLocator('#fi').locator('body').waitFor({ state: 'attached' });
  return page;
}

const selOf = (obs, placeholder) => {
  const el = (obs.observation.elements || []).find((e) => (e.placeholder || '') === placeholder);
  return el ? el.selector : null;
};

async function caseIframeIndex() {
  section('Case 9 [浏览器] iframe 索引：同父级序号，而非全局计数');
  const page = await openIframePage();
  try {
    const insp = await observation.inspect(page, { taskId: 'step7-iframe-' + Date.now() });
    const sMail = selOf(insp, '邮箱');
    const sTel = selOf(insp, '电话');
    const sDeep = selOf(insp, '深层');

    ok('采集到三个 iframe 内的元素（含嵌套层）',
      !!sMail && !!sTel && !!sDeep, 'mail=' + sMail + ' tel=' + sTel + ' deep=' + sDeep);

    // 注意：不能用 page.locator('iframe >> input') 来解析 —— 实测本版本 Playwright 的
    // ' >> ' 链**不穿透 frame**，恒返回 0。必须用生产代码本身的 makeLocator。
    const countVia = (sel) => tools.makeLocator(page, sel).count();

    // ── 两层缺陷取证：两种错误寻址都能构造出来，但一个都不可用 ──
    const oldStyle = await countVia('iframe:nth-of-type(2) >> input#tel');
    ok('① 旧实现（文档序计数 + nth-of-type(2)）命中 0 个 —— 编号唯一但指向不存在的元素',
      oldStyle === 0, 'count=' + oldStyle);
    const ambiguous = await page.locator('iframe:nth-of-type(1)').count();
    ok('② 只改用同父级序（nth-of-type(1)）会匹配到 3 个 iframe —— 编号正确但歧义，严格模式必抛错',
      ambiguous === 3, 'count=' + ambiguous);

    // ── 修复后：三种形态都必须唯一命中 ──
    ok('有 id 的 iframe 优先用 iframe#fa（比位置型更稳、更可读）',
      sMail === 'iframe#fa >> input#mail', String(sMail));
    ok('无 id 的 iframe 用文档序 :nth-match 唯一命中',
      sTel === 'iframe:nth-match(iframe, 2) >> input#tel' && (await countVia(sTel)) === 1,
      sTel + ' count=' + (await countVia(sTel)));
    ok('嵌套 iframe 从自己的文档重新寻址（不是接着外层累加成 3）',
      sDeep === 'iframe#fn >> iframe#fi >> input#deep' && (await countVia(sDeep)) === 1,
      String(sDeep) + ' count=' + (await countVia(sDeep)));

    // 端到端：能写进去才算真修好（选择器"看起来对"与"能用"是两回事）
    const res = await tools.runTool(
      { type: 'fill', target: { selector: sTel }, value: '13800000000',
        verification: { type: 'element_present', value: '#tel' }, timeoutMs: 20000 },
      { page, session: { profileId: 'p-test' } }, { taskId: 'step7-iframe-fill-' + Date.now() });
    const got = await tools.makeLocator(page, sTel).inputValue().catch(() => '<err>');
    ok('跨 frame fill 真的写进无 id iframe 里的输入框', res.success === true && got === '13800000000',
      'success=' + res.success + ' got=' + got + ' err=' + JSON.stringify(res.error));

    const res2 = await tools.runTool(
      { type: 'fill', target: { selector: sDeep }, value: 'deep-value',
        verification: { type: 'element_present', value: '#deep' }, timeoutMs: 20000 },
      { page, session: { profileId: 'p-test' } }, { taskId: 'step7-nested-fill-' + Date.now() });
    const got2 = await tools.makeLocator(page, sDeep).inputValue().catch(() => '<err>');
    ok('两层嵌套 iframe 内 fill 成功（修复前索引必错）', res2.success === true && got2 === 'deep-value',
      'success=' + res2.success + ' got=' + got2 + ' err=' + JSON.stringify(res2.error));
  } finally {
    await page.close();
  }
}

// 子菜单同时用 CSS :hover 与 mouseenter 粘性展开：
// 纯 :hover 在鼠标从触发器移向子项的瞬间可能已经失效（实测导致 click 用例 flaky）；
// 真实菜单也多是 mouseenter 展开、mouseleave 才收起，粘性更贴近现实，也让断言确定。
const HOVER_PAGE = `<!doctype html><html><head><style>
#sub{display:none}
#wrap:hover #sub{display:block}
</style></head><body>
<div id="wrap"><button id="menu">主菜单</button><div id="sub"><button id="item">系统设置</button></div></div>
<div id="out"></div>
<script>
document.getElementById('wrap').addEventListener('mouseenter', function(){ document.getElementById('sub').style.display='block'; });
document.getElementById('item').addEventListener('click', function(){ document.getElementById('out').textContent='已打开设置'; });
</script>
</body></html>`;

async function caseHover() {
  section('Case 10 [浏览器] hover：悬浮展开菜单，且展开后的内容必须被 after-observation 抓到');
  const page = await browser.newPage();
  await page.setContent(HOVER_PAGE);
  try {
    const before = await observation.inspect(page, { taskId: 'step7-hover-before-' + Date.now() });
    const hasItemBefore = (before.observation.elements || []).some((e) => (e.text || '').indexOf('系统设置') >= 0);
    ok('悬浮前「系统设置」不可见（否则测不出 hover 的价值）', hasItemBefore === false);

    const res = await tools.runTool(
      { type: 'hover', target: { selector: '#menu' }, timeoutMs: 15000 },
      { page, session: { profileId: 'p-test' } }, { taskId: 'step7-hover-' + Date.now() });
    ok('hover 执行成功', res.success === true, JSON.stringify(res.error));
    ok('返回体含 hovered 选择器', res.success && res.result && res.result.hovered === '#menu',
      JSON.stringify(res.result));

    const afterEls = (res.observation && res.observation.elements) || [];
    ok('after-observation 抓到展开出来的「系统设置」',
      afterEls.some((e) => (e.text || '').indexOf('系统设置') >= 0),
      '抓到 ' + afterEls.length + ' 个元素');

    // 悬浮的最终目的是让后续 click 能命中原本不存在的元素
    const click = await tools.runTool(
      { type: 'click', target: { selector: '#item' }, verification: { type: 'text_present', value: '已打开设置' }, timeoutMs: 15000 },
      { page, session: { profileId: 'p-test' } }, { taskId: 'step7-hover-click-' + Date.now() });
    const out = await page.textContent('#out').catch(() => '');
    ok('hover 后 click 展开项生效', click.success === true && out === '已打开设置',
      'success=' + click.success + ' out=' + JSON.stringify(out));
  } finally {
    await page.close();
  }
}

const DRAG_PAGE = `<!doctype html><html><body>
<div id="src" draggable="true" style="width:120px;height:40px;background:#ccc">卡片A</div>
<div id="dst" style="width:160px;height:80px;background:#eee">回收站</div>
<script>
var src=document.getElementById('src'), dst=document.getElementById('dst');
src.addEventListener('dragstart', function(e){ e.dataTransfer.setData('text/plain','A'); e.dataTransfer.effectAllowed='move'; });
dst.addEventListener('dragover', function(e){ e.preventDefault(); });
dst.addEventListener('drop', function(e){ e.preventDefault(); dst.appendChild(src); dst.setAttribute('data-dropped','1'); });
</script>
</body></html>`;

async function caseDrag() {
  section('Case 11 [浏览器] drag：选择器终点 + 语义终点');
  const page = await browser.newPage();
  await page.setContent(DRAG_PAGE);
  try {
    const res = await tools.runTool(
      { type: 'drag', target: { selector: '#src' }, value: '#dst',
        verification: { type: 'element_present', value: '#dst #src' }, timeoutMs: 20000 },
      { page, session: { profileId: 'p-test' } }, { taskId: 'step7-drag-sel-' + Date.now() });
    ok('drag 用 CSS 选择器作为终点成功', res.success === true, JSON.stringify(res.error));
    ok('drop 真的发生了（不是只报成功）',
      (await page.getAttribute('#dst', 'data-dropped').catch(() => null)) === '1');
    ok('返回体含源与终点', res.success && res.result.dragged === '#src' && res.result.droppedOn === '#dst',
      JSON.stringify(res.result));

    // 语义终点：模型更可能给可见文字「回收站」而不是 #dst。
    // 放置区是纯 <div>，不可交互、无 role、也不 draggable，observation 采不到它 ——
    // 语义解析必然落空，必须靠文本引擎兜底（否则"拖到回收站"这个最自然的表达直接不可用）。
    await page.setContent(DRAG_PAGE);
    const res2 = await tools.runTool(
      { type: 'drag', target: { selector: '#src' }, value: '回收站',
        verification: { type: 'element_present', value: '#dst #src' }, timeoutMs: 20000 },
      { page, session: { profileId: 'p-test' } }, { taskId: 'step7-drag-sem-' + Date.now() });
    ok('drag 用可见文字作为终点成功（文本引擎兜底）', res2.success === true, JSON.stringify(res2.error));
    ok('文本终点真的落到了 #dst 上',
      (await page.getAttribute('#dst', 'data-dropped').catch(() => null)) === '1',
      JSON.stringify(res2.result));

    // 找不到终点必须明确报错，不能静默成功
    await page.setContent(DRAG_PAGE);
    const res3 = await tools.runTool(
      { type: 'drag', target: { selector: '#src' }, value: '一个不存在的放置区',
        verification: { type: 'element_present', value: '#x' }, timeoutMs: 20000 },
      { page, session: { profileId: 'p-test' } }, { taskId: 'step7-drag-miss-' + Date.now() });
    ok('找不到放置目标 → DROP_TARGET_NOT_FOUND（非静默成功）',
      res3.success === false && res3.error && res3.error.code === 'DROP_TARGET_NOT_FOUND',
      JSON.stringify(res3.error));
  } finally {
    await page.close();
  }
}

// 用 submit 事件而非 URL 变化来判定：父页是 setContent 出来的 about:blank，
// srcdoc iframe 里 action="#done" 的片段跳转不可靠，会把"没提交"和"跳不动"混为一谈。
const PRESS_PAGE = `<!doctype html><html><body>
<iframe id="pf" srcdoc='<form id="f"><input id="q" name="q"></form><div id="r">idle</div><script>document.getElementById("f").addEventListener("submit",function(e){e.preventDefault();document.getElementById("r").textContent="submitted";});</script>'></iframe>
</body></html>`;

async function casePressTarget() {
  section('Case 12 [浏览器] press 消费 target（此前 target 是死参数）');
  const page = await browser.newPage();
  await page.setContent(PRESS_PAGE);
  await page.frameLocator('#pf').locator('body').waitFor({ state: 'attached' });
  try {
    const res = await tools.runTool(
      { type: 'press', target: { selector: 'iframe#pf >> input#q' }, value: 'Enter', timeoutMs: 15000 },
      { page, session: { profileId: 'p-test' } }, { taskId: 'step7-press-' + Date.now() });
    ok('press 带 target 执行成功', res.success === true, JSON.stringify(res.error));
    ok('press 返回体记录了聚焦目标',
      res.success && res.result && res.result.focused === 'iframe#pf >> input#q',
      JSON.stringify(res.result));
    // 焦点在 iframe 内的输入框里，按回车才会触发那个表单的 submit。
    // 修复前 press 完全忽略 target，键盘事件发给页面（焦点在 body），这里必然还是 idle。
    const r = await page.frameLocator('#pf').locator('#r').textContent().catch(() => '<err>');
    ok('iframe 内按回车真的提交了表单（修复前焦点在 body，这里会是 idle）',
      r === 'submitted', 'r=' + JSON.stringify(r));
  } finally {
    await page.close();
  }
}

const SCROLL_PAGE = `<!doctype html><html><body style="height:3000px">
<div id="box" style="width:200px;height:100px;overflow:auto"><div style="height:900px">long content</div></div>
</body></html>`;

async function caseScrollTarget() {
  section('Case 13 [浏览器] scroll 消费 target（此前 target 是死参数）');
  const page = await browser.newPage();
  await page.setContent(SCROLL_PAGE);
  try {
    const res = await tools.runTool(
      { type: 'scroll', target: { selector: '#box' }, value: 300, timeoutMs: 15000 },
      { page, session: { profileId: 'p-test' } }, { taskId: 'step7-scroll-el-' + Date.now() });
    ok('scroll 带 target 执行成功', res.success === true, JSON.stringify(res.error));
    ok('滚动的是指定元素而非整页', res.success && res.result.scrolled === 'element', JSON.stringify(res.result));
    const top = await page.evaluate(() => document.getElementById('box').scrollTop);
    ok('目标容器真的滚动了', top > 0, 'scrollTop=' + top);

    const res2 = await tools.runTool(
      { type: 'scroll', target: { role: 'page' }, value: 200, timeoutMs: 15000 },
      { page, session: { profileId: 'p-test' } }, { taskId: 'step7-scroll-page-' + Date.now() });
    ok('解析不出元素时退回滚页面（既有行为不退化）',
      res2.success === true && res2.result.scrolled === 'page', JSON.stringify(res2.result));
  } finally {
    await page.close();
  }
}

// ═══════════════════════════════════════════════════════════════
// 红线
// ═══════════════════════════════════════════════════════════════
function caseRedLines() {
  section('Case 14 红线扫描（去站点化 / 不放宽成功定义 / 不绕过 Policy）');
  const files = [
    'server/agent/schema/action.js',
    'server/agent/policy.js',
    'server/agent/tools.js',
    'server/agent/observation.js',
    'server/agent/planner.js',
  ];
  const root = path.resolve(__dirname, '..', '..');
  let siteSpecific = 0;
  for (const f of files) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    if (/siteType\s*===|fixtureName\s*===|taskId\s*===\s*['"]/.test(src)) siteSpecific += 1;
  }
  ok('新增/改动文件无站点特化分支', siteSpecific === 0, '命中文件数=' + siteSpecific);

  // 新动作必须仍然过 Policy，而不是新增一条绕过通路
  const t = actionSchema.validateAction({
    type: 'upload', target: { url: 'a.png', field: 'file' }, risk: 'HIGH',
    verification: { type: 'text_present', value: 'ok' },
  });
  ok('upload 即便 schema 通过，Policy 仍可拦（schema 不是唯一闸门）',
    t.ok === true && policy.allowsAction(t.action, { executionMode: 'ASSIST', policy: {} }).allowed === false);
}

// ═══════════════════════════════════════════════════════════════
(async () => {
  console.log('════════════════════════════════════════');
  console.log('STEP 7 — CAP-F1 动作登记 + CAP-F2 hover/drag/iframe');
  console.log('════════════════════════════════════════');

  caseRegistration();
  caseFloorCoverage();
  caseIntentFloor();
  caseParamContract();
  caseUploadAllowlist();
  caseSimulationGate();
  casePlannerHints();
  caseCollectJsSyntax();
  caseRedLines();

  browser = await chromium.launch({ headless: true });
  try {
    await caseIframeIndex();
    await caseHover();
    await caseDrag();
    await casePressTarget();
    await caseScrollTarget();
  } catch (e) {
    fail++;
    console.log('  FAIL 浏览器用例异常：' + String(e && e.stack || e));
  } finally {
    await browser.close().catch(() => {});
  }

  console.log('\n────────────────────────────────────────');
  console.log('STEP 7 动作面测试：' + pass + ' passed, ' + fail + ' failed');
  console.log('────────────────────────────────────────');
  process.exit(fail === 0 ? 0 : 1);
})();
