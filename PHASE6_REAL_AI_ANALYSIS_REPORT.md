# Phase 6 / Phase 7 真实 AI 能力分析报告（Real DeepSeek Benchmark）

> **数据来源**：本次分析的报告基于**真实 DeepSeek 全量 30 任务 Benchmark**（后台任务 `LsOxa8` 完成，产物 `phase6_1787691693952.json`）。
> **说明**：本文件同时回应「Phase 6 RESULT ANALYSIS MODE」要求 —— 该模式下等待的后台 Benchmark 即本次真实跑。它运行在 **Phase 7 Step 2 修复后的代码**上，并与 **Phase 6 基线**（`phase6_1787687782834.json`，30 任务）对比。
> **真实性**：`simulated:false`、`provider:deepseek`、无 mock planner、无 attachPlan 绕过、无 fallback provider、无异常成功、无 API 限流（日志已核验）。
> **原则**：本阶段目标不是让结果好看，是得到真实 AI Browser Agent 能力评估。任何失败均保留。

---

## 1. Executive Summary

| 项 | 值 |
| --- | --- |
| 总任务数 | 30（真实 DeepSeek） |
| 成功数量（SUCCESS 终态） | 12 |
| 失败数量（含升级/取消） | 18（HUMAN_ESCALATION 14 / FAILED 3 / CANCELLED 1） |
| Human Escalation | 14（46.7%） |
| Alpha 判定 | **Engineering Prototype（非 Alpha Ready）** |

**核心结论（诚实版）**：
1. **Resolver 已彻底修复**：ELEMENT_NOT_FOUND 从 Phase 6 的 80.1% 降到 **0%**（192 次尝试 0 次）。Step 2-A（target 对象贯穿 + field 参与评分）真实生效。
2. **Verification 已真实化**：verification:none 从 96.7% 降到 **0%**，真实验证覆盖 100%。Step 2-B（三层契约同步 + 禁止静默补 none）生效。
3. **但「真实化」暴露了原本被掩盖的弱点**：验证现在会真失败（VERIFY_FAILED 32 次，占失败码最大头），且 repair 仍 **0% 成功**，这些失败 surfaced 为升级，使原始成功率从 Phase 6 的 63.3% 降到 40%。
4. **存在 1 个 Step 2 引入的测量污染**：3 个任务因我新增的 schema 过严校验拒绝 `field:null` 而被判 FAILED（planner 实际已生成计划）。这是**测量假象，非 Agent 能力失败**，详见 §4 / §7。
5. **7 个 saas 升级是正确安全行为**（harness 未供 credentialRef，policy 正确升级），不算 Agent 失败。

---

## 2. Core Metrics

| Metric | Value (Phase 7) | Value (Phase 6) | 备注 |
| - | - | - | - |
| Planner Success Rate | 0.90（真值 1.0，见 §4） | 1.0 | 3 个被我的 schema 门误杀 |
| Execution Success Rate | 0.6471 | 0.4206 | ↑ +22.6pp（resolver 修复） |
| Verification Accuracy | 0.6735 | 1.0（失真） | Phase 6 的 1.0 是 none/action_success 失真 |
| Verification Coverage（真实带验证步骤占比） | 100% | ~3.3% | Step 2-B 真实生效 |
| Recovery Success Rate | 0.0 | 0.45（含假阳性） | 真实 repair 0% 成功 |
| Human Escalation Rate | 0.4667 | 0.3667 | 多为验证失败/凭据正确升级 |
| Average Duration | 24.9 s / 任务 | 23.4 s | 持平 |
| Average Cost | $0.0008 / 任务（共 44,205 tokens） | $0.0007 / 任务 | 持平 |
| AgentScore (overall) | 67 | 80 | 因诚实化而下降 |
| Success Rate（SUCCESS 终态） | 0.40 | 0.6333 | 见 §4 校正 |

