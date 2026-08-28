# PHASE 9 — Real World Validation 最终能力评估报告

> 冻结基线：v0.1-alpha（package.json 0.1.0，Node v22.22.2，deepseek-chat，simulated:false）
> 数据来源：`.benchmark/phase9_1787698717444.json`（runner 落盘，100 任务）+ `server/data/*`（aiTasks/Steps/Attempts/RepairAttempts/FailureSnapshots 真实 store）
> 执行约束：本阶段仅做数据审计、指标计算、产品决策分析。**未修改任何代码，未重跑 benchmark，未调整成功定义，未修正失败数据。**

---

## Executive Summary（一句话结论）

**v0.1-alpha 在 100 个真实用户场景（DeepSeek 真实链路，无 mock / 无 attachPlan）下：Planner 99%、执行动作成功率 62.5%、但 Business Success 仅 9%、Human Escalation 高达 90%（其中 Real 能力升级 72%、Credible 凭据/策略升级 18%）。**

**这不是能力「退化」，而是第一次「诚实测量」**：Phase 6 的 verification 是伪造的（67% 准确率但无意义）、Phase 7 甚至没有真正做 verification（107 步 verification:none=0%），且两者都**未 instrument taxonomy 与 escalation 拆分**。Phase 9 首次让 verification 真正运行、首次 instrument 失败分类与升级归因，于是原来被掩盖的真实能力缺口（VERIFY_FAILED 65%、ELEMENT_NOT_FOUND 7%）暴露出来。

**最大观察点（与 Phase 7 修复预期一致）**：VERIFY_FAILED 占 65%，且 **repair 触发率 100%、repair 尝试成功率 66.7%，但业务恢复率 0%**——repair 在微观上「成功执行」，却永远无法清除 verification 关卡，任务最终仍升级。这说明瓶颈在 **verification 策略质量**，而不是执行或 resolver。

**v0.2 判定：A 档（Candidate）四项全未达标 → 降级为 B 档（Engineering Ready）**。架构稳定、链路忠实、代码已冻结；限制产品化的是 **verification 策略质量 + resolver 泛化**，属于「能力硬化」而非「架构重写」。

---

## Part 1 — 数据一致性审计（Data Integrity）

### 方法
- Phase 9 runner 落盘 `phase9_1787698717444.json` 含 `perTask`（100 条自包含切片）。
- 真实 store 位于 `server/data/`，但为**多历史 run 混合**。通过服务端口 `127.0.0.1:6693`（Phase 9 专属）从 store 中**隔离出 Phase 9 的 100 个任务**及其 steps/attempts/repairs/failureSnapshots，与 perTask 交叉核对。

### 结果：**完全一致**

| 校验项 | perTask(JSON) | store(6693 隔离) | 一致 |
|---|---|---|---|
| 任务数 | 100 | 100 | ✅ |
| Step 总数 | 579 | 579 | ✅ |
| Attempt 总数 | 1450 | 1450 | ✅ |
| Repair 总数 | 216 | 216 | ✅ |
| perTask.status vs store.aiTasks.status 偏差 | — | 0 | ✅ |

**结论**：JSON 与 store 完全对齐，任务生命周期（Task→Planner→Execution→Verification→Recovery→Final State）完整，无数据虚构、无截断。审计通过。

---

## Part 2 — 核心产品指标

### 2.1 Planner Capability
| 指标 | 值 |
|---|---|
| Planner Success Rate | **99%**（99/100，仅 1 个被 schema 拒绝） |
| Schema Reject Rate | 1% |
| Average Steps | 5.8 / 任务 |

> Planner 已成熟稳定。平均 5.8 步（Phase 6 为 3.57），说明 Phase 9 任务更长、更复杂。

### 2.2 Execution Capability（store 派生，1450 attempts）
| 指标 | 值 |
|---|---|
| **Execution (Action) Success Rate** | **62.5%**（906 SUCCESS / 1450） |
| Attempts 总数 | 1450 |
| FAILED attempts | 544 |

**Action Failure Distribution（来自 aiFailureSnapshots.errorType，真实 store）**：
| 失败类型 | 事件数 |
|---|---|
| VERIFICATION_FAILED | 68 |
| CREDENTIAL_MISSING | 18 |
| ELEMENT_NOT_FOUND | 4 |

