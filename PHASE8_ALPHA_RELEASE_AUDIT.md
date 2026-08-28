# PHASE 8 — Alpha Candidate Release Audit

> 阶段性质：**版本收敛审计 / 只读**。
> 规则遵守：未修改代码、未运行 Benchmark、未改 benchmark 逻辑 / 成功定义 / verification 标准 / fingerprint-E4、未新增功能。
> 审计基准：Phase 7 真实 30 任务 DeepSeek Benchmark（`phase6_1787691693952.json`，`simulated:false`，provider=deepseek）。

---

## 1. Architecture Completeness

| # | 模块 | 入口文件 | 状态 | 风险 | 缺口 |
|---|------|----------|------|------|------|
| 1 | Planner | `planner.js` + `llm/providers/deepseek.js`(`deepseekPlan`) | ✅ 完成 | ⚠️ 受下游 schema 回归拖累（见 A1） | 无结构性缺口 |
| 2 | Schema | `schema/plan.js`、`schema/action.js` | ⚠️ 完成但含回归 | 🔴 **A1：`field:null` 被 `action.js:63` 误拒** | 见 A1 |
| 3 | Observation | `observation.js` | ✅ 完成 | 无 | 已暴露 `name/id/placeholder/label/ariaLabel/role` 等 field 信号 |
| 4 | Resolver | `semanticResolver.js` | ✅ 完成 | 无 | Step 2-A 多信号评分 + field 贯穿，Phase7 ELEMENT_NOT_FOUND=0% |
| 5 | Runtime | `runtime.js`（冻结） | ✅ 完成 | 无 | 未触碰，符合冻结要求 |
| 6 | Verification | `verification.js` | ✅ 完成 | ⚠️ 异步竞态误判（B1） | 非阻塞，见 B1 |
| 7 | Repair | `repair/*`（含 Step5 `verifyFailed.js`） | ✅ 完成 | 无（Step5 已修归因与策略） | 策略库可继续扩充（B2） |
| 8 | Recovery | `recovery/*`（`errorClassifier`/`policy`/`strategies`） | ✅ 完成 | 无 | 升级门控正确（payment=CRITICAL/password=CRITICAL/fill=MEDIUM） |
| 9 | Checkpoint | `checkpoint.js` | ✅ 完成 | 无 | 结构化快照（含 lastVerifiedState / profileId / executionId），支持崩溃回放 |
| 10 | Observability | `observability/traceCollector.js` + 20+ JSON store | ✅ 完成 | 无 | 统一可回放时间线（PLAN/STEP/ACTION/OBSERVATION/ERROR/REPAIR/RETRY/VERIFICATION/CHECKPOINT） |

**结论**：10/10 架构组件齐备且功能闭环，无结构性缺口。唯一阻塞来自 Phase 7 Step 2 引入的 **schema 契约回归**（A1），属数据一致性错误，非架构缺失。

---

## 2. Known Issues Classification

### A. Alpha 前必须修复（阻塞冻结）
| ID | 问题 | 证据 | 影响 |
|----|------|------|------|
| **A1** | **Schema 契约回归**：`schema/action.js:63` `if (t.field !== undefined && !isNonEmptyString(t.field)) errors.push('target.field 非法')` | Phase 7 中 `failure.network_failure` / `failure.verification_failure` / `real.ec.lazy` 三个任务 `schemaResult=FAIL`、`plan stored:[]`；DeepSeek 实际已生成计划，仅因送 `field:null` 被拒 | plannerSuccessRate 被压到 0.90（真实应为 1.0）；3 个任务被**错误判为 planner 失败**，污染成功率与能力评估 |
| A2 | **数据一致性**：归因落库链路（Step5 已修，但需确认冻结前已并入） | `reconcileRepair` + `stepManager.succeedAttempt` 已回写 22 条 SUCCESS 与 43 个 attempt.repairIds（磁盘已持久化） | 若冻结基线未含该修复，repair 指标仍为 0%；属"已修复待冻结确认" |

### B. Alpha 后优化（不阻塞）
| ID | 问题 | 说明 |
|----|------|------|
| B1 | Verification 异步竞态误判 | Phase 7 中 `VERIFY_FAILED` 占 repair 触发 87.5%，多为搜索结果延迟渲染导致验证过早；`verifyFailed` 策略（WAIT_STABLE→RECHECK→RETRY）已缓解，但验证精度仍有提升空间（agentScore.verification=72） |
| B2 | 更复杂 repair 策略库 | 当前 7 类策略已覆盖主路径，可后续扩充（如多步回滚、跨页状态校验） |
| B3 | 更多真实网站覆盖 | 当前 30 任务涵盖 ecommerce / saas / search / failure 类；可扩展行业站点与反爬形态 |
| B4 | 升级抢跑 | HUMAN_ESCALATION 在 repair 耗尽瞬间触发，偶尔早于 step 后续自然恢复（Step5 归因已部分缓解，但升级决策点可精细化） |

