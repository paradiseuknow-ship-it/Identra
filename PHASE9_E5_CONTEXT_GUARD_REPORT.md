# Phase 9 — E5 Context Guard + Navigation Capability 专项报告

> 生成时间：2026-08-28
> 原则：工程测试通过 ≠ 产品验证通过。所有结论均以真实浏览器 + 真实执行/验证链路的数据为准。

---

## 一、结论摘要

| 指标 | 修复前（phase68 基线） | Phase 9 后 | 证据来源 |
|---|---|---|---|
| E5 误阻断（4-task Gate） | 196 次 / 224 次阻断集中在 navigate | **0 次** | Gate 遥测 `guardBlocked` |
| 4-task Business Success | 0/4 | **1/4（原始契约）→ 2/4（契约修正后）** | Gate 回放 |
| 验证通过率（4-task） | — | 9/17 → **15/23** | Gate 遥测 |
| VIL 观察窗口有效观察率 | **0%（650 次迭代 0 次恢复）** | **100%（217 次迭代 217 次有效）** | 20-task 回放 |
| Planner 规划时可见页面信息 | **无（page 上下文恒为 null）** | **完整（URL/标题/可见文本/元素清单，含 id 与 ariaLabel）** | P4 探针 + 23 项测试 |
| 完整回归 | 23 文件 | **27 文件：25 OK / 2 BAD（既有数据损坏）** | 回归套件 |

**核心判断一：Phase 9 的五个修复（P0/P1/P2/P3/P4）在真实链路上全部生效。**

**核心判断二（更重要）：剩余失败的主要瓶颈不在 agent 代码侧，而在 benchmark 资产侧。**
P4 修完后做了「契约可推导性」只读分析（phase68 全量 100-task，185 个失败契约条款）：
**69.2% 的失败契约，其期望值在页面真实内容里根本不存在**（`text_present=总用户数` 打在
一个「比价网商品列表」页上；`url_contains=cart` 打在一个没有购物车页的 fixture 上）。
这类失败无论 planner 看多少次页面都写不对 —— 它们不是能力问题，是**任务池 objective
与 mock-site fixture 不匹配**。这属于 STOP-1 范畴（改 benchmark 资产），需单独决策。

---

## 二、P0 — E5 False Block

### Business Problem
真实 SaaS 页面 → `pageStateClassifier` 判 `GENERIC` → `contextGuard` 阻断 → Action 根本没执行。
phase68 数据中 28/30 的 SaaS task 命中 E5。

### Root Cause（数据定位）
读 phase68 store 的 995 条 attempt：

```
224 次 CONTEXT_WRONG_APP 中，196 次发生在 navigate 动作上
目标地址恒为 http://127.0.0.1:2963/saas/login.html
```

根因：**守卫用「导航前的当前页状态」判定「目标站点上下文」**。
浏览器 `startupUrls: []`，导航前停在内置起始页；分类器判 GENERIC 是**正确的**（该页确实无应用特征），
错在守卫把 GENERIC 当「明确错误上下文」去阻断 navigate。
另外 28 次是 `inspect`（只读动作）在下载页被阻断 —— 阻断了 agent 的诊断与恢复能力。

### Code Location / Minimal Patch
`server/agent/contextGuard.js`

1. **转场动作按「目标地址」判定，不按「当前页」**：新增 `PAGE_TRANSITION_ACTIONS`（navigate/goto/open）、
   `destinationConflict()`。导航本身就是离开错误上下文的手段。
2. **只读动作不参与上下文阻断**：新增 `READ_ONLY_ACTIONS`（inspect/observe/read/extract/scrape/screenshot/wait/scroll），
   判定提前到转场判定之前，直接返回 `guardMode: 'read_only'`。
3. **GENERIC + SaaS 证据裁决**：新增 `saasEvidence()`。放行需同时满足
   **结构性身份**（URL/title 正则）**且总证据数 ≥ 2**（DOM email+password 表单 / SaaS 动作按钮 / 可见文本语义）。
   `GENERIC + 证据不足` 仍然 BLOCK —— 未做 `GENERIC → always SaaS`。

`server/agent/tools.js`：4.5 守卫块传入 observation，并新增 `ai.guard.passed / ai.guard.blocked` 遥测。

### Tests
`server/scripts/test_phase9_e5_context_guard.js` — **43 PASS / 0 FAIL**

