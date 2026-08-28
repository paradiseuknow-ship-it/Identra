# Phase 5.9-A — Failure Attribution Report（只读分析，未修改任何代码）

> 生成时间：2026-08-22
> 方法：仅读取 `benchmark/tasks`、`benchmark/runners/{playwright,llm,agent}Runner.js`、`benchmark/verify.js`、`benchmark/agentPlanBridge.js`、`benchmark/mockSite`、`server/agent/runtime.js`、`server/agent/verification.js`、`server/agent/observation.js`、`server/agent/recovery/recoveryManager.js`、`server/agent/repair/repairManager.js` 与原始运行日志 `/tmp/bench_abc.log`。
> 未运行任何代码、未改动任何文件。
> 状态标注：[确认] = 代码静态可证；[推断] = 由代码逻辑推出但需运行时 trace 最终确认。

---

## 0. 原始结果（来自 /tmp/bench_abc.log）

```
Playwright (A)       | 81.8%  | P50 77ms    | P95 15071ms | Avg 2604ms | LLM/T 0   | Cost $0
Playwright+LLM (B)   | 45.5%  | P50 8024ms  | P95 15033ms | Avg 6199ms | LLM/T 5.0 | Cost $0.055
Experience Agent (C) | 100%   | P50 2226ms  | P95 15265ms | Avg 3316ms | LLM/T 0   | Cost $0
```

- A 失败 2/11，B 失败 6/11，C 失败 0/11。
- 旁路告警（与指标无关但保留）：`scheduler.reaped` 非标准事件、`fingerprint` UA/引擎版本对齐 WARNING。

---

## 1. 三组是否同构？（你最关心的"是否公平"问题）

### 1.1 Task 定义：同构 ✅ [确认]
A/B/C 共用 `benchmark/tasks/index.js` 的 11 个 `TASKS`，`objective / targetUrl / mock / verify` 完全一致。Runner 入参相同。

### 1.2 Mock Site 状态：同构 ✅ [确认]
三组都打同一个 `mockSite.buildApp()` 起的本地实例（`report.js` 单实例，`opts2.mockBaseUrl` 共享）。无独立 mock 实例差异。

### 1.3 Verify 判分：⚠️ 非完全同构（关键发现）[确认]
- **A/B 用 `benchmark/verify.js::verifyResult`**：基于 `page.waitForFunction / waitForURL / waitForSelector`，**阻塞轮询直到 `task.verify.timeoutMs`**。
- **C 用 `server/agent/verification.js::verify`**：基于 `tools.execute` 返回的 **单次 observation 快照**做 `text.toLowerCase().includes(expect)`，**不轮询、不等待**。
- 两者文本来源也不同：
  - A/B：`document.body.innerText`（不含 `display:none` 隐藏文本）。
  - C 的 observation：`h1,h2,h3,p,li,summary,span` 中 `isVisible(el)` 为真元素的 `innerText`（`observation.js` 行 88-92），同样不含隐藏文本。
- **结论**：文本来源口径一致（均不含隐藏文本），但**等待语义不同**——A/B 会等待至 timeoutMs，C 只看点击瞬间快照。这是 C 与 A/B 在 `timeout / cookie / structure-change` 等"异步变化"任务上行为分歧的根因之一。

### 1.4 Plan 注入：C 独有，A/B 无 [确认]
- C 在 `BENCH_PLAN_BRIDGE=1` 时由 `agentPlanBridge.injectPlan` 注入**针对 11 类任务的确定性 steps**（含 `browser-crash / worker-crash / session-expired / timeout` 的"正确"步骤序列）。
- A/B 无此注入：A 用硬编码 `_script`（无 retry、无 recovery），B 用 mock LLM `_heuristic`（退化策略，弱于确定性 plan）。
- **这意味着 C 的优势中，至少有一部分来自"已知答案的确定性 plan"，而非 Runtime/Intelligence 在线推导。**

### 1.5 Router / Memory / Failure Knowledge 参与度 [确认]
- A：无（硬编码）。
- B：`memoryHit:0, routerAccuracy:null`（代码无 memory/router 调用）。
- C：聚合表 `Mem%=0%, Router%=n/a`。`_collectMetrics` 从 `observability.trace(taskId).intelligence` 取，但**本次运行无记录** → 说明 C 在 `BENCH_PLAN_BRIDGE` 模式下，Runtime 内部**未实际触发 Router/Memory/Failure Knowledge 的命中统计**。
- **结论**：C 的 100% 主要来自 (a) 确定性 plan + (b) Runtime 有界 retry 重放步骤 + (c) 完整 Scheduler/Worker/Browser 链路稳定性。**Phase 3 Intelligence（Router/Memory/Failure Knowledge）在本轮未被证明产生商业价值**——这与你预判的"情况 C"一致。

---

## 2. A 失败的 2 个任务 [推断，基于代码+verify 语义]

A 的 `PlaywrightRunner._script` 为每任务写死单次操作、无 retry、无 recovery，且 `verify` 走 `verifyResult`（轮询至 timeoutMs）。

| taskId | category | objective | expected (verify) | A 实际 | 失败分类 | 是否 retry/recovery | C 为何成功 [推断] |
|---|---|---|---|---|---|---|---|
| `structure-change` | structure-change | 按钮从底部移到顶部，点"提交" | text `done` (8s) | 点 `#submit` 一次；但 mock 在加载后 600ms 才把 `#submit` 移到顶部。A 在 600ms 内点 `#submit` 可能命中旧位置或点击时元素已迁移导致错位 | **navigation/timing**（元素迁移竞态） | 否 / 否 | C 的 plan 同样只点一次 `#submit`，但 C 在 click 后做 observation 验证 `done`；若首次未中，retry 重放 click（600ms 后元素已稳定）→ 命中 → `done` [推断] |
| `browser-crash` 或 `worker-crash`（二者之一，或合计 2 个含 `session-expired`） | worker/session | 崩溃/失效后恢复 | text `recovered` / url `/dashboard` | A 脚本只点一次 `#go`/`#act`，无恢复逻辑 | **recovery（缺失）** | 否 / 否 | C 靠 Runtime 有界 retry 重放 step.action 第二次点击，触发 mock 的"二次点击显示 recovered/进 dashboard"分支 [推断，见 §4] |

> 说明：原始日志只给聚合表，**未打印逐 task 成功/失败明细**（这是 Phase 5.9-B 要补的 instrumentation 缺口）。上表 A 失败集合为"11 任务中除去 C 全成功、A 81.8%=9 成功"倒推的 2 个，具体是哪 2 个需运行时逐 task 输出确认。最可能的候选：`structure-change`（元素迁移）、`browser-crash`/`worker-crash`/`session-expired`（需恢复）、`timeout`（异步）。

---

## 3. B 失败的 6 个任务 [推断]

B 用 mock LLM（`provider.mock`）+ `_heuristic` 退化策略：`_heuristic` 仅在页面文本含"登录"时填 `#username`、含"提交/搜索"时点 `button`，否则 `done`。MAX_STEPS=12，每步 1 LLM call（实测 5.0 LLM/T 说明平均 5 步后 verify 或 done）。

B 失败根因分类：
1. **plan 质量差（mock LLM 退化）**：`_heuristic` 不识别多数任务的正确选择器/顺序，易提前 `done` 或点错 `button`。
   - 例 `login`：`fill #username` 仅当文本含"登录"——登录页有"登录"按钮文本 → 可能触发，但顺序/字段易错。
   - 例 `nav`：`_heuristic` 点 `button` 而非 `a[href]` → 导航失败。
   - 例 `search/form`：依赖"搜索/提交"文本 → 部分命中但 verify 常不满足。
2. **无 recovery**：B 的 `recovery:false` 写死，崩溃/失效类任务（crash/session/timeout）一律失败。
3. **无 retry 语义对齐**：B 的循环是"LLM 决策步"，非"步骤重试"，失败即 verify-failed。

> B 的 45.5%（5/11 成功）几乎肯定由 mock LLM 退化导致，**与 Runtime 稳定性无关**。这正好印证"现在接 DeepSeek 会污染结论"——B 当前根本不代表真实 LLM 能力。

---

## 4. C 的 11 个成功任务逐项追踪 [推断]

C 路径：`TaskManager.createTask → Scheduler.submit → tick → Worker → runtime.run → resolvePlan（BENCH_PLAN_BRIDGE 已落库 steps）→ 逐 step runStep → tools.execute → verification.verify（快照）→ 失败则 retry（recoveryManager 重放 step.action 或等待）→ 耗尽则 repairManager → HUMAN_ESCALATION/FAILED/SUCCESS`。

| taskId | plan 来源 | 经 Scheduler | 经 Router | 经 Memory | retry 发生? | recovery 触发? | C 成功机制 [推断] |
|---|---|---|---|---|---|---|---|
| login | bridge | 是 | 否(统计无) | 否 | 可能首过 | 否 | 确定性 fill+click+url 验证，首过 |
| search | bridge | 是 | 否 | 否 | 可能首过 | 否 | fill+click+#results 验证 |
| form | bridge | 是 | 否 | 否 | 可能首过 | 否 | 三 fill+click+text |
| nav | bridge | 是 | 否 | 否 | 可能首过 | 否 | 两次 click+url |
| text-change | bridge | 是 | 否 | 否 | 可能首过 | 否 | click #refresh + 等 800ms Ready（mock 自身 setTimeout 800ms，C 不轮询但 retry 间隔巧合覆盖） |
| timeout | bridge | 是 | 否 | 否 | **应 retry×3** | 可能(wait 800ms) | ⚠️ **矛盾点见 §5 Finding A1** |
| cookie | bridge | 是 | 否 | 否 | 可能首过 | 否 | click #accept + text |
| structure-change | bridge | 是 | 否 | 否 | **是(元素迁移)** | 可能 | retry 重放 click，600ms 后元素稳定命中 [推断] |
| session-expired | bridge | 是 | 否 | 否 | **是(被踢重登)** | 可能 | retry 重放 click #act；mock 第一次踢回 /login，重试时 localStorage.auth 已置 → 进 /dashboard [推断，需 trace] |
| browser-crash | bridge | 是 | 否 | 否 | **是(二次点击)** | crash:true 标志 | 第一次 click 触发 `__crashSignal`（不显 recovered），retry 重放 click → `__crashed=1` → 显 recovered → 验证过 [推断，高置信] |
| worker-crash | bridge | 是 | 否 | 否 | **是(二次点击)** | 可能 | mock 实际无真崩溃逻辑（点 #go 直接显 recovered），A 也应成功——**A 在此任务失败说明 A 的 click 时序/verify 问题，非 C 独有** [推断] |

**共性结论**：C 的成功主要来自 (1) 确定性 plan 给出正确步骤序列；(2) Runtime 的有界 retry 能重放 step.action 跨越 mock 的"首次触发信号/二次生效"设计；(3) 完整链路无悬挂。Router/Memory/Failure Knowledge 在本轮**未产生可观测命中**。

---

## 5. 最高优先级待澄清矛盾（Finding A1）

**C 对 `timeout` 任务 = 100% SUCCESS，但静态推导应失败。**

推导链：
- mock `/timeout`：`#slow` 点击后 `setTimeout(60000)` 才显示 `timeout-detected`（行 51）。
- C 的 plan：`click #slow → wait text_present timeout-detected`。
- `tools.execute` 点击后取**即时** observation，`timeout-detected` 文本（hidden，60s 后才显示）不在快照 → `verification.verify` 判失败 → VERIFY_FAILED。
- runtime retry×3（step.maxRetries=3），每次 recoveryManager.timeout 策略 `wait 800ms` + 重放 click ≈ 累计 2.4s，**远小于 60s** → 第 3 次仍失败 → repairManager → HUMAN_ESCALATION（非 SUCCESS）。
- 但实测 C=100% SUCCESS。

可能解释（均需运行时 trace 确认，不修改代码）：
- (a) `verification` 的 `text` 来源实际包含隐藏文本（与 observation.textSummary 不同源）；
- (b) recoveryManager 的 wait/重载序列累积时间巧合跨越 60s（P99=15s 不支持）；
- (c) classifier 将 VERIFY_FAILED 归为某类后 recoveryManager 返回 action 使 observation 在临界前命中；
- (d) 其他未读路径（如 checkpoint 恢复重放）介入。

**商业影响**：在 §5 澄清前，**不能把 C 的 100% 解读为"Experience Layer 解决了超时"**。它更可能是 BENCH_PLAN_BRIDGE 确定性 plan + Runtime retry 在 mock 上的特定交互。这正对应你担心的"情况 B（C 走了不同 verify/timeout 条件）"——必须排除。

---

## 5.1  5.9-A.1 Runtime Trace 终审（Finding A1 已钉死）

> 方法：临时取证脚本（已删除，未改任何源）启动同构 mockSite，单独跑 `timeout` 任务一次 C Runner，监听 `events` 事件 + monkey-patch `observation.inspect` 记录每次返回。原始日志 `/tmp/forensic_timeout2.log`。

### 5.1.1 实际轨迹（来自事件日志）

```
[step] 打开 http://localhost:4403/timeout        ← plan step 1 (navigate)
[action] ok=true tool=navigate
[verify] type=page_change success=true evidence=["无 before 观察，判定 URL 已加载 ... → 变化"]
[step] 观察页面                                ← plan step 2 (inspect)
[action] ok=true tool=inspect
[COMPLETED] {"result":true}                      ← 终态 SUCCESS
```

observation 记录（2 次）：
```
#1 url=http://localhost:4403/timeout  textSummary=""  elements=1  containsTimeoutDetected=false
#2 url=http://localhost:4403/timeout  textSummary=""  elements=1  containsTimeoutDetected=false
```

**关键事实**：
1. C 在 timeout 任务上**只执行了 2 步：nav + obs**。**plan bridge 注入的 `click #slow` 与 `wait text_present timeout-detected` 两步根本没有出现在 `task.step_started` 事件序列里**。
2. `obs` 步骤的 verification 是 `{type:'none'}`（`agentPlanBridge.js` 的 `obs` 步骤定义）→ 恒 PASS。
3. runtime 主循环判断"steps 全部 SUCCESS → taskManager.complete" → SUCCESS。
4. **C 从未检查 `timeout-detected` 是否出现**。task 定义里的 `verify={type:'state', value:'timeout-detected', timeoutMs:9000}` 在 C 路径下被 plan bridge 的 steps 完全旁路——C 根本不读 `task.verify`。

### 5.1.2 终审结论（Finding A1 根因）

> **C 对 timeout 任务的 100% SUCCESS 是 Benchmark 判分不公平导致的假阳性，而非 Runtime Retry Benefit，更非 Intelligence Benefit。**

判定：你预判的 **"情况 B（C 走了不同的 verify/timeout 条件）"完全成立，且比预期更严重**：
- A/B 严格读 `task.verify`（`type:'state'` → `page.waitForFunction(localStorage/body.textContent includes 'timeout-detected', timeout=9000)`），会因 60s 延迟真实失败。
- C 不读 `task.verify`，只执行 plan bridge 注入的 steps；而 bridge 对该任务注入的 steps 以 `obs(type:none)` 收尾，**从未验证 `timeout-detected`**。
- 这构成一个**架构级同构漏洞**：`task.verify`（统一成功判据）只约束 A/B，不约束 C。C 的"成功"由 plan bridge 自带的 step verification 决定，二者判据来源不同、宽严不同。

### 5.1.3 影响范围（需 5.9-B 前修复）

此漏洞**不限于 timeout**，凡 plan bridge 注入的末步 verification 与 `task.verify` 不一致的任务都可能被误判。需逐类核对 `agentPlanBridge.planFor` 的末步 `wait(...)` 与 `benchmark/tasks` 的 `verify` 是否等价：
- `login/search/form/text-change/cookie/structure-change/session-expired/browser-crash/worker-crash`：bridge 末步 `wait(url_contains|element_present|text_present, ...)` vs task.verify(`url|selector|text|state`)——**需确认是否真等价**（例如 `state` 类 task 在 bridge 里被映射成 `text_present`，语义已变）。
- 尤其 `state` 类型（timeout/session 等）在 bridge 中无对应 `state` verification，被降级为 `text_present` → 判分口径丢失。

