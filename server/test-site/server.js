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

// 前 4 次都慢（5s）、第 5 次起快 —— 确定性恢复(≤3 次)失败 → 进入 Repair 层 WAIT_RETRY_RELOAD 后成功
let flaky4Count = 0;
app.get('/flaky4', (req, res) => {
  const n = flaky4Count++;
  const delay = n < 4 ? 5000 : 100;
  setTimeout(() => {
    res.send(PAGE('Flaky4 Page', `<h1>Flaky4 Page (${n < 4 ? 'slow#' + (n + 1) : 'fast'})</h1><button>Continue</button>`));
  }, delay);
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
const VERSION = 9; // 递增版本号：测试脚本据此检测"残留旧进程"
app.get('/ping', (req, res) => res.json({ ok: true, version: VERSION }));
app.listen(PORT, () => console.log(`[test-site] v${VERSION} http://localhost:${PORT}`));
