# MASTER IMPLEMENTATION PLAN

> AI Browser Operator — Product Completion / Integrated Development Mode
> 生成日期：2026-08-24
> 模式：AUDIT → IMPLEMENT → INTEGRATE → VERIFY → HARDEN（连续推进，非实验取证）
> 基线：E4 Collector 冻结、E4-1 FINDING 封存、D'/100×3 暂不启动。历史实验结果 immutable。

---

## 进度追踪（实时更新）

### 已完成修复（2026-08-24）
- [P0-1] `deepseekPlan` 返回统一 contract `{ok, plan:{steps}}`/`{ok:false}`；`provider.js` plan wrap 归一化并明确抛 `PLAN_FAIL`；planner 正确消费步骤数组。✅
- [P0-2] OpenAI（无 raw.plan）经 planner 降级 structured 验证 PASS（capability=structured）。✅
- [P0-3] **修复 planner.js BLOCKER**：原第77行 `if (rawSteps===undefined && ...)` 在 plan 成功（rawSteps 非 undefined）时整个 if 为 false，误入 else 分支报 `PLANNER_PROVIDER_CAPABILITY_ERROR`。重构为「rawSteps 已赋值则跳过降级直接校验」，真实 LLM plan 路径闭环（capability=plan）。✅
- [P0-4] `tools.js` 补齐 `forward/delete/update_account_settings/purchase/payment/password_change` 实现；`schema/action.js` 加入 `check`（原 tools 已实现 schema 漏列），并允许 `back/forward` 无 target。所有 schema action 类型均有合法 tools 实现。✅
- [P0-5] `verification.js` 显式处理 `action_success`（有 observation 放行、无则失败），修复 silent-pass；未知验证类型不再默认放行（default 改为失败）。✅
- [P0-6] `tools.js` withBrowserOp 增加取消检测（taskId 传入），每个操作边界检查 `CANCELLED` 立即中断；`runtime.js` 主循环检测 `CANCELLED` 错误直接退出（不重试/不 escalate）。✅
- [B.4] `runtime.js` complete 前校验所有 step ∈ {SUCCESS,SKIPPED}，存在未完成任务降级为 FAILED。✅

### 已完成修复（2026-08-25，P1 系列）
- [P1-2] error classifier 与 repair 类别字典闭合（C.4）：errorClassifier 对纯 5xx 显式产出 `SERVER_ERROR`（不再混为 NAVIGATION_FAILED）；repairPlanner 补 `VERIFICATION_FAILED→RELOAD_OR_BACK`、`APPROVAL_REQUIRED→REAUTH_OR_PAUSE(HIGH)` 映射；新增 `CLOSED_ERROR_CATEGORIES` 单一真源，未登记类别降级 GENERIC_RETRY 而非静默放弃。验证 6/6 PASS。✅
- [P1-1] Semantic Resolver 覆盖率扩展（C.3）：observation 元素抽取增加 `cls` 字段；`scoreOne` 新增 role(0.7)/type(0.75)/cls(0.6) 评分源；纯图标/无文本按钮（role=button + 动作语义）兜底低分候选（由 verification 把关）。验证 5/5 PASS（含回归）。✅
- [P1-4] lock TTL 自动释放（B.12）：active 锁加 DEFAULT_TTL_MS(30min) 自动失效；`acquire`/`isHeld` 检查过期自动清理；新增 `isExpired`/`pruneExpired`；paused 锁（人工介入有意持有）不自动过期。验证 8/8 + 3/3 PASS。✅
- [P1-3] Checkpoint restore（B.13）：新增 `checkpoint.restore(taskId)` 结构化恢复包（url/stepId/lastSuccessfulAction/lastVerifiedState）；`taskManager.recover` 改用 restore 作为恢复状态来源；runtime 主循环跳过 SUCCESS 步骤保证不重复已成功动作。验证 8/8 PASS。✅
- [P1-5] proxy 凭据加密落库（B.11）：db 层透明加解密——`saveProxies` 落盘仅 `passwordEnc`（AES-256-GCM，复用 vault），`getProxies` 读取解密供消费点，新增 `getProxiesPublic` mask 密码供 GET 列表；GET /proxies 路由改用 public。验证 10/10 PASS（含旧明文兼容）。✅

