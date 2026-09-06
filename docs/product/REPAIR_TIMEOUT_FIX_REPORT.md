# REPAIR_TIMEOUT 双修复报告（2026-09-01，dl240 后续）

## 0. 背景

dl240 基线（Business Success 66%）放开 240s deadline 后，2 个此前被 120s 掩盖的 FAILED 新显形：
rw.026/046 = `修复编排超时/异常（重试4次耗尽）: REPAIR_TIMEOUT [ELEMENT_NOT_FOUND]`。
取证发现这是**两个独立 B 类缺陷叠加**，本报告记录双修复与实证。

## 1. Fix ① — 修复编排预算可配置化（runtime REPAIR_TIMEOUT_MS）

**ROOT CAUSE**：`runtime.js` 的 `REPAIR_TIMEOUT_MS = 90000` 硬编码。修复编排 = 1 次 LLM 诊断 +
至多 3 次浏览器修复动作，90s 真实跑不完（rw.046 实证：90s 超时 → 配置 120s 后收敛为
真实 ESC 终态）。

**修复**（与 per-task deadline 可配置化同模式，默认零变化）：
- `runtime.js`：模块级纯函数 `resolveRepairTimeoutMs(v)`——`FPB_REPAIR_TIMEOUT_MS` env
  显式覆盖，解析失败/0/负数一律回退 90000 默认；`run()` 内每次求值；导出供审计。
- `phase12Benchmark.js`：`--task-deadline` 联动推导 `FPB_REPAIR_TIMEOUT_MS =
  max(90000, deadline/2)`（240s→120s）；用户显式 env 优先不覆盖；不设 --task-deadline
  不写 env（默认路径零副作用）。

## 2. Fix ② — SEMANTIC_RELOCATE 修复动作封顶（契约强制执行）

**ROOT CAUSE**（事件链铁证，rw.026 smoke 126 条事件）：`elementChanged.js` 对
`buildElementVariants` 结果**无上限循环**——semantic「数据列表区域」不在 SYNONYMS 字典 →
CLICK_FALLBACK 11 变体 + 原 action = 12 个探测 → **单轮 repair = 1 reload + 11 次 click
盲猜（~55s，每次猜 continue/next/submit…）** × 两轮 repair ≈ 113s → 必然超预算。
「至多 3 次浏览器修复动作」契约被破坏 4 倍。

**修复**（把契约真正落实）：`variants.slice(0, 1 + MAX_PROBE_VARIANTS)`（MAX_PROBE_VARIANTS=3，
即原 action + ≤3 个语义变体）——单轮 repair ≤5 动作 ~30s，90s 默认预算内自然收敛；
字典内语义（Continue→Proceed 类）仍在前 3 变体命中，同义重定位价值保留；
recovery 路径 `buildElementVariants`/`getAction` 不变（runtime retry 阶段语义不受限）。

## 3. 文件

- `server/agent/runtime.js`（resolveRepairTimeoutMs + 接线 + 导出）
- `server/scripts/phase12Benchmark.js`（--task-deadline 联动推导）
- `server/agent/repair/strategies/elementChanged.js`（变体封顶）
- `server/scripts/test_repair_timeout_config.js`（新建，11 项）
- `server/scripts/test_repair_variant_cap.js`（新建，6 项）

## 4. 测试与回归

- `test_repair_timeout_config.js` **11/0 ×2**：T1 默认 90000 零变化 / T2 env 覆盖 /
  T3-T3c 非法回退（abc/0/负数）/ T4 run() 内求值接线（resolveRepairTimeoutMs(env)）/
  T5 联动推导公式 + require 前时序 / T6 显式 env 优先守卫 / T7 默认路径零副作用 /
  T8 导出审计面 / T9 消费点完整。
- `test_repair_variant_cap.js` **6/0 ×2**：T1 前置（未知语义 12 变体，recovery 不变）/
  T2 封顶（12 次盲猜 → 1 reload + 4）/ T3 命中即停 / T4 字典语义同样封顶 /
  T5 探测顺序 = 原 action + 字典头部 3 变体 / T6 契约常量防回归。
  （过程中修 1 个测试自身算术错误：submit 的 13 个 synonym 含自身去重 → 13 变体非 14。）
- 双回归（顺序）新基线：**runRegression.js 69/0 + run_phase9_regression.sh OK=62/BAD=0**。

## 5. 真实 LLM smoke 实证（rw.026/046，--task-deadline 240000）

| 任务 | dl240（修复前） | smoke#1（仅 Fix①） | **smoke#2（Fix①+②）** |
|---|---|---|---|
| rw.026 | FAILED，REPAIR_TIMEOUT，161.6s | FAILED，REPAIR_TIMEOUT，161.6s（实证预算不是唯一根因） | **SUCCESS，15.1s** |
| rw.046 | FAILED，REPAIR_TIMEOUT | HUMAN_ESCALATION，123.9s（Fix① 即生效） | HUMAN_ESCALATION，74.6s（真实收敛更快） |

- **REPAIR_TIMEOUT 出现次数：0**；Planner 100%；Escalation Credible 0 / Real 0；
  avg duration 142.7s → 44.8s。
- rw.026 从「两次 run 均 REPAIR_TIMEOUT→FAILED」转 SUCCESS：封顶消除盲猜长尾后，
  修复编排（或本轮 planner 直接产出可执行计划）在预算内真实完成业务闭环。
- rw.046 维持 VERIFY_RETRY 口径真实收敛（搜索输入框寻址耗尽需人工），无污染。

## 6. 结论与下一步

- 两个 FAILED 全部转为真实业务终态（SUCCESS + 合法 ESC）；REPAIR_TIMEOUT 形态清零。
- 回归基线更新：**69/0 + OK=62/BAD=0**。
- 剩余候选（需用户新授权）：① scraping/search 列表类验证契约对齐（ESC 30% 最大构成）；
  ② 池任务凭据配置（12pp）；③ 正式口径决策（120s vs 240s vs 分类分档）。
