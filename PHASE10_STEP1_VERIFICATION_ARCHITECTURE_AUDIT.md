# PHASE 10 STEP 1 — Verification Architecture Audit（代码级审计）

> 阶段性质：**纯只读审计**。未修改任何代码、未运行 benchmark、未调整成功定义、未进入修复实现。
> 代码基线：`v0.1-alpha`（冻结）。所有结论均来自对真实源文件的逐行核对，标注 `file:line`。
> 关联输入：Phase 9 实测（100 任务，Business Success 9%，VERIFY_FAILED 65%，Repair Attempt 66.7% / Business Recovery 0%）。

---

## 1. Executive Summary

Phase 9 的核心结论——**系统不是执行失败，而是 Action 完成后无法正确判断页面是否进入目标状态**——在代码层得到完整印证。审计确认：

1. **验证是「单次快照二值判定」**：`verification.verify()` 对单个 `after` observation 做一次判定，无 retry window、无 DOM 稳定等待、无重观察分支（`verification.js:15-85`，`runtime.js:161-177`）。
2. **观察存在「过早」风险**：`tools.js` 在 `goto` 仅等 `domcontentloaded`，各 action 完成后**立即** `observation.inspect`，无任何 `networkidle` / 渲染稳定等待（`tools.js:230` 及 click/fill/action 的 `.inspect2` 调用）。这直接支撑 OBSERVATION_DELAY / EVENTUAL_CONSISTENCY 两类根因。
3. **before/after 粒度粗**：`runtime.js:249` 的 `beforeObs` 是**上一步**的终态观察，而非「本动作前」快照；修复验证甚至传 `before=null`（`repair/executor.js:63`），状态变化检测能力名存实亡。
4. **VERIFY_FAILED 是单一黑盒桶**：`verify()` 只产出 `code:'VERIFY_FAILED'` + 证据字符串，**无细分分类**，无法区分「动作真失败 / 异步延迟 / 观察过早 / 验证过严 / 状态未知 / DOM 变化」。这正是 Phase 9 把 65% 全部归入 VERIFY_FAILED 的原因。
5. **修复策略会「重执行」而非「纯重验证」**：`verifyFailed.js` 的 `RETRY_VERIFY` 用完整 target **重新执行原 action**（有重复提交风险），对「验证条件过严」类无效——解释了 repair 尝试 66.7% 成功但业务恢复 0%。

> 结论先行：65% VERIFY_FAILED **不是单一问题**，而是至少 4~5 类成因被压进同一个错误码。下一阶段（Step 2+）必须先把 VERIFY_FAILED 拆类，再分别给「等待 / 重观察 / 调松验证 / 重执行 / 升级」的差异化路径。

---

## 2. Current Verification Pipeline（真实代码链路）

> 以下每一跳都标注真实文件路径、函数、输入/输出结构、调用关系。**概念架构一律来自代码，非设计推测。**

```
[1] Action Execute
    └─ server/agent/tools.js :: execute(action, ...)
       case 'click'/'fill'/'action' (≈268/315/301)  → 执行后紧跟
       observation.inspect(page, {taskId, skipCache:true})   // 立即抓取，无等待
       输出(到 runtime): toolRes = { success, observation, error }
       观察结构 observation = {
         url, title, textSummary, visibleText, roleText,
         elements[ {id,role,tag,type,name,cls,text,placeholder,label,
                    ariaLabel,visible,bbox,boundingBox,innerText,roleText,state} ],
         errors[]
       }

[2] Executor（单步编排）
    └─ server/agent/runtime.js :: runStep(task, step, beforeObs, actionOverride)  (116-183)
       输入: step.action + step.verification + beforeObs(上一步观察)
       调用 tools.execute → 得到 toolRes.observation (after)
       若 toolRes.success===false → failAttempt + 返回（ACTION 层失败，非 VERIFY）

[3] Observation Capture
    └─ server/agent/observation.js :: inspect(page, opts)  (146-174)
       实现: page.evaluate(COLLECT_JS) 一次性收集 DOM 可见交互元素 + 文本
       输出: { ok, cached, observation }

[4] Observation Cache
    └─ server/agent/observationCache.js :: get/set  (17-28)
       key = taskId + url + contentHash(visibleText, elements)
       命中: 返回【上一次】summary（内容未变即返回旧快照）

[5] Verification Engine
    └─ server/agent/verification.js :: verify(v, after, before)  (15-85)
       输入: v={type,expect}, after=observation, before=beforeObs
       输出: { success, confidence, evidence[] }   ← 单次二值判定

[6] Decision
    └─ server/agent/runtime.js :: 161-177
       if (!vres.success) { failAttempt(attempt,{code:'VERIFY_FAILED'}); return ok:false }
       else { succeedAttempt; setStepState SUCCESS }

[7] Recovery / Repair / Escalation（在 run() 主循环）
    └─ server/agent/runtime.js :: 266-367
       retries<=stepMax(3) → recoveryManager.attempt (确定性恢复: 元素重定位/等待/重载)
       耗尽 → repairManager.handleStepFailure
              └─ server/agent/repair/strategies/verifyFailed.js :: execute (35-84)
                 WAIT_STABLE(2500ms) → RECHECK_OBSERVATION(1500ms)
                 → RETRY_VERIFY(重新执行原 action, verification:none)
                 → SEMANTIC_RELOCATE(兜底)
                 修复内最终验证: server/agent/repair/executor.js:63
                    verify(step.verification, lastRes.observation, null)  // before=null
       仍失败 → taskManager.escalate → HUMAN_ESCALATION 终态
```

