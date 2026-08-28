# PHASE10_STEP2 — Verification Intelligence Design

> 阶段性质：**纯设计（只读 + 设计）**。本文件不修改任何代码、不运行 benchmark、不改变 success 定义、不实现任何修复。
> 设计基线：基于 `PHASE10_STEP1_VERIFICATION_ARCHITECTURE_AUDIT.md` 的代码级发现（已标注 file:line）。
> 所有分类占比均为**设计推断**，Phase 9 原始数据未 instrument 子类，需 v0.2.1 埋点测量后回填。

---

## 1. Executive Summary

### 1.1 Phase 9 真相回顾
Phase 9 的瓶颈不是「执行失败」，而是「Action 完成后 Agent 无法正确判断页面是否进入目标状态」：

| 指标 | 值 | 含义 |
|---|---|---|
| Business Success | **9%** | 诚实口径（Execution + Verification + NoEscalation） |
| VERIFY_FAILED | **65%** | 最大失败来源 |
| Repair 触发 | 100% | 所有 VERIFY_FAILED 都进 repair |
| Repair 尝试成功率 | 66.7% | 微观执行「成功」 |
| **Business Recovery** | **0%** | 但业务一律未恢复 |

### 1.2 Step 1 已确认的代码级根因（摘要）
- `tools.js:230`：`goto` 仅 `domcontentloaded`，各 action 完成后 `inspect` **立即抓取**，无 `networkidle`/渲染稳定等待 → **OBSERVATION_DELAY / EVENTUAL_CONSISTENCY 直接根因**。
- `verification.js`：9 类 handler 全部**单次 observation 二值判定**，无 retry window、无 DOM 稳定等待、无重观察分支。
- `runtime.js:249`：`beforeObs` 取「上一步」终态而非「本动作前」快照；`repair/executor.js:63` 修复验证 `before=null` → **before/after 对比失效**。
- `observation.js` 缺 `network/loading/mutation/timestamp` 维度；`observationCache.js` 内容未变即返回旧快照 → 掩盖时序。
- `VERIFY_FAILED` 是**黑盒错误码**，无子类，无法差异化恢复；repair 只有「重执行原 action」（RE_EXECUTE），对「观察过早 / 验证过严」无效 → **66.7% 尝试成功但 0% 业务恢复**。

### 1.3 本设计核心命题
引入**独立的 Verification Intelligence Layer（VIL）**，置于 `verify()` 失败之后、`repair` 之前：
- **不修改 runtime 核心执行链路**（遵守「禁止大重构」）。
- 把黑盒 `VERIFY_FAILED` 拆成 6 类可判别失败的 taxonomy。
- 在决策层区分「该等」、「该重观察」、「该换验证条件」、「该重执行」、「该人工」，而非一律丢给 RE_EXECUTE 式 repair。
- 补 observation 时序维度，让「观察过早」「仍在加载」与「确实无变化」可被区分。

### 1.4 预期出口（供 Step 5/实施参考，非承诺）
- 纯时序类（OBSERVATION_DELAY + EVENTUAL_CONSISTENCY，推断合计 ~45–55%）应可自动恢复。
- 目标：VERIFY_FAILED 65% → **<20%**；Business Recovery 0% → **>60%**；Business Success 9% → **≥70%**（结合后续 resolver 泛化）。

---

## 2. VERIFY_FAILED Taxonomy

> 将黑盒 `VERIFY_FAILED` 拆为 6 个可自动判别的子类。每类给出：定义、判断依据、需要的数据、当前缺失字段、推荐 recovery。
> **占比列均为推断**，需在 v0.2.1 埋点（记录每类命中计数）后回填真实值。

