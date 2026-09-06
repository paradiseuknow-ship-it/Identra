# PRODUCT_CORE_RUNTIME_AUDIT

> STEP 0 — PRODUCT CORE AUDIT
> 日期：2026-08-29
> 性质：**只读审计。未修改任何源码。**（`git status` 复核：仅新增本文档）
> 方法：按 §23 六步取证 —— ① 现有实现 ② 调用方 ③ 数据结构 ④ 测试 ⑤ 真实运行路径 ⑥ telemetry
> 上游文档：`docs/product/PRODUCT_CORE_ROADMAP.md`（A–O 能力矩阵与 P0/P1/P2）
> 本文档回答「Runtime 真实怎么跑」，是下一步改造的事实基础。

---

## 0. 审计方法说明（为什么这份报告和 grep 出来的不一样）

本项目最大的取证陷阱是：**`grep` 到文件 ≠ 功能在主链生效**。

实测：全仓有 6 个模块「有实现、有测试、有导出」但**生产执行链零调用**。
如果按 grep 结果判断能力，会得出完全错误的结论。

因此本报告对每个结论严格区分四种状态：

| 状态 | 含义 | 判据 |
|---|---|---|
| **IN-CHAIN** | 在真实执行链上被调用 | 能从 `POST /tasks/:id/start` 追到实际调用点 |
| **PARTIAL** | 在链上但不完整 / 半截 | 有调用点但前置条件缺失或读侧/写侧缺一边 |
| **ORPHAN** | 有实现但生产链零调用 | 仅 `scripts/`、测试、只读 API 引用 |
| **MISSING / 空壳** | 目录为空或根本没有 | `ls` / 全仓零命中 |

**本次审计额外做了运行时数据取证**（`server/data/aiAttempts.json`，4661 条真实 attempt），
用于把"架构上不对"升级为"实测造成了多少伤害"。这是本报告与前一份能力审计最大的区别。

---

# 第一部分：Q1–Q18

## 一、正向主链（Q1–Q7）

### Q1. 当前真实 Runtime 主链是什么？

**结论**：只有**一条**真实执行器 `runtime.run`。Scheduler/Worker 是可选编排层，必须手动
`POST /api/ai/execution/scheduler/start` 才介入，默认不跑；且 Worker 内部仍委托 `taskManager.start`，最终汇入同一 `runtime.run`。

```
server/index.js:500   app.use('/api/ai', require('./agent'))
  → server/agent/runtime.js:635   taskManager.setExecutor(run)        ← 唯一执行器注册
POST /api/ai/tasks            (agent/index.js:42)  → taskManager.createTask (:49)
POST /api/ai/tasks/:id/start  (agent/index.js:61)  → taskManager.start (:130)
  → recorder.createExecution(:149) → lock.acquire(:156)
  → 状态机 PENDING→PLANNING→PREPARING→PROFILE_READY→BROWSER_READY→RUNNING (:178-186)
  → checkpoint.save(:197) → _kick(:35, setImmediate)
  → runtime.run (runtime.js:353)
      → ensureBrowser(:54) → browserManager.launch(browserManager.js:551)
      → resolvePlan(:135) → planner.planObjective
      → while (index < steps.length) (:400) → runStep(:172)
          → tools.execute (tools.js:161) → runTool(:330) → page.*
          → verification.verify (:242) → VIL → stepManager.succeedAttempt / failAttempt
      → 收口：taskManager.complete(:619) / fail(:603) / escalate(:583)
```

**测试**：`testAgentPhase2.js`（生命周期）、`testAgentInfra.js`（lock/queue/budget）、`test_phase4_blockers.js`
**telemetry**：`events.emit` → `store.appendEvent`（events.js:66）+ SSE 广播（:76）。
事件：`task.created/started/completed/failed`、`ai.action.started/completed`、`agent.retrying`、`agent.replan`。

**⚠️ 缺口**
1. `_kick` 用 `setImmediate` 且**无并发去重**：一次 `resume` + 一次 `retry` 可同时起两个 `run` 协程（`runtime.js:432` 只挡 `paused`）。
2. 无幂等键；进程重启靠 `recoveryManager.recoverInterruptedTasks` 补。

---

### Q2. 用户输入如何进入 Runtime？

**结论**：`POST /api/ai/tasks` **零 body 校验**，直接 `createTask(req.body)`。可传字段仅 10 个：
`name / objective / targetUrl / profileId / executionMode / policy / budget / priority / secretRefs / dependsOn`。

**没有** `credentialRef`、`paymentMethodRef`、`proxyId`。`profileId` 必传，否则执行直接失败。

```js
// agent/index.js:42-49 —— 无任何校验
router.post('/tasks', (req, res) => {
  try { const t = taskManager.createTask(req.body || {}); res.json(t); }
```

```js
// runtime.js:55
if (!task.profileId) return { ok: false, error: '任务未绑定 Profile' };
```

**已复核的两个静默断裂（本次新发现，且均已运行时证实）**：

#### 断裂 2-A：`constraints` 被 `createTask` 静默丢弃

```js
// taskManager.js:49-77  createTask 构造的 task 对象里 —— grep constraints 结果 = 0 条命中
const task = { id, name, objective, targetUrl, profileId, executionMode,
               policy, budget, priority, secretRefs, dependsOn, status, ... };
//  ↑ 没有 constraints
```
而 `runtime.js:159` 用的是 `constraints: task.constraints || []`，`planner.js:130` 据此渲染
`(constraints && constraints.length ? '约束：' + constraints.join('; ') : '')`。

> **实测结论**：走 `/tasks` 创建的任务，`task.constraints` 恒为 `undefined`
> → Planner 永远拿到 `[]` → **prompt 中的「约束：」一行永不出现**。
> 用户下达的约束（如"最多重试 3 次""不要删除任何东西"）**根本传不到 Planner**。

#### 断裂 2-B：`task.secretRefs` 进不了真实 LLM prompt

```js
// planner.js:90-97  —— 只有 mock 路径的 taskLike 收下 credentialRefs
async function planObjective({ objective, target, constraints, credentialRefs, ... }) {
  const taskLike = { objective, targetUrl: target, constraints, secretRefs: credentialRefs || [], ... };
```
```js
// planner.js:124-137  buildStructuredOpts —— deepseek/openai 真实路径
prompt: `目标：${goalText}\n` + (target ? `入口地址...` : '') +
        (constraints && constraints.length ? `约束：...` : '') +
        `请按下列 Plan Schema 与 Action 约束输出 JSON：\n${PLANNER_INSTRUCTIONS}\n\n` + (CB || '') + ...
//  ↑ 全文 grep "credential" = 0 次命中（已运行时复核）
```

> **实测结论**：真实 LLM 规划时**看不到任何凭据引用**。
> 而 `schema/action.js` 对 `SENSITIVE_FIELDS`（password/cvv/cardNumber/otp/...）**禁止 value 字面量**、只允许 `credentialRef`。
> → 模型要么硬写 `value`（被 schema 拒绝），要么**幻觉编造一个 credentialRef**（运行中实测出现过 `credentialRef: "cvv"` 这种伪 id）
> → `credentialUnavailableError`（tools.js:693）→ `CREDENTIAL_UNAVAILABLE` → **直送人工，不进 repair、不重试**。

**⚠️ 其他**：`parser.js` 在 `/tasks` 主链是孤儿（唯一生产调用 `agent/index.js:389`，仅 `/chat`）；objective 是裸字符串，无 URL/约束抽取。

---

### Q3. Target 如何产生？

**结论**：**Planner 能看到 Observation** —— 自 Phase 9 P4 起 `resolvePlan` 会先真实导航 + `observation.inspect`，再经 `contextBuilder` 注入 prompt。这一点是**正确的**，符合「证据驱动」而非「凭空猜」。

```
runtime.js:135 resolvePlan
  → :140 capturePlanningObservation → :124 page.goto(task.targetUrl) → :126 observation.inspect
  → :144 contextBuilder.build({ observation: planningObs, ... })
  → planner.planObjective(:90) → contextBlock(:59) → LLM
  → validatePlan(schema/plan.js:36) → normalizeTarget(:174)
  → stepManager.createStep(:14) → runtime 执行
```

`TARGET_KEYS = ['semantic','role','field','text','selector','index','url']`（schema/action.js:36），
`validateAction` 要求至少命中一个（back/forward 除外）。

```js
// planner.js:69-74 —— Planner 可见页面内容，且被明确要求不得臆造
lines.push('页面元素清单（...必须从中选取真实存在的 id / name / text / ariaLabel，禁止臆造...）'
  + JSON.stringify(c.page.elements));
```