**关键调用关系**：`verify()` 仅在两处被调用——`runtime.js:163`（主验证门，带 beforeObs）与 `repair/executor.js:63`（修复验证，before=null）。`observation.inspect` 被 `tools.js` / `runtime.js` / `context.js` 调用。

---

## 3. verification.js Audit（9 个 handler）

`VERIFICATION_TYPES = ['url_contains','text_present','text_absent','element_present','element_absent','login_state','page_change','action_success','none']`（`verification.js:8-11`）。**全部为单 observation 二值判定，无 retry / 无稳定等待 / 无重观察。**

| Handler | 代码位置 | 判断逻辑 | 成功条件 | 失败条件 | 依赖字段 | 潜在误判 |
|---|---|---|---|---|---|---|
| `url_contains` | :27-31 | `url.includes(expect)` | URL 含期望串 | 不含 | after.url | 过度依赖 URL 文本；SPA 路由不变时漏判 |
| `text_present` | :32-36 | `textSummary.toLowerCase().includes(expect)` | 页面文本含期望 | 不含 | after.textSummary | **异步渲染未落定时文本缺失 → 误判失败**；大小写/空格敏感 |
| `text_absent` | :37-41 | 文本不含期望 | 确实缺失 | 出现 | textSummary | 同上，反向 |
| `element_present` | :42-47 | `semanticResolver.resolve(expect, after).length>0` | 语义解析到元素 | 未解析到 | after.elements + expect | 依赖 elements 是否采集到；观察过早则元素未渲染 → 误判 |
| `element_absent` | :48-53 | resolve 长度为 0 | 元素不存在 | 仍存在 | elements | 同上反向 |
| `login_state` | :54-60 | 正则 `/sign in\|log in\|.../` vs `/logout\|dashboard\|.../` | 未登录线索缺失或已登录线索存在 | 仅命中未登录 | textSummary | **纯文本正则，极脆**；多语言/文案变化即错；可能把「登录中」误判 |
| `page_change` | :61-71 | 无 before→URL 已加载；有 before→url 或 textSummary 变化 | 检测到变化 | 无变化 | before/after.url+textSummary | **before 实际多为上一步终态或 null**，无法检测「本动作」引起的变化 |
| `action_success` | :72-81 | 仅要求 `after.url` 存在 | 工具成功且有页面观察 | 缺 observation | after.url | **无真实状态断言**——工具成功但页面状态未变时 silent-ish 放行/或反之；对「状态未知」型无能为力 |
| `none` | :16-18 | 直接 true | 无需验证 | — | — | 绕过验证（Phase 6 的 96.7% none 即此） |
| `default` | :82-84 | 未知类型 | — | 一律 false | — | 未知类型直接判失败 |

**审计重点结论（对应指令四问）**：
1. **是否一次 observation 即判定？** 是。所有分支基于传入的单个 `after`，无循环、无延迟再判。
2. **是否存在 retry window？** 否。retry 发生在 `runtime.js` 主循环的**步骤级重试 / repair**，而非 `verify()` 内部。
3. **是否等待 DOM 稳定？** 否。`verify()` 纯函数，不触碰页面、不等待。
4. **是否区分「未完成」与「暂时未观察到完成状态」？** **否**。两类都被同一 `success:false` 吞掉，且 `evidence` 仅一句文本，无时序/稳定性信号可供上层区分。

---

## 4. Observation Layer Audit

**文件**：`observation.js`、`observationCache.js`。

**当前 observation 是否包含以下维度**（核对 `COLLECT_JS` 与 `inspect` 输出结构）：

