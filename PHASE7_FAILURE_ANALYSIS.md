# Phase 7 — 失败分析（Step 1：只读，不改代码）

> 数据来源：`.benchmark/phase6_1787687782834.json`（Phase 6 真实 DeepSeek 全量 30 任务运行）
> 明细关联：`server/data/aiTasks.json` `aiSteps.json` `aiAttempts.json` `aiRepairAttempts.json` `aiFailureSnapshots.json` `aiPlannerEvidence.json`
> 关联方法：对每个 phase6 场景，取 `aiTasks` 中 `objective` 精确匹配且 `createdAt` 最大的一条（即最新完整 30 任务运行）。锚定 30 任务，与 phase6 perTask 终态 0 不一致。

---

## 0. 数据概览（Phase 6 真实运行）

| 维度 | 值 |
| --- | --- |
| 任务总数 | 30 |
| SUCCESS | 19（63.3%） |
| HUMAN_ESCALATION | 11（36.7%） |
| 步骤总数（aiSteps） | 153 |
| 动作尝试总数（aiAttempts） | 失败 186 / 总 ~475 |
| 失败 attempt 错误分布 | ELEMENT_NOT_FOUND **149 (80.1%)** ｜ TOOL_EXECUTION 21 (11.3%) ｜ NO_VALUE 16 (8.6%) |
| 含 verification 的步骤 | **5 / 153（3.3%）**，其余 148 步为 `none` |
| Planner schema PASS | 30 / 30（100%） |
| Repair 触发 / 成功 | 18 / **0（0%）** |
| 失败快照 errorType | ELEMENT_NOT_FOUND 4 ｜ CREDENTIAL_MISSING 5 ｜ UNKNOWN 1 ｜ NAVIGATION_FAILED 1 |

**一句话结论**：瓶颈不是 Planner 语法、不是 Runtime 引擎、不是 Observation 缺数据，而是 **Semantic Resolver 无法把 LLM 生成的语义/字段目标解析到真实 DOM**（占失败 80%），叠加 **Planner 几乎不产出验证步骤**（96.7% 无验证）与 **Recovery 永远失败（0%）**。

---

## Failure Classification

### 1. Planner Failure

- **缺少 verification step（主导）**：153 步骤中仅 5 步带 verification（`action_success`），**148 步为 `none`（96.7%）**。Phase 6 报告里的 "Verification Accuracy = 100%" 是**误导性指标**——它只对那 5 步生效，其余 25/30 任务根本没有验证。本质是 Planner 不产出自检步骤，导致成功/失败无法判定，失败只能靠重试耗尽才升级。
- **目标形状不可解析（次主导，根因放大器）**：失败 attempt 的 `target` 几乎全是 `{"semantic":"搜索输入框"}` / `{"semantic":"密码输入框"}` / `{"semantic":"角色下拉框"}` 这种**纯中文自然语言描述，无 `field` 机器键**。Semantic Resolver 没有权威定位锚点，只能做模糊中文匹配 → 大面积 `ELEMENT_NOT_FOUND`。
- **错误 action / 参数错误 / 目标理解错误**：schema PASS 100%，未发现明显"动作类型选错"；参数层问题已并入上面的目标形状与 Execution 类。

### 2. Observation Failure

- **结论：本类不是瓶颈（重要诚实发现）**。失败快照的 `visibleTexts` **确实包含正确文本**，例如：
  - `saas/login.html` → `vis=CloudSaaS 控制台 企业邮箱 密码 登录 数据看板 本月活跃用户：12,480`
  - `ecommerce/search.html` → `vis=搜索 购物车：0 件`
  - `admin/users.html` → `vis=新增用户 用户名 邮箱 角色 viewer editor admin 创建用户`
  即 **DOM 文本充足、Observation 已采集到所需信息**，问题在"已有文本→元素定位"的解析环节，而非 Observation 缺失。
- 不统计为 Observation Failure 的子项（element not found / textSummary 缺失 / DOM 不足）在此数据集中均不成立。

### 3. Semantic Resolver Failure

- **主导失败类（80%）**：149 个 `ELEMENT_NOT_FOUND` 失败 attempt 的根因是 resolver 解析失败。典型错误：
  - `未找到输入目标: 搜索输入框`、`未找到输入目标: email`、`未找到输入目标: password`、`未找到输入目标: username`
  - `未找到动作按钮: 搜索表单`（submit 的 semantic 描述也解析不到）
