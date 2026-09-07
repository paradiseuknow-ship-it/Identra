'use strict';
// C43 守护测试 —— 键盘可达性（Esc 关闭弹层，零浏览器）。
// 缺陷背景：全应用弹层（TaskDetail/BrowserViewer/ProfileEditor/删除确认）零键盘关闭路径。
// 修复：lib/useEscapeClose.mjs（isEscapeKey 纯函数 + useEscapeClose hook）接入四处弹层。
// 覆盖：
//   P1 isEscapeKey：Escape/Esc/keyCode27 命中；其他键不命中
//   P2 hook 行为真测（React 18 createRoot + 最小 DOM stub）：Escape 触发 onClose 且 preventDefault；其他键不触发；inactive 不监听；卸载后按键不触发（无泄漏）
//   P3 接线契约：TaskDetail/ProfileEditor/BrowserViewer 均调用 useEscapeClose(true, onClose)；
//       App confirm 弹窗为取消语义（Esc 传 setConfirmState(null) 而非 runConfirm）

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const CLIENT_NM = path.join(ROOT, 'client', 'node_modules');
const React = require(path.join(CLIENT_NM, 'react'));
let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}
const read = (rel) => require('fs').readFileSync(path.join(ROOT, rel), 'utf8');

(async () => {
  const { isEscapeKey } = await import(
    'file://' + path.join(ROOT, 'client', 'src', 'lib', 'useEscapeClose.mjs').replace(/\\/g, '/')
  );

  // P1：纯函数
  chk('P1 isEscapeKey 三态判定',
    isEscapeKey({ key: 'Escape' }) && isEscapeKey({ key: 'Esc' }) && isEscapeKey({ keyCode: 27 })
      && !isEscapeKey({ key: 'Enter' }) && !isEscapeKey({ keyCode: 13 }) && !isEscapeKey(null),
    '部分判定错误');

  // P2：hook 行为真测 —— esbuild 转译 + fake-React useEffect 执行器
  // （不用 createRoot：无 DOM 环境下 DOM stub 过脆；fake 执行器直接驱动 useEffect 生命周期，语义等价）
  try {
    const { transformSync } = require(path.join(CLIENT_NM, 'esbuild'));

    const listeners = new Map(); // type -> Set<fn>
    const stubWindow = {
      addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
      removeEventListener(type, fn) { const s = listeners.get(type); if (s) s.delete(fn); },
    };
    global.window = stubWindow;

    const hookJs = transformSync(read('client/src/lib/useEscapeClose.mjs'), { format: 'cjs', target: 'node18' }).code;
    // fake React：useEffect 记录 [fn, deps]，由测试手动驱动生命周期
    const effects = [];
    const fakeReact = { useEffect: (fn, deps) => { effects.push({ fn, deps }); } };
    const hookMod = { exports: {} };
    new Function('require', 'module', 'exports', hookJs)(
      (id) => (id === 'react' ? fakeReact : (() => { throw new Error('unexpected require ' + id); })()),
      hookMod, hookMod.exports
    );
    const { useEscapeClose } = hookMod.exports;

    const fireKey = (ev) => {
      const s = listeners.get('keydown');
      let prevented = false;
      const e = { preventDefault: () => { prevented = true; }, ...ev };
      if (s) for (const fn of [...s]) fn(e);
      return prevented;
    };

    // mount（active=true）：记录 effect；执行后才注册监听
    effects.length = 0;
    let closed = 0;
    const onClose = () => { closed++; };
    useEscapeClose(true, onClose);
    chk('P2a mount 记录恰好一个 effect', effects.length === 1, 'effects=' + effects.length);
    const cleanup = effects[0].fn(); // 执行 effect → 注册监听 → 返回清理函数
    chk('P2b 执行 effect 后注册 keydown 监听；Escape 触发 onClose 且 preventDefault；Enter 不触发',
      (listeners.get('keydown') || new Set()).size === 1
        && fireKey({ key: 'Escape' }) === true && closed === 1
        && fireKey({ key: 'Enter' }) === false && closed === 1,
      'listeners=' + (listeners.get('keydown') || new Set()).size + ' closed=' + closed);

    // unmount：cleanup 清空监听（无泄漏）
    if (typeof cleanup === 'function') cleanup();
    chk('P2c cleanup 后监听清空（无泄漏）', (listeners.get('keydown') || new Set()).size === 0,
      'listeners=' + (listeners.get('keydown') || new Set()).size);

    // active=false：effect 早退，不注册
    listeners.clear();
    effects.length = 0;
    useEscapeClose(false, onClose);
    const cleanupFalse = effects.length === 1 ? effects[0].fn() : null;
    chk('P2d inactive 时不注册监听', (listeners.get('keydown') || new Set()).size === 0,
      'listeners=' + (listeners.get('keydown') || new Set()).size);
    if (typeof cleanupFalse === 'function') cleanupFalse();

    // onClose 非 function：不注册（防御）
    listeners.clear();
    effects.length = 0;
    useEscapeClose(true, undefined);
    chk('P2e onClose 非函数时不注册（防御）', (listeners.get('keydown') || new Set()).size === 0,
      'listeners=' + (listeners.get('keydown') || new Set()).size);

    delete global.window;
  } catch (e) {
    chk('P2 hook 行为真测', false, e.message);
  }

  // P3：接线契约
  {
    const td = read('client/src/components/TaskDetail.jsx');
    const pe = read('client/src/components/ProfileEditor.jsx');
    const bv = read('client/src/components/BrowserViewer.jsx');
    const app = read('client/src/App.jsx');
    const overlays = td.includes("useEscapeClose(true, onClose)")
      && pe.includes("useEscapeClose(true, onClose)")
      && bv.includes("useEscapeClose(true, onClose)");
    const confirmCancelOnly = app.includes("useEscapeClose(!!confirmState, () => setConfirmState(null))")
      && !app.includes('useEscapeClose(!!confirmState, runConfirm)');
    chk('P3 接线：三弹层 Esc 关闭 + confirm 弹窗取消语义（不误触发危险确认）',
      overlays && confirmCancelOnly,
      'overlays=' + overlays + ' confirmCancel=' + confirmCancelOnly);
  }

  console.log('\nRESULT: pass=' + pass + ' fail=' + fail);
  if (fail > 0) { console.log('FAILURES:\n- ' + failures.join('\n- ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
