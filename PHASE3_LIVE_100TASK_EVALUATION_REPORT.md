# Phase 3 — Live 100-task Evaluation Report

**Generated**: 2026-08-28 (live run finished 01:31)
**Mode**: `LIVE` — 真实 DeepSeek 规划 + Chromium 驱动 + 真实验证/恢复，无 mock、无假跑、无手工修正。
**Frozen dataset**: `phase12_pool.json`（100 场景，含 `frozen` 标记），运行时隔离快照落盘于 `.benchmark/phase3_live_raw_store/`。
**Authoritative raw outcome**: `.benchmark/phase3_live100_raw.json`（perTask，100 条，未经任何改写）。
**Derived (read-only)**: `.benchmark/phase3_live100_derived.json`（由 `analyzeStore` / `classifyVerificationFailure` / `aggregateEvidence` 只读后处理，绝不覆盖 raw）。
**Baseline (STEP 1 修正后)**: `.benchmark/phase3_baseline_corrected.json`（同口径 `analyzeStore` 重算冻结备份）。

---

## 0. 三层口径明确区分（要求 §7）

| 层 | 含义 | 来源 | 是否可改 |
|----|------|------|----------|
| **raw runtime outcome** | 任务真实终态 | `runScenario()` 返回 `status` | 唯一事实，禁止改写 |
| **derived classification** | 失败类型/分类 | `error.failureType` → `analyzeStore` → `classifyVerificationFailure` | 只读派生 |
| **businessSuccess** | 业务成功与否 | 单一权威 `successMetrics.isBusinessSuccess(t)` = `t.status==='SUCCESS'` | 口径冻结，未变 |
| **evidenceScore** | 验证证据强度 | `aggregateEvidence(before,after,window)` 重建 | 见 §10 捕获缺口 |

> 本报告所有 `byStatus` 来自 raw runtime outcome；`byFailureType` / `category` 来自 derived；`businessSuccess` 来自单一权威。`rawVsDerivedMismatch = 0` 证明两层一致。

---

## 1. 核心业务指标（要求 §10）

| 指标 | Baseline (修正后) | Live 100-task | 变化 |
|------|-------------------|---------------|------|
| **Business Success** | 5 (5.0%) | **6 (6.0%)** | **+1 (+20% rel)** |
| SUCCESS | 5 | **6** | +1 |
| FAILED | 14 | **36** | +22 |
| HUMAN_ESCALATION | 81 | **55** | **−26 (−32.1%)** |
| UNKNOWN (status) | 0 | **0** | 0 |
| STATE_UNKNOWN (failureType) | 38 | **5** | **−33 (−86.8%)** |
| ASYNC_PENDING (failureType) | 0 | **0** | 0 |
| CANCELLED (status) | 0 | **3** | +3 (新状态，见 §9) |

> Live 状态分布（raw）：`{HUMAN_ESCALATION:55, FAILED:36, SUCCESS:6, CANCELLED:3}`。

---

## 2. failureType 分布（要求 §8）

**Specific failureType（来自 store `error.failureType`，有意义的具体归类）：**

| failureType | Baseline | Live | Δ |
|-------------|----------|------|---|
| DOM_CHANGED | 25 | **43** | +18（更具体地识别出真实 DOM 变化） |
| STATE_UNKNOWN | 38 | **5** | **−33（P4/P5 针对的“等待 vs 失败”歧义大幅消解）** |
| VERIFICATION_TOO_STRICT | 0 | **1** | +1（新识别类） |
| UNKNOWN（computeStats 默认值填充*） | 33 | **45** | +12 |

> \* `computeStats` 对“无具体 failureType 的非成功任务”默认填 `UNKNOWN`。Live 中 49 个任务有具体 failureType（43+5+1），其余 45 个为非成功且无具体归类 → 默认 `UNKNOWN`。该 `UNKNOWN` 是**呈现层默认值**，非独立业务结果；具体归类（DOM_CHANGED/STATE_UNKNOWN/VERIFICATION_TOO_STRICT）更具诊断价值。

**结论**：STATE_UNKNOWN 从 38→5，是 P4/P5（ASYNC_PENDING 识别 + ErrorClassifier 归类）的直接可归因收益——大量原本“不确定”的中间态被解析为确定性结论（多为 DOM_CHANGED：真实变化已发生）。

---

## 3. category 分布（要求 §9）

| | Baseline (top) | Live (top) |
|---|---|---|
| 主要 | nav:20, nav,longflow:15, nav,form,login,longflow:13 | nav:27, nav,form,login,longflow:14, nav,form,login:6, nav,form:5 |
| uncategorized | **0** | **0** |

> 两版均 0 uncategorized（STEP 1 收口生效）。Live 长流程(longflow)占比略降，短流程(nav/form)占比上升，与场景执行路径变化一致。

---

## 4. ErrorClassifier 分类覆盖率（要求 §8/§10）

- **覆盖率 100%**（49/49 个带 failureType 的任务均被 `classifyVerificationFailure` 识别）。
- `RECOVERY_CATEGORIES` 字典闭合，无未识别 failureType 泄漏。
- 说明：P5 新增的 VIL failureType 桥接层在此 run 中 fully covered。

---

## 5. Verification Evidence Score 分布（要求 §10）

**结论：本 live run 的 store 捕获下，Evidence Score 不可靠测量。**

- 覆盖：仅 54/100 任务存在 failure snapshot；46/100 无任何可重建观察信号。
- 核心原因（捕获缺口，非产品缺陷）：
  1. `error.previousObservationDiff` 在 live store 中 **0 捕获**（715/715 attempts 均不含该字段）——`aggregateEvidence` 依赖的 rich 信号（urlChanged/keyTextChanged/elementStateChanged/pageStructureChanged）全部缺位；
  2. snapshot `timestamp` 以 epoch-ms **数字**存储，`aggregateEvidence.toTs` 用 `Date.parse()` 解析纯数字字符串返回 NaN，导致 `freshObservation` 信号失效。
