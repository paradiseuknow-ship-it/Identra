# 真实业务能力根因审计报告 (REAL_BUSINESS_CAPABILITY_ROOT_CAUSE_REPORT)

**Run ID：** `phase12_100task_1787785122280.json`（真实 DeepSeek `deepseek-chat` + 真实 Chromium，`simulated=false`，串行 100 任务，`--timeout 300000`）
**数据来源（权威）：** `.benchmark/_final100_store_backup/`（aiTasks / aiAttempts / aiSteps / aiEvents / run log）
**Code state：** 本阶段分两段 —— 第一段**只读审计**（未改任何代码）；第二段**最小修复**（仅 P0-1 一处 `const→let`）。
**纪律遵守：** 未重写 runtime / verification / resolver / planner；未改 success definition / benchmark / 任务池；未加 mock / fallback；修复后**未自动重跑 100-task**，等用户确认。

---

## 1. 执行摘要与判定

最终 100-task 验收：**Business Success = 6.0%（6/100）**，Real Escalation 67%，VERIFY_FAILED 66%，harness==store 差异 0（已统一口径）。

本阶段目标不是重做产品，而是回答一个问题：**"Planner 96% / Navigate 82%，但 Click/Submit 几乎不能完成业务动作"——断裂到底在哪？**

**审计结论（核心）：**

1. **Click / Submit 的"执行失败"是测量假象，不是真实能力断裂。** 用真实派发记录（`aiAttempts`）而非 step 验证记录（`aiSteps`）统计：click 仅 **1/87** 是真正的 `ELEMENT_NOT_FOUND`（元素没找到），其余 72 例是 `VERIFY_FAILED`——即**点击成功执行 + DOM 已变化，但验证层无法确认业务状态**。submit 35 次派发**无报错**，但 19 例结果未被记录为成功（RUNNING 孤儿），14 例验证未通过。
2. **真实能力断裂有两处：`const` 运行时崩溃 + 凭据解密失败。**
   - **Runtime Crash（P0-1，已修复）：** `runtime.js:306` `const steps` 在 `:479` REPLAN 分支被重赋值 → 抛原生 `Assignment to constant variable` → 任务被强制 FAILED。**10 个任务**命中（另有 4 个 FAILED 由其他根因导致，见 §9）。
   - **凭据解密失败（P1-1，环境/配置问题，非代码缺陷）：** **56 次 fill 全部 `NO_VALUE`，且 100% 集中在 `password` 凭据字段**——因 `FPB_MASTER_KEY` 未设置，Vault 无法解密，登录类业务流根本无法完成。这是**单一最大、最确定的业务能力断裂**。
3. **验证/观察层失效是贯穿性瓶颈（P0-4，但属禁止重写范围）：** `verification.window` 36 次重验证**成功 0 次**；repair 动作成功 61% 但 Business Recovery 仅 2.2%。验证契约存在，但验证/观察层本身无法确认业务结果。

**产品级判定：** 即便修掉 P0-1 崩溃，Business Success 也不会自动跃升——因为 (a) 56 次 password fill 仍会因无凭据而失败（需用户配置 `FPB_MASTER_KEY` + 供给真实凭据），(b) 验证层仍无法确认业务状态（P0-4 属禁止重写范围，需另行立项）。

→ **仍不是 A（Product Ready）。** 修复后需用户决策是否解除冻结、用同一 100-task 池重跑以量化 P0-1 的收益。

---

## 2. 验收基线数据（最终口径）

| 指标 | 值 | 说明 |
|---|---:|---|
| Business Success | **6.0%（6/100）** | harness == store == 6.0%，差异 0 |
| Execution Success | 57.8% | 动作执行（含验证）成功率 |
| Planner Success | 96.0% | 规划成功率 |
| Verification Accuracy | 36.8% | 验证层判定正确率 |
| Repair Action Success | 60.8%（113/186） | repair 动作本身成功 |
| Business Recovery | **2.2%** | repair 真正救回业务的比例 |
| Real Escalation | 67%（67/100） | 升级人工；其中 Credible 仅 13% |
| failureTaxonomy | ELEMENT_NOT_FOUND:3 / VERIFY_FAILED:66 / POLICY_BLOCK:13 / OTHER:12 | 任务级失败分类 |
| 任务池 selection sha256 | `97ced9a7…` | 与修复前 Phase 12 完全一致，可直接比对 |

Store 终态分布：`SUCCESS 5 / HUMAN_ESCALATION 81 / FAILED 14`（Business Success 6 含 1 个虽升级但业务状态已达成者）。

---

