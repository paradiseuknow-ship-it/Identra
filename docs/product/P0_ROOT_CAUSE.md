# P0 ROOT CAUSE：rw.095 未触发 needsCredentials 短路的完整归因

- 结论先行：**这不是 Fix #1 的实现 bug，而是 `every()` 守卫按设计正确拒绝了混合错误计划**。rw.095 的失败本质是 fixture 固有边界（注册+上传双资源缺失），按你的 P1 规则（"动作非法不能转 CREDIBLE"）它**本来就不应该**转 CREDIBLE。
- 归因性质：**只读调查，零代码改动**。

---

## 1. rw.095 完整事件链（evidence：aiPlannerEvidence.json task_mth91fpfes749，2 条完整记录）

```
task rw.095「长流程扩展3」none / longflow / 注册+资料上传长流程
  → runtime.js:178  resolvePlan(task)
    → planner.planObjective（capability=plan，严格 LLM 路径）
      → attempt 1：DeepSeek 产出 16 步计划
        → validatePlan 拒绝，vr.errors 共 4 条：
           ① steps[6](step_007)  password        是敏感字段，必须用 credentialRef  ✓ 匹配 SENSITIVE_GATE_RE
           ② steps[7](step_008)  confirmPassword  是敏感字段，必须用 credentialRef  ✓ 匹配
           ③ steps[10](step_011) password        是敏感字段，必须用 credentialRef  ✓ 匹配
           ④ steps[14](step_015) upload 文件路径越界：只允许 server\agent\data\uploads 内的相对路径  ✗ 不匹配
      → planner.js:452 `_errs.every(SENSITIVE_GATE_RE)` = false（第④条 upload 越界）
        → 不短路，走普通重试
      → attempt 2：17 步计划，同样 3× 敏感字段 + upload 越界（step_016）
      → attempt 3：同构 ×3，重试耗尽
    → return { ok:false, error:'Plan Schema 校验失败: steps[6]...' }  ← 无 needsCredentials 标记
  → runtime resolvePlan 调用点 throw（'runtime 执行异常: ...'）
  → run() 顶层 catch → FAILED，esc=ENGINEERING_FAILURE
```

## 2. 六个调查问题逐项回答

1. **走哪个 planner path**：`planObjective` 主循环、capability=plan（严格 LLM 路径）。**不是** replan，**不是** repair，**不是** structured 降级。
2. **哪个函数产生 rejection**：`validatePlan`（schema/plan.js）在 planner.js:356 被调用；错误文本组装在 planner.js:443。
3. **为什么没产生 needsCredentials**：短路条件是 `_errs.every(SENSITIVE_GATE_RE)`（planner.js:452，用**完整** vr.errors 数组）。4 条错误中 1 条是 upload 路径越界（非敏感字段类）→ `every()` = false → 正确地不短路。**注意：443 行 lastError 只展示前 3 条，所以日志里看不见第 4 条 upload 错误——这是"看起来像漏网"的直接原因。**
4. **为什么进 runtime 未捕获异常**：重试耗尽后 `return {ok:false, error}`（无 needsCredentials）→ runtime 调用点按普通失败 throw → run() 顶层 catch 转 FAILED。此路径与 Fix #1 设计一致。
5. **其他路径是否有同型覆盖缺口**：
   - `replan`（planner.js:510）内部调 `planObjective` → **已被短路覆盖** ✓
   - `repairPlanner.js` 有独立门（"Repair Plan Schema 校验失败"）→ repair 计划派生自已通过校验的原始计划，不会引入敏感字段字面量，**无缺口**
   - structured 降级路径（planner.js:333 vr0）：结构不可解析时只设 lastError 重试，无短路 → 与主路径**行为一致**（混合错误不升级），非缺口
   - `flowPlanner.js:31` 的 validatePlan 消费 flowMemory 确定性计划（无 LLM 凭据字段生成），**不在风险面**
6. **是否存在第三种敏感字段拒绝入口**：无。报错文案「是敏感字段，必须用 credentialRef」全仓只有 schema/action.js 一处产生（此前已验证）；validatePlan 的 LLM 消费入口只有 planObjective 的两处。

## 3. 语义判定：every() 拒绝 rw.095 是对的

你的 P1 规则明确：**"JSON 非法 / 字段缺失 / 动作非法 / selector 非法 / 未知 schema 错误，都不能转 CREDIBLE"**。

rw.095 的第④条错误（upload 文件路径越界）就是"动作非法"类。它的成因是：任务要求上传文件，但环境没有提供 uploads 资源 → 模型臆造了越界绝对路径。这是**资源缺失型不可满足，不是凭据缺失型**。若把混合错误放行到 CREDIBLE：
- 升级语义错误（用户补了凭据任务照样跑不通——upload 步骤依然无文件可传）
- 且会造成 some() 型误伤：真正不需要登录的任务里偶发的 spurious password 步骤会被错误升级，掩盖本可修复的普通错误

## 4. 是否影响其他场景

| 场景 | 影响 |
|---|---|
| required + 有 credentialRef | 无影响（_hasRefs=true 时短路分支本就不进） |
| 已正常升级的 none+login（纯敏感字段错误） | 无影响（every() 仍为 true） |
| 普通 schema rejection（无敏感字段） | 无影响 |
| mixed（敏感字段 + 其他错误） | 维持 FAILED——与你的规则一致 |

## 5. 候选最小修复点（等你选择，P1 阶段才动代码）

**方案 1（推荐，零代码改动）**：接受 rw.095 = fixture 固有边界（注册+上传双缺失），归类为「不可满足 → 诚实 FAILED」。在 21 项 verification taxonomy 中单列。**成本 0，风险 0。**

**方案 2（可审计性微修，不改语义）**：planner.js:443 的 lastError 从 `slice(0, 3)` 放宽为全部错误（或 5 条）——纯展示修复，让"为什么没短路"在终态错误里自解释。**不改任何判定逻辑，不影响 SUCCESS/FAILED/CREDIBLE 任何语义。** 配 targeted test ×2。

**方案 3（不推荐）**：every → some 放行混合错误。**明确反对此方案**：语义上把资源缺失伪装成凭据缺失，且引入 spurious-password 误伤面。

## 6. 附带发现：token 空转

rw.095 类混合错误会烧满 3 次 planner 重试（每次 16-17 步长计划），结局确定性相同。方案 2 可顺带在重试前对「错误签名集与上次完全相同 + 含敏感字段错误 + 凭据为空」做一次提前收口（仍 FAILED，只是不再空转）——但这是行为改动，超出手方案 2 的"纯展示"范围，**默认不做**，如你需要我再加。

---

**ROOT CAUSE**：`every(SENSITIVE_GATE_RE)` 守卫按设计正确拒绝混合错误；表面"漏网"实为 lastError 只展示前 3 条错误导致的观察偏差。
**MINIMAL FIX POINT**：方案 1（零改动）或方案 2（planner.js:443 展示放宽，1 行）。
**REGRESSION SCOPE**：方案 1 无；方案 2 仅影响终态错误文本长度，零语义影响，双回归应保持 62/0 + 55/0。

等你确认方案后进 P1。
