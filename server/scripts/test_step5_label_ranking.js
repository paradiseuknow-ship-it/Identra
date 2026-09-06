'use strict';
// test_step5_label_ranking.js — CAP-E5-LABEL-RANKING 专项测试
//
// 缺陷（回归套件里已登记的 P1 缺口）：
//   真实登录/注册表单最常见的结构是 `<label for="x">用户名</label><input id="x">`。
//   target={"semantic":"用户名"} 时 label 与 input 都得 0.92 分，
//   排序退化为「DOM 顺序」→ label 在前 → 胜出 → 后续 fill 打在不可输入的 label 上，
//   动作无效果。这是 ELEMENT_NOT_FOUND 的重要来源，直接卡住登录（Scenario 002）
//   与注册（Scenario 001）两个最高频场景。
//
// 根因不是评分不够准，而是**候选池里混了两类元素却没有类别概念**：
//   observation.js 的 Phase 9 P1 把 form/label/h1~h3/img 补进候选池，
//   是为了「候选发现与 element_present 验证」（<form id="regForm"> 曾被漏掉），
//   不是为了当动作目标。于是它们和真正的控件同台竞争，并在同分时靠 DOM 顺序取胜。
//
// 本测试锁定修复行为，同时**反向锁定不误伤**（form 仍可被 element_present 找到、
// 无关联控件的 label 不得被降权）。

const { chromium } = require('playwright');
const observation = require('../agent/observation');
const resolver = require('../agent/semanticResolver');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  << ' + extra : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