**⚠️ 缺口**
1. **`resolvePlan` 首行短路**：`if (steps.length) return steps;`（runtime.js:136-137）。一旦走 `/chat` 或 `attachPlan` 预挂计划，**Planner 完全不执行**，target 全部来自 flow memory / 硬编码。
2. **元素被截断两次**：observation 截 80 个（observation.js:287）→ contextBuilder 截 30 个（:57-64）。长表单（注册/结算）会丢字段。
3. **导航条件有洞**：`capturePlanningObservation` 只在 `!samePage` 时 goto（runtime.js:122-125）。复用 session 时若浏览器停在别的页面，**会对错误页面做观察**。

---

### Q4. Planner 如何产生 Action？

**结论**：**一次性生成整个 Plan**（非逐步）。这是"计划与执行脱耦"的根源。

```
runtime.js:156 planner.planObjective
  → planner.js:115 能力检测 → :150 provider.plan（mock）或 :165 provider.structured（真实）
  → :200 validatePlan → :203 recordPlannerEvidence → 返回 { ok, plan }
```

prompt = system + 目标 + 入口地址 + 约束 + `PLANNER_INSTRUCTIONS` + `contextBlock`。
schema 在 `schema/plan.js`。重试 3 次（planner.js:112/143）。

**⚠️ 缺口**
1. **步骤级失败不触发 replan**。只有重试耗尽后的 `tryReplan`（runtime.js:669），且受 `isReplanCandidate` 过滤 —— 仅 `DOM_CHANGED` / `ACTION_REAL_FAILURE`（非凭证类）触发（:658-665），`maxReplans=2`。
   → **未知网站一旦首轮 plan 编错，在本次执行内没有纠偏通道。**
2. `credentialRefs` 不进 prompt（见 Q2 断裂 2-B）。
3. `constraints` 恒为空（见 Q2 断裂 2-A）。

---

### Q5. Action 如何进入 Browser？

**结论**：唯一入口 `tools.execute`（tools.js:161）。**`contextGuard.guard()` 确认在 `tools.js:206` 每个动作前被调用。**

```
runtime.js:203 tools.execute
  → tools.js:165 validateAction（二次校验）
  → tools.js:172 policy.allowsAction (policy.js:52)
  → tools.js:184 lock.getOwner 校验 execution 持锁
  → tools.js:152 getPageFor → browserManager.getSession(:846) → session.page
  → tools.js:200 observation.inspect('guard.inspect')
  → tools.js:203 pageStateClassifier.classify
  → tools.js:206 contextGuard.guard(...)      ← 已运行时确认
  → tools.js:236 runTool(:330) → switch(action.type)
      → resolveSelector(:609)：显式 selector → elementMemory → semanticResolver.resolve → pageReady.waitForElement
      → withBrowserOp(:82) 包裹 page.click/type/goto
```

**guard 阻断规则**（contextGuard.js:169-230）：

| 规则 | 行号 | 阻断码 |
|---|---|---|
| 需元素的动作落在 BLANK 页（SPA 未挂载） | :177 | `CONTEXT_NOT_READY` |
| 只读/观察动作 | :190 | 永不阻断（`read_only`） |
| 转场动作目的地 URL 与期望站点冲突 | :196/:83 | `CONTEXT_WRONG_APP` |
| 动作语义 vs 页面状态直接矛盾 | :202/:70 | `CONTEXT_WRONG_APP` |
| 期望站点 vs 页面状态错配（saas+GENERIC 走专用证据裁决） | :206-227 | `CONTEXT_WRONG_APP` |

guard **不判成功，只阻断**（contextGuard.js:3），这一点设计上是对的。

**🔴 实测伤害（本次审计最重要的量化发现）**

运行时数据 `server/data/aiAttempts.json`（4661 条 attempt）失败码分布：

| error.code | 次数 | 占失败比 |
|---|---|---|
| `VERIFY_FAILED` | 1115 | **51.3%** |
| `CONTEXT_WRONG_APP` | **609** | **28.0%** |
| `ELEMENT_NOT_FOUND` | 270 | 12.4% |
| `RESOURCE_LOCK` | 53 | 2.4% |
| `NO_VALUE` | 52 | 2.4% |
| `CREDENTIAL_UNAVAILABLE` | 40 | 1.8% |
| `ACTION_INVALID` | 28 | 1.3% |
| `TOOL_EXECUTION` | 7 | 0.3% |

对 609 条 `CONTEXT_WRONG_APP` 的 message 去重统计：

```
553 次 | 期望站点=saas 但当前页面状态=GENERIC，上下文明显错误（E5）
 56 次 | 上传任务落在资源下载页，上下文明显错误（E5）
```

> **553 次拦截（占 CONTEXT_WRONG_APP 的 90.8%、占全部失败 attempt 的 25.4%）的阻断原因
> 字面就是「期望站点=saas」。**
>
> 这不是"架构洁癖"问题，也不是"代码不够优雅"问题 ——
> **这段被红线明确禁止的站点类型代码，在真实运行中拦掉了四分之一以上的动作尝试。**

**⚠️ 其他缺口**
1. guard **fail-open**：`if (pageStateObs && pageStateObs.observation)`（tools.js:202）—— 观察失败时整段守卫被跳过，动作直接执行。
2. `deriveExpectedSite` 只认 4 个硬编码站点，对未知网站恒返回 `null` → 规则 2/3 理论上不生效。但规则 3 的 `saas` 分支在 URL 含 `cloud`/`saas`/`admin`/`console` 时会命中，用 `SAAS_TEXT_RE` 的 mock 语料关键词裁决 —— **在未知网站上这是误判源，不是保护**。
3. `assertPageAlive`（:63-67）的 session 移除检测是空实现。
4. `withBrowserOp` 的 `Promise.race` 超时（:103）对冻结事件循环无效（代码注释已自认）。

---

### Q6. Observation 在哪里产生？

**结论**：`observation.inspect`（observation.js:262）是唯一产生点。采集字段充分，但**无独立持久化**。

产出字段（observation.js:280-328）：`url / title / textSummary / visibleText / roleText / elements(≤80) / errors(≤10) / timestamp / loadingState / domFingerprint / networkState / elementState / observationId / parentObservationId / source / actionFinishedAt / fresh / previousObservationDiff(六维)`。

消费方：
```
observation.inspect
  ├→ contextBuilder.build → Planner
  ├→ pageStateClassifier.classify → contextGuard.guard
  ├→ semanticResolver.resolve → 选 selector
  ├→ verification.verify → 读 textSummary/url/elements
  └→ verificationIntelligence.analyze → DOM_CHANGED 分型
```

**pageReady 等待逻辑**（pageReady.js:22-29）：有可见文本 **或** 有元素即认为就绪；`timeoutMs=8000`、`intervalMs=400`（:41-52）。

VIL 观察窗口（verificationWindow.js:24-26）：
```js
const SCHEDULE_STATE_UNKNOWN = [300, 800, 1600];  // 累计 ~2.7s
const SCHEDULE_TIMING        = [250, 600, 1200, 2200]; // 累计 ~4.3s
const DEFAULT_MAX_MS = Number(process.env.VIL_WINDOW_MAX_MS) || 5200;
```

**⚠️ 缺口**
1. **Observation 无独立持久化**：事后无法重放"某一步当时看到了什么"，只能从 `aiAttempts.error.observationBefore/After` 捞被截断的快照。
2. **before-observation 可能命中缓存**：tools.js 多处 before 调用未传 `skipCache`，会走 `obsCache.get`（observation.js:272-276）返回旧对象 —— 缺本次血缘字段，与 after 的 diff 语义失真。

---

### Q7. Verification 在哪里产生？

**结论**：`runtime.js:242` 是主链唯一调用点。最终成功依据 = step 级 `vres.success`（或 VIL 窗口 `win.recovered`）+ task 级全部 step SUCCESS/SKIPPED。

```
runtime.js:239 buildEffectiveVerification
  → verification.js:154 action.expectedBusinessState（Planner 显式契约，优先）
  → verification.js:165 contract.deriveContract(action)（按 type 推导）
runtime.js:242 verification.verify(effV, toolRes.observation, beforeActionObs)
  → contract.evaluateContract：forbiddenEvidence 硬失败 → requiredEvidence AND/OR → allowedAlternatives 递归 OR
  → 非合约分支：switch(type) 10 种
!vres.success → runtime.js:249 verificationIntelligence.analyze
  → :266 isReobservableDecision(WAIT/RECHECK_OBSERVATION/RETRY_VERIFY)
      → :273 verificationWindow.runObservationWindow（只重观察，绝不重执行）
      → win.recovered → step SUCCESS（:298-300）
  → :309 HUMAN_ESCALATE → taskManager.escalate（:315）
  → 否则 failAttempt(VERIFY_FAILED)（:338）
全部 step 走完 → :608-619 → taskManager.complete / fail
```

