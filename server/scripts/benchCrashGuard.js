'use strict';
// R7 进程级 crash guard（2026-09-03）：benchmark runner/worker 无声死亡取证加固。
// 背景：canonical240_run2 于 10:52 runner 主进程无声死亡（log 戛然而止、无堆栈、无
// WER 事件）——uncaughtException 未注册时 node 虽打印堆栈但 stdout 缓冲在强杀场景
// 可能丢失。本模块用 fs.appendFileSync 同步落盘，崩溃时刻可靠留证据。
// 只改执行容器可观测性，零验证语义/成功定义改动。
const fs = require('fs');
const path = require('path');

let installed = false;

function install(tag) {
  if (installed) return;
  installed = true;
  const t = String(tag || 'bench').replace(/[^\w-]/g, '_');
  const file = path.join('.benchmark', `crash_${t}.log`);
  const write = (kind, code, e) => {
    try {
      const line = `\n==== ${new Date().toISOString()} [${kind}] pid=${process.pid} ====\n`
        + ((e && e.stack) ? e.stack : String(e)) + '\n';
      fs.appendFileSync(file, line);
      console.error(`[crashGuard:${t}] ${kind} 已落盘 ${file}: ${(e && e.message) || e}`);
    } catch (_) { /* 落盘失败时至少尝试 stderr */ }
    // 落盘后强制非零退出：注册 handler 会改变 node 默认退出行为（继续运行 → 假死），
    // benchmark 语义要求快失败——harness 哨兵据此发现并 resume，绝不容忍假死。
    process.exit(code);
  };
  process.on('uncaughtException', (e) => { write('uncaughtException', 101, e); });
  process.on('unhandledRejection', (e) => { write('unhandledRejection', 102, e); });
  return file;
}

module.exports = { install };
