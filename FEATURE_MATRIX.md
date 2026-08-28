# FEATURE_MATRIX — AI Browser Agent 能力矩阵（Phase 12B 审计）

> 审计日期：2026-08-27
> 审计方式：6 路并行 Explore 代理，逐一读取真实代码（**禁止凭文件名判断**）。
> 判定口径：Existing（已实现且可用）/ Partial（部分实现或存在关键缺口）/ Missing（无实现）。
> 证据格式：`file:line` 指向真实实现位置。

---

## 总览矩阵

| Domain | Feature | Status | Evidence |
|---|---|---:|---|
| Browser | navigate | Existing | tools.js:227-235 |
| Browser | click | Existing | tools.js:268-277 |
| Browser | fill | Existing | tools.js:320-339 |
| Browser | select | Existing | tools.js:340-348（仅原生 `<select>`） |
| Browser | check | Existing | tools.js:349-357 |
| Browser | uncheck | **Missing** | 无 `case 'uncheck'`，未入 ACTION_TYPES |
| Browser | press | Existing | tools.js:249-254 |
| Browser | scroll | Existing | tools.js:244-248 |
| Browser | extract | Existing | tools.js:263-267 + observation.js:30-169 |
| Browser | screenshot | Existing | tools.js:255-258 |
| Browser | reload | Existing | tools.js:278-284 |
| Browser | back | Existing | tools.js:285-291 |
| Browser | forward | Existing | tools.js:292-298 |
| Browser | tab/page management | **Missing** | getPageFor 仅返回单 session.page（tools.js:123-129） |
| Browser | popup handling | **Missing** | 仅路由配置，无 popup 捕获（browserManager.js:724） |
| Browser | dialog handling | Partial | 仅盲 dismiss（browserManager.js:741-743），无 accept 路径 |
| Browser | iframe support | **Missing** | 观察器跳过 iframe（observation.js:81），无 frame API |
| Browser | file chooser | **Missing** | 全仓无 filechooser 钩子 |
| Browser | upload | **Missing** | 无 setInputFiles |
| Browser | download | **Missing** | 无 download 事件钩子 |
| Browser | multi-tab | **Missing** | 仅单页 |
| Browser | window/page lifecycle | Partial | 内部守卫存在，未暴露为 agent 能力 |
| Agent | planner | Partial | select/check/search 未纳入 MUST_VERIFY |
| Agent | schema | Partial | 仅 9 类强制 outcome 契约 |
| Agent | resolver | Partial | 无 nearby-text / DOM-relationship 信号 |
| Agent | observation | Existing | observation.js:171-225 |
| Agent | verification | Existing | verification.js + contract.js |
| Agent | VIL | Partial | HUMAN_ESCALATE 死枚举；RE_EXECUTE 间接 |
| Agent | runtime | Existing | runtime.js 主循环 |
| Agent | retry | Existing | runtime.js:339-343 |
| Agent | repair | Partial | 无 REPLAN / HUMAN_ESCALATE 策略枚举 |
| Agent | recovery | Partial | 仅执行级恢复，无业务态回滚语义 |
| Agent | checkpoint | Existing | checkpoint.js |
| Agent | failure classification | Existing | errorClassifier + diagnosisSchema |
| Agent | replanning | **Missing** | 仅 policy.maxReplans 配置，无实现 |
| Agent | context compression | Existing | contextBuilder.js（滑动窗口截断） |
| Agent | long workflow context | Existing | 同上（无语义摘要） |
| Agent | alternative verification | Partial | `allowedAlternativeStates` vs `allowedAlternatives` 键名不一致 bug |
| Agent | alternative target resolution | Existing | semanticResolver + recovery variants |
| Agent | structured failure evidence | Existing | failErr + diagnosisSchema |
| Agent | recovery policy | Partial | 路由静态，仅计数/阈值可配 |
| Security | risk policy | Existing | policy.js:12 / schema/action.js:16 |
| Security | credentialRef | Existing | schema/action.js:34,103-114 |
| Security | vault | Existing | vault.js AES-256-GCM |
| Security | human approval | Existing | policy→tools→runtime→API 闭环 |
| Security | LOW auto | Existing | policy.js:66-73 |
| Security | MEDIUM auto | Existing | 默认 riskFloor=MEDIUM |
| Security | HIGH per policy | Existing | 默认需审批 |
| Security | CRITICAL gate | Partial | autoPayment 可绕过，环境护栏未代码强制 |
| Security | audit trail | Existing | events + secretManager.recordUsage + recorder |
| Task | create | Existing | taskManager.js:49-82 |
| Task | queue | Partial | 主路径不经过 dequeue；任务无 QUEUED 态 |
| Task | start | Existing | taskManager.js:121-190 |
| Task | pause | Existing | pauseForHuman（状态机） |
| Task | resume | Existing | taskManager.js:212-221 |
| Task | cancel | Existing | taskManager.js:330-344 |
| Task | retry | Existing | taskManager.js:346-363 |
| Task | complete | Existing | taskManager.js:366-390 |
| Task | failed (terminal) | Existing | taskManager.js:398-417 |
| Task | escalated (terminal) | Existing | taskManager.js:421-434 |
| Task | priority | Existing | 存储+调度层生效，默认路径不排序 |
| Task | timeout | Partial | 仅步级/修复级，无任务级整体墙钟超时 |
| Task | retry policy | Partial | 无 backoff |
| Task | scheduling | Partial | scheduler 默认不启动 |
| Task | dependency | **Missing** | 全文无 dependsOn/waitFor |
| Task | cancellation (graceful) | Existing | 协作式取消 |
| Task | graceful shutdown | **Missing** | 无 SIGTERM/退出钩子 |
| Task | restart recovery | Existing | recoverInterruptedTasks |
| Infra | resource lock | Existing | lock.js |
| Infra | queue | Partial | 默认路径队列不控并发（仅记账） |
| Infra | profile isolation | Existing | browserManager.js profileDataDir |
| Infra | browser lifecycle | Existing | launch/close/zombieKiller |
| Infra | crash recovery | Existing | runtime.js:359-364 + recovery |
| Infra | cleanup | Existing | 惰性 TTL + zombieKiller |
| Infra | stale task recovery | Partial | 默认路径无周期 watch-dog |
| Observability | timeline | Existing | traceCollector.buildTimeline |
| Observability | step | Existing | stepManager.createStep |
| Observability | attempt | Existing | stepManager.createAttempt |
| Observability | repair | Existing | repairAttempts.create |
| Observability | verification | Existing | ai.verification.* 事件 |
| Observability | failure | Existing | failureSnapshot + aiAttempts.error |
| Observability | screenshot | Existing | evidence.saveSnapshot |
| Observability | trace | Existing | traceCollector.trace |
| Observability | metrics | Existing | aggregator.dashboard |
| Observability | matchedBy persist | **Missing** | resolver 计算但不落库 |
| Observability | escalationKind persist | **Missing** | 事后分析推导，未落库 |
| Observability | VIL decision in trace | Partial | 事件已落 aiEvents，traceCollector 未聚合 |
| API | GET /profiles | Existing | index.js:56-59 |
| API | POST /profiles | Existing | index.js:61-98 |
| API | DELETE /profiles/:id | Existing | index.js:178-189 |
| API | GET /tasks | Existing | 双实现（/api + /api/ai） |
| API | POST /tasks | Existing | 双实现 |
| API | GET /tasks/:id | Partial | 仅 /api/ai/tasks/:id |
| API | POST /tasks/:id/start | Partial | 仅 /api/ai/* |
| API | POST /tasks/:id/pause | **Missing** | 两模块均无 pause 路由 |
| API | POST /tasks/:id/resume | Partial | 仅 /api/ai/* |
| API | POST /tasks/:id/cancel | Partial | 仅 /api/ai/* |
| API | POST /tasks/:id/retry | Partial | 仅 /api/ai/* |
| API | GET /tasks/:id/timeline | Partial | 等效 /api/ai/observability/trace/:id |
| API | GET /tasks/:id/screenshots | Partial | 等效 /api/ai/tasks/:id/snapshots |
| API | GET /tasks/:id/trace | Partial | 等效 /api/ai/observability/trace/:id |
| API | GET /dashboard | Partial | 等效 /api/ai/observability/dashboard |
| Frontend | build (React/Vite) | Existing | client/package.json + vite |
| Frontend | Dashboard | Partial | 仅显示 4/8 指标 |
| Frontend | Profiles | Existing | ProfileEditor 完整 |
| Frontend | Tasks | Partial | 创建+同步执行；无 pause 按钮 |
| Frontend | Task Detail | Partial | 无专用页，散落于 AiPanel/ObservabilityPanel |
| Frontend | Execution Timeline | Partial | 缺 VIL / ESCALATION 节点 |

---

## 关键缺口（按严重度）

### 🔴 阻断级 / 正确性 Bug
1. **Alternative verification 键名不一致** — `verificationWindow.js` 读 `contract.allowedAlternativeStates`，真实字段为 `allowedAlternatives`（contract.js:185）。导致观察窗口内替代态验证永久失效。
2. **CRITICAL 可被 autoPayment 绕过** — `policy.js:60-62` + `taskManager.js:57` 允许任意 API 调用者设 `autoPayment=true` 自动执行 CRITICAL 支付/改密；注释声称"仅限测试环境"但代码无环境判定。
3. **VIL HUMAN_ESCALATE 死枚举** — `verificationIntelligence.js` 从不返回 HUMAN_ESCALATE；RE_EXECUTE 仅经 failureType 间接参与。VIL 未真正驱动升级/重执行决策。

### 🟠 功能缺失（P0 范围）
4. `uncheck` 动作缺失（check 仅能勾选不能取消）。
5. `tab/page management` / `multi-tab` / `popup` 完全缺失（仅单页）。
6. `iframe` 完全不可达（观察器跳过）。
7. `upload` / `file chooser` / `download` 完全缺失。
8. `replanning` 完全缺失（失败时仅 repair 重执行）。
9. API `POST /tasks/:id/pause` 端点缺失（前后端均无）。

### 🟡 部分实现 / 可观测性缺口
10. `matchedBy` 计算和返回但不持久化（observability 硬缺口）。
11. `escalationKind` 未落库（事后分析推导）。
12. Resolver 无 nearby-text / DOM-relationship 信号。
13. Task 无整体任务级超时（仅步级）。
14. Task retry 无 backoff。
15. Task dependency 完全缺失。
16. Graceful shutdown 缺失（无进程退出钩子）。
17. Scheduler/队列默认未激活（并发靠锁+worker 容量）。
18. 前端 Dashboard 仅 4/8 指标；缺 VIL/ESCALATION timeline 节点；缺专用 Task Detail 页。
19. VIL decision/recovery 事件未进 traceCollector 聚合。
20. dialog 仅盲 dismiss，无 accept 路径。

---

## 已扎实实现（无需担忧）
- 状态机：PENDING→…→SUCCESS/FAILED/CANCELLED/HUMAN_ESCALATION，非法转换由 `transitionTask` 强制抛错。
- 安全基线：Risk 4 级、CredentialRef、Vault 加密、运行时门禁 `tools.execute`+`allowsAction`、审计追踪脱敏。
- 浏览器核心单页交互集（navigate/click/fill/select/check/press/scroll/extract/screenshot/reload/back/forward）。
- Verification Outcome Contract（Phase 11）、Observation、Runtime 主循环、Checkpoint、Failure Classification、结构化证据。
- 基础设施：Resource Lock、Profile 隔离、Browser 生命周期/僵尸清理、Crash/Restart 恢复。
- 可观测性骨架（timeline/step/attempt/repair/failure/screenshot/trace/metrics）全部复用既有 store，无独立存储。
- Profiles 前端全套 CRUD/指纹/代理/Cookie/状态。

详见 `FEATURE_COMPLETE_SPEC.md`（P0/P1 定义）与 `FEATURE_COMPLETE_REPORT.md`（最终实现与判定）。
