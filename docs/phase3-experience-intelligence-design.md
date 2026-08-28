# Phase 3.0 架构设计：Browser Experience Intelligence

> 阶段目标：让 AI Browser Operator **越用越懂网站**——第一次靠 AI 推理执行，第二次起直接命中历史经验（Element/Flow/Failure/Profile），无需重复 LLM 推理，同时降低成本、提升成功率。
>
> 本阶段**先设计、不写代码**。设计落定后按 3.1→3.5 增量开发，每个模块独立验收。

---

## 0. 设计原则（防止"知识库堆积"）

1. **经验必须可被消费，而不是只被存储。** 每个记忆模块必须有明确的读取方（lookup 点），否则不写。
2. **写入即学习，读取即降本。** 记忆在 Runtime 生命周期关键节点自动写入；查询顺序固定为"记忆优先 → 启发式 → LLM"。
3. **置信度驱动。** 记忆必须带 `samples` / `successRate` / `confidence`，低样本或低成功率的经验自动降权，不误导 AI。
4. **安全边界不变。** 记忆只能"建议"，不能绕过风控/验证码/支付。`HTTP_FORBIDDEN` 类记忆的解决方案只输出"换网络/等待/人工"，绝不自动撞库或绕过。
5. **站点隔离。** 记忆全部按 `site` 键控，不同站点互不污染。

---

## 1. 架构定位

新增独立层 `server/agent/intelligence/`，位于现有各层之下、作为"横切记忆层"被消费：

```
用户目标 → AI Parser → Planner ───────┐
                                          │  flowMemory.lookup（历史流程命中）
Task → Observation ──┬────────────────────┤
                      │ elementMemory.lookup（元素记忆）→ semanticResolver → LLM
Semantic Action → Browser Tool ───────────┤
Verification ────────┬────────────────────┤
Failure Diagnosis → Repair Planner ───────┤  failureKnowledge.lookup（解决方案建议）
Repair Executor ────┬─────────────────────┤
Task 完成 / 失败 ─────┴──→ 写回记忆 ─────────┘
Profile 创建/任务结束 ──→ profileScoring 更新
```

- **写入方**：runtime / repairManager / observation / recorder / taskManager 的生命周期钩子。
- **消费方**：tools.resolveSelector、planner、repairManager、chat（推荐）、AiConsole（展示）。

---

## 2. 数据模型（每个模块一个集合）

复用 `store.js`（JsonStore），新增集合，键控 `site` 或 `profileId`，带 `lastUpdated`。

### 2.1 `siteMemory.js` — 站点画像

```json
{
  "id": "site_stripe.com",
  "site": "stripe.com",
  "domain": "stripe.com",
  "history": { "successTasks": 1520, "failedTasks": 31 },
  "commonFlows": [
    { "name": "signup", "successRate": 0.96, "avgSteps": 12, "samples": 84, "lastUsed": 0 },
    { "name": "login",  "successRate": 0.98, "avgSteps": 6,  "samples": 210, "lastUsed": 0 }
  ],
  "riskLevel": "medium",          // low/medium/high（由 failureKnowledge 聚合）
  "frequentFailures": ["HTTP_FORBIDDEN", "ELEMENT_NOT_FOUND"],
  "lastUpdated": 0
}
```

- API：`getSite(site)`、`recordTaskResult(site, {ok, flowName})`、`listSites()`。
- 写入：task 完成/失败时（taskManager.complete/fail 钩子）。
- 消费：chat 推荐、planner（站点整体可执行性提示）、AiConsole。

### 2.2 `elementMemory.js` — 元素记忆（**最重要，降本最直接**）

```json
{
  "id": "el_stripe_signup_next",
  "site": "stripe.com",
  "purpose": "signup_next",
  "patterns": [
    { "text": "Continue", "role": "button" },
    { "text": "Proceed",  "role": "button" },
    { "aria": "Next" }
  ],
  "confidence": 0.97,
  "successRate": 0.96,
  "samples": 87,
  "lastSuccess": 0,
  "lastUpdated": 0
}
```

- 写入点：`tools.resolveSelector` 成功命中后（记录 `site + purpose + patterns + observation 快照`）。
- 消费点：`tools.resolveSelector` 改为：
  1. 显式 `selector`（最快）
  2. **elementMemory.lookup(site, purpose)**：用站点历史 patterns 做 DOM 匹配（by text/role/aria），命中即返回，**零 LLM**
  3. `sites.selectorFor(site, key)`（Site Adapter 选择器）
  4. `semanticResolver.resolve`（启发式）
  5. LLM（仅真实 provider 且前序全失败时）
- 当 2 命中失败但 4 成功时，把新 pattern 追加进该 purpose（模式演化：Continue→Proceed 自动积累）。

### 2.3 `flowMemory.js` — 流程记忆（**未来最大价值**）