关键用例：
- 真实 SaaS login 页 → navigate 放行（`guardMode: 'destination'`）
- SaaS 证据不完整 → **不得 silent allow**（仍 BLOCK）
- Generic + expectedSaaS 且无证据 → **必须 BLOCK**
- 明确错误上下文（下载页 upload）→ **必须 BLOCK**（E5 原语义保留）
- 6.10 `inspect` 在下载页不再被阻断 / 6.12 `upload` 在同一页**仍被阻断**

### Regression
完整套件无新增失败。

---

## 三、P1 — Navigation / Element Capability（Candidate Discovery）

### Business Problem
Phase 8 剩余的真实 `ELEMENT_DISCOVERY`：51 个任务里 `VERIFY_FAILED: 194` vs `ELEMENT_NOT_FOUND: 8`
—— 真正的第一断裂点在**验证环节**，不是元素查找。

### Root Cause（确定性比对归因）
写 `server/scripts/analyze_phase9_p1.js`，绕开 store 无 resolver telemetry 的缺口，
直接把 planner 产出的 `verification.expect` 与 fixture 真实 DOM 比对：

```
CSS_IN_DOM 2 | CSS_NOT_IN_DOM 11 | SEMANTIC_IN_DOM 11 | SEMANTIC_DYNAMIC 1
SEMANTIC_NOT_IN_DOM 25 | URL_CHECK 4 | EMPTY 1
→ GAP_RESOLVABLE 13 / GAP_FIXTURE_MISSING 23
```

决定性证据（从 `aiEvents` 提取）：

```
element_present="form" → 未找到元素 "form"   出现 36 次，涉及 9 个任务
（rw.056/058/061/062/063/064/065/072/075）
这 9 个任务全部卡死在 step0（NAVIGATE 的验证），step1+ 全部 PENDING 从未执行。
```

而 `data_entry/form.html` 明确存在 `<form id="regForm">`。

根因：`observation.js` 的 `COLLECT_JS` 只对 `a/button/summary/带 role` 的元素入池，
尽管 `INTERACTIVE_TAGS` 声明了 `form/label/h1~h3`。而 `elements[]` 是 `semanticResolver` 的**唯一候选池**。

### Code Location / Minimal Patch
`server/agent/observation.js` — 把结构性容器与标题补齐进候选池：

```js
if (tag === 'a' || tag === 'button' || tag === 'summary' || roleAttr
    || tag === 'form' || tag === 'label' || tag === 'h1' || tag === 'h2' || tag === 'h3') {
```

刻意**不**加入 `p/div/span`：数量大会挤爆 80 条上限并稀释排序；且其文本已由 `textSummary` 覆盖，
`text_present` 验证不受影响。

### Tests
`server/scripts/test_phase9_p1_candidate_discovery.js` — **24 PASS / 0 FAIL**（真实浏览器 `data_entry/form.html`）

- B.2 `elements` 中出现 form
- B.4 `resolve("form")` 有候选
- B.7 `element_present="form"` 验证通过
- 回归：C.1~C.3 input 定位不变 / C.4 不超 80 上限 / C.6 text_present 不变 /
  C.8 脱敏未破坏 / C.9 form 未抢占 name 字段首位

---

## 四、P2 — Action Ranking（submit/login/logout）

### Business Problem
Phase 8 的 7 个「动作成功但目标未观察到」（rw.035/042/045/076/080/092/099），
失败步骤全部是对 `ecommerce/search.html` 执行 `submit`。

### Root Cause
表面看是 Ranking Gap：`search.html` 没有 `<form>`，搜索由 `button#searchBtn` 的 click 处理器触发；
语义排序把 `input#q`（field='search' 精确命中 id='q' → 1.0）排在 `button#searchBtn`（0.95）之前，
agent 点击了输入框 → 页面从未渲染结果 → `text_present` 验证**正确地**失败。

**但真正的第一断裂点更靠前 —— elementMemory 短路。** P2 测试首次运行时发现：

```
127.0.0.1 | 搜索表单  →  confidence=1, success=208, failed=0
patterns: [{tag:'input'},{tag:'input'}]     ← 记忆指向搜索输入框
```

即真实 benchmark 中每次 `submit` 都被记忆直接指向输入框，`semanticResolver` **根本没机会运行**。
记忆之所以记下 208 次「成功」：点击输入框这个动作本身机械成功了（无异常），
而真正的失败发生在验证层（`text_present` 未命中），记忆却记成 208 次成功。

> **element-level success ≠ business success。记忆不能对动作目标拥有否决权。**

