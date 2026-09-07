'use strict';
// C40 守护测试 —— 面板级 ErrorBoundary（零浏览器；静态契约 + react-dom/server 渲染冒烟）。
// 覆盖：
//   P1 ErrorBoundary.jsx 存在且实现 getDerivedStateFromError + componentDidCatch + retry
//   P2 App.jsx 面板内容区被 <ErrorBoundary key={tab}> 包裹（一处覆盖全部 tab）
//   P3 main.jsx 全局兜底 Boundary 存在
//   P4 node 渲染冒烟：正常 children 原样渲染；崩溃 children 渲染错误卡（含重试/刷新按钮）

const fs = require('fs');
const path = require('path');
// react/react-dom/esbuild 安装在 client/node_modules（server 侧无 react 依赖），显式绝对路径 require
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

// 让 renderToStaticMarkup 吞掉渲染错误（boundary 会接住，但 react-dom 仍会 console.error——静音）
const origErr = console.error;
console.error = () => {};

(async () => {
  const eb = read('client/src/components/ErrorBoundary.jsx');
  const app = read('client/src/App.jsx');
  const main = read('client/src/main.jsx');

  chk('P1 ErrorBoundary 实现三要素（getDerivedStateFromError/componentDidCatch/retry）',
    eb.includes('getDerivedStateFromError') && eb.includes('componentDidCatch') && eb.includes('retry'),
    '三要素缺失');

  chk('P2 App.jsx 面板内容区被 ErrorBoundary key={tab} 包裹',
    app.includes('<ErrorBoundary key={tab} name={tab}>') && app.includes('</ErrorBoundary>'),
    '包裹缺失');

  chk('P3 main.jsx 全局兜底 Boundary 存在',
    main.includes('<ErrorBoundary name="应用">'),
    '兜底缺失');

  // P4 渲染冒烟（jsx 需要编译——用 React.createElement 等价构造，直接 require 组件源码需 transform，
  // 因此这里以 createElement 重建同构最小验证：直接 eval 源文件不可行（ESM+JSX），
  // 改用 esbuild 快速转译 client 组件源码后渲染。
  try {
    const { transformSync } = require(path.join(CLIENT_NM, 'esbuild'));
    const src = read('client/src/components/ErrorBoundary.jsx');
    const js = transformSync(src, { loader: 'jsx', format: 'cjs', target: 'node18' }).code;
    // 转译后的 CJS 会 require('react')——从测试文件位置解析不到 client 的 react，做路径重定向
    const clientRequire = (id) => require(id.startsWith('.') || path.isAbsolute(id) ? id : path.join(CLIENT_NM, id));
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', 'React', js)(clientRequire, mod, mod.exports, React);
    const Boundary = mod.exports.default;

    // 注意：renderToStaticMarkup（SSR）不支持 error boundary（React 限制），因此
    // 直接单测类方法：getDerivedStateFromError + 设置 state 后的 render 输出。
    const errObj = new Error('boom-c40');
    const derived = Boundary.getDerivedStateFromError(errObj);
    chk('P4a getDerivedStateFromError → { error }', derived && derived.error === errObj, JSON.stringify(derived));

    const inst = new Boundary({ name: '测试面板' });
    inst.state = { error: errObj };
    const badHtml = renderToStaticMarkup(inst.render());
    chk('P4b 错误态渲染错误卡（含面板名/摘要/重试/刷新，不白屏）',
      badHtml.includes('测试面板 渲染出错') && badHtml.includes('重试') && badHtml.includes('刷新整页') && badHtml.includes('boom-c40'),
      badHtml.slice(0, 120));

    inst.state = { error: null };
    const okHtml = renderToStaticMarkup(inst.render());
    // error:null 时 render 直接返回 this.props.children（undefined）→ 仅验证不抛错且输出为空
    chk('P4c 错误清空后 render 恢复透传（不抛错、无错误卡）', okHtml === '', okHtml.slice(0, 60));
    // 正常态 children 渲染（单独构造，避免与错误态混淆）
    const okHtml2 = renderToStaticMarkup(
      React.createElement(Boundary, { name: '测试面板' }, React.createElement('div', null, '正常内容'))
    );
    chk('P4d 正常 children 原样渲染（无错误卡）', okHtml2.includes('正常内容') && !okHtml2.includes('渲染出错'), okHtml2.slice(0, 80));
  } catch (e) {
    chk('P4 渲染冒烟', false, String(e && e.message || e).slice(0, 200));
  } finally {
    console.error = origErr;
  }

  console.log('---');
  console.log('PASS=' + pass + ' FAIL=' + fail);
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})();
