'use strict';

// 浏览器能力测试：验证 Feature-Complete 新增的 browser-action 类型已在 tools.js 的 runTool switch 中实现，
// 并在无真实浏览器的情况下通过 mock page / mock browserManager 验证各 case 返回统一的 RESULT 结构。
// 真实 Chromium 不可用时（如 playwright 未安装）自动 skip，不导致套件失败。
//
// 运行：node server/scripts/test_browser_caps.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ FAIL: ' + msg); }
}
function section(name) { console.log('\n=== ' + name + ' ==='); }

// ---- mock 基础设施 ----
function makeMockLocator() {
  const loc = {
    boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
    click: async () => {}, fill: async () => {}, check: async () => {}, uncheck: async () => {},
    setInputFiles: async () => {}, selectOption: async () => {},
    locator: () => loc, frameLocator: () => loc,
  };
  loc.first = () => loc;
  return loc;
}
function makeMockPage() {
  const base = {
    isClosed: () => false,
    url: () => 'http://mock.local/',
    title: async () => 'mock',
    evaluate: async () => ({
      elements: [], url: 'http://mock.local/', title: 'mock', textSummary: '',
      visibleText: '', roleText: '', errors: [], loadingState: 'complete', domFingerprint: '00000000',
      elementState: { total: 0, withValue: 0 }, previousObservationDiff: { urlChanged: false, textChanged: false, domChanged: false },
    }),
    waitForTimeout: async () => {},
    waitForEvent: async (type) => {
      if (type === 'download') return { suggestedFilename: () => 'f.txt', saveAs: async () => {} };
      return { accept: async () => {}, dismiss: async () => {} };
    },
    locator: () => makeMockLocator(),
    frameLocator: () => makeMockLocator(),
    mouse: { move: async () => {}, down: async () => {}, up: async () => {}, wheel: async () => {} },
    keyboard: { type: async () => {}, press: async () => {} },
    goto: async () => {},
    screenshot: async () => ({}),
  };
  return new Proxy(base, { get(t, p) { return (p in t) ? t[p] : (async () => undefined); } });
}

async function main() {
  // ---- 加载被测模块（playwright 不可用时优雅跳过）----
  let browserManager, tools;
  try {
    browserManager = require('../browserManager');
    tools = require('../agent/tools');
  } catch (e) {
    console.log('[skip] 无法加载 browserManager/tools（可能缺少 playwright 依赖）：' + (e && e.message));
    console.log('PASS=' + pass + '  FAIL=' + fail);
    process.exit(0);
  }

  // ---- (a) 源码 grep：确认 7 个新 case 存在于 runTool switch ----
  section('(a) runTool switch 包含新增 action case');
  const TOOLS_SRC = fs.readFileSync(path.join(__dirname, '..', 'agent', 'tools.js'), 'utf8');
  const NEW_CASES = ['uncheck', 'upload', 'download', 'dialog', 'openTab', 'closeTab', 'switchTab'];
  for (const c of NEW_CASES) {
    const present = new RegExp("case\\s+'" + c + "'\\s*:").test(TOOLS_SRC);
    ok(present, `case '${c}' 已存在于 runTool switch`);
  }
  ok(typeof browserManager.acceptDialog === 'function', 'browserManager.acceptDialog 已导出');
  ok(typeof browserManager.dismissDialog === 'function', 'browserManager.dismissDialog 已导出');
  ok(typeof browserManager.openPage === 'function', 'browserManager.openPage 已导出');
  ok(typeof browserManager.closePage === 'function', 'browserManager.closePage 已导出');
  ok(typeof browserManager.switchToPage === 'function', 'browserManager.switchToPage 已导出');
  ok(typeof browserManager.getPages === 'function', 'browserManager.getPages 已导出');

  // 用 mock 替换 browserManager 中的浏览器相关函数（tools 持有同一模块引用，变更生效）
  browserManager.humanClick = async () => {};
  browserManager.humanType = async () => {};
  browserManager.humanScroll = async () => {};
  browserManager.openPage = async () => makeMockPage();
  browserManager.closePage = async () => true;
  browserManager.switchToPage = async () => makeMockPage();
  browserManager.getPages = async () => [makeMockPage()];
  browserManager.getPage = async () => makeMockPage();
  browserManager.acceptDialog = async () => ({ ok: true, type: 'confirm', message: 'mock dialog' });
  browserManager.dismissDialog = async () => ({ ok: true, type: 'beforeunload', message: 'mock dialog' });

  const resolved = { page: makeMockPage(), session: { profileId: 'p1' }, task: { profileId: 'p1' } };
  const meta = { taskId: 't1' };

  function assertShape(res, label) {
    const okObj = res && typeof res === 'object';
    const hasSuccess = okObj && typeof res.success === 'boolean';
    const hasError = okObj && (res.error === null || (typeof res.error === 'object' && 'code' in res.error));
    const hasResult = okObj && 'result' in res;
    const hasObs = okObj && 'observation' in res;
    ok(okObj && hasSuccess && hasError && hasResult && hasObs,
      label + ' 返回统一 RESULT（success=' + (res && res.success) + (res && res.error ? ', code=' + res.error.code : '') + '）');
  }

  // ---- (b) 各新 case 返回 sane RESULT 形状 ----
  section('(b) 各新 action 通过 runTool 返回统一 RESULT 形状');
  const CASES = [
    { type: 'uncheck', target: { semantic: 'x' } },                 // 无匹配元素 → ELEMENT_NOT_FOUND
    { type: 'upload', target: { field: 'file', url: '/tmp/x.png' } }, // 无匹配元素 → ELEMENT_NOT_FOUND
    { type: 'download', target: { selector: '#dl' } },              // 命中 selector → 走 download 流程
    { type: 'dialog', target: { intent: 'accept' } },              // 消费待处理 dialog
    { type: 'openTab', target: { url: 'http://example.com' } },     // 新建并切换标签
    { type: 'closeTab', target: {} },                               // 关闭当前标签
    { type: 'switchTab', target: { url: 'http://example.com' } },   // 切换到目标标签
  ];
  for (const action of CASES) {
    let res = null;
    try {
      res = await tools.runTool(action, resolved, meta);
    } catch (e) {
      ok(false, `case '${action.type}' 抛出未捕获异常: ` + (e && e.message));
      continue;
    }
    assertShape(res, `case '${action.type}'`);
  }

  // 额外：uncheck 命中元素时返回 ok（用显式 selector 避免依赖 semanticResolver）
  {
    const action = { type: 'uncheck', target: { selector: '#chk' } };
    let res = null;
    try { res = await tools.runTool(action, resolved, meta); } catch (e) { res = { error: { code: 'THROW', message: String(e.message) } }; }
    ok(res && res.success === true, `uncheck 显式 selector 命中 → success=true (code=${res && res.error && res.error.code})`);
  }

  console.log('\n---------------------------------------------------');
  console.log('PASS=' + pass + '  FAIL=' + fail);
  console.log('---------------------------------------------------');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('[test] 异常:', (e && e.stack) || e); process.exit(1); });