### Code Location / Minimal Patch
1. `server/agent/tools.js`：新增 `isActionableControl(el)`（可触发 + 未禁用判定：button / input[type=submit|button|image] /
   a[role=link] / summary / menuitem / tab），并在 `submit/login/logout` 分支通过
   `resolveSelector(..., { prefer: isActionableControl })` 传入。
2. `server/agent/intelligence/elementMemory.js`：`getCandidate` 新增可选 `opts.prefer`——
   记忆只提供候选，不越过约束：**若没有任何已匹配候选满足 prefer，返回 null**，交回 `semanticResolver`。
   命中统计只在实际采用后累加，避免把「被拒绝的记忆」算成命中。

未做：不重写 resolver、不加新 AI resolver、不加 fallback、不改验证阈值。

### Tests
`server/scripts/test_phase9_p2_action_ranking.js` — **26 PASS / 0 FAIL**

- A 组：`isActionableControl` 纯函数（8 条，含 disabled 排除、form 容器排除）
- B 组：真实浏览器 `ecommerce/search.html`
  - B.3 证明修复前首位确实是 `input#q`（缺口真实存在）
  - B.4 submit 解析落在 `button#searchBtn`
  - B.7 **端到端：点击后结果真实渲染 `4K显示器`**
  - B.8 `text_present="显示器"` 通过（真证据，非降低阈值）
  - B.9/B.10 反向对照：不带 prefer 仍回落 `input#q`；点击输入框不渲染结果
- C 组回归：fill 仍定位输入框 / 显式 selector 优先级 / 无候选返回 null
- D 组红线：无证据时 text_present、element_present **仍判失败**；prefer 只在候选内挑选，不新增候选
- **E 组（根因）**：存在「搜索表单→input」的 success=208 污染记忆时，submit 仍落在按钮（E.1），
  记忆因不满足约束被放弃、改由语义解析兜底（E.2）

---

## 四之二、P3 — Element Memory 污染治理（含 VIL 观察窗口重大修复）

### Business Problem

P2 的次生问题：`tools.execute` 中 `recordSuccess` 的触发条件是 `toolOut.success` = **动作机械成功**，
而业务验证（`verification.verify`）在其**之后**才由 runtime 执行。于是：

```
点击 input#q 机械成功 → 记忆 +1 → 随后 text_present 验证失败 → 记忆既不撤销也不扣减
  → 127.0.0.1|搜索表单 累积出 confidence=1 / success=208 / failed=0 的假成功记忆
  → 该记忆持续把后续 submit 指错目标（P2 的真实根因）
```

本质是 **element-level success ≠ business success**。

### Root Cause

| 环节 | 行为 |
|---|---|
| `tools.js` | `if (toolOut.success && …) recordSuccess(...)` —— 验证尚未发生 |
| `runtime.js` | 验证失败 → `failAttempt`，但**不回退**已写入的记忆 |
| 结果 | 208 次「成功」实为业务失败，且无任何负反馈 |

### Code Location / Minimal Patch

改为**挂起-确认**（两处出口确认，验证失败则完全不强化）：

| 文件 | 改动 |
|---|---|
| `server/agent/tools.js` | 不再直接 `recordSuccess`，改为把确认信息放入返回值的 `memoryConfirmation` |
| `server/agent/intelligence/elementMemory.js` | 新增 `confirmPendingSuccess(conf)` 并导出 |
| `server/agent/runtime.js` | 两处成功出口确认：① 业务验证通过 ② VIL 观察窗口恢复 |

无验证契约为前提的路径保持原行为（不退化），验证语义本身未改动。

### 意外发现：VIL 观察窗口 100% 失效（本次最大收获）

在验证 P3 第二处出口（VIL 恢复）时，测试始终无法覆盖目标路径。逐层下钻后定位到一个
**真实、严重、但修复极小**的缺陷：

```
server/browserManager.js:854   async function getPage(profileId) → 返回 Promise
server/agent/runtime.js:226    const page = browserManager.getPage(task.profileId);   ← 漏 await
```

后果链：

1. 传入观察窗口的是 **Promise** 而非 Page；
2. Promise 恒为 truthy，`if (page)` 拦截不住；
3. 窗口内每次 `observation.inspect` 失败于 `page.evaluate is not a function`；
4. `observation.inspect` 内部 catch 后**返回** `{ok:false}`（不抛异常），
   窗口再 `catch (e) { insp = null }` 静默吞掉 → 外部完全无感。