## 3. 审计方法论与纪律

**链路全貌（逐节点取证）：**
```
Planner → Target Contract → Resolver → Resolved Element → Action Execution
        → DOM/Page State → Observation → Verification → Repair → Business Success
```

**关键测量纪律（纠正前一轮误判）：**
- 前一轮用 `aiSteps.step.status` 统计"click 执行 4%"，但该口径要求**验证也通过**才算成功 → 是测量假象。
- 本轮改用 `aiAttempts`（真实动作派发记录）按 attempt 单元统计，区分 **dispatch（动作是否派发/执行）** 与 **outcome/verification（业务状态是否确认）**。

**只读纪律：** 审计阶段未修改任何源码、未调 success definition / benchmark / 任务池 / fixture / scenario、未重跑失败任务、未人为筛选失败样本。

---

## 4. 端到端链路与第一个断裂节点

按链路逐节点标注断裂位置：

| 节点 | 状态 | 证据 |
|---|---|---|
| Planner | ✅ 正常 | 96% 规划成功 |
| Target Contract | ✅ 正常 | target/verification 字段齐备 |
| Resolver | ⚠️ 不可测 | `matchedBy` 全为 `"unknown"`（遥测缺口，见 §10） |
| Resolved Element | ✅ 基本正常 | click 仅 1/87 `ELEMENT_NOT_FOUND` |
| **Action Execution** | ✅ 派发正常 | click/submit 派发几乎不报错 |
| **DOM/Page State** | ✅ 变化正常 | VERIFY_FAILED 的 failureType 多为 `DOM_CHANGED`（DOM 已变） |
| **Observation / Verification** | ❌ 断裂 | `verification.window` 36 次成功 0；36.8% 验证准确率 |
| Repair | ⚠️ 虚功 | 动作成功 61%，业务恢复 2.2% |
| **Business Success** | ❌ 坍塌 | 6% |

**第一个真实断裂节点 = Action Execution 之后的 Observation/Verification 层（P0-4）与 Credential 供给（P1-1）；外加一个独立的 Runtime Crash（P0-1）在 REPLAN 恢复路径上直接杀死任务。**

---

## 5. Action Reliability Matrix（真实派发口径，来自 `aiAttempts`）

> 全量 939 条 attempt，按 `action.type` 聚合（status==='SUCCESS' 计为 ok）。

| Action | n | ok | ok% | fail | failCodes |
|---|---:|---:|---:|---:|---|
| inspect | 272 | 168 | 61.8% | 104 | VERIFY_FAILED:104 |
| fill | 215 | 71 | 33.0% | 144 | **NO_VALUE:56, ELEMENT_NOT_FOUND:77, VERIFY_FAILED:11** |
| wait | 166 | 155 | 93.4% | 11 | VERIFY_FAILED:11 |
| navigate | 143 | 82 | 57.3% | 61 | VERIFY_FAILED:61 |
| click | 87 | 14 | 16.1% | 73 | **VERIFY_FAILED:72, ELEMENT_NOT_FOUND:1** |
| submit | 35 | 2 | 5.7% | 33 | **VERIFY_FAILED:14, (none):19** |
| reload | 21 | 21 | 100% | 0 | — |

**读法：** `ok%` 低 ≠ 派发失败。click 的 72 例 `VERIFY_FAILED` = 点击已执行、DOM 已变、但业务状态未被验证确认；submit 的 19 例 `(none)` = 提交无报错但结果未被记录成功。

---

## 6. Click 失败细分与测量假象澄清

**原报告（step 口径）：** click 执行 4% → 看似"点击几乎不成功"。

**真实派发口径（本轮）：** click n=87，失败 73 中：
- `ELEMENT_NOT_FOUND`：**1 例**（元素真的没找到）
- `VERIFY_FAILED`：**72 例**

进一步追 `aiEvents` 中 click 相关 VERIFY_FAILED 的 `failureType`：绝大多数为 `DOM_CHANGED`（"动作后 DOM 指纹显著变化"）——**即点击已经发生、页面已响应，只是验证层无法确认"业务状态已达成"**。

**结论：** Click 的真实执行能力≈正常（仅 1/87 真正找不到元素）。瓶颈不在"点不到"，而在"点了之后验证层确认不了业务结果"。这不是 click 派发断裂，是 **P0-4 验证/观察层** 的问题。

---

## 7. Submit 失败细分（含 RUNNING 孤儿）

