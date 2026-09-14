'use strict';

// C124 守护：元素级「存在性裁决」必须是**唯一实现**且跨层一致。
//
// 缺陷背景（C123 的余波，横向复审 L5 + L6 命中）：
//   observation.elements[] 是 semanticResolver 的唯一候选池，且刻意不收 div/span/p。
//   C123 在 verification.js 补了 contentLeaves 存在性索引，修掉 element_present 假阴性；
//   但**同一份语义在 diagnosis 层还有第二份实现**（verificationIntelligence.js）：
//     D1 clausePresent 根本没有 element_present 分支 ⇒ default 返回 false ⇒
//        任何含该子句的业务契约在 VIL 里结构性不可能成立（planner 契约却鼓励这么写，
//        contract.deriveContract 对 SEARCH_SUCCESS 更是直接产出该子句）。
//     D2 clausePresent 的 element_absent 走裸 resolver ⇒ div/span 形态的目标仍在页面上
//        却判「已消失」⇒ 谎报业务结果达成（假阳性成功证据）。
//     D4 存在性通道施加了可操作性否决（C105 M3 明令禁止）⇒ 放大 D2。
//
// 本套件断言的是**真正执行的那份东西**：
//   · A 组走真实 verificationIntelligence.analyze，断言 decision/failureType（不是内部函数返回值）；
//   · B 组把修复换 no-op（抽掉 contentLeaves）证明断言精确咬住目标（L7 双向验证）；
//   · C 组做 verification 层 ↔ diagnosis 层的 parity，防止未来再次分叉；
//   · E 组确认「证据缺失」不会翻转结论（这一版只能凭正面证据认定存在）。

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const verification = require(path.join(ROOT, 'server/agent/verification.js'));
const vil = require(path.join(ROOT, 'server/agent/verification/verificationIntelligence.js'));
const existence = require(path.join(ROOT, 'server/agent/existence.js'));
const semanticResolver = require(path.join(ROOT, 'server/agent/semanticResolver.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  [' + extra + ']' : '')); }
}

// 去掉注释后再做静态匹配 —— 否则注释里引用的旧写法会把守护变成自指陷阱（L3/C123 教训）。
function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 构造一个稳定的 after 观察（页面稳定、无异步 pending 信号，确保探针落到 4b 那条分支）。 */
function afterObs(opts) {
  const o = opts || {};
  return {
    url: o.url || 'https://example.test/app',
    loadingState: 'complete',
    networkState: 'idle',
    textSummary: o.textSummary || 'app shell rendered',
    visibleText: o.textSummary || 'app shell rendered',
    elements: o.elements || [],
    contentLeaves: o.contentLeaves || [],
  };
}

/** 页面上的展示性内容：只有 span/div 叶子，elements 池为空（C123 P1 六例的真实形态）。 */
const SPAN_ONLY = afterObs({
  contentLeaves: [
    { tag: 'span', cls: 'board-title', id: null, text: 'Dashboard' },
    { tag: 'div', cls: 'result-count', id: null, text: '12 results found' },
  ],
  textSummary: 'Dashboard 12 results found',
});

/** 跑真实 VIL 决策：返回 { decision, failureType, confidence }。 */
function analyzeIt(expectedVerification, after, actionType, beforeOverride) {
  return vil.analyze({
    beforeObservation: beforeOverride || afterObs({ url: 'https://example.test/start', textSummary: 'start page' }),
    afterObservation: after,
    expectedVerification,
    actionResult: { success: true },
    action: { type: actionType || 'click', risk: 'LOW', target: { semantic: 'continue' } },
  });
}

function bsContract(clauses, logic) {
  return { businessState: { stateType: 'TEST_STATE', requiredEvidence: clauses, evidenceLogic: logic || 'AND', forbiddenEvidence: [] } };
}