### 2.1 EVENTUAL_CONSISTENCY（最终一致性）
- **定义**：动作已成功执行，但页面状态（文本/列表/跳转后内容）存在异步延迟，尚未落定。
- **判断依据**：action 返回 success；observation 中 `networkState=pending` 或 `mutationState=mutating`；等待 N 秒后复检可见目标状态出现。
- **需要的数据**：`networkState`、`mutationState`、`timestamp`（前后间隔）、`loadingState`。
- **当前缺失字段**：`networkState`、`mutationState`、`loadingState`（observation.js 均无）。
- **推荐 recovery**：`WAIT_STABLE` → `RECHECK_OBSERVATION`（纯重观察 + 重验证，不重执行）。

### 2.2 OBSERVATION_DELAY（观察过早）
- **定义**：observation 捕获时机早于 DOM/文本/state 渲染完成，目标状态当时不在快照中，但稍后即存在。
- **判断依据**：`timestamp` 距 action 完成极短（< 临界）；`loadingState=loading`；`domFingerprint` 在后续观察变化；重观察后目标出现。
- **需要的数据**：`timestamp`、`loadingState`、`domFingerprint`、`mutationState`。
- **当前缺失字段**：同上，`observationCache` 还可能在未变时返回旧快照，进一步掩盖时序。
- **推荐 recovery**：`CAPTURE_NEW_OBSERVATION` → `RETRY_VERIFY`（不重执行，仅重新抓观察再判定）。

### 2.3 VERIFICATION_TOO_STRICT（验证过严）
- **定义**：action 实际已成功，但 verification 条件（如 `text_present` 精确匹配、`login_state` 正则、`action_success` 的状态断言）无法匹配真实成功状态。
- **判断依据**：action success + 重执行仍 VERIFY_FAILED + 人工/替代状态判断成功；目标元素/文本确实存在但形式与规则不符。
- **需要的数据**：`previousObservationDiff`（确认状态真的变了）、候选「替代成功状态」集合、`elementState`。
- **当前缺失字段**：无替代状态判定路径；`action_success`/`login_state` 为单一硬断言（Step 1 已标 G7/G8）。
- **推荐 recovery**：`VERIFY_ALTERNATIVE_STATE`（换用宽松/替代的成功判定，不重执行）。

### 2.4 ACTION_REAL_FAILURE（动作真实失败）
- **定义**：动作本身未达成（点击未生效、填入未提交、元素确实不可交互）。
- **判断依据**：action 返回 non-success；目标元素 `elementState=absent/unstable`；重试 action 仍失败；最终 ELEMENT_NOT_FOUND 或 RESOURCE_LOCK 倾向。
- **需要的数据**：`elementState`、`actionResult`（已有，但需与 observation 关联）、`domFingerprint`。
- **当前缺失字段**：`elementState` 结构化（当前 elements 为扁平文本，无稳定/可见语义）。
- **推荐 recovery**：`RETRY_ACTION` → 失败则 `RELOCATE_ELEMENT`（resolver 重新定位） → 仍失败 `HUMAN_ESCALATE`。

### 2.5 STATE_UNKNOWN（状态未知）
- **定义**：当前证据不足以判定成功或失败（observation 信息不全/页面结构异常/无明确成功锚点）。
- **判断依据**：`visibleText`/`roleText` 缺失关键锚点；`loadingState=unknown`；重观察多次仍无结论；置信度低于阈值。
- **需要的数据**：`loadingState`、`elementState`、`previousObservationDiff`、置信度评分。
- **当前缺失字段**：缺失结构化状态 + 置信度字段。
- **推荐 recovery**：`RECHECK_OBSERVATION`（多窗口）→ 仍未知则 `HUMAN_ESCALATE`（不盲目重执行，避免放大副作用）。

### 2.6 DOM_CHANGED（页面结构变化）
- **定义**：原目标状态/元素因页面结构变化而失效（SPA 重渲染、弹窗、布局漂移）。
- **判断依据**：`domFingerprint` 显著变化；目标元素在 `previousObservationDiff` 中消失/移位；resolver 原 selector 失效。
- **需要的数据**：`domFingerprint`、`previousObservationDiff`、`elementState`。
- **当前缺失字段**：`domFingerprint`、`previousObservationDiff`。
- **推荐 recovery**：`RELOCATE_ELEMENT`（调用 resolver 重新定位，复用现有 semanticResolver，不重写）→ 失败 `HUMAN_ESCALATE`。

