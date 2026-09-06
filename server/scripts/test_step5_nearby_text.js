'use strict';
// test_step5_nearby_text.js — CAP-E6-NEARBY-TEXT-DEAD 专项测试
//
// 缺陷：semanticResolver.scoreNearbyText()（Signal 3）读
//       el.parentText / el.siblingText / el.nearbyText / el.containerText，
//       但 observation.js 的 COLLECT_JS 从不写入这四个字段 —— 全库 grep 的
//       生产者只有测试夹具。也就是说：Resolver 五个信号里有一个在生产中是死壳。
//
// 它本该解决的真实形态：`<h3>用户名</h3><input name="username">`
//   没有 label[for] 关联，控件自身只有英文 name，语义只存在于旁边的标题文字里。
//   真实站点大量用 div/h3/p 做字段标题（label[for] 覆盖率远低于教科书示例）。
//
// 本测试同时锁定三件容易被后续改动破坏的事：
//   1. COLLECT_JS 语法守卫 —— 它是**字符串**里的页内脚本，语法错误不会被
//      require() 发现，只会让所有 observation.inspect 在运行时全崩。
//   2. 邻近文本必须走 redact —— 这是新增的文本外泄面。
//   3. 不得串味 —— 同一容器内多个字段各自只拿自己前面的文字。

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const observation = require('../agent/observation');
const resolver = require('../agent/semanticResolver');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  << ' + extra : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

let browser;

// 打开页面 → 观察 → 返回 { obs, byId }
async function inspect(html) {
  const page = await browser.newPage();
  await page.setContent(html);
  const insp = await observation.inspect(page, { taskId: 'cap-e6-' + Math.random().toString(36).slice(2) });
  const obs = insp.observation;
  const byId = {};
  (obs.elements || []).forEach((e) => { if (e.id) byId[e.id] = e; });
  await page.close();
  return { insp, obs, byId };
}

async function resolveTop(html, target) {
  const { obs } = await inspect(html);
  return { cands: resolver.resolve(target, obs), obs };
}

