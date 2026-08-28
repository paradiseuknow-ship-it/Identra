# PHASE 10 Real-World Result Report (v0.2.1 Verification Intelligence Layer)

> **只读验收报告**。本报告的每一项数字均直接来自 benchmark 原始结果、store 数据（`server/data/`）、trace、attempt、repair 数据。
> 未修改任何代码，未重跑 Benchmark，未调整 success 定义或统计口径，未删除任何失败样本。
> 生成时间：2026-08-26。

---

## 0. 重要前置结论（先读）

本次 Phase 10 全量 Benchmark **并未真正完成**，且多项决策级遥测缺失。因此：

1. **运行不完整**：Phase 10 全量运行在 `rw.075` 附近被终止，实际只创建/执行 **88 / 100** 个任务（1 个仍 `RUNNING`），`Long Workflow` 场景（rw.076+）**整类未执行**。未写出全量结果 JSON（`.benchmark/phase10_<runId>.json` 不存在，仅有 3-task smoke 文件）。
2. **VIL 决策级遥测缺失**：`aiEvents` 仅覆盖 10/88 个 Phase 10 任务，且事件流中**不存在** `ai.verification.recovered`、WAIT/RECHECK 决策类事件。VIL 的 WAIT/RECHECK/RETRY_VERIFY 是否真正改变控制流，**无法从 store 追溯**。
3. **分类退化**：6 类 VIL taxonomy 中只触发了 `STATE_UNKNOWN` + `DOM_CHANGED` 两类；`EVENTUAL_CONSISTENCY` / `OBSERVATION_DELAY` / `VERIFICATION_TOO_STRICT` / `ACTION_REAL_FAILURE` 全部为 **0**。即 VIL「异步时序恢复」这一核心能力**从未被触发**。
4. **指标回归**：Execution Action Success 62.5% → 37.4%；Repair Attempt Success 66.7% → 5.4%；Business Recovery 维持 **0%**。

**最终判定：C — Not Ready（见第 10 章）**。且必须明确声明：**Business Success 的微弱提升（9% → 12.5%）不能归因于 VIL。**

---

## 1. Data Integrity Audit（数据完整性审计）

### 数据来源核对

| 数据源 | 状态 | 说明 |
|---|---|---|
| `.benchmark/phase10_<runId>.json`（全量） | **缺失** | 运行被终止，未在末尾写出结果 JSON |
| `.benchmark/phase10_1787741194292.json`（smoke） | 存在 | 仅 3 个 SaaS 任务，端口 12488 |
| `server/data/aiTasks.json` | 存在 | 全量 337 个任务（跨多次运行混合） |
| `server/data/aiSteps.json` | 存在 | 1579 步 |
| `server/data/aiAttempts.json` | 存在 | 3339 次 attempt |
| `server/data/aiRepairAttempts.json` | 存在 | repair 记录 |
| `server/data/aiFailureSnapshots.json` | 存在 | 失败快照 |
| `server/data/aiEvents.json` | 存在 | 仅 500 条事件，覆盖 10/88 个 Phase 10 任务 |

### 隔离方式
- **Phase 10 全量运行** = store 中 `targetUrl` 端口 **10695** 的任务（共 **88** 个；命名 `P9 SaaS登录1` / profile `p9_rw_001`，即同一批 Phase 9 任务在 v0.2.1 代码下重跑）。
- **Phase 9 基线** = 端口 **6693** 的 100 个任务（已锁定基线 `phase9_analysis.json`）。
- attempt 通过 `stepId → taskId → 端口` 映射归属（attempt 本身无 `taskId` 字段，这是分析脚本早期解析失败的根因，已修正）。

### 数量核对（Phase 10 / Phase 9）

| 维度 | Phase 10 | Phase 9 |
|---|---|---|
| Task 数 | 88（含 1 RUNNING） | 100 |
| Step 数 | 470 | 579 |
| Attempt 数 | 531 | 1450 |
| Repair 数 | 186 | 216 |
| FailureSnapshot | 77 | — |
| Event 覆盖 | 10/88 | — |

