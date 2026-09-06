'use strict';
// R7 targeted test：crash guard 真实行为验证（子进程真崩溃 → crash 文件落盘含堆栈）。
// 断言「真正会执行的那份东西」：spawn 独立 node 子进程触发 uncaughtException /
// unhandledRejection，检查 .benchmark/crash_test_guard.log 内容。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CRASH_FILE = path.join(ROOT, '.benchmark', 'crash_test_guard.log');

function runNode(code) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', code], { cwd: ROOT });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code2) => resolve({ code: code2, out }));
  });
}

(async () => {
  let pass = 0, fail = 0;
  const check = (name, cond) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } };

  try { fs.unlinkSync(CRASH_FILE); } catch (_) {}
  const guardPath = path.join(__dirname, 'benchCrashGuard.js').replace(/\\/g, '/');

  // A) uncaughtException → 落盘
  const a = await runNode(`require('${guardPath}').install('test_guard'); setTimeout(()=>{ throw new Error('BOOM_UNCAUGHT'); }, 30);`);
  // B) unhandledRejection → 落盘
  const b = await runNode(`require('${guardPath}').install('test_guard'); setTimeout(()=>{ Promise.reject(new Error('BOOM_REJECTION')); }, 30);`);

  check('A 子进程以 101 非零退出（落盘后快失败）', a.code === 101);
  check('A 崩溃无守卫时不被守卫吞掉（进程仍退出）', a.out.includes('BOOM_UNCAUGHT'));
  const content = fs.existsSync(CRASH_FILE) ? fs.readFileSync(CRASH_FILE, 'utf8') : '';
  check('A crash 文件落盘含堆栈', content.includes('BOOM_UNCAUGHT') && content.includes('uncaughtException'));
  check('A 落盘含时间戳与 pid', content.includes('pid=') && content.includes('===='));

  // B 需要 node 默认行为（unhandledRejection=throw）触发崩溃；若被守卫改变行为也应落盘
  const hasB = content.includes('BOOM_REJECTION') && content.includes('unhandledRejection');
  check('B unhandledRejection 落盘（崩溃或记录任一证据路径）', hasB || b.out.includes('crashGuard'));

  // C) install 幂等（双 install 不抛、不重复注册崩溃）
  const c = await runNode(`const g=require('${guardPath}'); g.install('test_guard'); g.install('test_guard'); console.log('IDLE_OK'); setTimeout(()=>process.exit(0),50);`);
  check('C 双 install 幂等', c.out.includes('IDLE_OK') && c.code === 0);

  // D) tag 消毒（非法字符被替换，不产生路径穿越）
  const d = await runNode(`require('${guardPath}').install('../evil_tag'); setTimeout(()=>{ throw new Error('EVIL'); },30);`);
  const files = fs.readdirSync(path.join(ROOT, '.benchmark')).filter((f) => f.startsWith('crash_'));
  check('D tag 消毒无路径穿越', d.code !== 0 && !files.some((f) => f.includes('..') || f === 'crash_.._evil_tag.log'));

  console.log(`\n结果: PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
})();
