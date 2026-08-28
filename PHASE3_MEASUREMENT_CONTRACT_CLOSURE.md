# Phase 3 · STEP 1 — Measurement Contract Closure

> 时间：2026-08-27｜遵守规则：不修改 Business Success Definition / 不修改 benchmark task pool / 不修改 decision 语义 / 不修改历史 baseline 数据。
> 范围：仅做度量口径收口（measurement contract），不新增任何产品能力、不重写 verification 架构。

---

## 收口项 1 — status ↔ isBusinessSuccess 单一权威

- **业务问题**：分析器读取任务原始字段 `task.successMetrics.isBusinessSuccess` 作为业务成功依据；但冻结 100-task 数据集的任务根本不含该字段（`successMetrics: undefined`），导致所有任务被默认判为 `false`——基线出现「0% business success」的**度量假象**（实际 5 个 `status=SUCCESS` 任务应计为业务成功）。这与 `server/agent/successMetrics.js` 定义的单一权威（`isBusinessSuccess = status==='SUCCESS'`）直接冲突。
- **代码位置**：`server/scripts/benchmark_framework.js`
  - `analyzeStore`（原 L107）：`isBusinessSuccess: !!(t.successMetrics && t.successMetrics.isBusinessSuccess)`
  - `computeStats`（原 L52）：`if (r.isBusinessSuccess) businessSuccess++;`
- **最小 patch**：
  1. 顶部引入 `const successMetrics = require('../agent/successMetrics');`（既有的单一权威，未改其定义）。
  2. `analyzeStore` 改为 `isBusinessSuccess: successMetrics.isBusinessSuccess(t)`（由 `status==='SUCCESS'` 派生）。
  3. `computeStats` 改为由 `const isBiz = (st === 'SUCCESS')` 派生 `businessSuccess`（与 `success` 同源），不再依赖记录的原始布尔字段。
- **测试**：`test_benchmark_framework.js` 新增 §3.5（单一权威：失真字段被纠正，`conflictCount` 检出）、§3.6（analyzeStore 忽略失真字段、输出权威值）。
- **回归**：`test_benchmark_framework.js` 27/0。

## 收口项 2 — uncategorized failure attribution 收口

- **业务问题**：`deriveCategory` 仅识别 `click/submit/login/longflow`，而真实任务大量使用 `navigate/fill/wait/inspect` 等动作类型（如「SaaS 数据查看」= navigate+inspect，无任何 click/submit），导致 26/100 任务被标为 `uncategorized`，归因分析失效。
- **代码位置**：`server/scripts/benchmark_framework.js` → `deriveCategory`。
- **最小 patch**：扩展动作识别 `fill/type/select → form`、`navigate → nav`；当动作无法判定时，用任务 `name/objective` 关键词兜底（login/submit/click/scrape/other）。`uncategorized` 仅保留给真正不可归类者。
- **测试**：`test_benchmark_framework.js` 新增 §3.7（navigate+inspect→nav、fill→form、关键词兜底、完全不可归类→other）。
- **回归**：27/0；重算冻结数据集后 `uncategorized = 0 / 100`。

## 收口项 3 — 统计字段口径冲突检查

- **业务问题**：原始分析器可能静默采用与单一权威相悖的 `isBusinessSuccess` 字段，且无人察觉。需可量化的冲突检测。
- **代码位置**：`server/scripts/benchmark_framework.js` → `computeStats`。
- **最小 patch**：`computeStats` 新增 `conflictCount`：当记录自带 `isBusinessSuccess` 布尔且与权威（`status==='SUCCESS'`）相悖时计数（仅检测、不覆盖权威值），并加入返回结构。
- **测试**：§3.5 验证 2 条相悖记录→`conflictCount=2`；§3.6 验证 analyzeStore 仅输出权威值→`conflictCount=0`。
- **回归**：27/0。

---

## 修正后基线（冻结数据集，只读重算，未改数据）

`node server/scripts/benchmark_framework.js --analyze .benchmark/_final100_store_backup --out .benchmark/phase3_baseline_corrected.json`

| 指标 | 修正前（旧口径） | 修正后（单一权威） |
|------|------------------|--------------------|
| Business Success | 0% | **5%**（5 个 SUCCESS 任务） |
| conflictCount | 未检测 | 0 |
| uncategorized | 26/100 | **0/100** |
| byStatus | SUCCESS 5 / FAILED 14 / HUMAN_ESCALATION 81 | 同左（不变） |
| byFailureType | DOM_CHANGED 25 / UNKNOWN 33 / STATE_UNKNOWN 38 | 同左（不变） |

> 说明：byStatus / byFailureType 不变，证明本次仅修正**度量口径**，未触碰任何任务终态或成功定义。修正后的基线将作为 STEP 2 live 重跑的对照基准（同口径、同函数）。

## 冻结边界自检

- ❌ 未修改 `successMetrics.isBusinessSuccess` 的定义（仅**使用**既有权威）。
- ❌ 未修改 benchmark task pool / 任务数据 / 历史 baseline 文件。
- ❌ 未修改任何 decision 语义 / VIL / repair 逻辑。
- ❌ 未新增产品能力或架构；仅完善统计聚合与归因标签。
- ✅ 所有改动有测试覆盖（27/0）并全量回归。

**STEP 1 完成 → 自动进入 STEP 2。**
