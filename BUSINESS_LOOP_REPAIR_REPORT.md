# BUSINESS LOOP REPAIR REPORT

> 专项：Business Loop 最小修复（DOM_CHANGED → Fresh Observation → Re-Verification 断链）
> 纪律：先只读取证、不改验证整体语义、不重写 verification.js/resolver/planner、不降低验证门槛、不写真实凭据。

## BUSINESS LOOP REPAIR

**PASS（代码修复 + 单元/集成/回归测试全绿）— 4-TASK GATE 待用户在自有运行环境执行（见 CREDENTIAL GATE / STOP）。**

修复已落地并验证：
- 单元测试 21/21 通过（含 DOM_CHANGED 路由、Window 真实 re-observe、Fresh Observation 规则、lineage、孤儿防护、resolver telemetry）。
- 既有回归 0 failure（未改任何既有断言）：test_phase11_business_contract 23/0、test_resolver_repair 11/0、test_runtime_replan_const_regression PASSED、test_phase10_vil 24/0。

## ROOT CAUSE

1. **DOM_CHANGED 被直接归为 VERIFY_FAILED（核心断链）**
   `verificationIntelligence.js` 在 `after.previousObservationDiff.domChanged` 为真、action 成功时返回
   `{ decision: RE_EXECUTE, failureType: DOM_CHANGED }`。而 `isReobservableDecision` 仅含
   `{WAIT, RECHECK_OBSERVATION, RETRY_VERIFY}`，**不含 RE_EXECUTE** → `runtime.js` 的内联 Observation Window
   被完全跳过 → 直接 `failAttempt(VERIFY_FAILED, DOM_CHANGED)` → repair。DOM 变化被当成「需重执行」而非
   「需重新观察 + 重新验证」，业务结果在验证层丢失（Trace 的 `LOST_BUSINESS_CHANGE`）。

2. **Observation Window 永远 recovery=false（专项 §六根因：verification.window=36, success=0）**
   `verificationWindow.js` 中 `tryVerify = (obs) => doVerify(v, obs, beforeObservation)`，而 `doVerify` 是
   async（`verifyWithAlternatives` / 注入 `verifyFn` 均返回 Promise）。原代码 `const vres = tryVerify(current)`
   **未 await**，导致 `vres` 是 Promise、`vres.success` 恒为 undefined → `if (vres.success)` 永不命中 →
   窗口每次都判定「未恢复」。窗口确实重新 capture 了观察，却永远不会把成功回传给 runtime。

3. **obsCache.last() 返回倒数第二条观察（污染 DOM_CHANGED 基线 + lineage）**
   `observationCache.js` 的 `last()` 返回 `cur.prevSummary`（再上一条），而非 `cur.summary`（最近一条）。
   导致 `previousObservationDiff.domChanged`（VIL 的 DOM_CHANGED 触发信号）比对基线是错的，
   且 `parentObservationId` 在第二次观察即变 null（血缘链断裂）。

4. **submit 孤儿（专项 §13–15）：19 个 RUNNING 孤儿**
   扫描 `_final100_store_backup`：939 attempts 中 **19 个 RUNNING**，全部 `act=submit`、step `HEALING`、
   父 task 全部 `HUMAN_ESCALATION`（终态）。`createAttempt` **不存 taskId**（血缘缺失）；
   submit 触发整页导航时 after-observation 的 inspect 可能挂起，被 `STEP_TIMEOUT` 抢跑后
   在途 attempt 从未被 `succeedAttempt/failAttempt` 收口即遗留为 RUNNING 孤儿。

## CHANGES

| 文件 | 改动 | 类型 |
|---|---|---|
| `verification/verificationIntelligence.js` | DOM_CHANGED 的 decision 由 `RE_EXECUTE` 改为 `RETRY_VERIFY` → 进入内联 Observation Window（重新观察 + 重新验证，不重执行原动作） | 核心修复 #272 |
| `verification/verificationWindow.js` | `const vres = await tryVerify(current)`（修复 Promise 未 await）→ 窗口能真实 recovery；窗口内重观察标注 `source:'verification_window'` + `actionFinishedAt` + lineage | 核心修复 #274 |
| `observation.js` | observation 新增 lineage：`observationId / capturedAt / source / parentObservationId / actionFinishedId / fresh / taskId / stepId / attemptId`；`fresh = capturedAt > actionFinishedAt`（无 actionFinishedAt 则 `null`，禁止假装 fresh） | #273 |
| `observationCache.js` | `last()` 返回 `cur.summary`（最近一条）而非 `prevSummary`，修正 DOM_CHANGED 比对基线 + lineage | #273 |
| `tools.js` | after/before 观察补齐血缘 + `fresh`；`toolRes.finishedAt = afterObs.capturedAt` | #273 |
| `stepManager.js` | `createAttempt` 存 `taskId`；新增 `finalizeOrphanAttempts`（孤儿以 `ORPHAN_ATTEMPT` 显式收口） | #275 |
| `runtime.js` | 调用 Observation Window 时传入 `actionFinishedAt`；所有终态转换（fail/escalate/complete）前调用 `finalizeOrphans` 收口在途 attempt | #272/#275 |

