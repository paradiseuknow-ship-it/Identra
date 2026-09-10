'use strict';
// 回归运行器的临时目录加固 —— **唯一事实源**（runRegression.js 与 run_phase9_regression.sh 共用）。
//
// 背景（PHASE 17-C，2026-09-11，两次实证）：
//   Windows 下 Node 的 os.tmpdir() = TEMP || TMP || %SystemRoot%\temp。
//   后台任务 / 嵌套 shell 里 TEMP、TMP 可能整体缺失或为 POSIX 形态（/tmp），而 MSYS 的
//   环境变量转换在「argv / env / 脚本内 export」三条路径上**并不一致**：
//     实测 export TEMP=/tmp → 子进程 os.tmpdir() = C:\WINDOWS（mkdtemp EPERM）；
//     而继承 TEMP=/tmp → 子进程 os.tmpdir() = C:\Users\...\AppData\Local\Temp（正常）。
//   而 %SystemRoot%\temp 在本机「**可创建但不可列**」（icacls 拒绝访问）→ 测试能用
//   fs.mkdtempSync(path.join(os.tmpdir(), ...)) 建出 fixture，但 esbuild 解析
//   stdin.resolveDir 的**父目录**时需要 list → Access is denied
//   → 8 个 SSR/esbuild 套件整套假红（c70/c74/c78/c80/c81/c82/c87/c88）。
//   同一份代码在 env 正常时全绿 ⇒ **不是代码回归，是执行器环境非确定性**。
//
// 处置：把 TEMP/TMP 固定到一个「带盘符的 Windows 绝对路径 **且** 确实可列」的目录；
//   win32 下显式拒绝 POSIX 形态，消除 MSYS 转换歧义。env 正常时**零行为变化**。
//   命令行用法（供 shell 运行器调用）：node server/scripts/tmpEnvGuard.js
//     → stdout 输出已加固的目录（正斜杠形态，便于 shell 直接 export）

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

/** 候选临时目录（按优先级）。最后一项是仓库内兜底：不依赖任何环境变量，且 .benchmark/ 已 gitignore */
function tmpCandidates() {
  const out = [];
  if (process.env.LOCALAPPDATA) out.push(path.join(process.env.LOCALAPPDATA, 'Temp'));
  try {
    const h = os.homedir();
    if (h) out.push(path.join(h, 'AppData', 'Local', 'Temp'));
  } catch (e) { /* 环境异常时不阻塞 */ }
  if (process.env.USERPROFILE) out.push(path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Temp'));
  out.push(path.join(ROOT, '.benchmark', '.tmp'));
  return out;
}

/** 「可用」= 形态正确（win32 要求盘符绝对路径）且目录**可列**（esbuild 真正需要的能力） */
function usable(p) {
  if (!p || typeof p !== 'string') return false;
  if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(p)) return false;
  try { fs.readdirSync(p); return true; } catch (e) { return false; }
}

/**
 * 返回 { dir, changed, reason }；必要时把 process.env.TEMP/TMP 写回供子进程继承。
 * reason: 'env-ok' | 'env-bad' | 'no-candidate'
 */
function ensureListableTemp() {
  const cur = os.tmpdir();
  if (usable(cur)) return { dir: cur, changed: false, reason: 'env-ok' };
  for (const c of tmpCandidates()) {
    try { fs.mkdirSync(c, { recursive: true }); } catch (e) { /* 尽力而为，继续下一个 */ }
    if (usable(c)) {
      process.env.TEMP = c;
      process.env.TMP = c;
      return { dir: c, changed: true, reason: 'env-bad' };
    }
  }
  return { dir: cur, changed: false, reason: 'no-candidate' };
}

module.exports = { ensureListableTemp, usable, tmpCandidates, ROOT };

if (require.main === module) {
  const r = ensureListableTemp();
  // 正斜杠形态：shell 侧直接 export，且 MSYS 对 `C:/...` 的转换已实测稳定
  process.stdout.write(String(r.dir).replace(/\\/g, '/'));
}
