'use strict';
// Step 1 验证：用真实浏览器加载 fixture，校验 observation 增强 + semantic resolver + verification。
const { chromium } = require('playwright');
const observation = require('./server/agent/observation');
const semanticResolver = require('./server/agent/semanticResolver');
const verification = require('./server/agent/verification');

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // ── 测试页：div 渲染的动态结果 + 标准交互元素 ──
  await page.setContent(`<html><body>
    <h1>商城</h1>
    <div id="result">搜索结果：<span class="name">键盘</span> 已加入购物车</div>
    <button id="searchBtn">搜索</button>
    <input id="q" placeholder="搜索商品" type="search">
    <a id="next" href="#">下一页</a>
    <input id="agree" type="checkbox"> 我同意条款
  </body></html>`);

  const insp = await observation.inspect(page, { taskId: 't1' });
  const obs = insp.observation;

  console.log('\n=== 1) visibleText / textSummary 包含 div 文本？ ===');
  console.log('textSummary 含「键盘」:', obs.textSummary.includes('键盘'));
  console.log('visibleText 含「键盘」:', obs.visibleText.includes('键盘'));
  console.log('visibleText 长度:', obs.visibleText.length);
  console.log('roleText 样例:', obs.roleText.slice(0, 120));

  console.log('\n=== 2) verification.text_present 现能识别 div 渲染内容？ ===');
  const v = verification.verify({ type: 'text_present', expect: '键盘' }, obs, null);
  console.log('verify(text_present=键盘):', v.success, '| conf', v.confidence, '|', v.evidence[0]);

  console.log('\n=== 3) semantic resolver 仍能定位元素（且新字段存在） ===');
  const cSearch = semanticResolver.resolve('搜索', obs);
  console.log('resolve(搜索) top:', JSON.stringify({ id: cSearch[0] && cSearch[0].elementId, score: cSearch[0] && cSearch[0].score, reason: cSearch[0] && cSearch[0].reason }));
  const cAgree = semanticResolver.resolve('同意', obs);
  console.log('resolve(同意) top:', JSON.stringify({ id: cAgree[0] && cAgree[0].elementId, score: cAgree[0] && cAgree[0].score }));

  const btn = obs.elements.find((e) => e.id === 'searchBtn');
  const chk = obs.elements.find((e) => e.id === 'agree');
  console.log('\n=== 4) 新增字段（innerText / roleText / state / boundingBox） ===');
  console.log('searchBtn:', JSON.stringify({ innerText: btn.innerText, roleText: btn.roleText, boundingBox: btn.boundingBox, state: btn.state }));
  console.log('agree(checkbox):', JSON.stringify({ innerText: chk.innerText, roleText: chk.roleText, state: chk.state }));

  // ── 断言 ──
  const ok =
    obs.textSummary.includes('键盘') &&
    obs.visibleText.includes('键盘') &&
    v.success === true &&
    cSearch.length > 0 && cSearch[0].elementId === 'searchBtn' &&
    !!btn.boundingBox && !!btn.state && !!btn.innerText && !!btn.roleText &&
    chk.state.type === 'checkbox' && chk.state.checked === false;
  console.log('\nRESULT:', ok ? 'PASS ✅' : 'FAIL ❌');
  await browser.close();
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