```json
{
  "id": "flow_stripe_signup_v1",
  "site": "stripe.com",
  "name": "signup",
  "version": 1,
  "steps": [
    { "order": 1, "tool": "navigate",  "target": { "url": "https://stripe.com/signup" }, "purpose": "open_signup" },
    { "order": 2, "tool": "fill",      "target": { "field": "email" },  "credentialRef": true, "purpose": "fill_email" },
    { "order": 3, "tool": "click",     "target": { "semantic": "Continue" }, "purpose": "next" },
    { "order": 4, "tool": "inspect",   "target": { "role": "page" },  "purpose": "verify_email" },
    { "order": 5, "tool": "fill",      "target": { "field": "company" }, "purpose": "fill_company" },
    { "order": 6, "tool": "submit",    "target": { "semantic": "Submit" }, "purpose": "submit" }
  ],
  "successRate": 0.93,
  "avgSteps": 6,
  "samples": 55,
  "versionCreated": 0,
  "lastUsed": 0
}
```

- 写入点：task SUCCESS 后，从该任务的 `plan + execution.actions` 提炼规范化步骤（purpose 化，去具体 value/selector）。
- 消费点：`planner.planObjective` 前先 `flowMemory.lookup(site, flowName/objective 语义)`：
  - 命中 → 直接加载历史流程步骤 → 对每步执行 `observe → verify page 匹配` → 逐项执行；不匹配处回退 Planner/LLM。
  - 记录 `flowUsedAt`，供成功率统计。
- 版本化：流程修订时 `version++`（对应 plan_v1→v2 机制）。

### 2.4 `failureKnowledge.js` — 失败知识库（升级 aiRepairAttempts）

```json
{
  "id": "fk_example.com_403",
  "site": "example.com",
  "failureType": "HTTP_FORBIDDEN",
  "conditions": { "proxyCountry": "US", "accountAge": "new" },
  "solution": "switch_proxy",          // 枚举：switch_proxy / wait / retry / dismiss / manual / relocate
  "successRate": 0.72,
  "samples": 25,
  "lastUpdated": 0
}
```

- 写入点：`repairManager.handleStepFailure` 结束（诊断类别 + 使用的修复策略 + 结果）→ 聚合进 `failureKnowledge`；同时保留 `aiRepairAttempts` 明细。
- 消费点：
  - `repairManager` 生成方案前查该站点的 `failureKnowledge`：若某 solution 历史成功率高 → **优先选择该策略**（而不是固定顺序）。
  - **安全边界**：`HTTP_FORBIDDEN` / `SESSION_EXPIRED` 类只产出建议（换网络/等待/人工/重登流程），**禁止自动绕过、自动换账号、撞库**。
- 已有 `repairAttempts.statsByStrategy()` 是其数据源之一，直接升级为按 `site + failureType + conditions` 聚合。

### 2.5 `profileScoring.js` — 环境健康评分

```json
{
  "id": "score_profile001",
  "profileId": "profile001",
  "fingerprintConsistency": 100,
  "proxyStability": 92,
  "loginSuccess": 85,
  "taskSuccess": 96,
  "risk": "LOW",
  "score": 93,
  "updatedAt": 0
}
```

- 数据源：
  - `fingerprintConsistency`：integrity 检测通过率（profile 启动校验层数）。
  - `proxyStability`：proxy 连接成功率/平均延迟（可加定时探活）。
  - `loginSuccess`：vault 凭据在该 profile 的登录成功比例。
  - `taskSuccess`：该 profile 历史任务成功率。
- 评分公式（权重可配置，默认）：
  `score = 0.25·fp + 0.2·proxy + 0.2·login + 0.35·task`
  `risk` 按 `taskSuccess<0.6` 或 `proxyStability<60` 或该站点失败频发 → HIGH。
- 消费点：`recommendationEngine`（任务下发前选最优 profile）、AiConsole 展示。

### 2.6 `recommendationEngine.js` — 推荐引擎

- `recommendProfiles({ goal, site, count, budget })`：
  1. 按 `profileScoring` 排序；
  2. 交叉 `siteMemory`（该站点历史用哪个 profile 成功率高）；
  3. 返回 Top N + 理由（如"Profile001 Germany Residential 该站点成功率 91%"）。
- `recommendFlow({ site, objective })`：委托 flowMemory。
- `recommendSolution({ site, failureType, conditions })`：委托 failureKnowledge。
- 消费点：`POST /api/ai/chat` 的响应附带推荐（Profile/Flow），AiConsole 展示。

---

## 3. 学习闭环（写入时机一览）

| 时机 | 写入 |
|---|---|
| task 完成（SUCCESS） | siteMemory.recordTaskResult、flowMemory（提炼流程）、profileScoring.taskSuccess |
| task 失败 / 修复结束 | failureKnowledge（类别+策略+结果）、siteMemory.frequentFailures |
| resolveSelector 成功命中 | elementMemory（site+purpose+patterns） |
| profile 完整性校验通过 | profileScoring.fingerprintConsistency |
| proxy 探活 / 任务中的 proxy 表现 | profileScoring.proxyStability |
| 登录成功 | profileScoring.loginSuccess |