> 执行动作成功率 62.5%，与 Phase 6（64.7%）基本持平 → 执行链路稳定，无退化。

### 2.3 Business Success（严格定义）
```
Business Success = Execution Success  +  Verification Passed  +  No Human Escalation
```
逐任务判定：status=SUCCESS 且 verification 全部通过（或无需 verification）且未升级。

| 指标 | 值 |
|---|---|
| **Business Success Rate** | **9%**（9 / 100） |
| 组件 · Execution Success(任务级) | 9 |
| 组件 · Verification Passed(任务级) | 32 |
| 组件 · No Human Escalation | 10 |

> 这是**诚实**的业务成功率。Phase 6/7 报的 40% 因 verification 伪造/缺失而虚高。

### 2.4 Human Escalation（按你的要求强制拆分）
| 指标 | 值 |
|---|---|
| 总 Escalation Rate | **90%**（90 / 100） |
| A. Credible Escalation（凭据/权限/支付/安全策略） | **18%（18）** |
| B. Real Capability Escalation（resolver/verification/exec/recovery 失败） | **72%（72）** |

**关键校验**：`POLICY_BLOCK` 任务共 18 个，**100% 落入 CREDIBLE**（验证「credible=凭据/策略」定义成立）；`ELEMENT_NOT_FOUND` 7 个 **100% 落入 REAL**。两类升级归因干净、不混淆。

> 若不拆分，会误判「90% 都是 Agent 不行」。真实情况是：**只有 72% 是能力问题，18% 是凭据/策略本就该升级（正确行为）**。

---

## Part 3 — Failure Taxonomy

| 类型 | 数量 | 占比 | 影响任务类别 |
|---|---|---|---|
| **VERIFY_FAILED** | 65 | 65% | saas, ecommerce, data_entry, longflow（全类） |
| **POLICY_BLOCK** | 18 | 18% | saas, longflow |
| —（成功，无失败） | 9 | 9% | — |
| **ELEMENT_NOT_FOUND** | 7 | 7% | ecommerce, longflow |
| OTHER | 1 | 1% | data_entry |

### 重点：ELEMENT_NOT_FOUND 是否接近 0？
**否。7%（7 个任务）重新出现。**
- Phase 7 报「ELEMENT_NOT_FOUND 0%」，但当时 **taxonomy 未 instrument**（Phase 7 的 perTask taxonomy 全为 `-`，escalationKind 全空），该 0% 不可直接比较。
- Phase 9 首次 instrument taxonomy，实测 **7 个任务 resolver 找不到元素**，且 100% 落在 ecommerce / longflow（更高复杂度的目标）。
- **结论**：新任务目标复杂度上升，resolver 泛化不足，泛化缺口真实存在。这是仅次于 VERIFY_FAILED 的第二大产品阻塞点。

---

## Part 4 — Verification Analysis（最大观察点）

### VERIFY_FAILED 全景
| 指标 | 值 |
|---|---|
| VERIFY_FAILED 任务数 | **65**（占全部 65%） |
| 触发 repair 数量 | 65（100% 触发） |
| repair「成功」数量（attempt 级） | 65 |
| 最终仍升级数量 | **65（100%）** |

### Repair 策略拆解（store：`aiRepairAttempts.strategyType`，Phase 9 新增 VERIFY_RETRY 链路）
| 策略 | 次数 | 说明 |
|---|---|---|
| `verifyFailed`（= VERIFY_RETRY：WAIT_STABLE→RECHECK_OBSERVATION→RETRY_VERIFY） | 204 | Phase 7 Step5 新增策略，本次主力 |
| `elementChanged`（= SEMANTIC_RELOCATE） | 12 | resolver 重新定位元素 |

> 链路确如设计运行：WAIT_STABLE / RECHECK_OBSERVATION / RETRY_VERIFY 全部被调用（204 次），但**最终 65 个任务无一收敛**。

