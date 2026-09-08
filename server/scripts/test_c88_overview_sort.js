'use strict';
// C88 守护测试（回填）—— Overview Recent Activity 排序 TypeError（createdAt 数字时间戳）。
// 缺陷背景（commit e28f626 修复，本测试回填守护层）：
//   OverviewPage recent 排序原写法 `(b.createdAt || '').localeCompare(a.createdAt || '')`：
//   createdAt 为数字时间戳（服务端形状未契约化，部分链路落数字）时对数字调 localeCompare
//   直接 TypeError —— 整页被 ErrorBoundary 兜底（Overview 第一屏全挂）。
//   修复：`String(b.createdAt || '').localeCompare(String(a.createdAt || ''))` 类型归一。
// 本测试三层：
//   A 层（SSR 运行时冒烟）：esbuild bundle + react-dom/server —— OverviewPage 在 C86 新 IA
//      下可编译、可渲染（props 注入 profiles/readiness；api.js localStorage 全在 try/catch，SSR 安全）。
//   B 层（行为杀手）：从**实际源文件**注释剥离后正则提取 .sort(...) 比较器源码，new Function
//      实跑混合类型数据集（数字时间戳 / ISO 字符串 / 缺失 / null）——
//      修复前代码在此数据集上必抛 TypeError，回归即红灯（测的是发货代码，不是副本）。
//   C 层（整类守卫）：client/src 全库（剥注释）所有 .localeCompare( 调用点必须 String() 归一
//      两侧操作数 —— 全库当前唯一调用点在 OverviewPage，未来任何新增裸 localeCompare 直接待机失败。

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
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