- **修复尝试同样失败**：repair `SEMANTIC_RELOCATE` 的确定性回退（`尝试语义 email/password/username/name/first name/last name`）**全部 ok=false** —— 因为底层 resolver 逻辑本身无法匹配，换字段名也救不回。
- **根因**：resolver 对中文语义标签（"搜索输入框"）和 field 键（email/password）都缺乏有效匹配；且**只依赖单一 selector/标签匹配，无多信号回退**（placeholder / aria-label / name / 邻近文本 / 标签-控件关联）。实际 DOM 中搜索框的 placeholder 可能是"搜索商品"而非"搜索输入框"，子串匹配即失败。
- 注：少数任务（ecommerce.search / lazy_recovery / real.ec.usb）的 fill **成功**，说明 resolver 并非 100% 坏，而是**间歇性/对特定标签敏感**——进一步指向"匹配规则不够鲁棒 + 可能基于陈旧 observation"，而非彻底失效。

### 4. Execution Failure

- 失败 attempt 按动作类型：`fill 140` ｜ `select 25` ｜ `navigate 10` ｜ `click 6` ｜ `submit 2` ｜ `reload 3`。
- 其中 `fill(140)+select(25)=165` 本质是 **#3 Semantic Resolver 失败的症状**（元素没解析到，fill 自然失败），不应单独归因到执行引擎。
- **执行引擎自身的真实错误**仅有：`TOOL_EXECUTION 21` + `NO_VALUE 16` = **37 次（占失败 19.9%）**——即元素取到但「值未写入 / 工具执行异常」。
- 代表样本：`submit target={"semantic":"搜索表单"}` → `ELEMENT_NOT_FOUND`；`select target={"semantic":"角色下拉框"}` → `UNKNOWN` 错误。

### 5. Verification Failure

- **验证引擎本身的 false positive / false negative：0**。仅 5 步有验证且全部准确（ecommerce.search / lazy_recovery / real.ec.usb 的 text_present / page_change 均正确）。
- **真正的缺陷是"覆盖率缺失"而非"引擎错误"**：25/30 任务 verificationTotal=0。这是 Planner 不产验证（见 #1）的下游表现，不是 verification 模块算错。
- 因此本类结论：**Verification 引擎可用，但被 Planner 架空**；Phase 6 的 100% 准确率指标因样本过小而失真。

### 6. Recovery Failure

- **Repair 触发 18 次，成功 0 次（0%）**——这是 Recovery Success Rate 低（Phase 6 报 45%，但那只是"触发恢复的任务中终态 SUCCESS 的比例"，repair 动作本身 0 成功）的直接原因。
- 策略分布：`SEMANTIC_RELOCATE 15`（全败）｜ `RELOAD_OR_BACK 3`（全败）。
- **Retry 耗尽原因两类**：
  1. `SEMANTIC_RELOCATE` 上限（6 任务）：add_to_cart、search_changed、admin.create_user、failure.element_changed、real.ec.cart，以及 network_failure（RELOAD_OR_BACK）。resolver 修不好 → 必耗尽。
  2. `REAUTH_OR_PAUSE 风险 HIGH`（5 任务）：saas.login_dashboard、saas.login_failure、real.saas.login、real.saas.export、real.admin.admin。这是**风险策略把"密码/凭据填充"判为 HIGH 直接升级人工审批**，并非真实能力失败。
- **Root Cause**：① recovery 复用了同一套破损的 semantic 解析，无法产生新 locator；② 策略层不对错误类型分治，合法凭据填充被过度升级；③ 无"refresh observation → resolver 重搜 → alternative locator → planner repair → retry"的阶梯式路径。

---

## 汇总表：Failure Type / Count / Percentage / Representative Tasks / Root Cause / Recommended Fix / Expected Impact

> 计数基准：执行层失败以 **186 个失败 attempt** 为主；Planner/Policy/Recovery 类同时给出任务级视角。