### 验证失败主要原因判定
**结论：B — 验证逻辑问题（而非时机 A，也非纯执行 C）。**
- 执行动作本身成功率 62.5%，且 VERIFY_FAILED 任务大多**动作已执行成功**，只是 verification 关卡无法确认成功信号 → 升级。
- repair 重跑 WAIT_STABLE/RECHECK/RETRY 只是**用同一套失败的断言反复重查**，永远得不到通过 → 说明 verification 的判定逻辑（预期的成功信号、DOM 断言、语义校验）本身有缺口，而非「等得不够久」或「元素没加载」。
- 这正印证你的预判：Phase 7 修了 resolver / verification contract / repair attribution，但**没解决「验证策略质量」**。

---

## Part 5 — Repair Analysis（双指标）

| 指标 | 值 | 含义 |
|---|---|---|
| **指标1：Repair Attempt Success Rate** | **66.7%**（144 SUCCESS / 216） | repair 动作本身执行成功 |
| **指标2：Business Recovery Rate**（repair 触发后 step 最终 SUCCESS） | **0%**（step 级 0/72，task 级 0/72） | 业务未恢复 |

**避免 Phase 7 的误判**：若只看「repair success rate=66.7%」会误以为修复有效；但按你要求的双指标看——**修复尝试成功 ≠ 业务恢复**。72 个被修复的 step，最终**无一**达到 SUCCESS 状态（停在 PENDING/HEALING，任务升级）。

### 哪类 failure 易恢复 / 难恢复
| Failure Type | 触发 repair 任务数 | 恢复任务数 | 结论 |
|---|---|---|---|
| VERIFY_FAILED | 65 | 0 | **无法恢复**（verification 逻辑缺口，repair 无法清除） |
| ELEMENT_NOT_FOUND | 7 | 0 | **无法恢复**（resolver 泛化缺口，SEMANTIC_RELOCATE 12 次仍失败） |

> 两类核心失败**都未被 repair 真正解决**。repair 机制本身可运行（66.7% 执行成功），但缺乏「repair → 重新 verification 闭环」的收口逻辑，导致修复成果无法被 verification 接受。

---

## Part 6 — Scenario Matrix

| 类别 | 任务数 | Business Success | 主要失败原因 | 平均耗时 | 平均成本 |
|---|---|---|---|---|---|
| SaaS | 30 | 6.7% | VERIFY_FAILED(14), POLICY_BLOCK(14) | 36.2s | 2122 tok |
| E-commerce | 25 | 12% | VERIFY_FAILED(19), ELEMENT_NOT_FOUND(3) | 40.6s | 2055 tok |
| Data Entry | 20 | 20% | VERIFY_FAILED(15), OTHER(1) | 40.9s | 2254 tok |
| Long Workflow | 25 | 0% | VERIFY_FAILED(17), ELEMENT_NOT_FOUND(4) | 47.3s | 2286 tok |

> - **SaaS** 失败一半是 POLICY_BLOCK（credential/权限）→ 属 Credible 升级，**正确行为**，不应计入能力失败。
> - **Long Workflow 0% 成功**：最长任务 + VERIFY_FAILED + ELEMENT_NOT_FOUND 叠加，是能力最弱区，应作为 Phase 10 重点靶场。
> - 成本/耗时随复杂度单调上升，无异常爆炸，性能稳定。

---

## Part 7 — Phase 对比

| 维度 | Phase 6（30, 伪造 verif） | Phase 7（30, 真实 DeepSeek） | **Phase 9（100, 真实+instrument）** |
|---|---|---|---|
| Resolver / ELEMENT_NOT_FOUND | 未单列 | 0%（**未 instrument**，taxonomy 全 `-`） | **7%**（instrumented，真实） |
| Verification | **伪造** 67% 准确率 | **none-0%**（107 步无 verification） | **真实运行 → VERIFY_FAILED 65%** |
| Recovery | 0% | 22/24（92%，归因修复后） | 尝试 66.7% / **业务 0%** |
| Business Success | ~40%（虚高） | 40%（真实但弱） | **9%**（严格诚实定义） |
| Human Escalation | 46.7% | 46.7%（**未拆分**） | **90%（72 Real / 18 Credible）** |
| Planner | 90% | 90% | **99%** |
| Execution | 64.7% | 64.7% | **62.5%** |

### 哪些能力已成熟
- **Planner**：90% → 99%，成熟。
- **Execution 动作链路**：稳定 62~65%，成熟。
- **Escalation 归因**：Phase 9 首次 instrument，credible/real 干净拆分，机制成熟（正确区分「该升级」与「能力不行」）。

