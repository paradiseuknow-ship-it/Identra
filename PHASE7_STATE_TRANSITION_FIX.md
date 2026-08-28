# Phase 7 完成报告 — 非法 Step 状态转换崩溃修复（SUCCESS → HEALING）

## 1. 业务问题
真实 100-task 基准（`phase3_live100_raw.json`，LIVE / deepseek-chat）中 **27/100 任务全部以 `FAILED` 终态崩溃**，错误统一为：
```
runtime 执行异常: 非法 Step 状态转换: SUCCESS -> HEALING
```
这 27 个任务占全部 FAILED(36) 的 **75%**、占全池的 **27%**。它们并非真实业务失败，而是 runtime 内部状态机非法转换导致的**继发性崩溃**——任务在已有 step 达到 SUCCESS 后仍被强制转入 HEALING，触发 `taskStateManager.transitionStep` 抛错，使整个 task 异常终止为 FAILED。

## 2. 根因分析
- `taskStateManager.js:40` 定义 `STEP_TRANSITIONS.SUCCESS: []`——SUCCESS 为 step 终态，不可再转。
- `runtime.js` 主循环在失败分支（canRetry 与 retry-exhausted 修复分支）**无条件**调用 `stepManager.setStepState(step.id, 'HEALING')`。
- `stepManager.setStepState` 以**store 权威状态**做合法性校验（`getStep(stepId)`），而非本地 `steps[index]` 快照。
- 触发链：某 step 经 repair 在 store 中被置 `SUCCESS`（修复成功），但本地 `steps[index]` 快照已陈旧；主循环在 retry-exhausted 修复分支后**不递增 `index`**，于是重入同一 step 再次执行，失败，再次 `setStepState(HEALING)` → 与 store 的 `SUCCESS` 冲突 → 抛 `非法 Step 状态转换: SUCCESS -> HEALING` → 整 task 崩溃。
- 与高 `attemptCount`(≤12)、`repairSuccess`(≤2) 数据特征完全吻合：修复确实曾成功（置 SUCCESS），但后续重入崩溃。

## 3. 修改文件
- **`server/agent/runtime.js`**（3 处最小 patch，未改状态机定义、未改 success definition、未改 benchmark、未改 planner）：
  1. 主循环 SUCCESS 跳过判定（行 ~361）：改读**权威 store 状态** `stepManager.getStep(step.id).status`。
  2. canRetry 分支（行 ~408）：HEALING 前加守卫——若 store 中 step 已 `SUCCESS`/`SKIPPED`，直接 `index++` 推进，不再尝试 HEALING。
  3. retry-exhausted 修复分支（行 ~446）：同上守卫。

## 4. 最小 patch（节选）
```js
// (1) 权威状态跳过
const _liveStatus = (stepManager.getStep(step.id) || {}).status;
if (_liveStatus === 'SUCCESS' || _liveStatus === 'SKIPPED') { pendingAction = null; index++; continue; }

// (2)/(3) HEALING 前守卫
const _live = (stepManager.getStep(step.id) || {}).status;
if (_live === 'SUCCESS' || _live === 'SKIPPED') { index++; pendingAction = null; continue; }
stepManager.setStepState(step.id, 'HEALING');
```
设计原则：**fail-open 且向前推进**——已终态的 step 视为完成并前进，绝不伪造成功、绝不二次处理导致崩溃。非终态 step 的 HEALING/RETRY/REPAIR 路径完全保留。

## 5. 测试结果
- 新增 `server/scripts/test_phase7_statetransition.js`（10 断言，全 PASS）：
  - [A] 静态扫描确认 3 处守卫均读 `stepManager.getStep(step.id)` 且对 SUCCESS/SKIPPED 推进；并断言 `transitionStep(SUCCESS,HEALING)` 仍抛错（证明 bug 类真实、守卫必要）。
  - [B] 功能复现（用**真实** `taskStateManager.transitionStep` 为权威）：
    - B.1 复现原崩溃：`setStepState(SUCCESS→HEALING)` 抛确切错误。
    - B.2 修复逻辑：store 为 SUCCESS 时循环推进、不调用 HEALING、不崩溃、step 保持 SUCCESS。
    - B.3 非终态(RUNNING)仍正常 HEALING（守卫不误跳过）。

## 6. 回归结果
- `test_phase6.js` **36/0**、`test_phase4_blockers.js` **23/0**、`test_benchmark_framework.js` **27/0**、`test_runtime_replan_const_regression.js` **PASSED**——既有行为、状态机定义、benchmark 口径、planner 均未受影响。

## 7. 当前能力提升
- **直接消除 27 个继发性崩溃**（全池 27%）。这些任务此前被错误归为 FAILED；修复后它们将正确终态：已成功的 step 被识别并推进，任务按真实完成情况收口为 SUCCESS 或进入既有 retry/repair/escalate 路径，**不再因内部状态机异常而崩溃**。
- 预期（待真实基准验证）：Business Success 由 6% 显著上抬；HUMAN_ESCALATION 不受影响（该 27 个原属 FAILED）。保守估计仅此一项即可把 Success 从 6% 推向 20%+ 区间（取决于其中多少本就仅差这最后一步）。
- 系统鲁棒性提升：主循环对「stale 本地快照 vs 权威 store 状态」不一致具备容错，杜绝同类状态机崩溃回归。

## 8. 下一阶段建议
- **（需人工提供 DeepSeek Key）立即重跑真实 100-task 基准**，量化 Phase 7 实际收益，确认 Business Success / HUMAN_ESCALATION 距目标（>30% / <30%）的缺口。
- 基于新基准数据，按 ROI 排序推进后续最小风险修复（候选）：
  - **VERIFY_RETRY 23 例**（多为 open-page / fill / click 真实定位失败）：增强 resolver 对搜索框/表单字段同义覆盖 + 导航失败恢复；属允许的 selector robustness 范围。
  - **POLICY_BLOCK 20 例**（CREDIBLE 升级，设计内）：评估其中是否存在可经非敏感路径达成、避免升级的任务。
- 持续每 Phase 输出报告，直至真实基准达到 Business Success >30% 且 HUMAN_ESCALATION <30%，再进入 Product Ready 评审。

> 状态：Phase 7 已完成并通过测试与回归。下一步真实基准测量**需要 DeepSeek API Key**（环境内当前缺失，上一轮仅临时注入未持久化），属授权停止条件「需要人工提供密钥」，特此暂停请求。