### status 一致性
- Phase 10 store status：`HUMAN_ESCALATION 77 / SUCCESS 11 / RUNNING 1`；与每任务 `lastDiagnosis` / `error` 一致，无矛盾。
- Phase 9 store status 与锁定基线 `phase9_analysis.json` 完全吻合（STATUS 不一致 = 0）。

### 统计污染检查
- store 累积了 337 个任务、20+ 端口的多轮运行数据（Phase 7/9/smoke/Phase 10 等）。本报告已按端口隔离，但存在以下**不可追溯污染风险**：
  - `escalationKind` 在 Phase 10 任务上**未持久化**（0/88）→ Real/Credible 拆分缺失。
  - `matchedBy`（Resolver 命中方式）在 store 中**完全不存在**（grep `matchedBy` = 0）→ Resolver 分布不可追溯。
  - VIL 决策事件未持久化（见 §0）。

**结论**：数据可用于「部分」验收，但**不足以支撑 100-task 产品级判定**，且多项决策级字段缺失。

---

## 2. Phase 9 vs Phase 10 对比

> 固定比较。Phase 9 = 锁定基线（100 task）；Phase 10 = 88 task 部分样本（非 100）。

| 指标 | Phase 9 | Phase 10 | 变化 | 说明 |
|---|---|---|---|---|
| Planner Success Rate | 99% | ~99% | ≈0 | planner 未改动，基本持平 |
| Execution Success Rate | 62.5% | **37.4%** | **▼ -25.1pt** | action 成功率明显**回退** |
| Business Success | 9% | **12.5%** | ▲ +3.4pt | 微弱提升，**不可归因于 VIL**（见 §3/§6） |
| Human Escalation | 90% | 86.5% | ▼ -3.5pt | 仍极高 |
| └ Real | 72 | *(缺失)* | — | Phase 10 `escalationKind` 未持久化 |
| └ Credible | 18 | *(缺失)* | — | 同上 |
| VERIFY_FAILED | 65% | **68.5%** | ▲ +3.5pt | 略有**恶化** |
| ELEMENT_NOT_FOUND | 7% | **6.6%（任务率）** | ≈0 | resolver 未达 ≈0 |
| Repair Attempt Success | 66.7% | **5.4%** | **▼ -61.3pt** | 严重**回退** |
| Business Recovery After Repair | 0% | **0%** | 0 | 仍为零 |
| Average Cost | ~0.0008 USD/task | *(token 字段缺失)* | — | store attempt 无 token 字段，仅能以时长近似 |
| Average Duration | 36–47s（场景均值） | **27.0s** | ▼ -10~20s | 变快主要因更早放弃（no_repair） |

**解释**：
- 唯一正向变化是 Business Success 9%→12.5%（约 5 个任务从 esc→success 翻转）。但 §3/§6 证明这 5 个任务**未经过 VIL 恢复路径**（VIL recovery=0、wait/recheck=0），属 planner/随机方差，与 VIL 无关。
- Execution 与 Repair 双双明显回退，是真实的能力退化，需根因分析（见 §5、§10）。
- VERIFY_FAILED 不降反升，说明 VIL 没有解决验证失败这一主瓶颈。

---

## 3. Verification Intelligence Layer 实际效果

### VIL 分类分布（来自 attempt.error.failureType，共 236 条）

| 类别 | 数量 | 占比 | 恢复率 | 最终升级率 |
|---|---|---|---|---|
| EVENTUAL_CONSISTENCY | **0** | 0% | — | — |
| OBSERVATION_DELAY | **0** | 0% | — | — |
| VERIFICATION_TOO_STRICT | **0** | 0% | — | — |
| ACTION_REAL_FAILURE | **0** | 0% | — | — |
| STATE_UNKNOWN | 187 | 79.2% | ~0% | ~100% |
| DOM_CHANGED | 49 | 20.8% | ~0% | ~100% |

### 回答问题

**1. Phase 9 的 VERIFY_FAILED 65% 是否被拆解？**
被「拆」了，但只是**改名**：Phase 9 的 `VERIFY_FAILED(65)` 在 Phase 10 变成了 `STATE_UNKNOWN(187次/67%任务) + DOM_CHANGED(49次/约20%任务)`。这是**分类标签变化，不是能力变化**——失败总量未减（68.5% vs 65%）。