AgentScore 细分 Phase 7：planning=90, execution=65, recovery=50, verification=72, autonomy=53。

---

## 3. Failure Classification

**所有失败均分类（30 任务中 18 个非 SUCCESS）**：

### A. Schema-Gate Rejection（Step 2 回归，非 Agent 失败）— 3 个
- `failure.network_failure`、`failure.verification_failure`、`real.ec.lazy`
- 终态 FAILED，steps=0，plan 为空。DeepSeek **已生成计划**，但 `schema/action.js:63` 校验 `target.field` 非法（DeepSeek 送 `field:null`）而拒绝。Phase 6 接受此类 plan。

### B. Credential Escalation（正确安全行为，harness 限制）— 7 个
- `saas.login_dashboard`、`saas.export_report`、`saas.login_failure`、`failure.login_failure`、`real.saas.login`、`real.saas.export`、`real.saas.wrong`
- 终态 HUMAN_ESCALATION，错误含 `REAUTH_OR_PAUSE`。fill password/email 无 `credentialRef` → NO_VALUE → CREDENTIAL_MISSING。policy 行为正确（Phase 7 Step 2-D 已确认），harness 未供凭据。

### C. Semantic Resolver / Verification Weakness（真实 Agent 弱点）— 7 个
- `ecommerce.search`、`ecommerce.add_to_cart`、`failure.page_not_found`、`real.ec.cart`、`real.admin.create`、`real.admin.admin`、`real.ec.usb`
- 终态 HUMAN_ESCALATION，错误 `修复尝试已达上限(SEMANTIC_RELOCATE)`。元素**已被找到**（ELEMENT_NOT_FOUND=0），但执行后 VERIFY_FAILED，repair 尝试 relocate 耗尽。属验证/修复弱点，非解析失败。

### D. Harness Cancellation — 1 个
- `ecommerce.lazy_recovery`：终态 CANCELLED，错误「用户取消」。benchmark harness 中断，非 Agent 失败。

### E. 说明：无以下类别
- **无 Planner 真实失败**（DeepSeek 全部生成了计划；3 个 FAILED 是 schema 门误杀，见 A）。
- **无 Observation Failure 单独类别**（observation 提供足够信号；ELEMENT_NOT_FOUND=0 证明）。
- **无异常成功**（所有 SUCCESS 均经真实验证）。

---

## 4. Root Cause Analysis

| 失败类 | A. 架构 | B. Observation | C. Planner | D. Browser 执行 | E. Benchmark 设计 |
| --- | --- | --- | --- | --- | --- |
| Schema-Gate（3） | ✅ 我引入的 schema 过严（field:null 拒） | — | — | — | — |
| Credential（7） | — | — | — | — | ✅ harness 未供 credentialRef |
| Resolver/Verify（7） | — | 部分（验证误判） | — | ✅ 执行后状态/验证不稳 | — |
| Cancelled（1） | — | — | — | — | ✅ harness 中断 |

**关键判定**：
- **A 类（schema-gate）是 Step 2 我引入的回归**，不是 Agent 能力问题。DeepSeek 送 `field:..."` 组合时，偶发 `field:null`；Phase 6 的校验对 `undefined` 放行，我新增的 `!isNonEmptyString` 对 `null` 拒。这 3 个任务若不被误杀，会按 Phase 6 行为运行（network/verification 注入会触发恢复并升级，lazy 会搜索）。**结论：Phase 7 真实 Planner 生成能力 = 30/30 = 1.0，原报 0.90 偏低。**
- **C 类（7 个）是真实 Agent 弱点**：resolver 已能定位元素，但 (1) 验证有时误判/状态读取不稳（VERIFY_FAILED 32），(2) RESOURCE_LOCK 22 次（元素锁竞争/并发），(3) repair 0% 成功导致无法自愈。

---

## 5. Agent Capability Score