### 2.7 子类 → 恢复策略映射（总览）
| 子类 | 推断占比 | 是否可自动恢复 | 首选 recovery |
|---|---|---|---|
| EVENTUAL_CONSISTENCY | 25–30% | 是 | WAIT_STABLE → RECHECK |
| OBSERVATION_DELAY | 20–25% | 是 | CAPTURE_NEW_OBSERVATION → RETRY_VERIFY |
| VERIFICATION_TOO_STRICT | 20–25% | 是（换条件） | VERIFY_ALTERNATIVE_STATE |
| ACTION_REAL_FAILURE | 10–15% | 部分 | RETRY_ACTION → RELOCATE_ELEMENT |
| STATE_UNKNOWN | ~10% | 否（人工） | RECHECK → HUMAN_ESCALATE |
| DOM_CHANGED | 5–10% | 部分 | RELOCATE_ELEMENT |
| **纯时序类（2+3）合计** | **~45–55%** | **是** | 当前因 repair 用 RE_EXECUTE 错配 → 0% 恢复 |

---

## 3. Verification Decision Pipeline

### 3.1 当前 Pipeline（代码级，来自 Step 1）
```
Action execute (tools.js, 动作后 inspect 立即抓)
   ↓
runtime.runStep → verification.verify(step.verification, after, beforeObs)
   ↓ (单次 observation 二值判定)
Success / FAIL → failAttempt({code:'VERIFY_FAILED'})
   ↓
retries(3) → repair/verifyFailed(WAIT 4s → 重执行 action → 重验证) → escalate
```
**缺陷**：verify 只有一次；失败即黑盒 VERIFY_FAILED；repair 只能重执行；无「纯重观察/纯重验证/换条件」。

### 3.2 目标 Pipeline（Verification Intelligence Layer）
```
Action execute
   ↓
[新增] Before Observation        ← 动作前快照（解决 runtime.js:249 before 粒度粗）
   ↓
Execute
   ↓
[新增] Observation Window        ← 基于 loadingState/networkState 的稳定等待（解决 tools.js:230 过早）
   ↓
[复用] Observation Capture       ← observation.js（扩展字段，见 §4）
   ↓
[新增] State Comparison          ← before vs after diff（解决 before/after 失效）
   ↓
[新增] Verification Classifier   ← 6 类 taxonomy 判别（§2）
   ↓
[新增] Decision                  ← SUCCESS / WAIT / RETRY_VERIFY / RE_EXECUTE / HUMAN_ESCALATE
   ↓
[复用/扩展] Repair / Recovery / Escalation
```

### 3.3 阶段能力归属
| 阶段 | 性质 | 复用 / 新增 |
|---|---|---|
| Before Observation | 新增 | 在 executor 外围采集动作前快照 |
| Execute | 复用 | `tools.js` 现有 action 执行（不修改） |
| Observation Window | 新增 | 轻量稳定等待（基于 loading/network，非硬编码 sleep） |
| Observation Capture | 复用 + 扩展 | `observation.js` 增字段（§4），结构兼容 |
| State Comparison | 新增 | 纯函数 diff（before/after） |
| Verification Classifier | 新增 | 独立模块，读取 taxonomy（§2） |
| Decision | 新增 | 输出 5 态 verdict（§2/§4） |
| Repair/Recovery/Escalate | 复用 + 矩阵 | 接 §5 的 Recovery Strategy Matrix |

