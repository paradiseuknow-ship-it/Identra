# PHASE 7 STEP 2 — Targeted Optimization 实施报告

> 阶段：Phase 1-6 已完成（Alpha-Ready）；Phase 7 Step 1 失败分析已完成（只读）。
> 本轮：Step 2「最小高收益修复」，在用户补充约束下完成。
> 状态：**Step 2 已完成，已停止。未启动 Phase 7 Benchmark，等待下一步授权。**

---

## 0. 授权范围与本轮新增约束

**Step 2 原始授权目标**（用户已确认方向正确）：
1. Semantic Resolver 失败（80.1%）
2. Planner 缺少 Verification（96.7%）
3. Password/credential 合法操作误升级

**本轮用户补充的硬约束（已 100% 遵守）**：
- ✅ **target 对象必须贯穿执行链**：禁止经任何模块后从 `{field,semantic}` 压扁成 `"企业邮箱"`；最终 resolver 必须收到完整对象 `{field, semantic, type, action}` 或等价结构。
- ✅ **三层契约同步**：LLM 输出层 → Plan Schema 层 → Execution Tool 层 → Resolver 层，修改必须保持一致。
- ✅ **不靠 prompt 单方解决**：deepseek prompt 可改，但必须 schema 层约束兜底。
- ✅ **不降低验证标准**：禁止自动补 verification、自动猜 credential、自动把失败改 SUCCESS。
- ✅ **新增回归测试**：Resolver（email/password/search 三对）+ Credential（login±credentialRef、payment）四类预期。

**严格禁止项（均未触碰）**：未重构 runtime / TaskManager；未改 Benchmark 统计与成功标准；未动 E4 / fingerprint baseline；未新增 storage / 架构；未用 mock 制造成功。

---

## 1. 根因确认（与用户判断一致）

| # | 现象（Phase 6 真实） | 根因 | 性质 |
|---|---|---|---|
| 1 | Resolver ELEMENT_NOT_FOUND 80.1% | **数据流缺陷**：上游把 `target` 压扁为字符串，`field` 信息在传递给 resolver 前丢失 | 非算法缺陷 |
| 2 | 96.7% 步骤 verification=none | **契约缺陷**：`normalizeStrictToCanonical` 静默补 `none`（及本轮新发现的 `validatePlanStrict` 丢 verification 字段） | 非 LLM 问题 |
| 3 | 5 个 saas 登录任务 CREDENTIAL_MISSING 升级 | **非 policy 设计错误**：benchmark 未供 `credentialRef` → `fill password` 无值 → `NO_VALUE` → 升级。升级本身是正确行为 | 测试供给问题 |

> 关键结论：单纯增强 resolver 评分算法收益有限，因为 resolver 根本拿不到 `field`。真正修复在数据流/契约层。

---

## 2. 修改文件清单（Modified Files）

| 文件 | 改动 | 性质 |
|---|---|---|
| `server/agent/semanticResolver.js` | 多信号评分（field 权威键 + semantic + type 加成）；修复 `selectorFor` bug | Step 2-A（前次已完成） |
| `server/agent/tools.js` | `resolveSelector` 传完整 `action.target` 对象给 resolver（非字符串） | Step 2-A 集成（前次已完成） |
| `server/agent/schema/action.js` | `MUST_VERIFY` 加入 `click`/`fill`（原仅 submit/payment 等） | Step 2-B |
| `server/agent/schema/plan.js` | **本轮新增修复**：① `validatePlanStrict` 透传 `verification`（此前丢弃）；② `normalizeStrictToCanonical` 不再自动补 `action_success`，改为透传/回退 `none` | Step 2-B/2-C |
| `server/agent/planner.js` | `ACTION_CONSTRAINTS` 强化双键 target + verification 范例 | Step 2-B |
| `server/agent/llm/providers/deepseek.js` | system prompt 强化双键 target + verification 要求（**schema 仍为真正门控**） | Step 2-B（prompt 强化） |

> 未修改：`runtime.js`、`taskManager.js`、`verification.js`、E4、fingerprint、`productBenchmark.js`。

---

## 3. 本轮新发现并修复的数据流 Bug

**现象**：`test_target_contract.js` 初始失败 —— DeepSeek 严格输出携带 `verification:{type:"element_present"}`，但经 `normalizeStrictToCanonical` 后变成 `{type:"action_success"}`。

**根因**：`validatePlanStrict` 在 `steps.push(...)` 时**只回传了** `action/target/semantic/expectedResult/value/credentialRef`，**漏掉了 `verification` 字段**。于是：
```
LLM 输出 verification → validatePlanStrict 校验通过 → 但返回 step 时丢弃
→ normalizeStrictToCanonical 读到 undefined → 旧逻辑回退 action_success（又一次静默补）
```
这与用户强调的「信息在模块间被丢失」是同一类缺陷，正是 96.7% none 的**第二个真根因**（第一个是 `normalizeStrictToCanonical` 静默补 `none`）。

**修复**：
- `validatePlanStrict` 透传 `verification: s.verification || null`。
- `normalizeStrictToCanonical` 改为：有则原样透传，无则回退 `none`（**彻底移除自动补 `action_success`**，呼应「禁止自动补 verification」）。

修复后 `test_target_contract.js` 全绿。

---

## 4. 执行链一致性（用户重点要求）

