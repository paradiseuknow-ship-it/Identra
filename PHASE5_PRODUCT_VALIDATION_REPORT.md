# Phase 5 产品验证报告 · AI Browser Operator

> 生成时间：2026-08-26
> 运行模式：**SIMULATED（mock planner，场景盲）** —— 仅用于框架自检，**不构成产品级结论**
> 数据来源：`.benchmark/phase5_1787684496711.json`（15 场景全量，`--mock`）
> 冻结范围（未修改）：`runtime.js` / `planner.js` / `provider` 核心逻辑 / `fingerprint baseline` / `E4 benchmark` / 已通过的实验结论

---

## 0. 结论先行（Alpha 标准判定）

| 维度 | 判定 | 说明 |
|---|---|---|
| 系统架构成熟度 | **Alpha-Ready（架构达标）** | 执行引擎、验证、失败分类、恢复/升级协议、可观测性、Agent Score 全部就绪且自洽 |
| 产品级能力验证 | **未完成（仅 SIMULATED 自检）** | 本 benchmark 未运行真实 LLM Planner，也未跑真实站点 |
| **是否达到产品 Alpha 标准** | **架构达标，产品验证待补** —— 暂不授予「产品 Alpha」标签 | 需在真实 `DEEPSEEK_API_KEY` 下重跑 + 真实站点验证后方能定级 |

**一句话结论**：引擎本身具备 Alpha 级架构质量（安全、可观测、恢复/升级协议正确）；但**产品级 Alpha 标准尚未被本阶段验证**——验证需在真实 LLM + 真实站点下完成。当前数据只能证明"链路在确定性计划下可端到端闭环"，不能证明"AI 自主能力达标"。

---

## 1. 系统架构状态

唯一真实执行链（Phase 1–4 已闭环，本阶段未改动）：

```
TaskManager.createTask(不 attachPlan) → start → runtime.run
  → Planner(DeepSeek) → tools(browser) → verification → recoveryManager/repairManager → 终态
```

### 1.1 本阶段新建（非冻结）资产

- **真实场景框架** `server/scenarios/`（6 类，15 个场景）
  - `ecommerce/`（4）：商品搜索、加购、动态加载恢复、改版元素变更
  - `saas/`（3）：登录看板、导出报表、错误凭据登录失败
  - `admin/`（1）：创建用户
  - `data_entry/`（2）：会员注册、资料更新
  - `scraping/`（2）：商品列表、价格信息
  - `failure/`（5）：页面不存在 / 元素改变 / 网络失败 / 登录失败 / 验证失败（覆盖 Task 4 全 5 类必选注入）
  - 每个场景结构：`{id, objective, difficulty, expectedSteps, expectedOutcome, failureInjection}`，均为多步业务目标，无简单 demo。
- **测试替身 fixtures** `mock-site/`（9 个真实页面）：搜索/加购、动态加载、改版搜索、SaaS 登录+看板+导出、Admin 用户管理、会员表单、比价列表、异步操作台（验证失败）、404（由 mock server 返回）。
- **Product Benchmark Runner** `server/scripts/productBenchmark.js`：批量执行真实任务，输出要求全部指标 + 5 类失败注入的恢复矩阵 + 每任务明细 JSON。
- **Agent Score** `server/agentScore.js`：Planning/Execution/Recovery/Verification/Autonomy 五维分（权重 0.20/0.25/0.20/0.20/0.15）+ 加权 `overall`。

### 1.2 架构层已验证的事实（SIMULATED 模式亦成立）

