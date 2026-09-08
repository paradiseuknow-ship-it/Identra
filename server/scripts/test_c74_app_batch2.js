'use strict';
// C74 守护测试 —— client 深扫 batch 2（App.jsx 全文 + BrowserViewer/ExecutionPanel 细读）。
// 缺陷背景（全部零浏览器可证）：
//   D0 A类（SSR 探针实录发现）App.jsx ProfilesTab 渲染 {batch && ...} 批量建号弹窗，
//      但 batch/batching/setBatch/runBatch/loadProfiles 全是 App 作用域且从未传入
//      （C70 只修了 isNew/templates，漏了这一族）→ 配置管理 tab 整页渲染即
//      ReferenceError: batch is not defined，被 C40 ErrorBoundary 掩成错误卡。
//      修复：弹窗 JSX 移回 App（状态所有权与渲染位置对齐），「批量」按钮经既有
//      onBatch prop 打开。
//   D1 A类 App.jsx ProfilesTab（独立顶层组件）引用 exportCookies(p.id)，但该函数只定义在
//      App 组件作用域内、从未经 props 传入（C70 D1 同族：裸标识符引用）。
//      事件处理器错误不进 ErrorBoundary（错误边界只捕获渲染错误）→ 运行中配置的
//      「Cookie 导出」按钮点击即 ReferenceError，零反馈死按钮。
//      修复：App 传 onExportCookies={exportCookies}，ProfilesTab 形参解构收口。
//   D2 B类 App.duplicate 零 try/catch —— duplicateProfile 抛错即 unhandled rejection，
//      用户零反馈、列表不刷新（C70 D3 同族）。修复：对齐 launch/stop 错误处理口径。
//   D3 C类 确认弹窗按钮硬编码「确认删除」，但 requestConfirm 也被非删除类破坏性操作
//      使用（GovernancePanel 撤销 API Key）→ 按钮文案误导。修复：requestConfirm 第三参
//      okLabel（默认保持「确认删除」兼容既有 6 处删除语义），confirmIt 透传，
//      撤销 API Key 调用点传「确认撤销」。
//   D4 C类 ExecutionPanel.submitTask 优先级输入非数字经 Number() 变 NaN，
//      JSON.stringify(NaN)=null 静默发给服务器。修复：提交前 Number.isFinite 校验。
// 本测试两层：
//   A 层（运行时）：esbuild bundle + react-dom/server —— App 全树 SSR（首测覆盖，
//      api.js getAuthToken 有 try/catch 兜底故 SSR 安全）+ ProfilesTab 运行中配置态
//      （Cookie 按钮可达路径）。捕获任何裸标识符渲染崩溃 + 锚定 Cookie 按钮渲染。
//      边界（如实记录）：D1 是点击期而非渲染期 ReferenceError，SSR 抓不到点击；
//      点击期守卫由 B1c 负断言（旧断裂模式已消失）+ B1a/B1b 接线正断言承担。
//   B 层（文件断言）：接线/守卫细节锚定，防回归漂移（C58 P7b 教训：断言前剥注释）。

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const CLIENT = path.join(ROOT, 'client');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// C58 P7b 教训：断言前剥离注释。C74 新变体教训：ExecutionPanel 注释含
// 「/api/ai/execution/*」，naive /* */ 正则会从注释内 /* 起吞掉大段真实代码 ——
// 改为行级剥离：只删 trim 后以 // 开头的整行（本仓库前端注释均为行注释）。
const stripComments = (src) => src.split('\n')
  .filter((l) => !/^\s*\/\//.test(l))
  .join('\n');

(async () => {
  // ================= A 层：SSR 运行时渲染 =================
  let esbuild;
  try { esbuild = require(path.join(CLIENT, 'node_modules', 'esbuild')); }
  catch (e) { esbuild = require('esbuild'); }

  const entry = `
    import React from 'react';
    import { renderToString } from 'react-dom/server';
    import App, { ProfilesTab } from '${CLIENT.replace(/\\/g, '/')}/src/App.jsx';

    const noop = () => {};
    const results = {};
    const tryRender = (key, el) => {
      try { const html = renderToString(el); results[key] = { ok: true, len: html.length, html }; }
      catch (e) { results[key] = { ok: false, err: e.constructor.name + ': ' + e.message }; }
    };

    // A1：App 全树 SSR（首次覆盖 —— 此前 C70 只渲染各面板，App 本体从未被零浏览器渲染验证）
    tryRender('app', React.createElement(App, {}));

    // A2：ProfilesTab 运行中配置态（Cookie 按钮可达路径，含 runtime/fingerprint 完整块）
    const fp = {
      os: 'windows', browser: 'chrome',
      screen: { width: 1920, height: 1080, pixelRatio: 1 },
      timezone: 'Asia/Shanghai', language: 'zh-CN',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/152.0.0.0 Safari/537.36',
      webgl: { renderer: 'ANGLE (NVIDIA GeForce RTX 3060)' },
    };
    const p = { id: 'pf1', name: 'P1', group: 'default', running: true, fingerprint: fp, vault: { hasEmail: true, hasPassword: true } };
    tryRender('profilesTabRunning', React.createElement(ProfilesTab, {
      profiles: [p], proxies: [], runtime: { pf1: { uptimeMs: 65000, pagesCount: 2, currentUrl: 'https://example.com' } },
      onAdd: noop, onEdit: noop, onLaunch: noop, onStop: noop, onDuplicate: noop, onRemove: noop,
      onView: noop, onRotate: noop, onExport: noop, onImport: noop, onExportCookies: noop,
      onBatch: noop, notify: noop,
    }));

    console.log('SSR_RESULT ' + JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.ok ? { ok: true, len: v.len, markers: { header: v.html.includes('指纹浏览器控制台'), cookieBtn: v.html.includes('>Cookie<') } } : { ok: false, err: v.err }]))));
  `;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c74-ssr-'));
  const bundlePath = path.join(tmpDir, 'bundle.cjs');
  try {
    const out = esbuild.buildSync({
      stdin: { contents: entry, resolveDir: tmpDir, loader: 'jsx', sourcefile: 'c74-ssr-entry.jsx' },
      absWorkingDir: CLIENT,
      nodePaths: [path.join(CLIENT, 'node_modules')],
      bundle: true, platform: 'node', format: 'cjs', jsx: 'transform', write: false,
    });
    fs.writeFileSync(bundlePath, out.outputFiles[0].text);
    // 子进程执行：渲染崩溃不应拖垮本套件自身
    const { execFileSync } = require('child_process');
    let stdout = '', childErr = '';
    try {
      stdout = execFileSync(process.execPath, [bundlePath], { encoding: 'utf8', timeout: 60000 });
    } catch (e) {
      childErr = String((e.stderr || '') + (e.stdout || '')).slice(0, 400);
    }
    const line = stdout.split('\n').find((l) => l.startsWith('SSR_RESULT '));
    chk('A0 SSR bundle 可执行且产出结果', !!line, childErr || '未捕获 SSR_RESULT 行');
    if (line) {
      const r = JSON.parse(line.slice('SSR_RESULT '.length));
      chk('A1 App 全树 SSR 渲染成功（App.jsx 首次零浏览器全树验证）',
        r.app && r.app.ok, r.app && r.app.err || '结果缺失');
      chk('A2 App 渲染含 header 标题（树完整可达）',
        r.app && r.app.ok && r.app.markers.header, '渲染成功但 header 标题缺失');
      chk('A3 ProfilesTab 运行中配置态 SSR 渲染成功',
        r.profilesTabRunning && r.profilesTabRunning.ok, r.profilesTabRunning && r.profilesTabRunning.err || '结果缺失');
      chk('A4 运行中配置渲染出 Cookie 按钮（D1 按钮可达路径锚定）',
        r.profilesTabRunning && r.profilesTabRunning.ok && r.profilesTabRunning.markers.cookieBtn,
        '渲染成功但 Cookie 按钮缺失');
    }
  } catch (e) {
    chk('A0 SSR bundle 可执行且产出结果', false, String(e.message || e).slice(0, 200));
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* tmp 清理尽力而为 */ }
  }

  // ================= B 层：文件断言 =================
  const app = stripComments(read('client/src/App.jsx'));
  const gp = stripComments(read('client/src/components/GovernancePanel.jsx'));
  const ep = stripComments(read('client/src/components/ExecutionPanel.jsx'));

  // ---- D0 批量建号弹窗归属（SSR 探针实录发现的第二个 A 类）----
  // ProfilesTab 此前渲染 {batch && ...} 弹窗，但 batch/batching/setBatch/runBatch 全是
  // App 作用域且从未传入 → 配置管理 tab 整页渲染即 ReferenceError。修复：弹窗 JSX 移回 App。
  const ptIdx = app.indexOf('export function ProfilesTab');
  chk('B0a ProfilesTab 具名导出存在（SSR 探针入口）', ptIdx > 0, '未找到 export function ProfilesTab');
  if (ptIdx > 0) {
    const appPart = app.slice(0, ptIdx);
    const ptPart = app.slice(ptIdx);
    chk('B0b 批量建号弹窗 JSX 位于 App（batch && 块 + runBatch 按钮在 ProfilesTab 之前）',
      /\{batch && \(/.test(appPart) && /onClick=\{runBatch\}/.test(appPart),
      '弹窗未移回 App');
    chk('B0c ProfilesTab 体内零 batch/runBatch 裸引用',
      !/\{batch && \(/.test(ptPart) && !/runBatch/.test(ptPart) && !/setBatch\(/.test(ptPart),
      'ProfilesTab 仍引用 App 作用域的 batch 标识符');
    chk('B0d ProfilesTab 仍经 onBatch prop 打开弹窗（按钮接线保持）',
      /onClick=\{onBatch\}/.test(ptPart) && /onBatch=\{\(\) => setBatch\(/.test(appPart),
      '批量按钮 onBatch 接线断裂');
  }

  // ---- D1 exportCookies 接线 ----
  chk('B1a ProfilesTab 形参解构含 onExportCookies',
    /function\s+ProfilesTab\s*\(\s*\{\s*profiles\s*,\s*proxies\s*,\s*runtime[\s\S]{0,200}?onExportCookies/.test(app),
    'ProfilesTab 形参未含 onExportCookies');
  chk('B1b App 调用点传 onExportCookies={exportCookies}',
    /onExportCookies=\{exportCookies\}/.test(app), '调用点未传入 onExportCookies');
  chk('B1c 旧断裂模式已消失（ProfilesTab 内不再裸引用 exportCookies(p.id)）',
    !/onClick=\{\(\)\s*=>\s*exportCookies\(p\.id\)\}/.test(app),
    '仍存在裸引用 exportCookies(p.id) 的点击处理器');
  chk('B1d Cookie 按钮改用 onExportCookies(p.id)',
    /onClick=\{\(\)\s*=>\s*onExportCookies\(p\.id\)\}/.test(app), 'Cookie 按钮未接 onExportCookies');

  // ---- D2 duplicate try/catch ----
  chk('B2 duplicate 含 try（unhandled rejection 面收敛）',
    /const\s+duplicate\s*=\s*async\s*\(id\)\s*=>\s*\{\s*try\s*\{/.test(app),
    'duplicate 仍无 try/catch');

  // ---- D3 okLabel 传递链 ----
  chk('B3a requestConfirm 签名含第三参 okLabel',
    /const\s+requestConfirm\s*=\s*\(message\s*,\s*onConfirm\s*,\s*okLabel\)/.test(app),
    'requestConfirm 签名未含 okLabel');
  chk('B3b 确认按钮渲染 confirmState.okLabel（默认「确认删除」兼容既有删除语义）',
    /\{confirmState\.okLabel\s*\|\|\s*'确认删除'\}/.test(app), '按钮仍硬编码文案');
  chk('B3c GovernancePanel.confirmIt 透传 okLabel',
    /const\s+confirmIt\s*=\s*\(msg\s*,\s*onConfirm\s*,\s*okLabel\)/.test(gp)
    && /requestConfirm\(msg\s*,\s*onConfirm\s*,\s*okLabel\)/.test(gp),
    'confirmIt 未透传 okLabel');
  chk('B3d 撤销 API Key 调用点传「确认撤销」',
    /\},\s*'确认撤销'\)/.test(gp), '撤销调用点未自定义按钮文案');

  // ---- D4 priorityOverride 校验 ----
  chk('B4a ExecutionPanel 优先级 Number.isFinite 校验',
    /Number\.isFinite\(priorityOverride\)/.test(ep), '优先级仍无数字校验');
  chk('B4b 旧 NaN 直传模式已消失',
    !/body\.priorityOverride\s*=\s*Number\(submitForm\.priorityOverride\)/.test(ep),
    '仍存在 Number() 直传 body 的 NaN 面');

  // ---- BrowserViewer/ExecutionPanel 细读结论锚定（C67 已接线，无新缺陷）----
  chk('B5 BrowserViewer 人工介入操作条仍走 api.js（C67 接线保持）',
    /api\.humanClick\(profileId,\s*sel\)/.test(stripComments(read('client/src/components/BrowserViewer.jsx'))),
    'BrowserViewer 拟人操作未走 api.js');

  console.log('SUMMARY ' + JSON.stringify({ pass, fail }));
  if (fail > 0) {
    console.log('FAILURES:\n' + failures.map((f) => '  - ' + f).join('\n'));
    process.exit(1);
  }
})().catch((e) => { console.error('SUITE_ERROR', e); process.exit(2); });
