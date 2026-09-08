'use strict';
// C70 守护测试 —— ProfileEditor 渲染崩溃修复（A 类）+ 原生对话框清退 + 错误处理补齐。
// 缺陷背景（全部零浏览器可证，修复前 SSR 探针实录 RENDER_CRASH ReferenceError: isNew is not defined）：
//   D1 A类 ProfileEditor.BasicTab：引用父组件作用域的 isNew/templates 但从未经 props 传入
//      （C12+C13 46999a2 引入）→ 渲染即 ReferenceError；ProfileEditor 挂载在面板级
//      ErrorBoundary（App.jsx C40）之外 → 整个应用树崩溃白屏，新建/编辑配置入口全灭。
//   D2 B类 ProfileEditor.regenerateFingerprint 新建态：setField('seed') 后立即 refreshPreview，
//      闭包 form.seed 陈旧 → 预览仍用旧种子，看似无效。
//   D3 B类 ProxyPanel add/remove：零 try/catch → createProxy/deleteProxy 抛错即
//      unhandled rejection，用户零反馈、列表不刷新。
//   D4 B类 原生对话框清退（C47/C66 同族）：TaskPanel.run 原生 prompt（自动化浏览器恒 null
//      = 运行死按钮）、TaskEditor.save 原生 alert、ProfileEditor 两处原生 alert。
// 本测试两层：
//   A 层（运行时最强实证）：esbuild bundle + react-dom/server renderToString ——
//      ProfileEditor（新建态 + 编辑态）及本批扫描的全部面板 SSR 渲染必须成功
//      （此层可直接捕获任何「裸标识符未定义」类渲染崩溃，不需浏览器）。
//   B 层（文件断言）：接线/守卫细节锚定，防回归漂移。

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
// C58 P7b 教训：注释里引用旧代码字样会污染字面匹配 —— 断言前剥离 // 与 /* */ 注释。
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

