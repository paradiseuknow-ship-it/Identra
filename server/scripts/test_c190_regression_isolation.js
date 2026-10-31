'use strict';
// C190 — 回归套件「产品数据根隔离」守护
//
// 背景：phase9 回归曾有 14 个套件零隔离直写 server/data——每次回归往产品任务库塞
// 3+ 幽灵任务（历史累积 P9P3 ×263 + step6 fixture ×82，占任务库 17%）、往 elementMemory
// 塞 2+ 垃圾记忆（83/88 条、94%），且 P3 超时 SIGKILL 在 Windows 只杀 node 不杀 Chromium
// 进程树（一次回归泄漏 16 个 chrome）。C140 纪律「产品数据根不得被测试污染」由此机器化。
//
// 覆盖：
//   A. 静态全员：suiteScope --phase9（与 run_phase9_regression.sh 同一事实源）收录的每个
//      脚本，凡 require 写面模块（db / browserManager / agent/store / taskManager /
//      elementMemory），必须在【首个写面 require 之前】设置 FPB_DATA_DIR，且指向
//      os.tmpdir() 的 mkdtemp（不得指向仓库内路径）。
//   B. 运行时抽检：真实跑一个 store 型套件（step10，无浏览器、秒级），断言产品数据根的
//      关键集合文件 mtime/size 全程不变——证明隔离真实生效，而非只有 env 赋值摆设。
//   C. P3 树杀锚定：子进程超时击杀必须 taskkill /T（Windows SIGKILL 只杀 node，
//      Chromium 进程树泄漏）。
//
// 用法：node server/scripts/test_c190_regression_isolation.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = path.resolve(__dirname);
const SERVER = path.resolve(__dirname, '..');
const ROOT = path.resolve(SERVER, '..');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ FAIL: ' + name + (extra ? '  << ' + extra : '')); }
}

