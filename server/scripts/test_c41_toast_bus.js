'use strict';
// C41 守护测试 —— Toast 通知总线（零浏览器零服务器）。
// 缺陷背景：旧 notify 为单条 toast + 全局裸 setTimeout：
//   先发通知的 timer 会把后发通知提前清掉（截断竞态）；卸载后 timer 仍 setState。
// 修复：toastBus.mjs（pub/sub + 去重窗口）+ ToastHost（每条独立 timer + FIFO 上限 + 卸载清理）。
// 覆盖：
//   P1 emit 广播且 id 唯一递增；返回 item
//   P2 退订后不再收到广播
//   P3 去重窗口：同一消息窗口内重复 emit 被合并（emit 返回 null）
//   P4 去重窗口过期后同一消息放行
//   P5 不同消息即使在窗口内也不合并
//   P6 applyIncoming FIFO 上限：超出 maxVisible 丢最老
//   P7 ToastHost 转译冒烟：独立 timer Map + 卸载 cleanup 存在；SSR 空态渲染为 null
//   P8 App.jsx 接线契约：notify 走 toastBus、无残留单条 toast 渲染、<ToastHost /> 已挂载

const fs = require('fs');
const path = require('path');
const CLIENT_NM = path.join(__dirname, '..', '..', 'client', 'node_modules');
const React = require(path.join(CLIENT_NM, 'react'));
const { renderToStaticMarkup } = require(path.join(CLIENT_NM, 'react-dom', 'server'));

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

(async () => {
  const { createToastBus, applyIncoming } = await import(
    'file://' + path.join(ROOT, 'client', 'src', 'lib', 'toastBus.mjs').replace(/\\/g, '/')
  );

  // P1：广播 + id 唯一递增
  {
    const bus = createToastBus({ dedupeWindowMs: 0 });
    const seen = [];
    bus.subscribe((item) => seen.push(item));
    const a = bus.emit('A', true);
    const b = bus.emit('B', false);
    chk('P1 emit 广播且 id 唯一递增（返回 item）',
      seen.length === 2 && a && b && a.id !== b.id && a.ok === true && b.ok === false,
      'seen=' + JSON.stringify(seen));
  }

  // P2：退订
  {
    const bus = createToastBus({ dedupeWindowMs: 0 });
    let n = 0;
    const unsub = bus.subscribe(() => { n++; });
    unsub();
    bus.emit('X', true);
    chk('P2 退订后不再收到广播', n === 0, 'n=' + n);
  }

  // P3+P4+P5：去重窗口（注入可控 nowFn）
  {
    let now = 1000;
    const bus = createToastBus({ dedupeWindowMs: 800, nowFn: () => now });
    const seen = [];
    bus.subscribe((item) => seen.push(item));
    const dup1 = bus.emit('同一条', true);
    const dup2 = bus.emit('同一条', true);
    now = 1500;
    const dup3 = bus.emit('同一条', true); // 窗口内（500 < 800）仍合并
    now = 2000;
    const dup4 = bus.emit('同一条', true); // 窗口过期（1000ms）放行
    const other = bus.emit('另一条', false); // 不同消息不合并
    chk('P3 去重窗口内重复 emit 被合并（返回 null）',
      dup1 && dup2 === null && dup3 === null, 'dup1=' + !!dup1 + ' dup2=' + dup2 + ' dup3=' + dup3);
    chk('P4 窗口过期后同一消息放行', dup4 && seen.filter((x) => x.msg === '同一条').length === 2,
      'count=' + seen.filter((x) => x.msg === '同一条').length);
    chk('P5 不同消息窗口内不合并', other && other.ok === false,
      'other=' + JSON.stringify(other));
  }

  // P6：applyIncoming FIFO 上限
  {
    const max = 3;
    let items = [];
    for (let i = 1; i <= 5; i++) items = applyIncoming(items, { id: i, msg: 'm' + i, ok: true }, max);
    chk('P6 applyIncoming FIFO 上限：超出丢最老',
      items.length === max && items[0].id === 3 && items[2].id === 5,
      'items=' + JSON.stringify(items.map((x) => x.id)));
  }

  // P7：ToastHost 转译冒烟（esbuild + clientRequire 重定向，C40 模式）
  try {
    const { transformSync } = require(path.join(CLIENT_NM, 'esbuild'));
    const src = read('client/src/components/ToastHost.jsx');
    const js = transformSync(src, { loader: 'jsx', format: 'cjs', target: 'node18' }).code;
    chk('P7a ToastHost 具备每条独立 timer Map 与卸载 cleanup（clearTimeout 循环）',
      js.includes('timersRef.current.set') && js.includes('for (const t of timersRef.current.values()) clearTimeout(t)'),
      '转译产物缺少独立 timer/cleanup');

    const clientRequire = (id) => require(id.startsWith('.') || path.isAbsolute(id)
      ? path.resolve(path.join(ROOT, 'client', 'src', 'components'), id)
      : path.join(CLIENT_NM, id));
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', 'React', js)(clientRequire, mod, mod.exports, React);
    const ToastHost = mod.exports.default;
    // 静态实例（本地 bus，不订阅全局单例）：SSR 下 useEffect 不执行 → 空态渲染为 null
    const localBus = createToastBus({ dedupeWindowMs: 0 });
    const html = renderToStaticMarkup(React.createElement(ToastHost, { bus: localBus }));
    chk('P7b ToastHost 空态 SSR 渲染为 null（不产生 DOM 残留）', html === '', 'html=' + JSON.stringify(html));
  } catch (e) {
    chk('P7 ToastHost 转译冒烟', false, e.message);
  }

  // P8：App.jsx 接线契约
  {
    const app = read('client/src/App.jsx');
    const notifyGoesToBus = /const notify = \(msg, ok = true\) => toastBus\.emit\(msg, ok\);/.test(app);
    const noSingleToast = !app.includes('setToast(') && !app.includes('{toast && (');
    const hostMounted = app.includes('<ToastHost />');
    chk('P8 App.jsx 接线：notify→bus / 无残留单条渲染 / ToastHost 已挂载',
      notifyGoesToBus && noSingleToast && hostMounted,
      'bus=' + notifyGoesToBus + ' clean=' + noSingleToast + ' host=' + hostMounted);
  }

  console.log('\nRESULT: pass=' + pass + ' fail=' + fail);
  if (fail > 0) { console.log('FAILURES:\n- ' + failures.join('\n- ')); process.exit(1); }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