(async () => {
  const browser = await chromium.launch({ headless: true });

  async function resolveTop(html, target) {
    const page = await browser.newPage();
    try {
      await page.setContent(html);
      const obs = (await observation.inspect(page, { taskId: 'test' })).observation;
      return resolver.resolve(target, obs);
    } finally {
      await page.close();
    }
  }

  // ───────────────────────────────────────────────────────
  section('Case 1  label[for] 关联：必须定位到输入框而非 label');
  {
    const html = '<form><label for="uname">用户名</label><input id="uname" name="username"></form>';
    let c = await resolveTop(html, { semantic: '用户名' });
    ok('1.1 semantic「用户名」→ input#uname', c[0] && c[0].elementId === 'uname',
      c[0] && (c[0].elementId || c[0].selector) + ' score=' + c[0].score);
    ok('1.2 命中元素是控件类别', c[0] && c[0].elementClass === 'control', c[0] && c[0].elementClass);
    ok('1.3 关联 label 仍在候选池（供 element_present 使用，只是被降权）',
      c.some((x) => x.el && x.el.tag === 'label'), JSON.stringify(c.map((x) => x.el && x.el.tag)));
    ok('1.4 关联 label 的分数已低于控件',
      c.some((x) => x.el && x.el.tag === 'label' && x.score < c[0].score),
      JSON.stringify(c.map((x) => [(x.el && x.el.tag) || '?', x.score])));

    c = await resolveTop(html, { field: 'username' });
    ok('1.5 field 路径不受影响', c[0] && c[0].elementId === 'uname', c[0] && c[0].elementId);
  }

  // ───────────────────────────────────────────────────────
  section('Case 2  包裹式 label（无 for 属性）同样修复');
  {
    const html = '<form><label>邮箱<input id="em" name="email" type="email"></label></form>';
    const c = await resolveTop(html, { semantic: '邮箱' });
    ok('2.1 包裹式 label → input#em', c[0] && c[0].elementId === 'em',
      c[0] && (c[0].elementId || c[0].selector));
  }

  // ───────────────────────────────────────────────────────
  section('Case 3  密码字段（label + type=password）');
  {
    const html = '<form><label for="pw">密码</label><input id="pw" name="password" type="password"></form>';
    const c = await resolveTop(html, { semantic: '密码' });
    ok('3.1 semantic「密码」→ input#pw', c[0] && c[0].elementId === 'pw', c[0] && c[0].elementId);
    ok('3.2 命中元素是控件类别', c[0] && c[0].elementClass === 'control');
  }

  // ───────────────────────────────────────────────────────
  section('Case 4  多字段表单：不得串味（找密码不能拿到用户名框）');
  {
    const html = '<form>'
      + '<label for="a">用户名</label><input id="a" name="username">'
      + '<label for="b">密码</label><input id="b" name="password" type="password">'
      + '</form>';
    let c = await resolveTop(html, { semantic: '密码' });
    ok('4.1 「密码」→ input#b', c[0] && c[0].elementId === 'b', c[0] && c[0].elementId);
    c = await resolveTop(html, { semantic: '用户名' });
    ok('4.2 「用户名」→ input#a', c[0] && c[0].elementId === 'a', c[0] && c[0].elementId);
  }

  // ───────────────────────────────────────────────────────
  section('Case 5  复选框：label 文字命中时应定位到 checkbox 本体');
  {
    const html = '<form><input type="checkbox" id="agree" name="agree">'
      + '<label for="agree">我已阅读并同意服务条款</label></form>';
    const c = await resolveTop(html, { semantic: '同意' });
    ok('5.1 「同意」→ checkbox#agree（而非 label）', c[0] && c[0].elementId === 'agree',
      c[0] && (c[0].elementId || c[0].selector));
  }

  // ───────────────────────────────────────────────────────
  section('Case 6  同分时控件优先（button 与标题文字相同）');
  {
    const html = '<h2>导出</h2><button id="exp">导出</button>';
    const c = await resolveTop(html, { semantic: '导出' });
    ok('6.1 同分下 button#exp 胜过 <h2>', c[0] && c[0].elementId === 'exp',
      c[0] && ((c[0].elementId || c[0].selector) + ' tag=' + (c[0].el && c[0].el.tag)));
  }

  // ───────────────────────────────────────────────────────
  section('Case 7  [不误伤] element_present 依赖的结构性元素仍可被找到');
  {
    // Phase 9 P1 把 form 补进候选池的初衷：element_present="form" 曾恒为未找到。
    // 降权只影响排序，绝不能把 form 挤出候选池。
    const html = '<form id="regForm"><label for="u">用户名</label><input id="u" name="username"></form>';
    const c = await resolveTop(html, 'form');
    ok('7.1 element_present="form" 仍能找到 form', c.length > 0 && c[0].el && c[0].el.tag === 'form',
      JSON.stringify(c.map((x) => [(x.el && x.el.tag) || '?', x.score])));
    ok('7.2 form 是第一名（没有控件与之竞争该语义）', c[0] && c[0].elementId === 'regForm',
      c[0] && c[0].elementId);
  }

  // ───────────────────────────────────────────────────────
  section('Case 8  [不误伤] 无关联控件的 label 不得被降权');
  {
    // 页面上存在纯展示性 label（既无 for，也不包裹任何控件）时，
    // 它本身就是唯一合理候选，降权会让它被无关元素挤掉。
    const html = '<div><label>记住我</label><span>其它</span></div>';
    const c = await resolveTop(html, { semantic: '记住我' });
    ok('8.1 独立 label 仍是第一名', c[0] && c[0].el && c[0].el.tag === 'label',
      c[0] && ((c[0].el && c[0].el.tag) + ' score=' + c[0].score));
    ok('8.2 独立 label 未被降权（分数未被打 0.8 折）', c[0] && c[0].score === 0.92, String(c[0] && c[0].score));
  }

  // ───────────────────────────────────────────────────────
  section('Case 9  [红线] 修复必须是通用 DOM 结构规则，不得含站点特定逻辑');
  {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'semanticResolver.js'), 'utf8');
    const banned = [
      ['saas', /saas/i], ['cloudsaas', /cloudsaas/i],
      ['mock 品牌 戴尔', /戴尔/], ['mock 品牌 飞利浦', /飞利浦/], ['mock 品牌 华硕', /华硕/],
      ['siteType 判定', /siteType/], ['expectedSite 判定', /expectedSite/],
      ['按 id 硬编码某站点元素', /if\s*\(\s*el\.id\s*===?\s*['"](uname|username|email|regForm)/],
    ];
    let i = 0;
    for (const [name, re] of banned) {
      i += 1;
      ok(`9.${i} 源码不含 ${name}`, !re.test(src), '命中：' + (src.match(re) || [])[0]);
    }
    // 类别判定必须基于标准 HTML 标签语义
    ok('9.9 控件集合由标准表单/交互标签构成',
      /CONTROL_TAGS = new Set\(\[[\s\S]{0,200}'input'[\s\S]{0,200}'button'/.test(src));
    ok('9.10 描述性集合与 observation 补齐进池的标签一致',
      /DESCRIPTIVE_TAGS = new Set\(\[[\s\S]{0,120}'form'[\s\S]{0,120}'label'/.test(src));
  }

  await browser.close();
  console.log('\n────────────────────────────');
  console.log(`PASS=${pass}  FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常：', e); process.exit(2); });
