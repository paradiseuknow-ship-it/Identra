# FEATURE_COMPLETE SPEC — 功能完整范围定义（Phase 12B）

> 本文件定义「Feature Complete」的判定范围。基于 `FEATURE_MATRIX.md` 的真实审计结果，明确哪些必须完整（P0）、哪些属于产品完整性（P1）、以及本阶段将补齐的内容。
>
> 原则（§二、§二十）：不停下等授权，一次做到 Feature Complete。禁止 silent fallback（`verification:none`）；关键 Action 必须带 outcome contract；不降低安全门。

---

## P0 — 必须完整（没有这些不能叫 Feature Complete）

### Browser（13 项）
| # | 能力 | 现状 | 本阶段动作 |
|---|---|---|---|
| B1 | navigate | Existing | 保留 |
| B2 | click | Existing | 保留 |
| B3 | fill | Existing | 保留 |
| B4 | select | Existing | 保留（仅原生 select，见 P1 自定义下拉） |
| B5 | check | Existing | 保留 |
| B6 | uncheck | **Missing** | **新增 `uncheck` 动作**（tools.js + action.js ACTION_TYPES） |
| B7 | press | Existing | 保留 |
| B8 | scroll | Existing | 保留 |
| B9 | extract | Existing | 保留 |
| B10 | screenshot | Existing | 保留 |
| B11 | reload | Existing | 保留 |
| B12 | back | Existing | 保留 |
| B13 | forward | Existing | 保留 |
| B14 | tab/page management | **Missing** | **新增基础多页管理**：openTab/closeTab/switchTab（基于 context.pages()，单 session 多 page 跟踪） |

> 注：原 P0 列「tab/page management」为必备。本阶段实现最小可用的多页跟踪（context 内的 page 数组 + switch），popup 自动纳入跟踪。

### Agent（12 项）
| # | 能力 | 现状 | 本阶段动作 |
|---|---|---|---|
| A1 | Planner | Partial | **select/check/search 纳入 MUST_VERIFY**，强制 outcome 契约 |
| A2 | Schema | Partial | 同步扩大强制范围；消除 `normalizeStrictToCanonical` 静默 `none` 默认（非 MUST_VERIFY 也需至少 `verification.type` 合法） |
| A3 | Resolver | Partial | **新增 nearby-text / DOM-relationship 信号**，输出仍含 matchedBy/confidence/evidence |
| A4 | Observation | Existing | 保留（iframe 见 P1） |
| A5 | Verification | Existing | 保留；**修复 allowedAlternativeStates→allowedAlternatives 键名 bug** |
| A6 | VIL | Partial | **HUMAN_ESCALATE 可达**（分析返回升级决策并驱动 runtime 升级）；RE_EXECUTE 直接驱动重执行 |
| A7 | Runtime | Existing | 保留；接入 VIL 升级/重执行决策 |
| A8 | Retry | Existing | 保留；**新增 backoff** |
| A9 | Repair | Partial | 策略枚举增加 REPLAN / HUMAN_ESCALATE 语义（路由到 planner / taskManager.escalate） |
| A10 | Recovery | Partial | 保留执行级；补充「业务态回滚/推进」语义（checkpoint 恢复即业务态恢复） |
| A11 | Checkpoint | Existing | 保留 |
| A12 | Failure Classification | Existing | 保留；统一命名（ACTION_REAL_FAILURE 作为 ACTION_NOT_EXECUTED 等价项保留并文档化） |

### Security（6 项）
| # | 能力 | 现状 | 本阶段动作 |
|---|---|---|---|
| S1 | Risk Policy | Existing | 保留 |
| S2 | CredentialRef | Existing | 保留 |
| S3 | Vault | Existing | 保留 |
| S4 | Human Approval | Existing | 保留 |
| S5 | HIGH/CRITICAL gate | Partial | **代码强制 autoPayment 仅测试环境**（`NODE_ENV==='test'` 或 `FPB_ALLOW_AUTOPAY=1`），否则 CRITICAL 必须人工审批；开启时记录审计事件 |
| S6 | Audit trail | Existing | 保留；补充 escalationKind 落库 |

### Task（10 项状态机）
| # | 能力 | 现状 | 本阶段动作 |
|---|---|---|---|
| T1-T10 | Create/Queue/Start/Pause/Resume/Cancel/Retry/Complete/Failed/Escalated | 均 Existing | 保留状态机；**补齐 API pause 端点** |
| T11 | 任务无 QUEUED 态 | Partial | 接受 dispatch 层表达（不在任务状态机加态），文档说明 |

### Observability（9 项）
| # | 能力 | 现状 | 本阶段动作 |
|---|---|---|---|
| O1-O9 | Timeline/Step/Attempt/Repair/Verification/Failure/Screenshot/Trace/Metrics | Existing | 保留 |
| O10 | matchedBy persist | **Missing** | **stepManager.createAttempt 落库 matchedBy** |
| O11 | escalationKind persist | **Missing** | **escalate() 落库 escalationKind** |
| O12 | VIL decision in trace | Partial | **traceCollector 聚合 VIL decision / recovery 事件** |