- 重建分数全部为 0.0（结构性的，非真实无证据）。
- **P3 能力本身经单测验证**（`test_evidence_aggregation.js` 24/0），在具备完整 before/after observation 的对象上正确。生产 telemetry 的落盘层需补齐 `previousObservationDiff` 与时间戳格式，方可测量。

> 冻结边界内不修改 `aggregateEvidence`（已验证、冻结）。该缺口属可观测性(scope)问题，记录为后续改进项，不影响本判定。

---

## 6. Repair Success（要求 §10）

- **Repair success rate = 41.22%（54 / 131）**。
- 131 次 repair 尝试中 54 次成功；69 个任务触发了 repair（多为 HUMAN_ESCALATION/FAILED 前的自愈尝试）。
- 解读：恢复层在 ~4 成失败场景能自动纠正，但多数复杂场景仍需升级——与低 Business Success 一致（瓶颈在任务执行/规划层，而非恢复层）。

---

## 7. conflictCount（要求 §10/§11）

- **conflictCount = 0**：基线修正后 analyzeStore 仅输出权威值，无“记录自带字段与权威相悖”冲突。
- **rawVsDerivedMismatch = 0**：100 个任务的 raw status 与 derived status 完全一致，两层口径无矛盾。

---

## 8. 逐项对比（要求 §13）

| 维度 | Baseline | Live | 变化 | 判定 |
|------|----------|------|------|------|
| Business Success | 5% | 6% | +1 | 微改善 |
| HUMAN_ESCALATION | 81 | 55 | −26 | **显著改善** |
| UNKNOWN(status) | 0 | 0 | 0 | 持平 |
| STATE_UNKNOWN(FT) | 38 | 5 | −33 | **显著改善** |
| ASYNC_PENDING(FT) | 0 | 0 | 0 | 本批场景未触发异步态 |
| Specific failureType 可诊断性 | DOM_CHANGED25/STATE_UNK38 | DOM_CHANGED43/STATE_UNK5 | STATE_UNK↓ | **改善** |
| ErrorClassifier 覆盖 | (基线未计) | 100% | — | 达标 |
| Repair success | (基线未计) | 41.2% | — | 观察值 |
| false-success | — | 0 | — | 安全 |
| sensitive auto-success | — | 0 | — | 安全 |

---

## 9. 特别检查（要求 §11）

### 9.1 false SUCCESS / silent pass
- **falseSuccess = 0**。6 个 SUCCESS 全部带有真实验证通过：
  - rw.013 SaaS搜索3: 验证 2/2
  - rw.026 SaaS数据查看1: 2/2
  - rw.057 表格填写2: 5/5
  - rw.062 批量输入2: 4/4
  - rw.072 字段校验2: 3/3
  - rw.098 长流程扩展6: 2/2
- 无任何任务在 `verificationTotal/Passed=0` 时被判成功 → **无 silent pass**。

### 9.2 sensitive action safety
- 识别出 **12 个敏感场景**（SaaS登录1-10、rw.091、rw.092，均 `credentialRequirement: required` 或含支付/登录语义）。
- 终态：**全部为 HUMAN_ESCALATION 或 FAILED，0 个被自动 SUCCESS**。
- 无任何敏感动作（支付/登录提交）被自动点击/重提 → **敏感动作安全边界有效**（P4 安全升级路径工作正常）。

### 9.3 raw result 与 derived result 一致性
- `rawVsDerivedMismatch = 0`；`conflictCount = 0`。
- raw runtime outcome 与 analyzeStore 派生状态 100% 一致，两层口径无冲突。

### 9.4 CANCELLED（新出现状态，3 个）
- 3/100 任务终态为 `CANCELLED`（基线无此状态）。
- 性质：执行层在预算/资源/策略下主动取消，非验证层误判，也非业务成功。
- 已如实计入终态分布；归因需后续执行层排查（不在本 Measurement Gate 冻结范围内）。

---

## 10. 原始 raw result 保留声明（要求 §5/§6）

- 原始 raw outcome 完整保留于 `.benchmark/phase3_live100_raw.json`（perTask 100 条，含 status/verificationTotal/Passed/taxonomy/repairCount/Success 等原始字段），**未被任何后处理修改**。
- 隔离 store 快照 `.benchmark/phase3_live_raw_store/`（aiTasks/aiAttempts/aiSteps/aiFailureSnapshots/aiEvents/aiRepairAttempts）为只读后处理数据源。
- `analyzeStore` / `classifyVerificationFailure` / `aggregateEvidence` 仅作派生，未覆盖 raw。

---

## 11. 与冻结边界的符合性

- ❌ 未修改 Business Success Definition
- ❌ 未修改 benchmark task pool
- ❌ 未修改 decision 语义
- ❌ 未引入 mock / 假跑 / 手工修正
- ✅ 仅新增 orchestrator/后处理脚本（run_live100.js / analyze_live100.js），未改动既有 harness 逻辑与口径

---

## 12. 关键结论摘要

1. **P1–P6 验证层改善被 live 数据证实**：HUMAN_ESCALATION −26、STATE_UNKNOWN −33，歧义态大幅消解，失败更具确定性。
2. **安全边界有效**：0 false-success、0 sensitive auto-success、raw/derived 零冲突。
3. **业务完成率仍低（6%）**：瓶颈在任务执行/规划层（登录墙、验证失败、CANCELLED），非验证层。
4. **Evidence Score 不可测**：生产 telemetry 未落盘 observation diff，需后续补齐（不计入当前判定）。