```js
// successMetrics.js:14 —— 业务成功唯一口径
function isBusinessSuccess(task) { return !!(task && task.status === 'SUCCESS'); }
```

**⚠️ 缺口**
1. **无验证时直接放行**：`runtime.js:240` 的 `if (effV && (effV.businessState || (effV.type && effV.type !== 'none')))`
   —— 若 effV 为 `{type:'none'}`，**整段验证被跳过，step 直接 succeedAttempt**。`navigate/wait/scroll/press/extract` 仍可裸奔。
2. **`contractFromObjective`（contract.js:180）是孤儿** —— 已导出但生产零调用。
   objective 的「注册/选套餐/支付」语义**从未参与业务完成态推导**，只能靠 Planner 自报 `expectedBusinessState`。
3. VIL 窗口上限 5.2s，对真实站点支付 / 邮件 OTP 等异步场景过短。

---

## 二、失败链（Q8–Q13）

### Q8. Failure 在哪里产生？

**结论**：**没有统一失败模型**。benchmark 的四分类（VERIFY_FAILED / POLICY_BLOCK / ELEMENT_NOT_FOUND / OTHER）
是**离线脚本事后正则标注**，运行时根本不存在 `POLICY_BLOCK` 和 `OTHER` 这两个码。

```js
// server/scripts/phase10Benchmark.js:184-195 —— "四分类"的真实出处
function classifyTaxonomy(final, codes, escalationKind) {
  if (final.status === 'SUCCESS') return null;
  if (final.status === 'HUMAN_ESCALATION' && escalationKind === 'CREDIBLE') return 'POLICY_BLOCK';
  if (codes.some((c) => /ELEMENT_NOT_FOUND/.test(c))) return 'ELEMENT_NOT_FOUND';
  if (codes.some((c) => /VERIF|VERIFICATION/.test(c))) return 'VERIFY_FAILED';
  if (codes.some((c) => /CREDENTIAL|POLICY|BLOCK|APPROVAL/.test(c))) return 'POLICY_BLOCK';
  return 'OTHER';   // ← OTHER = 兜底，语义是"没匹配上任何已知码"
}
```
`grep 'POLICY_BLOCK|OTHER'` 在 `server/agent/` 下**零命中**。

**真实生产失败点（8 类）**：

| code | 位置 | 走向 |
|---|---|---|
| `ELEMENT_NOT_FOUND` | tools.js 9 处（:381,450,460,487,499,511,524,535,584） | 可重试 |
| `ACTION_REQUIRES_APPROVAL` | tools.js:176（policy 门）→ runtime.js:225 | ≈ benchmark 的 POLICY_BLOCK |
| `VERIFY_FAILED` | runtime.js:329-338 | 可重试 |
| `TOOL_EXECUTION` | tools.js:238（catch-all） | 可重试 |
| `STEP_TIMEOUT` | runtime.js:430（30s race） | 可重试 |
| `CONTEXT_WRONG_APP` | tools.js:221（guard） | 可重试 |
| `CREDENTIAL_UNAVAILABLE` | runtime.js:217 | **直送 escalate，不重试** |
| `HUMAN_ESCALATION` | runtime.js:316（VIL 决策） | 终态 |

**数据结构**：唯一规范化器 `stepManager.js:151-167` `normalizeErrorShape`，含 `code/message/failureType/confidence/evidence[≤5]/observationBefore/observationAfter`。

**⚠️ 缺口**：`code` 是裸字符串无枚举约束；`TOOL_EXECUTION` 是 catch-all，任何未预期异常都塌缩成这一个码，**抹掉根因**；12 个 OTHER 任务在运行时**无法归因**。

---

### Q9. Network 数据在哪里？

**结论**：**MISSING。完全没有网络采集。**

```js
// observation.js:15-25 —— 全 server/ 仅有的 3 个 page.on，且只是标量计数
function ensureNetHook(page) {
  if (page.__vilNetHooked) return;
  page.__vilNetHooked = true;
  page.__pendingRequests = 0;
  page.on('request',         () => { page.__pendingRequests = (page.__pendingRequests || 0) + 1; });
  page.on('requestfinished', () => { page.__pendingRequests = Math.max(0, (page.__pendingRequests || 0) - 1); });
  page.on('requestfailed',   () => { page.__pendingRequests = Math.max(0, (page.__pendingRequests || 0) - 1); });
}
```

已复核确认：
- URL / method / status / statusText / headers / body / timing / redirect / initiator —— **全部丢弃，从不持久化**
- 全仓 **零** console / pageerror 监听（已运行时复核）
- 唯一的 `page.route('**/*')`（browserManager.js:348）是**丢弃**请求（blockVideo/blockImages），不是采集
- `server/data/` 无任何 network / request / console 集合

**🔴 这条缺失的实测后果**

```js
// recovery/errorClassifier.js:45-48 —— 判断网络错误只能靠错误消息正则
if (/net::err_name_not_resolved|net::err_connection|ERR_NETWORK/i.test(msg)) return 'NETWORK_ERROR';
// :57-60 —— 判断服务端错误靠"消息里出现 500|502|503|504"
if (/\b(500|502|503|504)\b/.test(msg)) return 'SERVER_ERROR';
```

> **如果后端返回 `200 + {error: 'duplicate_email'}`（现代 SPA 的绝对常态），
> 分类器完全看不见。**
>
> Agent 会认为"动作执行成功了"，然后验证失败，然后——因为看不到网络——**只能猜**。
> 这是 36.81% 验证准确率与 51.3% VERIFY_FAILED 的共同根因。

---

### Q10. Diagnosis 是否真正进入 Runtime？

**结论**：**PARTIAL**。`diagnosisEngine` 在链内，但**只在 3 次盲目重试烧完之后**才跑；`executionFailureTaxonomy.js`（149 行 9 类分类法）是**孤儿**。

```
runtime.js:535 repairManager.handleStepFailure
  → repairManager.js:32 errorClassifier.classify（无 LLM，廉价）
  → repairManager.js:38 failureAdvisor.resolveDiagnosis（命中历史经验则跳过 LLM）
  → repairManager.js:57 diagnosisEngine.runDiagnosis   ← 唯一 LLM 诊断点
  → repairManager.js:67-69 强制覆盖 diag.diagnosis.category = 'VERIFICATION_FAILED'   ← 对 LLM 分类不信任
  → repairManager.js:73 写 t.lastDiagnosis → store
```

`GET /api/ai/tasks/:id/diagnosis`（agent/index.js:121-132）返回 `t.lastDiagnosis` + 最近 5 条 failureSnapshot —— **事后查看**，数据来自链内 :73。

`executionFailureTaxonomy.js` 全仓引用仅 `scripts/analyze_phase4.js:17`、`scripts/test_phase4_blockers.js:8`，文件头自标「只读」。它的 9 类 taxonomy 与 `diagnosisSchema` 的类别体系**并行且不一致**，运行时从不调用。

**⚠️ 缺口（三重叠加）**
1. **诊断在 3 次盲目重试烧完之后才发生** —— 前 3 次重试是无诊断的（见 Q12）。
2. `failureAdvisor` 命中时**完全跳过 LLM 诊断**（:46-51），历史错误经验会自我强化。
3. `repairManager.js:67-69` 硬编码覆盖诊断类别 —— 补丁叠补丁，说明对 LLM 分类不信任。

---

### Q11. Repair 是否真正进入 Runtime？

**结论**：**IN-CHAIN，但位于末段**。触发条件是**重试耗尽后**（不是"任何失败都修"）；策略**按诊断类别查表选**；`selfHealing/` 是**空目录**（`ls -A` 复核 = 0 文件）。

```
runtime.js:532-548（REPAIR_TIMEOUT_MS=90s race）
  → repairManager.handleStepFailure(:26)
    → :32 errorClassifier → :38 failureAdvisor → :57 diagnosisEngine
    → :79 repairPlanner.planFromDiagnosis → STRATEGY_FOR_CATEGORY 查表
    → :92 repairPolicy.canExecute → :102-112 executor.executePlan × maxAttempts(3)
      → executor.js:42 tools.execute（每个修复动作走全链路 Policy/Lock/Recorder）
      → executor.js:65 verification.verify（修复动作成功 ≠ 修复成功）
```

**策略查表**（repairPlanner.js:9-35，纯查表，AI 不发明策略）：

| 诊断类别 | 策略 | 模块 |
|---|---|---|
| ELEMENT_CHANGED / NOT_FOUND / NOT_INTERACTABLE | `SEMANTIC_RELOCATE` | elementChanged |
| TIMEOUT / PAGE_NOT_READY / NETWORK_ERROR | `WAIT_RETRY_RELOAD` | timeout |
| NAVIGATION_FAILED / SERVER_ERROR | `RELOAD_OR_BACK` | navigation |
| **VERIFICATION_FAILED** | `VERIFY_RETRY` | verifyFailed（11KB，最复杂） |
| OBSTRUCTION | `DISMISS_OVERLAY` | obstruction |
| SESSION_EXPIRED / HTTP_FORBIDDEN / CREDENTIAL_MISSING | `REAUTH_OR_PAUSE` | sessionExpired |
| BROWSER_CRASH / UNKNOWN | `GENERIC_RETRY` | generic |