### 3.4 Decision 输出契约（设计，非代码）
```
{
  verdict: SUCCESS | WAIT | RETRY_VERIFY | RE_EXECUTE | HUMAN_ESCALATE,
  confidence: 0..1,
  failureType: <6 类之一> | null,
  reason: <文本>,
  nextAction: <WAIT_STABLE | CAPTURE_NEW_OBSERVATION | VERIFY_ALTERNATIVE_STATE | RETRY_ACTION | RELOCATE_ELEMENT | null>
}
```
**关键约束**：`WAIT` / `RETRY_VERIFY` / `VERIFY_ALTERNATIVE_STATE` 均**不重执行 action**（避免放大副作用），只有 `RE_EXECUTE`/`RETRY_ACTION` 才重执行——这正是修复「66.7% 尝试成功但 0% 恢复」的结构性错配。

---

## 4. Observation Enhancement Contract

> 基于 `observation.js` 现有输出 `{url, title, textSummary, visibleText, roleText, elements[], errors[]}`，**最小扩展**字段。不替换现有结构，仅补充。

| 字段 | 类型 | 用途 | 解决的 Phase 9 问题 |
|---|---|---|---|
| `timestamp` | number(ms) | 标记观察时刻，计算与 action 完成的时间差 | OBSERVATION_DELAY（判断过早）、EVENTUAL_CONSISTENCY（等待时长） |
| `url` | string | 确认当前页面（已有，需纳入 diff） | STATE_UNKNOWN / DOM_CHANGED（确认是否跳转/重定向） |
| `visibleText` | string | 核心文本（已有，保留） | 基础验证载体 |
| `roleText` | string | 角色化文本（已有，保留） | 结构感知验证 |
| `domFingerprint` | string(hash) | DOM 结构哈希，识别「无变化」vs「重渲染」 | observationCache 掩盖时序；DOM_CHANGED 检测 |
| `networkState` | enum(idle/pending) | 异步请求是否完成 | EVENTUAL_CONSISTENCY（等请求落定） |
| `loadingState` | enum(loading/stable/unknown) | 页面是否仍在加载 | OBSERVATION_DELAY（等渲染完成） |
| `mutationState` | enum(mutating/stable) | DOM 是否仍在变化 | EVENTUAL_CONSISTENCY（等 DOM 静止） |
| `elementState` | object[] | 目标元素的结构化状态（present/visible/stable/disabled） | ACTION_REAL_FAILURE（确认真实失败）、VERIFICATION_TOO_STRICT |
| `previousObservationDiff` | object | 与上一次观察的增量（文本/元素/url 变化） | before/after 对比（修复 runtime.js:249 + repair/executor.js:63 的 before=null） |

### 4.1 字段与 taxonomy 的支撑关系
- `loadingState=loading` + 短 `timestamp` 间隔 → 触发 **OBSERVATION_DELAY**。
- `networkState=pending` / `mutationState=mutating` → 触发 **EVENTUAL_CONSISTENCY**（WAIT_STABLE）。
- `domFingerprint` 变化 + 目标消失 → 触发 **DOM_CHANGED**（RELOCATE_ELEMENT）。
- `elementState.absent` + action 失败 → 触发 **ACTION_REAL_FAILURE**（RETRY_ACTION）。
- 文本/元素均存在但规则不匹配 → 触发 **VERIFICATION_TOO_STRICT**（VERIFY_ALTERNATIVE_STATE）。
- 关键锚点缺失 + 多次重观察无结论 → 触发 **STATE_UNKNOWN**（HUMAN_ESCALATE）。

### 4.2 不破坏现有契约的原则
- 现有 `visibleText`/`roleText`/`elements` 全部保留，handler 继续可用。
- 新字段为**附加**，旧 pipeline 不读则忽略（向后兼容）。
- `observationCache` 改为基于 `domFingerprint + loadingState` 判断是否真「无变化」，而非纯文本 hash，避免掩盖时序。

---

## 5. Recovery Strategy Matrix

> 替换当前「VERIFY_FAILED → SEMANTIC_RELOCATE（实际走 RE_EXECUTE）」的单一路径。按 taxonomy 分流。