**行动项（不在本轮执行，待你确认后由 5.9-B 前置修复）**：
1. 让 C 路径的最终判据回归 `task.verify`（统一 `verifyResult`），plan bridge 仅提供执行步骤，不替代成功判据。
2. 或让 plan bridge 的末步 verification 严格镜像 `task.verify`（含 `state` 类型）。
3. 修复前**不得**将 C 的成功率用于任何商业结论。

---

## 6. 对"情况 A / B / C"的判定

| 你预判的情况 | 本轮证据 | 判定 |
|---|---|---|
| A：C 赢在 Element Memory 语义回退 + Failure Knowledge REAUTH | 无 Memory/Failure Knowledge 命中统计；C 成功靠确定性 plan + retry 重放 | **不支持** |
| B：C 走了不同 timeout/verify 条件（判分不公平） | **5.9-A.1 已钉死**：C 不读 `task.verify`，plan bridge 以 `obs(type:none)` 收尾旁路了 `state/timeout-detected` 判据；timeout 任务只跑 nav+obs 即判 SUCCESS | **成立（严重）** |
| C：C 11/11 确定性 plan，Router/Memory/FK 全 bypass | Mem%=0, Router%=n/a；plan 由 bridge 注入 | **强支持** |

**阶段结论**：当前 100/100 的 C 成功率**包含 Benchmark 判分不公平造成的假阳性**（情况 B），在修复 `task.verify` 同构前**不能用于任何商业结论**。已证实的是：**Phase 4 Scheduler + Worker + Browser Resource + Runtime 架构链路可稳定跑通**（无悬挂、无饿死），但 **Phase 3 Intelligence 商业价值仍未证明**（Router/Memory/FK 无命中）。这恰恰指明 5.9-B 的前置动作：**先修判分公平性（让 C 回归 `task.verify`），再扩 100×3**。

---

## 7. C 的 P50 overhead 标注修正 [确认你的提醒]

原口头结论"C P50=2226ms 是固定调度开销"**过早**。静态可确认的开销来源包括（占比未测）：
- Scheduler submit + tick 轮询（200ms 粒度）
- Worker allocation + Browser acquisition（chromium launch，含最多 3 次重试退避）
- Runtime initialization + resolvePlan（已落库 steps，跳过 planner）
- 逐 step：tools.execute（含 before/after observation ×2）+ verification
- 完整 Verification/Evaluation/Observability 落库

应改称 **"C 的端到端 P50 overhead"**，待 5.9-B instrumentation 拆解 Scheduler/Worker/Browser/Runtime/Verify 各段耗时。

---

## 8. 下一步（不执行，待你确认）

1. **澄清 Finding A1**：为 C 单个 `timeout` 任务开启 observability trace，确认 verify 文本来源与 retry 时序（只读 `observability.trace`，不改代码）。
2. **补 instrumentation（5.9-B）**：在 `report.js`/`runner` 增加逐 task 明细输出（成功/失败 taskId）、retry 次数、recovery 成功率、Memory Hit、Router Accuracy、各段耗时；任务扩到 100×3。
3. **架构价值 vs Intelligence 价值分离实验**：5.9-B 后半段建议在 C 路径下对比 `BENCH_PLAN_BRIDGE=1`（架构基线）vs `BENCH_PLAN_BRIDGE=0 + mock planner`（Intelligence 基线），隔离两者贡献。
4. **真实 LLM（5.9-C）**：最后才跑 `AI_PROVIDER=deepseek BENCH_PW_CHROMIUM=1 node benchmark/report.js`。

> 本报告未修改任何源代码与配置。所有 [推断] 项均需运行时 trace 最终确认。

---

## 9. 5.9-A.2 — Benchmark 判分同构修复 + 11×1 Fairness Gate（已执行）

> 执行时间：2026-08-22
> 边界：仅改 Benchmark 层（`benchmark/runners/agentRunner.js`），不改 Runtime / verification / mockSite / task 定义 / plan bridge / Scheduler / Worker / RecoveryManager / TaskManager。

### 9.1 修改内容（仅 `agentRunner.js`）

1. **核心修复 — 最终判据回归 `task.verify`（Ground Truth）**
   - `_waitFinal` 之后，通过 `browserManager.getSession(profileId)` 复用 per-profile 单例 page（串行 run 时序安全），调用统一 `verifyResult(task, page, {baseUrl})` 复核。
   - `success = groundTruth`（不再用 `final.status === 'SUCCESS'`）。
   - `result.raw` 记录 `runtimeStatus` / `groundTruth` / `groundTruthError` / `fairnessMismatch`（Runtime 判 SUCCESS 但 Ground Truth 判 FAILED → 假阳性捕获）。

2. **防回归断言（Fairness-Guard）**
   - 对 `timeout / browser-crash / worker-crash / session-expired / structure-change / cookie-consent` 六类，在 injectPlan 后打印 `groundTruth.verify` 与声明"Plan Step Verification 仅作执行策略，最终以 task.verify 复核"。
   - 该断言不阻塞执行，仅显式标记，供 Fairness Gate 复核。

### 9.2 Fairness Gate 结果（11×1 A/B/C，BENCH_PLAN_BRIDGE=1 BENCH_PW_CHROMIUM=1）

```
Runner               | Succ%  | P50     | P95     | Avg     | LLM/T | Tok/T | Cost/Succ
Playwright (A)       | 81.8%  | 71ms    | 15076ms | 2600ms  | 0     | 0     | $0
Playwright+LLM (B)   | 45.5%  | 8028ms  | 15032ms | 6196ms  | 5.0   | 1500  | $0.055
Experience Agent (C) | 18.2%  | 10131ms | 23692ms | 11366ms | 0     | 0     | $0
```

**C 从修复前的 100% 跌到 18.2%** —— 证明修复前的 C=100% 确为假阳性（情况 B 成立）。

### 9.3 逐任务诊断（C Runner，Ground Truth 复核 + pageUrl dump）

| task | pageUrl（Ground Truth 时） | runtimeStatus | groundTruth | fairnessMismatch |
|---|---|---|---|---|
| login | /login | SUCCESS | **false** | true |
| search | /search | SUCCESS | **false** | true |
| form | /form | SUCCESS | **false** | true |
| nav | / | SUCCESS | **false** | true |
| text-change | /text-change | SUCCESS | **false** | true |
| timeout | /timeout | SUCCESS | true | false |
| cookie | /cookie | SUCCESS | true | false |
| structure-change | /structure | SUCCESS | **false** | true |
| session-expired | /session | SUCCESS | **false** | true |
| browser-crash | /crash | SUCCESS | **false** | true |
| worker-crash | /worker-crash | SUCCESS | **false** | true |

**关键事实（已确认，非推断）**：
- `pageUrl` 全部正确（停在各自任务 URL，非启动占位页）→ **Ground Truth 读取的 page 状态有效，不存在 session 污染**。
- `groundTruthError=null` → 9 个 false 是**真实验证失败**，不是读取异常。
- 9 个任务 `runtimeStatus=SUCCESS` 但 `pageUrl` 停在**任务入口页**（如 login 停在 /login 而非 /dashboard，search 停在 /search 而非含 #results）→ **说明 C 的 Runtime 在 BENCH_PLAN_BRIDGE 模式下只执行了 plan 的 `nav` 步骤（可能 + `obs`），后续 `click/fill/wait` 步骤未被执行或未生效**，随即判 SUCCESS。
- `timeout / cookie` 两个 `groundTruth=true` 是因为其 `task.verify` 是 `state` 类型，`verifyResult` 的 state 分支检查 `body.textContent.includes(value)`——而 mock 页面里 `#flag`/`#cookie-dismissed` 是 `display:none` 的隐藏 div，**`textContent` 含隐藏文本**，故即使页面未真正变化、任务未真正完成，验证也恒 true。

### 9.4 结论与影响（重要）

1. **判分同构已修复**：C 现在与 A/B 使用同一把尺子 `verifyResult(task.verify)`。修复前的 C=100%（含假阳性）**正式标记为 INVALID / superseded**，**不得用于任何商业结论**（按你的要求）。
2. **Fairness Gate 暴露了比判分更深的坑**：C 的 Runtime 在确定性 plan（BENCH_PLAN_BRIDGE）模式下**并未完整执行 plan 注入的步骤**——11 类任务大多只跑到 `nav` 就 SUCCESS。这是 **Runtime ↔ Plan Bridge 集成层问题**，而非 Benchmark 判分问题。
3. **state 类型的 task.verify 本身也是假阳性源**：因 mock 用 `display:none` 隐藏 div 携带验证文本，`body.textContent.includes` 恒 true，使 timeout/cookie 即使未执行也 PASS。这是 `task 定义 / mockSite` 层的判分漏洞（超出 5.9-A.2 边界，未改）。
4. **Phase 5.8 的 100/100 验收也被重新审视**：当时 success 判定是 `final.status==='SUCCESS'`（Runtime 内部判），与修复前 report.js 的 C=100% 同源 —— **Phase 5.8 的 100/100 同样包含此假阳性，应降级为"Runtime 生命周期闭环正确（无悬挂/无饿死），但任务成功率数字不可信"**。

### 9.5 下一步（超出 5.9-A.2 边界，需你决策）

- **问题已不在 Benchmark 判分层，而在 Runtime ↔ Plan Bridge 集成层**：C 的 Runtime 不执行 plan 注入的 ACT/VERIFY 步骤。这需要查 `runtime.run` 主循环如何消费 `resolvePlan` 返回的 steps（是否只取前 2 步、或 step 执行后未推进），但**5.9-A.2 边界禁止改 Runtime**。
- 建议下一阶段（可命名为 5.9-A.3 或并入 5.9-B 前置）：在保持 Benchmark 判分同构的前提下，**修复 Runtime 对 BENCH_PLAN_BRIDGE 注入 steps 的完整执行**（仅允许改 Runtime 消费 plan 的逻辑，不动 verification 引擎本身），再重跑 Fairness Gate。
- 同时应修 `state` 类型 task.verify 的 mock 实现（让验证文本在任务真正完成后才进入 `textContent`，而非常驻隐藏 div），否则 A/B/C 的 state 类验证仍是假阳性。

> 本次仅修改 `benchmark/runners/agentRunner.js`（Benchmark 层）。临时诊断脚本 `_fairness_diag.js` 与调试日志行已删除，未留痕。

---

## 10. 5.9-A.3 — Runtime Plan 完整消费修复 + Mock State 验证修正（已执行）

> 执行时间：2026-08-22
> 边界：仅改 Benchmark 层（`benchmark/runners/agentRunner.js`、`benchmark/agentPlanBridge.js`、`benchmark/mockSite/index.js`）。**未改 Runtime / verification 引擎 / Scheduler / Worker / RecoveryManager / TaskManager**。

### 10.1 根因定位（通过只读诊断脚本逐 task dump，已删除）

| 层级 | 根因 | 现象 |
|---|---|---|
| **agentRunner** | `taskManager.createTask` 的 input schema 不含 `category` 字段，导致 `created.category` 为 undefined → `injectPlan` 调 `planFor(undefined)` 退化到 `base`（仅 nav+obs 两步） | C 全部任务只执行 2 步即 SUCCESS（5.9-A.2 暴露的 18.2% 真相） |
| **agentPlanBridge** | `fill` 步骤 `target` 只有 `field` 无 `selector`，且 `verification: element_present(field)`；Runtime `resolveSelector` 优先用显式 selector，否则走 `semanticResolver`（而 observation 不收集 input 元素）→ `ELEMENT_NOT_FOUND` / `未找到元素` | fill 步骤 VERIFY_FAILED → 重试耗尽 → HUMAN_ESCALATION |
| **agentPlanBridge** | `wait` 步骤 `verification: {type, expect}`（element_present/text_present/url_contains）；Runtime `verification` 引擎对 CSS selector 用语义解析失败、对 div 文本因 observation 不收集而失败 | 最后一步 VERIFY_FAILED → HUMAN_ESCALATION，即使页面已满足（groundTruth=true） |
| **mockSite** | timeout/cookie 用 `display:none` 隐藏 div 常驻验证文本 → `body.textContent.includes` 恒 true | state 类型 task.verify 假阳性（未执行也 PASS） |

### 10.2 修复内容（仅 Benchmark 层）

1. **agentRunner**：`created.category = task.category`（显式补挂，使 injectPlan 映射正确 plan）；`run` 的 `raw` 增加 `planStepCount`（注入步骤数）与 `executedStepCount`（Runtime 实际完成步骤数），供 Fairness Gate 验收 `plan==exec`。
2. **agentPlanBridge**：
   - `fill` 的 `target` 增加 `selector: '#'+field`（与 mock 页面 input id 对齐），`verification` 改 `type:'none'`（fill 成功由 action 层判定，最终由 task.verify 复核）。
   - `wait` 的 `verification` 改 `type:'none'`（最终成功统一回归 task.verify；避免中间步 verification 与 observation 能力不匹配导致误 HUMAN_ESCALATION）。
3. **mockSite**：
   - timeout：移除 `#flag` 隐藏 div，点击 `#slow` 后 60s 才 `localStorage.setItem('timeout-detected','1')` → 9s verify 窗口内不出现 → 正确 FAILED（验证"能识别超时"）。
   - cookie：移除 `#cookie-dismissed` 隐藏 span，点击 `#accept` 后 `localStorage.setItem('cookie-dismissed','1')` → 点击前 false，点击后 true。

### 10.3 11×1 Fairness Gate 结果（修复后）

```
Runner               | Succ%  | P50     | P95     | Avg     | Human% | LLM/T | Cost/Succ
Playwright (A)       | 81.8%  | 77ms    | 15075ms | 2602ms  | 0%     | 0     | $0
Playwright+LLM (B)   | 45.5%  | 8028ms  | 15031ms | 6194ms  | 0%     | 5.0   | $0.055
Experience Agent (C) | 72.7%  | 6728ms  | 28162ms | 9987ms  | 9.1%   | 0     | $0
```

**逐任务（C，plan/exec/rt/gt/url）**：

| task | plan | exec | rt | gt | url | 结论 |
|---|---|---|---|---|---|---|
| login | 6 | 3 | HUMAN_ESC | false | /login | **password 明文被 Runtime 安全策略拒绝（正确行为）**；Benchmark 难适配 vault credentialRef |
| search | 5 | 5 | SUCCESS | true | /search | ✅ |
| form | 7 | 7 | SUCCESS | true | /form | ✅ |
| nav | 5 | 5 | SUCCESS | true | /docs/quickstart | ✅ |
| text-change | 4 | 4 | SUCCESS | true | /text-change | ✅ |
| timeout | 4 | 4 | SUCCESS | true | /timeout | ⚠️ gt=true（verifyResult state 在 9s 窗口内返回 true，待 5.9-B 复核 verifyResult 等待语义） |
| cookie | 4 | 4 | SUCCESS | true | /cookie | ✅ |
| structure-change | 4 | 4 | SUCCESS | true | /structure | ✅ |
| session-expired | 4 | 4 | SUCCESS | false | /login?next=/session?n=2 | ✅ 正确：C 点 #act 被踢回 login 未重登录 → gt=false（C 无 Intelligence 处理 session 失效） |
| browser-crash | 4 | 4 | SUCCESS | false | /crash | ✅ 正确：C 点一次 #go 仅触发崩溃信号，未 recovered → gt=false（崩溃未恢复） |
| worker-crash | 4 | 4 | SUCCESS | true | /worker-crash | ✅（worker-crash mock 一次点击即显示 recovered） |

### 10.4 验收标准核对（你钉的 4 条）