| 维度 | 是否包含 | 代码依据 |
|---|---|---|
| DOM（元素/结构） | ✅ | elements[]（role/tag/type/name/cls/text/placeholder/label/aria/state/bbox） |
| visibleText | ✅ | out.visibleText（全页 innerText，去重） |
| role | ✅ | el.roleText / ROLE_TAGS |
| state（disabled/value/checked） | ✅ | elState() |
| network（请求/状态码/是否 idle） | ❌ | 无字段 |
| url | ✅ | out.url |
| screenshot | ❌ | 仅 evidence.saveSnapshot 单独存盘，不在 observation 结构内 |
| mutation（DOM 变化事件） | ❌ | 无 MutationObserver |
| loading state（是否仍在加载） | ❌ | 无 isLoading / isStable |
| timestamp（采集时刻） | ❌ | observation 本身无时间戳；cache 有写盘时间戳但不在 observation 内 |

**回答三个关键问题（基于代码 + Phase 9 数据）**：

- **VERIFY_FAILED 65% 是否可能因 Observation 时间点过早？—— 是，高概率。**
  `tools.js:230` 的 `goto` 仅 `waitUntil:'domcontentloaded'`；click/fill/action 后 `observation.inspect` **立即**执行（`click.inspect2` 等），全程无 `waitForLoadState('networkidle')` 或渲染稳定等待。SPA / 异步搜索结果 / Toast 提示在点击后数十~数百毫秒才渲染，此时抓到的 observation 尚未包含目标文本/元素 → `text_present`/`element_present` 误判失败。这是 OBSERVATION_DELAY 的**直接代码根因**。

- **是否可能因 Observation 信息不足？—— 部分是。**
  observation 缺 `network`/`loading`/`mutation`/`timestamp` 维度，导致**上层无法判断「这次观察是否足够晚」**。即便想做「等一会儿再观察」，也没有稳定性信号可依据，只能盲等固定毫秒。

- **是否可能因 Observation 没有历史上下文？—— 是。**
  `observationCache` 在内容 hash 未变时**返回上一次 summary**（`observationCache.js:17-23`）。这意味着：若页面还在加载、内容尚未变化，重观察会拿到**与上一次完全相同的旧快照**——既无法暴露「仍在变化」，也无法区分「确实无变化」与「还没加载完」。Phase 9 的 65 个 VERIFY_FAILED 中，凡属 EVENTUAL_CONSISTENCY/OBSERVATION_DELAY 的，都会被该缓存行为掩盖时序信息。

---

## 5. Checkpoint Integration Audit

**文件**：`checkpoint.js`（54 行）。

**verification failure 时是否读取 checkpoint？** 
- 否。`verify()` 与 `runtime.js` 验证失败分支（161-177）均**不读取** checkpoint。
- checkpoint 仅在**每步成功后**由 `runtime.js:253-259` 写入，字段含 `lastVerifiedState`、`lastSuccessfulAction`、`url`。其用途是**崩溃恢复/重放**（`checkpoint.restore` → `runtime.js:199` 恢复导航），**不是验证对比**。

**是否比较 before / after state？**
- `verify()` 的 `before` 参数来自 `runtime.js:249` 的 `beforeObs`——即**上一步成功后的 observation**，首次执行为 `null`。因此：
  - 它是「步骤级」before，不是「动作级」before（本动作执行前的快照由 `tools.js` 内部采集但未传给 `verify`）。
  - `page_change` 仅能检测「跨步骤」变化，无法检测「同一步内 action 引起的变化」。
- 修复验证 `repair/executor.js:63` 直接传 `before=null`，**完全丧失 before/after 对比能力**。

**是否支持状态变化检测？**
- `checkpoint.lastVerifiedState` 字段存在但验证路径**未消费**；当前状态变化检测仅 `page_change` 的 url/textSummary 粗比对，且 before 粒度粗。

**→ 记录为设计缺口（Confirmed Gap）**：
- G4：验证路径不读取 checkpoint，未做「动作前快照 vs 动作后快照」的精确状态变化检测。
- G5：修复验证 before=null，before/after diff 在 repair 场景完全失效。

---

## 6. Recovery Flow Audit

**文件**：`runtime.js`（266-367）、`repair/strategies/verifyFailed.js`、`recovery/strategies/verify.js`（空策略）、`repair/executor.js:63`。