### 待续（下一自动开发步骤）
- [Phase 2] 真实 AI Planner 端到端（provider.plan + DeepSeek 真实调用 + Schema 校验，最小真实链路集成验证）
- [Phase 3] 产品完善：Cookie 管理 UI / Execution Timeline / Retry UI / Checkpoint 恢复 UI
- [Phase 4] 系统完整后重新评估：5.9-D / E4 Semantic / D' / 100×3
- P0-7/P0-8 文档决策项：Observation→Planner objective-only（C.2，已判定，仅记录）

### Phase 1 架构收口完成（2026-08-25）
产品化收尾模式启动。按"唯一执行链"原则完成架构三块收口（A/B/C），并通过 17/17 功能验证 + 9/9 核心模块加载 smoke。
- **[Phase1-A] 执行链收口**：
  - 明确 CANONICAL EXECUTION ENTRY：`TaskManager.start(taskId)` → `queue.enqueue`（aiQueue 记账）+ `_kick` → `runtime.run` → Browser。`runtime.run` 是唯一执行器；`execution/` 编排层（`scheduler/worker/pool/browserResource`）是【可选编排/可观测层】，仅在手动 `POST /execution/scheduler/start` 后介入，Worker.runDispatch 内部委托 `taskManager.start`（验证：两条路径殊途同归，无双执行）。
  - **修正真正的"无效入口"**：`POST /execution/submit` 过去仅建 QUEUED 派遣记录，Scheduler 未手动启动则任务永不执行（卡死 QUEUED）。现改为：Scheduler 运行中入队由调度派遣；否则经唯一执行链 `taskManager.start` 直接启动（绝不卡死）。
  - **保留 execution 编排层（非空壳）**：探查确认 execution/ 13 模块（1318 行）为真实调度/编排/可观测系统（非先前审计误判的"空壳"）。删除会破坏 Phase 3 所需的 observability/timeline/浏览器资源池，违背"优先补齐产品缺口"，故保留并明确其可选角色。
  - 文件：`taskManager.js`（顶部唯一执行链文档）、`execution/index.js`（角色定位）、`index.js`（submit 无效入口修复）。
- **[Phase1-B] ContextBuilder 完整化**：补上 Observation→ContextBuilder→Planner→Runtime 断点。顶层 `contextBuilder.build` 原先无任何调用方（planner 内联构建 prompt）。现补全 Context 必含 6 字段（objective / observation summary / previous steps / checkpoint / error history 数组 / verification state），并由 `runtime.resolvePlan` 构建、注入 `planner.planObjective` 的 LLM prompt（真实 DeepSeek/OpenAI 走 structured 路径时注入 Task Context 块）。文件：`contextBuilder.js`、`planner.js`、`runtime.js`。
- **[Phase1-C] Store 层统一**：`StoreInterface` 契约为单一事实来源，`JsonStore`/`SqliteStore` 均实现。修复 B.9 真实缺口——`insert`/`upsert` 语义不一致：JsonStore 允许缺 `id` 直接 push，SqliteStore 在 `obj.id==null` 时抛错（双后端行为分裂）。现 SqliteStore 在缺 id 时自动补 id（与 JsonStore 对齐），杜绝 `STORE_DRIVER=sqlite` 下静默崩溃。文件：`storage/sqliteStore.js`。

---

## A. 已完成（基线，尽量不重复开发）

