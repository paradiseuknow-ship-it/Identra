# Phase 10.7–10.9 VIL Control-Flow Integration — 验收报告

> 生成时间：2026-08-26
> 范围：Phase 10.7（STATE_UNKNOWN 控制流修复）→ 10.8（VIL 决策执行 + 遥测 + 异步 Fixture + Observation Window）→ 10.9（全量 Benchmark）
> 基线：v0.1-alpha FROZEN；Phase 10 v0.2.1 状态 = C（Not Ready，VIL 控制流零触发）
> 约束：未修改 v0.1-alpha 冻结基线、未改 success 定义、未降低 verification 标准、未 mock planner、未改历史 benchmark 数据、未新增数据库/event bus、未删除失败样本。

---

## 0. 执行状态总览（先讲真相）

| 项目 | 状态 |
| --- | --- |
| Phase 10.7 代码改造 | ✅ 完成 |
| 单元测试（老 + 新） | ✅ 19/19 + 24/24 通过 |
| 集成测试（真实浏览器 async fixtures） | ✅ 17/17 通过 |
| 停止门 #1–#6 | ✅ 全部通过（见 §11） |
| Phase 10.9 全量 100-task Benchmark | ⛔ **本环境未执行** |

**全量 Benchmark 未执行原因（基础设施阻塞，非能力失败）：**
当前执行环境未设置 `DEEPSEEK_API_KEY`。`phase10Benchmark.js` 在第 11–14 行硬性检测该变量，缺失即 `process.exit(2)`。
→ 这意味着**无法在此环境跑真实 DeepSeek 100 任务**，因此 **Business Success / 全量 VERIFY_FAILED / 全量 ELEMENT_NOT_FOUND / 全量 Business Recovery 等真实产品指标无法在本报告产出**。
→ 本报告的所有"真实数据"来自**真实浏览器 + 真实 DOM 时序**（无 LLM），验证的是 VIL 控制流本身；产品级指标需补跑全量 Benchmark 后补充。

**结论前置：本阶段目标是"让 VIL 真正进入 runtime 控制流并形成可审计闭环"——该目标已用真实浏览器证据达成。全量产品判定（A/B/C 中的 A）因 API Key 缺失而暂挂。**

---

## 1. Control Flow Before / After

### Before（Phase 10 v0.2.1，C 级）
- `verificationIntelligence.analyze()` 仅做**分类标注**（6 类 failureType），但决策未真正进入控制流。
- `runtime.js` 内联 VIL 只对 `WAIT`/`RETRY_VERIFY` 做了**固定 sleep 后重观察**，且 `STATE_UNKNOWN`（占 Phase10 187/224）被直接路由到 `HUMAN_ESCALATE`。
- `verifyFailed.js` 对时序类（EVENTUAL_CONSISTENCY / OBSERVATION_DELAY / VERIFICATION_TOO_STRICT）**无条件返回 `ok:true`**（silent-pass 漏洞），导致 repair recovery 统计失真。
- 无任何 VIL 决策遥测事件（`ai.verification.decision` / `ai.verification.recovered` 均为 0）。
- 结果：WAIT=0、RECHECK=0、RETRY_VERIFY=0、RE_EXECUTE=0、recovered=0。VIL 只是"标签机"。

### After（Phase 10.7，本次改造）
- 新增 `verification/verificationWindow.js`：真实**观察窗口**（initial → 250/500/1000/2000ms 级联等待 → 重观察 → 重验证），有界超时（DEFAULT_MAX_MS=5200ms），绝不无限等待。
- `runtime.js`：验证失败后先 `VIL.classify` → 发 `ai.verification.decision` 遥测 → 对可重观察决策（WAIT/RECHECK_OBSERVATION/RETRY_VERIFY）**真实运行 Observation Window** → 成功则发 `ai.verification.recovered` 并置步成功；窗口耗尽则**失败 attempt**（不 silent-pass）→ 进入 retry→repair→escalate 终态。
- `verifyFailed.js` 重写：所有分支在返回 `ok:true` 前**必须用真实 observation 重新运行 verification（含 allowedAlternativeStates）**，否则 `ok:false` 交上层升级。
- `STATE_UNKNOWN` 不再放弃：→ `RECHECK_OBSERVATION` → 重观察 → 重验证 → 成功则恢复，失败则再分类/升级。
- `VERIFICATION_TOO_STRICT`：支持 `allowedAlternativeStates`（任务预定义合法态），绝不 LLM 自行宣布成功。
- 修复 `verifyFailed` 中 `step.verification` 读取路径（真实 runtime 中 `step.verification` 是 `step.action` 的同級属性，旧测试误嵌套导致误判）。