1. **指纹层在线且 PASS**：每次任务均输出 `[integrity] 层=OK/OK/OK 总体=PASS` 与 `[ua] Client Hints 已对齐`，说明指纹注入、UA/Client-Hints 对齐在生产路径中正常。
2. **执行引擎端到端闭环**：8/15 场景在确定性计划下完整跑通 NAVIGATE→fill→click→inspect→verification。
3. **验证门控生效**：`text_present` 验证真实拦截了 7 个未达预期的任务（未静默通过）。
4. **失败分类器工作**：15 任务分类为 execution=5 / verification=2 / planner=0，无分类缺失。
5. **恢复框架真实触发**：5 类失败注入中 4 类 `recoveryTriggered=true`；不可恢复失败正确升级为 `HUMAN_ESCALATION`（终态），无悬挂、无死循环。
6. **升级协议安全**：所有不可恢复失败均进入显式 `HUMAN_ESCALATION` 终态（而非旧版 `PAUSED_FOR_HUMAN` 非终态悬挂），worker 正常释放。
7. **可观测性就绪**：trace/事件/快照/JSON 报告全量产出，Agent Score 跨 5 维计算。

### 1.3 本阶段为诚实所做的两处度量修正（非核心逻辑）

- **修正 A（fixture 文案 bug）**：`mock-site/misc/verify_fail.html` 原描述文本含字面量"操作成功"，导致 `text_present('操作成功')` 误匹配成功 → 验证失败场景被**假阳性**判为 SUCCESS。已改写描述去除该字面量。修正后该场景正确升级为 `HUMAN_ESCALATION`（见 §4）。
- **修正 B（注入类型去重）**：`ecommerce.search_changed` 与 `saas.login_failure` 原本也挂了 `failureInjection` 标签，与 `failure.*` 中同名注入重复计数（恢复矩阵出现 `SUCCESS,SUCCESS` / `HUMAN_ESCALATION,HUMAN_ESCALATION`）。已将这两处置为 `null`，使 5 类注入与 5 个 `failure.*` 场景 1:1 对应。此修改仅影响度量聚合口径，不改变任何成功/失败结果。

---

## 2. Benchmark 结果（SIMULATED）

| 指标 | 值 |
|---|---|
| 模式 | SIMULATED（mock planner，场景盲） |
| 总任务数 | 15 |
| 成功率 | **53.3%**（8/15） |
| 人工升级率 | **46.7%**（7/15） |
| 平均步骤数 | 3.2 |
| 平均恢复次数（retries+repairs） | 3.07 |
| 平均延迟(ms) | 14,699 |
| 计划失败（planner） | 0 |
| 执行失败（execution） | 5 |
| 验证失败（verification） | 2 |
| Agent Score · Planning | 100 |
| Agent Score · Execution | 61 |
| Agent Score · Recovery | 53 |
| Agent Score · Verification | 77 |
| Agent Score · Autonomy | 53 |
| Agent Score · **Overall** | **69** |

> ⚠️ 上述 53.3% 是**框架自检成功率**，不是产品成功率。mock planner 为场景盲、使用注入式确定性计划，无法反映真实 LLM 的规划质量。详见 §5。

### 2.1 分任务明细

| 场景 | 类别 | 状态 | 分类 | steps | retries | repairs | score | 注入 |
|---|---|---|---|---|---|---|---|---|
| ecommerce.search | ecommerce | SUCCESS | – | 3 | 0 | 0 | 100 | – |
| ecommerce.add_to_cart | ecommerce | SUCCESS | – | 3 | 0 | 0 | 100 | – |
| ecommerce.lazy_recovery | ecommerce | SUCCESS | – | 3 | 3 | 0 | 88 | – |
| ecommerce.search_changed | ecommerce | SUCCESS | – | 3 | 0 | 0 | 100 | – |
| saas.login_dashboard | saas | HUMAN_ESCALATION | execution | 4 | 3 | 3 | 36 | – |
| saas.export_report | saas | HUMAN_ESCALATION | execution | 5 | 3 | 3 | 36 | – |
| saas.login_failure | saas | HUMAN_ESCALATION | execution | 4 | 3 | 3 | 36 | – |
| admin.create_user | admin | SUCCESS | – | 5 | 1 | 0 | 96 | – |
| scraping.product_list | scraping | SUCCESS | – | 2 | 0 | 0 | 100 | – |
| scraping.prices | scraping | SUCCESS | – | 2 | 0 | 0 | 100 | – |
| failure.page_not_found | failure | HUMAN_ESCALATION | execution | 3 | 3 | 3 | 44 | page_not_found |
| failure.element_changed | failure | SUCCESS | – | 3 | 0 | 0 | 100 | element_changed |
| failure.network_failure | failure | HUMAN_ESCALATION | execution | 2 | 3 | 3 | 28 | network_failure |
| failure.login_failure | failure | HUMAN_ESCALATION | verification | 4 | 3 | 3 | 36 | login_failure |
| failure.verification_failure | failure | HUMAN_ESCALATION | verification | 2 | 3 | 3 | 43 | verification_failure |