// ─────────────────────────────────────────────
// A. 静态全员断言（唯一事实源 = suiteScope --phase9，与回归执行器同一份清单）
console.log('== A. 静态：phase9 套件全员隔离断言 ==');
{
  const res = spawnSync(process.execPath, [path.join(SCRIPTS, 'suiteScope.js'), '--phase9'], { encoding: 'utf8', cwd: ROOT });
  if (res.status !== 0 || !String(res.stdout || '').trim()) {
    console.log('FATAL: 无法从唯一事实源取得套件清单（suiteScope --phase9）');
    process.exit(1);
  }
  const files = String(res.stdout).trim().split(/\s+/).filter(Boolean).map((f) => path.join(ROOT, f));

  // 写面模块：require 即解析 dataRoot（require 期）并具备持久化通路。
  // ★ 必须同时覆盖【字面量】与【动态 path.join】两种 require 形态——C190 首版只查字面量，
  //   被 test_c107_anti_flapping 等经 require(path.join(ROOT,'agent','store')) 绕过，
  //   reg1 后产品根又现 4 条幽灵任务（实证）。传递写入面含 runtime/tools/events
  //   （内部拉 store 链：tasks/steps/events/记忆）。
  const WRITE_MOD_NAMES = new Set([
    'db', 'browserManager', 'vault', 'auth', 'identity', 'proxyPool',
    'agent/store', 'agent/taskManager', 'agent/stepManager', 'agent/runtime', 'agent/tools', 'agent/events',
    'agent/intelligence/elementMemory',
  ]);
  // 返回 src 中全部「写面 require」的出现位置（两种形态合并）
  const writeRequirePositions = (src) => {
    const pos = [];
    // 形态 1：字面量 require('../x') / require('../agent/x')
    const litRe = /require\((['"])(\.\.\/[^'"]+)\1\)/g;
    let m;
    while ((m = litRe.exec(src))) {
      const mod = m[2].replace(/\.js$/, '').replace(/^\.\.\//, '');
      if (WRITE_MOD_NAMES.has(mod) || WRITE_MOD_NAMES.has(mod.replace(/^agent\//, 'agent/'))) pos.push(m.index);
    }
    // 形态 2：动态 require(path.join(X, 'a', 'b')) —— 取引号段拼路径
    const dynRe = /require\(path\.join\(([^)]*)\)\)/g;
    while ((m = dynRe.exec(src))) {
      const parts = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
      for (let i = 0; i < parts.length; i++) {
        const tail = parts.slice(i).join('/');
        const two = parts.slice(i, i + 2).join('/');
        const hit = WRITE_MOD_NAMES.has(tail) || WRITE_MOD_NAMES.has(two)
          || WRITE_MOD_NAMES.has(tail.replace(/^\.\.\//, '')) || WRITE_MOD_NAMES.has(two.replace(/^\.\.\//, ''));
        if (hit) { pos.push(m.index); break; }
      }
    }
    return pos;
  };

  let checked = 0;
  const writeFiles = [];
  for (const file of files) {
    const name = path.basename(file);
    // 自跳过：本守护只读产品文件做快照比对、子进程自带隔离头；且源码内含检测用的
    // 字面量样本（'process.env.FPB_DATA_DIR =' 等），自扫必误报。
    if (name === 'test_c190_regression_isolation.js') continue;
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch (e) { ok('A.0 可读取 ' + name, false, e.message); continue; }
    const writePos = writeRequirePositions(src);
    if (!writePos.length) continue; // 无写面 ⇒ 无隔离义务
    checked++;
    writeFiles.push(name);

    const envIdx = src.indexOf('process.env.FPB_DATA_DIR =');
    ok('A.1 ' + name + ' 设置 FPB_DATA_DIR', envIdx >= 0);
    if (envIdx < 0) continue;

    // 隔离必须在首个写面 require 之前（dataRoot 在 require 期解析，晚了无效）
    const firstReqPos = Math.min(...writePos);
    ok('A.2 ' + name + ' 隔离先于首个写面 require（含动态形态）', envIdx < firstReqPos, 'env@' + envIdx + ' req@' + firstReqPos);

    // 隔离目标必须是临时目录形态（mkdtemp / join(os.tmpdir(),…)），不得指向仓库内路径
    // （__dirname / ROOT 落盘 = 仓库内垃圾累积，step22 曾以此形态累积 6.1 GB）。
    // env 赋值可能是字面量表达式或变量（TMP_DIR / DATA_DIR…）⇒ 变量需回溯其定义行再判。
    const envLine = src.slice(envIdx, src.indexOf('\n', envIdx));
    let rhs = envLine.replace(/^process\.env\.FPB_DATA_DIR\s*=\s*/, '').replace(/;\s*$/, '');
    const varName = rhs.match(/^[A-Za-z_$][\w$]*$/) ? rhs : null;
    if (varName) {
      const defMatch = src.match(new RegExp('(?:const|let|var)\\s+' + varName + '\\s*=\\s*([^\\n;]+)'));
      rhs = defMatch ? defMatch[1] : rhs;
    }
    const tmpShape = /tmpdir\(\)/.test(src) && (varName ? /tmpdir\(\)/.test(rhs) || /mkdtempSync/.test(rhs) : /tmpdir\(\)|mkdtempSync/.test(rhs));
    const repoShape = /__dirname|\bROOT\b/.test(rhs);
    ok('A.3 ' + name + ' 隔离指向 os.tmpdir()（非仓库路径）', tmpShape && !repoShape, 'rhs=' + String(rhs).trim().slice(0, 120));
  }
  // C190 修复时实测写面套件 62 个（字面量＋动态双形态口径）；新增写面套件必须自带隔离
  // （A.1-A.3 会拦），数量只允许增长不允许回退。
  ok('A.4 写面套件覆盖数未回退（C190 基线 62）', checked >= 60, 'checked=' + checked);
  console.log('  （写面套件 ' + checked + ' 个: ' + writeFiles.join(', ') + '）');
}

// ─────────────────────────────────────────────
// C. P3 树杀锚定（chrome 进程树泄漏的回归防护）
console.log('== C. P3 超时进程树击杀锚定 ==');
{
  const p3 = fs.readFileSync(path.join(SCRIPTS, 'test_phase9_p3_memory_governance.js'), 'utf8');
  ok('C.1 P3 超时击杀为进程树级（taskkill /T /F）',
    p3.includes('taskkill') && p3.includes("'/T'") && p3.includes("'/F'"));
  ok('C.2 P3 隔离头存在（fork 子进程各自独立临时根）', p3.indexOf('process.env.FPB_DATA_DIR =') >= 0);
}

// ─────────────────────────────────────────────
// B. 运行时抽检：step10 全程不碰产品数据根
console.log('== B. 运行时抽检：真实跑 step10，产品数据根零变更 ==');
{
  const DATA = path.join(SERVER, 'data');
  const WATCH = ['aiTasks.json', 'aiSteps.json', 'aiAttempts.json', 'aiExecutions.json', 'aiElementMemory.json', 'aiSiteMemory.json', 'profiles'];
  const snapshot = () => {
    const s = {};
    for (const w of WATCH) {
      const p = path.join(DATA, w);
      try { const st = fs.statSync(p); s[w] = Math.round(st.mtimeMs) + '/' + st.size; } catch (e) { s[w] = 'absent'; }
    }
    return s;
  };
  const before = snapshot();
  const run = spawnSync(process.execPath, [path.join(SCRIPTS, 'test_step10_site_memory_wiring.js')], { encoding: 'utf8', timeout: 180000, cwd: ROOT });
  const after = snapshot();
  const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
  ok('B.1 step10 套件退出码 0（隔离头未破坏既有行为）', run.status === 0, String(run.stdout || '').slice(-200));
  ok('B.2 step10 全程未触碰产品数据根（隔离真实生效）', changed.length === 0, '变更: ' + changed.map((k) => k + '(' + before[k] + '→' + after[k] + ')').join(', '));

  // B.3/B.4：events_persistence 直接验证 events 持久化——隔离前每次回归都改写产品 aiEvents.json。
  const evFile = path.join(DATA, 'aiEvents.json');
  const evBefore = (() => { try { const st = fs.statSync(evFile); return Math.round(st.mtimeMs) + '/' + st.size; } catch (e) { return 'absent'; } })();
  const run2 = spawnSync(process.execPath, [path.join(SCRIPTS, 'test_events_persistence.js')], { encoding: 'utf8', timeout: 180000, cwd: ROOT });
  const evAfter = (() => { try { const st = fs.statSync(evFile); return Math.round(st.mtimeMs) + '/' + st.size; } catch (e) { return 'absent'; } })();
  ok('B.3 events_persistence 套件退出码 0（隔离头未破坏既有行为）', run2.status === 0, String(run2.stdout || '').slice(-200));
  ok('B.4 events_persistence 全程未改写产品 aiEvents.json', evBefore === evAfter, evBefore + ' → ' + evAfter);
}

console.log('\n────────────────────────────');
console.log(`PASS=${pass}  FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