| failureType | Recovery Action | 是否重执行 | 进入 Repair 条件 | 升级条件 |
|---|---|---|---|---|
| EVENTUAL_CONSISTENCY | `WAIT_STABLE` → `RECHECK_OBSERVATION` | 否 | 复检仍不一致且 network 卡死 | 超时（如 3 次 WAIT 仍 pending）→ HUMAN_ESCALATE |
| OBSERVATION_DELAY | `CAPTURE_NEW_OBSERVATION` → `RETRY_VERIFY` | 否 | 新观察仍缺目标 | 多次重观察仍无 → HUMAN_ESCALATE |
| VERIFICATION_TOO_STRICT | `VERIFY_ALTERNATIVE_STATE` | 否 | 替代状态亦不匹配 | 无任何替代态命中 → HUMAN_ESCALATE |
| ACTION_REAL_FAILURE | `RETRY_ACTION`（限次）→ `RELOCATE_ELEMENT` | 是（限次） | relocate 失败 | 重试耗尽 → HUMAN_ESCALATE |
| STATE_UNKNOWN | `RECHECK_OBSERVATION`（多窗口） | 否 | 仍无结论 | 置信度持续低于阈值 → HUMAN_ESCALATE |
| DOM_CHANGED | `RELOCATE_ELEMENT` | 否（重定位） | 重定位失败 | relocate 失败 → HUMAN_ESCALATE |

### 5.1 关键设计原则
1. **时序类优先「等 + 重观察」，绝不重执行**：OBSERVATION_DELAY / EVENTUAL_CONSISTENCY / STATE_UNKNOWN 都不重执行 action，避免放大副作用（Phase 9 repair 重执行是 0% 恢复的根因之一）。
2. **RE_EXECUTE 仅留给 ACTION_REAL_FAILURE**：且必须限次（如 ≤2），防止死循环。
3. **VERIFY_ALTERNATIVE_STATE 独立于 repair**：这是「换验证条件」而非「换执行」，结构上从 classification 直接出 verdict，不经 repair。
4. **保留现有 SEMANTIC_RELOCATE**：仅服务 DOM_CHANGED / RELOCATE_ELEMENT，不再作为 VERIFY_FAILED 的默认兜底。
5. **禁止 repair 的场景**：STATE_UNKNOWN 在证据不足时禁止盲目 repair（防误判放大）；VERIFICATION_TOO_STRICT 禁止重执行（重执行治不了条件错误）。

### 5.2 与现有 repair 模块的衔接
- 现有 `repair/strategies/verifyFailed.js`（WAIT→RECHECK→RETRY_VERIFY→SEMANTIC_RELOCATE）保留，但**仅作为 ACTION_REAL_FAILURE / DOM_CHANGED 的下游**，不再承接全部 VERIFY_FAILED。
- 新增 `WAIT_STABLE` / `CAPTURE_NEW_OBSERVATION` / `VERIFY_ALTERNATIVE_STATE` 为 **VIL 决策层内联动作**，不进 repair（轻量、无副作用）。

---

## 6. v0.2.1 Scope Proposal

> 禁止大重构。按 P0/P1/P2 划分，每项标注修改文件、风险、预计影响指标。

### 6.1 P0（必须 — 打通时序类自动恢复）
| 项 | 修改文件 | 风险 | 预计影响 |
|---|---|---|---|
| 1. observation 增加时序字段（timestamp/loadingState/networkState/mutationState/domFingerprint/elementState/previousObservationDiff） | `observation.js`、`observationCache.js` | 低（附加字段，向后兼容） | 解锁全部 6 类判别 |
| 2. VERIFY_FAILED 拆 6 类 classifier | 新增 `verification/classifier.js`（独立模块） | 低 | VERIFY_FAILED 可差异化恢复 |
| 3. VIL 决策层（Decision 5 态 + 内联 WAIT/RETRY_VERIFY/CAPTURE/VERIFY_ALTERNATIVE） | 新增 `verification/intelligence.js`；`runtime.js` 仅在 verify 失败后调用（不重写执行） | 中（需接 runtime 失败分支，不改核心） | OBSERVATION_DELAY+EVENTUAL_CONSISTENCY 自动恢复 |
| 4. before 快照传给 verify（修复 runtime.js:249）+ 修复 repair/executor.js:63 before=null | `runtime.js`、`repair/executor.js` | 中 | before/after 对比生效，STATE_UNKNOWN/DOM_CHANGED 可判 |