| 维度 | 评分依据 | Score |
| --- | --- | --- |
| Planning | DeepSeek 为 30/30 生成连贯计划（真值 1.0）；偶发 `field:null` 格式瑕疵 | 90 |
| Observation | ELEMENT_NOT_FOUND=0% 证明观察+解析链路打通；但 RESOURCE_LOCK/VERIFY_FAILED 显示状态读取仍不稳 | 75 |
| Execution | exec success 0.647（↑ from 0.42）；元素定位修复直接拉升 | 65 |
| Recovery | repair 0% 成功（24 次尝试 0 成功）；SEMANTIC_RELOCATE 耗尽即升级 | 50（repair 实际 0） |
| Autonomy | 升级率 46.7%（多为正确凭据升级 + 验证失败）；净自主能力中等 | 53 |
| **Overall** | 综合（agentScore.overall） | **67** |

> 注：Phase 6 的 Overall=80 含失真（verification=none 计 1.0、recovery 含假阳性）。67 是更诚实的估值。

---

## 6. Alpha Product Decision

**判定：Engineering Prototype（工程原型，非 Alpha Ready）**

条件核对：
- 真实成功率 ≥70%？❌ 原始 40%；校正后正常任务 ~63%（仍 <70%）。
- Planner 稳定？⚠️ 真实稳定（1.0），但我的 schema 门引入 3 个假失败，需修。
- 无大量死循环？✅ 未见死循环，repair 耗尽即终止。
- Recovery 有效？❌ repair 0% 成功，是核心短板。

**原因**：架构完整、核心链路真实可用（无 mock、真实 DeepSeek+浏览器）、resolver 与 verification 已修复；但 **Recovery 完全无效（0%）**、**验证仍有 ~33% 误判**、且存在 1 个 Step 2 schema 回归。距 Alpha 还差「自愈能力」与「验证精度」。

---

## 7. Next Phase Recommendation

**不自动修改代码，仅据真实数据提出建议：**

1. **修复 Step 2 schema 回归（高优先）**：`schema/action.js:63` 应容忍 `field:null`/`""`，当作「未知 field，回退 semantic 评分」，而非拒绝整计划。此修复可让 3 个被误杀的任务恢复运行，plannerSuccessRate 回到 1.0。
2. **优化 Recovery / Repair（最高优先）**：repair 0% 成功是当前最大短板。SEMANTIC_RELOCATE 耗尽即放弃；应引入替代策略（re-plan、邻近元素再评分、等待重渲染）或降低误判导致的无效 repair。
3. **提升 Verification 精度**：VERIFY_FAILED 32 次占失败码最大头，其中部分可能是验证器误判（状态读取/文本匹配不稳）。需提升 observation 状态读取与验证匹配鲁棒性，降低 RESOURCE_LOCK（22 次）与误判。
4. **凭据供给策略**：要么在 harness 中为 saas 任务供给 `credentialRef`（才能测出真实 saas 能力），要么将 saas 登录类明确移出「自主 Benchmark」范围，避免把正确安全升级算作失败。
5. **重跑 Benchmark**：上述 (1)(2)(3) 修复后，重跑 30/50/100 任务验证 —— 此时测量才干净（无 schema 门污染、repair 可能起效）。

---

## 附录：真实性核验清单

- [x] 每个 task 经 Objective → ContextBuilder → DeepSeek provider.plan → Schema Validation → Runtime → Browser → Verification 全链路（无 attachPlan 注入）。
- [x] 无 mock plan（`simulated:false`，日志仅 `mock-site`=本地 fixture 服务器）。
- [x] 无 fallback provider（脚本强制真实 DeepSeek，缺 key 即退出）。
- [x] 无异常成功（所有 SUCCESS 均带真实验证事件）。
- [x] 无 API 限流（日志无 429 / rate limit）。

**唯一数据 caveat**：3 个 Schema-Gate FAILED（§3-A / §4）为 Step 2 我引入的过严校验导致，属**测量污染**，已如实标注，未计入真实 Agent 能力失败。
