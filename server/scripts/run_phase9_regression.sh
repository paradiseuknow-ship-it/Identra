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