**记录字段**（repairAttempts.js:15-34）：`strategy / strategyType / risk / confidence / diagnosisId / actions[] / verification / error / status / createdAt / finishedAt`。
有 strategy、有 result、有 confidence；**无独立 `why` 字段**，evidence 需经 `diagnosisId → failureSnapshot` 二次跳转。

**⚠️ 缺口**
1. `selfHealing/` 空目录 —— 「自愈」在产品里只是 `repair/` 的别名，无独立能力。
2. 修复成功率实测仅 2.17%，因为 3 次盲目重试已先烧掉预算。
3. `_verifyFailCount`（verifyFailed.js:27）是**进程内 Map**，重启即失忆，stalePlan 判断不可靠。

---

### Q12. Retry 是否真正进入 Runtime？

**结论**：**IN-CHAIN，但存在明确的零信息盲目重试** —— 这是本审计发现的**第二大业务伤害源**。

```
runtime.js:400 while (index < steps.length)
  → :461-465 stepMax=3 / retries+=1 / canRetry
  → :471 setStepState(HEALING)
  → :483 recoveryManager.attempt(task, step, r.error)
      → :47 errorClassifier.classify → :50 policy.resolve(category) → STRATEGY_MAP
      → :65-66 mod.getAction(step, attempts)      // 候选动作（有则替换，无则原样）
      → :68-69 mod.getPreActions(attempts)        // wait/reload/back 前置序列
  → :500 backoffSleep(retries) → :501 continue
```
退避 `base=300ms, cap=5000ms, 300×2^(n-1)`（runtime.js:46-51）。

**🔴 已复核：占失败 51.3% 的 VERIFY_FAILED，其重试策略是零信息原样重跑**

```js
// server/agent/recovery/strategies/verify.js —— 全文
'use strict';
// 策略：验证失败 → 重新观察后重试（runtime 每次 attempt 都重新观察）。
function getPreActions(attempts) { return []; }
module.exports = { getPreActions };
//  ↑ 注意：没有 getAction
```
→ `recoveryManager.js:64` 的 `action = step.action` 保持原值 → **同一动作原样重跑 3 次**。
`generic.js` 同样 `return []`。

**对照**（证明框架本身支持信息增益重试，只是没给最主要的失败类型实现）：
```js
// recovery/strategies/elementMissing.js:34-38 —— 有信息增益
function getAction(step, attempts) {
  const variants = buildElementVariants(step.action);   // 按 attempts 取同义词语义变体
  const idx = Math.min(attempts, variants.length - 1);
  return variants[idx];
}
// timeout.js:5 / navigation.js:5 —— 有 ['wait','reload','back+reload'] 前置序列
```

> **因果链闭合**：
> VERIFY_FAILED 占失败 51.3% → 它的重试是零信息原样重跑 3 次 → 3 次后进入 repair（成功率 2.17%）
> → 再 escalate。
> **这就是 80% 升级率的直接机制解释。**不是 AI 不够聪明，是失败后没有任何新信息进入系统。

---

### Q13. Memory 在哪里写入？

**结论**：**PARTIAL**。3 写 2 读 + 1 孤儿 + 1 有写无读。

| 记忆 | 写 | 读 | 状态 |
|---|---|---|---|
| **elementMemory** | `runtime.js:296`（VIL 恢复后）、`:345`（业务验证通过后）→ `confirmPendingSuccess`；失败侧 `tools.js:304` | `tools.js:631` getCandidate | ✅ **闭环** |
| **failureKnowledge** | `failureCollector.js:34/41` ← `repairManager.js:120` | `failureAdvisor.js:42` ← `repairManager.js:38`（短路 LLM 诊断） | ✅ **闭环** |
| **flowMemory** | `taskManager.js:401-403`，**仅在 complete() 成功路径** | `flowPlanner.js:19` ← 仅 `/chat` 创建路径；**`planner.js` 零引用** | ⚠️ **有写无读** |
| **siteMemory** | `recordTaskResult`（:32）**零生产调用点**；`recordFailureProfile`（:58）← `failureCollector.js:44` | `intelligenceRouter`（孤儿）、只读 API | ⚠️ **成功侧孤儿** |

**elementMemory 写入闸已确认正确**（写入条件 = 业务验证通过）：
```js
// runtime.js:344-346
// Phase 9 P3：业务验证通过 → 确认挂起的元素记忆（记忆只由业务结果强化，不再由动作机械成功强化）
if (toolRes && toolRes.memoryConfirmation) {
  try { require('./intelligence/elementMemory').confirmPendingSuccess(toolRes.memoryConfirmation); } catch (e) {}
}
```
（对比 `test_phase9_p3_memory_governance.js` 记录的旧缺陷：confidence=1 / success=208 / failed=0 的假成功记忆 —— **污染治理已生效**。）

**记忆元数据**（memoryRecord.js:17-32）：
```js
{ id, version, status:'ACTIVE', confidence:0,
  samples:{ success:0, failed:0 }, successRate:0,
  source:{ type:'ai_success' },
  stats:{ hits, memoryHits, semanticFallback, falsePositive }, createdAt, updatedAt }
```

| 要求字段（§13） | 状态 |
|---|---|
| `confidence` | ✅（:55-61，`rate × maturity × sourceWeight`） |
| `successCount` / `failureCount` | ✅（`samples`） |
| `lastVerified` | ❌ **无**（只有 `updatedAt`） |
| `scope` | ❌ **无独立字段**（编码进 `key` 字符串 `site\|semantic\|contextKey`） |
| `invalidate` | ❌ **无 API** |
| `decay` | ❌ **无**（唯一"失效"是 `memoryRecord.js:50` 硬编码阈值：`total>=5 && successRate<0.4` → DEPRECATED） |
| `revalidation` | ❌ **无**（DEPRECATED 后永不复活） |

---

## 三、支付 / 凭据 / 污染面（Q14–Q18）

### Q14. Payment 当前真实链路是什么？

**结论**：**BROKEN**。不存在 Payment Intent 对象，不存在 `paymentMethodRef`。
`purchase` / `payment` 在 `tools.js` 里只是「按语义找一个按钮并拟人点击一次」，与 `click` 等价。

```js
// tools.js:435-455 —— 五个高风险类型共用一个"点击"实现
case 'delete': case 'update_account_settings': case 'purchase':
case 'payment': case 'password_change': {
  let sel = await resolveSelector(action, obs.observation, meta, page);
  ...
  await browserManager.humanClick(page, sel.selector, {});
  return RESULT.ok({ acted: action.type, selector: sel.selector, ... });
}
```

```js
// tools.js:674-687 —— 已复核的填卡断点
async function resolveFillValue(action) {
  const field = (action.target && action.target.field) || '';
  if (action.credentialRef) {
    const resolved = secretManager.resolve(action.credentialRef);
    if (!resolved) return null;
    const s = resolved.secrets || {};
    const f = String(field).toLowerCase();
    if (f.includes('email'))    return s.email    || null;
    if (f.includes('password')) return s.password || null;
    return s.email || s.password || null;      // ← card / cvv / exp 全部落到这里
  }
  return action.value !== undefined && action.value !== null ? String(action.value) : null;
}
```

**Vault**：`server/vault.js` `aes-256-gcm`（:27），主密钥 `FPB_MASTER_KEY`（:13-16）；
**未设置时退化为一次性内存密钥**（:18-19，重启即永久失效）。落盘 `server/data/vault.json` 仅存密文（:44-48）。
`setProfileSecrets` 支持 `card{number, expMonth, expYear, cvv, name}`（:75-84）。
`agent/tools.js` **不直接读 vault**，只经 `secretManager`（引用注册表 + 脱敏视图）。

**🔴 已复核的越权设计缺陷**

```js
// policy.js:33 —— 名为"支付类"，实际包含 delete 与 password_change
const PAYMENT_TYPES = new Set(['purchase', 'payment', 'password_change', 'delete']);

// policy.js:16-22
function autoPaymentAllowed(policy) {
  if (!policy || policy.autoPayment !== true) return false;
  if (process.env.NODE_ENV === 'test') return true;
  if (process.env.FPB_ALLOW_AUTOPAY === '1') return true;
  return false;
}

// policy.js:71-75 —— CRITICAL 门
if (risk === 'CRITICAL') {
  if (autoPaymentAllowed(policy) && PAYMENT_TYPES.has(action.type)) {
    return { allowed: true, requiresApproval: false, reason: `测试环境 autoPayment=true 放行 ${action.type}` };
  }
  return { allowed: false, requiresApproval: true, ... };
}
```