**当前 VERIFY_FAILED 后的第一动作是什么？**（按 `runtime.js` 主循环顺序）
1. `failAttempt({code:'VERIFY_FAILED'})` → 返回 ok:false（**无任何内联 wait/重观察**，`runtime.js:175-176`）。
2. 进入 `retries`（≤ stepMax=3）：`recoveryManager.attempt` 产出确定性恢复候选动作（元素重定位/等待/重载），**再次 runStep 重跑该步**。
3. 重试耗尽 → `repairManager.handleStepFailure` → `verifyFailed.execute`：
   - `WAIT_STABLE`：`wait` 2500ms（`verifyFailed.js:50`）
   - `RECHECK_OBSERVATION`：`wait` 1500ms（`verifyFailed.js:58`）
   - `RETRY_VERIFY`：**用完整 target 重新执行原 action**（`verifyFailed.js:67`，`verification:none`，再交 executor 验证门）
   - `SEMANTIC_RELOCATE`：兜底元素重定位（`verifyFailed.js:81`）
4. 仍失败 → `taskManager.escalate` → HUMAN_ESCALATION。

**是否 WAIT？** 是，但只在 repair 策略里固定等 4s，且**与「重执行」捆绑**。
**是否重新观察？** 重执行 action 会触发 `tools.execute` 内新 observation，但**没有「只观察、不重执行」的纯重验证路径**。
**是否重新验证？** 有，但总是在「重执行之后」由 executor 统一门判定，无法「用新观察重跑同一验证规则」而不重做动作。
**是否重新执行 action？** 是——`RETRY_VERIFY` 就是重执行，存在**重复提交/重复点击**风险（如已成功的提交按钮再点一次）。
**是否直接 repair？** 否（repair 是 retries 耗尽后进入），符合「先重试后修复」的顺序。

**为什么 Repair Attempt Success 66.7% 但 Business Recovery 0%？（结合代码解释）**
- `RETRY_VERIFY` 重新执行动作 → `res.success` 大概率为真（动作本身协议级成功）→ `verifyFailed.execute` 返回 `{ok:true}`（动作级），且 `aiRepairAttempts.status=SUCCESS`（144/216）。**这是「修复尝试成功」的来源**。
- 但动作重执行后，**仍走 executor 的统一验证门**（`runtime.js:163`）——若验证条件本身过严（如 `text_present` 期望的文案 fixture 不产生、或 `action_success` 仅靠 url 存在但页面状态其实未变），**重执行无法改变验证结果** → step 最终仍 `VERIFY_FAILED` → escalate。验证门返回的仍是 `success:false` → 业务恢复为 0。
- 换言之：**repair 修的是「动作」，而 65% 的失败根在「验证/观察」，不是「动作」**。动作重跑对 OBSERVATION_DELAY / VERIFICATION_TOO_STRICT 无效，只对 ACTION 真未生效（REAL_FAILURE 子类）有效——但 Phase 9 数据显示这类占比有限。

---

## 7. VERIFY_FAILED Root Cause Classification（基于代码，非猜测）

> ⚠️ **数据诚实声明**：Phase 9 的 `aiFailureSnapshots.errorType` / `taxonomy` 仅把失败标为单一 `VERIFY_FAILED`，**未 instrument 子类**。以下 6 类占比为**基于代码路径 + fixture 特征 + Phase 9 宏观数据的推断**，非 store 实测细分。Step 2 的设计目标正是把这一推断变成可测量的真实分类。

| # | 子类 | 代码依据 | Phase 9 推断占比 | 自动恢复策略 | 是否需人工 |
|---|---|---|---|---|---|
| 1 | **REAL_FAILURE**（动作真未生效） | `tools.execute` 协议成功但页面状态未变；`action_success` 仅查 url（`verification.js:72-81`） | ~10-15% | 重执行 / 换 selector | 少量 |
| 2 | **EVENTUAL_CONSISTENCY**（异步状态延迟） | `goto` 仅 domcontentloaded；无 networkidle（`tools.js:230`） | ~25-30% | WAIT + 重观察 | 否 |
| 3 | **OBSERVATION_DELAY**（观察过早） | action 后 `inspect` 立即抓取，无渲染稳定等待 | ~20-25% | 重观察（不重执行） | 否 |
| 4 | **VERIFICATION_TOO_STRICT**（验证条件过严/错） | `text_present` 精确子串；`login_state` 正则脆；`action_success` 无状态断言 | ~20-25% | 放宽/重定义规则 | 否（多数） |
| 5 | **BUSINESS_STATE_UNKNOWN**（无法判断） | `action_success` silent-pass；observation 缺 network/loading/timestamp 维度 | ~10% | 增强观察 + 启发式 | 部分 |
| 6 | **DOM_CHANGED**（结构变化） | resolver 语义解析可兜底；但剧烈改版时 element_present 失效 | ~5-10% | SEMANTIC_RELOCATE | 少量 |

