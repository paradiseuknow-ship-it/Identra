'use strict';
// C45 守护测试 —— screencast 生命周期缺陷修复（零浏览器）。
// 缺陷背景（C42 引入）：
//   A 类：getHub.onNeedStart 的 attachScreencast 是异步的；若 attach 未完成时订阅者已清零，
//         onNeedStop 走 else 分支删除 hub entry → attach 完成后 .then 找不到 entry →
//         stop 被丢弃 → CDP session + screencast 永久泄漏（浏览器持续推帧+ack）。
//         每次快速开关云查看都可能泄漏一个 CDP session。
//   B 类：/browser/:id/stream SSE 心跳不检查浏览器存活 → 浏览器停止后僵流保活、
//         hub 永不释放、客户端冻结在"实时流已连接"；浏览器重启后流也永久失效。
// 覆盖：
//   P1 A 类泄漏回归：subscribe→立即 unsubscribe→attach 才 resolve → stop 必须被调用（旧代码 FAIL）
//   P2 正常生命周期：subscribe→attach resolve→unsubscribe → stop 恰好一次 + hub 表清理
//   P3 hub 表清理后复用：新订阅者拿到全新 hub 且再次 attach（不复用死 entry）
//   P4 双退订/双清理幂等：unsubscribe 两次只触发一次 onNeedStop（不重复 stop）
//   P5 服务端接线静态断言：心跳含 isRunning 存活检查 + cleanup 幂等守卫
//   P6 客户端接线静态断言：BrowserViewer 保留 SSE 断线降级低速（配合服务端主动断流）

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const read = (rel) => require('fs').readFileSync(path.join(ROOT, rel), 'utf8');

// 构造可控制 attach 时序的 fake browserManager（驱动真实 attachScreencast 代码路径）
function makeFakeBrowserManager() {
  const calls = { stopCalled: 0, detachCalled: 0, startScreencast: 0 };
  let resolveAttach = null;
  const fakeCdp = {
    on() {}, off() {},
    send: async (method) => { if (method === 'Page.startScreencast') calls.startScreencast++; return {}; },
    detach: async () => { calls.detachCalled++; },
  };
  // 真实 attachScreencast 路径：s.page || s.context.pages()[0] → page.context().newCDPSession(page)
  const fakePage = {
    context: () => ({
      newCDPSession: () => new Promise((res) => { resolveAttach = res; }),
    }),
  };
  const fakeSession = { context: { pages: () => [fakePage] } };
  const bm = {
    getSession: (id) => (id === 'p-leak' ? fakeSession : null),
    isRunning: () => true,
  };
  return {
    bm, calls,
    resolveAttachNow: () => {
      const r = resolveAttach; resolveAttach = null;
      if (r) r(fakeCdp);
    },
    stopCounter: calls,
  };
}

(async () => {
  const { getHub, hubFor, resetForTests } = require(path.join(ROOT, 'server', 'screencastManager.js'));

  // P1：A 类泄漏回归 —— attach 期间订阅者清零，attach 完成后必须立即释放
  {
    resetForTests();
    const f = makeFakeBrowserManager();
    const hub = getHub(f.bm, 'p-leak');
    const u = hub.subscribe(() => {});
    u(); // 立即离开：此时 attach promise 未 resolve，onNeedStop 走 else 分支删除 entry
    await sleep(10);
    f.resolveAttachNow(); // attach 此刻才完成
    await sleep(20);
    // 真实断言：stop 函数内部会调用 Page.stopScreencast（经由 fakeCdp.send）与 detach
    chk('P1 A 类：attach 期间订阅者清零 → attach 完成后 CDP session 已释放（stopScreencast + detach）',
      f.calls.startScreencast === 1 && f.calls.detachCalled === 1,
      'startScreencast=' + f.calls.startScreencast + ' detach=' + f.calls.detachCalled);
  }

  // P2：正常生命周期 —— attach 完成后订阅者离开 → stop 恰好一次 + hub 表清理
  {
    resetForTests();
    const f = makeFakeBrowserManager();
    const hub = getHub(f.bm, 'p-leak');
    const u = hub.subscribe(() => {});
    f.resolveAttachNow();
    await sleep(10);
    u();
    await sleep(20);
    chk('P2 正常生命周期：unsubscribe → stop 恰好一次 + hub 表已清理',
      f.calls.detachCalled === 1 && hubFor('p-leak') === null,
      'detach=' + f.calls.detachCalled + ' hubFor=' + String(hubFor('p-leak')));
  }

  // P3：hub 清理后复用 —— 新订阅者触发全新 attach（不复用已死 entry）
  {
    resetForTests();
    const f = makeFakeBrowserManager();
    let hub1 = getHub(f.bm, 'p-leak');
    const u1 = hub1.subscribe(() => {});
    u1(); // 清零（attach 未完成）→ entry 删除 + P1 路径释放
    f.resolveAttachNow();
    await sleep(10);
    const hub2 = getHub(f.bm, 'p-leak'); // 新 entry
    chk('P3 清理后新订阅者获得全新 hub（不复用死 entry）',
      hub2 !== hub1 && hub2.subscriberCount() === 0,
      'same=' + (hub2 === hub1) + ' count=' + hub2.subscriberCount());
    const u2 = hub2.subscribe(() => {});
    f.resolveAttachNow();
    await sleep(20);
    chk('P3b 新订阅触发第二次 startScreencast（重新 attach）',
      f.calls.startScreencast === 2, 'startScreencast=' + f.calls.startScreencast);
    u2();
    await sleep(20);
    chk('P3c 第二轮清理同样释放（detach=2）', f.calls.detachCalled === 2, 'detach=' + f.calls.detachCalled);
  }

  // P4：双退订幂等 —— unsubscribe 两次只触发一次 stop（不重复释放/不抛异常）
  {
    resetForTests();
    const f = makeFakeBrowserManager();
    const hub = getHub(f.bm, 'p-leak');
    const u = hub.subscribe(() => {});
    f.resolveAttachNow();
    await sleep(10);
    u();
    u(); // 第二次为 no-op，但不得再次触发 onNeedStop
    await sleep(20);
    chk('P4 双退订只 stop 一次（幂等）', f.calls.detachCalled === 1, 'detach=' + f.calls.detachCalled);
  }

  // P5：服务端接线静态断言（对真实 index.js 源码）
  {
    const idx = read('server/index.js');
    const hbAlive = /heartbeat = setInterval\(\(\) => \{[\s\S]*?isRunning\(p\.id\)\)[\s\S]*?cleanup\(\)/.test(idx);
    const idem = /let cleaned = false;[\s\S]*?if \(cleaned\) return;/.test(idx);
    chk('P5 服务端：SSE 心跳含浏览器存活检查 + cleanup 幂等守卫', hbAlive && idem,
      'hbAlive=' + hbAlive + ' idem=' + idem);
  }

  // P6：客户端接线静态断言（对真实 BrowserViewer.jsx 源码）
  {
    const viewer = read('client/src/components/BrowserViewer.jsx');
    const degrade = viewer.includes("es.onerror = () => {") && viewer.includes("setMode('slow')");
    const escClose = viewer.includes('useEscapeClose(true, onClose)');
    chk('P6 客户端：保留 SSE 断线降级低速 + Esc 关闭接线', degrade && escClose,
      'degrade=' + degrade + ' esc=' + escClose);
  }

  console.log('\nRESULT: pass=' + pass + ' fail=' + fail);
  if (fail > 0) { console.log('FAILURES:\n- ' + failures.join('\n- ')); process.exit(1); }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