function walkJs(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      walkJs(p, out);
    } else if (/\.(jsx?|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

(async () => {
  const overview = stripComments(read('client/src/components/OverviewPage.jsx'));

  // ================= A 层：SSR 运行时冒烟 =================
  let esbuild;
  try { esbuild = require(path.join(CLIENT, 'node_modules', 'esbuild')); }
  catch (e) { esbuild = require('esbuild'); }

  const compDir = CLIENT.replace(/\\/g, '/') + '/src/components';
  const entry = `
    import React from 'react';
    import { renderToString } from 'react-dom/server';
    import OverviewPage from '${compDir}/OverviewPage.jsx';
    const profiles = [
      { id: 'p1', name: 'Shop Profile', group: 'shop', running: true },
      { id: 'p2', name: 'Social Profile', group: 'shop' },
      { id: 'p3', name: 'Lone Profile' },
    ];
    const readiness = { ok: false, checks: [{ name: 'llm', ok: true }, { name: 'proxy', ok: false, optional: false }] };
    const html = renderToString(React.createElement(OverviewPage, {
      profiles, readiness, onNewTask: () => {}, onNavigate: () => {}
    }));
    if (html.length < 500) throw new Error('SSR output too small: ' + html.length);
    if (!html.includes('New Task')) throw new Error('primary CTA missing');
    if (!html.includes('Recent Activity')) throw new Error('recent section missing');
    if (!html.includes('shop')) throw new Error('profile grouping missing');
    console.log('SSR_LEN=' + html.length);
  `;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c88_ssr_'));
  try {
    const result = esbuild.buildSync({
      stdin: { contents: entry, resolveDir: tmpDir, loader: 'jsx', sourcefile: 'c88-ssr-entry.jsx' },
      absWorkingDir: CLIENT,
      nodePaths: [path.join(CLIENT, 'node_modules')],
      bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'transform',
    });
    const modPath = path.join(tmpDir, 'bundle.cjs');
    fs.writeFileSync(modPath, result.outputFiles[0].text);
    const out = require('child_process').execFileSync(
      process.execPath, [modPath], { encoding: 'utf8', timeout: 30000 }
    );
    const len = Number((out.match(/SSR_LEN=(\d+)/) || [])[1]);
    chk('P1a OverviewPage C86 新 IA 下 SSR 渲染成功（组件可编译非空）', len > 500, 'len=' + len);
    chk('P1b SSR 冒烟含三要素（New Task / Recent Activity / profiles 分组）', /SSR_LEN=\d+/.test(out), 'entry markers all passed');
  } catch (e) {
    chk('P1 SSR bundle+render', false, String(e.message).slice(0, 200));
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }

  // ================= B 层：行为杀手（实跑发货比较器）=================
  // 提取实际源文件里的 .sort(...) 比较器（C88 修复点），new Function 后实跑混合类型数据。
  const sortM = overview.match(/\.sort\(\s*(\(?[\w,\s]*\)?\s*=>[\s\S]*?)\)\s*\n?\s*\.slice/);
  chk('P2a 可从源文件提取 recent 排序比较器（结构漂移即红灯）', !!sortM, 'sort comparator not found in OverviewPage.jsx');
  if (sortM) {
    let comparatorSrc = sortM[1].trim();
    if (!/^\(?/.test(comparatorSrc)) comparatorSrc = '(' + comparatorSrc;
    const mkSorted = new Function(
      'tasks',
      'return [...tasks].sort(' + comparatorSrc.replace(/^\(?[\w,\s]*\)?\s*=>/, '(a, b) =>') + ');'
    );
    // 混合类型数据集：数字时间戳（C88 实录触发形状）+ ISO 字符串 + 缺失 + null
    const mixed = [
      { id: 't1', name: 'numeric-newer', createdAt: 1757400000000 },
      { id: 't2', name: 'iso-string', createdAt: '2026-09-09T03:00:00.000Z' },
      { id: 't3', name: 'numeric-older', createdAt: 1757000000000 },
      { id: 't4', name: 'missing', },
      { id: 't5', name: 'null', createdAt: null },
    ];
    let sorted = null, threw = null;
    try { sorted = mkSorted(mixed); }
    catch (e) { threw = e; }
    chk('P2b 混合 createdAt 类型排序零 TypeError（C88 实录形状：修复前必抛）', !threw,
      threw ? ('TypeError reproduced: ' + String(threw.message).slice(0, 120)) : 'no throw');
    if (sorted) {
      const ids = sorted.map((t) => t.id);
      // 期望（String 归一语义）：'9...' 开头的 ISO 字符串 > '17574...' > '17570...' > ''（missing/null 垫底）
      chk('P2c 排序语义保持（ISO 字符串最大值居首、缺失值垫底）', ids[0] === 't2' && ids[ids.length - 2] === 't4' && ids[ids.length - 1] === 't5',
        'order=' + ids.join('>'));
    }
  }

  // ================= C 层：整类守卫（全库 localeCompare 归一）=================
  const allJs = walkJs(path.join(CLIENT, 'src'), []);
  const rawHits = [];
  for (const f of allJs) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    for (const line of src.split('\n')) {
      if (/\.localeCompare\s*\(/.test(line) && !/String\([^()]*\)\s*\.localeCompare\s*\(\s*String\(/.test(line)) {
        rawHits.push(path.relative(ROOT, f) + ' :: ' + line.trim().slice(0, 120));
      }
    }
  }
  chk('P3a 整类守卫：client/src 全部 .localeCompare 调用点必须 String() 归一两侧操作数', rawHits.length === 0,
    'raw hits=' + JSON.stringify(rawHits));
  chk('P3b 修复点源码即 String 归一写法（防注释漂移）',
    /String\(\s*b\.createdAt\s*\|\|\s*''\s*\)\s*\.localeCompare\s*\(\s*String\(\s*a\.createdAt\s*\|\|\s*''\s*\)\)/.test(overview),
    'normalized comparator anchor missing');

  // ================= 汇总 =================
  console.log('\nRESULT pass=' + pass + ' fail=' + fail);
  if (fail) { console.log('FAILURES:\n' + failures.join('\n')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
