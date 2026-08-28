# PHASE 9 — Real World Validation Plan

> 阶段性质：**规划 / 只读**。不修改代码、不运行任务。
> 基线版本：**v0.1-alpha（FROZEN）**。所有验证均在冻结能力上做"外部测量"，不改 Agent 内部逻辑。
> 目标：设计真实世界验证方案，把 Phase 7 的 30 任务实验室基准扩展为 100 任务真实场景验证，并沉淀可复用的指标体系与采集方案。

---

## 1. 真实任务集设计

复用现有 `server/agent/scenarios.js` 加载框架 + `realBenchmark.js` runner，按四类真实场景扩充到 100 任务（含既有 30 任务作为回归基线子集）。

### 1.1 SaaS（~30 任务）
代表：CRM / 邮箱 / 协作工具 / 后台登录态业务流。
- 登录（供给 `credentialRef`，消除 Phase 7 中 7 例 saas 凭据升级噪声）
- 创建记录（联系人/工单）、筛选列表、导出 CSV
- 设置项修改、通知开关
- 多步向导（wizard）完成
> 真实难点：SPA 动态 DOM、异步表格、二次确认弹窗 → 验证竞态（B1）主战场。

### 1.2 电商后台（~25 任务）
代表：商户后台 / 商品管理 / 订单处理。
- 商品上架（填表 + 图片上传占位 URL + 提交）
- 订单状态流转（待发货→已发货）
- 库存批量修改、价格调整
- 营销活动配置
> 真实难点：富表单、级联下拉、长表单验证。

### 1.3 数据录入（~20 任务）
代表：从结构化源（CSV/JSON fixture）逐条录入到目标系统。
- 固定字段映射录入（name/email/phone/address）
- 重复检测与跳过
- 批量分页录入（每页 N 条）
> 真实难点：field 语义歧义（B3）、长流程稳健性、错误行恢复。

### 1.4 长流程任务（~25 任务）
代表：跨多页、多系统、需中间状态保持的复合任务。
- "注册 → 验证邮箱（fixture）→ 完善资料 → 首单下单" 端到端
- "搜索 → 对比 → 加入购物车 → 结算 → 支付（fixture 卡）→ 确认" 
- 跨 SaaS+电商的组合流
> 真实难点：Checkpoint 回放有效性、中途失败的 repair 串联、升级决策点（B4）。

**总计**：30（既有回归）+ 30 SaaS + 25 电商 + 20 录入 + 25 长流程 = **130 任务池**，首跑取 **100 任务**（含全部 30 回归 + 各类抽样）。

---

## 2. Benchmark 规则

沿用 `realBenchmark.js` 的终态判定，明确三类结局定义（不改变 success 定义，仅文档化）。

### 2.1 success（成功）
- Runtime 终态 `status === 'SUCCESS'`
- 且最后一个 MUST_VERIFY 步骤的 verification 实际通过（`verificationPassed === verificationTotal` 且无非 `none` 失败）
- 且未触发 HUMAN_ESCALATION
> 即"经过真实验证闭环的成功"，与 Phase 7 口径一致（非失真 `none` 通过）。

### 2.2 failure（失败）
- Runtime 终态 `status === 'FAILED'`
- 原因：planner 真实失败（schema 拒且非 A1 类污染）、执行耗尽重试、verification 持续失败、RESOURCE_LOCK 未恢复
> 区分"真实失败"与"测量污染"：A1 类 `field:null` 拒计划在 v0.1-alpha 已修复，不应再出现；若复现即记为 **回归缺陷**（非能力失败）。

### 2.3 human escalation（人工升级）
- Runtime 终态 `status === 'HUMAN_ESCALATION'`
- 细分（复用 `errorClassifier` + `policy`）：
  - **Credible（预期）**：saas 登录无 `credentialRef` → CREDENTIAL_MISSING（HIGH）→ 升级（正确安全行为，不计为 Agent 失败）
  - **Real（真实弱点）**：SEMANTIC_RELOCATE 耗尽 / VERIFY_FAILED 持续 / 锁竞争
- 报告须分别统计两类，避免把"安全门控"误算成能力失败。

---

## 3. 指标体系

在 Phase 7 指标基础上扩展为真实世界适用指标。

