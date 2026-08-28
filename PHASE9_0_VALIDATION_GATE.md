# PHASE 9.0 — Real Validation Gate

> 阶段性质：**执行前门检查（Pre-Execution Gate） / 只读**。
> 规则遵守：未运行任务、未修改代码、未调整 benchmark、未改变成功标准。
> 基线：**v0.1-alpha（FROZEN @ 2026-08-26T05:35:14）**。
> 目标：在真实 100 任务执行前，确认冻结完整性、凭据矩阵、任务分级、成功定义与执行规则就绪，并锁定发布判定门槛。

---

## 1. Freeze Integrity ✅ PASS

| 检查项 | 结果 | 证据 |
|--------|------|------|
| `server/agent` 未修改 | ✅ | 最新改动 `schema/action.js` @ `2026-08-26T05:27:38`，早于冻结报告 `05:35:14`；05:34 后无 `server/**/*.js` 改动 |
| `realBenchmark.js` 未修改 | ✅ | `server/scripts/realBenchmark.js` @ `2026-08-26T03:58:49`，早于冻结 |
| success definition 未修改 | ✅ | `runtime.js`(@08-25)、`verification.js`(@08-24) 均在冻结前；终态 `SUCCESS/FAILED/HUMAN_ESCALATION` 判定与 Phase 7 口径一致 |
| 冻结报告存在 | ✅ | `PHASE8_2_ALPHA_FREEZE_REPORT.md` + `CHANGELOG_v0.1-alpha.md` |

**结论**：冻结基线完整，可执行真实验证。

---

## 2. Credential Matrix

基于冻结的 `policy.js` 风险分级（fill=MEDIUM/AUTO，payment/password_change=CRITICAL，login 等需凭据）。

| 任务类型 | 允许 credentialRef | 风险等级 | 人工审批要求 | 备注 |
|----------|-------------------|----------|--------------|------|
| SaaS 登录 | ✅（usernameRef + passwordRef） | MEDIUM | 无（AUTO，凭据齐备时） | 无凭据 → CREDENTIAL_MISSING(HIGH) → 预期升级（非能力失败） |
| 电商/后台 普通填写（email/address/name） | ✅ 可选 | MEDIUM | 无（AUTO） | 非敏感字段明文 value 允许 |
| 数据录入（结构化字段） | ❌ 不需要 | MEDIUM | 无（AUTO） | 直接 value 录入 |
| 密码修改 / 敏感字段 | ✅ 必须 credentialRef | **CRITICAL** | **需人工审批** | 明文 value 被 `action.js` 拒绝 |
| 支付 / 购买 | ✅（卡 fixture credentialRef） | **CRITICAL** | **需人工审批** | 门控保持，不削弱 |
| 长流程含支付节点 | ✅（分段供给） | **CRITICAL**（支付段） | **需人工审批**（支付段） | 流程前段 AUTO，支付段门控 |

> 关键：真实验证中 **SaaS 类必须供给 `credentialRef`**，否则 Phase 7 中 7 例 saas 升级噪声将重现，污染 Human Intervention Rate。

---

## 3. Task Classification（100 任务分级）

| Level | 定义 | 预估步数 | 示例 | 占比（100 任务） |
|-------|------|----------|------|------------------|
| **L1 简单任务** | 单页单/少动作，无分支 | 1–2 | 搜索框输入并搜索、单字段 fill、点击按钮 | ~20 |
| **L2 多步骤任务** | 单页多字段表单 + 提交 | 3–6 | 商品上架填表、联系人创建、设置修改 | ~30 |
| **L3 长流程任务** | 跨多页/多状态，需 Checkpoint | 7–15 | 登录→录入→提交→确认、订单状态流转 | ~30 |
| **L4 复杂业务任务** | 跨系统、条件分支、外部依赖、含支付 | 15+ | 注册→邮箱验证(fixture)→完善资料→下单→支付；SaaS+电商复合流 | ~20 |

> 分级用于分层解读 Completion Rate：L1/L2 应接近 100%，L3/L4 允许更低（反映真实复杂度），避免"平均成功率"掩盖难度差异。

---

## 4. Success Definition

三层成功定义（均沿用冻结口径，未新创）：

| 层级 | 定义 | 判定源 |
|------|------|--------|
| **Execution Success（执行成功）** | 单步：action 实际执行 + 该步 verification 真实通过 | `aiSteps.verification.type≠none` 且 `verificationPassed` 计入；`aiAttempts.status==='SUCCESS'` |
| **Agent Success（Agent 成功）** | 任务：Runtime 终态 `SUCCESS`，所有 MUST_VERIFY 步骤验证通过，未触发 HUMAN_ESCALATION | `aiTasks.status==='SUCCESS'` |
| **Business Success（业务成功）** | 目标：在真实业务语义上达成（如订单真实生成、记录真实创建、状态真实变更） | 由终态验证 + 后置条件校验（post-condition verification）佐证，与 Agent Success 一致时即业务达成 |

> 三者关系：Execution ⊆ Agent ⊆ Business。报告须分别汇报，避免只报"任务成功"而掩盖单步验证弱点。

---

## 5. Execution Rules ✅ 确认

- ❌ 不自动修代码（冻结基线只读测量）
- ❌ 不调整 benchmark runner / 统计逻辑
- ❌ 不改变成功定义 / verification 标准
- ✅ 每波执行后**只分析**数据，发现问题登记为 B/C 类 Known Issue，不热改冻结基线
- ✅ 任何 A1 类 `field:null` 误拒复现 → 记为冻结回归缺陷，触发版本回检（非本阶段执行动作）
- ✅ 真实 DeepSeek API（`DEEPSEEK_API_KEY` 注入），禁止 mock / fallback / attachPlan

---

## 6. Release Decision Criteria（发布判定门槛，保持）

真实 100 任务执行后，达到以下全部门槛即建议进入 **v0.2.0 候选**（新版本号，非冻结热改）：

| 指标 | 门槛 | 说明 |
|------|------|------|
| **Completion Rate** | **≥ 70%** | 剔除 Credible（saas 凭据）升级后的 Agent Success / total |
| **Real escalation rate** | **≤ 30%** | HUMAN_ESCALATION 中 Real 类（验证/解析/锁）占比，不含 Credible |
| **Recovery Value** | **≥ 85%** | 经 repair 恢复的 step / 触发 repair 的 step（Step5 归因口径） |
| **ELEMENT_NOT_FOUND** | **≈ 0%** | 冻结保证（field 贯穿），任一复现即回归缺陷 |

**门结论**：前置检查全部通过，冻结完整、凭据矩阵/任务分级/成功定义/执行规则/发布门槛均已就绪。**Gate = OPEN（允许进入 Phase 9 真实 100 任务执行）**。

> 注：本阶段仅做门检查，未运行任何任务、未修改任何代码。实际执行将由后续授权触发（按 PHASE9_REAL_WORLD_VALIDATION_PLAN.md 的 4 波渐进方案）。