**未改动**：verification.js 主判定语义、semanticResolver 算法、planner、合约判定逻辑、成功标准。DOM_CHANGED 仍只表示「页面变化」，绝不≡SUCCESS。

## REGRESSION

- 运行既有测试：**0 failure**。
- `test_phase11_business_contract` 23/0、`test_resolver_repair` 11/0（含「DOM_CHANGED → needsReplan」仍成立）、
  `test_runtime_replan_const_regression` PASSED、`test_phase10_vil` 24/0。
- 既有断言未修改。DOM_CHANGED 现先走 Window（re-observe + re-verify），窗口失败才回落 repair（保留语义重定位），
  故 repair 层 DOM_CHANGED 分支与 replan 逻辑不受影响。

## CREDENTIAL GATE

- **CREDENTIAL_GATE = NOT RUN（本通道不执行）**。依用户纪律：真实账号/密码/支付卡**绝不写入聊天或代码**，
  仅由用户在自有运行环境通过 **Vault reseed 脚本**（稳定 `FPB_MASTER_KEY` 下重注入真实凭据）录入。
- 代码侧已确保：Trace/telemetry 只记录 `credentialRef / available / resolved / valueLength`，绝不记录明文值。
- 4-task Gate 须用户在 Vault 解锁 + 真实凭据就绪后于运行环境实跑。

## 4-TASK TRACE

- **PENDING（需在用户运行环境实跑）**：1 SaaS Login + 1 Ecommerce + 1 Data Entry + 1 Long Workflow，
  real DeepSeek / Chromium / `simulated=false` / 真实 credential。
- _gate 检查项（Gate A–H）：const→let=0 / NO_VALUE=0 / ORPHAN=0 / Action 后有 Fresh Observation /
  Verification 消费 Fresh Observation / window 真实 re-observe / 每个 VERIFY_FAILED 可解释 / 至少 2 个完整闭环。
- 不要求 4/4 成功，要求 Business Loop 真实闭环。

## ORPHAN ATTEMPTS

- 修复前（备份数据）：**19 个 submit RUNNING 孤儿**（step HEALING、task HUMAN_ESCALATION）。
- 修复后：`createAttempt` 存 `taskId`；runtime 在 fail/escalate/complete 前调用 `finalizeOrphanAttempts`，
  任何仍 RUNNING 的 attempt 以 `ORPHAN_ATTEMPT` 显式收口。新测试 `test_submit_orphan` 静态断言该守卫已接入。

## VERIFICATION WINDOW

- 修复前：`vres = tryVerify(...)` 未 await → `verification.window` 成功率 **0**（专项 §六：36 次成功 0）。
- 修复后：`await tryVerify(...)` → 窗口真实 re-observe 后在 Fresh Observation 命中即 `recovered=true`。
  新测试 `test_verification_window_reobserve` 验证（注入 inspect/verify，窗口在 fresh obs 命中后 recovered，
  observationCount≥2）。

## BUSINESS RECOVERY

- 闭环恢复：ACTION → DOM_CHANGED → Fresh Observation（window 重新 capture，标注 `fresh`）→ Verification Contract
  重新评估 → SUCCESS / VERIFY_FAILED / STATE_UNKNOWN / REPAIR。
- DOM_CHANGED 不再直接≡VERIFY_FAILED；仅在 Fresh Observation 重验证仍失败时，才回落 repair（保留语义重定位 / replan）。

## 100-TASK BENCHMARK

**NOT RUN**（专项纪律 §28：4-task Gate 完成后立即 STOP，不自动跑 100-task；是否解除冻结重跑 100-task 由用户决定）。

## STOP

4-task Gate 代码与守卫已就绪；**STOP — 下一步是否在用户环境实跑 4-task Gate、及是否解除冻结重跑 100-task，由用户决定。**
本通道不持有、不写入任何真实凭据；凭据录入仅由用户运行环境内的 Vault reseed 脚本完成。
