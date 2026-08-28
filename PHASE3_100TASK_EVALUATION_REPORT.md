# Phase 3 · 100-task Evaluation 跑批与归因报告

> 生成时间：2026-08-27
> 模块：Phase 2 (P1–P6) + Phase 3 Benchmark Framework
> 数据来源：`.benchmark/_final100_store_backup`（冻结 100-task 权威数据集，只读分析）
> 执行方式：`node server/scripts/benchmark_framework.js --analyze .benchmark/_final100_store_backup --out .benchmark/phase3_100task_analysis.json`
> 冻结边界：未修改成功定义 / 未修改 benchmark 口径 / 未重跑 live 100-task / 未触碰 frozen 数据集

---

## 1. 评估范围与方法

本次 100-task Evaluation **不启动新的 live 基准**（环境无可用 DeepSeek/Chromium，且 100-task 自动重跑属冻结授权项）。
采用已建立的「冻结数据集只读分析」实践，对权威快照 `_final100_store_backup` 做零成本、零副作用的归因分析：

- 解析 100 条 aiTask 的终态（`status` / `isBusinessSuccess` / `failureType` / 步骤类别）。
- 经 `benchmark_framework.js`（Phase 3 外观层，懒加载 `phase10Benchmark`，不触发其顶部 env 守卫）聚合统计。
- **不重写任何口径**：统计口径与 Phase 10.9 / Phase 12 基准完全一致（同一 Business Success 定义、同一 store 解析逻辑）。

> ⚠️ 重要前提：该冻结数据集由**更早一版 verification 逻辑**产出（早于本次 Phase 2 P1–P6 加固）。因此本评估是 **P1–P6 加固前的基线测量**；P3/P4/P5/P6 新增能力是应当前基线问题而设计的**增量改进**，其收益需经授权后的 live 重跑方可量化。

---

## 2. 总体指标

| 指标 | 数值 |
|------|------|
| 总任务数 | 100 |
| 终态 SUCCESS | 5（5.0%） |
| 终态 FAILED | 14（14.0%） |
| 终态 HUMAN_ESCALATION | 81（81.0%） |
| **Business Success** | **0（0.0%）** |

> 注意：`status=SUCCESS` 的 5 个任务中，`isBusinessSuccess` 全部为 `false`（见 §5.1）。即「状态成功」与「业务成功」口径在此数据集中存在**残留不一致**——这是 B3（Success 单一权威口径）在 frozen 快照中的历史痕迹，本次评估不修改 frozen 数据，仅作为产品就绪待办上报。

---

## 3. 失败归因

### 3.1 按 failureType（95 个非 SUCCESS 任务）

| failureType | 数量 | 占比 |
|-------------|------|------|
| STATE_UNKNOWN | 38 | 40.0% |
| UNKNOWN | 33 | 34.7% |
| DOM_CHANGED | 25 | 26.3% |

### 3.2 按 step 类别（category）

| category | 数量 |
|----------|------|
| uncategorized | 26 |
| longflow | 16 |
| login,longflow | 13 |
| submit,longflow | 11 |
| login,click,longflow | 7 |
| click,longflow | 7 |
| submit | 10 |
| click | 5 |
| login,click | 4 |
| login | 1 |

- **longflow 相关**合计 54（54%），是失败最集中的任务形态（多步、跨页、易触发异步/状态不确定）。
- **uncategorized 26** 为最大单桶——26 个任务缺少明确的步骤类别归因，属 trace/归因覆盖缺口（由 P6 Trace 升级补齐）。

---

## 4. 新模块（P3/P4/P5/P6）对基线归因的解释力

将基线失败类型映射到本次新增的验证智能能力，可解释「为何被误升级」并指明修复方向：

| 基线 failureType | 现有占比 | 新模块提供的解释/改进 |
|------------------|----------|----------------------|
| **STATE_UNKNOWN (38)** | 40% | 多数属于「页面处理中/结果未定」。`detectAsyncPending`（P4）可识别 processing/pending/waiting/loading 信号，将其中异步态正确归类为 `ASYNC_PENDING → RECHECK_OBSERVATION`（非敏感）或 `HUMAN_ESCALATE`（敏感），**避免盲目升级人工**。 |
| **UNKNOWN (33)** | 35% | `classifyVerificationFailure`（P5）将其映射到 `RECOVERY_CATEGORIES` 字典，给出建议 recovery 路径；`aggregateEvidence`（P3）提供可解释证据分，区分「真无证据」与「证据不足」。 |
| **DOM_CHANGED (25)** | 26% | P1/P2 的 Fresh Observation + observation diff 细分（keyTextChanged/elementStateChanged/pageStructureChanged）+ P3 证据聚合，使其进入「重观察→再验证」闭环而非直接失败/升级。 |

> 关键判断：**81% 的 HUMAN_ESCALATION 中，STATE_UNKNOWN+UNKNOWN 占 71/81**。这些并非「明确业务失败」，而是「验证未定/证据不足」。P4/P5 的引入正是为了把这 71 个「待定」从「升级人工」重新分流到「可恢复类」，从而压低误升级率。该收益需经授权 live 重跑确认。

---

## 5. 关键发现

### 5.1 status=SUCCESS 但 isBusinessSuccess=false（5 个任务）
- 现象：5 个任务 `status` 为 `SUCCESS`，但 `isBusinessSuccess` 为 `false`。
- 含义：执行层「状态」与业务成功「单一权威口径」仍存在分歧点。
- 处置：**冻结规则禁止修改成功定义或 frozen 数据集**，故仅上报为产品就绪待办（推荐：将 `status` 派生自 `isBusinessSuccess`，落实 B3 单一权威）。

### 5.2 HUMAN_ESCALATION 占比畸高（81%）
- 根因指向「验证未定即升级」策略——在异步/长流程任务中尤其明显。
- P4 ASYNC_PENDING 是针对性修复，但需 live 重跑量化。

### 5.3 uncategorized 归因缺口（26）
- 26% 任务无步骤类别，限制根因分析粒度。
- P6 Verification Trace（lineage / evidence timeline / repair reason）补齐可观测性与归因能力。

### 5.4 冻结边界零触碰
- 本次评估：**只读** frozen 数据集 + 新增 read-only 分析脚本；未改动成功定义、benchmark 口径、decision 语义、任务池或任何生产代码逻辑。

---

## 6. 结论与下一步

1. **基线结论**：冻结数据集显示 0% business success、81% 人工升级，失败集中在 STATE_UNKNOWN/UNKNOWN/DOM_CHANGED——典型「验证未定被误升级」画像。
2. **增量改进就绪**：P1–P6 已提供针对该画像的精确分类与恢复能力（ASYNC_PENDING / ErrorClassifier / Evidence Aggregation / Trace），且全部有测试覆盖（125/0 新模块 + 全量回归绿）。
3. **量化门槛（需授权）**：要确认 P1–P6 对 100-task 的实际收益，需启动 **live 100-task 重跑**（依赖 DeepSeek API Key + Chromium + 解除 100-task 自动跑授权）。本步骤**未授权、未执行**。
4. **产品就绪建议**：代码层已具备可测量、可解释、可恢复的验证闭环；在 live 重跑确认误升级率下降前，建议判定为 **「代码就绪 / 测量待确认」**，而非无条件 Product Ready。

---
*附：逐任务明细见 `.benchmark/phase3_100task_analysis.json`（100 条 perTask 记录）。*