### C. 基础设施问题（不阻塞冻结，但影响观测成功率）
| ID | 问题 | 根因 | 处理建议 |
|----|------|------|----------|
| C1 | **RESOURCE_LOCK**（2/24 repair 未恢复） | `tools.js:157` `当前 execution 未持有 Profile 锁` —— 并发/Profile 调度层锁竞争，非 Agent 算法问题 | 锁调度层单独处理（限并发、重试拿锁），不影响 Agent 架构冻结 |

---

## 3. Product Readiness

### 已验证能力（基于 Phase 7 真实 Benchmark + 全程无 mock/fallback/attachPlan）
- ✅ **真实 LLM 规划**：DeepSeek 真实调用，`simulated:false`；双键 target 契约已贯穿（attempt 样本实测 `target:{semantic,field}`）。
- ✅ **浏览器执行**：真实 Chromium 执行，ELEMENT_NOT_FOUND 从 80.1% → **0%**（Step 2-A 生效）。
- ✅ **验证闭环**：verification 真实执行且覆盖 100%（`verification:none` 从 96.7% → **0%**），不再失真。
- ✅ **自动恢复**：repair 归因修复后历史 24 条重算 **22/24（92%）** 成功；`verifyFailed` 策略对 VERIFY_FAILED 正确路由。
- ✅ **人工升级**：HUMAN_ESCALATION 正常触发（saas 凭据 / 锁竞争 / 验证耗尽），policy 门控正确。
- ✅ **可观测**：`traceCollector` + 20+ JSON store 提供完整可回放时间线，支持崩溃恢复与事后审计。

### 关键指标（Phase 7 真实，剥离已知污染后）
| 指标 | 值 | 备注 |
|------|----|------|
| Planner Success | 0.90（真实 1.0） | 受 A1 污染 |
| Execution Success | 64.7% | +22.6pp vs Phase6 |
| Verification Coverage | 100% | 失真已消除 |
| Verification Accuracy | 67.4% | 含异步竞态误判（B1） |
| Recovery(Attribution) | 92%（24 重算） | Step5 修复 |
| Human Escalation | 46.7%（含 7 例 saas 预期升级） | — |
| AgentScore | overall 67 / planning 90 / execution 65 / recovery 50 / verification 72 / autonomy 53 | Planning/Execution/Verification 达 Alpha 级 |

### 判定
架构完整、链路真实、六大能力均已验证闭环。但存在一个**已定位、未修复的代码级正确性缺陷（A1）**，会在冻结后持续污染 planner 指标与成功率。

---

## 4. Freeze Recommendation

### 建议：**暂不冻结 v0.1-alpha（条件性阻塞）**

**阻塞项（冻结前必须完成，预计极小改动）**：
1. **A1 — 修复 `schema/action.js:63` 的 `field:null` 误拒**：将 `field` 归一化（null/空串 → 视为未提供，跳过字符串校验或 trim 后允许），使 DeepSeek 合法 plan 不再被错误拒绝。这是 Phase 7 Step 2 引入的回归，属数据一致性错误，必须在冻结基线前消除。
2. **A2 — 确认 Step5 repair 归因修复已并入冻结基线**：22 条 SUCCESS 归因与 43 个 attempt.repairIds 必须随冻结版本一并发布，否则 repair 指标回退为 0%。

**非阻塞（Alpha 后处理）**：B1–B4（验证精度/策略库/站点覆盖/升级精细化）、C1（RESOURCE_LOCK 锁调度）。

### 一旦 A1 + A2 并入，系统即达到 Alpha Candidate，可冻结为 **v0.1-alpha**，理由：
- 真实 LLM 规划稳定（真实 100%）；
- 浏览器执行与解析闭环（ELEMENT_NOT_FOUND=0%）；
- 验证 100% 真实覆盖；
- 自动恢复闭环（92% 历史归因成功）；
- 人工升级与可观测齐备；
- 全程无 mock / 无 fallback / 无 attachPlan 绕过。

> 注：本审计严格遵守"只读"规则，未对 A1/A2 做任何代码改动，仅给出冻结前阻塞清单。修复需在下一次授权（如 Phase 8 Step 2 或独立 Hotfix）中执行。

---

## 附：审计证据索引
- 真实 Benchmark 结果：`phase6_1787691693952.json`（`simulated:false`）
- 修复分析：`PHASE7_REPAIR_ANALYSIS.md`、`PHASE7_STEP5_REPORT.md`
- 能力对比：`PHASE7_REAL_AI_VALIDATION_REPORT.md`、`PHASE6_REAL_AI_ANALYSIS_REPORT.md`
- 模块入口：已逐一确认 `planner / schema / observation / semanticResolver / runtime / verification / repair / recovery / checkpoint / observability` 均存在且功能闭环
- 已知回归代码点：`server/agent/schema/action.js:63`