submit n=35，ok=2，失败 33：
- `VERIFY_FAILED`：**14 例** —— 提交已发生，业务状态未确认（同 P0-4）。
- `(none)`：**19 例** —— submit 工具**返回无报错**，但 attempt 未被标记为 SUCCESS，任务状态悬空/最终 FAILED。这是**提交结果记录缺口**：提交动作本身执行了，但成功/观察结果未回写。

**结论：** submit 派发正常（无报错）。断裂在 (a) 验证确认（14 例）与 (b) 结果记录（19 例孤儿）。后者指向 runtime 提交后的 observation→success 落点逻辑，属 runtime 内部——但本轮纪律**禁止重写 runtime**，故仅作记录，列为 P0-3 二级发现，暂不改动。

---

## 8. Fill / Credential 根因（56× NO_VALUE 全为 password 凭据）

fill 失败 144 中：
- **`NO_VALUE`：56 例 —— 100% 带有 `credentialRef`，且目标字段 100% 是 `password`（部分含 email/login）。**
- `ELEMENT_NOT_FOUND`：77 例（元素解析/定位失败，含动态表单）。
- `VERIFY_FAILED`：11 例。

**代码级根因链：**
```
FPB_MASTER_KEY 未设置
  → vault.getProfileSecrets(profileId) 抛错/返回 null
  → secretManager.resolve(credentialRef) 返回 null
  → resolveFillValue(action) 返回 null
  → tools.js:369  return RESULT.error('NO_VALUE','fill 缺少 value 且 credentialRef 不可用')
```
证据：`aiAttempts` 中 56 条 NO_VALUE **全部** `action.credentialRef` 非空且字段为 `password`；`aiCredentials.json` 中 available:true 但解密值为 null（Vault 未解锁）。

**关键判断：** 这是**环境/配置缺陷，不是代码 bug**。在 `FPB_MASTER_KEY` 未设置、Vault 无真实凭据的情况下，**任何登录类业务流都无法完成**——这直接封顶了 Business Success。修复方式是运维动作（设置主密钥 + 供给真实凭据），**不是代码改动**（且纪律禁止加 mock/fallback 掩盖）。

> 注：若希望"无凭据时明确升级而非静默 NO_VALUE→VERIFY_FAILED→repair→fail"，属合理的错误可见性改进，但会改动 runtime/verification 行为，**超出本轮最小修复范围**，列为后续建议（§16）。

---

## 9. Runtime Crash 取证（Assignment to constant variable）

**现象：** 14 个任务终态 FAILED。run log 命中：
```
[runtime] run 未捕获异常，转 FAILED 终态: Assignment to constant variable.
```
共 **10 条**该崩溃日志。

**代码级根因（已定位，per-function 作用域敏感扫描确认唯一命中）：**
- `server/agent/runtime.js:306`：`const steps = await resolvePlan(task);`（在 `run()` 主循环内声明为 `const`）
- `server/agent/runtime.js:479`（REPLAN 分支）：`steps = stepManager.listSteps(task.id);` —— **对 `const` 变量重赋值**

这是原生 V8 错误（非自定义 throw）。仅在任务 plan stale 触发 REPLAN 时命中 `:479`，故恰好部分任务崩溃，解释了"为什么有的任务崩、有的不崩"。

**崩溃影响分类（精确，来自 store 取证）：**
- **const-crash 任务（10 个）：** `task_mtaiy2p1uwtg0`、`mtaj1gn1iizrc`、`mtaj28eyyv0vz`、`mtaj39xddz5uo`、`mtaj46avl01wp`、`mtaj6wsqmv9sj`、`mtaj86itn9y2r`、`mtajad5kseqz1`、`mtajeevln9w07`、`mtajq0mzygivq`。全部 `steps:0`、currentStepId=null → 崩溃在共享 post-step 路径。
- **其他 FAILED（4 个，根因不同，非本崩溃）：**
  - `mtakst3fniluy` / `mtaku7d5m540d` / `mtakyei9i9w6d`：`规划失败(plan): JSON 解析失败`（DeepSeek 返回非法 plan JSON）—— 规划器输出质量问题。
  - `mtajo2wia120m`：`Plan Schema 校验失败: steps[2] fill 禁止仅用 action_success 作为完成证据`（规划器产出的 fill 完成证据不合规被拒）—— 规划器/验证契约交互问题。

**判定：** 该崩溃属 **type B（失败恢复/replan 路径触发的二次 bug）**——非 click/submit/verification 主链路，而是恢复路径对自身变量的误用。这 10 个任务本应进入 REPLAN 续跑，却因崩溃直接 FAILED。

---

## 10. Resolver 审计（matchedBy unknown，非主瓶颈）