| 模块 | 文件 | 状态 |
|---|---|---|
| Fingerprint generate/inject/UA/screen/tz/lang/fonts/WebGL/Canvas/Audio/WebRTC/CDP | `server/fp/*` | ✅ 已实现并接入 browserManager |
| Browser Manager（persistent profile / lifecycle / proxy bind / fp bind / session persistence / resource gating） | `server/browserManager.js`, `server/agent/execution/browser/*` | ✅ |
| Proxy（checker / geoip / precheck） | `server/proxyChecker.js`, `geoip.js`, `proxyPrecheck.js` | ✅ |
| Credential Vault（AES-256-GCM / masked / injection） | `server/vault.js`, `server/agent/secretManager.js` | ✅ 生产安全 |
| RPA tools（goto/fill/click/wait/extract/select/screenshot/eval/scroll/press/reload/back/check/inspect） | `server/agent/tools.js` | ✅ 大部分实现 |
| Frontend（ProfileEditor / ProxyPanel / TaskPanel / AiPanel / BrowserViewer） | `client/src/components/*` | ✅ 结构存在 |
| AI Operator architecture（TaskManager/Scheduler/Worker/Runtime/Planner/Observation/Verification/Retry/Recovery/SelfHealing/Intelligence/Lock/Credential/Checkpoint/records） | `server/agent/*` | ✅ 骨架完整 |
| E3.1 browser operation timeout | `tools.js` withBrowserOp + `runtime.js` STEP_TIMEOUT/REPAIR_TIMEOUT | ✅ |
| E4 Collector | `benchmark/*` | 🟦 已实现、冻结（不作为产品目标） |
| E4-1 observationPassed=false | — | 🟨 FINDING 封存 |
| E4 11×1 | — | ⚠️ 受 harness contamination，不作为语义结论 |
| 真实 LLM Planner（deepseek plan 接口） | `server/agent/llm/providers/deepseek.js` | ⚠️ 已实现闭环，但 contract 未规范化（见 C.1） |

---

## B. 已确认缺陷（确凿，来自静态审计 + 调用链验证）

### B.1 [P0] tools.js Action dispatch 未覆盖 schema 全部类型
- **文件**：`server/agent/tools.js:209-323`（`runTool` switch）
- **问题**：`schema/action.js` 允许的 `forward / delete / update_account_settings / purchase / payment / password_change` 在 switch 中无 case，全部落入 `default`（322行）→ 返回 `UNSUPPORTED_TOOL`。AI Planner 若产出这些类型，步骤必然失败且无重试价值。注意 `login/logout/submit` 已有 case（304-320）。
- **修复**：补齐 case（forward=goForward；delete/update_account_settings/purchase/payment/password_change 通过语义定位 + 拟人点击/键盘实现，或显式声明为"需结构化界面支持"并配合理验证）。对确实无法纯浏览器实现的类型，应在 planner 指令层约束，避免产出。
- **依赖**：schema/action.js、policy.js、verification.js
- **验收**：对上述每种 type 构造合法 Action，tools.execute 返回 success 或明确的 ACTION_REQUIRES_APPROVAL（而非 UNSUPPORTED_TOOL）。