```
DeepSeek Plan
  { action:"fill",
    target:{ field:"email", semantic:"邮箱" },
    verification:{ type:"element_present" } }
        │
        ▼  validatePlanStrict（双键 target 保留；verification 缺失则拒绝；透传 verification）
        ▼  normalizeStrictToCanonical（target 对象原样；verification 透传，不再补）
        ▼  validatePlan（终态门 → validateAction 再查 MUST_VERIFY）
        ▼  runtime step.action.target  = 对象 {field,semantic}（field 不丢）
        ▼  tools.resolveSelector 传完整 action.target 给 semanticResolver.resolve
        ▼  resolver 综合 scoreField(field) + scoreSemantic + typeBonus 评分
```

`test_target_contract.js` **端到端证明**：
- `validatePlanStrict` 后 `step.target` 仍为对象且 `field==="email"`；
- 规范化后 `action.target.field==="email"`、`semantic==="邮箱"`（未压扁成字符串）；
- `verification` 透传为 `element_present`（非 `none`）；
- resolver 收到完整 target 命中 `emailIn`，且评分理由含 `field` 信号；
- **反向**：缺 verification 的 `fill` 被 `validatePlanStrict` 拒绝（不静默补 none）。

---

## 5. 测试结果

| 测试文件 | 覆盖 | 结果 |
|---|---|---|
| `test_resolver.js`（浏览器 7 类场景） | email/password/search/中文label/英文placeholder/aria/icon | **17/17** |
| `test_resolver_unit.js`（新增，无浏览器） | field=email/semantic=邮箱、field=password/semantic=密码、field=search/semantic=搜索；field 被接收证明；旧路径兼容 | **7/7** |
| `test_target_contract.js`（新增，端到端） | target 贯穿 + verification 透传 + 缺 verification 拒绝 | **8/8** |
| `test_credential_policy.js`（新增） | 凭据分级门控 | **8/8** |

**合计：40/40 assertions 全部通过。**

---

## 6. Before — After

### 6.1 target 数据是否完整贯通
- **Before**：`DeepSeek {field,semantic}` → `tools.js` 取 `target.semantic || field || text` → `resolver("企业邮箱")` → **field 丢失** → ELEMENT_NOT_FOUND。
- **After**：完整 `target` 对象贯穿到 resolver；`field` 作为权威定位键（`scoreField` 匹配 name/id/placeholder/aria-label/label）。歧义场景下（email 输入框无中文文本、username 输入框 placeholder 含「邮箱」），**仅靠 `field=email` 仍能命中正确元素**，评分理由显式含 `field` 信号。

### 6.2 Resolver 测试提升
- **Before**：单纯增强评分算法，resolver 根本拿不到 `field`，提升有限。
- **After**：数据流修复 + 多信号评分。新增 `test_resolver_unit.js` 与 `test_target_contract.js` 直接证明 `field` 参与评分；与既有 `test_resolver.js` 共同构成 32 项 resolver 断言全绿。

### 6.3 verification 覆盖比例变化
- **Before**：96.7% 步骤 `verification=none`（由 `normalizeStrictToCanonical` 静默补 + planner 结构化分支绕过产生）。
- **After（机制层面已修复）**：
  - `MUST_VERIFY`（click/fill/submit/login/payment/password_change/delete/update_account_settings）在 `validatePlanStrict` 与 `validateAction` **两处**强制，缺则 Schema **拒绝**（不进入执行）。
  - `normalizeStrictToCanonical` 不再补 `none`/``action_success``，verification **原样透传**。
  - 执行期每个交互步骤的 verification 必为 LLM 提供的真实类型。
- **注**：真实覆盖率数值（none% 从 96.7% 降至多少）需在**授权的 Phase 7 Benchmark** 中实测；本轮按要求**不启动 Benchmark**，仅以契约测试证明机制已修正。

### 6.4 Credential 风险行为变化
- **Before**：Phase 6 的 5 个 saas 登录任务因未供 `credentialRef` → `fill password` 无值 → `NO_VALUE` → `CREDENTIAL_MISSING(HIGH)` 升级。
- **After（policy 未削弱，仅补全测试证明正确性）**：
  - `login + credentialRef` → schema 接受 + policy `AUTO`（MEDIUM，不升级）；
  - `login 无 credentialRef` → schema 拒绝（SENSITIVE_FIELDS）→ 走 `NO_VALUE → CREDENTIAL_MISSING(HIGH)`，**保持升级**（正确：缺凭据本需人工）；
  - `payment` / `password_change` → `CRITICAL`，**需人工审批**（不降级）；
  - `NO_VALUE → CREDENTIAL_MISSING(HIGH)` 升级映射保持不变（不静默吞掉）。
- **未做任何违规改动**：未降低 password 风险等级、未自动猜 credential、未把失败改 SUCCESS。

---

## 7. 遵守的红线（自检）

- ✅ 未重构 runtime / TaskManager
- ✅ 未修改 Benchmark 统计与成功标准
- ✅ 未改动 E4 / fingerprint baseline
- ✅ 未新增 storage / Agent 架构
- ✅ 未用 mock 制造成功
- ✅ 未自动补 verification / 自动猜 credential / 自动改 SUCCESS

---

## 8. 下一步（等待授权）

建议在**修正后的契约**上运行授权的 **Phase 7 Benchmark**（30 / 50 / 100 任务），实测：
- Resolver `ELEMENT_NOT_FOUND` 率（预期自 80.1% 显著下降）
- `verification=none` 比例（预期自 96.7% 降至 <20%）
- `CREDENTIAL_MISSING` escalation 比例（预期在「正确供给凭据」的场景下归零，仅真实缺凭据时保留升级）

此为修 Agent「感知—执行接口契约」的关键一步，是从 Demo 走向产品的必要前提。
