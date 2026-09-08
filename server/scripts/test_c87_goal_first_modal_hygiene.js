'use strict';
// C87 守护测试 —— NewTaskModal C70 红线回退修复（alert→toast）+ Escape 守卫一致性 + USER_GUIDE Goal-first 节。
// 缺陷背景（C86 新组件引入，零浏览器可证）：
//   D1 B类 NewTaskModal plan/start 两处 catch 用原生 alert(e.message) —— 全库唯一残留点。
//      C70 红线：原生对话框 → 应用内 toast（原生 alert 阻塞主线程、脱离 C41 toast 事件总线、
//      在自动化/无头环境恒被吞）。修复：App 传 notify prop（C41 既有模式），两处 catch 改 notify(...,false)。
//   D2 C类 Escape 关闭无 busy/starting 守卫 —— backdrop 点击有 !busy&&!starting 守卫，
//      Esc 却可在规划/启动中掐断弹层（行为不一致；start 中关闭会丢失 preview.taskId 绑定视图）。
//      修复：guardedClose(useCallback 依赖 busy/starting/onClose)，backdrop 与 useEscapeClose 同源。
//   D3 C类 USER_GUIDE 无 Goal-first 创建流使用说明（C86b 只补了导航映射节）。
// 本测试两层：
//   A 层（运行时最强实证）：esbuild bundle + react-dom/server renderToString ——
//      NewTaskModal 两态（goal 输入态 / notify prop 缺省容错态）SSR 渲染必须成功。
//   B 层（文件断言）：C70 红线全库量化（client/src 零 alert）+ 接线锚定，防回归漂移。

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
// C58 P7b 教训：断言前剥离 // 与 /* */ 注释。
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
  const ntm = stripComments(read('client/src/components/NewTaskModal.jsx'));
  const app = stripComments(read('client/src/App.jsx'));

  // ================= A 层：SSR 运行时渲染 =================
  let esbuild;
  try { esbuild = require(path.join(CLIENT, 'node_modules', 'esbuild')); }
  catch (e) { esbuild = require('esbuild'); }

  const compDir = CLIENT.replace(/\\/g, '/') + '/src/components';
  const entry = `
    import React from 'react';
    import { renderToString } from 'react-dom/server';
    import NewTaskModal from '${compDir}/NewTaskModal.jsx';
    const profiles = [{ id: 'p1', name: 'Shop Profile' }];
    const html1 = renderToString(React.createElement(NewTaskModal, {
      profiles, notify: (m, ok) => {}, onClose: () => {}, onCreated: () => {}
    }));
    const html2 = renderToString(React.createElement(NewTaskModal, {
      profiles, notify: undefined, onClose: () => {}, onCreated: () => {}
    }));
    console.log('SSR_LEN_1=' + html1.length);
    console.log('SSR_LEN_2=' + html2.length);
    if (!html1.includes('你希望 AI 做什么')) throw new Error('goal-first question missing');
    if (!html1.includes('生成计划')) throw new Error('plan CTA missing');
    if (!html1.includes('高级选项')) throw new Error('advanced toggle missing');
  `;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c87_ssr_'));
  try {
    const result = esbuild.buildSync({
      stdin: { contents: entry, resolveDir: tmpDir, loader: 'jsx', sourcefile: 'c87-ssr-entry.jsx' },
      absWorkingDir: CLIENT,
      nodePaths: [path.join(CLIENT, 'node_modules')],
      bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'transform',
    });
    const modPath = path.join(tmpDir, 'bundle.cjs');
    fs.writeFileSync(modPath, result.outputFiles[0].text);
    const out = require('child_process').execFileSync(
      process.execPath, [modPath], { encoding: 'utf8', timeout: 30000 }
    );
    const len1 = Number((out.match(/SSR_LEN_1=(\d+)/) || [])[1]);
    const len2 = Number((out.match(/SSR_LEN_2=(\d+)/) || [])[1]);
    chk('P1a NewTaskModal goal 态 SSR 渲染成功（非空且含 Goal-first 三要素）', len1 > 500 && out.includes('goal-first question') === false && !out.includes('goal-first question missing'), 'len=' + len1);
    chk('P1b NewTaskModal notify 缺省态 SSR 渲染成功（未点错误路径前不依赖 notify 实现）', len2 > 500, 'len=' + len2);
  // P1c 改文件级断言：SSR stdout 只含 LEN 行，文案 marker 已在 entry 内 throw 守护（P1a 通过即已证明）
  chk('P1c Goal-first 问题文案为弹窗首屏主问题（文件级）', ntm.includes('你希望 AI 做什么？'), 'goal-first question anchor');  } catch (e) {
    chk('P1 SSR bundle+render', false, String(e.message).slice(0, 200));
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }

  // ================= B 层：文件断言 =================

  // P2 C70 红线全库量化：client/src 全部源码零原生 alert(
  const allJs = walkJs(path.join(CLIENT, 'src'), []);
  const alertHits = [];
  for (const f of allJs) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    if (/\balert\s*\(/.test(src)) alertHits.push(path.relative(ROOT, f));
  }
  chk('P2a C70 红线全库量化：client/src 零原生 alert(', alertHits.length === 0, 'hits=' + JSON.stringify(alertHits));

  // P3 NewTaskModal 错误路径走 toast + 接线
  chk('P3a NewTaskModal 规划失败走 notify(...,false)', /notify\('规划失败[^\n]*false/.test(ntm), 'catch(plan) must notify');
  chk('P3b NewTaskModal 启动失败走 notify(...,false)', /notify\('启动失败[^\n]*false/.test(ntm), 'catch(start) must notify');
  chk('P3c NewTaskModal props 含 notify', /function NewTaskModal\(\{\s*profiles,\s*notify/.test(ntm), 'notify prop required');
  chk('P3d App.jsx 传 notify={notify} 给 NewTaskModal', /<NewTaskModal[\s\S]{0,200}notify=\{notify\}/.test(app), 'App wiring');
  chk('P3e notify 模式与 C41 toastBus 同源（App notify 定义存在）', /toastBus\.emit/.test(app), 'App notify -> toastBus');

  // P4 Escape 守卫一致性
  chk('P4a guardedClose 引用 busy/starting 守卫', /const guardedClose = useCallback\([\s\S]{0,200}!busy && !starting/.test(ntm), 'useCallback guard');
  chk('P4b useEscapeClose 接 guardedClose（非裸 onClose）', /useEscapeClose\(true,\s*guardedClose\)/.test(ntm), 'escape wired to guard');
  chk('P4c backdrop onClick 同源 guardedClose', /onClick=\{guardedClose\}/.test(ntm), 'backdrop wired to guard');

  // P5 USER_GUIDE Goal-first 节
  const guide = read('docs/USER_GUIDE.md');
  chk('P5a USER_GUIDE 含 Goal-first 创建流节', guide.includes('### 0.1 创建一个 AI 任务（Goal-first）'), 'section anchor');
  chk('P5b 手册覆盖计划预览/风险标注/高级选项三要素', guide.includes('预览计划') && guide.includes('执行模式') && guide.includes('演练模式'), 'coverage');
  chk('P5c 手册说明错误走 toast（与 D1 修复一致）', guide.includes('toast'), 'error-surface doc');

  // ================= 汇总 =================
  console.log('\nRESULT pass=' + pass + ' fail=' + fail);
  if (fail) { console.log('FAILURES:\n' + failures.join('\n')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