### B.2 [P0] Verification 对 `action_success` 类型永远放行（silent-pass）
- **文件**：`server/agent/verification.js:8-11,72-73` + `server/agent/repair/strategies/*.js`（meta.verification={type:'action_success'}）
- **问题**：`VERIFICATION_TYPES` 不含 `action_success`。repair executor 验证门（`repair/executor.js:61-65`）对 `action_success` 调 `verify()` → 落 `default` 分支返回 `{success:true, confidence:0.5, evidence:['未知验证类型，跳过']}`。结果：修复动作工具返回成功即判定修复成功，从不核对页面状态。修复验证闭环形同虚设，构成系统性 silent-pass。
- **修复**：在 `verify()` 显式处理 `action_success`（语义=依赖工具自身 success 即可，但必须要求 `after.observation` 真实存在，缺失则视为失败）；或在 repair schema 中将 verification 类型收敛为真实类型（url_contains/element_present 等）。
- **依赖**：repairSchema.js、repairPlanner.js、repair/strategies/*.js
- **验收**：repair 修复后若页面状态未变，`action_success` 验证门返回 `success:false`，触发二次修复或 escalate；修复成功路径仍正常放行。

### B.3 [P0] 取消任务不真正中断浏览器操作
- **文件**：`server/agent/taskManager.js:316-330`（`cancel`）+ `server/agent/runtime.js:203-218`
- **问题**：`cancel()` 仅置 CANCELLED + 释放锁 + markDone + 广播事件。runtime 主循环每轮重读 `task.status !== 'RUNNING'` 才 break，但当前正在 `await tools.execute(...)` 的单步不会被中途 abort（无 AbortSignal 传入 browserManager）。前端 `AiPanel` 点取消拿到 200 即显示"已取消"，但后端动作仍跑完（最长 STEP_TIMEOUT 30s），浏览器 session 不关。
- **修复**：cancel 时向 runtime 注入取消标志/AbortSignal；`tools.execute` 与 `withBrowserOp` 检测该标志并在下一次操作边界中断；runtime 主循环在 await 返回后检测到 CANCELLED 立即收口为 CANCELLED（而非等待自然结束）。
- **依赖**：runtime.js、tools.js、taskManager.js、events.js
- **验收**：取消后正在执行的单步在合理时间内（≤ 操作超时）中断，任务落 CANCELLED，浏览器 session 释放。

### B.4 [P1] complete 不校验所有 step 均 SUCCESS
- **文件**：`server/agent/runtime.js:357-361` + `server/agent/taskManager.js:352-376`
- **问题**：主循环正常结束即 `complete`，统计 `status==='SUCCESS'` 数量，不拒绝。若某 step 因 B.2 的 silent-pass 停留在 HEALING 而 index 仍推进，任务会被标 SUCCESS，掩盖未真正完成的步骤。
- **修复**：`complete` 前校验所有 step 状态 ∈ {SUCCESS, SKIPPED}，存在非终态（HEALING/PENDING/FAILED）则降级为 FAILED 或携带 warnings。
- **依赖**：stepManager.js、runtime.js
- **验收**：有 step 未 SUCCESS 时任务不标 SUCCESS。

### B.5 [P1] recoveryManager 未真正处理 BROWSER_CRASH / recoverable=false
- **文件**：`server/agent/recovery/policy.js:14`（relaunch 映射）、`server/agent/recovery/recoveryManager.js:23-29,59-61`、`server/agent/runtime.js:263-265`
- **问题**：`BROWSER_CRASH` 映射到 `relaunch`，但 `STRATEGY_MODS` 无 `relaunch` 模块；runtime `rec.crash` 分支仅空注释不触发重建。且 `rec.recoverable===false`（如 CREDENTIAL_MISSING/APPROVAL_REQUIRED）被 runtime 忽略，仍 continue 重试至 maxRetries 才 escalate。
- **修复**：实现 `relaunch` 真实策略（重建浏览器上下文 + 导航回现场）；runtime 尊重 `rec.recoverable===false` 直接 escalate，避免无意义重试。
- **依赖**：recoveryManager.js、browserManager.js、runtime.js
- **验收**：BROWSER_CRASH 触发浏览器重建并恢复；不可恢复错误直接 escalate。

### B.6 [P1] repair executor 验证门 observation 来源脆弱
- **文件**：`server/agent/repair/executor.js:34,47,62`
- **问题**：`lastRes` 初始 `{observation:null}`；若最后一次动作走 catch，`res` 无 observation 字段；验证门用 `lastRes.observation` 可能拿到旧快照或 null。B.2 叠加后静默放行。
- **修复**：runAction 始终回传最新 observation；验证门在 observation==null 时视为验证失败。
- **依赖**：repair/executor.js、observation.js
- **验收**：修复动作后 observation 为 null 时验证门不放行。

### B.7 [P2] contextBuilder 与 context.js 字段不一致（死分支风险）
- **文件**：`server/agent/contextBuilder.js` vs `server/agent/context.js`
- **问题**：`build` 签名不兼容（{task,observation,...} vs {task,inspect,...}），字段命名 `observation.textSummary` vs `inspect.visibleText` 未对齐。runtime 实际未调用 contextBuilder（仅 diagnosisEngine 用 context.js）。contextBuilder 可能是孤立遗留模块。
- **修复**：统一单一 context 构造入口，字段对齐；或删除 contextBuilder 避免误导。
- **依赖**：无（隔离项）
- **验收**：无孤立/字段错位模块。

### B.8 [P2] execution/queueManager.js、workerManager.js、worker.js 未接线（空壳）
- **文件**：`server/agent/execution/queueManager.js`、`workerManager.js`、`worker.js`、`scheduler.js`(仅 priorityFor)
- **问题**：实际执行走 `taskManager.start → _kick(runtime.run)` 直跑模式，上述模块无人调用（queueManager.finish/schedule/assign/start 全死代码）。属于"4.3 编排层"未完成接线。当前直跑模式不饿死 worker，但模块误导性强。
- **修复**：要么实现真正的 worker pool 调度并接线，要么明确标记 deprecated/移除，避免误读为已实现的调度能力。
- **依赖**：taskManager.js、runtime.js
- **验收**：调度相关模块要么真实生效要么被清理，无虚假空壳。

### B.9 [P2] sqliteStore write 与 insert 语义不一致（潜在数据覆盖）
- **文件**：`server/agent/storage/sqliteStore.js:91,123`
- **问题**：`write` 先 DELETE 整集合再全量 INSERT（覆盖）；`insert` 普通 INSERT 重复 id 抛错。业务层若混用同集合会丢数据（当前未混用，仅风险）。
- **修复**：统一集合级写入语义或文档化约束。
- **依赖**：storage/*
- **验收**：同集合读写语义一致。

### B.10 [P3] 前端 Retry 按钮状态 mismatch
- **文件**：`client/src/components/AiPanel.jsx:190` vs `taskManager.retry`（仅允许 FAILED/CANCELLED）
- **问题**：PAUSED_FOR_HUMAN 显示 Retry 并调 retryTask → 必然抛"状态不允许重试"。应为 Approve/Reject。
- **修复**：PAUSED_FOR_HUMAN 显示 Approve/Reject，移除误置 Retry。
- **验收**：PAUSED_FOR_HUMAN 下按钮行为正确。

### B.11 [P3] proxy 明文落库
- **文件**：`server/index.js:213`（proxyRouter.post 直接存 password）
- **问题**：代理密码明文存入 JSON 文件，与 vault AES-256-GCM 形成对比。
- **修复**：代理凭据走 vault 加密或环境变量注入。
- **验收**：代理密码不明文落库。

### B.12 [P3] lock 无 TTL 自动释放
- **文件**：`server/agent/lock.js:19`
- **问题**：`acquire` 无 TTL，进程硬杀时锁残留 → 同 profile 永久 RESOURCE_BUSY。
- **修复**：加 `acquiredAt` + `isExpired(timeoutMs)` 自动失效。
- **验收**：残留锁超时可被清理。

### B.13 [P3] checkpoint 仅恢复 URL，无 restore
- **文件**：`server/agent/checkpoint.js`
- **问题**：只有 save/latest/list，无 restore()；recover 只导航回 url，不重建表单态，可能重复已成功动作。
- **修复**：提供 restore 接口，runtime recover 时回放状态。
- **验收**：recover 不重复已成功动作。

---

## C. 产品缺口（能力缺失，非测试问题）

### C.1 [P0] 真实 LLM Planner provider.plan() capability contract 未规范化
- **文件**：`server/agent/llm/providers/deepseek.js`、`server/agent/llm/provider.js:125-128`、`server/agent/planner.js:63-119`
- **当前状态**：
  - `deepseek.js` 已实现 `plan(task, ctx)` → `deepseekPlan()` 复用 chat + validatePlan，形成 `provider.plan → raw.plan → DeepSeek → validatePlan → {steps}` 闭环（真实 LLM Planner 代码层已闭环）。
  - **contract 隐患**：`deepseekPlan` 成功返回 `{ steps: [...] }`，失败返回 `{ steps: [], error }`；`provider.js:127` `return resp.steps || resp.plan || resp` 在失败时空数组 truthy → 返回 `[]`；`planner.js:65` 收到 `[]`（非 undefined）→ 跳过结构化降级 → validatePlan({steps:[]}) 失败 → ok:false（合理"规划失败"路径，非误杀）。但 contract 表达不清晰（成功/失败形状不统一，无 `{ok}` 字段）。
  - **OpenAI 不一致**：`openai.js` 无 `raw.plan`，必须走 planner 的 `structured` 降级（provider.js plan 抛 `raw.plan is not a function` → CAPABILITY_RE 捕获 → 降级 structured）。这是能力检测设计，可接受，但需文档化：deepseek 直连 plan，openai 降级 structured。
- **问题**：返回值 contract 不统一，依赖"空数组 truthy"的隐式语义，脆弱；planner 与 provider 对 plan 返回形状的约定未在 schema/contract 层明确。
- **修复**：
  1. 定义统一 `provider.plan()` contract：成功 `{ ok:true, plan:{steps} }` 或 `steps` 数组；失败 `{ ok:false, error }`（明确，不靠空数组）。
  2. `deepseekPlan` 返回统一形状；`provider.js` wrap 层归一化（无论 raw 返回 steps 数组还是 {ok,plan}，都收敛为 planner 期望的 `steps` 数组或明确抛 CAPABILITY）。
  3. `planner.js` 明确区分：plan 能力成功 / plan 能力缺失降级 structured / 两者皆无 → CAPABILITY_ERROR。当前逻辑基本正确，需对齐返回值 shape 避免误判。
  4. 在 provider contract 文档/注释中明确：deepseek 支持 plan，openai 经 structured 降级，mock 支持 plan。
- **依赖**：schema/plan.js、provider.js、planner.js、deepseek.js、openai.js
- **验收（IMPLEMENTATION RESULT 8 项）**：
  1. `deepseekFactory().plan is function === true`
  2. provider.js `plan()` 不再因 `raw.plan undefined` 抛未捕获错误（能力检测正确降级）
  3. 真实 DeepSeek 单任务 `provider.plan()` 返回合法 Plan（validatePlan ok）
  4. planner.js 能正确消费 deepseek plan 成功路径（不再误报 CAPABILITY_ERROR）
  5. runtime.resolvePlan 经 planner 获得 steps 并落库
  6. 未改冻结区（planner 仅对齐 contract，不改验证语义/E4/mockSite）
  7. OpenAI 经 structured 降级仍能生成 Plan
  8. 无大规模重跑，仅真实单任务 + 单元测试

### C.2 [P1] Observation 进入 Planner 的产品设计决策未落地
- **文件**：`server/agent/planner.js`（不引用 observation）、`server/agent/observation.js`、`server/agent/contextBuilder.js`
- **当前状态（审计结论）**：Observation 被 tools→verification（主链路）与 repair executor 验证门消费；Planner 不消费原始 observation。"先规划后执行"架构下 Planner objective-only 是合理设计。
- **问题**：E4-1 发现 observationPassed=false，但这是 FINDING 封存项。需独立判断产品正确设计：Planner 是否应获得 observation。
- **决策（产品层，非为 E4 通过）**：当前架构 Planner 为 objective-only + 执行期 observation 驱动 verification/repair，符合"先规划后执行"范式。**不强行让 Planner 消费 observation**。记录为设计决策。若未来需要 adaptive planning，由 planner mode 分阶段引入（不在本计划范围）。
- **依赖**：无（设计决策，非代码缺口）
- **验收**：设计文档记录；Planner 行为符合 objective-only 设计。

### C.3 [P1] Semantic Resolver / grounding 覆盖率有限
- **文件**：`server/agent/semanticResolver.js`
- **问题**：仅匹配 text/aria/label/placeholder/name，对纯图标按钮或 role 缺失元素覆盖有限。
- **修复**：扩展候选特征（role/type/aria-role/css 类/位置启发）。属能力增强，非阻塞。
- **依赖**：observation.js
- **验收**：常见无文本按钮可定位。

### C.4 [P1] error classifier 与 repair strategy 类别字典不闭合
- **文件**：`server/agent/recovery/errorClassifier.js` vs `server/agent/repair/repairPlanner.js:9-31`
- **问题**：classifier 产出 ELEMENT_NOT_FOUND/CREDENTIAL_MISSING 等；repair STRATEGY_FOR_CATEGORY 用 ELEMENT_CHANGED/SESSION_EXPIRED/SERVER_ERROR/OBSTRUCTION 等，二者并集未覆盖所有 key，依赖 diagnosisEngine(LLM) 补全。
- **修复**：统一错误类别字典，明确 classifier 与 diagnosis 的类别并集覆盖 STRATEGY_FOR_CATEGORY 所有 key。
- **依赖**：errorClassifier.js、repairPlanner.js
- **验收**：任一错误类别都能映射到策略或显式 UNKNOWN→GENERIC。

---

## D. 测试缺口

| 缺口 | 说明 | Priority |
|---|---|---|
| 单元测试 | tools 各 action 类型、verification 各类型、planner contract、provider wrap | P1 |
| 集成测试 | planner→runtime→stepManager→tools→verification 闭环 | P0 |
| 最小真实链路 | 真实 DeepSeek → plan → 浏览器执行 → verification（需 API key 或可控 mock LLM） | P0 |
| 取消链路测试 | cancel 中断进行中操作 | P0 |
| repair 验证门测试 | action_success 不应 silent-pass | P0 |
| 终态收口测试 | 所有 step 必须 SUCCESS 才能 complete | P1 |

---

## E. 架构债务

- E.1 execution/queueManager/workerManager/worker/scheduler 空壳（B.8）
- E.2 provider.mock 可在生产被默认激活（auto 回退），建议生产强制显式 AI_PROVIDER
- E.3 contextBuilder 孤立模块（B.7）
- E.4 recovery/replay.js 仅追溯无重放（命名误导，功能自洽）
- E.5 sqliteStore write/insert 语义不一致（B.9）
- E.6 jsonStore.js:95 `Atomics.wait ? null : null` 占位空表达式

---

## F. 暂不处理事项（明确冻结/延后）

- F.1 E4 Collector（冻结，不再修改）
- F.2 E4-1 observationPassed=false（FINDING 封存，不修 Observation/Planner 改变实验结果）
- F.3 E4 11×1 / D' / 100×3（不启动）
- F.4 plannerProbe / invocationRecord（冻结）
- F.5 Observation→Planner 强制接入（设计决策为 objective-only，见 C.2）
- F.6 大规模 benchmark 重跑（仅做最小真实链路 + 单任务）

---

## G. 最终验收标准（产品完成定义）

真实用户创建 Task
→ Planner（真实 LLM 或降级 structured）
→ Plan（Schema validation + 基础 action 合法）
→ Runtime
→ Browser（真实操作 + 超时/cancel 保护）
→ Observation
→ Executor
→ Verification（真实验证，非 silent-pass）
→ 失败时 Repair → Retry → Checkpoint → 继续 / Escalate
→ 最终 SUCCESS / FAILED / HUMAN_ESCALATION
**绝不**：PENDING forever / RUNNING forever / silent failure / undefined provider capability / fake plan / schema-valid 但语义不可能 plan。

### 分优先级验收
- **P0 完成判据**：
  - 所有 schema action type 有真实 tool 实现或明确审批路径（B.1）
  - verification 无 silent-pass（B.2）
  - cancel 真正中断进行中操作（B.3）
  - 真实 LLM plan contract 规范化并闭环（C.1）
  - 真实链路 vertical slice 跑通（search 类任务不生成 login variant）
- **P1 完成判据**：complete 校验所有 step（B.4）、BROWSER_CRASH relaunch（B.5）、repair observation 来源（B.6）、语义覆盖（C.3）、错误类别闭合（C.4）
- **P2 完成判据**：空壳模块清理（B.8）、contextBuilder 对齐（B.7）、存储语义一致（B.9）
- **P3 完成判据**：前端 Retry 状态（B.10）、proxy 加密（B.11）、lock TTL（B.12）、checkpoint restore（B.13）

---

## 执行顺序（依赖驱动，连续推进）

1. **P0-1** 真实 LLM Planner contract 规范化（C.1）—— 先对齐，避免后续基于错误 contract
2. **P0-2** provider capability contract 文档化 + openai 降级确认
3. **P0-3** Planner→Runtime→StepManager 闭环（runtime 已具备，验证 + 修复 B.4 收口）
4. **P0-4** tools dispatch 补齐（B.1）
5. **P0-5** verification silent-pass 修复（B.2）+ repair observation（B.6）
6. **P0-6** cancel 中断链路（B.3）
7. **P0-7** Observation→Planner 设计决策落地（C.2，仅文档）
8. **P0-8** Verification→Repair→Retry→Escalation 完整闭环（B.5 + 集成测试）
9. **P1** Semantic/Category/Checkpoint/Credential/ResourceLock  observability
10. **P2** 前端完整性 / 空壳清理
11. **P3** 性能/清理/文档/UX

> 每完成一个模块即：单元测试 + 集成测试 + 最小真实链路测试（FAIL→定位→修产品→回归→继续）。
> 仅当发现真正架构决策问题才暂停汇报。历史证据 immutable，不修测试预期/FINDING/scoring 制造 PASS。