> **`FPB_ALLOW_AUTOPAY=1` 会自动放行 `delete`（删除动作）与 `password_change`（改密码）。**
> 一个命名为"自动支付"的开关，实际授权范围是"删除账号 + 改密码 + 支付"。
> 而真正的 `purchase` 反而只是 HIGH（`schema/action.js:29`），**永远走不到 CRITICAL 分支**，`autoPayment` 对它无效。
> **即：该开关放行了最危险的两个动作，却没放行它名字所指的那个动作。**

**讽刺之处**：唯一具备完整填卡能力的 `server/automation/templates.js:24-40`（`checkoutTemplate`，能填 `{{card.number}}` / `{{card.cvv}}`）
在**非 AI 的工作流模板链**上（`server/index.js:22 runWorkflow` → `engine.js:17 vault.getProfileSecrets`），
AI 链路的 `resolveFillValue` 反而填不了卡。

**AI 走完一次真实支付，当前缺 5 步**：
1. Payment Intent 对象（amount / currency / planId / merchant / 幂等键）—— **无**
2. Payment Method 注册表（vault 只按 profileId 存单张卡，AI 无法"选哪个已授权支付方式"）—— **无**
3. `resolveFillValue` 的 card/cvv/exp 映射 —— **断点**
4. 金额/套餐确认步骤与受控注入通道 —— **无**
5. 支付结果验证与幂等/防重放 —— **无**

---

### Q15. Credential 当前真实链路是什么？

**结论**：**基本正确**。明文经 vault 加密落盘，AI 全程只见 `cred_xxx` 引用与脱敏视图。
**未发现凭据明文进入 LLM prompt 的路径**。（⚠️ 但脱敏正则失效问题见前份审计报告 `SEC-N4`）

```
录入：  POST /api/vault/:id (server/index.js:395) → vault.setProfileSecrets（AES-256-GCM）
注册：  POST /api/ai/secrets (agent/index.js:571) → secretManager.createSecret → cred_xxx
执行：  tools.js:461 resolveFillValue → secretManager.resolve(:677) → vault.getProfileSecrets(:75)
       → browserManager.humanType(:469)
留痕：  secretManager.recordUsage(:474-477，只存引用不存值)
```

**红线通过项**：
```js
// observation.js:70-74 —— 敏感字段明文不出浏览器
if (_sensType || _sensName) { s.value = ''; s.sensitive = true; s.valueLength = raw.length; }
```
```js
// context.js:11-21 redactString 覆盖 password/authorization/apiKey/cookie/otp/token/卡号/CVV
// contextBuilder.js:47-121 全量经 red()
// secretManager.maskedView(:43-61) 只出 maskedEmail / maskedCard（**** + 后4位）
```

**⚠️ 缺口**
1. `POST /api/vault/:id`（index.js:395）与 `POST /api/ai/secrets`（agent/index.js:571）**均无可鉴权/限流**。
2. **无 `FPB_MASTER_KEY` 时静默降级为内存密钥**（vault.js:18-19），仅 `console.warn` —— 生产误部署会导致凭据"写入即永久丢失"。
3. **Planner 看不到凭据引用**（Q2 断裂 2-B）→ 幻觉编造 credentialRef → `CREDENTIAL_UNAVAILABLE` → 直送人工。
4. 无 OTP/2FA 凭据类型落地。

---

### Q16. 哪些地方仍存在 SaaS / Webflow / siteType 特化？

全仓扫描 `server/` 下 157 个 .js，排除 `node_modules/`、`scripts/`、`scenarios/`、`test-site/`、`data/`。

## 🔴 污染点总表

| # | 位置 | 代码片段 | 主链？ | 违反 |
|---|---|---|---|---|
| 1 | `contextGuard.js:56` | `if (/saas\|控制台\|cloud/.test(url) \|\| /saas/.test(sem)) return 'saas';` | **是**（tools.js:204） | 红线1 |
| 2 | `contextGuard.js:59` | `if (/shop\|mall\|商城\|商品\|订单\|库存/.test(url) ...) return 'shop';` | **是** | 红线1 |
| 3 | `contextGuard.js:64-67` | `const SITE_CONFLICT = { saas: [...], upload: [...] };`（只 2 个 key，不对称） | **是** | 红线1 |
| 4 | `contextGuard.js:100-105` | `if (expectedSite === 'saas' && /\/download\.html\|\/download\//.test(url))` | **是** | 红线1 |
| 5 | `contextGuard.js:119-121` | `SAAS_URL_RE / SAAS_TITLE_RE / SAAS_TEXT_RE`，含 `cloudsaas\|控制台\|工作台\|数据看板\|企业邮箱` | **是** | 红线1+2 |
| 6 | `contextGuard.js:209` | `if (site === 'saas' && state === 'GENERIC')` | **是** | 红线1 |
| 7 | **`pageStateClassifier.js:76`** | `/戴尔\|lg\|飞利浦\|华硕\|明基\|加入购物车\|¥\s?\d\|价格\|\d+\.\d+\s*元\|商品详情\|sku/` | **是**（tools.js:203） | 红线2 —— **已复核，品牌词逐字抄自 `mock-site/scraping/list.html`** |
| 8 | `pageStateClassifier.js:96` | `LOGIN_WALL: 'SaaS 登录/控制台页（邮箱或密码错误）'` | **是** | 红线1 |
| 9 | `pageStateClassifier.js:102` | `GENERIC: '电商商品列表页'`（兜底硬编码） | **是** | 红线2 |
| 10 | `pageStateClassifier.js:106` | `return BUCKET_MAP[state] \|\| '电商商品列表页';` | **是** | 红线2 |
| 11 | `tools.js:125-127` | 注释引 `ecommerce/search.html`、`button#searchBtn`、`input#q` 作设计依据 | 注释（代码本身通用） | 红线4 |
| 12 | `contextBuilder.js:52-54` | 注释引 `scraping/list.html`、`saas/login.html` | 注释 | 红线4 |
| 13 | `runtime.js:108-109` | 同上注释 | 注释 | 红线4 |
| 14 | `sites/index.js:31-33` | `const adapters = { generic };` —— **0 个真实适配器** | 是（contextBuilder:28） | 不违反（空壳，反而是缺能力） |

**已排除的非污染项**：`semanticResolver.js` 无站点词；`observation.js` / `verification.js` / `intelligence/` 全目录无 saas/ecommerce/控制台；`intelligence/*Memory.js` 的 `site` 是 hostname 动态键控。
生产代码中的域名仅 `openai.com`、`gstatic.com`、`ip-api.com`（基础设施，非站点特化）。

> **红线编号**：1 = 禁止站点类型进入核心执行逻辑；2 = 禁止 mock fixture 语料进入生产代码；
> 3 = 禁止为具体网站写业务流程；4 = 禁止 benchmark 语料成为产品设计依据。

> **污染点 1/5/6/7/9 位于每一个 action 的必经前置守卫（`tools.js:200-222`）。**
> 已实测其伤害：553 次拦截（见 Q5）。
>
> **污染点 7 的额外危害**：`/¥\s?\d/` 意味着**任何带价格的页面**都会被判为 `PRODUCT_LISTING`；
> 而品牌词是戴尔/飞利浦/华硕/明基 —— 一个不卖这些品牌的真实电商站**不会被识别为商品列表页**。
> 这两个方向同时失准，且失准方向相反。

---

### Q17. 哪些地方仍然由 benchmark 驱动？

**结论**：**生产执行链没有被 `server/scenarios/` 或 `benchmark/` 耦合**；`successMetrics.js` / `agentScore.js` 口径严格，未发现为刷分放宽标准。残留主要是**注释级**历史包袱 + 运行时数据被 fixture 污染。

```
server/scripts/productBenchmark.js:67    require('../scenarios')
server/scripts/realBenchmark.js:77       require('../scenarios')
server/scripts/run_4task_gate.js:29      require('./server/scenarios')
```
生产代码（`server/*.js`、`server/agent/*.js`）对 `scenarios` 与 `benchmark` 的 require 数 = **0**。

```js
// successMetrics.js:14 —— 业务成功口径严格
function isBusinessSuccess(task) { return !!(task && task.status === 'SUCCESS'); }
// agentScore.js:60 —— 人工介入即 0 分，未放宽
return m.escalated ? 0 : 100;
```
二者调用方全在 `server/scripts/`（analyze_live100 / benchmark_framework / phase10Benchmark），**不在生产链**。

