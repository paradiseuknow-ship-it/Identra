'use strict';

// Phase 5.1 — Benchmark Mock 站点
// 本地 express 提供 11 类任务的可控页面 + 故障注入端点。
// 所有页面纯静态 + 少量内联 JS，保证可重复、CI 友好。
// 真实站点任务（5.5）不走这里，直接打真实 URL。

const express = require('express');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(require('path').join(__dirname, 'public')));

  // 状态注入：用于结构变化 / 文案变化 / session 失效等场景
  const state = {};

  // ---- login ----
  app.get('/login', (req, res) => res.send(page('login',
    `<form id="loginForm"><input id="username"/><input id="password" type="password"/><button type="button" id="submit">登录</button></form>
     <script>document.getElementById('submit').onclick=()=>{localStorage.setItem('auth','1');location.href='/dashboard';};</script>`)));

  // ---- search ----
  app.get('/search', (req, res) => res.send(page('search',
    `<input id="q"/><button type="button" id="go">搜索</button><div id="results" style="display:none">结果列表</div>
     <script>document.getElementById('go').onclick=()=>{document.getElementById('results').style.display='block';};</script>`)));

  // ---- form ----
  app.get('/form', (req, res) => res.send(page('form',
    `<input id="name"/><input id="email"/><textarea id="msg"></textarea><button type="button" id="submit">提交</button><div id="ok" style="display:none">提交成功</div>
     <script>document.getElementById('submit').onclick=()=>{document.getElementById('ok').style.display='block';};</script>`)));

  // ---- navigation ----
  app.get('/', (req, res) => res.send(page('home',
    `<a href="/products" id="p">产品</a><a href="/docs" id="d">文档</a>
     <script>
       document.getElementById('p').onclick=(e)=>{e.preventDefault();location.href='/products';};
       document.getElementById('d').onclick=(e)=>{e.preventDefault();location.href='/docs/quickstart';};
     </script>`)));
  app.get('/products', (req, res) => res.send(page('products', '<h1>产品</h1><a href="/docs" id="d2">文档</a><script>document.getElementById("d2").onclick=(e)=>{e.preventDefault();location.href="/docs/quickstart";};</script>')));
  app.get('/docs/quickstart', (req, res) => res.send(page('quickstart', '<h1>快速开始</h1>')));

  // ---- text-change ----
  app.get('/text-change', (req, res) => res.send(page('text',
    `<span id="status">Loading</span><button type="button" id="refresh">刷新</button>
     <script>document.getElementById('refresh').onclick=()=>{setTimeout(()=>{document.getElementById('status').textContent='Ready';},800);};</script>`)));

  // ---- timeout（按钮 5s 不响应）----
  // 5.9-A.3 修复 State 验证假阳性：初始 DOM 不含 timeout-detected 文本，localStorage 也不设。
  // 点击 #slow 后需 60s 才置 localStorage.timeout-detected='1'，故 9s verify 窗口内必然 FAILED（验证"能识别超时"）。
  // 旧实现用 display:none 隐藏 div 常驻文本 → body.textContent 恒包含 → 假阳性 SUCCESS。
  app.get('/timeout', (req, res) => res.send(page('timeout',
    `<button type="button" id="slow">慢按钮</button>
     <script>document.getElementById('slow').onclick=()=>{setTimeout(()=>{localStorage.setItem('timeout-detected','1');},60000);};</script>`)));

  // ---- cookie ----
  // 5.9-A.3 修复 State 验证假阳性：初始无 cookie-dismissed 文本/状态；点击 #accept 后才置 localStorage.cookie-dismissed='1'。
  // 旧实现用 display:none 隐藏 span 常驻文本 → 假阳性 SUCCESS。
  app.get('/cookie', (req, res) => res.send(page('cookie',
    `<div id="banner">Cookie 提示 <button type="button" id="accept">接受全部</button></div>
     <script>document.getElementById('accept').onclick=()=>{document.getElementById('banner').style.display='none';localStorage.setItem('cookie-dismissed','1');};</script>`)));

  // ---- structure-change（加载后按钮移位）----
  app.get('/structure', (req, res) => res.send(page('structure',
    `<div id="bottom"><button type="button" id="submit">提交</button></div><div id="done" style="display:none">done</div>
     <script>setTimeout(()=>{const b=document.getElementById('submit');const top=document.createElement('div');top.id='top';top.appendChild(b);document.body.insertBefore(top,document.body.firstChild);},600);
     document.getElementById('submit').onclick=()=>{document.getElementById('done').style.display='block';};</script>`)));

  // ---- session-expired（首次操作被踢回登录）----
  app.get('/session', (req, res) => {
    const authed = req.query.n && req.query.n === '2';
    if (authed) return res.send(page('session-ok', '<div id="dashboard">dashboard</div>'));// 进入 dashboard 判定
    res.send(page('session',
      `<div id="op">操作区</div><button type="button" id="act">执行</button>
       <script>document.getElementById('act').onclick=()=>{if(!localStorage.getItem('auth')){location.href='/login?next=/session?n=2';}else{location.href='/session?n=2';}};</script>`));
  });
  app.get('/dashboard', (req, res) => res.send(page('dashboard', '<h1 id="dashboard">Dashboard</h1>')));

  // ---- browser-crash（中点让页面崩溃信号）----
  app.get('/crash', (req, res) => res.send(page('crash',
    `<button type="button" id="go">开始</button><div id="recovered" style="display:none">recovered</div>
     <script>
       document.getElementById('go').onclick=()=>{
         if(!window.__crashed){window.__crashed=1;window.__crashSignal&&window.__crashSignal();return;}
         document.getElementById('recovered').style.display='block';
       };
     </script>`)));

  // ---- worker-crash ----
  app.get('/worker-crash', (req, res) => res.send(page('worker-crash',
    `<button type="button" id="go">开始</button><div id="recovered" style="display:none">recovered</div>
     <script>document.getElementById('go').onclick=()=>{document.getElementById('recovered').style.display='block';};</script>`)));

  return app;
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

// 独立启动（benchmark 脚本可 require buildApp 也可直接 node 起）
if (require.main === module) {
  const PORT = process.env.BENCH_MOCK_PORT || 4599;
  buildApp().listen(PORT, () => console.log(`[benchmark-mock] on http://localhost:${PORT}`));
}

module.exports = { buildApp };