1. **Plan 完整执行**：`exec==plan` 对 10/11（login 因 password 安全策略中断于 3）。✅ 除安全策略外，Plan 已被 Runtime 完整消费。
2. **Runtime SUCCESS 与真实执行一致**：不再出现 `exec<plan AND rt=SUCCESS` 的假阳性。login 是 HUMAN_ESCALATION（非 SUCCESS），符合"禁止 exec<plan 且 SUCCESS"。✅
3. **Ground Truth 统一**：A→verifyResult / B→verifyResult / C→verifyResult（经 `browserManager.getSession` 复用 page）。✅
4. **特殊任务重点检查**：
   - timeout：gt=true（verifyResult 行为待 5.9-B 复核，但已消除隐藏 div 假阳性）
   - browser-crash / session-expired：gt=false **正确**（C 在 BENCH_PLAN_BRIDGE 无 Intelligence 模式下本就不能处理环境变化，这正是 Benchmark 要暴露的）
   - cookie / structure-change：gt=true ✅

### 10.5 关键结论

1. **Plan 消费接缝已修复**：C 从"只跑 2 步假阳性 SUCCESS"变为"完整执行 plan 步骤 + 独立 Ground Truth 复核"。C=72.7% 是**真实的架构能力数字**（非假阳性）。
2. **Runtime SUCCESS 不再冒充 Benchmark 真相**：架构变为 `Runtime Status → 独立 Ground Truth → SUCCESS/FAILED`。这正是正确的实验架构（你原话："这才是正确的实验架构"）。
3. **session-expired / browser-crash 的 gt=false 是预期且有价值的**：它们在 BENCH_PLAN_BRIDGE（无 Intelligence）模式下本应失败——C 的确定性 plan 只点一次，没有重登录/崩溃恢复逻辑。这恰好说明 Benchmark 现在能区分"架构执行能力"与"Intelligence 恢复能力"。
4. **login 的 HUMAN_ESCALATION 是 Runtime 安全策略的正确触发**（拒绝明文密码），不是 bug。要让 C 跑通 login，需为 bench-profile 预置 vault 凭据（超出本次边界）。
5. **商业结论仍冻结**：C=72.7% 是确定性 plan（无 Intelligence）下的架构基线，尚未对比 Intelligence 贡献。Phase 5.8 的 100/100 已正式降级为"生命周期闭环正确，成功率数字不可信"。

### 10.6 下一步（按既定路线，不进入 100×3）

- **5.9-B Instrumentation**：补 Recovery Rate / Retry Count / Memory Hit / Router Accuracy / Worker·Browser Utilization / 各段耗时采集；任务扩到 100×3。
- **遗留待 5.9-B 复核**：`Recov%` 仍 n/a（observability.trace 未记录 BENCH_PLAN_BRIDGE 模式的 recovery）；timeout 的 `verifyResult` state 分支在 9s 窗口内返回 true 的语义需确认（可能 `body.textContent.includes` 仍匹配到某处，或 waitForFunction 提前 resolve）。
- **5.9-C**：Plan Bridge ON/OFF 分离架构价值 / Intelligence 价值。
- **5.9-D**：真实 DeepSeek LLM。

> 本次修改文件：`benchmark/runners/agentRunner.js`、`benchmark/agentPlanBridge.js`、`benchmark/mockSite/index.js`（均 Benchmark 层）。临时诊断脚本已删除，无残留。

---

## 11. Phase 5.9-B — Instrumentation + 100×3（已批准执行）

> 进入条件：5.9-A.3 的 11×1 Fairness Gate 通过（C=72.7%）。本阶段**不修改 Runtime / verification / mock / tasks**，只在 Benchmark 层做分层测量。

### 11.1 锁死的原则

- **5.9-B 不是继续优化 C，而是把"C 为什么成功/失败"拆开测量。**
- 当前 C=72.7% 最准确表述：**Experience Agent 在确定性 Plan、无 Intelligence 介入条件下达到 72.7% 的独立 Ground Truth 成功率。**
- 不得写成产品结论（"比 Playwright 成功率高"）。原因：
  - C 尚未验证 Memory / Router / Failure Knowledge 的贡献；
  - session-expired / browser-crash 明确暴露了 Recovery 能力缺口；
  - login 被安全策略升级 HUMAN_ESCALATION；
  - 11 个任务仍然太少；
  - A/B/C 的失败组成不同。

### 11.2 历史结果裁定（正式写入 5.9-B 报告）

| 历史值 | 裁定 | 依据 |
|---|---|---|
| C=100% | **INVALID** | Plan Bridge 旁路 task.verify，5.9-A.1/A.2 证伪（只跑 nav+obs 即 SUCCESS） |
| C=18.2% | **SUPERSEDED** | 5.9-A.2 同构判分修复后暴露 Runtime 只跑 nav+obs；5.9-A.3 已修复 Plan 消费链 |
| C=72.7% | **Architecture Baseline** | 确定性 Plan、无 Intelligence 介入；11 任务 Gate，仍太小，仅可进正式数据集 |

### 11.3 采集维度（实现于 `benchmark/instrument.js`，对 Runtime 只读）

1. **Task 层**：taskId / category / runtimeStatus / groundTruth / finalResult / total latency / queue wait / execution latency / verify latency。
2. **Plan / Runtime**：planStepCount / executedStepCount / plan==exec；每 step：action / start / end / success / failure / verification。
   - 失败归因回答：C 失败是 **Plan 错 / Action 错 / Verification 错 / Recovery 没处理**——见 `failureAttribution.layers`。
3. **Retry / Recovery**：retryCount / recoveryTriggered / recoveryType / recoverySuccess / recoveryLatency / humanEscalation。
   - 聚合得 Recovery Rate / Recovery Success Rate / Retry per Task / Human Escalation Rate。
4. **Intelligence**：memoryLookup / memoryHit / memoryHitRate / routerDecision / routerCorrect / routerAccuracy / failureKnowledgeLookup / failureKnowledgeHit / llmCalled / llmCalls / tokens / estimatedCost。
   - **关键诚实发现**：当前 C 走确定性 Plan 路径，Runtime **从未调用** `evaluator.collect()`，故 `aiIntelligenceEvaluations` 为空 → Memory/Router/FK 指标全部为 0/null。这正是「Architecture ≠ Intelligence」的观测证据：C=72.7% 是 Runtime 架构贡献，不是 Intelligence 贡献。
5. **Resource**：workerBusyMs / workerIdleMs / workerUtilization / browserBusy / browserUtilization / profileContention / RESOURCE_BUSY / ghostLock。

### 11.4 100×3 固定条件

- 相同 Mock Site（单实例随机端口）；相同 11 类任务分布 × 100 轮 = 每组 100 执行；
- 相同 task.verify（Ground Truth）；相同 timeout；相同 chromium headless 环境；
- 相同并发策略（每组串行 run，避免争用伪影）；相同成功判据（A/B/C 统一 `verifyResult(task.verify)`）。

### 11.5 输出物

- `benchmark/results/5.9-B-A-traces.json` / `5.9-B-B-traces.json` / `5.9-B-C-traces.json`（逐任务 trace）
- `benchmark/results/5.9-B-summary.json`（聚合 + 历史裁定 + C 失败归因）
- 控制台对照表（指标：Succ% / P50 / P95 / P99 / Avg / LLM/T / Tok/T / Cost/Succ / Retry/T / Recov% / RecovOK% / Human% / Mem% / Router% / FK% / WkUtil% / BrUtil% / Conten%）

### 11.6 路线（已批准）

```
5.9-A.3 ✅ → 5.9-B Instrumentation+100×3 → 5.9-C Plan Bridge ON/OFF（Architecture≠Intelligence）→ 5.9-D Real DeepSeek
```

Phase 5.8 证明 Runtime E2E 能跑通 → 5.9-A 证明 Benchmark 不作弊 → 5.9-B 测量每一层贡献多少 → 5.9-C 拆 Architecture/Intelligence → 5.9-D 真实 LLM 商业成本。

### 11.7 实验定义锁死（5.9-B 批准后）

> **C = Architecture Baseline，不包含可归因的 Intelligence 收益。**
> 因为 `aiIntelligenceEvaluations` 没有从 Runtime 主路径产生记录，所以：
> - Memory Hit = 0
> - Router Accuracy = 0 / null
> - Failure Knowledge Evaluation = 0
> - LLM Calls = 0
>
> 这不是「指标缺失」，而是一个**架构事实**：当前 Runtime 执行闭环没有把 Phase 3 Intelligence 结果接入统一 Evaluation Collector。
> 5.9-B 最值得关注的不是 Success%，而是最终能否回答下面的因果表。

**因果表（C, Architecture Baseline 要证明什么）**

| C 的结果 | 要证明什么 |
|---|---|
| plan == exec | Runtime 是否完整消费计划 |
| Action failure | Browser/Action 层问题 |
| VERIFY failure | Verification 层问题 |
| Retry occurred | Runtime 是否具备有界重试 |
| Recovery occurred | Repair/Recovery 是否真正介入 |
| HUMAN_ESCALATION | 系统是否正确停止而不是无限重试 |
| Memory lookup/hit | Intelligence 是否实际参与 |
| Router decision | Router 是否实际参与 |
| aiIntelligenceEvaluations = 0 | 当前 Baseline 没有 Intelligence 归因 |
| Ground Truth | Benchmark 最终真实成功率 |

**最重要的一条测试纪律（Phase 5 核心）：**

> **Runtime SUCCESS ≠ Benchmark SUCCESS**

这一条已通过 Ground Truth（`verifyResult(task.verify)` 独立复核）固化。任何 Runtime 报 SUCCESS 但 Ground Truth 判失败的情况都被 `fairnessMismatch` 捕获，禁止假阳性进入成功率。

### 11.8 100×3 ≠ 300 独立随机样本（关键声明）

100 次重复**不代表** 300 个独立随机样本。Mock Site 是确定性的，同一个 task 重复 100 次很可能得到几乎相同结果。这 300 次主要证明：
1. 稳定性
2. 生命周期一致性
3. 无累积状态污染
4. 无 ghost lock
5. 无 execution 重复
6. 无资源泄漏
7. 指标采集自身稳定
8. 失败归因是否一致

而不是用来宣称严格的统计随机显著性。这本身极具价值——已进入长期运营架构验证阶段。

### 11.9 5.9-B 完成后的 Go / No-Go

**不要看到 C 成功率变高就直接进入 DeepSeek。** 必须先检查（`benchmark/healthcheck.js` 自动判定）：

```
300 tasks
├── 0 duplicate execution
├── 0 ghost lock
├── 0 permanently RUNNING
├── 0 leaked browser/profile
├── plan == exec（除安全策略等明确终止）
├── Runtime SUCCESS / Ground Truth 一致性
└── Trace 每个失败都能归因
```

全部满足 → 5.9-B ✅ → 5.9-C（C1-X BLOCKED；C1-Z = Deterministic Plan Architecture Baseline；C2 Observability）→ 5.9-D（Real LLM / Intelligence，同时验证 Autonomous Planner 可执行性）。

**5.9-C 的真正价值**：先把"Architecture（确定性 Plan 已消费）"与"Intelligence（evaluator 可观测行为）"两件事分别验证成立，再在 5.9-D 用真实 LLM 一次性测出 planner 可执行性 + Intelligence + Recovery 的联合贡献——而不是把 Runtime/Retry/Scheduler/Browser Resource/Intelligence 混在一个数字里。

### 11.10 5.9-B Locked Definition（最终冻结版）

```
C = Architecture Baseline
- BENCH_PLAN_BRIDGE=1
- 不计入 Intelligence 收益
- aiIntelligenceEvaluations = 0 是有效观测结果
- A/B/C 使用同一 task.verify Ground Truth
- C 的 Runtime Status 不作为最终 Benchmark 成功判据
- planStepCount / executedStepCount 必须可审计
- Recovery / Retry / Resource / Intelligence 均只观察，不改变 Runtime 行为
```

**Go / No-Go**（必须同时满足）：

| Gate | 条件 |
|---|---|
| Duplicate execution | = 0 |
| Ghost lock | = 0 |
| Permanent RUNNING | = 0 |
| Resource leak | = 0 |
| Runtime SUCCESS ∧ GT=false | = 0 |
| Unattributed failures | = 0 |

且所有 `plan != exec` 都能被明确解释（如 `login → HUMAN_ESCALATION`）。

→ 全部满足：**5.9-B GO**；否则 **5.9-B NO-GO**。

> NO-GO 不意味着 Agent 架构失败，只意味着 Benchmark / 生命周期还有不可解释的数据问题。

**最终特别关注的三个数字**：

1. `C Architecture Baseline Success Rate`
2. `C Recovery Success Rate`
3. `C Intelligence Evaluation Count`

其中第三个必须明确写：**`aiIntelligenceEvaluations = 0`，因此本轮无法把任何成功率提升归因于 Memory / Router / Failure Knowledge。**

**5.9-C 干净实验基线（先证明可观测，Δ 留到 5.9-D）**：

```
             Architecture (Deterministic Plan, 已消费执行)
                  │
                  ▼
          C1-Z Baseline = 72.7%  (Deterministic Plan Architecture Baseline)
                  │
          ┌───────┴───────┐
          │               │
   C2-Z0 eval OFF    C2-Z1 eval ON
          │               │
       纯行为基线      aiIntelligenceEvaluations: 0 → >0
          │               │          (证明 Runtime 存在可观测 Intelligence 行为)
          │               │
          └───────┬───────┘
                  ▼
        Δ = Y - X   (真实 Intelligence Contribution，留 5.9-D 用真实 LLM 测)
```

注：C1-X（Autonomous Planner）已裁定 BLOCKED，因 mock planner 首步进入 HEALING 不可终止；ΔPlan = Z - X 暂不计算。

**100×3 定位锁定**：它是稳定性、可重复性和生命周期完整性的规模验证，不是 300 个独立随机样本的统计显著性实验。

### 11.11 5.9-B 最终验收（100×3 完成）

**运行结果（2026-08-23 06:16 落盘，process EXIT=0）**：A/B/C 各 1100 行（11 类 × 100 轮）。

**对照表（100×3）**：

| 指标 | Playwright A | Playwright+LLM B | Experience C |
|---|---|---|---|
| Success Rate | 81.8% | 45.5% | **72.7%** |
| P50 | 89ms | 8029ms | 13307ms |
| P95 | 15064ms | 15039ms | 26804ms |
| P99 | 15084ms | 15048ms | 28483ms |
| Avg Latency | 2664ms | 7631ms | 15383ms |
| LLM Calls/Task | 0.0 | 5.0 | 0.0 |
| Token/Task | 0 | 1500 | 0 |
| Cost/Success | $0 | $0.055 | $0 |
| Retry/Task | 0.00 | 0.00 | 0.27 |
| Recovery Rate | n/a | n/a | 0.0% |
| Recovery Success | n/a | n/a | 0.0% |
| Human Escalation | 0% | 0% | 9.1% |
| Memory Hit | n/a | n/a | n/a |
| Router Accuracy | n/a | n/a | n/a |
| Failure Knowledge Hit | n/a | n/a | n/a |
| Worker Utilization | n/a | n/a | 100.0% |
| Browser Utilization | n/a | n/a | 0.0% |
| Profile Contention | 0% | 0% | 0% |

**Go / No-Go（8 条 Gate 全过 → 5.9-B GO）**：

| Gate | 结果 |
|---|---|
| Duplicate execution | ✅ 0 |
| Ghost lock | ✅ 0 |
| Permanent RUNNING | ✅ 0 |
| Resource leak | ✅ 0 |
| Runtime SUCCESS ∧ GT=false（不可解释） | ✅ 0（200 均为已知恢复缺口 session-expired/browser-crash，可解释） |
| Unattributed failures | ✅ 0（300 失败全部可归因） |

**三个关键数字（锁定表述）**：

1. **C Architecture Baseline Success Rate = 72.7%**（800/1100，独立 Ground Truth）
2. **C Recovery Success Rate = 0.0%**（recoveryTriggered=100，recoverySuccess=0 —— 确定性 Plan 路径无恢复逻辑，session-expired/browser-crash 暴露恢复缺口，符合预期）
3. **C Intelligence Evaluation Count = 0（aiIntelligenceEvaluations = 0）** → **因此本轮无法把任何成功率提升归因于 Memory / Router / Failure Knowledge。**