生产代码内为 benchmark 而生的逻辑，均已核实可辩护（注释明写不改阈值）：
- `runtime.js:65-80` chromium 启动 3 次有界重试 —— 真实可靠性修复
- `tools.js:124-129` `isActionableControl` —— 「修排序，不动验证阈值」
- `contextBuilder.js:48-56` —— 「不改任何验证阈值、不改判定、不绕过 Guard」
- `planner.js:108-112` —— 「不弱化 password 等安全拦截」

**「修改 fixture 迎合 Agent」痕迹**：`git log` 显示 `mock-site/`、`server/scenarios/` 均只有 1 个 commit（`03a1048`），
**无逐次微调痕迹**。`mock-site/ecommerce/search_changed.html`（搜索框 id 由 `#q` 改为 `#query`）是正当的元素变更失败注入资产。

**⚠️ 残留风险**
1. `server/data/aiAttempts.json` 等运行时库被大量 `http://127.0.0.1:9478/saas/login.html` fixture 任务污染（4661 条中占绝大多数）—— **任何基于这些数据的度量都会失真**（本报告已标注此限制）。
2. 生产代码注释中嵌入 phase68/phase9/phase11 等 benchmark 期号与实测数据（至少 5 处）—— 技术债文档化，纠偏时应清理以降低误导。

---

### Q18. 哪些能力已经存在但没有接入主链？

## 孤儿 / 空壳 / 半接入清单

| 模块 | 状态 | 证据 |
|---|---|---|
| `agent/selfHealing/` | **空壳** | `ls -A` = 0 文件（已复核）；全仓 grep `selfHealing` = 0 |
| `agent/executionFailureTaxonomy.js`（149 行 9 类） | **ORPHAN** | 仅 `scripts/analyze_phase4.js:17`、`scripts/test_phase4_blockers.js:8` |
| `verification/contract.js::contractFromObjective` | **ORPHAN** | 定义 :180、导出 :287；唯一调用 `scripts/test_phase11_business_contract.js:68`。同文件的 `deriveContract`/`evaluateContract` 在链 |
| `agent/parser.js`（/tasks 侧） | **ORPHAN**（/chat 侧在链） | 唯一生产调用 `agent/index.js:389`（/chat） |
| `sites/index.js::selectorFor` | **ORPHAN** | :90 定义，**零调用方**（`semanticResolver.js:252` 是同名不同函数） |
| `sites/index.js` Site Adapter 注册表 | **在链但空壳** | `contextBuilder.js:12,28` 在链；但 `adapters = { generic }`（已复核）；`loadFromDir()` 每进程扫空目录 |
| `intelligence/router/intelligenceRouter.js` | **ORPHAN（只建议不执行）** | `agent/index.js:216`、`:398`（chat）；注释自标「只读、仅建议，不执行」 |
| `intelligence/router/contextBuilder.js` | **ORPHAN** | 仅 router 内部自引用；`runtime.js:37` 引的是 `./contextBuilder`（**不同文件**） |
| `intelligence/flowMemory.js`（读侧） | **有写无读** | 写 `taskManager.js:402`；执行链读侧仅 `/chat`；`planner.js` 零引用 |
| `intelligence/siteMemory.js::recordTaskResult` | **ORPHAN** | :32 定义，**零生产调用点** |
| `intelligence/flowPlanner.js` | **ORPHAN** | 无生产调用方 → `flowMatcher` 实际连带孤儿 |
| `intelligence/evaluation/*`（9 文件） | **ORPHAN** | 仅 `index.js:238` 报表路由 + 离线 |
| `recovery/replay.js` | **ORPHAN（只读路由）** | 仅 `index.js:138` |
| `execution/schedulerLoop.js` | **未挂载** | 被 `dispatchPolicy` 用，但 `server/index.js` 未挂载 → `execution/` 整体实际孤儿 |
| `automation/templates.js::checkoutTemplate` | **在链但不在 AI 链** | `index.js:22 runWorkflow`；**唯一能填真实卡号/CVV 的路径**，却绕开 AI Runtime |

**非孤儿（确认在链）**：`diagnosis/diagnosisEngine`（→repairManager:57）、`repair/*` 全部、`recovery/*`（retry 路径）、
`agent/memory.js`、`elementMemory`、`failureKnowledge`、`observationCache`、`selectorFallback`、`pageStateClassifier`、`contextGuard`。

---

# 第二部分：两张链路图

## 图一 — PRODUCT CORE 主链（当前真实实现）

```
USER ── POST /api/ai/tasks ────────────────────────────────────────────┐
         (零 body 校验；无 credentialRef / paymentMethodRef)              │
         ⚠ constraints 被丢弃 · ⚠ secretRefs 不进 prompt                │
                                                                        ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ API          server/agent/index.js:42  ────────────────────────────── │
  └──────────────────────────────────────────────────────────────────────┘
                                    ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ TASK         taskManager.createTask(:49) → start(:130) → _kick(:35)   │
  └──────────────────────────────────────────────────────────────────────┘
                                    ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ PLANNER      runtime.resolvePlan(:135)                               │
  │              → goto + observation.inspect(:126)   ✅ 证据驱动         │
  │              → contextBuilder(30 元素) → planner.planObjective(:90)   │
  │              → validatePlan → 一次性产出全 plan                       │
  │              ⚠ 首行短路 if(steps.length) return（预挂计划则不跑）      │
  └──────────────────────────────────────────────────────────────────────┘
                                    ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ RUNTIME      runtime.run(:353) → while(:400) → runStep(:172)          │
  └──────────────────────────────────────────────────────────────────────┘
                                    ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ ACTION       tools.execute(:161)                                     │
  │              → validateAction → policy.allowsAction(:172)            │
  │              → observation.inspect(:200)                             │
  │              → pageStateClassifier.classify(:203)  🔴 mock 品牌词     │
  │              → contextGuard.guard(:206)            🔴 site==='saas'   │
  │              → runTool(:330) → resolveSelector(:609) → page.*        │
  └──────────────────────────────────────────────────────────────────────┘
                                    ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ BROWSER      browserManager.getSession(:846) → session.page          │
  └──────────────────────────────────────────────────────────────────────┘
                                    ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ OBSERVATION  observation.inspect(:262)                               │
  │              ✅ url/title/text/elements/errors/domFingerprint/diff    │
  │              🔴 networkState 仅 pending|idle（无 request/response）   │
  │              🔴 无 console / pageerror                               │
  │              ⚠  无独立持久化                                          │
  └──────────────────────────────────────────────────────────────────────┘
                                    ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ VERIFICATION runtime.js:242 verification.verify                      │
  │              → contract.evaluateContract（优先 Planner 自报契约）      │
  │              🔴 contractFromObjective 孤儿 → objective 语义不参与      │
  │              ⚠  verification type==='none' 时整段跳过，直接 succeed    │
  └──────────────────────────────────────────────────────────────────────┘
                                    ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ RESULT       taskManager.complete(:619) / fail(:603) / escalate(:583) │
  │              业务成功唯一口径：task.status === 'SUCCESS'               │
  └──────────────────────────────────────────────────────────────────────┘
```

## 图二 — 失败链（当前真实实现 vs 应有实现）

```
失败发生
   │
   ├─ VERIFY_FAILED       1115 次 (51.3%)  ← runtime.js:338
   ├─ CONTEXT_WRONG_APP    609 次 (28.0%)  ← tools.js:221（🔴 553 次是 site==='saas'）
   ├─ ELEMENT_NOT_FOUND    270 次 (12.4%)
   ├─ NO_VALUE / CREDENTIAL_UNAVAILABLE  92 次 (4.2%)  ← 直送人工，不重试
   └─ 其他                 88 次
   │
   ▼
EVIDENCE 收集
   ✅ DOM / Screenshot(部分) / Page State / Action Outcome
   🔴 Network        —— 完全缺失（只有 pending 计数器）
   🔴 Console        —— 完全缺失（零监听）
   🔴 HTTP Status    —— 完全缺失（靠错误消息正则猜 500）
   🔴 Request/Response —— 完全缺失
   🔴 Timing / Redirect —— 完全缺失
   │
   ▼
【当前真实路径】                        【应有路径】
                                        
  retry 循环 (runtime.js:400)             Diagnosis（进诊断）
   ├─ errorClassifier（正则）               ├─ 输入：DOM/Network/Console/HTTP/Action
   ├─ recovery/strategies/*.getAction      ├─ 输出：failureType/confidence/evidence[]
   │   🔴 verify.js 返回 [] → 零信息       │        /likelyCause/repairability
   │   🔴 同一动作原样重跑 × 3             └─ recommendedRepair
   └─ backoff 300ms→5000ms                      │
   │                                            ▼
   ▼ (3 次耗尽)                           Repair Strategy（按诊断选）
Diagnosis（repairManager.js:57）            WAIT / REOBSERVE / RELOAD / RELOCATE /
   ⚠ 此时预算已烧完                          ALTERNATIVE_SELECTOR / BACK / REPLAN ...
   ⚠ failureAdvisor 命中则跳过 LLM                │
   ⚠ :67 硬编码覆盖诊断类别                        ▼
   │                                        Retry（带新信息）
   ▼
Repair（repairPlanner 查表 → executor）
   ⚠ 修复成功率实测 2.17%
   │
   ▼
HUMAN_ESCALATION（runtime.js:316）
   ⚠ 死锁：taskStateManager.js:14 列为终态，:18-32 TASK_TRANSITIONS 无该键
   ⚠ 升级率实测 80%
   ⚠ 升级产物缺 reason/evidence/failedStep/attemptCount/diagnosis/recommendedNextAction
```