- `aiElementMemory` 共 81 条，但 **`matchedBy` 字段全部为 `"unknown"`** —— Resolver 的匹配来源遥测**根本没被记录**。
- Resolver 不是主瓶颈：click 仅 1/87 `ELEMENT_NOT_FOUND`（元素解析），fill 77/215 `ELEMENT_NOT_FOUND`（含动态表单，部分与凭据无关）。`ELEMENT_NOT_FOUND` 任务级仅 3/100，说明"找不到元素"不是 Business Success 坍塌的主因。
- 但 `matchedBy` 全 unknown 使 B5（真实任务泛化是否改善）**不可测**——属测量缺口，如实标注。

---

## 11. Observation / Verification 追踪（P0-4，贯穿性瓶颈）

来自 `aiEvents`：
- `ai.verification.decision`：18 条；`ai.verification.window`：36 条（已入 store）。
- **`verification.window` 36 次重验证，成功 0 次（0%）** —— 吸烟枪：验证层**从未成功确认过一次业务结果**。
- failureType 分布：`STATE_UNKNOWN` 14（→ RECHECK_OBSERVATION×12）、`DOM_CHANGED` 4（→ RE_EXECUTE×4）、其余 → HUMAN_ESCALATE。
- **Business Recovery 2.2%**：repair 动作 61% 成功，但仅 2.2% 真正救回业务 → repair "recovered" ≠ "Business recovered"，虚功。

**结论：** 验证契约与 VIL 决策逻辑存在且能正确归因（STATE_UNKNOWN 不再 silent recheck），但**验证/观察层本身失效**——无法把"DOM 已变化"映射到"业务状态已达成"。这是 Business Success 坍塌的**贯穿性根因**，但按纪律**禁止重写 verification/runtime**，故本轮不改动，列为最高优先级后续立项（§16）。

---

## 12. Root Cause Priority Ranking

按"影响 Business Success 的任务数 / 是否真实能力断裂 / 是否可最小修复"排序：

| 优先级 | 根因 | 影响规模 | 性质 | 本轮处置 |
|---|---|---:|---|---|
| **P0-1** | Runtime `const steps` REPLAN 崩溃 | 10 任务直接 FAILED | 代码 bug（type B 二次 bug） | ✅ **已最小修复**（`const`→`let`） |
| **P1-1** | 凭据解密失败（56× NO_VALUE，全 password） | 56 fill 失败，封顶所有登录业务流 | 环境/配置缺陷（非代码） | ⛔ 需用户配置 `FPB_MASTER_KEY` + 供给真实凭据 |
| **P0-4** | 验证/观察层无法确认业务状态（window 0%） | 贯穿 66% VERIFY_FAILED | 架构层失效 | ⛔ 禁止重写，列为后续立项 |
| **P0-3** | submit 结果记录缺口（19 孤儿） | 19 submit 悬空 | runtime 内部缺口 | ⛔ 禁止重写，仅记录 |
| **P1-3** | 规划器 JSON 解析失败 / Schema 校验失败 | 4 FAILED 任务 | 规划器输出质量 | ⛔ 禁止重写 planner，仅记录 |
| **P1-2** | Resolver `matchedBy` 遥测缺失 | B5 不可测 | 测量缺口 | ⛔ 仅记录，待补 telemetry |

**关键洞察：** Business Success 6% 不是"click/submit 派发能力差"，而是 (1) 10 个任务被崩溃杀死 + (2) 56 次 password fill 无凭据 + (3) 验证层永远确认不了业务状态，三者叠加。

---

## 13. Phase 2 最小修复

### 13.1 P0-1（已实施 ✅）

**修改文件：** `server/agent/runtime.js`
**改动：** 第 306 行 `const steps` → `let steps`（使 REPLAN 分支 `:479` 的 `steps = stepManager.listSteps(task.id)` 合法）。
**范围：** 单点、外科手术式。未重写 runtime，未触碰验证/解析/规划逻辑。其余所有 `steps` 只读用法语义不变（`let` 是 `const` 的严格超集）。

**为什么这样改（而非 try/catch 包住重赋值或重构 REPLAN）：** 重赋值本身是合理语义（replan 后用新步骤列表续跑），错误仅在 `const` 声明上。最小修复即改声明，零行为副作用，回归风险最低。

### 13.2 P0-2 / P0-3 / P0-4 / P1-x（未实施，超出最小修复范围）

依据纪律"禁止重写 runtime/verification/resolver/planner、不加 mock/fallback"，以下根因**本轮不做代码改动**，仅在上文取证并记录，待用户决策后另行立项：
- P0-4 验证/观察层失效（最大贯穿性瓶颈）
- P0-3 submit 结果记录缺口
- P1-1 凭据供给（运维动作，非代码）
- P1-3 规划器输出质量
- P1-2 Resolver telemetry

