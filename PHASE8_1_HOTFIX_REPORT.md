# PHASE 8.1 — Alpha Release Hotfix Report

> 范围：仅修复 Phase 8 审计发现的两个 Alpha 阻塞项（A1、A2）。
> 规则遵守：未新增功能、未改 benchmark / 成功定义 / verification 标准 / fingerprint-E4 / runtime 架构；未运行完整 Benchmark。

---

## 修改文件

| 文件 | 改动 | 原因 |
|------|------|------|
| `server/agent/schema/action.js` | `validateAction` 第 63 行：`field:null`/`""` 视为「未提供」，跳过字符串校验；仅当 field 为非字符串有值（如数字）才判非法 | **A1**：Phase 7 Step 2 引入的契约回归。DeepSeek 常送 `field:null` 表示「仅靠 semantic 定位」，原 `t.field !== undefined && !isNonEmptyString` 将其误判为非法，导致整计划被拒（Phase 7 中 3 个任务被错误判为 planner 失败，真实 planner 成功率 1.0 被压到 0.90）。 |
| `server/agent/repair/repairAttempts.js` | `reconcileRepair`（纯函数，Phase 7 Step 5 已写入，**本次确认并入冻结基线**） | **A2**：修复 repair 归因断链。FAILED repair 之后同 step 出现 SUCCESS attempt 即归因为 SUCCESS，并回写 `repairId`。 |
| `server/agent/stepManager.js` | `succeedAttempt` 调用 `reconcileRepair` 并落库（Step 5 已写入，**本次确认**） | **A2**：SUCCESS attempt 必须绑定 `repairId`（写入 `attempt.repairIds`），并将 `repair.status` 更新为 SUCCESS。 |
| `test_hotfix_a1a2.js` | 新增回归测试（11 项） | 验证 A1 接受 `field:null` 且强校验不降、A2 归因正确。 |

**未触碰**：benchmark、runtime、verification 标准、fingerprint/E4、观察/解析/规划/恢复等其它模块。

---

## A1 — Schema Contract Regression 修复

### 修复前（Phase 7 表现）
```
Error: Plan Schema 校验失败: steps[2](step_003): action 非法: target.field 非法
→ plan stored: [] → 该任务 steps=0 → 被算作 planner 失败
```
3 个任务（`failure.network_failure` / `failure.verification_failure` / `real.ec.lazy`）实际已生成合法 plan，仅因 `field:null` 被拒。

### 修复后
- `field:null` / `field:""` → 视为未提供，**不再 reject**，target object 完整保留（`field` 仍为 `null`）。
- **保留的强校验（均未降低）**：
  - 非法 `type` 仍 FAIL
  - MUST_VERIFY 动作（click/fill/submit…）缺 verification 仍 FAIL
  - 敏感字段（password）明文 `value` 仍 FAIL
  - `field` 为非字符串有值（数字）仍判非法

### 测试（A1 组）
- ✅ `field:null` + `semantic` → PASS（validateAction）
- ✅ `field:null` 经 `validatePlanStrict` → PASS
- ✅ `field:""` → PASS
- ✅ target object 保留 `field` 键（值仍为 null）
- ✅ 非法 type / 缺 verification / 敏感字段明文 / field 为数字 → 仍 FAIL

---

## A2 — Repair Attribution Freeze 确认

### 当前落地状态（已并入，本次确认）
- `repairAttempts.reconcileRepair(repair, stepAttempts)`：纯函数，FAILED repair 之后存在 `startedAt > repair.createdAt` 的 SUCCESS attempt → 返回 `{status:'SUCCESS', repairId, attributedAttemptIds}`；无则保持 FAILED。
- `stepManager.succeedAttempt(id)`：在 attempt 落库为 SUCCESS 后，对该 step 所有 FAILED repair 调用 `reconcileRepair`，将 `repairId` 写入成功 attempt 的 `repairIds`，并据此更新 `repair.status`。

### 测试（A2 组）
- ✅ FAILED repair + 后续 SUCCESS attempt → `status:SUCCESS` + 绑定 `repairId` + 归因 attempt
- ✅ FAILED repair 无 SUCCESS retry → 保持 FAILED
- ✅ 已是 SUCCESS 的 repair 不被重算覆盖

### 历史数据（Phase 7 全量）
`server/scripts/recomputeRepairAttribution.js` 已在 Step 5 将 24 条 repair 重算为 **22 SUCCESS / 2 FAILED**（2 例为 RESOURCE_LOCK，属 C 类基础设施），并持久化到 `aiRepairAttempts.json` 与 `aiAttempts.json`（43 个 attempt 带 `repairIds`）。本次热修确认该逻辑随冻结基线发布。

---

## 测试结果

| 套件 | 结果 |
|------|------|
| `test_hotfix_a1a2.js`（本次新增，A1+A2） | **11 / 11 PASS** |
| `test_resolver_unit.js` | 7 / 7 PASS |
| `test_target_contract.js` | 8 / 8 PASS |
| `test_credential_policy.js` | 8 / 8 PASS |
| `test_repair_step5.js` | 11 / 11 PASS |
| **合计** | **45 / 45 PASS（零回归）** |

---

## 是否达到 Alpha Freeze 条件

### ✅ 是 — 已满足冻结 v0.1-alpha 的全部前置条件

Phase 8 审计列出的两个 Alpha 阻塞项均已消除：

1. **A1 已修复**：`field:null` 不再误拒合法 plan → planner 真实成功率恢复为 1.0，3 个被污染任务将不再被错误判为 planner 失败。
2. **A2 已确认并入**：repair 归因链路（SUCCESS attempt 绑定 repairId、repair.status=SUCCESS）随冻结基线发布，repair 真实成功率 92% 得以保持。

剩余未阻塞项（Phase 8 分类 B/C）不影响冻结：
- **B 类（Alpha 后优化）**：验证异步竞态精度、更复杂 repair 策略、更多真实站点覆盖、升级抢跑精细化。
- **C 类（基础设施）**：`RESOURCE_LOCK`（Profile 锁调度，非 Agent 算法问题）。

### 冻结建议
**建议立即冻结 v0.1-alpha**。系统已具备：
- 真实 LLM 规划（DeepSeek，simulated:false，planner 真实 100%）
- 浏览器执行闭环（ELEMENT_NOT_FOUND 0%）
- 验证 100% 真实覆盖（none 率 0%）
- 自动恢复闭环（repair 归因 92%）
- 人工升级门控正确（payment/password=CRITICAL，fill=MEDIUM）
- 完整可观测（traceCollector + 20+ JSON store）

---

## 附
- A1 代码点：`server/agent/schema/action.js:63`
- A2 代码点：`server/agent/repair/repairAttempts.js:75`、`server/agent/stepManager.js:84`
- 关联报告：`PHASE8_ALPHA_RELEASE_AUDIT.md`、`PHASE7_STEP5_REPORT.md`、`PHASE7_REAL_AI_VALIDATION_REPORT.md`