(async () => {
  browser = await chromium.launch({ headless: true });

  // ───────────────────────────────────────────────────────
  section('Case 1  COLLECT_JS 语法守卫（字符串脚本，require 发现不了语法错误）');
  {
    let err = null;
    try {
      // 编译但不执行：语法错误会在这一步抛出（页内 API 如 document 并不存在）。
      // eslint-disable-next-line no-new-func
      new Function('return (' + observation.COLLECT_JS + ')');
    } catch (e) { err = e; }
    ok('1.1 COLLECT_JS 可编译', !err, err && String(err.message).slice(0, 160));
    ok('1.2 COLLECT_JS 是页内 IIFE 表达式', /^\s*\(\(\)\s*=>/.test(observation.COLLECT_JS || ''),
      (observation.COLLECT_JS || '').slice(0, 40));

    // 运行时守卫：语法/引用错误会让 page.evaluate 抛错 → inspect 返回 ok:false
    const { insp } = await inspect('<div><h3>用户名</h3><input id="un" name="username"></div>');
    ok('1.3 真实浏览器 inspect 成功返回', insp && insp.ok === true, insp && insp.error);
    ok('1.4 观察结果含 elements', !!(insp && insp.observation && insp.observation.elements));
  }

  // ───────────────────────────────────────────────────────
  section('Case 2  字段被真实写入（修复前恒为 undefined）');
  {
    const { byId, obs } = await inspect('<div><h3>用户名</h3><input id="un" name="username"></div>');
    const el = byId.un;
    ok('2.1 input 元素存在', !!el, JSON.stringify(Object.keys(byId)));
    ok('2.2 siblingText = 前一个兄弟标题的文字', el && el.siblingText === '用户名', el && el.siblingText);
    ok('2.3 nearbyText 非空', el && String(el.nearbyText || '').includes('用户名'), el && el.nearbyText);
    ok('2.4 四个字段均已定义（不再是死壳）',
      el && ['parentText', 'siblingText', 'nearbyText', 'containerText'].every((k) => typeof el[k] === 'string'),
      el && JSON.stringify(['parentText', 'siblingText', 'nearbyText', 'containerText'].map((k) => [k, typeof el[k]])));
    const keys = new Set();
    (obs.elements || []).forEach((e) => Object.keys(e).forEach((k) => keys.add(k)));
    ok('2.5 元素字段全集含 nearbyText 家族',
      ['parentText', 'siblingText', 'nearbyText', 'containerText'].every((k) => keys.has(k)),
      JSON.stringify([...keys]));
  }

  // ───────────────────────────────────────────────────────
  section('Case 3  【缺口验收准则】h3 标题 + 无关联 input → 必须定位到 input');
  {
    const html = '<div><h3>用户名</h3><input id="un" name="username"></div>';
    const { cands } = await resolveTop(html, { semantic: '用户名' });
    ok('3.1 第一名是 input#un（不是 <h3>）', cands[0] && cands[0].elementId === 'un',
      cands[0] && ((cands[0].elementId || cands[0].selector) + ' tag=' + (cands[0].el && cands[0].el.tag)));
    ok('3.2 第一名是可操作控件', cands[0] && cands[0].elementClass === 'control', cands[0] && cands[0].elementClass);
    ok('3.3 命中来自邻近文本信号', cands[0] && /nearby_text|dom_relationship/.test(cands[0].reason || ''),
      cands[0] && cands[0].reason);
    ok('3.4 h3 仍在候选池（未被剔除，只是封顶让位）',
      cands.some((x) => x.el && x.el.tag === 'h3'),
      JSON.stringify(cands.map((x) => [(x.el && x.el.tag) || '?', x.score])));
    ok('3.5 h3 分数已低于 input',
      cands[0] && cands.some((x) => x.el && x.el.tag === 'h3' && x.score < cands[0].score),
      JSON.stringify(cands.map((x) => [(x.el && x.el.tag) || '?', x.score])));
  }

  // ───────────────────────────────────────────────────────
  section('Case 4  [正确性底线] 同一容器内多字段不得串味');
  {
    // 若 parentText 取「父容器全部直接文本」，两个 input 都会拿到「用户名 密码」，
    // 定位必然错。这里用最恶劣的扁平结构（无包裹元素）锁死该行为。
    const html = '<div>用户名<input id="a" name="username">密码<input id="b" name="password" type="password"></div>';
    const { byId } = await inspect(html);
    ok('4.1 input#a 只拿到自己前面的文字', byId.a && byId.a.parentText === '用户名',
      byId.a && JSON.stringify(byId.a.parentText));
    ok('4.2 input#b 只拿到自己前面的文字', byId.b && byId.b.parentText === '密码',
      byId.b && JSON.stringify(byId.b.parentText));

    let r = await resolveTop(html, { semantic: '密码' });
    ok('4.3 「密码」→ input#b', r.cands[0] && r.cands[0].elementId === 'b',
      r.cands[0] && (r.cands[0].elementId || r.cands[0].selector));
    r = await resolveTop(html, { semantic: '用户名' });
    ok('4.4 「用户名」→ input#a', r.cands[0] && r.cands[0].elementId === 'a',
      r.cands[0] && (r.cands[0].elementId || r.cands[0].selector));
  }

  // ───────────────────────────────────────────────────────
  section('Case 5  包裹式 label（无兄弟元素）—— 走「紧邻在前文本」通道');
  {
    const html = '<form><label>邮箱<input id="em" name="email" type="email"></label></form>';
    const { byId } = await inspect(html);
    ok('5.1 parentText 采到包裹 label 的文字', byId.em && byId.em.parentText === '邮箱',
      byId.em && JSON.stringify(byId.em.parentText));
    const { cands } = await resolveTop(html, { semantic: '邮箱' });
    ok('5.2 仍定位到 input#em', cands[0] && cands[0].elementId === 'em', cands[0] && cands[0].elementId);
  }

  // ───────────────────────────────────────────────────────
  section('Case 6  containerText：最近 form/fieldset 的可访问名');
  {
    const html = '<form aria-label="登录"><input id="u" name="uid"></form>'
      + '<form aria-label="注册"><input id="r" name="regid"></form>';
    const { byId } = await inspect(html);
    ok('6.1 登录表单内控件拿到 containerText=登录', byId.u && byId.u.containerText === '登录',
      byId.u && JSON.stringify(byId.u.containerText));
    ok('6.2 注册表单内控件拿到 containerText=注册', byId.r && byId.r.containerText === '注册',
      byId.r && JSON.stringify(byId.r.containerText));
    ok('6.3 两个表单未互相污染', byId.u && byId.u.containerText !== byId.r.containerText);
  }

  // ───────────────────────────────────────────────────────
  section('Case 7  噪声抑制：不是标签的东西不得被当成标签');
  {
    // (a) 前一个兄弟是控件 → 它的文字属于它自己，不能给后面的字段当标签
    const a = await inspect('<div><button id="btn">提交</button><input id="x" name="x"></div>');
    ok('7.1 前一个兄弟是 button 时不采集 siblingText',
      a.byId.x && a.byId.x.siblingText === '', a.byId.x && JSON.stringify(a.byId.x.siblingText));
    // (b) 前一个兄弟是长文本块 → 是内容，不是字段标签
    const long = '这是一段很长的页面说明文字用于验证长度阈值不会被误当成字段标签'.repeat(2);
    const b = await inspect('<div><div id="d">' + long + '</div><input id="y" name="y"></div>');
    ok('7.2 前一个兄弟是长文本块时不采集', b.byId.y && b.byId.y.siblingText === '',
      b.byId.y && JSON.stringify(b.byId.y.siblingText));
    // (c) 前一个兄弟内部含别的控件 → 说明它不是本字段的标签
    const c = await inspect('<div><div id="w"><span>备注</span><input id="inner"></div><input id="z" name="z"></div>');
    ok('7.3 前一个兄弟内含控件时不采集', c.byId.z && c.byId.z.siblingText === '',
      c.byId.z && JSON.stringify(c.byId.z.siblingText));
  }

  // ───────────────────────────────────────────────────────
  section('Case 8  [安全] 页内脱敏必须真实生效（端到端，不比对源码文本）');
  {
    // 为什么必须端到端：COLLECT_JS 是模板字符串，源码里写 \s 会被转义处理成字母 s，
    // 正则语法依然合法、源码比对型「一致性测试」依然通过，但脱敏语义全变。
    // 2026-08-29 取证：五条规则里四条因此完全失效（卡号/CVV/Bearer 明文进 LLM）。
    // 下面每一条都断言「敏感值不出现在整个观察结果里」，而不是断言规则长什么样。
    const probes = [
      ['8.1 k=v 明文密码', '<div>password=PlainText123</div><input id="p" name="p">', 'PlainText123'],
      ['8.2 JSON 引号形态密码', '<div>{"password":"JsonSecret9"}</div><input id="p2" name="p2">', 'JsonSecret9'],
      ['8.3 Bearer token', '<div>Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abc</div><input id="p3" name="p3">', 'eyJhbGciOiJIUzI1NiJ9abc'],
      ['8.4 16 位卡号', '<div>card 4111 1111 1111 1111</div><input id="p4" name="p4">', '4111 1111 1111 1111'],
      ['8.5 15 位卡号（Amex）', '<div>card 3782 822463 10005</div><input id="p5" name="p5">', '3782 822463 10005'],
      ['8.6 CVV', '<div>cvc 123</div><input id="p6" name="p6">', 'cvc 123'],
      ['8.7 token=', '<div>token=Tk9De4rF1gH</div><input id="p7" name="p7">', 'Tk9De4rF1gH'],
    ];
    let i = 0;
    for (const [name, html, secret] of probes) {
      i += 1;
      const { obs } = await inspect(html);
      // 断言整个 observation（含 textSummary / visibleText / 所有元素字段）
      const raw = JSON.stringify(obs);
      ok(name + ' 明文未进入观察结果', !raw.includes(secret),
        '泄漏片段：' + raw.slice(Math.max(0, raw.indexOf(secret) - 60), raw.indexOf(secret) + 60));
      void i;
    }
    // 邻近文本这一路（新增外泄面）单独再确认一次
    const { byId } = await inspect('<div>password=PlainText123</div><input id="p" name="p">');
    ok('8.8 邻近文本已被 REDACTED', /REDACTED/.test(String((byId.p && byId.p.siblingText) || '')),
      byId.p && byId.p.siblingText);
    ok('8.9 邻近文本不含明文', !String((byId.p && byId.p.siblingText) || '').includes('PlainText123'),
      byId.p && byId.p.siblingText);
  }

  // ───────────────────────────────────────────────────────
  section('Case 11 [安全] 模板字符串转义陷阱护栏');
  {
    // 失效机理：COLLECT_JS 是模板字面量，源码里写单个 \s 会被转义处理成字母 s。
    // 等到「有效字符串」这一层再看，反斜杠已经消失，只剩一个语义不同的正则 ——
    // 所以护栏必须做在**源码层**（找未配对的单反斜杠），而不是结果层。
    const raw = fs.readFileSync(path.join(__dirname, '..', 'agent', 'observation.js'), 'utf8');
    const TICK = String.fromCharCode(96);
    const start = raw.indexOf('const COLLECT_JS = ' + TICK);
    // 模板以 `})()` + 反引号 结束（页内 IIFE）
    const tailAt = raw.indexOf('})()', start);
    const end = tailAt < 0 ? -1 : raw.indexOf(TICK, tailAt);
    ok('11.1 能定位 COLLECT_JS 模板字面量', start > 0 && end > start && raw[end + 1] === ';',
      'start=' + start + ' end=' + end + ' next=' + JSON.stringify(raw[end + 1]));
    const body = raw.slice(start, end);

    // 11.2 源码层：任何「奇数长度反斜杠串 + 转义字母」都是陷阱
    const bad = [];
    const runRe = /(\\+)([sbdrtnwSDW])/g;
    let m;
    while ((m = runRe.exec(body))) {
      if (m[1].length % 2 === 1) bad.push(JSON.stringify(body.slice(Math.max(0, m.index - 24), m.index + 24)));
    }
    ok('11.2 COLLECT_JS 源码内无未配对的单反斜杠转义', bad.length === 0, bad.slice(0, 3).join(' | '));

    // 11.3 结果层：页内 _cap 必须是「折叠空白」而不是「折叠字母 s」
    const eff = observation.COLLECT_JS;
    ok('11.3 页内 _cap 折叠的是空白（\\s+ 未被吃掉）',
      eff.includes(".replace(/\\s+/g, ' ')"),
      '实际：' + (eff.match(/\.replace\(\/[^)]*\)/g) || []).slice(0, 3).join(' '));

    // 11.4 行为层：抽取页内 redact 真跑一遍（源码比对型断言抓不到转义陷阱）
    let verdict = '未执行';
    try {
      const mm = eff.match(/const redact = \(s\) => String\(s \|\| ''\)([\s\S]*?);\s*\n\s*\n/);
      if (!mm) throw new Error('未能抽取 redact 定义');
      // eslint-disable-next-line no-new-func
      const make = new Function('return (function redact (s) { return String(s || \'\')'
        + mm[1] + '; })');
      const r = make();
      const checks = [
        ['k=v', r('password=abc123'), 'REDACTED'],
        ['Bearer', r('Authorization: Bearer eyJabc.def'), 'Bearer REDACTED'],
        ['16 位卡号', r('card 4111 1111 1111 1111'), 'CARD_REDACTED'],
        ['Amex', r('card 3782 822463 10005'), 'CARD_REDACTED'],
        ['CVV 数字在前', r('123 cvv'), 'CVV_REDACTED'],
        ['CVV 词在前', r('cvc 123'), 'REDACTED'],
      ];
      const missed = checks.filter(([, got, want]) => !String(got).includes(want));
      verdict = missed.length
        ? '失效：' + missed.map(([n, got]) => n + '→' + JSON.stringify(got)).join(', ')
        : '';
      ok('11.4 页内 redact 六条规则实测全部生效', missed.length === 0, verdict);
    } catch (e) {
      ok('11.4 页内 redact 六条规则实测全部生效', false, String(e && e.message).slice(0, 160));
    }
  }

  // ───────────────────────────────────────────────────────
  section('Case 9  [不误伤] 无控件竞争时描述性元素保持原分');
  {
    // 封顶只在「存在评分更高的可操作控件」时生效；页面上只有纯展示 label 时，
    // 它就是唯一合理答案，降权会让它被无关元素挤掉。
    const r = await resolveTop('<div><label>记住我</label><span>其它</span></div>', { semantic: '记住我' });
    ok('9.1 独立 label 仍是第一名', r.cands[0] && r.cands[0].el && r.cands[0].el.tag === 'label',
      r.cands[0] && ((r.cands[0].el && r.cands[0].el.tag) + ' score=' + r.cands[0].score));
    ok('9.2 独立 label 未被封顶（score 仍为 0.92）', r.cands[0] && r.cands[0].score === 0.92,
      String(r.cands[0] && r.cands[0].score));

    // element_present="form" 走的是 verification 对 elements 的直接扫描（不经过 resolve），
    // 这里锁住「form 仍在候选池且未被封顶挤出」。
    const f = await resolveTop('<form id="regForm"><label for="u">用户名</label><input id="u" name="username"></form>', 'form');
    ok('9.3 element_present="form" 仍能找到 form#regForm',
      f.cands.length > 0 && f.cands[0].elementId === 'regForm',
      JSON.stringify(f.cands.map((x) => [(x.el && x.el.tag) || '?', x.elementId, x.score])));
  }

  // ───────────────────────────────────────────────────────
  section('Case 10 [红线] 修复必须是通用 DOM 结构规则');
  {
    const files = [
      ['observation.js', path.join(__dirname, '..', 'agent', 'observation.js')],
      ['semanticResolver.js', path.join(__dirname, '..', 'agent', 'semanticResolver.js')],
    ];
    const banned = [
      ['saas', /saas/i], ['cloudsaas', /cloudsaas/i],
      ['mock 品牌 戴尔', /戴尔/], ['mock 品牌 飞利浦', /飞利浦/], ['mock 品牌 华硕', /华硕/],
      ['siteType 判定', /siteType/], ['expectedSite 判定', /expectedSite/],
      ['按 id 硬编码', /if\s*\(\s*el\.id\s*===?\s*['"](uname|username|email|regForm)/],
      ['按 taskId/fixture 分支', /taskId\s*===?\s*['"]rw\./],
    ];
    for (const [fname, fp] of files) {
      const src = fs.readFileSync(fp, 'utf8');
      let i = 0;
      for (const [name, re] of banned) {
        i += 1;
        ok(`10.${fname}.${i} 不含 ${name}`, !re.test(src), '命中：' + (src.match(re) || [])[0]);
      }
    }
    const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'semanticResolver.js'), 'utf8');
    ok('10.90 封顶线是显式常量（可被审计，不是魔法数字散落）',
      /DESCRIPTIVE_CEILING\s*=\s*0\.75/.test(src));
    ok('10.91 封顶只在存在更高分控件时触发（保留无控件出口）',
      /if\s*\(\s*controlBest\s*>\s*DESCRIPTIVE_CEILING\s*\)/.test(src));
  }

  await browser.close();
  console.log('\n────────────────────────────');
  console.log(`PASS=${pass}  FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常：', e); process.exit(2); });