**2. 其中多少属于「原本可自动恢复」vs「真正业务失败」？**
- `EVENTUAL_CONSISTENCY` / `OBSERVATION_DELAY`（理论可自动恢复的时序类）= **0**。
- `VERIFICATION_TOO_STRICT`（可放宽验证）= **0**。
- 实际触发的两类 `STATE_UNKNOWN` / `DOM_CHANGED` 在静态 mock 场景下**绝大多数属于真业务失败或动态 DOM 误判**，无法靠 wait+recheck 自愈。

**3. WAIT + REOBSERVE 是否有效？**
**无法判定有效，因为从未执行。** repair 工具分布中 `wait_stable = 0`、`recheck_observation = 0`。VIL 的时序恢复路径在真实运行里一条都没跑。

**4. RE_EXECUTE 是否减少误用？**
RE_EXECUTE 也未作为 VIL 决策出现（proxy 计数为 0）。取而代之的是 `no_repair`（171 次）与 `semantic_relocate`（27 次）。即 verifyFailed 策略**倾向于放弃/重定位**，而非重新执行动作——这与 Phase 9 的 `VERIFY_RETRY`(204) 相比是行为回退。

---

## 4. Observation 改造效果

`beforeObservation` / `afterObservation` 字段已持久化（port 10695 共 224 条 observationBefore/After）。

| 改善目标 | 改善前（Phase 9） | 改善后（Phase 10） |
|---|---|---|
| 异步渲染误判 | 单点快照，无法对比 | 有 before/after 快照，但 `EVENTUAL_CONSISTENCY`/`OBSERVATION_DELAY`=0 → **未触发** |
| stale cache | observationCache 返回 hash 命中旧值 | 新增 `networkState`/`domFingerprint`，但 STATE_UNKNOWN 仍占 79% → **未解决** |
| 动态 DOM 误判 | 无结构对比 | `DOM_CHANGED` 可识别（49 次），但路由到 `semantic_relocate` 后恢复率≈0 |

**结论**：Observation 字段**已落地并持久化**，但因为没有配套的「wait 后重观察」执行路径（§3 中 wait/recheck=0），其数据**没有被转化为恢复动作**。即「采集到了，但没用上」。

---

## 5. Repair 体系重新评估

> 不采用旧 repair success 定义。同时输出 A / B 并解释差异。

- **A. Repair Attempt Success** = 10 / 186 = **5.4%**（Phase 9 = 66.7%）。
- **B. Business Recovery After Repair** = 0 / 88 = **0%**（与 Phase 9 持平）。

**差异解释**：Phase 9 的「Repair Attempt Success 66.7%」统计的是「repair 步骤本身跑通（重新执行了动作）」，并不等于业务恢复。Phase 10 把「repair 步骤」几乎全变成 `no_repair`（171/186），所以「attempt success」骤降到 5.4%；而两端「业务恢复」都=0，说明**无论旧定义还是新定义，repair 都没有真正把任务救活**。

### 各策略调用 / 成功

| 策略（repair action tool） | 调用次数 | 成功次数 | 成功率 |
|---|---|---|---|
| `no_repair` | 171 | 0 | 0% |
| `semantic_relocate:*` | 27 | (含于 10) | — |
| `fill` | 21 | (含于 10) | — |
| `verify` | 12 | — | — |
| `reload` | 3 | — | — |
| `wait_stable` | **0** | 0 | — |
| `recheck_observation` | **0** | 0 | — |

**结论**：`WAIT_STABLE` / `RECHECK_OBSERVATION` / `RETRY_VERIFY` 三个 VIL 设计的恢复策略**调用次数为 0**；`SEMANTIC_RELOCATE` 有 27 次但恢复率≈0。verifyFailed 策略在 Phase 10 实际退化成了「多数情况直接 no_repair 放弃」。

---

## 6. Resolver 泛化效果

| 指标 | Phase 9 | Phase 10 |
|---|---|---|
| ELEMENT_NOT_FOUND（任务率） | 7% | **6.6%**（6/91 任务；38 次 attempt） |