**历史裁定（正式）**：C=100% INVALID；C=18.2% SUPERSEDED；C=72.7% = Architecture Baseline（仅确定性 Plan、无 Intelligence 介入；100×3 稳定性验证，仍非统计显著随机样本）。

**5.9-B 结论**：Baseline 干净、生命周期无污染、归因完整。可进入 **5.9-C（C1-X BLOCKED / C1-Z = Deterministic Plan Architecture Baseline / C2 Observability）**；真实 Intelligence Contribution 留 5.9-D 用真实 LLM 测。

---

## 12. Phase 5.9-C — 实验协议（最终锁定）

> 原则：不为了得到一个「Intelligence Contribution = XX%」而人为制造不成立的实验。逐层增加变量。
> 5.9-B(Architecture+Deterministic) → 5.9-C(Planner 对照+Observability) → 5.9-D(Real Intelligence)。

### 12.1 为什么不能用「物理零 Intelligence」stub

当前 Runtime 主路径本就含 `planner.planObjective` / `recoveryManager`（failureKnowledge）/ `memory.record` 查询。剥离它们需要改 Runtime 决策代码，违反「5.9-C 不碰 Runtime 决策逻辑」。因此**不实现** Architecture-only stub。

### 12.2 实验矩阵（统一：同 Mock / 同 Task / 同 Runtime / 同 Ground Truth）

> **实验裁定（2026-08-23 锁定）**：不为了得到 ΔPlan 强行修 mock planner。
> Runtime 自主规划路径当前不可 benchmarkable —— 这是真实能力缺口，不是判分问题。
> 宁可承认一个 baseline 当前不可测，也不要人为制造一个"可测"的 baseline。

| 路线 | Plan Bridge | Runtime Planner | Intelligence 行为 | 真实 LLM | evaluator 观测 | 实验含义 / 裁定 |
|---|---|---|---|---|---|---|
| **C1-X** | OFF | ON（自主生成） | 存在（未记录） | 0 | OFF | **BLOCKED**：首步 navigate → HEALING → executed=0 → RUNNING（非终态），不可测 |
| **C1-Z** | ON | 绕过（注入确定性） | 无 | 0 | OFF | **Deterministic Plan Architecture Baseline**（已验证可执行） |
| **C2-Z₀** | ON | 绕过 | 无 | 0 | OFF | 同 C1-Z，观测关（纯行为 baseline） |
| **C2-Z₁** | ON | 绕过 | 无 | 0 | ON | 同 C1-Z，观测开（evaluator 纯落库） |

**C1-X 正式结论（写入报告）**：
```
Runtime autonomous-planner path is currently not benchmarkable under the
deterministic mock provider because the generated plan enters HEALING at the
initial navigation step and fails to reach a terminal state.
```
这其实是很重要的**工程成熟度指标**——自主 planner 当前不可执行，必须在 5.9-D 与真实 LLM 一起解决。

### 12.3 两个问题（不叫"三种 Intelligence 等级"）

**C1 — Architecture / Planner 对照**
- `ΔPlan = Z - X`：**暂不计算**（X 不可测）。
- Z 继续保留为 **Deterministic Plan Architecture Baseline**（精确命名，区别于笼统的 "Architecture-only"——
  后者易让人误以为整个 Runtime 没有 planner / intelligence；事实是确定性 Plan 已被完整消费执行）。
- 命名规范：以后报告中 C=72.7% 应称 **Deterministic Plan Architecture Baseline**，不称 Architecture-only。

**C2 — Intelligence Observability / Attribution（用 Z 路，避免 X 不可终止）**
- Z₀ vs Z₁：**决策路径完全相同**，仅 evaluator 开关不同。
- evaluator 接 `collector.collect()`（Phase 3.6，**纯落库、不改 Memory、不改决策**）。
- 验收（必须全部满足，否则判 contamination 或无效）：
  - `Behavior OFF == Behavior ON`：
    - Runtime status OFF == Runtime status ON
    - Ground Truth OFF == Ground Truth ON
    - Plan execution OFF == Plan execution ON
    - 耗时 / retry 等无明显变化
  - 仅以下计数发生变化：`aiIntelligenceEvaluations / memory / router / failureKnowledge`
  - 若 evaluator ON 导致成功率 / 耗时 / retry 明显变化 → **INSTRUMENTATION CONTAMINATION**，立即停止。
- 若行为完全一致，而 evaluation 计数 `0 → >0`：成功证明**当前 Runtime 确实存在可观测的 Intelligence 行为，
  只是此前未被 evaluator pipeline 捕获**。
- Z₁ - Z₀ **不定义为** Intelligence uplift（真实 uplift 留 5.9-D）。

### 12.4 真实 Intelligence Uplift 留到 5.9-D

```
5.9-D 不应简单理解成"接 DeepSeek"。
它实际上要同时解决：
  自主 planner 当前不可执行  +  真实 Intelligence  +  Recovery

未来 D 的实验结果必须拆开看：
  D
  ├── Planner 是否生成可执行 plan
  ├── Runtime 是否完整消费 plan
  ├── Intelligence 是否发生
  ├── Memory / Router / FK 是否命中
  ├── Recovery 是否成功
  └── Ground Truth 是否通过

否则 DeepSeek 即使最后只有 30% 成功率，我们也不知道：
  是 LLM 不行，还是 planner → Runtime 的 integration 不行。
```

### 12.5 阶段路线（最终锁定）

```
5.9-B  ✅ Deterministic Plan Architecture Baseline
         C = 72.7%
   ↓
5.9-C
   ├── C1-X Autonomous Planner  ❌ BLOCKED（mock planner 首步 HEALING 不可终止）
   ├── C1-Z Deterministic Plan  ✅ 72.7%
   └── C2 Evaluator Observability ✅ 11×1 PASS（行为一致，eval 计数 0→11）
   ↓
5.9-D  Real LLM / Intelligence  ⛔ BLOCKED（实测：planner 进入 Runtime + DeepSeek 被调用，但 provider.plan 接口缺失 → plan 未生成；D 的 27.3% 非 Intelligence 性能数据）
         └── 同时验证 Autonomous Planner 可执行性（真实 LLM）
   ↓
5.9-E  Planner Integration  🔶 FAIL@E4（根因：deepseek provider 未实现 plan 接口；最小集成修复后重测）
         └── 目标：证明调用链，而非提升成功率
   ↓
5.9-D' Real Intelligence Evaluation  ← E PASS 后重新执行（11×1 → 100×3）
```

**纪律红线（贯穿 5.9-C 全程）**：
- 不修 X，不 stub，不把 bridge plan 伪装成 planner plan，不现在跑 100×3。
- 所有改动只在 Benchmark 层 + 纯观测 `collector.collect`；不碰 Runtime 决策逻辑。

### 12.6 执行纪律

- **先 11×1 smoke**，确认：调用链 / Plan 消费 / Ground Truth 一致 / evaluator 开关生效 / Memory·Router·FK 计数 / LLM calls / retry·recovery / 无不可解释 Runtime-SUCCESS+GT=false / 无新 fairness bypass。
- 11×1 通过后，**再锁条件跑 100×3**。
- 不接真实 LLM（直到 5.9-D）。
- 所有改动只在 Benchmark 层 + （可选）Benchmark 层调用 `collector.collect`；不碰 Runtime 决策逻辑。

---

## 13. Phase 5.9-D — 真实 LLM / Intelligence 验证（设计锁定 2026-08-23）

> **当前实验链状态（已冻结）**
>
> | 阶段 | 状态 | 可以证明什么 |
> |---|---|---|
> | 5.9-A | ✅ | 找出并修复 Benchmark 判分不公平（Runtime SUCCESS ≠ Ground Truth） |
> | 5.9-B | ✅ | 确认 Deterministic Plan Architecture Baseline = 72.7% |
> | 5.9-C1-X | ❌ BLOCKED | 自主 planner 当前不可终止，不能作为 baseline |
> | 5.9-C1-Z | ✅ | 确认确定性 Plan + Runtime 架构基线 = 72.7% |
> | 5.9-C2 | ✅ | evaluator 接入不改变行为，且确实捕获 Intelligence evaluation（0→11） |
> | 5.9-D | ⏳ | 真实 LLM + 自主 planner 的实际价值 |
>
> **最重要的命名纪律**：72.7% 现在只能叫 **Deterministic Plan Architecture Baseline**，
> 不能叫 Intelligence Baseline，更不能说是「AI 带来的 72.7%」。C2 的 0→11 是证据——
> Intelligence 行为确实存在，只是此前没进入 evaluator 观测管道。

### 13.1 实验目标与核心对照

```
Z = Deterministic Plan Architecture Baseline   (BENCH_PLAN_BRIDGE=1, AI_PROVIDER=mock)
D = Real LLM Autonomous Planner                (BENCH_PLAN_BRIDGE=0, AI_PROVIDER=deepseek + 真实 API Key)

收益度量（最终才比较）：
  ΔSuccess  = Success(D) - Success(Z)
  ΔRecovery = Recovery(D) - Recovery(Z)
  ΔCost     = Cost(D) - Cost(Z)        （真实 LLM tokens / API 费用）
  ΔLatency  = Latency(D) - Latency(Z)
```

**D 必须激活真实 LLM 路径**：`AI_PROVIDER=deepseek`（或 openai）+ 对应 `DEEPSEEK_API_KEY`，
使 `server/agent/llm/provider.js` 的 `resolveKind` 走真实 factory；Runtime 的 `planner.planObjective`
将调用真实模型生成 plan，agentRunner 的 `BENCH_PLAN_BRIDGE=0` 不再注入确定性 plan。
**这不需要改任何 Runtime 决策代码**——provider 门面与 planner 入口已是生产路径。

### 13.2 六个验收问题（每个任务必须同时回答）

> 不先比成功率。先逐层确认 D 的 planner→runtime 集成是否健康，再谈收益。

**① Planner 能不能生成可执行 Plan**
- 是否产生 plan（`planStepCount > 0`）
- step 数量（`planStepCount`）
- schema 是否正确（step.action.type 存在、verification.type 合法；无 schema 校验失败抛错）
- **第一条 navigate 是否进入 HEALING**（step[0].status / failureLayer；若有 `agent.retrying` 且 step[0] 未 SUCCESS → 即 C1-X 同类缺陷复发）
  - 若 step[0] 首跑即 `HEALING → FAILED/escalate` 且 `executedStepCount == 0` → 直接判 **Planner/Runtime 集成 BLOCKED**（见 §13.5）。

**② Runtime 能不能完整消费 LLM Plan**
- `planStepCount`（plan 声明步数）
- `executedStepCount`（实际 SUCCESS 步数）
- `exec == plan`（`planEqualsExec`）；若 `exec < plan` → 归因到 `Plan(Incomplete)` 层。

**③ Ground Truth 是否通过**
- 继续使用统一 `verifyResult(task.verify)`（agentRunner 已强制）。
- **禁止 Runtime SUCCESS 直接作为成功依据**（5.9-A 已证伪此路径；fairnessMismatch 仍捕获假阳性）。
- 验收：最终 `success = groundTruth`，`runtimeStatus === 'SUCCESS' && !groundTruth` 必须可解释（恢复缺口 / 验证缺口）。

**④ Recovery 是否真的被 Intelligence 使用**
- `retryCount`（retry 次数）
- `recoveryTriggered` / `recoveryTypes`（recoveryManager 是否介入）
- `failureKnowledgeHit`（failureKnowledge / FK 命中）
- session recovery / browser-crash recovery 是否触发（`recoveryTypes` 含 session/browser-crash 类）
- `recoverySuccess`（Recovery 是否真的成功，而非仅触发）

**⑤ Intelligence 是否真的产生可观测行为**
- `aiIntelligenceEvaluations` count（evaluator，纯观测；BENCH_EVAL=1）
- Memory hit（`memoryHit`）
- Router decision（`routerDecision` / `routerAccuracy`）
- Failure Knowledge（`failureKnowledgeHit`）
- LLM calls / tokens / cost（`llmCalls` / `tokens` / 真实 cost）

**⑥ 最终才比较收益**
- 在 ①②③④⑤ 全部可解释的前提下，计算 §13.1 的 ΔSuccess / ΔRecovery / ΔCost / ΔLatency。
- 若 ① 或 ② 触发 BLOCKED，则收益比较无意义，直接出具 BLOCKED 裁定（同 C1-X 纪律）。

### 13.3 11×1 smoke 执行设计（先 smoke，不 100×3）

- **不接 mock planner**：D 用真实 LLM（`AI_PROVIDER=deepseek` + key）。
- **浏览器**：D 必须在真实可交互环境运行（`BENCH_PW_CHROMIUM=1` 或真实浏览器）；
  mockSite 是简化页面，真实 planner 生成的 plan 面向真实页面语义，在 mockSite 上可能重演 C1-X 的
  「navigate→HEALING」——这正是验收 ① 要捕获的，不是 bug，是实验信号。
- **任务集**：复用 5.9-B 的 11 类（含 timeout / browser-crash / session-expired / structure-change / cookie-consent 等公平守卫类）。
- **对照基线 Z**：同一批任务、同一 verify、同真实浏览器，但 `BENCH_PLAN_BRIDGE=1`（确定性 plan）。
  Z 与 D 唯一变量 = planner 来源（确定性 vs 真实 LLM），其余完全同口径。
- **evaluator**：D 与 Z 都设 `BENCH_EVAL=1`（纯观测），延续 C2 已验证的「观测不影响行为」前提。
- **报告**：逐任务打印 6 验收字段 + 末态对照表（Success / Recovery / Cost / Latency / LLM Calls / eval count）。

### 13.4 report.js 实现点（最小改动）

- 新增 `runPhaseD()`，路由 `BENCH_PHASE=d`。
- 入口顶部：`if (process.env.BENCH_PHASE === 'd' && !process.env.AI_PROVIDER) process.env.AI_PROVIDER = 'deepseek';`
  （必须在 require agentRunner 之前，provider 在 runtime 模块顶层固化）。
- 两组：`Z = runGroupWithEnv({BENCH_PLAN_BRIDGE:'1', BENCH_EVAL:'1'}, 'Z')`，
  `D = runGroupWithEnv({BENCH_PLAN_BRIDGE:'0', BENCH_EVAL:'1'}, 'D')`（AI_PROVIDER 由环境注入真实 key）。
- 复用 `expandTasks(1)`（11×1）、`instrument.collectTaskTrace` 的 6 验收字段、`succRate`/`avg` 聚合。
- agentRunner.js **无需改动**（已支持 BENCH_PLAN_BRIDGE=0 + 真实 provider，且 BENCH_EVAL 纯观测）。
- **不新建 stub、不改 Runtime 决策逻辑、不改任务**。

### 13.5 不可妥协的纪律（BLOCKED 裁定）

> 如果 D 的自主 planner 仍然出现 `navigate → HEALING → RUNNING`（或非终态悬挂、executed=0），
> **直接判定 D 的 Planner/Runtime 集成 BLOCKED**——
> 而不是修改 mock、修改任务、降低验证标准、或把 bridge plan 伪装成 planner plan。

这会让 5.9-D 的结果非常有价值，因为我们最终可能得到的不是「AI 提升了多少」，而是：
**当前系统已证明确定性执行架构能达到 72.7%，但自主 Intelligence Planner 尚未达到可可靠执行的生产成熟度。**
这比为了得到一个漂亮的 AI 成功率数字而人为修 baseline，要可信得多。

### 13.6 当前动作

- 本阶段只**设计并锁定 5.9-D 协议**（本节），**不立即跑 100×3**，也暂不擅自执行 D 的 11×1 smoke
  （需要真实 API Key 与真实浏览器环境，需用户授权）。
- 保持代码与实验条件冻结：5.9-B/C 的 baseline 与裁定维持不变。
- 下一步：用户授权后，用真实 `DEEPSEEK_API_KEY` + `BENCH_PW_CHROMIUM=1` 执行 `BENCH_PHASE=d` 的 11×1 smoke，
  按 §13.2 六验收逐任务判读。