### 哪些仍限制产品化
- **Verification 策略质量**：从「伪造」→「缺失」→「真实但 65% 失败」，是**最大限制项**。
- **Resolver 泛化**：ELEMENT_NOT_FOUND 从 0%（未测）→ 7%（实测），泛化缺口真实。
- **Repair → Verification 闭环**：修复执行成功但业务不恢复，缺收口。

> ⚠️ 重要解读：Business Success 从 40%→9% **不是能力退化**，而是第一次「verification 真实运行 + 严格三闸门定义 + 100 任务更难池」。Phase 6/7 的 40% 是「看不见失败」的假象；Phase 9 的 9% 是「看见真实失败」的基线。这让 v0.2 产品评审有了**可行动的真实数据**。

---

## Part 8 — v0.2 Release Decision

### A 档判定（v0.2 Candidate 门槛）
| 条件 | 要求 | 实测 | 达标 |
|---|---|---|---|
| Business Success | ≥70% | **9%** | ❌ |
| Real Escalation | ≤30% | **72%** | ❌ |
| Recovery | ≥85% | 尝试 66.7% / 业务 0% | ❌ |
| ELEMENT_NOT_FOUND | ≈0% | **7%** | ❌ |

**四项全未达标 → 不是 v0.2 Candidate。**

### 最终等级判定

## ⚠️ 结论：B 档 — Engineering Ready（工程就绪，非产品就绪）

**理由**：
- ✅ **架构稳定**：v0.1-alpha 冻结代码在 100 真实任务下完整跑通 Planner→Resolver→Execution→Verification→Recovery→Escalation，无崩溃、无数据流断裂、无 schema 回归（仅 1 例合理拒绝）。
- ✅ **链路忠实**：真实 DeepSeek、真实 Playwright、真实 verification、真实 repair，无 mock / 无 attachPlan。
- ✅ **度量可信**：首次 instrument taxonomy 与 escalation 拆分，数据经 store 交叉核对 100% 一致。
- ❌ **业务能力不达标**：限制项集中在 **verification 策略质量** 与 **resolver 泛化**，二者均为「能力硬化」范畴，**不需要架构重写**。

> 不选 C（核心链路仍不稳定）：因为链路本身稳定、可跑、可度量；失败是「验证/解析能力不够」，不是「链路碎了」。B 档更准确传达「架构 OK，去硬化能力」的下一步方向。

### 阻塞原因与优先级（Phase 10 硬化路线）
| 优先级 | 阻塞项 | 证据 | 硬化方向 |
|---|---|---|---|
| **P0** | Verification 策略质量 | VERIFY_FAILED 65%，repair 100% 触发但 0% 业务恢复 | 真实成功信号建模（语义 verification、fixture 感知断言、repair→re-verify 闭环收口） |
| **P1** | Resolver 泛化缺口 | ELEMENT_NOT_FOUND 7%，集中在 ecommerce/longflow | 更宽选择器 + 语义解析 + 复杂目标记忆 |
| **P2** | Repair→Verification 收口 | 修复成功但 verification 不接受 | 修复后强制 re-verify，verification 接受 repaired 态 |

### 预计下一阶段目标（Phase 10 出口标准）
- VERIFY_FAILED 从 65% → <20%
- ELEMENT_NOT_FOUND 从 7% → ≈0%
- Business Success ≥70% / Real Escalation ≤30% → 达到 **A 档 v0.2 Candidate**

---

## 交付物与下一步
- 原始数据：`.benchmark/phase9_1787698717444.json`（100 任务 perTask）
- 交叉核对 store：`server/data/{aiTasks,aiSteps,aiAttempts,aiRepairAttempts,aiFailureSnapshots}.json`（端口 6693 隔离）
- 分析脚本（只读，未改 agent 代码）：`.benchmark/analyze_phase9.js`、`.benchmark/phase9_analysis.json`

**本阶段未修改任何代码、未重跑、未修正数据。现进入 v0.2 产品评审——建议聚焦 P0（Verification 策略质量）的硬化方案设计，而非再次进入「发现问题→改代码→重测」循环。**