(async function main() {
  console.log('=== A 组：真实 VIL 决策级探针（断言 decision/failureType）===');
  // A1：业务契约要求 element_present "Dashboard"，页面上它只是个 span 叶子。
  //     修复前：clausePresent 无该分支 ⇒ 恒 false ⇒ 走到「证据不足」而非 TOO_STRICT。
  const r1 = analyzeIt(bsContract([{ type: 'element_present', expect: 'Dashboard' }]), SPAN_ONLY);
  ok('A1 含 element_present 子句的业务契约可被 VIL 认定成立（D1）',
    r1.failureType === 'VERIFICATION_TOO_STRICT' && r1.decision === 'RETRY_VERIFY',
    'failureType=' + r1.failureType + ' decision=' + r1.decision);

  // A2：D2 的正向 —— 目标仍以 span 形态留在页面上时，element_absent 不得谎报「已消失」，
  //     否则 VIL 会以为业务结果其实达成了（假阳性成功证据），把失败步骤判成 TOO_STRICT。
  const r2 = analyzeIt(bsContract([{ type: 'element_absent', expect: 'Dashboard' }]), SPAN_ONLY);
  ok('A2 目标仍在（span 叶子）时不得谎报已消失（D2）',
    r2.failureType !== 'VERIFICATION_TOO_STRICT',
    'failureType=' + r2.failureType + ' decision=' + r2.decision);

  // A3：目标真的消失（既不在 elements、也不在 contentLeaves）⇒ element_absent 仍应成立
  //     —— 修 bug 不能靠「让 absent 永远判仍在」来实现（旧行为保留）。
  const gone = afterObs({ contentLeaves: [{ tag: 'h1', cls: 'title', id: null, text: 'Home' }], textSummary: 'Home' });
  const r3 = analyzeIt(bsContract([{ type: 'element_absent', expect: 'Dashboard' }]), gone);
  ok('A3 目标确实消失时 element_absent 仍判成立（不为了修 A2 反向放宽）',
    r3.failureType === 'VERIFICATION_TOO_STRICT',
    'failureType=' + r3.failureType);

  // A4：elements[] 命中路径不受影响（<button> 是动作目标，本就在池里）
  const btnObs = afterObs({
    elements: [{ id: 'b1', tag: 'button', role: 'button', type: 'button', text: 'Continue', visible: true, cls: 'btn', state: {} }],
    textSummary: 'Continue',
  });
  const r4 = analyzeIt(bsContract([{ type: 'element_absent', expect: 'Continue' }]), btnObs);
  ok('A4 actions 目标仍在 elements[] 里时 element_absent 仍判 false', r4.failureType !== 'VERIFICATION_TOO_STRICT',
    'failureType=' + r4.failureType);

  console.log('=== B 组：no-op 双向验证（断言必须精确咬住存在性索引）===');
  // 抽掉 contentLeaves = 把本批修复还原（等价于修复前的 resolver-only 实现）。
  const stripped = Object.assign({}, SPAN_ONLY, { contentLeaves: [] });
  const n1 = analyzeIt(bsContract([{ type: 'element_present', expect: 'Dashboard' }]), stripped);
  ok('B1 A1 的 no-op：无存在性索引时立即回到「证据不足」（断言确实咬住该索引）',
    n1.failureType !== 'VERIFICATION_TOO_STRICT', 'failureType=' + n1.failureType);
  const n2 = analyzeIt(bsContract([{ type: 'element_absent', expect: 'Dashboard' }]), stripped);
  ok('B2 A2 的 no-op：无存在性索引时 element_absent 重新谎报「已消失」（还原修复前形态）',
    n2.failureType === 'VERIFICATION_TOO_STRICT', 'failureType=' + n2.failureType);

  console.log('=== C 组：跨层 parity（verification 层 ↔ diagnosis 层不得再分叉）===');
  const matrix = ['Dashboard', '12 results found', '不存在的目标XYZ'];
  for (const ex of matrix) {
    const strict = verification.verify({ type: 'element_present', expect: ex }, SPAN_ONLY, null).success;
    // loose 是**有意更宽**的口径（答的是「有没有字面痕迹」），故只断言单向包含：
    // 裁决层说存在 ⇒ 诊断层必须也说存在。反向不成立即为偷换判据或分叉。
    const looseProbe = vil.analyze({
      beforeObservation: afterObs({ url: 'https://example.test/start' }),
      afterObservation: SPAN_ONLY,
      expectedVerification: { type: 'element_present', expect: ex },
      actionResult: { success: true },
      action: { type: 'click', risk: 'LOW', target: { semantic: 'continue' } },
    });
    const loose = looseProbe.failureType === 'VERIFICATION_TOO_STRICT';
    ok('C parity "' + ex + '"：裁决层存在 ⇒ 诊断层存在（strict⊆loose）',
      strict === false || loose === true, 'strict=' + strict + ' loose=' + loose);
  }
  const absentMatrix = ['Dashboard', '不存在的目标XYZ'];
  for (const ex of absentMatrix) {
    const vAbs = verification.verify({ type: 'element_absent', expect: ex }, SPAN_ONLY, null).success;
    const vilStates = analyzeIt(bsContract([{ type: 'element_absent', expect: ex }]), SPAN_ONLY);
    const vilAbs = vilStates.failureType === 'VERIFICATION_TOO_STRICT';
    ok('C absent parity "' + ex + '"：裁决层与诊断层结论一致', vAbs === vilAbs,
      'verification=' + vAbs + ' vil=' + vilAbs);
  }

  console.log('=== D 组：严格/宽松分档（不得把 loose 信号混进成功裁决）===');
  // 注入面：语义解析器用「恒空」桩替代，隔离出「存在性索引通道」与「loose 字段子串通道」。
  // 不能用真 resolver 做本组断言 —— 它的模糊匹配连 "Board Nex" 这类碎片都能命中
  // （实测 strict.via 恒为 resolver），会把两条通道混在一起，断言看似通过实则零判别力。
  const noResolver = () => [];
  const twoEls = afterObs({
    elements: [
      { id: 'a', tag: 'a', role: 'link', text: 'Dash', visible: true, cls: 'x', state: {} },
      { id: 'b', tag: 'a', role: 'link', ariaLabel: 'board next', text: '', visible: true, cls: 'y', state: {} },
    ],
  });
  // 诚实记录（勿把「清理」包装成「修 bug」）：旧口径把整页元素字段串成一条字符串且**不折叠空白**。
  // 元素间接缝恒含 ≥6 个空白（6 个字段各留一个分隔符），要跨元素误命中必须 expect 自带同样长的
  // 空白串 —— 现实不可达。故本批**不声称**修掉了跨元素假阳性；这里只锁住「不得再退化回整页串联」。
  const legacyPool = (twoEls.elements || []).map((e) => [e.text, e.placeholder, e.ariaLabel, e.label, e.innerText, e.roleText].join(' ')).join(' ').toLowerCase();
  const seam = legacyPool.replace(/[a-z]/g, '');
  ok('D0 差异核查：旧口径元素间接缝确实是多空白（≥2），跨元素假阳性现实不可达 ⇒ 本批不声称修它',
    seam.includes('  '), 'seam=' + JSON.stringify(seam));
  ok('D1 loose 按单元素各自拼接（即使折叠空白后也不会跨元素接缝命中）',
    existence.elementExists(twoEls, 'dash board', noResolver, { loose: true }).found === false);
  ok('D2 loose 允许单元素内字段子串（hit ariaLabel）',
    existence.elementExists(twoEls, 'board next', noResolver, { loose: true }).via === 'elementSubstring');
  ok('D3 strict 不接受 loose 弱信号（同一 fixture、同一桩 resolver，仅档位不同）',
    existence.elementExists(twoEls, 'board next', noResolver, {}).found === false);
  ok('D4 strict 仍认 contentLeaves 索引（成功裁决必须能用到存在性证据）',
    existence.elementExists(SPAN_ONLY, 'Dashboard', noResolver, {}).via === 'contentLeaf');
  // D5 才是本组唯一的行为差异：旧口径逐字 includes（不折叠空白）⇒ 元素内文本带换行/多空格时，
  // 视觉上完全相同的 expect 反而匹配不上。loose 档（只用于判「是否过严」）应当容忍空白差异。
  const wsEls = afterObs({
    elements: [{ id: 'r', tag: 'button', role: 'button', text: 'Export\n  report', visible: true, cls: 'b', state: {} }],
  });
  const legacyWs = String('Export\n  report').toLowerCase();
  ok('D5a 差异核查：旧口径在「含换行的元素文本」上确实匹配不到同行 expect', !legacyWs.includes('export report'));
  ok('D5b loose 折叠空白后命中（差异真实且只发生在 loose 档）',
    existence.elementExists(wsEls, 'Export report', noResolver, { loose: true }).found === true);

  console.log('=== E 组：静态契约（事实源锚点 + 禁止旧写法复活）===');
  const esrc = fs.readFileSync(path.join(ROOT, 'server/agent/existence.js'), 'utf8');
  const vsrc = stripComments(fs.readFileSync(path.join(ROOT, 'server/agent/verification.js'), 'utf8'));
  const isrc = stripComments(fs.readFileSync(path.join(ROOT, 'server/agent/verification/verificationIntelligence.js'), 'utf8'));
  ok('E1 存在性索引实现只在 existence.js 里出现一次',
    (esrc.match(/function matchContentLeaf\(/g) || []).length === 1);
  ok('E2 verification.js 不再自带该实现（改为 require 共用原语）',
    !/function matchContentLeaf\(/.test(vsrc) && /require\('\.\/existence'\)/.test(vsrc));
  ok('E3 verificationIntelligence.js 不再自带该实现（改为 require 共用原语）',
    !/function matchContentLeaf\(/.test(isrc) && /require\('\.\.\/existence'\)/.test(isrc));
  ok('E4 clausePresent 必须同时具备 element_present 与 element_absent 分支',
    /case 'element_present':/.test(isrc) && /case 'element_absent':/.test(isrc));
  ok('E5 存在性通道不得再出现裸 resolver 长度判空（D2 的字面形态）',
    !/semanticResolver\.resolve\(t, after\)\.length === 0/.test(isrc));
  ok('E6 存在性裁决不对 missing expect 抛异常且返回未找到',
    existence.elementExists({}, '', semanticResolver.resolve, {}).found === false);

  console.log('=== F 组：防空（畸形输入不得翻转结论）===');
  const shapes = [
    {}, { contentLeaves: undefined }, { contentLeaves: null }, { elements: null },
    { contentLeaves: [null, undefined, {}] }, { contentLeaves: [{ tag: 'span', cls: 'c', text: null }] },
  ];
  let survived = true;
  for (const s of shapes) {
    try {
      const r = existence.elementExists(s, 'Dashboard', semanticResolver.resolve, {});
      if (r.found !== false) survived = false;
    } catch (e) { survived = false; }
  }
  ok('F1 畸形/空观察一律返回「未找到」且不抛异常', survived);
  ok('F2 单字符 expect 不参与存在性判定（长度闸门仍生效）',
    existence.elementExists({ contentLeaves: [{ tag: 'span', cls: 'c', text: 'A' }] }, 'A', semanticResolver.resolve, {}).found === false);
  ok('F3 无 contentLeaves 的旧观察：verbatim 目标仍走 resolver 通道', (function () {
    const old = afterObs({ elements: [{ id: 'nav', tag: 'nav', role: 'navigation', text: 'Menu', visible: true, cls: 'm', state: {} }] });
    return existence.elementExists(old, 'Menu', semanticResolver.resolve, {}).via === 'resolver';
  })());

  console.log('=== G 组：真实推导契约（证明缺陷落在主链路，而非手写 fixture 的产物）===');
  const contract = require(path.join(ROOT, 'server/agent/verification/contract.js'));
  // 生产路径 buildEffectiveVerification() 对每个关键业务动作都附 deriveContract 推导合约，
  // 该合约再由 VIL 的 businessStatePresent → clausePresent 逐子句求值。
  const dSearch = contract.deriveContract({ type: 'search', target: { semantic: 'q' } });
  const dClick = contract.deriveContract({ type: 'click', target: { semantic: 'Go to next step' } });
  ok('G1 生产路径确实产出含 element_present 的推导契约（SEARCH）',
    (dSearch.requiredEvidence || []).some((c) => c.type === 'element_present'));
  ok('G2 生产路径确实产出含 element_absent 的推导契约（CLICK）',
    (dClick.requiredEvidence || []).some((c) => c.type === 'element_absent'));
  // G3 是关键：一次「点了但页面没动」的 click。推导契约是 OR(page_change, element_absent)，
  //    这里让 before/after 的 url 与文本完全一致 ⇒ page_change 子句为假 ⇒ 契约是否达成**只由
  //    element_absent 决定**。修复前：目标虽仍在页面上却判「已消失」⇒ 推导契约被判达成
  //    ⇒ VIL 谎报业务结果达成（TOO_STRICT）—— 这正是验收排序里最忌讳的伪造 Business Success。
  const clickObs = afterObs({
    url: 'https://example.test/landing',
    textSummary: 'Go to next step',
    contentLeaves: [{ tag: 'div', cls: 'cta', id: null, text: 'Go to next step' }],
  });
  const sameBefore = afterObs({ url: 'https://example.test/landing', textSummary: 'Go to next step', contentLeaves: [] });
  const rg3 = analyzeIt({ businessState: dClick }, clickObs, 'click', sameBefore);
  ok('G3 点击目标仍在页面上 ⇒ 不得据 element_absent 谎报业务结果达成',
    rg3.failureType !== 'VERIFICATION_TOO_STRICT',
    'failureType=' + rg3.failureType);
  // G4 对照（同样「页面未跳转」以保证只由 element_absent 决定）：SPA 原地移走了 CTA ⇒
  //    目标确已消失 ⇒ element_absent 必须仍然成立 —— 证明 G3 不是靠「让 absent 永不成立」达标。
  const spaAfter = afterObs({
    url: 'https://example.test/landing',
    textSummary: 'step two',
    contentLeaves: [{ tag: 'div', cls: 'panel', id: null, text: 'step two' }],
  });
  const rg3b = analyzeIt({ businessState: dClick }, spaAfter, 'click', sameBefore);
  ok('G4 页面未跳转但目标确已消失 ⇒ element_absent 仍成立（不得为修 G3 而反向放宽）',
    rg3b.failureType === 'VERIFICATION_TOO_STRICT',
    'failureType=' + rg3b.failureType);

  console.log('=== H 组：page_change 跨层一致性（D5，比较型谓词两侧同口径）===');
  const sameA = afterObs({ url: 'https://example.test/landing', textSummary: 'same page', visibleText: 'same page' });
  const sameB = afterObs({ url: 'https://example.test/landing', textSummary: 'same page', visibleText: 'same page' });
  const pageOnly = { businessState: { stateType: 'T', requiredEvidence: [{ type: 'page_change' }], evidenceLogic: 'AND', forbiddenEvidence: [] } };
  // H0 差异核查：旧公式下两侧确实不可能相等（after 恒多一个尾随空格）——证明修复改变了真实行为。
  ok('H0 差异存在性：旧的一侧拼接公式使「内容未变」也判为不等',
    ((sameA.visibleText || '') + ' ' + (sameA.roleText || '')) !== (sameB.visibleText || ''));
  const h1 = analyzeIt(pageOnly, sameA, 'click', sameB);
  ok('H1 页面完全没变 ⇒ VIL 不得判 page_change 成立（修复前恒真）',
    h1.failureType !== 'VERIFICATION_TOO_STRICT', 'failureType=' + h1.failureType);
  ok('H1b 与 verification.js 同口径（见到同一组观察必须给同一答案）',
    verification.verify({ type: 'page_change' }, sameA, sameB).success === (h1.failureType === 'VERIFICATION_TOO_STRICT'));
  const changed = afterObs({ url: 'https://example.test/landing', textSummary: 'step two', visibleText: 'step two' });
  const h2 = analyzeIt(pageOnly, changed, 'click', sameB);
  ok('H2 文本真的变了 ⇒ VIL 仍判 page_change 成立（不得为修 H1 反向禁掉）',
    h2.failureType === 'VERIFICATION_TOO_STRICT', 'failureType=' + h2.failureType);
  const navA = afterObs({ url: 'https://example.test/step3', textSummary: 'same page', visibleText: 'same page' });
  const h3 = analyzeIt(pageOnly, navA, 'click', sameB);
  ok('H3 URL 真的跳了 ⇒ page_change 仍成立', h3.failureType === 'VERIFICATION_TOO_STRICT', 'failureType=' + h3.failureType);

  console.log('\n=== C124 守护结果：通过 ' + pass + ' / 失败 ' + fail + ' ===');
  if (fail > 0) {
    // 与既有套件口径一致：非零退出
    console.error('C124 GUARD FAILED: ' + fail);
    assert.fail('C124 守护存在 ' + fail + ' 项失败');
  }
})().catch((e) => {
  console.error('C124 GUARD ERROR: ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
