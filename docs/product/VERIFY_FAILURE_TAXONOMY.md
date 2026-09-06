# VERIFY_FAILURE_TAXONOMY — Final100 21 个 VERIFY_RETRY 只读归因（2026-09-01）

口径说明：机器分类（escalationClass 五分类）权威口径为 **VERIFY_RETRY=21、REAL=0**
（`phase12_100task_1788181819049.json` summary.escalationClasses）。
「REAL 15 + VERIFY_RETRY 6」为此前人工归因口径，本表以 21 个机器 VERIFY_RETRY 为全集。

证据：`server/data/aiTasks|aiSteps|aiAttempts.json`（最终 run 时间窗）→
聚合导出 `.benchmark/p2_verify21_evidence.json`。

## 总体结论（回答核心问题）

> **21 个中，没有 1 个能证明「Agent 实际已完成业务但 observation/selector/readiness 没捕获」。**
> 深查的样本（rw.099/094/038/092/076/082/065/097/079/008）显示：卡点步骤的业务前提普遍**真实未达成**
> （关键词从未输入、selector 不存在、fixture 无该资源），或验证契约**先天不可满足**（planner 臆造）。
> 「4 FAIL + 6 SUCCESS 仍升级」的表象来自 repair 通道的 `action_success` 降级口径，
> 与 step 收口的业务证据复核脱节 —— 是**状态口径自相矛盾**，不是「完成了没捕获」。

## 分布（21 = A1×1 + A2×2 + A3×12 + B1×5 + B2×1）

### A. Planner 契约缺陷型（15）——卡点 = 计划生成的证据契约不可满足

**A1. navigate 冒充 fill（1）**
- rw.099（铁证）：step_001 描述「在搜索框中输入商品关键词」，实际 action=**navigate**，
  verification=`element_present input#q`（输入框存在即过，值从未输入）→ step_002 点击搜索时
  `q` 为空 → fixture `search.html` 的 `if (q) render(q)` 跳过渲染 → `text_present "机械键盘"` 永假
  → 4 次 VERIFY_FAILED + 3 轮 repair 重点 6 次（action_success 口径 SUCCESS）→ 升级。
  **业务真未完成**（搜索从未发生）。
- 候选修复：schema/守卫层拒绝「描述含输入/填写语义但 action=navigate」的计划。

**A2. 中文语义文本当 element_present selector（2）**
- rw.094：`element_present expect="商品列表容器"`（页面无此 selector，永不匹配）；
- rw.055：同型。
- 候选修复：planner 证据契约必须从页面元素清单取 selector（prompt 已注入清单但 evidence 生成未约束）。

**A3. 臆造 selector / 臆造 UI 文案 / fixture 无资源（12）**
- rw.065（`id=regForm` 非法 CSS 语法）、rw.082（`query`，实际是 `#q`）、rw.079（`productSpecs`）；
- rw.097（`text_present "购物车：1 件"`——fixture 实际只写数字进 cart 文本）、rw.076（搜「耳机」，
  CATALOG 无此商品→「未找到相关商品」forbidden 命中）；
- rw.038/041/050/052/054（「编辑按钮/库存输入框/订单筛选/订单列表/物流入口」——
  fixture `ecommerce/search.html` 是 C 端商城页，不存在管理后台元素）；
- rw.092（`url_contains "cart"`——SPA 无路由跳转，URL 类证据在 SPA 恒假，同 P3 已知结论）。
- 性质：与 C 类边界（登录前无法预知登录后内容 → 臆造）同根：**planner 在无元素清单依据处臆造契约**。
- 候选修复：evidence 生成时强制引用页面元素清单/可见文本白名单；fixture 边界部分属池标注缺陷，记边界不修码。

### B. 执行/框架工程型（6）——非 planner、非业务

**B1. PENDING 残留 / 计划版本对账缺陷（5）**
- rw.005/007/060/061/075：报错「任务完成但存在未成功步骤 [step_XXX(PENDING)]（N/N 成功）」。
  所有已执行步骤全 SUCCESS，但存在从未执行也从未取消的 PENDING 步骤（replan 后旧版本步骤
  未被收口，或计划步骤数 > 执行窗口）。**工程缺陷（状态对账），不是业务失败。**
- 候选修复：replan/收口时对旧版本步骤做 CANCELLED/SKIPPED 对账。

**B2. harness deadline 截断（1）**
- rw.008：120s per-task deadline 到期（多步 SPA 组织切换），后段步骤 PENDING+HEALING。
  归 TIMEOUT 工程口径（与 smoke 中 rw.063/091 同款），非 product 失败。

## 对「候选修复授权范围」的映射（全部待授权，本轮未实施）

| 修复 | 类型 | 预期挽回 |
|---|---|---|
| evidence 生成约束（selector/文案必须来自页面清单） | planner 契约 | A2+A3 ≈ 14 任务的主要损失 |
| navigate 冒充 fill 守卫 | planner 契约/schema | A1 |
| PENDING 收口对账 | 执行层工程 | B1 = 5 任务 |
| repair `action_success` 与 step 收口口径统一（矛盾状态消除） | 执行层工程 | 表象消除 + 可观测性 |
| semantic ready wait / observation timing | 执行层 robustness | 收益有限（同步渲染 fixture 已证明时序非主因） |

## 明确不建议

- 不放宽 SUCCESS / 不改 verification 语义 / 不把 VERIFY_FAILED 转 SUCCESS（21 个中无「误判失败」证据）。
- 不大规模重写 planner —— 缺口集中在 evidence 契约生成一个点，可最小化修复。

## 深查样本明细

逐任务卡点 action/verification/expectedBusinessState/attempts 明细见
`.benchmark/p2_verify21_evidence.json`（21 任务 × step 序列 + 错误原文）。

---

## 修复状态更新（2026-09-01，Fix A/B 落地后）

| 类别 | 数量 | 状态 |
|---|---|---|
| A3 非法 CSS 形态（id=regForm 子集） | 部分 | ✅ Fix A schema 守卫 + 三处 prompt 同步（确定性子集） |
| A3 臆造语义元素/文案 | 其余 | C 类边界保持（prompt 契约缓解，不做语义层修复） |
| B1 PENDING 残留 | 5 | ✅ Fix B：根因=replan 步骤 id 冲突（非计划版本对账），已修复并实证（rw.005 smoke SUCCESS） |
| A1 navigate 冒充 fill | 1 | ✅ Fix A1：schema 守卫（组合动词短语模式 + part 级导航宾语逃逸）+ 三处 prompt 同步；rw.099 smoke 实证 planner 正确拆为 navigate+fill 且 fill SUCCESS |
| A2 中文语义当 selector | 2 | prompt 契约缓解（守卫不可确定性判定语义存在性） |
| B2 deadline | 1+ | 工程口径，harness deadline 可配置化待授权（rw.099 smoke step_004 观察步骤亦被 120s 截断） |

详见 P2_FIX_A_B_REPORT.md。回归 65/0 + OK=58/BAD=0；smoke 关键标记（PENDING 残留/守卫拒绝/JSON 解析失败/凭据串线）全部归零。
