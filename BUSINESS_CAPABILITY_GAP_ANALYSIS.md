# Business Capability Gap Analysis — Phase 2 Hardening (Step 1: 只读审计)

> 本文档是 **Step 1** 交付物：纯只读代码审计 → 缺口分析。不修改任何源码。
> Step 2 将基于本文提出「最小 patch 列表」，**待用户确认后**才进入 Step 3 实施。

## 0. 执行约束（本 Phase 全程遵守）

1. 不修改 success definition（业务成功定义不变）
2. 不修改 benchmark 统计口径（100-task / 4-task 计量不变）
3. 不加入 mock / fake success（任何 "成功" 必须来自真实观察证据）
4. 不降低安全策略（敏感动作仍优先升级人工）
5. **不重写整个 verification 架构**（只在现有 `verificationIntelligence.analyze` 上做证据聚合增强）
6. 每个改动必须：说明业务问题 / 定位代码 / 最小 patch / 增加测试 / 跑回归

---

## 1. 当前能力基线（已具备，勿重复造轮）

| 能力 | 位置 | 说明 |
|---|---|---|
| 业务结果契约（非 action_success 判定成功） | `verification.js` + `contract.js` (`businessState` requiredEvidence) | click→page_change/element_absent；submit→FORM_SUBMIT_SUCCESS；值写入校验 `fieldExistsButEmpty` (`verificationIntelligence.js:128-139`) |
| VIL 失败分类 + 决策 | `verificationIntelligence.js:145-262` | 6 类 failureType / 6 类 decision，纯函数可单测 |
| DOM_CHANGED → Fresh Observation + Re-Verify（非 RE_EXECUTE） | `verificationIntelligence.js:197-205` + `runtime.js:225-256` | 已进入内联 Observation Window 真实 re-capture + re-verify |
| Verification Window 异步等待 | `verification/verificationWindow.js:68-130` | `await tryVerify`，时序证据表 `[250,600,1200,2200]`，上限 5200ms |
| submit 孤儿精确分类 | `stepManager.js:83-86` `orphanCodeFor` | submit→`SUBMIT_RESULT_UNKNOWN`，其余→`ORPHAN_ATTEMPT`（task 终态收口） |
| Credential 不可用 → 人工 | `runtime.js:175-181` | `CREDENTIAL_UNAVAILABLE` 早于 VIL 直送 escalate |
| Observation 血缘 lineage | `observation.js:274-300` | `source / parentObservationId / actionFinishedAt / fresh / previousObservationDiff` |
| Trace 10 节点 attempt | `server/scripts/trace_single_task.js:78-139` | beforeObs / action / result / afterObs / verify / repair / outcome |

**结论**：核心闭环骨架已存在。Phase 2 的目标不是重建，而是**补强证据链与差异化处理**，使其能稳定区分「动作完成」与「业务成功」。

---

## 2. 缺口分析（按 P0-1 A/B/C/D）

### A. Action → Observation → Verification → Business Outcome
**业务问题**：系统能判断「动作执行了」，但难以稳定判断「业务真的成功了」。尤其：
- (A1) click 成功但业务态未确认（toast/redirect/异步加载无专用证据通道）
- (A2) **submit 结果落点不确定**：点击提交后只 `waitForTimeout(400)` 再抓一次快照（`tools.js:494-510`），无网络空闲等待、无 URL 变化轮询、无 backend state 轮询
- (A3) 无 backend state 变化证据（合约只查 DOM/URL/文本）
- (A4) STATE_UNKNOWN 不区分「证据不足」与「业务确未成功」

| 缺口 | 代码位置 | 现状 | 最小 patch 方向（不实施） |
|---|---|---|---|
| A2 submit 落点 | `tools.js:508-509` | 固定 400ms + 单次 after-obs | submit 分支：点击后进入「结果落点窗口」——等待 `networkIdle` 或 `url` 变化或预期态出现，上限 ~5s；窗口后仍不确定才允许 VIL 判 `SUBMIT_RESULT_UNKNOWN`（而非仅 task 终态孤儿） |
| A1/A4 证据通道 | `observation.js:282,294-298` | `previousObservationDiff` 仅 `{urlChanged,textChanged,domChanged}` 三布尔 | 扩展 diff：增加 `keyTextChanged / elementStateChanged / pageStructureChanged` 细分（仍是布尔/轻量，不改存储契约主结构） |
| A3 backend state | `verificationIntelligence.js:208-210` | 无 | 新增可选 `expectedVerification.backendStateCheck`（由调用方注入，如 DB/API 断言钩子）；默认空，不强制 |

