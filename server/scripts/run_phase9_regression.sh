#!/usr/bin/env bash
# Phase 9 完整回归执行器
# 串行执行 server/scripts 下全部 test_*.js，逐个采集 PASS/FAIL/SKIP 与退出码，最后汇总。
# 串行原因：测试共享浏览器 profile 锁与持久化 store，并行会互相干扰（实测会触发非法状态转换）。
set -u
cd "$(dirname "$0")/../.." || exit 1
ROOT="$(pwd)"
# 原先硬编码到本机 node 绝对路径（C:/Users/YogaPC/.workbuddy/...），换任何一台机器就跑不起来。
# 改为默认取 PATH 中的 node，仍可用 NODE=/path/to/node 覆盖。
#
# 注意：新代码请优先用 `npm test`（= node server/scripts/runRegression.js）。
# 该 Node 版执行器跨平台（Windows 下 npm 用 cmd.exe 执行 scripts，无法调用 bash），
# 且支持已知缺口登记与取证跳过计数。本 shell 脚本保留仅为兼容既有使用习惯。
NODE="${NODE:-node}"

# ── 环境确定性加固（PHASE 17-C，2026-09-11；零断言改动）─────────────────────
# 执行器环境的 TEMP/TMP 在后台任务 / 嵌套 shell 下并不确定（可能缺失，或为 POSIX
# 形态 /tmp 而 MSYS 的环境变量转换在 argv / env / 脚本内 export 三条路径上不一致），
# 而 os.tmpdir() 会因此回落到「可创建但不可列」的 %SystemRoot%\temp → 测试能建出
# fixture，但 esbuild 解析 stdin.resolveDir 的父目录时 Access is denied
# → 8 个 SSR/esbuild 套件整套假红（c70/c74/c78/c80/c81/c82/c87/c88）。
# **不是代码回归，是执行器环境非确定性。**
#
# ⚠️ 两个已踩过的坑（勿回退）：
#   1) 在外层命令里 `export TEMP=...` **不会**传递进嵌套 bash → 必须在脚本内部导出。
#   2) 候选**只能是 Windows 绝对路径**。写成 `/tmp` 时 MSYS 会把它映射成
#      `C:\WINDOWS` → mkdtemp 报 EPERM。
#
# 处置：整段判定交给 Node 侧的**唯一事实源**（server/scripts/tmpEnvGuard.js，
# 不依赖任何环境变量：LOCALAPPDATA → os.homedir() → 仓库内 .benchmark/.tmp 兜底）。
# 完整根因链见该文件头部注释。env 正常时此处零行为变化。
if [ -f server/scripts/tmpEnvGuard.js ]; then
  _fix="$("$NODE" server/scripts/tmpEnvGuard.js 2>/dev/null || true)"
  if [ -n "${_fix:-}" ]; then export TEMP="$_fix"; export TMP="$_fix"; fi
fi
echo "临时目录: ${TEMP:-<未设置>}"
OUT=".benchmark/phase9_regression_$(date +%Y%m%d_%H%M%S).txt"
mkdir -p .benchmark

: > "$OUT"
summary=""
ok_files=0
bad_files=0
bad_list=""

for f in $(ls server/scripts/test_*.js | sort); do
  name="$(basename "$f")"
  printf '\n──────── %s ────────\n' "$name" >> "$OUT"
  log="$("$NODE" "$f" 2>&1)"
  code=$?
  echo "$log" >> "$OUT"
  # 兼容三种统计行风格：
  #   a) "PASS=43  FAIL=0"        （P1/P2/P3 风格）
  #   b) "23 PASS / 0 FAIL"       （P4 风格）
  #   c) "19 通过 / 4 失败"        （phase4/phase6 风格）
  line="$(echo "$log" | grep -E 'PASS[:=][[:space:]]*[0-9]+' | tail -1)"
  if [ -z "$line" ]; then
    line="$(echo "$log" | grep -E '[0-9]+[[:space:]]*(PASS|通过)' | tail -1)"
  fi
  if [ -z "$line" ]; then
    line="$(echo "$log" | grep -Ei '全部通过|ALL PASS|OK$' | tail -1)"
  fi
  [ -z "$line" ] && line="(无统计行)"
  printf '%-52s %-34s exit=%s\n' "$name" "$line" "$code" >> "$OUT"
  summary="${summary}$(printf '%-52s %-34s exit=%s\n' "$name" "$line" "$code")
"
  if [ "$code" -eq 0 ]; then ok_files=$((ok_files+1)); else bad_files=$((bad_files+1)); bad_list="${bad_list}  - ${name} :: ${line}\n"; fi
done

printf '\n================ 汇总 ================\n' >> "$OUT"
printf 'OK=%s  BAD=%s\n' "$ok_files" "$bad_files" >> "$OUT"
if [ -n "$bad_list" ]; then printf '失败文件:\n'"$bad_list" >> "$OUT"; fi

echo "$summary"
echo "================ 汇总 ================"
echo "OK=$ok_files  BAD=$bad_files"
if [ -n "$bad_list" ]; then echo "失败文件:"; printf "$bad_list"; fi
echo "完整日志: $ROOT/$OUT"