---

# 第三部分：汇报（A–I）

## A. 已存在能力

| 能力 | 状态 | 证据 |
|---|---|---|
| Runtime 主链（单一执行器） | ✅ 完整 | `runtime.js:635 setExecutor(run)`，唯一且收敛 |
| Planner 证据驱动 | ✅ **正确** | `resolvePlan` 先 goto + inspect 再规划（:124-144），prompt 明令「禁止臆造」 |
| Target Contract 7 键 | ✅ 够用 | `schema/action.js:36` |
| 语义解析 + 回退链 | ✅ 在链 | 显式 selector → elementMemory → semanticResolver → pageReady |
| Action 风险分级 + 敏感字段红线 | ✅ **正确** | `TYPE_RISK_FLOOR`；`SENSITIVE_FIELDS` 禁止 value 字面量 |
| VIL 验证智能层 | ✅ 架构优秀 | DOM_CHANGED → RETRY_VERIFY（不判成功）；SUBMIT_UNKNOWN → ESCALATE |
| Observation 采集字段 | ✅ 充分 | 18 个字段 + 六维 diff + 血缘追踪 |
| Repair 策略库（7 种，查表选） | ✅ 在链 | `repairPlanner.js:9-35`，AI 不发明策略（设计正确） |
| Recovery 重试框架 | ✅ 在链 | 支持 `getAction`（信息增益）+ `getPreActions`（前置序列） |
| elementMemory 写入闸 | ✅ **污染已治理** | 业务验证通过才写（`runtime.js:344-346`） |
| failureKnowledge 读写闭环 | ✅ 在链 | 写 `repairManager:120`，读 `:38`（短路 LLM 诊断） |
| Credential Vault 加密 | ✅ 存在 | AES-256-GCM；明文不出浏览器（`observation.js:70-74`） |
| 凭据不进 LLM prompt | ✅ **红线通过** | `contextBuilder` 全量经 `red()`；`maskedView` 只出后 4 位 |
| Scheduler / Worker / 资源池 / 检查点 | ✅ 存在（未挂载） | `execution/` 19 文件 |

## B. 已接入主链能力

`Runtime.run` · `Planner（真实 LLM 路径）` · `contextBuilder` · `tools.execute` ·
`policy.allowsAction` · `pageStateClassifier` · `contextGuard` · `semanticResolver` ·
`observation.inspect` · `verification.verify` · `VIL（Intelligence + Window + contract.evaluate）` ·
`recoveryManager`（retry 路径）· `diagnosisEngine`（末段）· `repairManager/Planner/Executor` ·
`elementMemory`（读写）· `failureKnowledge`（读写）· `secretManager.resolve` · `vault` ·
`checkpoint` · `events/SSE` · `recorder`

## C. 存在但未接入主链能力

| 能力 | 状态 | 损失 |
|---|---|---|
| `selfHealing/` | **空壳** | 「自愈」只是 repair 的别名 |
| `executionFailureTaxonomy.js`（9 类） | **ORPHAN** | 20 类失败分类法在生产链完全不存在 |
| `contractFromObjective` | **ORPHAN** | objective 的「注册/支付」语义从不参与业务完成态推导 |
| `parser.js`（/tasks 侧） | **ORPHAN** | objective 是裸字符串，无 URL/约束抽取 |
| Site Adapter 注册表 | **空壳（0 适配器）** | 架构正确的设施空转，特例反而写进了 contextGuard |
| `intelligenceRouter` | **ORPHAN** | 只建议不执行 |
| `flowMemory`（读侧） | **有写无读** | 历史流程经验零回报投资 |
| `siteMemory::recordTaskResult` | **ORPHAN** | 成功侧站点经验从不沉淀 |
| `execution/`（scheduler/worker） | **未挂载** | 定时/批量能力不可达 |
| `automation/checkoutTemplate` | **在链但不在 AI 链** | **唯一能填真实卡号/CVV 的路径，AI 用不到** |

## D. 错误的 benchmark / site-specific 逻辑

| 级别 | 位置 | 问题 | 实测伤害 |
|---|---|---|---|
| 🔴 P0 | `contextGuard.js:56-60,64-67,100-105,119-121,209` | `siteType` 分支 + mock 语料关键词进入核心守卫 | **553 次拦截**（占全部失败 attempt 25.4%） |
| 🔴 P0 | `pageStateClassifier.js:76,96,102,106` | mock 品牌词（戴尔/飞利浦/华硕/明基）+ GENERAL 兜底硬编码为电商 | 每个 action 必经；双向失准 |
| 🟠 P1 | `recovery/strategies/verify.js` | VERIFY_FAILED 重试零信息原样重跑 | 占失败 51.3%，直接解释 80% 升级率 |
| 🟠 P1 | `.benchmark/` 四分类 | 是离线正则标注，运行时无 `POLICY_BLOCK`/`OTHER` 概念 | 12 个 OTHER 任务运行时无法归因 |
| 🟡 P2 | `tools.js:125-127`、`contextBuilder.js:52-54`、`runtime.js:108-109` | 注释引用 fixture 文件作设计依据 | 误导后续维护者 |
| 🟡 P2 | `server/data/aiAttempts.json` | 4661 条中绝大多数是 fixture 任务 | 任何基于该库的度量失真 |

## E. 最大 10 个产品阻塞

| # | 阻塞 | 性质 | 实测证据 |
|---|---|---|---|
| **1** | **安全基线未修**（匿名 RCE / 路径穿越 / CORS `*` / 0.0.0.0 / 脱敏失效 / 主密钥静默降级） | 能不能卖 | 见 `PRODUCT_CORE_ROADMAP.md` §6.1（`SEC-N1~N5`） |
| **2** | **`siteType` 分支位于核心守卫** | 红线违反 + 业务伤害 | **553 次 `期望站点=saas` 拦截** |
| **3** | **网络层完全缺失**（无 request/response/console/HTTP status） | 差异化能力为零 | Agent 对 `200 + {error}` 完全失明 |
| **4** | **VERIFY_FAILED 重试零信息** | 失败链失效 | 占失败 51.3%；`verify.js` 返回 `[]` |
| **5** | **升级即死锁** | 可用性断裂 | `taskStateManager.js:14 vs :18-32`；升级率 80% |
| **6** | **`constraints` 被 `createTask` 丢弃** | 输入链断裂 | `taskManager.js` grep = 0 → Planner 恒收 `[]` |
| **7** | **`secretRefs` 不进真实 LLM prompt** | 输入链断裂 | `buildStructuredOpts` grep credential = **0** → 幻觉 credentialRef → 直送人工 |
| **8** | **支付链路 BROKEN + `AUTOPAY` 越权** | 商业化阻塞 + 安全 | `resolveFillValue` 无卡字段；`PAYMENT_TYPES` 含 `delete` |
| **9** | **Diagnosis 在 3 次盲目重试之后才跑** | 时序错误 | `repairManager.js:57` 位于重试耗尽后 |
| **10** | **无统一失败模型 + Memory 无 decay/invalidate/scope** | 度量与学习失真 | `code` 是裸字符串；`memoryRecord` 只有硬编码阈值降级 |

## F. 每个阻塞的最小修复方案

> 全部遵循 §22「audit / instrument / connect / extend」，**不重写 Runtime / Planner / Resolver / Browser**。