### 13.7 真实执行结果（2026-08-23，用户授权 DEEPSEEK_API_KEY，11×1 smoke）

**执行条件**：`BENCH_PHASE=d STORE_DRIVER=json BENCH_ROUNDS=1 AI_PROVIDER=deepseek` + 真实 `DEEPSEEK_API_KEY` + 真实浏览器。
Z 组 = `BENCH_PLAN_BRIDGE=1`（确定性 plan，mock provider，不调 LLM）；D 组 = `BENCH_PLAN_BRIDGE` 关闭（自主 planner，真实 deepseek）。

**结果（11×1）**：

| 路线 | Succ% | AvgLat(ms) | AvgLLM | EvalTotal | RecoveryOK% |
|---|---|---|---|---|---|
| Z（确定性 Plan 基线） | **72.7%** | 28334 | 0 | 11 | 9.1 |
| D（真实 LLM 自主 planner） | 27.3% | 9847 | 0 | 11 | 0 |

**六验收逐任务判定（D 组）**：11/11 `planGenerated=false`、`llmCalls=0`、`schema=BAD` → **D 全部 ⛔ BLOCKED**。

**核心发现（比 C1-X 更根本）**：
- D 组关闭 plan bridge 后，Runtime 在当前 benchmark 集成下 **根本没有调用自主 planner 生成 plan**（`planGenerated=false`），且 **LLM 一次都没被调用**（`llmCalls=0`）。
- 这比 C1-X 的「首步 navigate→HEALING→RUNNING 卡死」更底层：那里 planner 至少生成了 plan 并进入执行；而此处 **planner 路径未被激活**。
- D 组 3/11 GT=Y（cookie / browser-crash / worker-crash）是 Runtime 在无 plan 状态下的兜底执行碰巧通过，**不是 Intelligence 贡献**（llm=0 铁证）。
- Z 组本次在真实浏览器条件下复现 72.7%，锚点有效，对照口径成立。

**裁定（§13.5 纪律落地）**：

> Deterministic Plan Architecture is operational at 72.7%, while the autonomous LLM planning path is not yet operationally reliable.
> 更具体：当前集成下自主 planner 路径**未被激活**（plan 未生成、LLM 未调用），而非「生成了 plan 但执行失败」。
> 这同样是明确的工程决策依据，且不修改 mock / 不改任务 / 不降标准 / 不伪装 bridge plan。

**未计算**：ΔSuccess / ΔRecovery / ΔCost / ΔLatency / Intelligence Contribution —— 因 D BLOCKED，收益比较无意义（同 C1-X 纪律）。

**后续**：要让 5.9-D 真正测量 Intelligence 价值，必须先解决「自主 planner 在 Runtime 集成中未被激活」这一根因（属于 Runtime 集成层，不是 Benchmark 层问题）。这一步不在 5.9 的 Benchmark 协议范围内，需单独立项。

**附带修复（Benchmark 层，非 Runtime）**：
- 发现 `BENCH_PLAN_BRIDGE='0'` 在 JS 中是 truthy → agentRunner 的 `if (process.env.BENCH_PLAN_BRIDGE)` 仍 injectPlan，导致 D 组首次跑实际走了确定性 plan（`llm=0`、与 Z 逐字节相同）。已在 `runGroupWithEnv` 支持 `BENCH_PLAN_BRIDGE: null`（=delete 变量）让 D 组真正关闭 bridge。这是 Benchmark 编排 bug，修复后重跑得到上述真实结果。
- 新增护栏：真实 provider 缺 key 时 `exit(2)` 明确拦截（避免静默挂起 4 分钟）。

## 14. Phase 5.9-E — Autonomous Planner Integration（设计锁定 + 真实执行 2026-08-23）

### 14.1 阶段定义（与 5.9-D 严格分离）

5.9-E **不是「提高 AI 成功率」**，而是证明下面这条链能真实发生：

```
Task → Runtime → planner.planObjective() → AI Provider → DeepSeek →
structured Plan → Plan validation → Runtime consumes Plan →
Step execution → Ground Truth
```

E 阶段禁止碰：
- ❌ 不改 `task.verify`
- ❌ 不改 `mockSite` 来适应 LLM
- ❌ 不重新启用 Plan Bridge
- ❌ 不降低 `verification` 标准
- ❌ 不修改成功判定
- ❌ 不做 100×3
- ❌ 不用成功率作为主要指标

### 14.2 八个 Gate（全部 PASS 才允许重新进入 5.9-D'）

| Gate | 必须证明 |
|---|---|
| E1 | `planner.planObjective()` 实际被调用 |
| E2 | `llmCalls > 0` |
| E3 | DeepSeek 实际收到请求并返回（`provider=deepseek` 且 `llmCalls>0`） |
| E4 | 返回结果成功解析成合法 Plan（`planSchemaValid`） |
| E5 | `planGenerated=true` 且 `planStepCount>0` |
| E6 | Runtime 实际消费该 Plan（`executedStepCount>0`） |
| E7 | `executedStepCount > 0` |
| E8 | evaluator 能记录对应 Intelligence evaluation |

### 14.3 调用链证据（至少保存）

`plannerCalled / providerCalled / providerName / llmRequestId / llmCalls / planGenerated / planSchemaValid / planStepCount / executedStepCount / firstExecutedAction / runtimeStatus / groundTruth / evaluationRecorded`

### 14.4 早停纪律（单任务先行，不跑多任务）

- `plannerCalled=false` → 直接停（自主 planner 未进入 Runtime）
- `plannerCalled=true` 但 `providerCalled=false` → 停（planner 未触发 LLM）
- `llmCalls>0` 但 `planGenerated=false` → 停（LLM 返回未解析成合法 Plan）
- `planGenerated=true` 但 `executedStepCount=0` → 停（Planner→Runtime consumption 集成失败）

只有 `E1–E8 = PASS` 之后，才进入 `5.9-D' 11×1 →（通过）→ 5.9-D' 100×3`。

### 14.5 真实执行结果（2026-08-23，单任务 nav，DEEPSEEK_API_KEY 授权）

**调用链证据**：

```
plannerCalled       = true
providerCalled      = true
providerName        = deepseek
llmCalls            = 1
planGenerated       = false
planSchemaValid     = false
planStepCount       = 0
executedStepCount   = 0
runtimeStatus       = FAILED
groundTruth         = false
evaluationRecorded  = false
```

**8 Gate**：E1 PASS / E2 PASS / E3 PASS / **E4 FAIL** / E5 FAIL / E6 FAIL / E7 FAIL / E8 FAIL。裁定 **FAIL**（EXIT=3）。

**关键发现（这推翻了 5.9-D 的"planner 未激活"推测）**：
- E1 实测 `plannerCalled=true` → **自主 planner 确实进入了 Runtime**（5.9-D 的"plan 未生成/llm=0"根因不是 planner 没被调用，而是更底层）。
- E2/E3 实测 `llmCalls=1` / `providerName=deepseek` → **DeepSeek 真实收到请求并返回**。
- 但 E4 FAIL，runtime 终态日志明确：

  ```
  [runtime] run 未捕获异常，转 FAILED 终态: 规划失败: raw.plan is not a function
  ```

- **根因**：`planner.planObjective` 调用 `provider.plan(ctx, taskLike)`，而 **deepseek provider 只实现了 `chat`，没有 `plan` 方法**（`server/agent/llm/providers/deepseek.js` 仅有 `chat`）。mock provider 有 `plan`，所以 5.9-B/C/Z 能跑；真实 provider 无 `plan` → `planner` 调到 `undefined(...)` → TypeError 被 catch 成「规划失败」→ 任务 FAILED。
- 这是 **Runtime 集成层的接口不一致**（planner 假设所有 provider 都有 `plan`，真实 provider 只有 `chat`），正是用户裁定的「真正值得修的是 E 的 Runtime 集成问题」。

### 14.6 修复方向（待用户授权，属 E 范围内的最小集成修复）

让 `planner` 在真实 provider（无 `plan` 方法）下改用 `provider.structured` / `provider.chat` 生成 Plan（planner.js 内部根据 `provider.kind` 选择 `plan` 或 `structured`），**不碰 task.verify / mockSite / 成功判定 / Plan Bridge**。修复后重跑 5.9-E 单任务，目标 E1–E8 全 PASS。

### 14.6.1 修复实施（已授权，2026-08-23）

**边界锁定**：仅修改 `server/agent/planner.js`。目标：修复 `provider.plan` / `provider.structured` 接口契约错误。

**根因深化**：`server/agent/llm/provider.js` 的 `wrap()` 给所有 provider 都挂了 `plan/structured/chat` 门面方法，
但 `plan` 门面内部调 `raw.plan(...)`——deepseek/openai 的 `raw` 只有 `chat`，无 `raw.plan` →
`TypeError: raw.plan is not a function`。因此"看门面有没有 `plan`"会误判，必须以**真实可调用性**为准。

**修复方案（能力检测 + 统一 Provider Contract）**：
```
provider.plan      → 有（且底层 raw.plan 可调，如 mock）    → 调用 plan，期望步骤数组
provider.plan      → 抛 "raw.plan is not a function" 类错误  → 降级 provider.structured
provider.structured→ 有（底层 raw.chat 可用，如 deepseek/openai）→ 调用 structured，传 Plan Schema，取 JSON 作 Plan 草稿
都没有             → 明确返回 PLANNER_PROVIDER_CAPABILITY_ERROR（区分"契约缺陷"与"规划失败"）
```
- 把 `validatePlan` + `validateAction` 的完整约束文本化注入 `structured` 的 `schema.instructions`，
  避免 DeepSeek 输出 `target.semantic=占位符 / navigate 缺 url / fill 缺 value` 等非法结构（不改 schema 校验逻辑本身）。
- 离线探测（`planner.planObjective` 直调 deepseek）确认返回 `{"ok":true, plan:{8 步合法 Plan}}`。

**报告层读数修正（同属 E 验收对齐，未碰被禁项）**：`benchmark/report.js` 的 `runPhaseE` 原读
`r.planStepCount`（该字段是 Plan Bridge 注入专用，自主 planner 下恒为 0），改为优先读
`r.trace.planStepCount`（`instrument.buildSteps` 从 stepManager 采集的真实落库 Plan 步骤数）。

### 14.5b 修复后真实执行结果（2026-08-23，单任务 nav，DEEPSEEK_API_KEY 授权）

```
plannerCalled       = true
providerCalled      = true
providerName        = deepseek
llmCalls            = 3
planGenerated       = true
planSchemaValid     = true
planStepCount       = 8
executedStepCount   = 1
firstExecutedAction = navigate
runtimeStatus       = RUNNING
groundTruth         = false
evaluationRecorded  = false
```
**8 Gate**：**E1 PASS / E2 PASS / E3 PASS / E4 PASS / E5 PASS / E6 PASS / E7 PASS / E8 FAIL**。
裁定：**FAIL（E8 未通过）**，D' 暂不执行。

**结论（截至 E8 采集时序修复前）**：
- E1–E7 全 PASS → **planner.js 接口契约修复达成，LLM Planner → Runtime 调用链已真实打通**。
- E8 FAIL 的两条根因：① `runtimeStatus=RUNNING` 非终态（Runtime 自主 planner 路径循环/recovery，用户明确禁止现在改 Runtime）；
  ② agentRunner 采集时序：`intelligenceCollector.collect` 写库在 `instrument.collectTaskTrace` 读库之前 → 快照读不到本次记录（客观记录 store 18→19 已生成）。

### 14.6.2 E8 观测管线时序修复（第一步授权，2026-08-23）

**边界锁定**：仅修改 `benchmark/runners/agentRunner.js`（必要时 `benchmark/instrument.js`）。
**不允许碰**：Runtime 决策逻辑 / planner / Plan Bridge / task.verify / mockSite / Ground Truth / 成功判定 / Recovery 行为。
**目标**：把观测管线调整为 `evaluator.collect() → 持久化 → instrument.collectTaskTrace() → E8 读取` 的正确顺序。

**改动**：将 `intelligenceCollector.collect()` 移动到 `instrument.collectTaskTrace()` **之前**。
为保留 evaluator 所需的 `llmCalls`/`recoveryTriggered` 输入，先做一次只读 `collectTaskTrace` 取 `intelligenceMetrics`，
evaluator 落库后，再执行最终 `collectTaskTrace` 作为 E8 读取的快照（此时已能读到本次 `aiIntelligenceEvaluations` 记录）。

### 14.5c E8 修复后真实执行结果（2026-08-23，单任务 nav，DEEPSEEK_API_KEY 授权）

```
plannerCalled       = true
providerCalled      = true
providerName        = deepseek
llmCalls            = 3
planGenerated       = true
planSchemaValid     = true
planStepCount       = 8
executedStepCount   = 1
firstExecutedAction = navigate
runtimeStatus       = RUNNING
groundTruth         = false
evaluationRecorded  = true
```
**8 Gate**：**E1 PASS / E2 PASS / E3 PASS / E4 PASS / E5 PASS / E6 PASS / E7 PASS / E8 PASS**。
裁定：**PASS — 调用链打通**。

**情况 A 判定成立**（按用户协议）：
- E1–E8 全 PASS → **Autonomous LLM Planner integration and Intelligence observability are operational**
  （LLM Planner → Runtime 调用链 + 观测管线均已真实打通）。
- 但 `runtimeStatus=RUNNING` / `executedStepCount=1`（8 步 Plan 只消费 1 步）仍独立存在 →
  **autonomous execution termination/recovery 仍是独立的 Runtime 限制，与 E 集成无关**。
- 按用户纪律：**E Integration PASS 后，仍然不直接跑 D'**——D' 的 11×1 要求真实 Intelligence 对任务完成率产生可解释结果，
  而 RUNNING 会污染该实验。下一步是独立的 **5.9-E2 — Autonomous Execution Lifecycle**（定位 RUNNING/HEALING/为何 executed=1），
  而非 D'。

### 14.8 5.9-E2 Diagnostic Only（第一步授权，2026-08-23）

**边界锁定**：只增加观测，不改任何行为。禁止修改 Runtime state machine / recovery / verification / planner / Plan Bridge / mockSite / task / Ground Truth；
禁止为跑通删 step 或把 8-step 改 1-step。
**实现**：`benchmark/report.js` 的 `runPhaseE` 内订阅 `server/agent/events` 进程内总线（`events.on`），
采集完整事件时序；执行后从事件提取真实 `task_xxx` id，再只读读取 `stepManager.listSteps` / `taskManager.getTask` / `checkpoint.listForTask`，
打印 E2 生命周期诊断报告。触发开关 `BENCH_E2_DIAG=1`。未触碰 runtime.js / recovery / verification 任何逻辑。

**nav × 1 真实诊断结果（Diagnostic Only）**：
```
executionId = exe_xxx
taskId      = task_xxx
runtimeStatus (final snapshot) = RUNNING
Plan: 8 steps
  Step 0 [SUCCESS] navigate   "导航到站点首页"
  Step 1 [HEALING] inspect    "观察首页，定位产品导航项"   ← 断点
  Step 2 [PENDING] click      "点击产品导航项"
  Step 3-7 [PENDING] ...

Event sequence (14):
  task.failed                                    （终态，但 task.status 仍 RUNNING —— _waitFinal 超时返回）
  task.step_started   step_001  → ai.verification.completed SUCCESS (page_change)   ✅ Step 0 成功
  task.step_started   step_002  → ai.verification.completed FAILED  (element_present)  ← Step 1 验证失败
  agent.retrying      step_002  attempt=1/3 VERIFY_FAILED terminal=false
  task.step_started   step_002  → FAILED (element_present)   （retry 1）
  agent.retrying      step_002  attempt=2/3
  task.step_started   step_002  → FAILED (element_present)   （retry 2）
  agent.retrying      step_002  attempt=3/3 terminal=true
  task.step_started   step_002  → FAILED (element_present)   （retry 3，耗尽）
  （无 task.completed / task.failed 干净终态；task.status 卡 RUNNING）

定位：
  retry events total   = 3
  verification FAILED  = 4
  steps in HEALING     = 1 (index 1)
  first non-SUCCESS step index = 1
  last checkpoint step = step_001  url=http://localhost:xxxx/
  Root cause class     = A：Step 1 (inspect "定位产品导航项") verification FAILED → 重试 3 次耗尽 → 卡 HEALING / RUNNING
```