即：Phase 10.7 主推的「WAIT / RECHECK / RETRY_VERIFY → 观察窗口恢复」能力**从未真正工作过**。

**修复**：四处漏 `await` —— `runtime.js` 154（SIMULATION 观察）/ 226（观察窗口，核心）/
280（verification_failed 快照）、`recovery/failureSnapshot.js` 13。
（`tools.js:423` 与 `index.js` 全部调用原本就有 `await`。）

**可观测性补强**（纯遥测，不改判定）：`verificationWindow` 的 window 事件新增
`observationOk` / `observationError`。没有它，「页面真的没变化」与「根本没观察到」
在外界完全不可区分 —— 这正是该缺陷被长期隐藏的直接原因。

### 影响面（只读分析，数据来自 phase68 100-task 真实跑批）

`server/scripts/analyze_phase9_p3_vil_impact.js` → `.benchmark/phase9_p3_vil_window_impact.json`

| 指标 | 数值 |
|---|---|
| VIL 窗口迭代事件 | **650 次** |
| VIL 恢复事件 | **0 次**（窗口 100% 空转） |
| 本应进入窗口的 VIL 决策 | **214 次，涉及 55 个独立任务**（100 任务中的 55%） |
| 失败类型分布 | STATE_UNKNOWN 204 / DOM_CHANGED 6 / SUBMIT_RESULT_UNKNOWN 8 / VERIFICATION_TOO_STRICT 4 |
| 敏感动作被一刀切 HUMAN_ESCALATE | 8 次（全部 submit） |

### 20-task 回放对照（证伪型结论）

从上述 55 个受影响任务中取 20 个（6 个 DOM_CHANGED + 1 个 VERIFICATION_TOO_STRICT + 13 个 STATE_UNKNOWN），
用历史真实 plan 回放（执行/验证/判定全真实）：

| 指标 | 结果 |
|---|---|
| Business Success | 0/20（历史同为 20/20 HUMAN_ESCALATION → **无退化**） |
| VIL 窗口迭代 | 217 |
| **窗口内有效观察** | **217（修复前为 0 —— 修复确实生效）** |
| VIL 恢复 | **0** |

**这条数据的价值在于证伪**：观察窗口已经真正工作（有效观察 0 → 217，100% 有效），
却一次都没能恢复 —— 说明这些失败**不是观察时机问题**，重观察救不了。
失败根因被精确锁定为「planner 期望契约与页面真实内容不符」（STATE_UNKNOWN 占 95%）。

> 样本说明：这 20 个任务是**刻意从历史失败任务中挑选**的（目的是检验窗口能否恢复它们），
> 因此 0/20 不代表整体能力，仅表示「历史失败任务未被观察窗口挽回」。

### Tests

`server/scripts/test_phase9_p3_memory_governance.js` —— **22 PASS / 0 FAIL**

| 组 | 覆盖 |
|---|---|
| A | `confirmPendingSuccess` 纯函数与空值安全 |
| B | **验证失败 → 记忆不增长**（核心） |
| C | **验证通过 → 记忆增长**（核心，证明未切断学习） |
| D | **VIL 观察窗口恢复 → 记忆增长**（覆盖 runtime 第二处出口） |
| E | 红线：不降低验证阈值、`recordFailure` 语义不变、关键动作无验证契约仍被拒绝 |

D 组含三层前提断言，缺一即为假通过：
`D.0` 前导 navigate 成功 / `D.1` 首次验证确实进入 VIL 决策 /
**`D.1b` 窗口内每次观察都真实成功** / `D.2` 窗口确实恢复。

---

## 四之三、P4 — Planner 页面上下文（契约编造的结构性根因）

### Business Problem
§八「下一步」第 1 项把瓶颈锁定为「planner 契约准确性」。本节回答一个更前置的问题：
**Planner 在规划时到底能不能看到页面？** 答案是：**完全看不到。**

先做失败契约分型（`.benchmark/phase9_p4_contract_attribution.json`，78 个失败 attempt）：

| 分型 | 数量 | 占比 | 含义 |
|---|---|---|---|
| CONTRACT_SELECTOR_MISMATCH | 38 | 48.7% | 契约里的元素标识在页面上根本不存在 |
| OTHER | 23 | 29.5% | 含 `url_contains=edit`（动作后 URL 未变）等 |
| CONTRACT_TEXT_MISMATCH | 17 | 21.8% | 期望文案不在页面真实内容里 |

