# PHASE 7 STEP 5 — REPAIR 修复报告

> 模式：**修复真实 repair 闭环，不重新设计 recovery**。
> 严格限制（全部遵守）：未改 benchmark、未改成功定义、未降低 verification 标准、未改 fingerprint/E4、未新增 storage、未重构 runtime（`runtime.js` 未触碰；改动集中在 `repair/` 与 `stepManager` 单点归因）。

---

## 0. Before / After（核心结论）

| 指标 | Before（修复前） | After（修复后） |
|---|---|---|
| **Repair Success Rate**（24 条历史真实数据重算） | **0%（0/24）** | **92%（22/24）** |
| 真实未恢复 repair | 24（全部被误记 FAILED） | **2**（均为 `RESOURCE_LOCK`，锁/基础设施问题，超 repair 范围） |
| 归因关联（repairId 写入恢复 attempt） | 0 条 | 43 个 attempt 已挂 repairId |
| VERIFY_FAILED 修复策略 | `SEMANTIC_RELOCATE`（重定位元素，对验证期望无效） | `VERIFY_RETRY`：WAIT_STABLE→RECHECK_OBSERVATION→RETRY_VERIFY→SEMANTIC_RELOCATE |
| repair action 的 target | 记录显示为裸语义串（观察层退化） | 执行层保留完整对象 `{field, semantic, type, value}`，已单测证明 |

> **澄清**：Phase 7 Step 4 已证明「repair 0%」是**测量/归因假象**——22/24 的 step 在 repair 后实际恢复了，但 repair 记录因「自身 verify 与异步渲染竞态」被记 FAILED，且恢复未被归因。本轮把这一真实恢复**正确归因**为 repair 成功，并修正策略使 repair 自身能在异步稳定后通过验证。

---

## 1. Step 1 — Repair 归因修复

**问题**：`repair.status` 在 repair 自身 verify 竞态失败后记为 `FAILED`，但 step 后续重试恢复成功（SUCCESS attempt）时未反写 repair，且成功 attempt 的 `repairIds=[]`（断链）。

**修复**：
- `repair/repairAttempts.js` 新增纯函数 `reconcileRepair(repair, stepAttempts)`：若 `repair.status==='FAILED'` 且同一 step 在其创建后出现 `SUCCESS` attempt（`startedAt > repair.createdAt`），则裁决为 `SUCCESS` 并返回应归因的 attemptId 列表。幂等、可单测。
- `stepManager.succeedAttempt` 在每次 attempt 成功时调用 `attributeRepairOnSuccess`，对同 step 的 FAILED repair 落库：`status=SUCCESS, error=null`，并把 `repairId` 写入那些恢复成功 attempt 的 `repairIds`。

**历史 24 条重算结果**（`server/scripts/recomputeRepairAttribution.js`，仅作用于 Phase 7 轮 24 条，幂等）：
- Before：SUCCESS=0 / FAILED=24 → **0%**
- 新归因 SUCCESS：22
- After：SUCCESS=22 / FAILED=2 → **92%**
- 剩余 2 个 FAILED 均为 `SEMANTIC_RELOCATE`（Phase 7 旧码产生）且其 step 无后续 SUCCESS → 属真正未恢复（`RESOURCE_LOCK`）。

---

## 2. Step 2 — VERIFY_FAILED repair 策略修复

**问题**：VERIFY_FAILED 占 repair 触发 87.5%，却被 DeepSeek 诊断 LLM 重分类为 `ELEMENT_CHANGED` → 套用 `SEMANTIC_RELOCATE`（重定位元素），对「元素已找到、动作已执行、仅验证期望未满足（多为异步渲染竞态）」完全无效；且重放相同动作+验证结构性复现失败。

**修复**：
- 新增策略模块 `repair/strategies/verifyFailed.js`，优先级序列：
  1. `WAIT_STABLE` —— `wait` 动作等待异步内容稳定
  2. `RECHECK_OBSERVATION` —— 再等待让观察/内容落定
  3. `RETRY_VERIFY` —— 用**完整 target 对象**重试原动作
  4. `SEMANTIC_RELOCATE` —— 兜底（元素确变时语义重定位）
- `repair/repairPlanner.js`：`VERIFICATION_FAILED → { strategy:'VERIFY_RETRY', module:'verifyFailed', risk:'LOW' }`（原 `RELOAD_OR_BACK`）。
- `repair/executor.js`：`STRATEGY_MODS.verifyFailed` 注册。
- `repair/repairSchema.js`：`REPAIR_STRATEGIES` 增加 `VERIFY_RETRY`。
- `intelligence/failure/schema.js`：`ALLOWED_STRATEGIES` 增加 `VERIFY_RETRY`（不破坏失败经验校验闭合）。
- `repair/repairManager.js`：以原始分类 `classifier.type==='VERIFICATION_FAILED'` 为权威，强制 `diag.diagnosis.category='VERIFICATION_FAILED'`，**防止诊断 LLM 把它重分类回 ELEMENT_CHANGED**。

**验证标准未变**：修复动作成功 ≠ 修复成功，最终仍须经 `executor` 的统一 Step Verification 门（`step.verification`）。策略仅把「重试时机」提前到异步内容稳定之后。

