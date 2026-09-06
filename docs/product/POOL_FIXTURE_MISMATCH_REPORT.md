# 池任务 objective↔fixture 错配归因报告（候选② 取证结论）

日期：2026-09-01 ｜ 前置：dl240 基线（Business Success 66%）之后，原候选②「scraping/search 列表类验证契约对齐」

## 0. 一句话结论

**原假设「ESC 30% 主构成 = C 类列表渲染/懒加载验证契约边界」被证伪。**
主根因是 **B 类池生成缺陷**：`genRealWorldScenarios.js` 生成 objective 模板与 fixture 内容从未对齐。
**全池 100 任务中 43 个 objective 引用了 fixture 上根本不存在的资源**（机械审计 + 逐 fixture 人工复核）。
dl240 中这 43 个任务的终态：**SUCCESS 19（假阳性）+ ESC/VERIFY_RETRY 14（诚实失败）+ CREDIBLE 8 + ENGINEERING 2**。

## 1. 审计方法与工具

- 新增只读审计脚本 `server/scripts/audit_pool_fixture_alignment.js`（**不参与回归套件、不改池、不改 runtime**）：
  对每个任务，取 objective 中的资源名词词典（订单/报表/成员/库存/结算/购物车/项目…共 34 词）+ id 改名契约，比对 fixture HTML 全文（含 JS 字符串量）。
- 粗筛命中 49 → 人工逐 fixture 复核剔除 6 个灰区假阳性：
  - rw.034（search.html 空结果搜索仍可执行）、rw.064/065（form.html 数据描述型目标）、rw.081/085（search_lazy 结果文本回显任意 query）、rw.089（导出 CSV 按钮存在，半匹配）。
- **最终：43 个真实错配任务**。

## 2. 错配三大源头（生成期缺陷，非运行期缺陷）

| 源头 | 证据 | 任务 |
|---|---|---|
| ① objective 模板数组硬绑 fixture，两套模板独立编写 | `genRealWorldScenarios.js` L40-70：`saasData`（报表/成员/订单/日志）与 `ecOrder`/`ecStatus`（订单查询/状态更新）均硬编码 `fixture: 'scraping/list.html'`，而该 fixture 实为「比价网·显示器榜单」只读列表 | 14 个 |
| ② objective 声称的页面状态与 fixture 不符 | rw.082「搜索框（**id 已改为 query**）」但 `search_lazy.html` 实际 `id="q"`，从未改过 | 1 个 |
| ③ saas/login.html 登录后仅「数据看板 + 导出 CSV」，post-login objective 无对应资源 | rw.003 项目列表 / rw.006 通知 / rw.009 成员 / rw.015 账单搜索 / rw.016-020 新建项目 / rw.021 关闭通知 | 13 个 |

其余错配：ecommerce/search.html 上的 编辑/库存/详情/结算/地址/看板 类目标（页面只有 搜索框+加入购物车+购物车计数，目录仅 3 商品）、download.html 无上传头像、scraping/list 上的 14 个订单/报表目标。

## 3. 对 dl240 基线的双口径修正

### 3a. 向下修正（假阳性 SUCCESS）

43 个错配任务中 **19 个判 SUCCESS**。假阳性机制（代码级实证）：

- `observe`/`extract` 类动作不在 `contract.js ACTION_TO_STATE`（DERIVABLE）集合 → `deriveContract` 返回 null → 非关键业务动作 → **无 outcome 契约时执行成功即 SUCCESS**（verification.js `buildEffectiveVerification` 回退路径）。rw.027-030「查看报表/成员/订单/日志」即此形态：页面加载成功 + observe 成功 → SUCCESS，目标资源从未存在。
- 池里的 `expectedVerification`（如 text_present「订单信息可见」）**从不被消费**（验证只看 planner 产出的 expectedBusinessState/推导契约）——池级期望是摆设，这掩盖了生成期错配。

### 3b. 向上修正（真实能力口径）

- 真实可满足分母 = 100 − 43 = **57**。
- 真实可满足任务上的 SUCCESS = 66 − 19 = **47 → 修正口径成功率 ≈ 82.5%**（vs 名义 66%）。
- ESC 30 构成修正：**14 个 = 结构性不可满足的诚实失败**（agent 正确报告找不到订单/编辑/结算资源，重试耗尽后 ESC——行为正确，任务不可解）；真实 agent 能力缺口候选仅 **rw.094 / rw.083 等 ~2-4 个**。

### 3c. 双口径表述（建议报告口径）

> 名义 Business Success 66%（含 ~19pp 目标资源不存在的假阳性）；结构性不可满足任务 43% 单列后，真实可满足任务成功率 ≈ 82%，其中诚实升级（CREDIBLE+结构性 ESC）占错配任务的 51%（22/43）。

## 4. 纪律边界（本次未做）

- **未改池**（冻结池，重生成 = 基线不可比，需授权）。
- **未改 runtime/验证/成功定义**（observe 无契约回退是既有设计；修它=改 Success Definition，红线）。
- **未建 planner 短路**（「objective 与页面资源匹配」无法机械判定，臆造守卫反而引入 A3 同类风险）。

## 5. 下一步候选（均需授权）

- **A. 池 v2 对齐重生成**：`genRealWorldScenarios.js` 按「fixture 能力清单」生成 objective + 生成期对齐 lint（审计脚本逻辑前移到生成期断言）→ 重跑基线（历史基线不可比，作为新基线 v2）。
- **B. 口径固化（零代码）**：把审计清单固化为分析工具输入，`analyze_phase12.js` 增加双口径输出（名义 + 剔除结构性不可满足），历史数据立即可重解读。
- **C. 真实能力缺口专项**：rw.094（搜索+加购+购物车计数页面能力齐全仍 ESC）/ rw.083（懒加载恢复路径）小样本取证——唯一剩下的真实 agent 能力问题。

## 6. 交付物

- 审计工具：`server/scripts/audit_pool_fixture_alignment.js`（只读）
- 本报告：`docs/product/POOL_FIXTURE_MISMATCH_REPORT.md`
- 证据：dl240 产物 `.benchmark/phase12_tag_fixes_baseline_dl240_1788229276002.json` + `phase12_pool.json` + `mock-site/*.html`