> 写入全部走"异步非阻塞 + 集合 trim"，不拖慢 Runtime 主循环。

---

## 4. 查询降本顺序（统一规范）

**元素定位**：显式 selector → elementMemory → site.selectors → semanticResolver → LLM
**计划生成**：flowMemory → Planner(LLM) → mock 兜底
**修复方案**：failureKnowledge → Repair Policy 顺序 → 固定策略
**Profile 选择**：recommendationEngine → 默认策略（按 score 降序）

---

## 5. 存储

- 复用 `JsonStore`（`storage/jsonStore.js` 新增 `FILES` 键）：
  `aiSiteMemory` / `aiElementMemory` / `aiFlowMemory` / `aiFailureKnowledge` / `aiProfileScores`
- 每条带 `samples`/`lastUpdated`；`trimCollection` 保底上限（如 elementMemory 每站 200 条）。
- 现有 `aiRepairAttempts` / `aiKnowledge` 保持，作为 failureKnowledge 的明细与聚合源。

---

## 6. API 面（Phase 3.5 汇总）

```
GET  /api/ai/intelligence/sites                  # 站点画像列表
GET  /api/ai/intelligence/sites/:site            # 单站画像 + flows + 高频失败
GET  /api/ai/intelligence/sites/:site/elements   # 元素记忆
GET  /api/ai/intelligence/profiles/:id/score     # 环境评分
POST /api/ai/intelligence/recommend/profiles     # 推荐 profile
POST /api/ai/intelligence/recommend/solution     # 失败解决方案建议
```

---

## 7. 分阶段交付

| 阶段 | 模块 | 验收标准 |
|---|---|---|
| **3.1 Site + Element Memory** | siteMemory, elementMemory | ①同语义第二次命中零 LLM（resolveSelector 命中 elementMemory）；②Continue→Proceed 模式自动积累；③testAgentPhase31 全绿 |
| **3.2 Flow Memory** | flowMemory + planner 集成 | ①任务 SUCCESS 后自动提炼流程；②同站点同目标第二次直接加载流程执行，无 LLM 规划；③流程版本化；testAgentPhase32 |
| **3.3 Failure Knowledge** | failureKnowledge + repairManager 集成 | ①修复成功后对应策略聚合为高成功率；②同站点同类失败优先用历史策略；③HTTP_FORBIDDEN 只产出"换网络/等待/人工"建议；testAgentPhase33 |
| **3.4 Profile Scoring** | profileScoring + 数据管线 | ①完整性/proxy/登录/任务四维入库；②评分公式正确；③风险标记（taskSuccess<0.6 → HIGH）；testAgentPhase34 |
| **3.5 Recommendation + Console** | recommendationEngine + 前端 | ①chat 返回 profile/flow 推荐；②AiConsole 新增"经验"页签（站点画像/元素记忆/失败知识/环境评分）；③end-to-end 演示"第二次执行不推理"；testAgentPhase35 |

---

## 8. 测试策略

- 每个子阶段独立 `testAgentPhase3x.js`（复用 `_testSite.js` 版本探针 + mock provider 确定性）。
- 关键测试点：
  - **Element Memory 命中**：第一次 `/renamed`（Continue）AI 定位成功 → 记忆写入 → 把按钮改名 Proceed → 第二次**不经 LLM/不经 semanticResolver** 直接命中（用注入探针统计 resolveSelector 是否走 memory 分支）。
  - **Flow Memory 复用**：完整跑通 `/form` 注册 → 提炼 flow → 删除 planner LLM（mock 下断言 `planner.planObjective` 未被调用 / 被 flow 短路）。
  - **Failure Knowledge 聚合**：制造 3 次同类失败+成功，断言 `failureKnowledge` 聚合出高成功率策略，且 repairManager 优先选用。
  - **安全边界**：`HTTP_FORBIDDEN` 记忆永远不产出"自动绕过"，只产出建议。
- 回归：infra / phase2 / phase3 / phase5 / phase22 / phase23 / phase4（带服务）。

---

## 9. 风险与边界

1. **记忆污染**：站点内容高频变更 → 用 `samples + successRate` 降权，`pattern` 超期未命中自动降级。
2. **过度拟合**：流程/元素记忆必须带 site 隔离 + 置信度门槛（`successRate < 0.5` 不推荐）。
3. **合规红线**：`failureKnowledge` 与 `recommendationEngine` 明确**不提供**规避风控/验证码/账号滥用/自动支付的能力；`HTTP_FORBIDDEN`/`SESSION_EXPIRED` 只建议"换网络/等待/人工/既有登录流程"。
4. **多进程写冲突**：单 server 进程写；多 worker 场景由 TaskManager 唯一写入口兜底（沿用 Phase 1.5 结论）。
5. **记忆膨胀**：全集合 `trimCollection` + 按 site 上限。

---

## 10. 一句话总结

Phase 3 的护城河不是"存了多少历史"，而是：**每个记忆都有一条确定性的读取路径，让第二次执行比第一次便宜一个量级**。设计完成，确认后按 3.1 开始增量开发。