(async () => {
  // ================= A 层：SSR 运行时渲染 =================
  let esbuild;
  try { esbuild = require(path.join(CLIENT, 'node_modules', 'esbuild')); }
  catch (e) { esbuild = require('esbuild'); }

  const entry = `
    import React from 'react';
    import { renderToString } from 'react-dom/server';
    import ProfileEditor from '${CLIENT.replace(/\\/g, '/')}/src/components/ProfileEditor.jsx';
    import ProxyPanel from '${CLIENT.replace(/\\/g, '/')}/src/components/ProxyPanel.jsx';
    import TaskPanel from '${CLIENT.replace(/\\/g, '/')}/src/components/TaskPanel.jsx';
    import TemplatesPanel from '${CLIENT.replace(/\\/g, '/')}/src/components/TemplatesPanel.jsx';
    import SchedulesPanel from '${CLIENT.replace(/\\/g, '/')}/src/components/SchedulesPanel.jsx';
    import IntelligencePanel from '${CLIENT.replace(/\\/g, '/')}/src/components/IntelligencePanel.jsx';

    const noop = () => {};
    const proxies = [{ id: 'px1', name: 'N', type: 'socks5', server: '1.2.3.4:1080' }];
    const profiles = [{ id: 'pf1', name: 'P1' }];
    const results = {};
    const tryRender = (key, el) => {
      try { const html = renderToString(el); results[key] = { ok: true, len: html.length, html }; }
      catch (e) { results[key] = { ok: false, err: e.constructor.name + ': ' + e.message }; }
    };

    tryRender('profileNew', React.createElement(ProfileEditor, { profile: {}, proxies, onClose: noop, onSaved: noop, notify: noop }));
    tryRender('profileEdit', React.createElement(ProfileEditor, { profile: { id: 'pf1', name: 'P', tags: ['a', 'b'], startupUrls: ['https://x'], launchArgs: ['--x'], proxyInline: { server: '1.2.3.4:1080' } }, proxies, onClose: noop, onSaved: noop, notify: noop }));
    tryRender('proxy', React.createElement(ProxyPanel, { proxies, onChange: noop, notify: noop, requestConfirm: noop }));
    tryRender('task', React.createElement(TaskPanel, { profiles, notify: noop, onLog: noop, requestConfirm: noop }));
    tryRender('templates', React.createElement(TemplatesPanel, { notify: noop, requestConfirm: noop }));
    tryRender('schedules', React.createElement(SchedulesPanel, { profiles, notify: noop, requestConfirm: noop, onViewDetail: noop }));
    tryRender('intelligence', React.createElement(IntelligencePanel, { notify: noop }));

    console.log('SSR_RESULT ' + JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.ok ? { ok: true, len: v.len, markers: { basic: v.html.includes('基础信息'), tabs: v.html.includes('基础设置') } } : { ok: false, err: v.err }]))));
  `;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c69-ssr-'));
  const bundlePath = path.join(tmpDir, 'bundle.cjs');
  try {
    const out = esbuild.buildSync({
      stdin: { contents: entry, resolveDir: tmpDir, loader: 'jsx', sourcefile: 'c69-ssr-entry.jsx' },
      absWorkingDir: CLIENT,
      nodePaths: [path.join(CLIENT, 'node_modules')],
      bundle: true, platform: 'node', format: 'cjs', jsx: 'transform', write: false,
    });
    fs.writeFileSync(bundlePath, out.outputFiles[0].text);
    // 子进程执行：渲染崩溃（ReferenceError 类）不应拖垮本套件自身
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
      chk('A1 ProfileEditor 新建态 SSR 渲染成功（D1 修复最强实证）',
        r.profileNew && r.profileNew.ok, r.profileNew && r.profileNew.err || '结果缺失');
      chk('A2 ProfileEditor 编辑态 SSR 渲染成功（normalizeProfile 路径）',
        r.profileEdit && r.profileEdit.ok, r.profileEdit && r.profileEdit.err || '结果缺失');
      chk('A3 新建态渲染含 BasicTab「基础信息」节（模板选择块可达）',
        r.profileNew && r.profileNew.ok && r.profileNew.markers.basic, '渲染成功但基础信息节缺失');
      for (const k of ['proxy', 'task', 'templates', 'schedules', 'intelligence']) {
        chk('A-SSR ' + k + ' 面板渲染成功', r[k] && r[k].ok, r[k] && r[k].err || '结果缺失');
      }
    }
  } catch (e) {
    chk('A0 SSR bundle 可执行且产出结果', false, String(e.message || e).slice(0, 200));
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* tmp 清理尽力而为 */ }
  }

  // ================= B 层：文件断言 =================
  const pe = stripComments(read('client/src/components/ProfileEditor.jsx'));
  const tp = stripComments(read('client/src/components/TaskPanel.jsx'));
  const pp = stripComments(read('client/src/components/ProxyPanel.jsx'));
  const appRaw = read('client/src/App.jsx');

  // ---- D1 BasicTab 接线 ----
  chk('B1a BasicTab 形参含 isNew/templates',
    /function\s+BasicTab\s*\(\s*\{\s*form\s*,\s*setField\s*,\s*setOv\s*,\s*isNew\s*,\s*templates\s*\}/.test(pe),
    'BasicTab 形参未含 isNew/templates');
  chk('B1b 调用点传 isNew={isNew} templates={templates}',
    /<BasicTab[^>]*isNew=\{isNew\}[^>]*templates=\{templates\}/.test(pe),
    '调用点未传 isNew/templates');
  // ---- D2 seed 覆盖 ----
  chk('B2a refreshPreview 支持显式 seed 覆盖',
    /payload\?\.seed\s*\|\|\s*form\.seed/.test(pe), 'refreshPreview 未读 payload?.seed');
  chk('B2b 新建态生成传入新种子',
    /refreshPreview\(\{\s*seed:\s*newSeed\s*\}\)/.test(pe), 'regenerate 未传 { seed: newSeed }');
  // ---- D4 原生对话框清退 ----
  chk('B3a ProfileEditor 零原生 alert', !/\balert\s*\(/.test(pe), '残留 alert(');
  chk('B3b TaskPanel 零原生 prompt/alert', !/\b(prompt|alert)\s*\(/.test(tp), 'TaskPanel 残留 prompt(/alert(');
  chk('B3c 运行按钮走 askRun（应用内选择）', /askRun\s*=\s*\(task\)\s*=>/.test(tp) && /onClick=\{\(\)\s*=>\s*askRun\(t\)\}/.test(tp), 'askRun 未定义或按钮未接');
  chk('B3d pickFor 弹层存在且点击 Profile 调 run(pickFor, p.id)',
    /\{\s*pickFor\s*&&/.test(tp) && /run\(pickFor,\s*p\.id\)/.test(tp), '选择弹层缺失或未接线');
  chk('B3e TaskEditor 接收 notify 且保存失败走 toast',
    /function\s+TaskEditor\s*\(\s*\{\s*task\s*,\s*profiles\s*,\s*notify\s*,/.test(tp) && /notify\(\s*'保存失败/.test(tp), 'TaskEditor notify 未接线');
  chk('B3f ProfileEditor 签名含 notify 且 App 注入',
    /function\s+ProfileEditor\s*\(\s*\{\s*profile\s*,\s*proxies\s*,\s*onClose\s*,\s*onSaved\s*,\s*notify\s*\}/.test(pe) &&
    appRaw.includes('notify={notify}'), 'ProfileEditor notify 链路缺失');
  // ---- D3 ProxyPanel 错误处理 ----
  const addBody = (pp.match(/const add = async \(\) => \{[\s\S]*?\n  \};/) || [''])[0];
  chk('B4a ProxyPanel.add 含 try/catch（createProxy 失败有反馈）',
    /try\s*\{/.test(addBody) && /await api\.createProxy/.test(addBody) && /catch\s*\(e\)/.test(addBody),
    'add 未包 try/catch 或未调 createProxy');
  const removeBody = (pp.match(/const remove = \(id\) => \{[\s\S]*?\n  \};/) || [''])[0];
  chk('B4b ProxyPanel.remove 回调含 try/catch + await',
    /async/.test(removeBody) && /await api\.deleteProxy/.test(removeBody) && /catch\s*\(e\)/.test(removeBody),
    'remove 回调缺 try/catch 或未 await');
  // ---- TaskPanel.remove 同族补齐 ----
  const tpRemove = (tp.match(/const remove = \(id\) => \{[\s\S]*?\n  \};/) || [''])[0];
  chk('B5 TaskPanel.remove 回调含 try/catch + await load',
    /async/.test(tpRemove) && /await api\.deleteTask/.test(tpRemove) && /await load\(\)/.test(tpRemove) && /catch\s*\(e\)/.test(tpRemove),
    'TaskPanel.remove 缺 await/try-catch');

  // ================= 汇总 =================
  console.log('\n==== C70 RESULT: ' + pass + ' passed, ' + fail + ' failed ====');
  if (fail) { failures.forEach((f) => console.log('  FAILED: ' + f)); process.exit(1); }
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