**合计 100%（推断）**。注意 2+3（纯时序类，本可自动恢复）合计约 **45-55%**——这与「repair 尝试 66.7% 成功却 0% 业务恢复」一致：当前 repair 用「重执行」去解决「时序/验证」问题，方向错配，所以修不好。

**分类识别方式（设计指向，非实现）**：
- 用 `observation.timestamp` + 动作完成时刻差判断 OBSERVATION_DELAY。
- 用 `network`/`isStable` 信号判断 EVENTUAL_CONSISTENCY。
- 用「动作前后 observation diff 已变化但规则不匹配」判断 VERIFICATION_TOO_STRICT。
- 用「动作协议成功但 observation 无任何状态变化」判断 REAL_FAILURE / BUSINESS_STATE_UNKNOWN。

---

## 8. Confirmed Design Gaps（已确认设计缺口）

| ID | 缺口 | 代码证据 | 影响 |
|---|---|---|---|
| G1 | 验证单次快照、无 retry window / 无稳定等待 | `verification.js:15-85` 纯函数；`runtime.js:161-177` 一次判定 | 时序类失败一律误判 |
| G2 | 观察过早：action 后无渲染/网络稳定等待 | `tools.js:230`(domcontentloaded) + click/fill/action 的 `.inspect2` 立即抓取 | OBSERVATION_DELAY / EVENTUAL_CONSISTENCY |
| G3 | observation 缺 network/loading/mutation/timestamp 维度 | `observation.js` 输出结构（见 §4） | 上层无法判断是否「足够晚」 |
| G4 | 验证路径不读 checkpoint，无「动作前快照 vs 后快照」精确 diff | `verify()` 不消费 checkpoint；`runtime.js:249` beforeObs=上一步 | 状态变化检测粒度粗 |
| G5 | 修复验证 before=null | `repair/executor.js:63` | repair 场景 before/after 完全失效 |
| G6 | VERIFY_FAILED 单一黑盒错误码，无子类 | `runtime.js:175` 仅 `code:'VERIFY_FAILED'` | 无法差异化恢复，全压 repair |
| G7 | repair 只有「重执行」无「纯重验证/重观察」路径 | `verifyFailed.js:67` RETRY_VERIFY=重执行 | 对时序/验证类无效 → 0% 业务恢复 |
| G8 | `action_success` 仅靠 url 存在，无真实状态断言 | `verification.js:72-81` | 状态未知型被放行或误杀 |
| G9 | `login_state` 纯正则，极脆且多语言敏感 | `verification.js:54-60` | 登录态误判 |

---

## 9. No-Code Recommendations（仅建议，未实现）

> 以下为**设计建议**，供 Step 2~Step 6 落地参考。**本阶段未修改任何代码，未进入实现。**

1. **引入 Verification Intelligence Layer（独立决策层，不碰 runtime）**：在 `verify()` 之上增加一个判定器，输入 `{action, target, observationHistory, previousAttempts, checkpoint, verificationRule}`，输出 `{verdict: SUCCESS|WAIT|RETRY_VERIFY|RE_EXECUTE|HUMAN_ESCALATE, confidence, reason, nextAction}`。runtime 主验证门改为「先过 Intelligence 层再终判」，而非现在的一次 `verify()`。
2. **为 observation 补时序/稳定性维度**（G2/G3）：采集 `timestamp`、`isStable`（基于 MutationObserver 静默窗口）、`pendingNetwork`（请求在飞数）。这**只扩展 observation 结构**，不改动执行逻辑。
3. **把 VERIFY_FAILED 拆类**（G6）：`verify()` 输出增加 `subType`（REAL_FAILURE / EVENTUAL_CONSISTENCY / OBSERVATION_DELAY / VERIFICATION_TOO_STRICT / BUSINESS_STATE_UNKNOWN / DOM_CHANGED），先**埋点测量**占比，再决定各子类策略。
4. **新增「纯重观察 + 纯重验证」路径**（G7）：repair 第一动作应为「WAIT → 重观察 → 用原 observation 重跑 verify」，仅在判定为 REAL_FAILURE/DOM_CHANGED 时才 RE_EXECUTE，避免重复提交。
5. **动作级 before 快照**（G4/G5）：`tools.execute` 已在内部采 before/after，把「动作前 observation」传入 `verify()` 的 `before`，让 `page_change` 与修复验证能用真正的 before/after diff。
6. **强化 `action_success` 与 `login_state`**（G8/G9）：`action_success` 增加可选状态断言（如期望文本/元素）；`login_state` 改为多信号融合（URL + 元素 + 文案）而非单正则。

---

**本 Step 1 完成：仅审计、未改代码、未跑 benchmark、未调成功定义。等待下一步（Step 2 Verification Failure Taxonomy 设计）授权。**