| 指标 | 定义 | 采集源 |
|------|------|--------|
| **Completion Rate（完成率）** | success / total | `aiTasks.status` |
| **Human Intervention Rate（人工干预率）** | HUMAN_ESCALATION / total（含 Credible 与 Real 细分） | `aiTasks.status` + `errorClassifier` |
| **Recovery Value（恢复价值）** | 经 repair 恢复的 step 数 / 触发 repair 的 step 数（即 Step5 归因口径） | `aiRepairAttempts` + `aiAttempts.repairIds` |
| **Cost（成本）** | 总 token / USD，含 prompt+completion；per-task avg | `realBenchmark` summary + `aiPlannerEvidence` |
| **Duration（时长）** | 端到端秒数（含 planner+exec+verify+repair） | `aiTasks.createdAt` → 终态时间戳 |
| **Failure Taxonomy（失败分类）** | 按 `errorClassifier.type` 分布：ELEMENT_NOT_FOUND / VERIFY_FAILED / NO_VALUE / RESOURCE_LOCK / PLANNER / OTHER | `aiAttempts.error.code` + `aiFailureSnapshots.errorType` |

**附加质量指标**（Phase 7 已有）：
- Verification Coverage（verification≠none 占比，目标 100%）
- Verification Accuracy（验证判读正确率，目标 > Phase 7 的 67%）
- AgentScore（planning/execution/verification/recovery/autonomy 五维）

---

## 4. 数据采集方案

**全部复用现有冻结基础设施，不新增存储**（符合 C 类红线）。

| 数据 | 现有落点 | 用途 |
|------|----------|------|
| 规划证据 | `aiPlannerEvidence.json`（raw plan / schemaResult / errors） | 审计 LLM 输出质量、定位 A1 类回归 |
| 执行轨迹 | `aiSteps.json` + `aiAttempts.json`（含 `repairIds`） | 计算 ELEMENT_NOT_FOUND、verification、repair 归因 |
| 失败快照 | `aiFailureSnapshots.json`（errorType / visibleTexts / lastAction） | 失败分类、复现分析 |
| 修复记录 | `aiRepairAttempts.json`（strategy / status / diagnosisId） | Recovery Value、策略分布 |
| 可回放时间线 | `observability/traceCollector.js`（`buildTimeline`） | 单任务全链路追踪（PLAN→…→CHECKPOINT） |
| 多维指标 | `observability/aggregator.js` + taskMetrics/queueMetrics/resourceMetrics | Dashboard 实时观测 |
| 检查点 | `aiCheckpoints.json` | 长流程崩溃恢复验证 |

**采集流程**：`realBenchmark.js` 运行 → 自动写入上述 store → 报告生成器（参考 `genPhase7Report.js` 只读聚合）从 store 实算指标。无需新代码，仅配置任务集与运行参数（`--max 100`、`DEEPSEEK_API_KEY` 注入、saas 任务供给 `credentialRef`）。

---

## 5. 第一批 100 任务执行计划

### 5.1 前置（冻结外、一次性）
- 为 SaaS 类任务在 harness 层供给 `credentialRef`（vault fixture），消除 Credible 升级噪声，使 Human Intervention Rate 反映真实弱点。
- 确认 `RESOURCE_LOCK`（C1）锁调度：限制并发 execution 数，降低锁竞争导致的假性失败。
- 不修改 Agent 代码。

### 5.2 运行
```
cd fingerprint-browser
DEEPSEEK_API_KEY=<real> node server/scripts/realBenchmark.js --max 100
# 输出：.benchmark/phase9_*.json + PHASE6_REAL_AI_VALIDATION_REPORT.md（按 runner 默认）
```

### 5.3 分批策略（降风险、早发现问题）
- **Wave 1（30 任务）**：既有回归子集，确认冻结基线无回退。
- **Wave 2（30 任务）**：SaaS + 电商后台。
- **Wave 3（25 任务）**：数据录入 + 长流程。
- **Wave 4（15 任务）**：长流程高压（跨系统复合）。
每波完成后用 `genPhase7Report` 式聚合做止血检查，再进下一波。

### 5.4 完成判据（真实世界 Alpha 门槛，仅测量）
- Completion Rate ≥ 70%（含 Credible 升级剔除后）
- Human Intervention Rate（Real 类）≤ 30%
- Recovery Value ≥ 85%
- ELEMENT_NOT_FOUND ≈ 0%（冻结保证）
- 无 A1 类回归（schema 不再误拒 `field:null`）

### 5.5 产出
- `PHASE9_REAL_WORLD_RESULTS.md`（对比 Phase 7 基线）
- 失败分类报告（Failure Taxonomy）
- 若指标达标 → 建议进入 **v0.2.0 候选**（新能力增强，非冻结热改）。

---

## 附：与冻结基线的关系
- 本计划**不改 v0.1-alpha 任何代码**，100 任务是对冻结能力的外部真实测量。
- 发现的任何 Agent 缺陷一律登记为 **B/C 类 Known Issue**，待 v0.2.0 规划处理，不在冻结基线热修。
- 若运行中发现 A1 类 `field:null` 误拒复现 → 记为冻结回归缺陷，触发版本回检（非本阶段动作）。