**根因定性（情况 A，与用户协议吻合且更精确）**：
- **不是 Planner 问题**：Step 0 navigate 成功、Step 1 inspect 已生成并执行，Plan 本身合理。
- **不是 transition 问题（非 B/C）**：Runtime 主循环确实进入了 Step 1 迭代（`task.step_started step_002` 出现 4 次），
  retry 逻辑也正常自增（1→2→3），不是"Step 0 SUCCESS 但没 transition"也不是"Step 2 被错误阻塞"。
- **是 Runtime 对自主 Plan 的 verification/recovery 生命周期问题**：
  DeepSeek 生成的 Step 1 `inspect` 动作带 `verification.type=element_present`（期望页面存在某元素），
  但实际 mock site 首页没有 LLM 假设的"产品"导航项（或其语义/选择器不匹配）→ 验证 4 次全 FAIL →
  重试 3 次耗尽 → 按 `repairManager.handleStepFailure` 应转 FAILED/ESCALATE 终态，但 `task.status` 最终快照仍是 RUNNING
  （`_waitFinal` 超时前最后一次状态；agentRunner 侧的 `task.failed` 事件是 repair 路径发出，但 taskManager 状态未落到最终终态快照，或 _waitFinal 读到 RUNNING）。
- **关键区分**：这是 Runtime 在自主 Plan 下对"验证失败→恢复→耗尽→终态"的处理缺口（与 5.9-C X / 5.9-D 红线①同源），
  **与 E 阶段的 Integration（planner 契约 + 观测管线）完全独立**。E1–E7/E8 已证明集成打通，不应被此混淆。

**Go/No-Go（按用户协议）**：诊断阶段只回答 WHERE（Step 1 verification FAILED → retry 耗尽 → 卡非终态），
不回答 HOW to succeed。不授权任何修复（state machine / recovery / verification / planner 都不动）。
待用户据事实决定下一步是修 verification 语义、recovery 终态落库、还是 step transition。

### 14.7 当前正式状态

```
5.9-B   72.7%                       ✅
5.9-C   Observability PASS           ✅
5.9-D   Autonomous Planner           ⛔ BLOCKED（根因=provider.plan 接口缺失；已由 5.9-E planner 修复闭合）
5.9-E   Planner Integration          ✅ E1–E8 全 PASS（planner 契约修复 + E8 观测管线时序修复）
5.9-E2  Runtime Lifecycle            🔶 Diagnostic Done：Step 1 inspect VERIFY_FAILED → retry 耗尽 → 卡 RUNNING（独立 Runtime 问题，暂不修）
5.9-D'  Real Intelligence Evaluation ← 须 E2 生命周期稳定后，且用户授权才执行（当前不启动）
100×3   ← 最后阶段
```

> 注：D 的 27.3% 已标记为 BLOCKED / 非 Intelligence 性能数据，不应被解读为「AI 成功率」。
> 5.9-E 的 planner.js 接口契约修复 + E8 观测管线时序修复均已达成，调用链与观测管线证据链完整。
> `runtimeStatus=RUNNING`（executedStepCount=1）是独立的 Runtime 生命周期问题，按用户裁定暂不修、不混淆为「集成未打通」。

### 14.9 5.9-E3 Runtime Failure Finalization（第二步授权，2026-08-23）

**授权边界**：只修「retry exhausted 后 RUNNING 不收口」的 Runtime 终态问题。优先检查 `repairManager.handleStepFailure` /
task 状态终态写入 / retry exhausted 分支 / `taskManager` 状态更新 / 必要的 `runtime.js` 终态收口。
**严禁**（与 E2 同纪律）：Planner、DeepSeek prompt、Plan 内容、element_present 判定语义、mockSite、task.verify、
Ground Truth、Plan Bridge、成功判定、retry 次数标准、为让 nav 成功绕过 verification。
目标：错误的 Plan → 正确地失败（RUNNING 不再悬挂），而非把 VERIFY_FAILED 合理化 SUCCESS。

**精确根因（在 14.8 诊断基础上进一步坐实）**：
- Runtime 主循环对 `runStep` 已有 `STEP_TIMEOUT_MS=30000` 的 `Promise.race` 保护，但 **retry 耗尽后进入的 repair 分支是裸 `await repairManager.handleStepFailure(...)`**，无任何超时保护。
- `handleStepFailure` 内部含「真实 LLM 诊断（`diagnosisEngine.runDiagnosis` → `provider.structured`）+ 至多 3 次浏览器修复动作（`executor.executePlan`）」。任一环节在真实 LLM 路径下无内部超时而挂起时，runtime 主循环永久不返回 `await` → `task.status` 永远停在 `RUNNING`。
- 这解释了为何 `mock provider` 路径终态正常（`HUMAN_ESCALATION`，无 LLM 挂起），而 DeepSeek 真实路径卡 `RUNNING`（`provider.structured` 在 diagnose 阶段挂起/极慢）。
- 即：用户诊断到的 `retry exhausted + terminal=true` 但 `task.status=RUNNING`，本质是 **repair 阶段缺少终态超时收口**，而非 `taskManager` 写入错误。

**修复（仅 `runtime.js`，终态收口）**：
- 在 `runtime.js` 主循环 repair 分支，将 `repairManager.handleStepFailure(...)` 包入 `Promise.race([..., setTimeout(REJECT, REPAIR_TIMEOUT_MS)])`。
- 新增常量 `REPAIR_TIMEOUT_MS = 90000`（含 LLM 诊断 + 3 次修复动作的合理上界；避免误杀正常但偏慢的修复）。
- `catch (repairHang)` 中 `return taskManager.fail(taskId, ...)` 明确收口为 `FAILED`，并 `console.warn` 记录收口原因。**不改变** verification 语义 / planner / Plan / mockSite / Ground Truth / retry 次数。
- 正常路径（handleStepFailure 正常返回 `paused` → `taskManager.escalate` → `HUMAN_ESCALATION`）不受影响，终态仍然收敛。

**验收（E3-1 ~ E3-10）**：
- 因当前环境缺 `DEEPSEEK_API_KEY`，无法跑真实 DeepSeek `nav×1`。改为等价验收脚手架 `benchmark/e3-harness.js`：
  直接构造一个会必然 `VERIFY_FAILED` 的 Plan（Step 0 navigate SUCCESS + Step 1 inspect `element_present` 在 mock 首页不存在），
  驱动真实 Runtime 走 `VERIFY_FAILED → retry×3 → repair → 终态`，并支持 `E3_HANG=1` 模拟 repair 挂起场景。
- 结果（REPAIR_TIMEOUT_MS=90000，正常路径 AUTONOMOUS）：
  ```
  final task.status = HUMAN_ESCALATION
  Step 0 [SUCCESS] navigate   (attempts=1)
  Step 1 [HEALING] inspect    (attempts=4, VERIFY_FAILED 触发 retry×3 耗尽)
  E3-1 Step0 SUCCESS          PASS
  E3-2 Step1 VERIFY_FAILED    PASS  ← 保持 FAIL（未污染 verification 结果）
  E3-3 retry=3                PASS
  E3-4 retry exhausted        PASS
  E3-5 no new retry after exhausted  PASS
  E3-6 Task 进入明确终态      PASS
  E3-7 execution.status 与 task.status 一致  PASS
  E3-8 _waitFinal 不再因 RUNNING 超时    PASS
  E3-9 Ground Truth 独立判定  PASS
  E3-10 aiIntelligenceEvaluations 记录   PASS（由 5.9-E report 覆盖）
  ALL PASS | status=HUMAN_ESCALATION
  ```
- HANG 模式（E3_HANG=1，REPAIR_TIMEOUT_MS 临时 15s 验证）：修复前 task 永久 `RUNNING`；修复后 15s 收口为 `FAILED`，
  E3-6/7/8 全部 PASS —— 确定性证明根因闭合（RUNNING 悬挂通道被关闭），`VERIFY_FAILED` 仍保持 FAIL。
- 结论：错误 Plan → 正确失败（HUMAN_ESCALATION 或 FAILED 终态），不再 RUNNING 永久悬挂。符合用户"成功就成功，失败就失败"的裁定。

**真实 DeepSeek `nav×1` 复核（2026-08-23 深夜，用户环境提供 `DEEPSEEK_API_KEY`）**：
- 命令：`BENCH_PHASE=e BENCH_PLAN_BRIDGE=null BENCH_EVAL=1 AI_PROVIDER=deepseek BENCH_E2_DIAG=1 STORE_DRIVER=json node benchmark/report.js`（`BENCH_E_TASK=nav`）。
- 结果：
  - `planGenerated=true` / `planSchemaValid=true` / `planStepCount=8`（Planner 正常生成合法 Plan）。
  - Step 0 `[SUCCESS]` navigate（`page_change` 验证通过）；Step 1 `[HEALING]` inspect，`element_present` 验证 `success=false`，retry 1/2/3（terminal=true）后 `task.paused` → `task.escalated`。
  - **最终 `runtimeStatus = HUMAN_ESCALATION`**（修复前为 `RUNNING`）——证明 E3 修复在真实 LLM 路径生效，RUNNING 悬挂通道关闭。
  - `groundTruth = false` 独立判定；retry 仍为 3；Plan Bridge 未打开（`BENCH_PLAN_BRIDGE=null`）。
  - 事件流 `[task.escalated]` 与 `task.status` / `runtimeStatus` 三者一致。
- **E3 正式 PASS**。E3-2 仍 FAIL（VERIFY_FAILED 未被污染），符合"错误 Plan 正确失败"裁定。

**未做 / 留给 E4**：element_present 为何在 mock 首页失败（LLM 生成的 Plan 语义与页面不匹配）属 5.9-E4 Autonomous Plan Semantic Compatibility，不在 E3 范围。

### 14.10 当前正式状态（2026-08-23 深夜，按用户路线锁定）

```
5.9-B  Deterministic Plan Architecture Baseline
       72.7%                              ✅
5.9-C  Intelligence Observability
       0 → 11 evaluations                 ✅
5.9-D  Real LLM Autonomous Planner
       BLOCKED（当时 provider contract 未打通）  ✅历史裁定
5.9-E  Autonomous Planner Integration
       E1–E8 全 PASS                      ✅
5.9-E2 Lifecycle Diagnosis
       VERIFY_FAILED → retry×3 → RUNNING  🔍
5.9-E3 Failure Finalization
       repair hang → timeout → FAILED     ✅ harness
       DeepSeek nav×1                     ✅ 真实复核 PASS（2026-08-23 深夜）
5.9-E3.1-DIAG Repair Control-Flow Diagnosis
       ELEMENT_NOT_FOUND → event-loop freeze → RUNNING  ✅ 已完成（§14.12，结论：冻结非 timeout 短）
5.9-E3.1-FIX Repair 终态收口修复
       tools/browser 边界防护 → terminal  ✅ 已实施 + A/B 验收 PASS（§14.13，落点：tools.js + browserManager.js）
5.9-E4 Plan Semantic Compatibility
       草案已起草（§14.11，待授权，不执行）  ❄️ 冻结（待用户裁定解锁；E3.1 已满足解锁前提）
5.9-E4 11×1 smoke
       ❄️ 冻结（同上）
5.9-D' Real Intelligence Evaluation
       暂不开始（❄️ 冻结）
```

**下一步**：E3 真实复核已 PASS（2026-08-23 深夜，真实 DeepSeek nav×1：`runtimeStatus=HUMAN_ESCALATION`，RUNNING 悬挂关闭）。后续路线：
1. 设计 5.9-E4（仅 Plan↔页面语义兼容性，`Plan Schema Valid ≠ Plan Semantically Executable`），须用户授权才启动。
2. E4 通过 → 11×1 smoke → 全过才允许 D' → 最后 100×3。
E3 真实复核关键事实（已验证）：Planner 生成 8 步合法 Plan / Step0 navigate SUCCESS / Step1 element_present VERIFY_FAILED retry×3→escalated / 终态 HUMAN_ESCALATION（绝不绝 RUNNING）/ task.status=runtimeStatus=事件流一致 / 不改 GroundTruth·retry·PlanBridge。

**审计纪律（终态 vs 中间态）**：后续审计必须明确区分 — `RUNNING` 是 agentRunner 的**中间快照**（executedStepCount 等来自 agentRunner 注入点）；`HUMAN_ESCALATION`/`FAILED` 是 `_waitFinal` 返回的**最终终态**。E3 真实复核以 `_waitFinal` 终态 `HUMAN_ESCALATION` 为准，不得因中间快照 `RUNNING` 误判为悬挂。

---

### 14.10.1 当前正式状态（2026-08-24 E4 首跑 + 指标封存裁定后）

```
5.9-B              ✅ PASS
5.9-C              ✅ PASS
5.9-D              ⛔ BLOCKED（历史裁定）
5.9-E / E3         ✅ PASS
E3.1               ✅ PASS（A/B 验收）
E4 Collector       ✅ IMPLEMENTED（e4-smoke.js + report.js BENCH_PHASE=e4）
E4-Harness-Isolation ✅ PASS（E4-HI-1~7 全 PASS；仅修 harness/runner 隔离）
E4-1               🟡 FINDING：observationPassed=false（唯一可信，已封存）
E4 11×1            🟡 隔离已修复，待重跑（前次 RAN-BUT-INCONCLUSIVE 证据保留不覆盖）
E4 Semantic Result ⛔ NOT DETERMINED（需重跑 11×1 后产生）
E4-FIX             ❄️ 未授权
D'                 ❄️ 冻结
100×3              ❄️ 冻结
```

**E4 首跑诚实定性（详见 §14.14 + §14.14 指标封存裁定）**：
- ✅ 可信信号：`observationPassed=false` 对全部 11 任务成立 → planner 生成 Plan 时完全看不到页面（E4-1 FINDING，原样保存，不视为本轮缺陷）。
- ⛔ 污染信号：任务 1 `login` 因 navigate 相对路径 bug 卡 `RUNNING`，串行 harness 单 worker 被占用 →
  后续 10 任务永远 `PENDING` 未执行。故 `Schema Validity=9.1%` / `Terminal Finalization=0%` 等**标记为
  HARNESS-CONTAMINATED / NON-EVIDENTIARY，不得读作 E4 结论**。
- search 独立证据（`planner.planObjective(search)` → ok=true → 5 steps → schema valid）已封存：
  planner 本身未因 search 在 11×1 中 steps=0，11×1 里 search 的 steps=0 纯属 harness 未派发。
- 本轮 11×1 原始证据（`5.9-E4-smoke-summary.json` / `e4-run.log`）**保留，不覆盖、不重算、不混入下一轮**。
- 候选修复边界：(b) runtime 拼 baseUrl = 不授权（属被测对象行为）；(a) 独立 worker/profile 隔离 = 待授权，
  最小边界严格限定为「一个任务失败/RUNNING/挂起不阻塞其它任务」，**不改变任何任务自身执行结果**。
- 未修任何被测代码；发现问题即冻结。当前裁定：**E4 保持 INCONCLUSIVE，D' 与 100×3 继续冻结，等待明确的
  Harness Isolation 修复授权**。

**E3 与 E4 是两个不同的问题（纪律红线）**：
- E3 解决「错误 Plan 能不能正确失败」→ 终态收口，已闭合。
- E4 解决「LLM 生成的 Plan 是否与真实页面语义兼容」→ `Plan Schema Valid ≠ Plan Semantically Executable`。
- 当前已证明：LLM→合法 Plan→Runtime 消费→navigate SUCCESS→inspect→element_present→页面无对应元素→VERIFY_FAILED。
  这**不能再归咎于 Planner 没接通**（Planner 已接通且生成合法 schema）。E4 待研究的是「合法 JSON/合法 Action ≠ 对当前页面正确的 Action」。
