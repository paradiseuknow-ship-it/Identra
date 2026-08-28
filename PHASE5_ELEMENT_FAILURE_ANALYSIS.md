# Phase 5 — Execution Failure Deep Analysis

> 只读分析。目标：对 Phase 4 一级 `Execution Failure Taxonomy` 中归为 **`ELEMENT_NOT_FOUND`（29/39，74%）** 的案例做二级 taxonomy 拆解，定位「元素为何未找到」的根因分布，为后续修复排期提供证据。
>
> **本阶段不修改任何执行能力**：未改 planner / resolver / selector 策略 / retry / benchmark / success definition。所有结论均来自既有 runtime 遥测（`.benchmark/phase3_live_raw_store`）与 Phase 4 分析产物，无重跑、无 mock、无手工修正。

---

## 1. 二级 Taxonomy 定义与判定规则

二级分类 `E1–E7` 在「元素未找到」这一既成事实之下，按 **observable runtime 信号** 做确定性判定。规则按优先级短路（命中即归该级），并在输出中附带 `confidence` 与 `reasons` 以便审计。

| 级 | 名称 | 定义 | 判定信号（命中即归该类） | 置信 |
|----|------|------|--------------------------|------|
| **E1** | selector 失效 | 选择器/验证表达式本身脆或错，但元素在 DOM 中实际可定位 | 后续 `reload/wait` 后同元素填充成功（`laterSuccessFill`） | 0.8 |
| **E2** | 页面未 ready | 页面/SPA 未挂载或仍在加载，查询时 DOM 为空 | 快照可见文本为空（`blankSnap`）或含「加载中/loading」 | 0.8 / 0.7 |
| **E3** | iframe / shadow DOM | 目标位于 iframe / shadow root，主文档查询无法命中 | 快照/错误/选择器含 `iframe/shadow/contentDocument/#document` | 0.8 |
| **E4** | dynamic loading | 元素需异步/条件渲染，当前页已渲染但该元素未产出 | 页面有内容、无后续成功、选择器为 CSS/结构式（非语义） | 0.6 |
| **E5** | semantic resolution 错误 | 语义/上下文解析错位：落到错误页面或解析到错误目标 | 快照页面类型与任务意图冲突（`wrongPage`），或目标为语义描述但页面已渲染却缺失 | 0.65–0.7 |
| **E6** | permission / auth 导致隐藏 | 受保护元素被登录墙/鉴权拦截替换 | 快照为登录/鉴权拦截态（邮箱或密码错误/401/403/权限） | 0.85 |
| **E7** | unknown | 证据不足，无法归入 E1–E6 | 兜底 | 0.5 |

**信号来源字段**（均只读）：
- `aiAttempts.error.message` → 提取失败选择器（`element_present="..."` 或 `未找到元素 "..."`）
- `aiAttempts.status` / `action.type` / `action.verification.expect` → 动作与目标
- `aiFailureSnapshots.visibleTexts` → 页面可见文本（判定登录墙 / 空白 / 商品页 / 下载页 / 注册页）
- `aiEvents`（类型 `agent.diagnosing` / `ai.verification.decision`）→ 诊断类别与 VIL `failureType`
- `aiRepairAttempts.strategy` → 修复策略

---

## 2. 分布统计

| 级 | 名称 | 数量 | 占比 | 预计修复收益（估算） | 修复方向（仅 Phase 6 参考，本阶段不动） |
|----|------|------|------|----------------------|------------------------------------------|
| **E1** | selector 失效 | 5 | 17.2% | **5/5 可恢复**（元素实际可定位） | 验证/定位选择器鲁棒化：去除 `[value=]` 等脆属性、语义回退到稳定选择器 |
| **E2** | 页面未 ready | 3 | 10.3% | **3/3 大概率可恢复** | wait-for-ready / SPA 挂载等待 + 退避重试 |
| **E3** | iframe / shadow | 0 | 0% | 0 | 本数据集无证据；跨上下文定位能力（如需） |
| **E4** | dynamic loading | 3 | 10.3% | **2–3/3 可恢复** | 等待条件/异步渲染完成后再定位 |
| **E5** | semantic resolution 错误 | 18 | 62.1% | **高收益，但需导航/上下文能力修复**（其中 4 例根因为认证） | 页面状态/上下文感知 + 语义→稳定选择器映射；SaaS 子集需会话预置 |
| **E6** | auth 导致隐藏 | 0 | 0% | 0（见 §4 说明） | — |
| **E7** | unknown | 0 | 0% | 0 | — |
| | **合计** | **29** | 100% | | |

