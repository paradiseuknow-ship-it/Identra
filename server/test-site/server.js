'use strict';

// 本地测试站点（Phase 1.2 专用，仅本机）。
// 故意制造可预测的场景，供 Agent 验证：表单提交、慢页面、语义定位、Modal 遮挡。
// 端口 9555（8446~9061 是 Windows 保留段，避开）。启动：node server/test-site/server.js

const express = require('express');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PAGE = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;color:#111;line-height:1.6}
input{display:block;margin:8px 0 16px;padding:8px;width:100%;box-sizing:border-box}
button{padding:10px 24px;font-size:15px;cursor:pointer}</style></head><body>${body}</body></html>`;

// 注册表单
app.get('/form', (req, res) => {
  res.send(PAGE('Test Site — Form', `
    <h1>Registration Form</h1>
    <form method="post" action="/form" id="reg-form">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" placeholder="you@example.com" />
      <label for="password">Password</label>
      <input type="password" id="password" name="password" placeholder="Enter password" />
      <button type="submit" name="submit">Register</button>
    </form>`));
});

app.post('/form', (req, res) => {
  const email = (req.body.email || '').trim();
  if (!email || !req.body.password) {
    return res.status(400).send(PAGE('Registration Failed', `<h1>Registration Failed</h1><p>Missing required fields.</p>`));
  }
  res.send(PAGE('Registration Success', `<h1>Registration Success</h1><p>Account created for ${email}</p>`));
});

// 慢页面（测试 wait / 页面未就绪）
app.get('/slow', (req, res) => {
  setTimeout(() => {
    res.send(PAGE('Slow Page', `<h1>Slow Page Loaded</h1><button>Continue</button>`));
  }, 4000);
});

// 首访慢（5s）、后续快 —— 测试 timeout 确定性恢复（首次超时 → 等待/重载 → 成功）
let flakyCount = 0;
app.get('/flaky', (req, res) => {
  const n = flakyCount++;
  const delay = n === 0 ? 5000 : 100;
  setTimeout(() => {
    res.send(PAGE('Flaky Page', `<h1>Flaky Page (${n === 0 ? 'slow first hit' : 'fast'})</h1><button>Continue</button>`));
  }, delay);
});

// 前 N 次都慢（5s）、之后快 —— 让**当前**确定性恢复预算必然耗尽，从而真正进入 Repair 层
// WAIT_RETRY_RELOAD 并成功。
// C140 归因：旧值 n<4 是「确定性恢复 ≤3 次」时代的快照。实测恢复预算 = 1 + stepMax(默认 3)
// = 4 次导航 + ≤1 次 reload（recoveryManager RELOAD_CAP_PER_STEP=1）⇒ 第 5 个请求(n=4)恰好快
// ⇒ 确定性恢复在第 4 次导航即成功，Repair 层**恒不被触达**（实测 repairs=[]）。
// 现取 6（>5，留 1 单位余量），并由 test_c140_repair_action_contract.js 对
// 「6 > 1 + 运行时默认重试 3 + reload 上限 1」做跨层不变量守护（防再次静默漂移）。
const FLAKY4_SLOW_REQUESTS = 6;
let flaky4Count = 0;
// 复位入口：test-site 进程可能跨套件/跨次回归存活（端口已有且版本匹配时 _testSite.ensure()
// 不重启进程）⇒ 计数不复位会让本夹具在第 2 次运行时恒快，断言静默变红。套件在用例前 GET 本路由。
app.get('/flaky4-reset', (req, res) => { flaky4Count = 0; res.json({ ok: true, slowRequests: FLAKY4_SLOW_REQUESTS }); });
app.get('/flaky4', (req, res) => {
  const n = flaky4Count++;
  const slow = n < FLAKY4_SLOW_REQUESTS;
  setTimeout(() => {
    res.send(PAGE('Flaky4 Page', `<h1>Flaky4 Page (${slow ? 'slow#' + (n + 1) : 'fast'})</h1><button>Continue</button>`));
  }, slow ? 5000 : 100);
});

// 无任何交互元素 —— 测试最终失败 + AI Diagnosis（元素不存在且无同义命中）
app.get('/empty', (req, res) => {
  res.send(PAGE('Empty Page', `<h1>Empty Page</h1><p>No interactive elements here.</p>`));
});

// Cookie 弹窗遮挡 —— 测试 OBSTRUCTION 修复（自动关闭弹窗后继续）
// 注意：按钮点击用坐标实现（不校验遮挡），所以用"真实跳转 + page_change 验证"来判断是否点到内容按钮。
app.get('/cookie', (req, res) => {
  res.send(PAGE('Cookie Page', `
    <h1>Cookie Page</h1>
    <button type="button" name="continue" onclick="location.href='/cookie-done'">Continue</button>
    <div id="consent" style="position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:9999">
      <div style="background:#fff;padding:24px;border-radius:8px;text-align:center">
        <p>We use cookies to improve your experience.</p>
        <button type="button" name="accept" onclick="document.getElementById('consent').remove()">Accept Cookies</button>
      </div>
    </div>`));
});
app.get('/cookie-done', (req, res) => res.send(PAGE('Cookie Done', `<h1>Cookie Done</h1><p>Overlay dismissed and continued.</p>`)));

// 元素演化：第 1 次 Continue → 之后 Proceed（测试 Element Memory pattern 积累 + 命中零推理）
let evolveCount = 0;
app.get('/evolve', (req, res) => {
  const n = evolveCount++;
  const label = n === 0 ? 'Continue' : 'Proceed';
  res.send(PAGE('Evolve Page', `<h1>Evolve Page</h1><button type="button" name="go" onclick="location.href='/evolve-done'">${label}</button>`));
});
app.get('/evolve-done', (req, res) => res.send(PAGE('Evolve Done', `<h1>Evolve Done</h1><p>Navigated via button.</p>`)));

// 语义定位：按钮文字故意用 "Continue" 而非 "submit"
app.get('/renamed', (req, res) => {
  res.send(PAGE('Renamed Button', `
    <h1>Renamed Button</h1>
    <p>Follow the steps</p>
    <button type="button" name="action">Continue</button>`));
});

// 语义重定位 + 可验证效果（C140）：旧 /renamed 的按钮**没有 onclick**，点击不产生任何页面变化。
// 而 click 属 schema/action.js MUST_VERIFY ⇒ 必须有 verification(type≠none) 或 expectedBusinessState；
// 于是「语义 Proceed 不在 → 恢复探测 Continue → 点击」这条链在 /renamed 上**无法诚实验证**：
// 写 verification:{type:'none'} 判 ACTION_INVALID（实测恒败），写任何 DOM 断言都是恒真的假绿。
// 故新增本夹具：按钮文案同为 Continue（与 /renamed 同形），但点击真实跳转 ⇒ page_change 可验证。
app.get('/renamed-nav', (req, res) => {
  res.send(PAGE('Renamed Nav', `
    <h1>Renamed Nav</h1>
    <p>Follow the steps</p>
    <button type="button" name="action" onclick="location.href='/renamed-done'">Continue</button>`));
});
app.get('/renamed-done', (req, res) => res.send(PAGE('Renamed Done', `<h1>Renamed Done</h1><p>Relocated to Continue and navigated.</p>`)));

// Modal 遮挡（测试模态框识别）
app.get('/modal', (req, res) => {
  res.send(PAGE('Modal', `
    <h1>Page behind modal</h1>
    <button id="open-modal">Open</button>
    <div id="modal" style="position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center">
      <div style="background:#fff;padding:24px;border-radius:8px">
        <p>This is a modal dialog</p>
        <button type="button" id="close-modal" name="close">Close</button>
      </div>
    </div>`));
});

// 健康检查
app.get('/', (req, res) => res.send(PAGE('Test Site Home', '<h1>Test Site</h1><ul><li><a href="/form">/form</a></li><li><a href="/slow">/slow</a></li><li><a href="/renamed">/renamed</a></li><li><a href="/modal">/modal</a></li></ul>')));

const PORT = 9555;
const VERSION = 10; // 递增版本号：测试脚本据此检测"残留旧进程"（C140：新增 /renamed-nav·/renamed-done·/flaky4-reset）
app.get('/ping', (req, res) => res.json({ ok: true, version: VERSION }));
app.listen(PORT, () => console.log(`[test-site] v${VERSION} http://localhost:${PORT}`));