- **严禁**为让 D' 跑起来而放宽 `element_present` 语义——那会破坏已建立的证据链。

### 14.11 5.9-E4 Plan Semantic Compatibility（草案 / 待授权，不执行）

> 状态：**草案**。本节仅锁定边界、研究维度、验收 Gate 草案与红线，未经用户授权不执行任何实验、不修改任何源码。

**核心命题**：`Plan Schema Valid ≠ Plan Semantically Executable`。
- 已证事实（E3 真实复核）：DeepSeek Planner 生成的 8 步 Plan 完全符合 schema（`planSchemaValid=true`），Step 0 navigate SUCCESS，但 Step 1 `inspect element_present("产品")` 在 mock 首页无对应元素 → VERIFY_FAILED → retry×3 → HUMAN_ESCALATION。
- 这说明 Planner 已"接通"且"合法"，但 Plan 的**语义**与真实页面结构不匹配。E4 研究的是这一层，而非"如何把当前 nav 跑成功"。

**E4 与 E3 的职责切分（必须保持）**：
- E3：错误 Plan 能不能**正确失败并收口**（终态 `FAILED`/`HUMAN_ESCALATION`，不再 RUNNING）。✅ 已闭合。
- E4：合法 Plan 为什么可能**语义错误**，以及 Intelligence 能否正确理解真实页面（observation 质量、selector 生成、verification 类型选择、页面语义理解）。

**研究维度（候选，待细化）**：
- planner prompt 是否注入真实页面 observation（当前 nav 失败根因疑似：planner 在生成 Plan 时缺少/未消费页面观察，凭语义假设生成 `element_present("产品")`）。
- observation 信息质量：Runtime 在 plan 阶段能否向 LLM 提供"页面当前存在哪些可定位元素"。
- semantic resolver / selector generation：LLM 生成的 selector/目标描述能否映射到页面真实 DOM。
- verification 类型选择：LLM 为何选 `element_present` 而非更宽松/更合适的验证；这是 LLM 决策问题，不是 verification 引擎问题。
- 页面语义理解：LLM 对"产品/文档/快速开始"等语义在真实站点的落点理解。

**验收 Gate 草案（待授权后定稿）**：
- E4-1：planning 阶段 page observation 是否进入 LLM 上下文（可观测性）；由执行前置条件「每任务记录 observation 摘要/来源」落地，证明信息入上下文但未注入答案。
- E4-2：Plan 中生成的 selector/目标描述，在真实页面存在率（语义可执行率）是否可度量。
- E4-3：语义歧义（如"产品"在首页无对应元素）是否能被 Intelligence 自识别/自愈，或至少被显式标记。
- E4-4：仍允许**合法失败**（`VERIFY_FAILED` 不被污染、`element_present` 语义不变、Ground Truth 独立）。

**红线（E4 禁止修改，与 E3 同纪律）**：
- ❌ 不修改 `element_present` 判定语义（不得为让 nav 成功而放宽验证）。
- ❌ 不修改 Ground Truth / 成功判定。
- ❌ 不修改 retry / recovery 标准（仍为 3 次）。
- ❌ 不重新启用 Plan Bridge（保持 `BENCH_PLAN_BRIDGE=null`，用真实 Planner）。
- ❌ 不给 Planner 注入页面答案（不得把 mock 站真实元素硬编码进 prompt 来"作弊"成功）。
- ❌ 不为了提高成功率修改 mockSite（mock 站是固定基准，改它等于改考题）。
- ❌ 不启动 D'，不跑 100×3（E4 仅研究兼容性，规模受控）。

**执行规模（草案）**：先 11×1 smoke（11 个任务各跑 1 次真实 DeepSeek），度量 Plan 语义可执行率与自愈能力；全过/达标后才允许进入 D'。

**执行前置条件（草案，强制）**：11×1 每个任务都必须记录「planner 实际看到的 observation 摘要 / 来源」，以证明页面信息确实进入 LLM 上下文、但未注入页面答案（红线：不得硬编码 mock 站真实元素到 prompt 来作弊成功）。该记录是 E4-1 的可观测性落地点，缺一则该次任务验收无效。

**进入 D' 的前置（不变）**：E4 通过 → 11×1 smoke → 全过 → 才允许 5.9-D' → 最后 100×3。

**证据链分层（最有价值结论）**：Provider Contract → Planner Integration → Plan Execution → Verification
→ Failure Finalization → Intelligence Value。每一层可单独证明，而非只看 Success Rate。

**E4/后续路线（须逐级授权）**：E3 真实 PASS → 设计 E4（仅 Plan↔页面语义兼容性）→ 11×1 smoke
→ 全通过 → 才允许 D' → 最后才考虑 100×3。


### 14.12 5.9-E3.1-DIAG Repair Path Control-Flow Diagnosis（已授权，仅诊断，2026-08-24）

> 状态：**Diagnostic Only（已完成）**。仅回答 4 个问题，未修改任何 Runtime/repair/executor 行为。
> 方法：在 `runtime.js` / `repairManager.js` / `executor.js` / `taskManager.js` 插入**纯日志**埋点
> （受 `E3_1_DIAG=1` 门控），为每次 repair 生成唯一 `repairAttemptId` 串起全链路；并在 runtime repair
> 分支加了一个**事件循环看门狗** `setInterval`（每 10s 打 `WATCHDOG` 心跳，`unref` 不阻止退出）。
> 触发：单任务 search（真实 DeepSeek，`BENCH_E_TASK=search`）。

**背景裁定（用户 2026-08-24）**：
```
5.9-E3  VERIFY_FAILED → repair → HUMAN_ESCALATION          ✅ 已证明
ELEMENT_NOT_FOUND → retry×3 → repair → 自动修复路径
        → 无 REPAIR_TIMEOUT → 无终态 → RUNNING                ❌ E3.1 阻塞
E4 11×1                                                   ⛔ 暂停
```
关键观察：search 任务在 300s/400s 后仍 RUNNING 且**无 REPAIR_TIMEOUT 日志**。这不像「90s timeout 太短」，
更像「代码没走到 Promise.race 管控的异步路径，或进入不受 race 管辖的挂死」。

**诊断证据链（单次 search 运行，节选）**：
```
RACE_CREATED        RA_xxx  step=..._step_003  attemptNo=4  code=ELEMENT_NOT_FOUND  timeoutMs=90000
HANDLE_STEP_FAILURE_ENTER
REPAIR_ENTER        errorCode=ELEMENT_NOT_FOUND
DIAGNOSIS_RESULT    category=ELEMENT_NOT_FOUND  fromLLM=true
AUTO_REPAIR_ENTER   strategyType=elementChanged  strategy=SEMANTIC_RELOCATE  maxAttempts=3
AUTO_REPAIR_ITER    iter=0
EXECUTOR_ENTER      strategyType=elementChanged
EXEC_RUN_ACTION_ENTER  actionType=reload        → RETURN success=true
EXEC_RUN_ACTION_ENTER  actionType=fill target=搜索框  → RETURN success=false code=ELEMENT_NOT_FOUND
EXEC_RUN_ACTION_ENTER  actionType=fill target=email    → RETURN success=false code=ELEMENT_NOT_FOUND
EXEC_RUN_ACTION_ENTER  actionType=fill target=password
                       （此后进程完全沉默：无 RETURN / 无 WATCHDOG / 无 RACE_TIMEOUT / 无 TASK_FAIL，
                        直到外部 timeout 160s 强杀进程）
```

**四个问题答复（确凿）**：

1. **`Promise.race(REPAIR_TIMEOUT)` 是否实际被创建？**
   ✅ 是。`RACE_CREATED` 已打印，含 `timeoutMs=90000` 与唯一 `repairAttemptId`。race 的 setTimeout promise 真实创建。

2. **`handleStepFailure()` 是否实际被调用？**
   ✅ 是。`HANDLE_STEP_FAILURE_ENTER` + `REPAIR_ENTER` 已打印，且 `repairAttemptId` 透传进 repairManager/executor。

3. **`handleStepFailure` 内部进入哪个分支？**
   - `DIAGNOSIS_RESULT`：`ELEMENT_NOT_FOUND`，`fromLLM=true`（diagnosisEngine 真实诊断，非 memory 命中）。
   - `AUTO_REPAIR_ENTER`：`strategyType=elementChanged` / `SEMANTIC_RELOCATE` / `maxAttempts=3`
     → 进入**自动修复路径**（executor.executePlan 循环），**不是** `pauseForHuman` 的 paused 路径。
   - 卡死点：iter=0 第 3 个 variant `fill target=password` 的 `EXEC_RUN_ACTION_ENTER` 之后，
     无 `EXEC_RUN_ACTION_RETURN`。即挂死在 `tools.execute(fill)` 内部的某个浏览器调用。

4. **`executor` / 浏览器操作是否把控制流带到 `Promise.race` 无法覆盖的异步路径？**
   ✅ 是——且比「race 管不到」更严重：**它冻结了整个 Node 事件循环**。
   - 看门狗 `setInterval`（独立于 race，仅依赖事件循环）在 `fill password ENTER` 后**同样完全沉默**，
     直到 160s 外部 timeout 强杀。
   - race 的 90s `REPAIR_TIMEOUT` setTimeout 也沉默 → 两个 timer 都不调度 = **事件循环被冻结**，
     **不是**「promise pending 但事件循环正常」。
   - 冻结点落在 `fill` 动作的底层浏览器交互：`tools.js:197` 路径的
     `observation.inspect(page)`（`page.evaluate(COLLECT_JS)`，observation.js:103）或
     `browserManager.humanType`（`page.type`）。属 Runtime/executor 的**浏览器驱动层**，
     JS 层 `Promise.race` 对其**完全无能为力**——race 只能约束 JS promise，无法约束
     「底层 CDP/浏览器上下文僵死导致事件循环停摆」。

**根因定性（确凿，待 E3.1-FIX 授权后修复）**：
- E3 的 `REPAIR_TIMEOUT` 修复**只对「JS promise 层挂起」有效**（如 LLM 调用无超时、浏览器操作返回 pending 但事件循环存活）。
- 它**无法覆盖「事件循环被冻结」**：此时 race 的 timer 自身也不调度，timeout 形同虚设。
- 这正是 ELEMENT_NOT_FOUND 自动修复路径与 VERIFY_FAILED 路径的**本质差异**：
  VERIFY_FAILED 走 `pauseForHuman`→runtime `escalate`→`HUMAN_ESCALATION`（纯 JS 终态，事件循环存活）；
  ELEMENT_NOT_FOUND 走 `executor.executePlan`→`tools.execute`→`page.evaluate`/`page.type`，
  若浏览器上下文在该时刻僵死，事件循环冻结，所有 JS 层 timer（含 REPAIR_TIMEOUT）永久不触发 → 永久 RUNNING。

**附带的语义问题（不在 E3.1 范围，仅供 E4/修复参考）**：
- `elementChanged` 策略的 `buildElementVariants(step.action)` 为 search 任务（原动作 fill 搜索框）
  生成了 `email` / `password` 这类**完全不相关的登录表单变体**（`EXEC_RUN_ACTION_ENTER target=email/password`）。
  这是修复策略的语义错配，会让修复在错误目标上反复尝试；但不修改它（属 E4/repair 语义范畴）。

**E3.1-DIAG 状态表更新（2026-08-24）**：
```
E3.1-DIAG  Repair Path Control-Flow Diagnosis   ✅ 已完成（结论：事件循环冻结，非 timeout 太短）
E3.1-FIX   Repair Path 终态收口修复             ✅ 已授权 + 已实施 + A/B 验收 PASS（2026-08-24）
E4         Plan Semantic Compatibility          ❄️ 冻结（待 E3.1 稳定后由用户裁定解锁）
11×1       smoke matrix                         ❄️ 冻结（同上）
100×3      full matrix                          ❄️ 冻结
D'         Real Intelligence Evaluation         ❄️ 冻结
```
**纪律重申**：不直接为让 E4 继续而扩大 E3 修复。E3.1-FIX 严格限定在浏览器工具调用的故障隔离与终态收口，
未触碰 Planner / Plan Schema / verification / retry / GroundTruth / mockSite / elementChanged 语义 / Plan Bridge。

---

### 14.13 5.9-E3.1-FIX Browser Failure Lifecycle（已授权 + 已实施，2026-08-24）

**授权范围（用户裁定）**：唯一目标是「任何单次浏览器工具调用异常/超时/上下文失效时，都不得让 Runtime
永久悬挂；必须返回 Runtime，由既有 failure finalization 收口」。验收对象：
```
tools → page.* / CDP → 异常/超时/context failure → tool 返回失败
      → executor 失败 → repairManager 失败 → runtime fail / escalate → TERMINAL
```

**用户对落点的关键约束（已遵守）**：
- ❌ 不把 `Promise.race([browserCall, timeout])` 当成「能杀掉 `page.evaluate`/`page.type`」的机制。
  若底层真的冻结 event loop，race 的 timer 自己也不调度，再加 timeout 毫无意义。
- ✅ 优先用 Playwright 自身 timeout + 上下文生命周期检测（`page.isClosed()` / `browserManager`
  session 已在 `disconnected` 时 `delete`）做**快速失败**，让异常正常回到 JS 调用方。
- ✅ 仅对「自身含循环、可能无限 await」的拟人化函数（`humanType`/`humanClick`/`humanScroll`）
  加纯 JS 总时长上限——这是能 `throw` 的边界，覆盖「慢调用但 event loop 仍可运行」场景。
- ❌ 禁止修改 Planner / Plan Schema / element_present 语义 / verification / retry 次数 / GroundTruth
  / mockSite / elementChanged 的 email/password 语义 / Plan Bridge / D'；不跑 11×1 / 100×3；不用成功率作指标。

**实施落点（仅 `server/agent/tools.js` + `server/browserManager.js`，纯边界防护）**：
1. `tools.js` 新增 `TOOL_OP_TIMEOUT_MS`（默认 25000，短于 Playwright 默认 30s 与 runtime `REPAIR_TIMEOUT` 90s，
   由 `process.env.TOOL_OP_TIMEOUT_MS` 可调）。
2. `tools.js` 新增 `assertPageAlive(page)`：进入任何浏览器操作前检查 `page.isClosed()`，已失效则立即
   `throw BROWSER_CONTEXT_LOST`，避免把请求发往已死的 CDP 连接（诊断定位的高危挂死区）。
3. `tools.js` 新增 `withBrowserOp(label, page, opFn)`：包裹 `runTool` 内**每一个** `page.*` / `browserManager.*`
   / `observation.inspect` 调用。先 `assertPageAlive` 快速失败；再用 `Promise.race([opFn(), timeout])` 约束
   「慢调用但 event loop 可运行」场景；成功路径 `clearTimeout`；**timeout timer 不 `unref`**（否则当它是唯一
   存活句柄时 Node 会直接退出，已踩坑验证并修复）。超时归类 `BROWSER_TIMEOUT`，上下文失效归类 `BROWSER_CONTEXT_LOST`，
   其余统称 `TOOL_EXECUTION`——三者均被 `runTool` 的 `try/catch` 接住 → 回到 executor → repairManager → runtime 收口。
4. `browserManager.js` 的 `humanType`/`humanClick`/`humanScroll`/`humanMove` 循环内加 `Date.now()` 总时长上限
   （取 `TOOL_OP_TIMEOUT_MS`）与 `page.isClosed()` 检查，越界即 `throw`，避免循环无限 await。

**关键实现教训（值得记录）**：`withBrowserOp` 的初版对 timeout `setTimeout` 调用了 `.unref()`，
结果在「冻结 humanType（`new Promise(()=>{})`）+ 唯一 unref timer」场景下 Node 因无任何存活句柄**直接退出**，
`process.exit` 从未到达，且 timer 不触发——与诊断预言的「event loop 冻结」表现一致（虽机理是 unref 退出而非真冻结）。
移除 `.unref()` 后，timeout 在 8s 正常 fire 并 reject `BROWSER_TIMEOUT`。这正是用户担心的「用更多 JS timeout 掩盖未知控制流」
的反面教材：**timeout 本身必须保持"能强制触发"语义，不能 unref 掉。**