典型样本：`scraping/list.html` 真实 id 是 `list`，Planner 写出 `element_present="member-list"`；
`saas/login.html` 真实字段是 `email`，Planner 写出 `input[name='username']`。

### Root Cause（三个串联断裂点）
沿 `runtime.resolvePlan → contextBuilder.build → planner → provider` 逐段排查，发现**三处串联缺陷**，
任一存在都会让 Planner 看不到页面：

| # | 位置 | 缺陷 |
|---|---|---|
| B1 | `runtime.js` `resolvePlan` | 调用 `contextBuilder.build({task, steps, checkpoint, errorHistory, budgetCfg})` —— **从不传 `observation`**，致 `ctx.context.page` 恒为 `null` |
| B2 | `contextBuilder.js` | elements 映射只取 7 个字段，observation 采集 17 个 —— **丢掉 `id` 与 `ariaLabel`** |
| B3 | `planner.js` / `llm/providers/deepseek.js` | 两处 context 序列化**都只输出 url/title**，`textSummary` 与 `elements` 从未进入 prompt |

后果是一条自相矛盾的死链：`planner.js` 的 `ACTION_CONSTRAINTS` 明文要求
「verification 与 expectedBusinessState 都必须能从 objective 推导，**禁止凭空臆造**预期结果」，
但模型手里只有一个 URL 字符串和一句 objective —— 除臆造外别无他法。

探针实测（`phase9_p4_planner_visibility.js`，真实 Chromium）：

```
/admin/users.html    observation 元素 8  → Planner 可见 8
  Planner 可见字段 : role,tag,type,name,text,placeholder,label
  ★ 丢失字段      : id,cls,ariaLabel,visible,bbox,boundingBox,innerText,roleText,state,selector,inFrame
  页面真实 id     : username, email, role, addBtn
```

### Code Location / Minimal Patch
| 文件 | 改动 |
|---|---|
| `server/agent/runtime.js` | 新增 `capturePlanningObservation(task)`：规划前真实导航 + 真实观察，结果传给 `contextBuilder.build`。全程 try/catch，失败返回 `null` 降级为既有行为 —— **不新增失败模式** |
| `server/agent/contextBuilder.js` | elements 映射补 `id` 与 `ariaLabel` |
| `server/agent/planner.js` | `contextBlock` 输出 `页面可见文本` 与 `页面元素清单`，并显式约束「必须从中选取真实存在的 id / name / text / ariaLabel，禁止臆造」 |
| `server/agent/llm/providers/deepseek.js` | `buildContextSection` 同步输出同上两项 |

红线：只补上下文可见性，**不触碰任何判定 / 阈值 / Guard / success definition**。

### 收益天花板（诚实评估）
P4 修完并不等于失败清零。做了「契约可推导性」只读分析
（`.benchmark/phase9_p4_derivability_phase68.json`，phase68 全量 100-task，185 个失败条款）：

| 分类 | 数量 | 占比 | 说明 |
|---|---|---|---|
| **UNDERIVABLE** | 128 | **69.2%** | 期望值在页面真实内容里**根本不存在** → benchmark 资产问题，P4 救不了 |
| DERIVABLE | 42 | 22.7% | 正确值可从页面推导 → P4 后 Planner 有能力写对 |
| POST_ACTION | 15 | 8.1% | 动作后才出现的结果态（成功文案 / URL 变化）→ 规划前不可见 |

按 fixture 拆分：

```
fixture                         总数  DERIV  UNDER  POST
/ecommerce/search.html            68      4     50    14
/data_entry/form.html             53     36     16     1
/scraping/list.html               48      0     48     0
/ecommerce/search_lazy.html       12      2     10     0
/download.html                     4      0      4     0
```

两点必须如实说明，不夸大 P4：

1. **42 个 DERIVABLE 里 36 个是 `element_present=form`**，已被 **P1 候选池修复**覆盖
   （form 现在进得了候选池）。扣掉后，P4 自身能新增修复的失败条款约 **6/185 ≈ 3%**。
   P4 是**必要的基础设施修复**（消除「盲飞规划」），但不是 Business Success 的主要杠杆。
2. **`/saas/login.html` 未出现在失败契约里** —— 它的 30 个任务全部死在 **E5 阻断**（P0 已修），
   根本没走到验证阶段。这反证了 P0 的关键性。

**69.2% 的 UNDERIVABLE 才是主要瓶颈，且根因在 benchmark 资产侧，不在 agent 代码侧** —— 详见 §八。