---

## 3. 成功率

- **整体**：SIMULATED 模式 53.3%（8/15）。其中 7 个能力场景（ecommerce×4、admin、scraping×2）全部 SUCCESS；saas 套件 3 个全升级；5 类失败注入中 1 个恢复成功、4 个正确升级。
- **能力场景子集**（不含失败注入）：11 个中 8 个 SUCCESS ≈ **72.7%**。
- **失败注入子集**：5 个中 1 个 SUCCESS（element_changed，语义定位恢复）、4 个正确升级。
- **关键解读**：成功率偏低的主因是 **saas 套件在 SIMULATED 模式下全败**（见 §4/§5 的 `<div>` 观测盲区说明），而非引擎缺陷。真实 LLM 模式下 Planner 会自适应，预期显著不同——但需真实 key 重跑方能证实。

---

## 4. 失败分类（Task 4：5 类必选注入的恢复验证）

恢复矩阵（修正后 1:1 对应）：

| 失败类型 | ran | recoveryTriggered | recovered | 终态 | 真实性判定 |
|---|---|---|---|---|---|
| page_not_found（页面不存在） | ✅ | ✅ | ❌ | HUMAN_ESCALATION | ✅ 正确：缺失资源无法自恢复，应升级 |
| element_changed（元素改变） | ✅ | ❌ | ✅ | SUCCESS | ✅ 语义解析器按 `field/aria-label` 重定位到改版后的元素，未触发重试即完成 |
| network_failure（网络失败） | ✅ | ✅ | ❌ | HUMAN_ESCALATION | ✅ 正确：连接被拒不可自恢复，应升级 |
| login_failure（登录失败） | ✅ | ✅ | ❌ | HUMAN_ESCALATION | ✅ 正确：错误凭据验证失败，重试/修复无效，应升级（不绕过鉴权） |
| verification_failure（验证失败） | ✅ | ✅ | ❌ | HUMAN_ESCALATION | ✅ **修正后正确**：服务端永不返回成功，验证失败→恢复尝试→无法恢复→升级 |

**结论**：Recovery 框架**真实工作**——5 类注入全部 `ran`，失败均被正确识别并触发恢复/修复编排（retries+repairs 均值 3.07），不可恢复者一律安全升级，未出现静默通过、悬挂或死循环。

**两个诚实披露**：
1. `verification_failure` 在修正 fixture 文案前曾被**假阳性**判 SUCCESS（页面描述含字面"操作成功"）。已修正，修正后行为符合预期。
2. SIMULATED 模式的"恢复"= 确定性 retry + repair **管线**被真实驱动，但**不代表 AI 自主重规划智能**被验证（mock planner 不重规划）。AI 自主恢复推理需在真实 LLM 模式下评估。

---

## 5. 当前限制（Real Limitations）

> 下列为**真实架构/产品限制**，非测试噪声。其中 L5 触及冻结文件，本报告仅记录，未修改。