> **「预计修复收益」为只读估算**，量化口径：在不改变既有能力约束下，若针对该类根因引入修复，理论上可翻转的 FAILED/CANCELLED 数。E5 占比最高，是后续修复的**最高杠杆点**，但其修复往往涉及导航/页面状态感知（需 Phase 6 明确授权）。

### 观察状态交叉分布（元素缺失时页面处于什么状态）
- SaaS 登录/控制台页（邮箱或密码错误）：5（均为 E1）
- 电商商品列表页（戴尔/LG 等）：17（均为 E5）
- 空白页（SPA 未挂载）：3（均为 E2）
- 资源下载页：3（均为 E5）
- 电商搜索/空结果页：4（E4×2、E5×2）
- 会员注册表单页：1（E4）

---

## 3. 逐 case 明细（29/29）

### E1 — selector 失效（5）

| task id | action | target | resolver 结果 | observation 状态 | failure evidence | 分类 |
|---------|--------|--------|---------------|------------------|------------------|------|
| task_mtbqbbfazxbgb (P9 SaaS搜索1) | fill | `input[name='username'][value='admin']` | 后续 reload 后填充成功（元素可定位） | SaaS 登录页（邮箱或密码错误） | `required unmet … → 未找到元素 "…[value='admin']"`；diag=VERIFICATION_FAILED/ELEMENT_CHANGED | E1 |
| (P9 SaaS建项目1) | fill | `username` | 后续 reload 后填充成功 | SaaS 登录页 | `element_present="username" → 未找到元素` | E1 |
| (P9 SaaS改设置2) | fill | `用户名输入框` | 后续 reload 后填充成功 | SaaS 登录页 | `element_present="用户名输入框" → 未找到元素` | E1 |
| (P9 库存修改3) | inspect | `库存输入框` | 后续 reload 后填充成功 | 电商搜索空页 | `element_present="库存输入框" → 未找到元素` | E1 |
| (P9 SPA多页4) | fill | `username` | 后续 reload 后填充成功 | SaaS 登录页 | `element_present="username" → 未找到元素` | E1 |

### E2 — 页面未 ready（3）

| task id | action | target | resolver 结果 | observation 状态 | failure evidence | 分类 |
|---------|--------|--------|---------------|------------------|------------------|------|
| (P9 动态DOM1) | navigate | `搜索框` | 快照为空，DOM 未挂载 | 空白页 | `element_present="搜索框" → 未找到元素` | E2 |
| (P9 动态DOM3) | navigate | `搜索框` | 快照为空，DOM 未挂载 | 空白页 | `element_present="搜索框" → 未找到元素` | E2 |
| (P9 动态DOM4) | navigate | `search input` | 快照为空，DOM 未挂载 | 空白页 | `element_present="search input" → 未找到元素` | E2 |

### E4 — dynamic loading（3）

| task id | action | target | resolver 结果 | observation 状态 | failure evidence | 分类 |
|---------|--------|--------|---------------|------------------|------------------|------|
| (P9 商品编辑5) | inspect | `category` | 始终未定位 | 电商搜索空页 | `element_present="category" → 未找到元素` | E4 |
| (P9 库存修改5) | inspect | `threshold` | 始终未定位 | 电商搜索空页 | `element_present="threshold" → 未找到元素` | E4 |
| (P9 批量输入5) | inspect | `form` | 始终未定位 | 会员注册表单页 | `element_present="form" → 未找到元素`（页面确有表单） | E4 |

### E5 — semantic resolution 错误（18）