**matchedBy 分布（不可追溯）**：
- `id / name / aria / placeholder / label / class / semantic` 分布 —— **无法从 store 统计**。`matchedBy` 字段在 `semanticResolver` 中计算但**未持久化**（grep `matchedBy` = 0）。
- 这是 instrumentation gap，**不得补造**。

**判断**：Resolver **未达到 ELEMENT_NOT_FOUND ≈ 0**。6.6% 与 Phase 9 的 7% 基本持平，说明 Phase 10 的多信号 `matchedBy` 泛化**没有在真实运行中体现收益**（且无法验证其分布，因为未落库）。

---

## 7. Scenario Matrix

| 场景 | 任务数 | 成功数 | Business Success | Real Escalation |
|---|---|---|---|---|
| SaaS | 35 | 2 | 5.7% | 32 |
| E-commerce | 30 | 6 | 20.0% | 24 |
| Data Entry | 15 | 3 | 20.0% | 12 |
| Long Workflow | **0** | 0 | — | — |

**关键缺口**：`Long Workflow` 场景 **0 个任务**——因运行在 rw.076 前被终止，该场景整类缺失。Phase 9 中 Long Workflow 成功率为 0%、是 VERIFY_FAILED 重灾区；Phase 10 反而没有覆盖它，使得对比**存在场景偏倚**（Phase 10 样本偏向 SaaS/电商/表单，避开了最难的 Long Workflow）。

---

## 8. Failure Taxonomy（真实失败排名 TOP 10）

| 排名 | Failure Type | 数量 | 比例 | 可否自动恢复 | 下一阶段建议 |
|---|---|---|---|---|---|
| 1 | FT:STATE_UNKNOWN | 187 | 79%* | 否（静态场景） | 增强状态探测/重验证，而非放弃 |
| 2 | VERIFICATION_FAILED | 61 | 68.5%* | 部分 | 同上 |
| 3 | FT:DOM_CHANGED | 49 | 20.8%* | 部分（relocate） | 提升 relocate 后复验成功率 |
| 4 | CREDENTIAL_MISSING | 16 | — | 否（需凭据） | 凭据库补齐 |
| 5 | ELEMENT_NOT_FOUND | 1(task) | 6.6% | 部分 | resolver 落库 + 多信号 |
| 6 | FT:EVENTUAL_CONSISTENCY | 0 | 0% | 理论可 | 需异步 fixture 才能验证 |
| 7 | FT:OBSERVATION_DELAY | 0 | 0% | 理论可 | 同上 |
| 8 | FT:VERIFICATION_TOO_STRICT | 0 | 0% | 理论可 | 需放宽验证场景 |
| 9 | FT:ACTION_REAL_FAILURE | 0 | 0% | 否 | — |
| 10 | FT:OTHER | — | — | — | — |

\* 比例为 attempt 级；任务级 STATE_UNKNOWN 占 67% 任务。

**核心结论**：Phase 10 的失败结构**与 Phase 9 高度同源**——验证失败仍占绝对主导，且没有出现任何「可自动恢复的时序类」失败，说明 VIL 设计的黄金场景（异步一致性）在**静态 mock 基准上根本无法被触发**。

---

## 9. Agent Capability Score（重新评分）

| 能力 | Phase 9 | Phase 10 | 变化 |
|---|---|---|---|
| Planning | 90 | 95 | ▲ |
| Execution | 65 | **45** | ▼（62.5%→37.4%） |
| Observation | 70 | 55 | ▼（采到但未用） |
| Verification | 72 | **40** | ▼（VERIFY_FAILED 68.5%，VIL 未触发） |
| Recovery | 50 | **20** | ▼（repair 5.4%、恢复 0%） |
| Resolver | 60 | 50 | ▼（ELEMENT_NOT_FOUND 未达 ≈0，且不可追溯） |
| Safety Policy | 90 | 90 | ≈ |
| Observability | 80 | **30** | ▼（escalationKind/matchedBy/VIL 决策事件缺失） |
| **Overall** | **67** | **53** | **▼ -14** |

---

## 10. v0.2.1 Release Decision

### 固定指标汇总