**闭环链路（已打通）：**
```
Action → Before Observation → Execute → After Observation
  → verification.verify() → FAIL
  → VIL.classify() [6 类]
  → VIL.decide()  [SUCCESS|WAIT|RECHECK_OBSERVATION|RETRY_VERIFY|RE_EXECUTE|HUMAN_ESCALATE]
  → Observation Window(WAIT+RECHECK+RETRY_VERIFY) 或 RE_EXECUTE
  → 重新 verification
  → 成功 → SUCCESS（Business Recovery）
  → 失败 → 再分类 / HUMAN_ESCALATE
```

---

## 2. VIL Decision Count（真实浏览器集成测试实测）

来自 `test_phase10_vil_integration.js`（真实 chromium + 真实 mock-site/async）：

| 指标 | 实测值 |
| --- | --- |
| VIL decision 事件 | 1（每次验证失败均记录；测试覆盖 3 个 fixture × 各 1 次 FAIL） |
| WAIT 窗口事件（`ai.verification.window`） | 8 |
| RECHECK（重新 capture observation，observationCount 累计） | 23（初始 1 + 重观察 22） |
| VIL recovered 事件 | 1（async-success） |
| 窗口内 verification 尝试 | async-success=3、async-loading=3、async-never 耗尽 maxMs |

> 注：以上为**单轮集成测试**计数，不等于全量分布。全量分布需跑 100-task Benchmark。

---

## 3. Decision Distribution（分类 → 决策映射，单元测试覆盖）

`verificationIntelligence.analyze()` 的 6 类映射（24 条单元测试逐一断言）：

| failureType | decision | 是否可重观察（进入 Window） |
| --- | --- | --- |
| EVENTUAL_CONSISTENCY | WAIT | ✅ |
| OBSERVATION_DELAY | RETRY_VERIFY | ✅ |
| VERIFICATION_TOO_STRICT | RETRY_VERIFY | ✅ |
| STATE_UNKNOWN | RECHECK_OBSERVATION | ✅ |
| ACTION_REAL_FAILURE | RE_EXECUTE | ❌（仅重执行原 action） |
| DOM_CHANGED | RE_EXECUTE | ❌（语义重定位） |

`isReobservableDecision()` 对 WAIT/RECHECK_OBSERVATION/RETRY_VERIFY 返回 true，对 RE_EXECUTE/HUMAN_ESCALATE 返回 false——保证"重观察/重验证路径绝不触发原 action"。

---

## 4. VIL Recovery（验证级恢复，真实证据）

| Fixture | 结果 | 证据 |
| --- | --- | --- |
| async-success | **recovered=true** | observationCount=3，stateChanged=true，最终观察含 "SUCCESS" |
| async-loading | **recovered=true** | Loading → Loaded 稳定后出现，恢复成功 |
| async-never-success | recovered=false | 到达 maxMs 后明确收口（elapsedMs=2739ms ≤ 5200+容差），不无限等待 |

→ VIL 在真实异步场景下**确实恢复了验证失败**（async-success/loading），且对永远不成功的场景**正确超时收口**而非死等。

---

## 5. Business Recovery（严格区分四层）

依用户约束，明确区分：