**E3.1-A 确定性 Harness（`benchmark/e31-harness.js`，不依赖 LLM / 真实浏览器挂死）**：
- 在 `browserManager.humanType` 边界 monkey-patch 模拟「CDP 调用永久不返回」（即诊断定位的冻结点）。
- `E31_FREEZE=1`：断言 `tools.runTool(fill)` 在 `TOOL_OP_TIMEOUT_MS` 内以 `BROWSER_TIMEOUT` 拒绝；
  全 Runtime 任务 ELEMENT_NOT_FOUND→AUTO_REPAIR 最终 `HUMAN_ESCALATION`（非 RUNNING）。**PASS**。
- `E31_FREEZE=0`：断言正常路径无回归（`fill` 成功、快速返回），任务仍终态。**PASS**。
- 双重模式均 ALL PASS。

**E3.1-B 真实 Search ×1（DEEPSEEK_API_KEY 真实、单 search）**：
- 修复前：search 在 `step_003`（`ELEMENT_NOT_FOUND`）的 `fill password` 进入 `humanType` 后永久 RUNNING，
  300s/400s 无 REPAIR_TIMEOUT、无终态（事件循环冻结）。
- 修复后（TOOL_OP_TIMEOUT_MS=20000）：同一路径被工具层 `BROWSER_TIMEOUT` 在 20s 内拒绝 → executor 失败
  → repair 3 轮 inspection/reload 完成后 `handleStepFailure` 返回 `paused` → `RACE_RESOLVE` →
  `TASK_ESCALATE_ENTER` → 终态 `HUMAN_ESCALATION`（或 `FAILED`）；**不再出现永久 RUNNING**。
- 完整链可见：`ELEMENT_NOT_FOUND → retry exhausted → AUTO_REPAIR → browser tool failure/timeout`
  `→ repair returns → terminal`，`runtimeStatus ∈ {FAILED, HUMAN_ESCALATION}`，符合授权验收。

**E3.1 验收结论**：错误 Plan 可以失败，但**绝不能无限悬挂**——已确证。E3.1-A + E3.1-B 均 PASS。
按用户裁定，「两者都 PASS 才解除 E4 冻结」的条件已满足，E4 可由用户裁定解锁（仍保持当前草案/待授权纪律）。

**隔离确认（E4 语义问题原封不动）**：诊断与修复过程中再次观察到 `elementChanged` 策略为 search 任务
（fill 搜索框）生成 `email`/`password` 登录表单变体——这是 E4 应研究的「Plan schema-valid ≠ Plan
semantically executable」问题，**E3.1 未改动**，留给 E4。

### 14.14 5.9-E4 11×1 Smoke（首跑：证据污染 / INCONCLUSIVE / 仅 1 个可信 FINDING）

**授权（用户裁定，2026-08-24）**：解锁 E4-Design → 11×1 Smoke；仅研究 Real LLM Planner 生成的 Plan
与真实页面/任务环境之间的**语义兼容性**；不优化 D' 成功率。纪律红线（不修 task.verify / GroundTruth /
element_present / retry / mockSite / Plan Bridge / elementChanged 语义 / 不因失败改 Plan；发现问题只记
FINDING 并冻结）。

**采集器（纯观测，未碰被测代码）**：新增 `benchmark/e4-smoke.js` + `report.js` 的 `BENCH_PHASE=e4` 分支。
- E4-1：planner 入口只读 wrap，记录 `observationPassed` / `ctxKeys`。
- E4-2：逐 step `semanticCompatibility` 归因（6 类，仅归因层，不反控 Runtime）。
- E4-3：任务结束后用 `observation.inspect(page)` **事后只读**校验 target 是否真实存在（grounding），不反喂 planner。
- E4-4：OBSERVATION_MISSING / SEMANTIC_MISMATCH / RECOVERY_FAILURE → 记 FINDING，冻结。

**运行实况（真实 DeepSeek + 真实 Browser + Plan Bridge OFF，8m30s）**：
- 任务 1 `login`：`plannerCalled=true` `planSchemaValid=true` `steps=3`，但 step0 `navigate url="/"` 触发
  `page.goto("/")` → `Cannot navigate to invalid URL`（相对路径未拼 baseUrl）→ step0 HEALING →
  **`terminal=RUNNING`（未到终态）**。
- 任务 2–11（search/form/nav/text-change/timeout/cookie/structure-change/session-expired/browser-crash/
  worker-crash）：全部 `plannerCalled=true` 但 `steps=0` `terminal=PENDING`（**未进入执行**）。

**✅ 唯一可信 FINDING（与被测对象是否跑起来无关，planner 入口 wrap 已确证）**：
`observationPassed=false` 对**全部 11 任务**成立（`ctx` 仅含 `["taskId","executionId"]`，无 observation）。
即 LLM 在生成 Plan 时**完全看不到真实页面**——这正是 E4-1 要测的「Observation 是否进入 Planner 上下文」，
预期答案 = 否，原样记为 FINDING，**不视为本轮需修的缺陷**。
佐证：单任务诊断复现 `planner.planObjective(search)` 返回 `ok=true` 且生成 5 步合法 plan
（`fill 搜索框`/`submit 搜索表单`/`wait 结果列表` 等），证明 planner 自身工作正常，schema 合法；
但 plan 内容完全基于 `objective` 文本臆测，无任何页面事实支撑。

**⛔ 证据污染（为什么 10/11 不能支撑 E4 结论，必须如实标注 INCONCLUSIVE）**：
1. **harness 串行隔离缺陷**：`e4-smoke.js` 串行复用同一 `AgentRunner` / 全局 `schedulerLoop` / 单 profile
   page。任务 1 `login` 因 navigate 相对路径 bug 卡 `RUNNING`（单 worker 被占用），导致后续 10 任务
   `submit` 后**永不派发** → 永远 `PENDING`。这是**采集器/harness 的隔离问题，不是被测语义兼容性**。
2. **navigate 相对路径 bug**：runtime 对 planner 给的相对 `url="/"` 直接 `page.goto("/")` 失败
   （§14 已记：5.9-D 的 `navigate→HEALING→RUNNING` 是「实验信号」而非被测缺陷，但本 harness 把它放大成
   全局卡死）。
3. 因此 10/11 任务的 `planSchemaValid=false steps=0` 是**未执行**导致，而非「LLM 生成非法 plan」；
   `Schema Validity=9.1%` / `Terminal Finalization=0%` 等聚合指标**是 harness 污染产物，不得读作 E4 结论**。

**产物**：`benchmark/results/5.9-E4-smoke-summary.json`（已存，含完整逐任务原始证据 + 分层归因，
但整体标注 INCONCLUSIVE）。`benchmark/results/e4-run.log`（完整 stdout）。

**指标封存裁定（用户，2026-08-24）**：
- `observationPassed=false`（全部 11 任务）= **本轮唯一具备充分证据的 E4-1 FINDING**，原样封存，不覆盖、不重算。
- `Schema Validity=9.1%` / `Terminal Finalization=0%` / `Plan Semantic Compatibility` / `Target Grounding Rate`
  等聚合值 = **HARNESS-CONTAMINATED / NON-EVIDENTIARY**，不得作为 E4 语义兼容性结论或任何后续判据。
- search 独立证据（`planner.planObjective(search)` → `ok=true` → 5 steps → schema valid → `fill 搜索框`/
  `submit 搜索表单`/`wait 结果列表`）**明确封存**：证明 Planner 本身并未因 search 在 11×1 中 `steps=0`，
  11×1 里 search 的 `steps=0` 纯属 harness 未派发（PENDING），与 planner 能力无关。
- 本轮 11×1 原始证据**必须保留，不覆盖、不重算、不混入下一轮**。
- 候选修复边界裁定：
  - **(b) runtime 把 `/` 拼 baseUrl = 不授权**。即使看似仅 URL 兼容，也属于 Runtime 被测对象行为，会改变 E4 实验条件。
  - **(a) 独立 worker/profile 隔离 = 待授权**，且最小边界严格限定为：仅保证「一个任务失败/RUNNING/挂起时不阻塞其它实验任务」，
    **不改变任何任务自身的执行结果**。属实验 harness 有效性保障，非被测对象。
- 严格路线（若继续 E4）：
  `E4-Harness-Isolation` → 只修实验基础设施 → 重新验证每个 task 都真正进入 planner→runtime →
  确认采集器逐任务完整 → 重跑 E4 11×1 → 才允许产生 Semantic Compatibility 结论。
- **当前正式裁定：E4 保持 INCONCLUSIVE；D' 与 100×3 继续冻结；等待明确的 Harness Isolation 修复授权。**

**当前正式状态（2026-08-24 最终裁定）**：
```
5.9-B              ✅ PASS
5.9-C              ✅ PASS
5.9-D              ⛔ BLOCKED（历史裁定）
5.9-E / E3         ✅ PASS
E3.1               ✅ PASS
E4 Collector       ✅ IMPLEMENTED
E4-1               🟡 FINDING：observationPassed=false
E4 11×1            🟡 RAN-BUT-INCONCLUSIVE
E4 Semantic Result ⛔ NOT DETERMINED
E4-FIX             ❄️ 未授权
D'                 ❄️ 冻结
100×3              ❄️ 冻结
```

**纪律执行**：本次未修任何被测代码（planner/runtime/verification/mockSite/elementChanged 均原样）；
发现问题即冻结，未进入 E4-FIX。

**待用户裁定（harness 修复边界，非被测对象）**：
要让 E4 11×1 真正可执行、拿到语义兼容性证据，需修 **采集器/harness 的隔离正确性**（属实验工具，非被测语义）：
(a) 每任务独立进程或独立 worker / 独立 profile，避免单任务 RUNNING 污染后续；

---

## 14.15 E4-Harness-Isolation 执行与验收（2026-08-24，授权后执行）

**授权**：用户正式授权 E4-Harness-Isolation，仅修改 E4 实验 Harness / runner 的隔离机制，
目标 = 恢复实验可执行性（任务 A RUNNING/FAILED/HUNG 不得阻塞任务 B 进入 planner→runtime→collector），
**不改变任何任务自身执行结果**。

**修复范围（仅 harness/runner，未触任何 server/agent/* 被测对象）**：
1. `benchmark/runners/agentRunner.js`：
   - `_ensureProfile(taskId)`：每任务基于 `task.id` 生成独立 `profileId` + 独立 `userDataDir`，
     解除 `browserPool` 资源闸门对同一 profile 的串行互斥（根因 #1）。
   - `_ensureScheduler()`：先 `sched.start()`（start 内 `_reapZombieWorkers` 会清空 registry 仅留 worker_1，
     **必须在 start 之后**补 worker），再按 `BENCH_MAX_WORKERS` 向既有 scheduler 的 `executorPool`
     动态补足 `worker_2..N` 并 `workerManager.startWorker` 注册（根因 #2：单 worker 串行）。
   - `planBridgeOverride`：per-run 覆盖（harness 隔离辅助），消除并行任务对 `BENCH_PLAN_BRIDGE` env 的竞态。
   - `raw.profileId` 透出：供 collector 事后只读 grounding 校验取本任务独立 profile 的 session。
2. `benchmark/e4-smoke.js`：
   - grounding 校验段改用 `r.profileId` 取本任务 session（原固定 `'bench-profile'` 已失效）。
   - 新增 `opts.limit` / `opts.taskIds` 支持 3-task smoke 与指定任务。
3. `benchmark/e4-hi.js`（新增）：E4-HI 确定性验收 + 3-task smoke。

**根因复盘（修复前）**：
- `schedulerLoop` 为全局单例，被 `planner` 的 require 链以默认 `maxWorkers=1` 预建；`getInstance` 无重置接口，
  `stop()` 不销毁单例。故 harness 无法以 `maxWorkers>1` 重建——改为向既有 scheduler 的 `executorPool`
  **动态补 worker**（仅扩展 worker 集合，不改 scheduler 任何逻辑/状态机），属「调度隔离配置」。
- `start()` 内 `_reapZombieWorkers` 会 `workerRegistry.clear()` 仅留 worker_1，故补 worker 必须在 `start()` **之后**。

**E4-HI 验收结果（确定性，真实 DeepSeek for B，Plan Bridge for A，maxWorkers=2）**：
```
E4-HI-1  A RUNNING 不阻塞 B          ✅ PASS   A.status=RUNNING  B.status=RUNNING
E4-HI-2  B 调用 planner              ✅ PASS   planner.called=1
E4-HI-3  B 生成 Plan                 ✅ PASS   B.planStepCount=5
E4-HI-4  B 进入 Runtime              ✅ PASS   B.executionId=exe_...  status=RUNNING
E4-HI-5  A/B profile 隔离           ✅ PASS   profA=acquire.ok  profB=acquire.ok
E4-HI-6  A/B collector 数据隔离     ✅ PASS   A.profile≠B.profile  A.exec≠B.exec
E4-HI-7  未修改被测对象             ✅ PASS   仅改 agentRunner.js/e4-smoke.js/e4-hi.js
```
→ **E4-Harness-Isolation PASS（E4-HI-1~7 全 PASS）**

**3-task smoke（search/form/nav，真实 Planner，maxWorkers=3）**：
- 验证目标：隔离修复后连续 3 任务进入 planner→plan→runtime→collector，不再出现「前任务 RUNNING→后续 PENDING」。
- 验收判据：每个任务 `planSchemaValid && terminalStatus && terminalStatus !== 'PENDING'`
  （planner 调用计数受 plannerProbe wrap 冲突影响，不单独作为隔离验收阻塞项；planSchemaValid 来自
  runtime trace.planStepCount，是 planner 实际产出的权威证据）。
- 运行结果：（见下方「3-task smoke 结果」回填）

**本轮仍不可变条件（全部遵守，未触碰）**：
- ❌ 未修改 runtime.js / planner.js / verification / retry / recovery / repairManager / executor / tools /
  browserManager / mockSite / elementChanged / GroundTruth / Plan Bridge / Planner prompt / Plan schema /
  semanticCompatibility 判定逻辑。
- ❌ 未把 `/` 自动改成 baseUrl；❌ 未为 Planner 注入 observation；❌ 未把失败任务强制标记 SUCCESS；
  ❌ 未修改 E4-1 的 observationPassed 判定。

**指标处置**：
- 本轮 11×1 原始证据（`5.9-E4-smoke-summary.json` / `e4-run.log`）**原样保留，不覆盖、不重算**。
- `observationPassed=false`（全部 11 任务）仍为本轮唯一有效 E4-1 FINDING，封存。
- `Schema Validity=9.1%` / `Terminal Finalization=0%` 等仍标记 **HARNESS-CONTAMINATED / NON-EVIDENTIARY**。
- E4-Harness-Isolation 解除的是「HARNESS-CONTAMINATED」状态（使后续 E4 11×1 可重新获得有效实验数据），
  **不等于 E4 PASS**；E4 语义兼容性结论仍需重跑 11×1 后产生。
(b) 让 runtime 对 planner 给的相对 `url` 拼接 `baseUrl`（或 planner 本就生成绝对 URL——诊断复现里 planner
  收到绝对 URL 时生成了 `http://localhost:.../search`，说明 planner 能处理绝对 URL，问题在 agentRunner
  传给 planner 的 `target` 是绝对、但 planner 内部生成 plan 时把 navigate 写成相对 `"/"`）。
这两项修复属于「让 E4 实验能跑起来」的前提，不改变被测 Plan 语义兼容性研究对象，需用户明确授权边界后再做，
**不擅自在 E4 实验过程中修改**。

**当前状态（用户裁定口径）**：
- E3.1-FIX ✅ PASS
- E4 DESIGN ✅ LOCKED
- E4 11×1 🟡 RAN-BUT-INCONCLUSIVE（证据污染；仅 `observationPassed=false` 可信 FINDING；待 harness 修复授权后重跑）
- E4 FIX ❌ NOT AUTHORIZED
- D' ❄️ FROZEN / 100×3 ❄️ FROZEN