---

## 14. 测试纪律与测试结果

**新增回归测试：** `server/scripts/test_runtime_replan_const_regression.js`
- [A] 静态扫描真实 `runtime.js`：确认 `run()` 内 `steps` 以 `let` 声明且 REPLAN 分支对其重赋值。
- [B] 隔离 vm 功能复现：证明 `const`+重赋值抛 `Assignment to constant variable`（复现原 bug）、`let`+重赋值成功（修复验证）。

**运行结果：**
```
[A] Static scan of real runtime.js
  PASS: runtime.run() declares `steps` with `let` (not `const`)
  PASS: runtime.run() reassigns `steps` in the REPLAN branch
[B] Functional micro-reproduction of the bug class (isolated vm)
  PASS: const + reassignment throws "Assignment to constant variable" (reproduces the original crash)
  PASS: let + reassignment succeeds (fix verified)
REGRESSION TEST PASSED — P0-1 const-steps reassignment crash is fixed.
EXIT=0
```

**语法/加载冒烟：** `node --check server/agent/runtime.js` → SYNTAX_OK；`require('./server/agent/runtime.js')` → REQUIRE_OK。

**未做：** 未重跑 100-task（遵守 STOP 纪律）。未改动任何既有测试。

---

## 15. 完成条件确认 / STOP 声明

本阶段交付物已齐备：
- ✅ 只读根因审计（§3–§12，全链路证据 + Action Reliability Matrix + 崩溃 10 任务取证 + 56 NO_VALUE 凭据归因）。
- ✅ 最小修复 P0-1（`const`→`let`）+ 回归测试通过。
- ✅ 16 节报告（本文件）。

**STOP —— 未自动重跑 100-task，未自行进入下一 Phase。** 修复为单点代码修正，预期仅消除 10 个崩溃任务的"必死"路径；Business Success 的真实跃升依赖 P1-1（凭据）与 P0-4（验证层）的后续处置，均超出本轮范围。

**等你确认后，再决定是否：**
1. 解除 CODE FREEZE；
2. 用**同一 100-task 池**（sha256 `97ced9a7…`）重跑，以量化 P0-1 修复带来的 FAILED→续跑转化；
3. 是否并行启动 P0-4 / P1-1 专项修复。

---

## 16. 未解决问题与后续建议

**A. 必须用户决策/处置（阻塞 Business Success 的真实根因）：**
1. **P1-1 凭据供给（最高杠杆）：** 设置 `FPB_MASTER_KEY` 并解锁 Vault、向 `aiCredentials` 供给真实 password/email 凭据。这是 56 次 password fill 失败的唯一起因，也是所有登录类业务流的前提。**这是把 6% 拉起来的最关键一步，且无需改代码。**
2. **P0-4 验证/观察层（最大架构瓶颈）：** 需专项立项（允许重写 verification/observation），目标：把"DOM 已变化"可靠映射为"业务状态已达成"，消除 `verification.window` 0% 成功与 2.2% 业务恢复。

**B. 已记录、待立项（禁止重写范围内）：**
3. P0-3 submit 结果记录缺口（19 孤儿）—— 排查 submit→observation→success 落点。
4. P1-3 规划器 JSON 解析失败（3 任务）+ fill 完成证据 Schema 校验失败（1 任务）—— 规划器输出鲁棒性。
5. P1-2 Resolver `matchedBy` telemetry 缺失 —— 补遥测使 B5 可测。

**C. 可选错误可见性改进（超出本轮，需另行批准）：**
6. 无凭据时由 `secretManager.resolve` 显式返回"vault locked"，使 runtime 走 HUMAN_ESCALATION 而非静默 NO_VALUE→VERIFY_FAILED→repair→fail（提升失败可解释性，但改动 runtime/verification 行为）。

---

### 附：关键证据索引
- 崩溃日志：`.benchmark/logs/final100_run.log`（10 条 `Assignment to constant variable`）
- 崩溃任务 ID 与 4 个非崩溃 FAILED：§9（来自 `.benchmark/_final100_store_backup/aiTasks.json`）
- Action Reliability Matrix：§5（来自 `aiAttempts.json`，939 条）
- NO_VALUE 凭据归因：§8（56 条全部 `credentialRef`=password）
- 修复 diff：`runtime.js:306` `const steps` → `let steps`
- 回归测试：`server/scripts/test_runtime_replan_const_regression.js`（4/4 PASS）