| 层 | 定义 | 本阶段证据 |
| --- | --- | --- |
| **classified** | VIL 仅做分类标注 | 6 类分类在单元测试中全部断言正确 |
| **decision_changed** | VIL 实际改变了 runtime 决策（从"直接升级"改为"进入 Window"） | 集成测试中 STATE_UNKNOWN→RECHECK_OBSERVATION 驱动了 WAIT+RECHECK 窗口（旧代码会直接 HUMAN_ESCALATE） |
| **recovered** | VIL 验证级恢复（verification 通过） | async-success / async-loading：recovered=true |
| **business_recovered** | 业务最终成功（任务终态 SUCCESS） | ⛔ 需全量 100-task Benchmark 才能给出百分比 |

**重要声明：** 本阶段证明的是 `recovered`（验证级）。`business_recovered`（业务级百分比）**不能由 VIL 验证级恢复直接外推**，必须跑全量 Benchmark 后依据任务终态统计。未做此外推，未用分类变化冒充能力提升。

---

## 6. VERIFY_FAILED Taxonomy（6 类路由矩阵，代码级已闭环）

| failureType | 路由（verifyFailed.js） | 重执行原 action? |
| --- | --- | --- |
| EVENTUAL_CONSISTENCY | WAIT_STABLE + RECHECK_OBSERVATION | ❌ |
| OBSERVATION_DELAY | WAIT + RECHECK_OBSERVATION | ❌ |
| VERIFICATION_TOO_STRICT | RECHECK_OBSERVATION + 替代验证态 | ❌ |
| STATE_UNKNOWN | RECHECK_OBSERVATION → 再分类 → 升级 | ❌ |
| ACTION_REAL_FAILURE | RE_EXECUTE（保留 target 对象） | ✅（仅此处） |
| DOM_CHANGED | SEMANTIC_RELOCATE → 重观察 → 重验证 | ❌（重定位，非原 action） |
| RESOURCE_LOCK | **不进入 verifyFailed**，走独立基础设施错误分支 | — |

修复要点：`verifyFailed` 对除 ACTION_REAL_FAILURE 外的所有分支，**不再 silent-pass**——重观察/重执行后必须用真实 observation 重新 verify，失败则 `ok:false` 交上层。

---

## 7. Observation Window（真实指标）

`verificationWindow.runObservationWindow` 输出（集成测试实测）：

| 字段 | async-success | async-loading | async-never-success |
| --- | --- | --- | --- |
| observationCount | 3 | ≥2 | 耗尽 maxMs |
| verificationAttempts | 3 | ≥2 | 耗尽 maxMs |
| stateChanged | true | true | false（始终 Processing） |
| elapsedMs | < maxMs | < maxMs | 2739ms（受 maxMs 约束） |
| recovered | true | true | false |

窗口时间表：STATE_UNKNOWN 用 `[300,800,1600]`（累计 ~2.7s 封顶，降低静态页面误判耗时）；EVENTUAL_CONSISTENCY/OBSERVATION_DELAY/RETRY_VERIFY 用 `[250,600,1200,2200]`（累计 ~4.3s）。

---

## 8. Async Fixture Results（真实浏览器）

新增 `mock-site/async/`：
- `async-success.html`：点击/加载后 ~900ms 出现 "SUCCESS"（真实 DOM 时序）。
- `async-loading.html`：加载后进入 Loading，~1500ms 后出现 "Loaded"。
- `async-never-success.html`：永远停在 Processing，周期心跳更新——用于证明窗口超时收口、不无限等待。

集成测试（真实 chromium）验证：
- async-success：`FAIL → VIL → WAIT → RECHECK → VERIFY → SUCCESS` 完整链路 ✅
- async-loading：等待稳定后恢复 ✅
- async-never-success：`TIMEOUT → 不恢复 → 必须交上层升级`（non-silent-pass）✅

---

## 9. Phase 9 vs Phase 10 vs Phase 10.9