| # | Failure Type | Count | Percentage | Representative Tasks | Root Cause | Recommended Fix（Step 2 提案，未实施） | Expected Impact |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **Semantic Resolver — ELEMENT_NOT_FOUND** | 149 attempts | **80.1%** | ecommerce.add_to_cart, search_changed, failure.element_changed, real.ec.cart, saas.login*, admin.create_user, real.admin.admin | resolver 无法将中文语义标签/field 键映射到 DOM，且单信号匹配无回退 | 升级 `semanticResolver`：placeholder/aria-label/name/邻近文本/标签-控件关联多信号回退；并以 `field` 机器键为权威定位 | **直接消除 80% 失败** |
| 2 | **Planner — Missing Verification** | 148 / 153 steps | 96.7% | 全部 30 任务 | DeepSeek 计划几乎不产出 verification 步骤 | Planner contract 强制每步 verification（text_present / page_change / action_success）；缺则判 schema FAIL | 验证覆盖率→~100%；使成功/失败可判定，减少误升级 |
| 3 | **Planner — Unresolvable Target Shape** | ~149 attempts 溯源 | — | 同上 | LLM 只输出 `semantic` 中文描述，无 `field` 键，resolver 无锚点 | Planner 输出 `{field, semantic}` 双键；`field` 为权威定位键，semantic 仅辅助 | 配合 #1 根治 ELEMENT_NOT_FOUND |
| 4 | **Execution — engine errors** | 37 attempts | 19.9% | submit/select 类 | 元素取到但值未写入(NO_VALUE)/工具异常(TOOL_EXECUTION) | Executor 执行前 Observe→Confirm→Execute→Verify；fill 后读 value 回写校验 | 消除 20% 残余执行错误 |
| 5 | **Recovery — Repair 0% success** | 18 / 18 | 100% fail | 全部 11 升级任务 | SEMANTIC_RELOCATE 复用破损解析必败；RELOAD 对不可恢复直接耗尽 | 按 errorType 分策略：ELEMENT_NOT_FOUND→refresh obs→resolver 重搜→alt locator→planner repair→retry；差异化阶梯 | 恢复成功率 0%→目标 ≥70% |
| 6 | **Policy — REAUTH over-escalation** | 5 tasks | 16.7% of tasks | saas.login_dashboard, saas.login_failure, real.saas.login, real.saas.export, real.admin.admin | 密码/凭据填充被风险策略判 HIGH→人工审批，非真实能力失败 | 当填充密码是任务明确目标且站点为已知 fixture 时降为 MEDIUM/LOW | 升级率 36.7%→~20%（11→6） |
| 7 | **Config — CREDENTIAL_MISSING** | 5 snapshots | — | real.admin.admin 等 | benchmark 未绑定凭据引用 | 测试夹具预置 credential / 任务显式提供凭据 | 消除该类假失败 |

---

## 80/20 判定（Step 2 只改造成 80% 失败的问题）

- **第一杠杆（~80% 失败）**：`#1 Semantic Resolver` + `#3 Planner target shape` + `#2 Planner verification`。
  这三项是同一根因链：LLM 用中文语义描述目标 → resolver 解析不到 → fill 失败 → 无验证 → 重试耗尽升级。**只需在 resolver 增加多信号回退 + planner 强制 field 双键与 verification，即可消灭绝大多数失败。**
- **第二杠杆（升级率）**：`#6 Policy` 把 5 个合法密码填充任务误升级，单独修复即可让升级率从 36.7% 降到 ~20%（达标线）。
- **不建议本阶段做**：大规模重写 runtime / 新增大系统 / 为通过测试加规则。Recovery 升级（#5）跟随 resolver 修复自然受益，无需单独大改。

---

## 待确认后进入 Step 2

以上为**纯数据诊断，未修改任何产品代码/基准**。Step 2 拟修改范围（供确认）：

1. `server/agent/semanticResolver.js` — 多信号回退 + `field` 权威键（最大收益）
2. `server/agent/planner.js` + `schema/` — planner contract：强制 verification、输出 `{field, semantic}`
3. `server/agent/tools.js` / runtime — Executor 执行前 Observe→Confirm→Execute→Verify（仅针对 #4 的 20%）
4. 风险策略 — 合法凭据填充降风险等级（针对 #6）

禁止项均遵守：未改 benchmark 统计方式、未改成功标准、未降 verification 要求、未 mock 成功、未 attachPlan 绕过 LLM、未碰 E4/fingerprint 冻结区、未删失败样本。