---

## P1 — 产品完整性（本阶段补齐）

### Browser 高级
- **B15 popup**：`page.on('popup')` / context 新 page 自动纳入跟踪并暴露给 agent。
- **B16 dialog**：agent 可控 accept/dismiss（按 action 意图），不再盲 dismiss。
- **B17 iframe**：观察器采集 iframe 内元素；click/fill 支持 frame 定位（frameLocator）。
- **B18 file chooser**：`page.waitForEvent('filechooser')` 拦截上传对话框。
- **B19 upload**：`setInputFiles` 设置文件输入。
- **B20 download**：`page.waitForEvent('download')` 捕获并保存。
- **B21 multi-tab coordination**：基于 B14 的多页跟踪。
- **B22 window/page lifecycle**：暴露 open/close 事件订阅（内部已有守卫）。

### Agent
- **A13 replanning**：失败时（重试+repair 耗尽）调用 planner 重新生成步骤序列（消耗 `maxReplans`），而非仅重执行。
- **A14 context compression**：现有滑动窗口截断保留；新增可选 LLM 摘要钩子（不强制）。
- **A15 long workflow context**：checkpoint 已支撑；补充 step 上下文窗口管理。
- **A16 alternative verification**：修复后生效（键名 bug 已修）。
- **A17 alternative target resolution**：已有；补充 DOM-relationship 信号（同 A3）。
- **A18 structured failure evidence**：已有；统一输出。
- **A19 recovery policy**：路由表可经 `task.policy.recovery` 覆盖（静态默认 + 可配）。

### Task System
- **T12 task priority**：默认路径不排序——接受（scheduler 路径已支持），文档说明。
- **T13 task timeout**：**新增任务级整体墙钟超时**（policy.taskTimeoutMs），超时自动 fail/escalate。
- **T14 task retry policy**：**新增 backoff**（指数退避）。
- **T15 task scheduling**：scheduler 默认不启动——提供配置开关 `enableScheduler`，文档说明。
- **T16 task dependency**：**新增 dependsOn**（任务在依赖未完成前保持 PENDING/BLOCKED）。
- **T17 task cancellation**：已有协作式；保留。
- **T18 graceful shutdown**：**新增 SIGTERM/SIGINT 钩子**，drain 在跑任务 + 关闭浏览器。
- **T19 restart recovery**：已有；保留。

### Infrastructure
- **I1 Resource Lock**：已有；保留。
- **I2 Queue**：默认路径不控并发——接受（锁+worker 容量已控），文档说明。
- **I3 Profile isolation**：已有；保留。
- **I4 Browser lifecycle**：已有；保留。
- **I5 crash recovery**：已有；保留。
- **I6 cleanup**：已有（惰性 TTL + zombieKiller）；**新增定时 prune 后台任务**。
- **I7 stale task recovery**：默认路径无周期 watch-dog——**新增周期 stale-task 扫描**（独立 setInterval，默认开启）。

---

## P1 产品层（前端）
- **F1 Dashboard**：接线后端已有但未展示指标（Running / AvgDuration / RecoveryRate / Escalated），新增 VerificationRate 计算。
- **F2 Profiles**：已有；保留。
- **F3 Tasks**：新增 Pause 按钮（调 `/api/ai/tasks/:id/pause`）；保留创建/执行/取消。
- **F4 Task Detail**：新增专用页，结构化实时展示 Goal/Current Step/Browser/Action/Observation/Verification/VIL/Repair/Status。
- **F5 Execution Timeline**：新增 VIL Decision / Escalation 节点类型，补充「决策理由」叙述层。

---

## API 兼容性
- **API1**：新增 `POST /api/ai/tasks/:id/pause`。
- **API2**：为 AI 任务生命周期增加 `/api/tasks/:id/*` 别名（指向 `/api/ai/tasks/:id/*`），消除前端 404 风险。
- 不强制重构现有路由命名，优先兼容。

---

## 版本
- 当前冻结基线：`v0.1.0`（package.json）+ `v0.1-alpha`（CHANGELOG）。
- Phase 11 Outcome Contract 后进入：`v0.2.0-dev`。
- Feature Complete 后：`v0.2.0-rc1`。
- 最终大规模 Benchmark 通过：`v0.2.0`。

---

## 判定门槛（Feature Complete）
- 所有 P0 项 = Existing（无 Missing/Partial 阻断）。
- P1 关键项（B15-B22、A13、T13、T14、T16、T18、I6、I7、F1、F3、F4、F5）= 已实现或文档化接受。
- 所有已有测试 + 新增 `test_feature_complete.js` 全部 PASS（不修绿）。
- 无 silent fallback、无安全门降低。
