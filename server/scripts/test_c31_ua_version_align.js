'use strict';
// C31 守护测试 —— UA 版本 ↔ 引擎版本对齐（层间一致性 invariant）。
// 背景：顺序回归高负载下 powershell 冷启动超时 → getChromeVersion() 静默返回 null →
//       伪造 UA 停在指纹池版本，而 brands/identity 走原生回放 → step19 L6a/L7 红灯。
// 覆盖（零浏览器，纯函数 + 静态守护）：
//   P1 getChromeVersion() 返回 a.b.c.d 四段完整版本
//   P2 memo 生效：第二次调用不再 fork powershell（<50ms 且同值）
//   P3 多次调用恒等（幂等，进程级不变事实）
//   P4 源码守护：memo 缓存变量 / 失败重试 / 失败 warn 三处均在
//   P5 源码守护：launch 侧失守必须报警（不再静默）

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BM = path.join(ROOT, 'server', 'browserManager.js');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}

// 子进程里 require 真实模块测 memo（避免在本进程留下缓存污染）
function probe() {
  const script = `
    const bm = require(${JSON.stringify(BM)});
    const t0 = Date.now();
    const v1 = bm.getChromeVersion();
    const t1 = Date.now();
    const v2 = bm.getChromeVersion();
    const t2 = Date.now();
    process.stdout.write(JSON.stringify({ v1, v2, ms1: t1 - t0, ms2: t2 - t1 }));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8', timeout: 60000, cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // stdout 可能混入模块副作用日志，取最后一个 JSON 对象
  const m = out.match(/\{"v1".*?\}\s*$/s);
  return m ? JSON.parse(m[0]) : null;
}

(async () => {
  let r = null;
  let err = '';
  try { r = probe(); } catch (e) { err = String(e.message || e).slice(0, 300); }

  chk('P0 子进程可加载 browserManager 并读取版本', !!(r && r.v1), err || JSON.stringify(r));
  if (r && r.v1) {
    chk('P1 getChromeVersion 返回 a.b.c.d 四段完整版本',
      /^\d+\.\d+\.\d+\.\d+$/.test(r.v1), 'v1=' + r.v1);
    chk('P2 memo 生效：第二次调用极快（未再 fork powershell）',
      r.ms2 < 50, 'ms1=' + r.ms1 + ' ms2=' + r.ms2);
    chk('P3 多次调用恒等（进程级不变事实）',
      r.v1 === r.v2, r.v1 + ' vs ' + r.v2);
  }

  const src = fs.readFileSync(BM, 'utf8');
  chk('P4a 源码含 memo 缓存变量 _chromeVerCache',
    src.includes('_chromeVerCache'), 'missing');
  chk('P4b 源码含失败重试（attempt < 2）',
    src.includes('attempt < 2'), 'missing');
  chk('P4c 源码含读取失败 warn（不再静默 return null）',
    src.includes('读取引擎版本失败'), 'missing');
  chk('P4d 缓存命中前置短路存在',
    /if \(_chromeVerCache\) return _chromeVerCache;/.test(src), 'missing');
  chk('P5 launch 侧对齐失守时必须报警',
    src.includes('引擎版本未知（profile ') && src.includes('未与 brands/identity 对齐'), 'missing');

  console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
  if (failures.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
