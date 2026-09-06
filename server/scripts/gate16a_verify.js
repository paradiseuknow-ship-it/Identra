'use strict';

// Phase 16-B Gate A — 六项验证脚本（native Chromium 152 构建完成后执行）
// 用法: node server/scripts/gate16a_verify.js [D:\\chromium\\build\\chrome.exe]
// 六项（BUILD_CHAIN Gate A）: launch / version=152.x / Playwright launch / persistent profile / navigation / JS execution
// 全部通过输出 BUILD_CHAIN = PASS 判定行；任一失败 exit 1（不降 Gate）。
// 注：Windows 下 chrome --version stdout 不可靠 → V2 以 CDP Browser.getVersion 为准。

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BIN = process.argv[2] || 'D:\\chromium\\build\\chrome.exe';

let pass = 0; let fail = 0; const failures = [];
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name + (detail ? ' :: ' + detail : '')); }
  else { fail++; failures.push(name + (detail ? ' :: ' + String(detail).slice(0, 300) : '')); console.log('  FAIL ' + name + (detail ? ' :: ' + String(detail).slice(0, 300) : '')); }
}

(async () => {
  if (!fs.existsSync(BIN)) { console.error('FATAL binary 不存在: ' + BIN); process.exit(2); }
  const sizeMB = Math.round(fs.statSync(BIN).size / 1024 / 1024);
  console.log('binary: ' + BIN + ' (' + sizeMB + ' MB)');

  // V1 launch + V3 Playwright/CDP 驱动 + V2 version（CDP）
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp16b-gatea-'));
  const t0 = Date.now();
  const ctx = await chromium.launchPersistentContext(profileDir, {
    executablePath: BIN,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const launchMs = Date.now() - t0;
  assert('V1 native launch（persistent context）', true, launchMs + 'ms');

  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('about:blank');
  const cdp = await ctx.newCDPSession(page);
  const verInfo = await cdp.send('Browser.getVersion');
  const versionOut = verInfo.product + ' ' + (verInfo.revision || '');
  assert('V2 version 输出 152.x', /152\./.test(versionOut), versionOut);
  assert('V3 Playwright 可驱动 native binary + CDP', !!cdp);

  // V5 basic navigation（真实 http origin，本地 server 排除外网方差）
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><title>fp16b-gatea</title><body>ok</body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  await page.goto(base + '/');
  const navTitle = await page.title();
  assert('V5 basic navigation（http origin + title）', navTitle === 'fp16b-gatea', navTitle);

  // V4 persistent profile：http origin 写 localStorage → 重启同 profile → 读回
  await page.evaluate(() => localStorage.setItem('fp16b', 'persist-ok'));
  await ctx.close();
  const ctx2 = await chromium.launchPersistentContext(profileDir, {
    executablePath: BIN, headless: true,
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const page2 = ctx2.pages()[0] || await ctx2.newPage();
  await page2.goto(base + '/');
  const persisted = await page2.evaluate(() => localStorage.getItem('fp16b'));
  assert('V4 persistent profile（localStorage 跨重启保留）', persisted === 'persist-ok', persisted);

  // V6 basic JS execution
  const jsOk = await page2.evaluate(() => 40 + 2);
  assert('V6 basic JS execution', jsOk === 42, String(jsOk));
  await ctx2.close();
  server.close();
  fs.rmSync(profileDir, { recursive: true, force: true });

  console.log('');
  if (fail === 0) {
    console.log('BUILD_CHAIN = PASS');
    console.log('记录项（补入 PHASE16B_BUILD_CHAIN.md）: binary=' + BIN + ' sizeMB=' + sizeMB + ' version=' + versionOut + ' launchMs=' + launchMs);
  } else {
    console.log('BUILD_CHAIN = FAIL（不降 Gate）');
    failures.forEach((f) => console.log('  - ' + f));
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
