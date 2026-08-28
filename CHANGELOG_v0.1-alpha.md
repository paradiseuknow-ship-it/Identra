# CHANGELOG — v0.1-alpha

> 状态：**FROZEN**（冻结于 2026-08-26, UTC+8）
> 适用范围：`fingerprint-browser` AI Browser Operator Agent
> 规则：冻结基线不接受热修改；后续变更须以新版本号走流程。

---

## [0.1-alpha] — 2026-08-26

首个 Alpha 候选冻结版本。完成从 Demo 到产品化感知-执行接口契约的收敛。

### Added（相对早期原型，Phase 1–6 累积）
- 真实 DeepSeek 规划链路（`deepseekPlan` 严格路径 + `validatePlanStrict` + `normalizeStrictToCanonical` 透传）。
- 多信号 Semantic Resolver：field 权威键 + semantic 模糊/CJK bigram + 邻近上下文 + element type；接收完整 `action.target` 对象。
- Observation 暴露 `name/id/cls/placeholder/label/ariaLabel/role` 等 field 定位信号。
- Verification 真实闭环：MUST_VERIFY 扩展至 click/fill/submit，禁止 `none` 静默补。
- Repair 模块：7 类策略（`elementChanged`/`navigation`/`obstruction`/`sessionExpired`/`timeout`/`generic`/`verifyFailed`）。
- Recovery：errorClassifier + policy 分级门控（payment/password_change=CRITICAL，fill=MEDIUM AUTO）。
- Checkpoint：结构化快照（lastVerifiedState/profileId/executionId）支持崩溃回放。
- Observability：traceCollector 统一可回放时间线 + aggregator 多维指标 + Dashboard。
- `realBenchmark.js` 真实 DeepSeek Benchmark Runner（30 任务，禁止 mock/fallback）。

### Fixed（Phase 7 Step 2 / Step 5 / Phase 8.1）
- **Step 2-A**：Resolver 数据流缺陷——上游把 `{field,semantic}` 压扁成字符串致 field 丢失；改为 `tools.resolveSelector` 传完整 target，ELEMENT_NOT_FOUND 80.1% → 0%。
- **Step 2-B**：`validatePlanStrict` 返回 step 时漏传 `verification` + `normalizeStrictToCanonical` 静默补 none → 修正为透传；verification:none 96.7% → 0%。
- **Step 5**：Repair 归因断链——FAILED repair 后 step 实际恢复但记录 false 0%；新增 `reconcileRepair` + `stepManager.succeedAttempt` 归因，历史 24 条重算 22/24（92%）SUCCESS。
- **Step 5**：VERIFY_FAILED 策略错配——单 `SEMANTIC_RELOCATE` 用于验证失败药不对症；新增 `verifyFailed` 策略（WAIT_STABLE→RECHECK_OBSERVATION→RETRY_VERIFY→SEMANTIC_RELOCATE），并按原始 `classifier.type==='VERIFICATION_FAILED'` 强制路由。
- **Phase 8.1 A1**：Schema 契约回归——`field:null` 被 `action.js` 误拒整计划；改为 null/空串视为未提供，强校验（verification/敏感字段/非法 type）不降低。
- **Phase 8.1 A2**：确认 repair 归因逻辑并入冻结基线（SUCCESS attempt 绑定 `repairId`、repair.status=SUCCESS）。

### Verified（冻结前真实能力基线，Phase 7 实测）
- DeepSeek 真实规划：planner 真实 100%（A1 修复后消除污染）。
- Playwright 执行：ELEMENT_NOT_FOUND 0%。
- Verification 覆盖：100%（none 0%）。
- Repair 归因：92%（22/24）。
- Human Escalation：policy 门控正确。
- AgentScore overall：67（planning 90 / execution 65 / verification 72 / recovery 50 / autonomy 53）。

### Known Issues（不阻塞冻结）
- **B（Alpha 后）**：B1 VERIFY_FAILED 异步竞态精度优化；B2 更多 repair 策略；B3 更多真实网站覆盖；B4 升级抢跑精细化。
- **C（基础设施）**：C1 RESOURCE_LOCK（Profile 锁调度竞争）。

### Frozen Components（10/10）
Planner · Schema · Observation · Resolver · Runtime · Verification · Repair · Recovery · Checkpoint · Observability

---

## Versioning Policy
- 冻结基线：本版本号 `0.1.0`（v0.1-alpha）。
- 热修复（非架构）：`0.1.x`。
- 能力增强 / 新策略：`.x.0` 次版本。
- 任何修改不得直接改冻结基线文件，须新版本号发布并附 CHANGELOG 条目。