### Tests
`test_phase9_p4_planner_context.js` — **23 PASS / 0 FAIL**

| 组 | 覆盖 | 关键断言 |
|---|---|---|
| A（纯函数） | B2 / B3 | 真实 observation 结构下，context 携带 `id`/`ariaLabel`；prompt 含页面文本、元素清单与「禁止臆造」约束；deepseek 侧同步修复 |
| B（真实 Chromium） | B1 | 规划前观察返回 `ok=true`，`regForm/name/email/phone/submitBtn` 真实 id 完整传导到 Planner 上下文；降级保护存在 |
| C（根因边界） | 归因正确性 | `member-list`/`order-list`/`log-list` 在 fixture 中**确实不存在**；真实 id 为 `list` |
| D（红线） | 不越界 | DOM_CHANGED 仍不判成功；Guard 未被绕过（GENERIC+无证据仍 BLOCK）；P0 放行分支仍在；无契约动作仍被拒绝；verify 未降阈值；验证核心无 P4 改动 |

---

## 五、4-task Gate

### 5.1 Gate 形态说明（重要）

当前运行环境**无 `DEEPSEEK_API_KEY`**，真实 LLM 规划环节无法执行。因此采用**确定性回放 Gate**：

- **真实**：Chromium、taskManager/runtime、tools 执行、observation、verification、成功判定、Guard
- **回放**：plan 取自 `.benchmark/phase68_100task_store` —— 历史真实跑批中 DeepSeek **实际产出的 plan**
  （逐字回放，仅重写 mock 站点端口与凭据引用）

红线遵守：无 mock / 无 fake / 无 fallback success；不降低任何验证阈值；不绕过 Guard。

| 任务 | 覆盖路径 | 步数 |
|---|---|---|
| rw.001 SaaS登录1 | P0（navigate 曾 196 次被 E5 阻断） | 4 |
| rw.035 商品搜索5 | P2（submit 曾被记忆短路到 input#q） | 3 |
| rw.056 表格填写1 | P1（element_present="form" 曾失败 36 次） | 5 |
| rw.076 多步确认1 | 完整 Business Loop | 6 |

### 5.2 Gate 结果（原始契约回放）

| 任务 | 历史状态 | 本次 | 步骤 | Guard | 验证 |
|---|---|---|---|---|---|
| rw.001 | HUMAN_ESCALATION | HUMAN_ESCALATION | HEALING,PENDING,PENDING,PENDING | blocked=0 passed=8 | 0/4 |
| rw.035 | HUMAN_ESCALATION | **SUCCESS** | SUCCESS×3 | blocked=0 passed=3 | **3/3** |
| rw.056 | HUMAN_ESCALATION | HUMAN_ESCALATION | SUCCESS×4, HEALING | blocked=0 passed=6 | 4/6 |
| rw.076 | HUMAN_ESCALATION | HUMAN_ESCALATION | SUCCESS,SUCCESS,HEALING,PENDING×3 | blocked=0 passed=4 | 2/4 |

**Business Success 1/4（历史 0/4）；E5 阻断 0 次（历史 196 次）。**

### 5.3 剩余失败定性（逐个 trace）

| Case | planner 期望 | fixture 真实 | 验证器行为 | 归属 |
|---|---|---|---|---|
| rw.001#0 | `input[name='username']` | 只有 `input[name='email']`/`[name='password']` | **正确失败** | 契约不符 |
| rw.076#2 | 搜索「耳机」 | 商品库仅 机械键盘/无线鼠标/4K显示器，真实输出「未找到相关商品」 | **正确失败** | fixture 缺数据 |
| rw.056#4 | `text_present="提交成功"` | 实际文案「注册成功，欢迎 张三」（textSummary 19→30 字符，业务结果已产生） | **正确失败** | 契约不符 |

> rw.056 是 P1+P2 生效的直接证据：submit 落在 `#submitBtn`，点击产生真实业务结果，
> 对照 `text_present="注册成功"` → **true**。只差 planner 的文案契约。

### 5.4 反事实验证（隔离「planner 契约准确性」变量）

仅把已被 trace 证明与 fixture 不符的期望替换为 fixture 真实内容，**不动任何验证阈值、不绕 Guard**：

```
rw.001  input[name='username'] → input[name='email']
rw.056  提交成功 → 注册成功
rw.076  耳机 → 显示器
```