---

### B. Verification Evidence Aggregation（**不重写 verification**）
**业务问题**：VIL `analyze` 是**单信号优先级 if-else 链**（`verificationIntelligence.js:158-261`），每个分支只依据单一/少量信号，无「多证据聚合 → Evidence Score → Decision」。

**目标形态（用户指定）**：
```
DOM_CHANGED + URL变化 + 关键文本变化 + 元素状态变化 + 页面结构变化 + 等待窗口
   ↓
Evidence Score
   ↓
Verification Decision
```

| 缺口 | 代码位置 | 现状 | 最小 patch 方向（不实施） |
|---|---|---|---|
| B1 无 Evidence Score | `verificationIntelligence.js:160-261` | `confidence` 是写死常量（0.5~0.9） | **新增纯函数 `aggregateEvidence(before, after, waitWindow)`**：接收 before/after 观察 + 等待窗口结果，输出结构化 `{ signals:{urlChanged,keyTextChanged,elementStateChanged,pageStructureChanged,domChanged,networkIdle,waitElapsed}, score, weight }`；`analyze` 在返回前调用它，把 `evidence` + 计算出的 `score` 一并返回（**不改 failureType/decision 枚举**） |
| B2 等待窗口未进证据 | `verification/verificationWindow.js:97-106` | 窗口只返回 `stateChanged`（domFingerprint 比较） | 窗口返回时附带「等待期间观察到的信号增量」供 B1 聚合（如 URL 是否变化、关键文本是否出现） |
| B3 diff 粒度粗 | `observation.js:297` | `domChanged` 仅 domFingerprint 哈希 | 配合 A1 扩展 diff 细分字段，供 B1 量化「变化类别」 |

> 红线：B 类 patch **只增强证据聚合**，最终 decision 仍由现有 if-else + `isReobservableDecision` 决定；不替换 `verification.js` 的权威判定，不降低验证标准。

---

### C. Repair 能力增强（按失败类型差异化）
**业务问题**：`verifyFailed.execute` 对部分 failureType 无专用分支，与 VIL 产出的类型不对齐。

| 缺口 | 代码位置 | 现状 | 最小 patch 方向（不实施） |
|---|---|---|---|
| C1 SUBMIT_RESULT_UNKNOWN 无策略 | `verifyFailed.js:154-158` | 落入通用 `recheckAndVerify`，不会 "query result state" | 新增分支：消费 submit 结果落点窗口产物——若窗口捕获到预期业务态→成功；若 URL/文本指示错误页→`RE_EXECUTE`；若仍不确定→`HUMAN_ESCALATE` |
| C2 ASYNC_PENDING 类型缺失 | `verificationIntelligence.js:24-31` | VIL 枚举无 `ASYNC_PENDING`，被 `EVENTUAL_CONSISTENCY` 粗略覆盖 | VIL 在 `networkState=pending` 时仍可细分：若等待窗口后仍未稳定→产出 `ASYNC_PENDING`；`verifyFailed` 对应分支 = 加长 `wait + observe`（复用 `verificationWindow` 更长时序） |
| C3 STATE_UNKNOWN 无专用 refresh | `verifyFailed.js:156-158` | 与 EVENTUAL_CONSISTENCY 共用 `recheckAndVerify` | 可保留复用，但补 `reason: 'STATE_UNKNOWN→refresh observation'` 文本（供 D 类 trace 展示），**不改变行为** |
| C4 taxonomy 不对齐 | `recovery/errorClassifier.js:9-15` | RECOVERY_CATEGORIES 仅 `NETWORK_ERROR/VERIFICATION_FAILED/PAGE_NOT_READY/CREDENTIAL_MISSING`，缺 `SUBMIT_RESULT_UNKNOWN/ASYNC_PENDING/STATE_UNKNOWN/DOM_CHANGED/EVENTUAL_CONSISTENCY` | 在 classifier 增加映射（纯字典扩充，不改判定逻辑），使 repair 层能识别 VIL 全量类型 |

> 红线：C 类 patch 不引入 silent-pass；任何 "成功" 必须来自 `verifyWithAlternatives` 真实重验证。

---

### D. Trace 升级
**业务问题**：`trace_single_task.js` 的 10 节点是**单 attempt 平铺**，缺跨观察的证据时间线、血缘图、证据分、修复理由。

