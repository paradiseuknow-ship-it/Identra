# PHASE10_9_FINAL_PRODUCT_VALIDATION.md

> 生成时间：2026-08-26T17:04:56.027Z
> Benchmark JSON：`phase10_1787763155065.json`（generatedAt 2026-08-26T16:52:35.065Z）
> simulated：false ｜ provider：deepseek ｜ model：deepseek-chat
> VIL 事件源：`server/data/aiEvents.json` 运行期周期捕获切片（去重合并，共 13457 条唯一事件）
> 冻结声明：本阶段未修改任何代码/benchmark/fixture/统计口径。仅读取→执行→记录→分析→判定。

## 1. Executive Summary

- **100-task 是否完整完成**：✅ 是（100/100 终态）
- **最终判定**：**B — Engineering Ready**
- Business Success：11.0%（目标 ≥70%）
- Real Escalation：64.0%（目标 ≤30%）
- VERIFY_FAILED：58.0%（目标 <20%）
- ELEMENT_NOT_FOUND：8.0%（目标 ≈0%）
- Business Recovery：2.4%（目标 ≥60%）
- **VIL 实际 Business Recovery（因果审计，非口径）**：0 / 0 个 VIL 恢复事件最终业务成功

## 2. Data Integrity Audit (§五)

- benchmark perTask 任务数：100
- 运行窗口内 aiTasks(P9*)：121（桥接 ✅ 一致）
- 本次运行捕获唯一事件总数：13457；VIL 事件：1686
- 捕获切片唯一事件：13457
- 悬挂/RUNNING 任务：0
- JSON 与 store 桥接一致性：✅

## 3. Core Metrics (§六)

| 指标 | 值 |
| --- | --- |
| Planner Success Rate | 96.0% |
| Execution Success Rate | 52.8% |
| **Business Success** | **11.0%** |
| Human Escalation (Credible/Real) | 79.0% (Cred 15.0% / Real 64.0%) |
| VERIFY_FAILED | 58.0% |
| ELEMENT_NOT_FOUND | 8.0% |
| Repair Attempt Success | 67.3% |
| Business Recovery (After Repair) | 2.4% |
| VIL Recovery (events) | 0 |
| Average Cost | $0.0012 / 任务（共 207255 tokens）|
| Average Duration | 45.6 s / 任务 |
| Agent Score (overall) | 62 |

## 4. VIL Causal Audit (§七)

> 严格区分：classified ≠ decision_changed ≠ recovered ≠ business_recovered

| 维度 | 计数 | 说明 |
| --- | --- | --- |
| VIL classified | 491 | 每次 verify 失败触发一次分类+决策 |
| VIL decision_changed | 491 | 决策 ≠ HUMAN_ESCALATE（VIL 改变了默认行为）|
| VIL WAIT | 1195 | 观察窗口迭代次数（每次=一次等待）|
| VIL RECHECK | 1195 | 观察窗口迭代次数（每次=一次重新观察）|
| VIL RETRY_VERIFY | 0 | 决策=RETRY_VERIFY |
| VIL RE_EXECUTE | 90 | 决策=RE_EXECUTE（唯一重执行路径）|
| VIL recovered | 0 | ai.verification.recovered 事件数 |
| **VIL business_recovered** | **0** | 上述恢复事件对应任务终态 SUCCESS |

**决策分布**：{"RE_EXECUTE":90,"RECHECK_OBSERVATION":401}

**回答 §七："Phase 10.7–10.8 的 VIL 在真实 100 任务中到底救回了多少业务？"**

→ VIL 共恢复 0 次（observation-window 路径），其中 0 次对应任务最终业务成功（Business Success）。
→ 注意：Business Success 从 Phase 9 的 9% 到本运行的 11.0%，其增量不可由 VIL 恢复事件解释，但仍受 planner/验证/其它失败主导；按约束不将整体 BS 提升归因于 VIL（除非 recovered 事件与 BS 增量严格对应）。

## 5. Verification Taxonomy (§八)

| 类别 | 数量 | 比例 | WAIT | RECHECK | RETRY_VERIFY | RE_EXECUTE | Recovery | Business Recovery | Escalation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| STATE_UNKNOWN | 401 | 81.7% | 1195 | 1195 | 0 | 0 | 0 | 0 | 73 |
| DOM_CHANGED | 90 | 18.3% | 303 | 303 | 0 | 90 | 0 | 0 | 30 |

