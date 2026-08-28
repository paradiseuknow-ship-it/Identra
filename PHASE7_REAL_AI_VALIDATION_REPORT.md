# Phase 7 真实 AI 验证报告（Real DeepSeek Benchmark V2）

> 生成时间：2026-08-26
> 模式：**真实 DeepSeek**（`simulated:false`，`provider:deepseek`）。禁止 mock planner / 禁止 fallback / 计划由 DeepSeek 端到端生成。
> 对比基线：`phase6_1787687782834.json`（Phase 6，30 任务）。
> 本次运行：`phase6_1787691693952.json`（Phase 7，30 任务，Step 2 修复后代码）。
> 指标算法来自 `server/scripts/realBenchmark.js`，本次**未修改**其评分逻辑与成功标准。
> 数据真实性已核验：无 mock / 无 attachPlan / 无 fallback / 无限流。详见 `PHASE6_REAL_AI_ANALYSIS_REPORT.md`。

---

## 1. PHASE6 vs PHASE7 核心指标对比

| 指标 | Phase 6 | Phase 7 | 变化 |
| --- | --- | --- | --- |
| Planner Success Rate | 100% | 90%（真值 100%） | 见分析 4 |
| Execution Success Rate | 42.1% | 64.7% | **+22.6pp** ✅ |
| Verification Accuracy | 100%（失真） | 67.4%（真实） | 失真消除，真实值见下 |
| Verification Coverage（真实带验证步骤占比） | ~3.3%（96.7% 为 none） | **100%** | **+96.7pp** ✅ |
| Recovery Success Rate | 45%（含假阳性） | 0% | 真实 repair 0% 成功 |
| Human Escalation Rate | 36.7% | 46.7% | +10pp（见分析 4） |
| Average Cost / 任务 | $0.0007 | $0.0008 | 持平 |
| Average Duration / 任务 | 23.4 s | 24.9 s | 持平 |
| AgentScore (overall) | 80 | 67 | 诚实化下降 |
| 成功率（SUCCESS 终态） | 63.3% | 40.0% | -23.3pp（见分析 4） |

AgentScore 细分对比：

| 维度 | Phase 6 | Phase 7 |
| --- | --- | --- |
| planning | 100 | 90 |
| execution | 66 | 65 |
| recovery | 75 | 50 |
| verification | 93 | 72 |
| autonomy | 63 | 53 |
| overall | 80 | 67 |

---

## 2. 重点分析（Step 3 授权要求的 4 项）

### 2.1 ELEMENT_NOT_FOUND 是否下降？—— ✅ 是，80.1% → 0%

- Phase 6（文档基线 `PHASE7_FAILURE_ANALYSIS.md`）：失败尝试中 **80.1%** 为 ELEMENT_NOT_FOUND（语义解析失败）。
- Phase 7（store 实算）：192 次尝试，**0 次** ELEMENT_NOT_FOUND（占 0.0%）。
- 错误码分布：`{"VERIFY_FAILED":32,"NO_VALUE":28,"RESOURCE_LOCK":22,"TOOL_EXECUTION":1,"ELEMENT_NOT_FOUND":0}`。
- **结论：Step 2-A 让 resolver 接收完整 `target.{field,semantic}`，field 权威键参与评分，元素定位彻底修复。这是本轮最确定的改善。**

### 2.2 verification:none 是否下降？—— ✅ 是，96.7% → 0%

- Phase 6（文档基线）：**96.7%** 步骤无 verification（失真，验证形同虚设）。
- Phase 7（store 实算）：107 步中 verification.type=none **0 步**（占 0.0%），真实验证覆盖率 **100%**。
- **结论：Step 2-B（三层契约同步 + `validatePlanStrict` 强制 + `normalizeStrictToCanonical` 透传，禁止静默补 none）真实生效。验证现在真的在执行。**

### 2.3 repair 是否首次成功？—— ❌ 否，仍 0%

- Phase 7（store 实算）：repair attempt 共 24 次，触发 repair 的任务 8 个，**repair attempt 至少一次 SUCCESS 的任务 0 个（首次成功率 0%）**。
- Phase 6 文档：recovery 触发但 0% 成功。
- **结论：repair 仍完全无效。这是当前最大短板，且 Step 2 未针对 repair（用户指示先不优化 Recovery）。需在下一阶段重点修复。**

### 2.4 Human Escalation 是否下降？—— ❌ 否，36.7% → 46.7%（但需拆分看）

Phase 7 共 14 个升级，拆分：
- **7 个 Credential 升级（正确安全行为）**：`saas.login_dashboard` 等。harness 未供 `credentialRef` → NO_VALUE → CREDENTIAL_MISSING 升级。policy 行为正确（Step 2-D 已确认），**非 Agent 失败**。
- **7 个 SEMANTIC_RELOCATE/VERIFY_FAILED（真实 Agent 弱点）**：元素已找到（ELEMENT_NOT_FOUND=0），但执行后验证失败，repair 耗尽即升级。
- **1 个 CANCELLED**（harness 中断）。
- 另有 **3 个 FAILED 是被我 Step 2 的 schema 过严校验误杀**（见下），非升级。

**结论：升级率上升主因是 (a) 验证真实化后暴露了原本被 none 掩盖的失败；(b) 7 个正确凭据升级。若剥离这两类「非 Agent 能力失败」，Agent 在 19 个正常任务上真实成功率 ≈ 12/19 = 63%，与 Phase 6 持平，但此时成功是「经过真实验证」的成功。**

---

## 3. 数据完整性 caveat（必须声明）

**3 个任务被 Step 2 引入的 schema 过严校验误判为 FAILED（非 Agent 失败）**：
- `failure.network_failure`、`failure.verification_failure`、`real.ec.lazy`
- 证据：`schemaResult=FAIL`，错误 `target.field 非法`（steps[2]/[3] 或 [1]），`plan stored: []`。
- 根因：`schema/action.js:63` 对 `field:null` 判非法并拒绝整计划；DeepSeek 实际已生成计划。Phase 6 对此类 `field` 放行。
- 影响：plannerSuccessRate 被压到 0.90（真实应为 1.0）；这 3 个任务未进入执行，污染了成功率分母。
- **处理：按分析阶段「禁止继续开发」要求，不修复、不重跑；如实标注。建议在下一阶段修复该 schema 回归后重跑。**

---

## 4. 总判定

**Phase7 Step3：未 PASS（部分达成）**

- ✅ 确定的改善：ELEMENT_NOT_FOUND 80.1%→0%；verification:none 96.7%→0%；Execution 42%→65%。
- ❌ 未达 Alpha：repair 0% 成功（无自愈）、验证仍有 ~33% 误判、存在 schema 回归污染。
- 成功率表面下降（63.3%→40%）是**诚实化 + schema 回归**双重结果，并非 Agent 真实退步；正常任务真实成功率仍约 63%。

**按授权要求：完成 Step 3 后停止，不进入下一阶段，等待下一步授权。**