| 指标 | 实测 | A 门槛 | 达标？ |
|---|---|---|---|
| Business Success | 12.5% | ≥70% | ❌ |
| Real Escalation | *(未持久化，约 77)* | ≤30% | ❌ |
| VERIFY_FAILED | 68.5% | <20% | ❌ |
| ELEMENT_NOT_FOUND | 6.6% | ≈0% | ❌ |
| Business Recovery（合计） | 0% | ≥60% | ❌ |
| VIL Business Recovery | 0% | — | ❌ |
| Repair Business Recovery | 0% | — | ❌ |
| Average Cost | 不可比（缺 token） | — | — |
| Average Duration | 27.0s | — | — |

### 等级判定

**A — Product Candidate：❌ 未达成**（全部硬性门槛均未达标）。

**B — Engineering Ready：❌ 不适用**（B 要求「架构稳定但产品指标不足」；但本次不仅有指标问题，还出现 Execution / Repair 的**能力回退**与 VIL 决策路径**零触发**，属于链路功能缺陷，非单纯指标不足）。

**C — Not Ready：✅ 判定为 C。**

理由（结构问题）：
1. **运行不完整**：88/100，Long Workflow 缺失，结果 JSON 未产出。
2. **VIL 核心能力未验证**：时序恢复类（EVENTUAL_CONSISTENCY / OBSERVATION_DELAY / VERIFICATION_TOO_STRICT）触发 0 次，WAIT/RECHECK 执行 0 次 → VIL 的「Verification Intelligence」在真实运行中**未形成闭环**。
3. **能力回退**：Execution 62.5%→37.4%，Repair 66.7%→5.4%，且 recovery 维持 0%。
4. **遥测缺口致无法归因**：`escalationKind`、`matchedBy`、VIL 决策事件均未持久化，无法证明任何提升来自 VIL。

### 必须明确声明的两点（依验收约束）

> **「指标提升不能归因于 VIL。」**
> Business Success 9%→12.5% 的微弱提升（约 5 个 esc→success 翻转）中，`recoveredViaVIL = 0`、`wait_stable = 0`、`recheck_observation = 0`。即这 5 个任务在 Phase 10 中**从未经过 VIL 恢复路径**（其成功 attempt 不带 failureType）。因此该提升来自 planner/随机方差，**不能归因于 VIL**。

> **「VIL 已改变控制流，但尚未形成有效产品能力。」——不适用。**
> 事实更强：VIL **既未改变控制流（wait/recheck=0），也未形成产品能力（recovery=0）**。VIL 只完成了「分类标注」（236 条 failureType），其设计中的决策→恢复回路没有被执行。

---

## 11. 是否进入 v0.3（仅方向，不执行、不改代码、不重跑）

**结论：暂缓进入 v0.3 功能开发。先修复 v0.2.1 的结构缺陷与遥测缺口，否则 v0.3 无法被有效验收。**

下一阶段方向（仅列出，待确认后执行）：
1. **修复 verifyFailed 策略回退**：当前 `STATE_UNKNOWN`（最大类）路由到 `no_repair` 放弃，应改为「重执行动作 + 重验证」优先，仅真不可恢复再升级。
2. **打通 VIL 决策执行**：让 `WAIT + REOBSERVE + RETRY_VERIFY` 在 runtime 内真实执行并可被事件记录（当前计数为 0，需排查为何未触发）。
3. **构建可触发时序恢复的 fixture**：当前 mock 为静态站点，VIL 的异步一致性能力无法被验证；需增加带延迟渲染/轮询状态的页面。
4. **补齐遥测**：持久化 `escalationKind`、`matchedBy`、VIL 决策事件（WAIT/RECHECK/RE_EXECUTE/RECOVERED），否则下一轮验收仍无法做决策级归因。
5. **完成 100-task 全量运行**：补齐 Long Workflow 场景，产出标准结果 JSON 后再做产品判定。

---

*报告生成方式：仅读取 `server/data/*`、`server/scripts/phase10Benchmark.js`、`.benchmark/phase9_analysis.json`、`.benchmark/phase10_1787741194292.json`。分析脚本：`.benchmark/phase10_analysis_final.json`（由 `server/scripts/analyze_phase10_final.js` 生成，只读）。未修改任何代码、未重跑 Benchmark。*