| 维度 | Phase 9 (v0.1) | Phase 10 (v0.2.1, C) | Phase 10.9 (本阶段) |
| --- | --- | --- | --- |
| VIL 分类 | 无 | 仅标注 6 类 | 6 类 + 决策 |
| WAIT / RECHECK | — | 0 / 0 | **>0 / >0（真实浏览器验证）** |
| VIL recovered | — | 0 | **>0（async-success/loading）** |
| verifyFailed silent-pass | — | 无条件 ok:true | **已修复（必须真实重验证）** |
| STATE_UNKNOWN 路由 | — | HUMAN_ESCALATE | **RECHECK_OBSERVATION** |
| 决策遥测 | — | 无 | **ai.verification.decision / recovered** |
| 全量 Business Success | 9% | 12.5% | ⛔ 本环境未跑全量 |

> Phase 10.9 的"能力增量"已用真实浏览器证据确认（VIL 进入控制流、窗口恢复异步验证、超时收口）。全量产品指标待补跑。

---

## 10. Release Decision

### 固定标准
- **A Product Candidate**：Business Success ≥70% / Real Esc ≤30% / VERIFY_FAILED <20% / ELEMENT_NOT_FOUND ≈0% / Business Recovery ≥60%
- **B Engineering Ready**：架构稳定，但未达 A
- **C Not Ready**：核心控制流仍无法形成真实闭环

### 判定：**B — Engineering Ready**

理由：
1. **核心控制流已真正闭环**（C 级失败模式"核心控制流仍无法形成真实闭环"已消除）：集成测试用真实浏览器证明 `FAIL → VIL → WAIT → RECHECK → VERIFY → SUCCESS` 真实发生，WAIT/RECHECK/recovered 均 >0。
2. **silent-pass 漏洞已修复**：verifyFailed 所有分支必须真实重验证。
3. **STATE_UNKNOWN 不再放弃**：进入 RECHECK 路径。
4. **超时有界**：async-never 在 maxMs 内收口，不无限等待。
5. **遥测可审计**：决策/恢复事件 schema 已落地（复用 aiEvents）。

**为何不是 A：** A 要求的产品级指标（Business Success ≥70% 等）**必须来自全量 100-task Benchmark**，而本环境因 `DEEPSEEK_API_KEY` 缺失而无法执行。在拿到全量数据前，不能宣称达到 A（遵守"指标提升不能归因于 VIL"的约束——本阶段只证明控制流机制成立，未证明全量产品指标达标）。

### 解阻塞条件（交付后即可补跑）
```bash
export DEEPSEEK_API_KEY=...
node server/scripts/phase10Benchmark.js
# 产出 .benchmark/phase10_<runId>.json + PHASE10_RAW_RESULT.md
# 随后用 analyze_phase10_final.js 生成全量对比，补全本报告 §5/§9 的产品级指标
```

### 下一步方向（仅列，不执行、不改代码）
1. 提供 `DEEPSEEK_API_KEY` 后补跑全量 100-task Benchmark（含 SaaS/E-commerce/Data Entry/Long Workflow）。
2. 若全量 Business Success ≥70% 且 VERIFY_FAILED <20% → 升 A。
3. 若未达 → 依据全量 taxonomy 分布定位剩余瓶颈（预期在 credential/real-escalation 类，非 VIL 控制流）。

---

## 附录：测试矩阵结果

| 层 | 文件 | 结果 |
| --- | --- | --- |
| 单元测试（老回归） | test_phase10.js | 19/19 ✅ |
| 单元测试（VIL/verifyFailed/Window） | test_phase10_vil.js | 24/24 ✅ |
| 集成测试（真实浏览器 async） | test_phase10_vil_integration.js | 17/17 ✅ |
| 历史回放 | 不修改历史数据；Phase 9/10 JSON 仅供分析 | — |

**停止门（§11）核查：#1 VIL decision>0 ✅ / #2 WAIT>0 ✅ / #3 RECHECK>0 ✅ / #4 VIL recovered>0 ✅ / #5 async-success 全链路 ✅ / #6 async-never TIMEOUT→ESCALATION ✅。全部通过，允许进入 Phase 10.9（受 API Key 阻塞，非门禁失败）。**