> 过程中的关键发现：验证真正消费的是 `action.expectedBusinessState.requiredEvidence`，
> 而非 `action.verification` 字段。错误信息 `required unmet: element_present="input[name='username']"`
> 即来自前者。

| 任务 | 原始契约 | 契约修正后 |
|---|---|---|
| rw.001 | HEALING(0/4) | SUCCESS,SUCCESS,SUCCESS,**HEALING** |
| rw.035 | **SUCCESS** | **SUCCESS** |
| rw.056 | HEALING(4/6) | **SUCCESS（5/5 全通）** |
| rw.076 | HEALING(2/4) | SUCCESS×4, HEALING, PENDING |

**Business Success 2/4；验证通过率 15/23；E5 阻断 0 次。**

剩余 2 个失败再次定性（同一类：fixture 缺页）：

| Case | planner 期望 | fixture 真实 |
|---|---|---|
| rw.001#3 | `url_contains=dashboard` | `mock-site/saas/` 下**只有 login.html**；doLogin 是同页显示 `#dash` 区块，**不跳转** |
| rw.076#4 | `url_contains=cart` | search.html 购物车是 `<b id="cart">0</b>` 纯计数器，**无 cart 页面**，加购只改计数 |

这两项与 P1 归因中的 `GAP_FIXTURE_MISSING = 23` 完全吻合。

---

## 六、回归

27 个 `test_*.js`，**25 OK / 2 BAD**（P4 后重跑）：

- `test_phase6.js` — 「页面分类准确率 ≥27/29 (got 3/29)」
  已证实为**既有数据损坏**：`.benchmark/phase3_live_raw_store/aiFailureSnapshots.json`
  19 条快照中 **0 条有 visibleTexts**，29 个 perCase **0 个能匹配到 taskId**。
  纯函数用例 11/11 全绿；本次未改动 `pageStateClassifier`。
- `test_phase4_blockers.js` — live store 只剩 1 条 FAILED/CANCELLED 记录（dist 仅 `UNKNOWN_EXECUTION_FAILURE:1`）。

两个测试均**不 import** 本次改动的模块，失败与改动前完全一致。

---

## 七、红线遵守声明

| 红线 | 状态 |
|---|---|
| `GENERIC → always SaaS` | ❌ 未做。放行需「结构性身份 AND 证据数 ≥ 2」 |
| `E5 → 删除` | ❌ 未做。`CONTEXT_WRONG_APP` 保留（测试 6.12 断言 upload 在下载页仍被阻断） |
| `Guard → bypass` | ❌ 未做。仅修正「按目标地址判定」与「只读豁免」 |
| `catch-all fallback → allow` | ❌ 未做。证据不足仍 BLOCK |
| `verification failure → success` | ❌ 未做。D.1/D.2 断言无证据时仍判失败 |
| `DOM_CHANGED ≠ SUCCESS` | ✅ 保持。VIL 中 `DOM_CHANGED` 仅触发 `RETRY_VERIFY`，不判成功 |
| 全能 Resolver 重写 | ❌ 未做。仅补候选池 + 在既有候选内重排 |

---

## 八、下一步

1. **benchmark 资产不匹配 —— 已被量化为第一瓶颈（STOP-1，需决策后推进）**
   P4 的「契约可推导性」分析给出硬数据：185 个失败契约条款中 **128 个（69.2%）是 UNDERIVABLE**
   —— 期望值在页面真实内容里根本不存在。举例：

   | 任务 objective | fixture | 冲突 |
   |---|---|---|
   | 抓取总用户数 / 统计管理员数量 / 查看订单数据 | `scraping/list.html`（比价网商品列表，10 条显示器） | 页面**完全没有**这些业务数据 |
   | 搜索「耳机」「USB 网卡」 | `ecommerce/search.html`（商品库：机械键盘 / 无线鼠标 / 4K显示器） | 商品不存在 |
   | 进入商品编辑页改标题 / 改库存 / 批量设置库存 | `ecommerce/search.html`（单页 demo，无编辑页） | **页面不存在** |
   | 结算确认地址（`url_contains=cart`） | `ecommerce/search.html`（无购物车页） | **页面不存在** |
   | 触发邮箱格式校验错误 / 手机号校验 | `data_entry/form.html`（只在姓名或邮箱为空时提示「请填写必填项」） | 校验逻辑不存在 |

   这类任务在 fixture 上**不可能完成**，与 agent 能力无关。
   实测佐证：反事实 Gate 中 rw.076 把「耳机」换成 fixture 真实存在的「显示器」后，
   搜索（step#2）与加购（step#3）**立刻从 HEALING 变为 SUCCESS**，
   剩余失败卡在 step#4 `url_contains=cart` —— fixture 根本没有购物车页。

   **这不是「改任务池刷成功率」，而是「修正不可用基准」**：当前基准里相当一部分任务
   在完成度为 0 的前提下被计入 Business Success 分母，会系统性低估 agent 的真实能力。
   处置建议（按冻结纪律，需明确决策后再动）：
   - 方案 A：为不匹配的任务补齐对应 fixture 页面（cart.html / edit.html / 站内搜索等）
   - 方案 B：把 objective 收敛到 fixture 实际支持的能力范围内
   - 方案 C：标注为「基准不可用」，从成功率分母中剔除并单独说明

