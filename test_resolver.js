'use strict';
// Step 2-A Resolver 验证：7 类目标场景，断言多信号评分能正确定位。
// 用法：node test_resolver.js
const { chromium } = require('playwright');
const observation = require('./server/agent/observation');
const resolver = require('./server/agent/semanticResolver');

// 每个用例：html + 多个待解析 target（模拟 DeepSeek 可能产出的 target 形状）+ 期望定位到的 elementId/selector
const CASES = [
  {
    name: '1. email input',
    html: '<form><label for="email">企业邮箱</label><input id="email" name="email" type="email" placeholder="企业邮箱"></form>',
    targets: [{ field: 'email' }, { semantic: '企业邮箱' }, { field: 'email', semantic: '企业邮箱' }],
    expectId: 'email',
  },
  {
    name: '2. password input',
    html: '<form><label for="pwd">密码</label><input id="pwd" name="password" type="password" placeholder="请输入密码"></form>',
    targets: [{ field: 'password' }, { semantic: '密码输入框' }, { field: 'password', semantic: '密码输入框' }],
    expectId: 'pwd',
  },
  {
    name: '3. search input',
    html: '<form><input id="q" name="q" type="search" placeholder="搜索商品"></form>',
    targets: [{ field: 'search' }, { semantic: '搜索输入框' }, { field: 'search', semantic: '搜索输入框' }],
    expectId: 'q',
  },
  {
    name: '4. 中文 label',
    html: '<form><label for="uname">用户名</label><input id="uname" name="username"></form>',
    targets: [{ field: 'username' }, { semantic: '用户名' }],
    expectId: 'uname',
  },
  {
    name: '5. 英文 placeholder',
    html: '<form><input name="q" placeholder="Search products"></form>',
    targets: [{ field: 'search' }, { semantic: 'Search products' }],
    expectSel: /name="q"/,
  },
  {
    name: '6. aria-label only button',
    html: '<div><button id="ariaBtn" aria-label="搜索"></button></div>',
    targets: [{ semantic: '搜索' }, { field: 'search', semantic: '搜索' }],
    expectId: 'ariaBtn',
  },
  {
    // C105 F1 契约修订（D-A 误点机器根因）：纯 icon button 无任何身份信号（text/aria/id/cls
    // 全空）时，动作语义兜底不得再命中（零证据拒点）。旧 catch-all 对页面所有 button 同分 0.4、
    // DOM 顺序决胜 → 语义「continue/submit」误点第一个无关按钮（法语站 Plateforme 实锤）。
    // 有身份信号的 icon button（aria-label）仍由 case 6 覆盖：命中路径不变。
    name: '7. 纯 icon button（无文本/aria）→ 零证据拒点',
    html: '<div><button id="iconBtn"><svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg></button></div>',
    targets: [{ semantic: '提交' }, { semantic: 'submit' }],
    expectNoCandidate: true,
  },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  let pass = 0, total = 0;
  const rows = [];
  for (const c of CASES) {
    const page = await browser.newPage();
    await page.setContent(c.html);
    const insp = await observation.inspect(page, { taskId: 'test' });
    const obs = insp.observation;
    for (const tgt of c.targets) {
      total++;
      const cands = resolver.resolve(tgt, obs);
      const top = cands[0];
      const gotId = top ? (top.elementId || top.selector) : '(none)';
      let ok = false;
      if (c.expectNoCandidate) ok = !top;
      else if (c.expectId) ok = !!top && top.elementId === c.expectId;
      else if (c.expectSel) ok = !!top && c.expectSel.test(top.selector);
      if (ok) pass++;
      rows.push({
        case: c.name, target: JSON.stringify(tgt), got: gotId,
        score: top ? top.score : 0, reason: top ? top.reason : 'NO CANDIDATE', ok,
      });
    }
    await page.close();
  }
  await browser.close();

  console.log('Step 2-A Resolver 验证结果');
  console.log('========================================');
  for (const r of rows) {
    console.log(
      (r.ok ? '✅' : '❌') + ' ' +
      r.case.padEnd(22) + ' target=' + r.target.padEnd(34) +
      ' => ' + String(r.got).padEnd(22) + ' score=' + r.score +
      '  (' + r.reason + ')'
    );
  }
  console.log('========================================');
  console.log(`PASS rate: ${pass}/${total} = ${(pass / total * 100).toFixed(1)}%`);
  console.log(`Phase 6 baseline: ELEMENT_NOT_FOUND = 80.1% (真实运行统计)`);
  process.exit(pass === total ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(2); });