> 特别检查（Phase 10.7–10.8 已证明的 EVENTUAL_CONSISTENCY / OBSERVATION_DELAY 在真实 100 任务中是否出现）：
> EVENTUAL_CONSISTENCY 触发：0 次；OBSERVATION_DELAY 触发：0 次。⚠️ Fixture-level capability exists, but real-world workload did not exercise it (no EVENTUAL_CONSISTENCY / OBSERVATION_DELAY classifications appeared).
> 观察窗口实际执行情况：VIL 观察窗口共产生 1195 次 WAIT/RECHECK 迭代（窗口机制在真实负载中被大量调用），但 ai.verification.recovered 事件数 = 0 —— 即重新观察+重新验证后，没有任何任务最终恢复为业务成功。结论：VIL 时序恢复能力（fixture 级已验证）在真实 100 任务中**被调用但未产生业务恢复**。失败主因为真实 VERIFY_FAILED（非时序/一致性可恢复）。

> 注：上表为 VIL 6 类失败分类（决策时刻的 VIL 分类）；最终任务归档 taxonomy 另计：{"VERIFY_FAILED":58,"OTHER":8,"POLICY_BLOCK":15,"(none)":11,"ELEMENT_NOT_FOUND":8}。两者为不同命名空间（VIL 决策分类 ≠ 最终任务归档分类），不应混用。

## 6. Repair Analysis (§九)

- Repair Attempt Success：67.3%（Phase 9：66.7%）
- Business Recovery After Repair：2.4%（Phase 9：0%）
- 按策略拆分：

| 策略 | 总数 | 成功 | 成功率 |
| --- | --- | --- | --- |
| VERIFY_RETRY | 352 | 236 | 67.0% |

> Phase 9：Repair Attempt Success 66.7% / Business Recovery 0%。本运行：Attempt 67.3% / Business Recovery 2.4%。✅ 已改变（业务级恢复 > 0）。

## 7. Resolver Analysis (§十)

- ELEMENT_NOT_FOUND：8 任务（Phase 9：7 任务）。占比 8.0%。
- matchedBy 持久化：matchedBy instrumentation gap（快照/repair 未记录 matchedBy）。

## 8. Scenario Matrix (§十一)

| 场景 | 任务数 | 成功 | Business Success | Exec Success | Real Esc | Cred Esc | VERIFY_FAILED | ELEMENT_NOT_FOUND | Bus Recovery |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SaaS | 30 | 3 | 10.0% | 61.1% | 15 | 11 | 15 | 0 | 0.0% |
| E-commerce | 25 | 1 | 4.0% | 52.2% | 21 | 0 | 18 | 3 | 0.0% |
| Data Entry | 20 | 5 | 25.0% | 48.0% | 12 | 0 | 10 | 2 | 0.0% |
| Long Workflow | 25 | 2 | 8.0% | 49.1% | 16 | 4 | 15 | 3 | 8.0% |

## 9. Phase Comparison (§十二)

| 指标 | Phase 9 | Phase 10 (incomplete) | Phase 10.7–10.8 | Phase 10.9 (本运行) |
| --- | --- | --- | --- | --- |
| Business Success | 9% | 12.5% | B(未跑全量) | 11.0% |
| VERIFY_FAILED | 65% | 未 instrument 细分 | B(未跑全量) | 58.0% |
| ELEMENT_NOT_FOUND | 7% | 7% | B(未跑全量) | 8.0% |
| Repair Bus Recovery | 0% | 0% | B(未跑全量) | 2.4% |
| VIL Bus Recovery | 0 | 0 | 0(未跑全量) | 0 |
| Real Escalation | 72% | ~72% | B(未跑全量) | 64.0% |

> 说明：Phase 10 (incomplete) 为 88/100 中断运行，不冒充完整 benchmark。Phase 10.7–10.8 仅通过真实浏览器集成测试（停止门），未跑全量 100 任务。

## 10. AgentScore

```json
{
  "planning": 96,
  "execution": 59,
  "recovery": 22,
  "verification": 100,
  "autonomy": 21,
  "overall": 62,
  "sampleSize": 100
}
```

## 11. Release Decision (§十三)

| 门槛 | 要求 | 实际 | 通过 |
| --- | --- | --- | --- |
| Business Success | ≥70% | 11.0% | ❌ |
| Real Escalation | ≤30% | 64.0% | ❌ |
| VERIFY_FAILED | <20% | 58.0% | ❌ |
| ELEMENT_NOT_FOUND | ≈0% | 8.0% | ❌ |
| Business Recovery | ≥60% | 2.4% | ❌ |

**最终判定：B — Engineering Ready**

⚠️ 核心架构与控制流稳定（VIL 真实触发 491 次、恢复 0 次），但产品级指标未达 A。阻塞原因：
- Business Success 11.0% < 70%
- Real Escalation 64.0% > 30%
- VERIFY_FAILED 58.0% ≥ 20%
- ELEMENT_NOT_FOUND 8.0% > 0%
- Business Recovery 2.4% < 60%

> 按约束：不实施修复、不自动重跑、不自动进入 Phase 11。

---
数据来源：benchmark JSON + server/data/{aiEvents,aiTasks,aiRepairAttempts,aiFailureSnapshots}.json（运行期捕获切片合并）。
本分析为只读，未修改任何冻结代码/统计口径/成功定义。