| 缺口 | 代码位置 | 现状 | 最小 patch 方向（不实施） |
|---|---|---|---|
| D1 无 evidence timeline | `trace_single_task.js:68-75,104-138` | `obsSummary` 丢弃 `parentObservationId/observationId/fresh/source/diff` | 新增 `buildEvidenceTimeline(attempts)`：跨 attempt 合并 URL 变化序列 / 文本变化序列 / DOM 变化序列的时间轴 |
| D2 无 observation lineage graph | `observation.js:293` | 有 `parentObservationId` 字段但未构图 | 新增 `buildLineageGraph(observations)`：由 `parentObservationId` 链构建树，标注 `fresh/source`；trace 输出 Mermaid/缩进树 |
| D3 无 verification evidence score | — | VIL 只产出 `confidence`（常量） | 在 trace 中调用 B1 的 `aggregateEvidence` 输出 `evidenceScore`（与 VIL 返回同源，只读消费） |
| D4 无 repair decision reason | `trace_single_task.js:85-92,135` | repair 段只给 `strategy/status/actions` | 抽取 `verifyFailed` 返回的 `reason`（C3 已补）字段展示为人工可读文本 |

> 红线：D 类仅增强诊断输出，**不改 runtime/verification/resolver 任何逻辑**。

---

## 3. 跨类共性缺口（一处实现，多处受益）

1. **Observation diff 细分**（A1 + B3 + D1 共用）：扩展 `previousObservationDiff` 增加 `keyTextChanged / elementStateChanged / pageStructureChanged`。
   - 位置：`observation.js:294-298`（对比逻辑）+ `observation.js:282`（初始值）。
   - 风险：仅新增布尔字段，向后兼容（旧消费者忽略）。
2. **Evidence 聚合纯函数**（B1 + D3 共用）：`aggregateEvidence()` 被 VIL 与 trace 共同消费。
3. **submit 结果落点窗口**（A2 + C1 共用）：tools.js submit 分支 + verifyFailed SUBMIT_RESULT_UNKNOWN 分支，共享「结果落点判定」产物。

---

## 4. Step 2 候选最小 patch 清单（预览，待确认）

| # | 目标 | 文件 | 最小 patch | 测试点 | 回归 |
|---|---|---|---|---|---|
| P1 | A2/C1 | `tools.js:508-509` + `verifyFailed.js` | submit 点击后「结果落点窗口」（wait networkIdle/url 变化/预期态，上限~5s）；verifyFailed 加 `SUBMIT_RESULT_UNKNOWN` 分支 | submit 后网络空闲→成功 / 错误页→RE_EXECUTE / 不确定→escalate | `test_business_loop_repair.js` 增 Case；`test_resolver_repair.js` 不受影响 |
| P2 | A1/B3 | `observation.js:282,294-298` | diff 增加 `keyTextChanged/elementStateChanged/pageStructureChanged` | diff 细分正确计算 | `test_phase10.js` 增 diff 断言 |
| P3 | B1 | `verificationIntelligence.js` | 新增 `aggregateEvidence(before,after,waitWindow)` 纯函数；`analyze` 返回附带 `evidenceScore` | 多信号→score 正确；failureType/decision 枚举不变 | `test_phase10_vil.js` 增聚合单测 |
| P4 | C2 | `verificationIntelligence.js` + `verifyFailed.js` | VIL 细分 `ASYNC_PENDING`；verifyFailed 加 `wait+observe` 长窗口分支 | 异步未稳定→ASYNC_PENDING→长等待 | 新 `test_async_pending.js` |
| P5 | C4 | `recovery/errorClassifier.js:9-15` | RECOVERY_CATEGORIES 扩充 VIL 全量类型 | classifier 识别新类型 | `test_*.js` 字典单测 |
| P6 | D1-D4 | `server/scripts/trace_single_task.js` | 增 `buildEvidenceTimeline` / `buildLineageGraph` / 输出 `evidenceScore` / `repairReason` | trace 输出含四新维度 | 新 `test_trace_capability.js`（纯函数/静态） |

> 以上仅为候选，未实施。Step 2 将请用户勾选范围后，逐个按 "业务问题→代码位置→最小patch→测试→回归" 实施。

---

## 5. 明确不做（防止 scope creep）

- ❌ 重写 `verification.js` 或 `verificationIntelligence.js` 的整体判定架构
- ❌ 修改 `successMetrics.isBusinessSuccess` 定义或 100-task/4-task 计量口径
- ❌ 引入任何「假设成功」的 fallback（如 timeout 即判成功）
- ❌ 降低敏感动作（purchase/payment/login/submit）的人工升级优先策略
- ❌ 触碰已通过的 Phase10/11/12 回归测试的实际逻辑