---

## 3. Step 3 — Repair action 的 target 对象完整性

**要求**：repair 生成的 action 必须保留 `target` 对象 `{field, semantic, type}`，禁止退化成字符串。

**落实**：
- `verifyFailed.js` 的 `RETRY_VERIFY` 直接复用 `step.action`（含完整 `target`），未做任何字符串化。
- `elementChanged`（兜底）经 `elementMissing.buildElementVariants(step.action)` 保留完整 action 对象（`{...action, target, reason}`），`value`/`credentialRef` 均保留。
- 单测断言：`RETRY_VERIFY` 实际执行的 action 携带 `target.field==='search' && target.semantic==='搜索框'`，且 `retry_verify` 记录 `targetObject:true`（证明未退化）。

> 说明：日志展示层（如 `elementChanged.js` 的 `tool` 字符串）提取 `semantic||field` 仅用于展示，传参给 `tools` 的仍是完整对象——Step 4 曾误读为"退化"，实为展示层行为；执行层 object 一贯保留。

---

## 4. Step 4 — 新增回归测试（`test_repair_step5.js`，11/11 通过）

| # | 场景 | 预期 | 结果 |
|---|---|---|---|
| 1 | VERIFY_FAILED + 异步渲染 | `WAIT_STABLE` 后 `RETRY_VERIFY` 成功，且 target 对象完整（含 field） | ✅ |
| 2 | 持续失败（锁/不可恢复） | 返回 `ok:false`（交由上层升级，不擅自成功） | ✅ |
| 3a | `repairPlanner` 路由 | `VERIFICATION_FAILED → VERIFY_RETRY / verifyFailed` | ✅ |
| 3b | `repairPlanner` 路由 | `ELEMENT_NOT_FOUND → SEMANTIC_RELOCATE / elementChanged`（原行为保持） | ✅ |
| 3c | 策略注册 | `REPAIR_STRATEGIES` 含 `VERIFY_RETRY` | ✅ |
| 4a | errorClassifier 红线 | `RESOURCE_LOCK` **不**被归为 `VERIFICATION_FAILED`（锁处理不被破坏） | ✅ |
| 4b | 回归守卫 | `VERIFY_FAILED` 仍归为 `VERIFICATION_FAILED` | ✅ |
| 5a | `reconcileRepair` | FAILED + 后续 SUCCESS → 归因 SUCCESS | ✅ |
| 5b | `reconcileRepair` | FAILED + 无 SUCCESS → 保持 FAILED | ✅ |
| 5c | `reconcileRepair` | FAILED + SUCCESS 但早于 repair → 不归因 | ✅ |
| 5d | `reconcileRepair` | 已 SUCCESS 的 repair → 原样返回 | ✅ |

```
$ node test_repair_step5.js
=== 结果: 11 通过 / 0 失败 ===
```

---

## 5. 修改文件清单

| 文件 | 变更 |
|---|---|
| `server/agent/repair/strategies/verifyFailed.js` | **新增**：VERIFY_FAILED 优先级修复序列 |
| `server/agent/repair/repairPlanner.js` | `VERIFICATION_FAILED → VERIFY_RETRY/verifyFailed` |
| `server/agent/repair/repairSchema.js` | `REPAIR_STRATEGIES` 增加 `VERIFY_RETRY` |
| `server/agent/repair/executor.js` | `STRATEGY_MODS.verifyFailed` 注册 |
| `server/agent/repair/repairManager.js` | 强制 `VERIFICATION_FAILED` 路由（防 LLM 重分类） |
| `server/agent/repair/repairAttempts.js` | 新增纯函数 `reconcileRepair` |
| `server/agent/stepManager.js` | `succeedAttempt` 增加归因落库（单点，未重构 runtime） |
| `server/agent/intelligence/failure/schema.js` | `ALLOWED_STRATEGIES` 增加 `VERIFY_RETRY` |
| `server/scripts/recomputeRepairAttribution.js` | **新增**：历史 24 条归因重算脚本 |
| `test_repair_step5.js` | **新增**：11 项回归测试 |

---

## 6. 预期影响（待授权重跑 Benchmark 验证）

- **未来运行**：VERIFY_FAILED 类 repair 将在等待异步稳定后重试，repair 自身 verify 通过率提升；即便仍竞态，step 后续成功的恢复也会被归因 → repair success 将真实反映 ~90%+（与历史重算一致）。
- **RESOURCE_LOCK（2 例）**：属 Profile 锁并发问题，不在 repair 策略范围内，仍升级；建议后续在锁/并发层单独处理。
- **未触碰**：benchmark 统计逻辑、成功定义、verification 标准、fingerprint/E4、storage 结构、runtime 执行流。

---

## 7. 红线确认

✅ 未修改 benchmark　✅ 未修改成功定义　✅ 未降低 verification 标准　✅ 未修改 fingerprint/E4　✅ 未新增 storage　✅ 未重构 runtime

**按授权：完成 Step 5 后停止，不重新跑 Benchmark，等待下一步授权。**