| task id | action | target | resolver 结果 | observation 状态 | failure evidence | 分类 |
|---------|--------|--------|---------------|------------------|------------------|------|
| (P9 SaaS数据查看2) | inspect | `report-list` | 始终未定位 | 电商商品列表页 | `element_present="report-list" → 未找到元素` | E5 |
| (P9 SaaS数据查看3) | inspect | `member-list` | 始终未定位 | 电商商品列表页 | `element_present="member-list" → 未找到元素` | E5 |
| (P9 SaaS数据查看4) | inspect | `order-list` | 始终未定位 | 电商商品列表页 | `element_present="order-list" → 未找到元素` | E5 |
| (P9 SaaS数据查看5) | navigate | `list.html` | 始终未定位 | 电商商品列表页 | 无 VERIFY_FAILED（diag=ELEMENT_NOT_FOUND） | E5 |
| (P9 订单查询1) | inspect | `input[type='search'],…` | 始终未定位 | 电商商品列表页 | `element_present="input[type='search']…" → 未找到元素` | E5 |
| (P9 订单查询3) | navigate | `list.html` | 始终未定位 | 电商商品列表页 | 无 VERIFY_FAILED（diag=ELEMENT_NOT_FOUND） | E5 |
| (P9 订单查询4) | inspect | `订单详情链接或按钮` | 始终未定位 | 电商商品列表页 | `未找到元素 "订单详情链接或按钮"` | E5 |
| (P9 订单查询5) | inspect | `status` | 始终未定位 | 电商商品列表页 | `element_present="status" → 未找到元素` | E5 |
| (P9 状态更新1) | inspect | `订单列表中的更新按钮` | 始终未定位 | 电商商品列表页 | `未找到元素 "订单列表中的更新按钮"` | E5 |
| (P9 状态更新2) | navigate | `list.html` | 始终未定位 | 电商商品列表页 | 无 VERIFY_FAILED（diag=ELEMENT_NOT_FOUND） | E5 |
| (P9 状态更新3) | inspect | `退款订单状态元素` | 始终未定位 | 电商商品列表页 | `未找到元素 "退款订单状态元素"` | E5 |
| (P9 状态更新4) | inspect | `订单列表中的订单项` | 始终未定位 | 电商商品列表页 | `未找到元素 "订单列表中的订单项"` | E5 |
| (P9 状态更新5) | inspect | `订单行或签收按钮` | 始终未定位 | 电商商品列表页 | `未找到元素 "订单行或签收按钮"` | E5 |
| (P9 文件上传2) | inspect | `input[type=file]` | 始终未定位 | 资源下载页 | `未找到元素 "input[type=file]"` | E5 |
| (P9 文件上传4) | inspect | `input[type='file']` | 始终未定位 | 资源下载页 | `element_present="input[type='file']" → 未找到元素` | E5 |
| (P9 文件上传5) | inspect | `input[type=file]` | 始终未定位 | 资源下载页 | `未找到元素 "input[type=file]"` | E5 |
| (P9 多步确认3) | inspect | `register` | 始终未定位 | 电商搜索空页 | `element_present="register" → 未找到元素` | E5 |
| (P9 长流程扩展4) | inspect | `筛选控件` | 始终未定位 | 电商搜索空页 | `未找到元素 "筛选控件"` | E5 |

---

## 4. 关键发现

1. **E5 主导（18/29 = 62%）**——「元素未找到」的主要根因不是选择器本身，而是 **导航/上下文解析错位**：agent 实际落在了与任务意图不符的页面（商品列表页、资源下载页、商城搜索空页），目标元素在该上下文中根本不存在。这是后续修复的**最高杠杆点**，但修复通常需页面状态/上下文感知与语义→稳定选择器映射能力（超出本阶段只读范围）。

2. **E5 中 4 例（SaaS数据查看 2/3/4/5）根因在认证**：SaaS 应用登录返回「邮箱或密码错误」（mock 凭证问题），agent 未能进入 SaaS 控制台，退而落在公开商品页。这 4 例在元素层表现为 E5，但**业务根因属 E6（auth 导致隐藏）**。Phase 6 若修正 benchmark 凭证或预置真实会话，可直接回收这 4 例而不必改动 agent 能力。

3. **E1 仅 5（17%）**——验证/定位选择器脆性（`[value='admin']` 属性选择器、松散 `username`、语义名 `用户名输入框`）。这 5 例元素**实际可定位**（后续 reload 后 fill 成功），纯属验证表达式与实时 DOM 不匹配。修复成本最低、收益确定。

4. **E2 3（10%）**——动态 DOM 任务快照为空白页（SPA 未挂载/未就绪即查询）。属等待/就绪类问题。

5. **E4 3（10%）**——`category`/`threshold`/`form` 等条件/结构元素在当前页已渲染但未产出，依赖数据或状态（如未选中商品时库存输入框不出现）。

6. **E3 / E7 无证据**——本数据集未观察到 iframe/shadow DOM 上下文问题，也无证据不足案例（所有 29 例均可由 E1–E5 解释）。

---

## 5. 范围与合规声明

- ✅ 仅读取既有 runtime 遥测与 Phase 4 产物；新增 `server/scripts/analyze_phase5.js`（只读分析器，产出 `.benchmark/phase5_element_failure_analysis.json`）。
- ✅ 未修改 planner / resolver / selector 策略 / retry / benchmark / success definition / Evidence 评分逻辑。
- ✅ 未重跑 benchmark、未启动 beta、未自动发布/上线。
- ⛔ **本阶段止于分析**。未进入修复阶段，所有「修复方向」仅为 Phase 6 的排期输入。

**等待下一步授权**（如进入 Phase 6 修复，需明确授权，且应遵守本阶段冻结边界之外的修复约束）。