**P0 预期**：VERIFY_FAILED 65% → **<20%**（纯时序类 ~45–55% 自动恢复）；Business Recovery 0% → **>60%**。

### 6.2 P1（应该 — 验证条件质量）
| 项 | 修改文件 | 风险 | 预计影响 |
|---|---|---|---|
| 5. VERIFY_ALTERNATIVE_STATE 替代态库（login_state 多正则、text 模糊匹配、action_success 状态断言放宽） | `verification.js` handler 增强（不改接口） | 中（可能引入误判，需回归） | VERIFICATION_TOO_STRICT 部分恢复 |
| 6. observationCache 基于 domFingerprint+loadingState 判真无变化 | `observationCache.js` | 低 | 消除时序掩盖 |

**P1 预期**：VERIFICATION_TOO_STRICT（~20–25%）恢复 50%+；cache 误判归零。

### 6.3 P2（后续 — Resolver 泛化，归 Phase 10 Step 5/10C）
| 项 | 修改文件 | 风险 | 预计影响 |
|---|---|---|---|
| 7. resolver score 扩展（label/aria/placeholder/role/nearby text/history） | `tools/resolveSelector.js`、`semanticResolver` | 高（核心解析） | ELEMENT_NOT_FOUND 7% → ≈0% |

> 注：ELEMENT_NOT_FOUND 属 Resolver 泛化范畴（Step 5 设计），本 Step 2 仅将 DOM_CHANGED/STATE_UNKNOWN 流转向，不直接修复 resolver；P2 列此作为 v0.2.1 完整出口的依赖项。

---

## 7. Expected Metric Improvement

> 所有数字为**设计预期**（基于 Step 1 推断占比），非实测。需在 v0.2.1 实施后由真实 benchmark 回填。

| 指标 | Phase 9 实测 | v0.2.1 预期（P0+P1） | 说明 |
|---|---|---|---|
| Business Success | 9% | **≥70%** | 时序类 + 验证松弛恢复后，三闸门通过率上升 |
| VERIFY_FAILED | 65% | **<20%** | 纯时序类自动恢复，剩余为真实失败/未知 |
| Business Recovery | 0% | **>60%** | 修复「重执行错配」，等/重观察路径生效 |
| Real Escalation | 72% | **≤30%** | 时序类不再升级；仅真实失败/未知升级 |
| ELEMENT_NOT_FOUND | 7% | ≈0%（P2 后） | 属 resolver 泛化，本 Step 不直接修复 |
| Repair 尝试成功率 | 66.7% | 维持/提升 | 但「业务恢复」从 0% 跃升才是关键修正 |

### 7.1 出口判定（对照 Phase 9.5 的 A 档标准）
达到 A 档（v0.2 Candidate）需：**Business Success ≥70% + Real Escalation ≤30% + Recovery ≥85% + ELEMENT_NOT_FOUND≈0**。
- P0+P1 解决前三项中的「Recovery / Real Escalation / Business Success（部分）」；
- ELEMENT_NOT_FOUND≈0 依赖 P2（resolver 泛化）。
- **结论**：v0.2.1 完成 P0+P1 后可显著逼近 A 档，P2 补齐后正式达到 A 档候选。

### 7.2 不可逾越的红线（本设计承诺）
- 不修改 runtime 核心执行流（仅接入失败分支与 before 快照）。
- 不改变 success 定义（Business Success = Execution + Verification + NoEscalation）。
- 不引入 mock / attachPlan / fallback。
- 新模块（classifier / intelligence）为**独立纯函数 + 轻量编排**，可单测、可回归。

---

*文档结束。本 Step 2 仅完成设计，未修改代码、未运行 benchmark、未实现任何修复。等待下一步授权（Step 3 / Step 5 等）。*