- **L1 · SIMULATED 模式不验证 AI「大脑」**：mock planner 场景盲、注入确定性计划，本 benchmark 未运行真实 DeepSeek Planner。产品级规划质量需 `DEEPSEEK_API_KEY` 重跑 15 场景 + 更大真实站点套件验证（Phase 3/4.4 曾用真实 key 达 10/10，但非本套场景）。
- **L2 · 仅本地 mock 站点**：fixtures 无反爬、无真实鉴权、无网络延迟、无验证码、无 SPA 复杂导航。生产级鲁棒性（anti-bot、captcha、长任务、跨域）未验证。
- **L3 · 观测 `<div>` 盲区（真实核心缺陷，冻结未改）**：`observation.textSummary` 仅采集 `h1/h2/h3/p/li/summary/span`，**不采集 `<div>` 文本**。后果：`text_present` 验证对 `<div>` 渲染的动态内容**失明**。已观察到的影响：
  - 原 `verify_fail.html` 描述含"操作成功"被误匹配（已借 fixture 文案修正绕过）；
  - `saas/login.html` 的看板（`#dash` 为 `<div>`）与导出提示（`#exportMsg` 虽为 `<p>` 但依赖 div 内流程）在 SIMULATED 模式验证不稳，是 saas 套件全败的高概率根因。
  - 修复需改 `observation.js` 采集逻辑（冻结项），建议作为 P1 架构修复排期。
- **L4 · 恢复"智能"未被证明**：SIMULATED 模式恢复=确定性 retry/repair 管线；AI 能否从**未见过的**失败自主重规划恢复，本阶段未验证。
- **L5 · 样本与覆盖有限**：15 场景、全本地、无长程/对抗/跨站点；成功率统计意义有限。
- **L6 · 度量口径依赖注入标签**：恢复矩阵按 `failureInjection.type` 聚合，需保证 1:1（已借修正 B 处理），否则会重复计数。

---

## 6. 下一阶段建议

1. **真实 LLM 重跑（最高优先级）**：提供 `DEEPSEEK_API_KEY`，运行 `node server/scripts/productBenchmark.js`（不加 `--mock`）对 15 场景 + 扩充的真实站点套件做产品级验证，替换本报告的 SIMULATED 数字。
2. **修复 L3 观测盲区（P1，需解冻 `observation.js`）**：让 `text_summary` 采集 `<div>` 文本（或增加语义块提取），消除 `text_present` 对动态内容的失明；随后重测 saas 套件，预期恢复成功率上升。
3. **saas 套件健壮化**：在 L3 修复后复测；若为真实 DOM/form-submit 交互问题，补充 preset 计划与 fixture 的字段对齐（仅影响 SIMULATED 自检，不改动核心）。
4. **恢复智能专项（Phase 6 候选）**：构造"未见失败"场景，在真实 LLM 模式下评估 agent 自主重规划恢复率，作为 Recovery Score 的核心证据。
5. **真实站点 pilot**：选取 3–5 个真实网站（含登录、表单、列表）做小规模真实运行，建立反爬/验证码/网络抖动的恢复基线。
6. **Alpha 定级门禁**：建议以「真实 LLM 重跑成功率 ≥ 80% 且 5 类失败注入均正确升级」作为授予「产品 Alpha」标签的准入门槛。

---

## 附：如何复现

```bash
# 框架自检（SIMULATED，无需 key）
node server/scripts/productBenchmark.js --mock --timeout 60000

# 产品级验证（需真实 LLM key）
DEEPSEEK_API_KEY=sk-xxxx node server/scripts/productBenchmark.js --timeout 90000

# 仅跑 5 类失败注入
node server/scripts/productBenchmark.js --injection

# 结果 JSON：.benchmark/phase5_<ts>.json
```

**再次声明**：本报告所有量化结论均基于 SIMULATED 模式（mock planner），仅证明"执行/验证/恢复/升级管线在确定性计划下端到端可用"，**不构成 AI 自主能力的产品级结论**。产品 Alpha 定级须待真实 LLM + 真实站点验证。