| # | 最小修复 | 预估改动 | 是否触碰核心 |
|---|---|---|---|
| **1** | `evidence.js:35` 加 file 白名单校验；`/browser/:id/evaluate` 加鉴权+默认关；API 鉴权中间件+CORS 白名单+绑定 127.0.0.1；脱敏正则 `\\s`→`\s`；`vault.js` 主密钥缺失 fail-fast | ~50 行 | 否 |
| **2** | 删 `deriveExpectedSite` / `SITE_CONFLICT` / `saasEvidence`；`pageStateClassifier` 状态改为页面形态（`authenticated_area`/`auth_wall`/`form_page`/`empty_result`/`error_page`/`loading`/`generic`），删 `BUCKET_MAP` 与品牌词；guard 只保留「动作语义 vs 页面形态」通用矛盾判定 | ~200 行删 + ~80 行改 | **是**（但是删除，不是新增） |
| **3** | 新增 `networkCollector`：`page.on('request'/'response'/'requestfinished'/'requestfailed')` + `page.on('console')` + `page.on('pageerror')` → 写入新 store `aiNetworkEvents`（脱敏后）；observation 增 `networkSummary` 字段 | 新文件 ~150 行 + 接线 ~30 行 | 否（旁路挂载） |
| **4** | `recovery/strategies/verify.js` 补 `getAction`：「重观察 → 比对 `previousObservationDiff` → 按 diff 选策略」；或先补 `getPreActions` 返回 `['wait','reobserve']` | ~40 行 | 否（策略层） |
| **5** | `taskStateManager.js:18-32` 补 `HUMAN_ESCALATION` 出边；`/tasks/:id/resume` 允许跨终态续跑；升级产物补 6 字段 | ~25 行 | 否 |
| **6** | `createTask` 增加 `constraints: Array.isArray(input.constraints) ? input.constraints : []` | **1 行** | 否 |
| **7** | `buildStructuredOpts` 的 prompt 增加「可用凭据引用：cred_xxx（type=login）…」；schema 提示敏感字段必须用真实 ref | ~10 行 | 否 |
| **8** | `resolveFillValue` 补 `card`/`cvv`/`exp`/`cardNumber`/`expMonth`/`expYear` 映射；`PAYMENT_TYPES` 收窄为 `['payment','purchase']`；`purchase` 风险级 HIGH→CRITICAL | ~15 行 | 否 |
| **9** | 把 `diagnosisEngine` 从「重试耗尽后」前移到「首次失败后」；重试前先看诊断结论 | ~40 行（调度层） | **是**（调度时序） |
| **10** | 定义 `FailureRecord` 枚举（code→category/rootCause/recoverability）；`memoryRecord` 补 `lastVerified`/`scope`/`invalidate()`/可配置 decay | ~80 行 | 否 |

## G. 推荐 STEP 1

> **STEP 1 — Generic Target / Context 去站点化**

**理由**（三条，按权重）：

1. **它同时是红线违反与实测最大业务伤害源**。
   红线 §26 点名禁止 `if siteType === "saas"` 重新进入核心 Runtime；
   而实测 553 次拦截证明这不是"潜在风险"，是**正在发生的四分之一失败率**。

2. **它是唯一一个「删除型」改造**。
   其余 9 个阻塞都是"新增能力"，需要设计、需要验证；
   去站点化是**把错误的东西拿掉**，风险最低、收益最直接，且符合 §22「不要大重构」的精神。

3. **它是后续 STEP 的前置**。
   `pageStateClassifier` 的状态语义会进入 Observation 2.0（STEP 2）与 Diagnosis（STEP 5）的证据集。
   如果先做 STEP 2/5，会把污染状态名固化进新代码，返工成本翻倍。

**STEP 1 具体范围**（严格限定，不扩散）：
- 删 `contextGuard.js` 的站点类型三件套（`deriveExpectedSite` / `SITE_CONFLICT` / `saasEvidence`）
- `pageStateClassifier` 状态改为页面形态语义，删 `BUCKET_MAP` 与 mock 品牌词
- 补齐「动作语义 vs 页面形态」的通用矛盾判定（替代原站点矛盾矩阵）
- 顺带修最小阻塞 #6（`constraints` 1 行）与 #7（prompt 加凭据引用 ~10 行）—— 因为都在输入链上，同批验证成本最低

**不在 STEP 1 范围**：安全基线（#1）单独作为 STEP 0.5 先行，因其不可延后且与其他改动零耦合。

## H. 预计修改文件

### STEP 0.5 安全基线（先行）
| 文件 | 改动 |
|---|---|
| `server/agent/evidence.js` | `:35` file 白名单校验 |
| `server/index.js` | `:297-310` evaluate 加鉴权+默认关；`:50` CORS 白名单；`:509` 绑定 127.0.0.1；API 鉴权中间件 |
| `server/agent/observation.js` | `:49-52` 脱敏正则双重转义 |
| `server/vault.js` | `:18-19` 主密钥缺失 fail-fast |

### STEP 1 去站点化
| 文件 | 改动 | 性质 |
|---|---|---|
| `server/agent/contextGuard.js` | 删 `deriveExpectedSite`(:54-60)、`SITE_CONFLICT`(:63-66)、`destinationConflict` 的 saas 分支(:100-105)、`saasEvidence`(:118-187)；`:206-227` 改为通用矛盾判定 | 删除为主 |
| `server/agent/pageStateClassifier.js` | 状态集改为页面形态；删 `BUCKET_MAP`(:95-103) 与 `:76` 品牌词；`toBucket` 一并删除 | 重写状态定义 |
| `server/agent/tools.js` | `:203-206` 调用点适配（传页面形态而非 expectedSite） | 接线 |
| `server/agent/taskManager.js` | `:49-77` 增 `constraints` 字段 | +1 行 |
| `server/agent/planner.js` | `:124-137` prompt 增加可用凭据引用 | +10 行 |
| `server/agent/contextBuilder.js` | `:52-54` 清理 fixture 注释 | 注释 |
| `server/agent/runtime.js` | `:108-109` 清理 fixture 注释 | 注释 |
| `server/agent/tools.js` | `:125-127` 清理 fixture 注释 | 注释 |

**合计**：8 个文件，其中 3 个仅改注释；核心逻辑改动集中在 2 个文件（contextGuard / pageStateClassifier）。
**不触碰**：`runtime.js` 主循环、`planner.js` 规划逻辑、`semanticResolver.js`、`browserManager.js`、`verification.js` 判定逻辑。

## I. 预计测试

### 现有需更新的测试
| 测试 | 原因 |
|---|---|
| `server/scripts/test_phase9_e5_context_guard.js` | 断言 `SITE_CONFLICT` / `saasEvidence` 行为 → 需改为通用矛盾判定断言 |
| `server/scripts/test_phase6.js` | 断言 `pageStateClassifier` 状态与 `toBucket` → 状态名全变，且当前有 2 条取证 SKIP |
| `server/scripts/test_phase9_p1_candidate_discovery.js` | 可能引用 `deriveExpectedSite` |
| `server/scripts/test_phase9_p2_action_ranking.js` | 同上 |

### 需新增的测试
| 测试 | 断言 |
|---|---|
| `test_generic_context_guard.js` | **未知网站**（3 个从未见过的真实站点 URL）上执行 click/fill/submit，`CONTEXT_WRONG_APP` 触发次数 = 0 |
| `test_page_form_classifier.js` | 页面形态分类：登录页→`auth_wall`、结算页→`form_page`、空结果→`empty_result`、500 页→`error_page`；**断言 mock 品牌词零命中** |
| `test_constraints_passthrough.js` | `POST /tasks` 传 `constraints` → 断言 `task.constraints` 非空 → 断言 planner prompt 含「约束：」 |
| `test_credential_ref_prompt.js` | 断言 `buildStructuredOpts` prompt 含 `cred_` 引用列表；断言敏感字段动作生成的是真实 ref 而非幻觉 id |
| **回归护栏** `test_no_site_specific.js` | **`grep -rn "siteType\|=== 'saas'\|cloudsaas\|戴尔\|飞利浦" server/agent/ && exit 1`** —— 把红线变成 CI 门禁 |

### 回归基线
当前 `npm test`：**34 文件 → 33 通过 / 0 失败 / 1 已知缺口 / 6 取证跳过，144.5s**。
STEP 1 完成后基线必须保持：**0 失败**，且不新增 KNOWN_GAPS 条目。

---

## 附：审计限制声明

1. **运行时数据被 fixture 污染**：`server/data/aiAttempts.json` 的 4661 条中绝大多数来自
   `http://127.0.0.1:9478/*` mock 站点任务。因此本报告引用的「失败码分布」反映的是
   **Benchmark 场景下的失败结构**，不等于真实网站上的失败结构。
   但其**相对量级**（VERIFY_FAILED 51.3%、CONTEXT_WRONG_APP 28.0%）仍具强指示性，
   且 `CONTEXT_WRONG_APP` 的 553 次「期望站点=saas」是**机制性**而非数据性问题——
   只要站点类型分支还在，任何含 `cloud`/`saas`/`admin`/`console` 的 URL 都会触发。

2. **静态审计为主**：本次未启动浏览器或 100-task benchmark（符合 §29 要求）。
   所有"实测"结论均来自已落盘的历史运行数据，非本次新跑。

3. **未复核前份审计的安全结论**：`SEC-N1~N5` 已在 `PRODUCT_CORE_ROADMAP.md` 中取证，
   本报告直接引用，未重复验证。

---

**STEP 0 审计完成。未修改任何源码。等待下一步授权。**