2. **补跑真实 LLM Gate**：需 `DEEPSEEK_API_KEY`。P0~P4 中有三项（P0 的契约语义、P4 的规划上下文）
   作用于 LLM 规划环节，而回放 Gate 用 `attachPlan` 会 early-return，
   完全不经过 `resolvePlan` —— 这也是 P4 在回放 Gate 上「无退化也无提升」的原因。
   **只有真实 LLM 规划才能验证 P4 的真实收益**，当前环境无法完成。

3. ~~planner 契约准确性（页面上下文）~~ → **已完成**（见 §四之三）。
   结论：结构性根因（Planner 看不到页面）已消除，但其收益天花板受第 1 项压制。

4. **敏感动作的 VIL 一刀切 HUMAN_ESCALATE**（待评估，本次未改）：
   `SENSITIVE_TYPES` 含 `submit`，导致 submit 验证失败时直接升级人工，连「只读重观察」的机会都没有
   （phase68 中 8 次）。观察窗口**不重执行动作**，让 submit 先看一眼真实结果再决定升级，
   理论上不触碰安全红线（仍不自主重提交）。但当前数据不足以证明收益，故未改动 ——
   需在第 1 项（契约准确性）落地后重测，避免把两个变量混在一起。

5. ~~elementMemory 污染治理~~ → **已完成**（见 §四之二）。

---

## 附：本次改动文件

| 文件 | 改动 |
|---|---|
| `server/agent/contextGuard.js` | 转场按目标地址判定 / 只读豁免 / SaaS 证据裁决（P0） |
| `server/agent/tools.js` | guard 遥测；`isActionableControl` + `prefer` 通路（P2）；记忆改为挂起-确认（P3） |
| `server/agent/observation.js` | form/label/h1~h3 入候选池（P1） |
| `server/agent/intelligence/elementMemory.js` | `getCandidate` 支持 `opts.prefer`（P2）；`confirmPendingSuccess`（P3） |
| `server/agent/runtime.js` | 两处成功出口确认挂起记忆（P3）；**四处 `getPage` 补 `await`**（观察窗口修复）；**新增 `capturePlanningObservation`：规划前真实导航+观察，结果传入 ContextBuilder（P4/B1）** |
| `server/agent/recovery/failureSnapshot.js` | `getPage` 补 `await`（证据快照修复） |
| `server/agent/verification/verificationWindow.js` | window 事件新增 `observationOk` / `observationError`（纯遥测） |
| `server/agent/contextBuilder.js` | elements 映射补 `id` / `ariaLabel`（P4/B2） |
| `server/agent/planner.js` | `contextBlock` 输出页面可见文本 + 元素清单 + 「禁止臆造」约束（P4/B3） |
| `server/agent/llm/providers/deepseek.js` | `buildContextSection` 同步输出页面文本与元素清单（P4/B3） |

新增脚本：
`test_phase9_e5_context_guard.js`、`test_phase9_p1_candidate_discovery.js`、
`test_phase9_p2_action_ranking.js`、`test_phase9_p3_memory_governance.js`、
`test_phase9_p4_planner_context.js`、
`analyze_phase9_p1.js`、`analyze_phase9_p3_vil_impact.js`、
`analyze_phase9_p4_contract.js`（失败契约分型）、
`analyze_phase9_p4_derivability.js`（可推导性上限，支持 `--store`）、
`phase9_p4_planner_visibility.js`（Planner 可见性探针）、
`phase9_gate_replay.js`（支持 `--taskIds` / `--counterfactual` / `--only` / `GATE_VERBOSE` / `GATE_DUMP`）、
`run_phase9_regression.sh`、`phase9_gate_trace.js`、`phase9_gate_trace2.js`
