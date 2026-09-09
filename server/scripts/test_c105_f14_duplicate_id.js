'use strict';

// C105 F14 守护测试（零浏览器，fake page）：
// 重复 id 的第一个实例是隐藏副本（w=0,h=0）时，humanClick 必须点中**真实可见**的那个，
// 而不是误报 "element not found"。
//
// 真实站点证据（.benchmark/c105_probe_continue_nav_1788975046101.json）：
//   联盟落地页 #continue-nav 共 4 个实例 —— 首个 w=0（隐藏副本），
//   可见的两个（"Commencez gratuitement" 245×51 / "Commencer" 142×51）排在后面。
//   旧实现 `page.locator(sel).first()` → boundingBox()===null → 误报 not found，
//   实证连续 18 次假性 ELEMENT_NOT_FOUND（task_mtudaiwupwsmo），恢复链反复 reload 后升级人工。

const path = require('path');
const browserManager = require(path.join(__dirname, '..', 'browserManager'));

let passed = 0, failed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  PASS', name); })
    .catch((e) => { failed++; console.error('  FAIL', name, '-', e && e.message); process.exitCode = 1; });
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// fake page：boxes 为各匹配实例的 boundingBox（null = 隐藏/不存在）
function fakePage(boxes) {
  const log = { moved: 0, down: 0, up: 0 };
  const page = {
    isClosed: () => false,
    __log: log,
    locator(sel) {
      const at = (i) => ({
        boundingBox: async () => (i < boxes.length ? boxes[i] : null),
      });
      return { first: () => at(0), nth: (i) => at(i), count: async () => boxes.length };
    },
    mouse: {
      move: async () => { log.moved++; },
      down: async () => { log.down++; },
      up: async () => { log.up++; },
    },
    evaluate: async () => ({ x: 0, y: 0 }),
  };
  return page;
}

async function main() {
  console.log('C105 F14 duplicate-id visibility guard (fake page, no browser)');

  await ok('F14.1 首个实例隐藏（null）时，点中后续可见实例（不误报 not found）', async () => {
    const page = fakePage([null, { x: 1192, y: 494, width: 142, height: 51 }]);
    await browserManager.humanClick(page, '#continue-nav', {});
    assert(page.__log.down === 1 && page.__log.up === 1, '应发生一次完整点击，实际 ' + JSON.stringify(page.__log));
  });

  await ok('F14.2 首个实例零面积（w=0,h=0）时同样跳过，选中真实可见实例', async () => {
    const page = fakePage([{ x: 0, y: 0, width: 0, height: 0 }, { x: 2387, y: 54, width: 245, height: 51 }]);
    await browserManager.humanClick(page, '#continue-nav', {});
    assert(page.__log.down === 1, '应点击可见实例，实际 ' + JSON.stringify(page.__log));
  });

  await ok('F14.3 首个实例可见时行为不变（仍取第一个，零回归）', async () => {
    const page = fakePage([{ x: 10, y: 10, width: 100, height: 40 }, { x: 20, y: 20, width: 100, height: 40 }]);
    await browserManager.humanClick(page, '#visible-first', {});
    assert(page.__log.down === 1, '实际 ' + JSON.stringify(page.__log));
  });

  await ok('F14.4 全部实例隐藏/不存在时仍抛 not found（语义不变）', async () => {
    const page = fakePage([null, null, { x: 5, y: 5, width: 0, height: 0 }]);
    let threw = null;
    try { await browserManager.humanClick(page, '#all-hidden', {}); } catch (e) { threw = e; }
    assert(threw && /element not found/.test(String(threw.message)), '应抛 not found，实际 ' + (threw && threw.message));
    assert(page.__log.down === 0, '不应发生点击');
  });

  console.log(`\nF14 guard: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
