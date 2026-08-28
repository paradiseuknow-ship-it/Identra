# PHASE 4 — Product Readiness Blocker Closure Report

**生成时间**：2026-08-28
**前置结论**：Product Ready = **B — CONDITIONALLY READY**（来自 STEP 3 决策）
**Live100 已证明**：Verification Intelligence 有效 / HUMAN_ESCALATION −32% / STATE_UNKNOWN −87% / false-success=0 / sensitive safety=0
**本阶段目标**：只解决三个 Blocker（B1 执行层归因、B2 Evidence 遥测缺口、B3 CANCELLED 归因），不新增能力、不改 planner、不改 success definition、不改 benchmark、不改 decision 语义。

---

## 0. 三个 Blocker 与 Phase 4 映射

| Blocker | 描述 | 对应 Phase 4 任务 | 结果 |
|---|---|---|---|
| **B1** | 业务完成率瓶颈在执行层（FAILED 36 + CANCELLED 3 缺乏细粒度归因） | **C1** Execution Failure Taxonomy | ✅ 39/39 全量拆解 |
| **B2** | Evidence Score 生产遥测缺口（store 零捕获 previousObservationDiff，score 全 0.0） | **C2** Evidence Telemetry Repair | ✅ 链路闭合，评分逻辑未改 |
| **B3** | CANCELLED 3 个原因未说明 | **C3** CANCELLED 归因 | ✅ 3/3（100%）归因 |

---

## C1 — Execution Failure Taxonomy（只读执行层归因）

### 业务问题
Live100 的 FAILED/CANCELLED 任务在既有的 `error.code` 层被统一标记为 `VERIFY_FAILED`（`failureType` 多为 `DOM_CHANGED`），形成"粗分类黑洞"：执行层真正的失败根因（元素缺失 / 鉴权墙 / 超时 / 网络 / 权限 / 规划失败 / 工具失败）被验证失败包裹吞噬，无法支撑 B1 的执行层瓶颈定位与后续 beta 准入决策。

### 代码位置
- 新增：`server/agent/executionFailureTaxonomy.js`（纯函数分类器，无副作用）
- 新增：`server/scripts/analyze_phase4.js`（只读后处理，对既有 store 做 C1/C2/C3 归因，不写 raw/store）

### 最小 patch
新增一个只读分类器 `classifyExecutionFailure(signals)`，从既有 runtime 信号（不含任何新采集）映射为 9 类执行失败：
`AUTH_FAILURE / CAPTCHA_OR_HUMAN_CHECK / ELEMENT_NOT_FOUND / TIMEOUT / NETWORK_FAILURE / PERMISSION_DENIED / PLANNER_FAILURE / TOOL_FAILURE / UNKNOWN_EXECUTION_FAILURE`。
- **信号分层**避免误判：强信号（`error.message` 验证需求文本 / VIL `failureType` / `agent.diagnosing` 类别 / repair error）优先；弱信号（snapshot 页面可见文本）**仅**用于高精度的 CAPTCHA 识别，避免 SaaS 后台 "权限/登录" 文案造成的误分类。
- **不改任务结果**：分类器仅消费既有数据，不写 store、不调用 LLM/浏览器、不修改 status。

### 测试
`server/scripts/test_phase4_blockers.js`
- 9 类合成信号各命中对应类别（✓ 全 9 类覆盖）
- 对既有 live store 的 39 个 FAILED/CANCELLED 全量分类，分布 `ELEMENT_NOT_FOUND:29 / UNKNOWN_EXECUTION_FAILURE:9 / PERMISSION_DENIED:1`（✓ 39/39）

### 回归
- `computeStats` 业务成功口径（status===SUCCESS）不变（✓）
- `aggregateEvidence`、benchmark 口径、decision 语义均未触碰（✓）

### C1 结果（基于既有 live 数据，只读）
- **总计 39 个 FAILED/CANCELLED 全部拆解**（原 36 FAILED + 3 CANCELLED）。
- 分布：

  | 类别 | 数量 | 占比 | 说明 |
  |---|---|---|---|
  | ELEMENT_NOT_FOUND | 29 | 74.4% | 动态 DOM / SaaS 元素始终未被 VIL 确认（含 3 个 CANCELLED 的执行层根因） |
  | UNKNOWN_EXECUTION_FAILURE | 9 | 23.1% | VIL `DOM_CHANGED/STATE_UNKNOWN` 但无更深执行信号 |
  | PERMISSION_DENIED | 1 | 2.6% | 真实 403/禁止访问 |

- 9 类中 AUTH/CAPTCHA/TIMEOUT/NETWORK/PLANNER/TOOL 在 live 数据未触发（taxonomy 已覆盖，仅本次数据未命中）。
- **结论**：B1 执行层瓶颈主要落在「元素未找到 / 动态 DOM 无法收敛」（29/39 = 74%），指向 Verification/Observation 在动态 DOM 上的精度问题，与 B3 的超时根因同源。

---

## C2 — Evidence Telemetry Repair（不改动评分逻辑）

### 业务问题
STEP 2 报告称 Evidence Score 全 0.0、coverage 仅 0.54，判定为"生产遥测缺口（store 零捕获 previousObservationDiff）"，即 B2。

### 根因（实测定位，非猜测）
对既有 live store 抽查：**`error.observationAfter.previousObservationDiff` 实际含有真实 diff（106/116 个 attempt 非默认）**。因此"=0"并非真实未采集，而是两处**传输/读取断点**：
1. `stepManager.normalizeErrorShape` 透传了 `observationBefore/observationAfter`，但**未把 `previousObservationDiff` 提升到 `error` 顶层** → `error.previousObservationDiff` 恒为 `undefined`。
2. `analyze_live100.js` 只读 `a.error.previousObservationDiff`（恒 undefined）→ 重建证据时 diff 为空 → score 0。
3. （次要）`capturedAt` 为 epoch-ms 数字，`aggregateEvidence.toTs` 用 `Date.parse` 解析返回 `NaN` → `freshObservation` 恒 false。此属评分模块输入解析问题，按冻结边界**不修改评分逻辑**，改在只读分析层做 ISO 兼容。

### 代码位置
- 修复：`server/agent/stepManager.js:160-163`（`normalizeErrorShape` 透传 `previousObservationDiff`）
- 修复：`server/agent/stepManager.js:180`（导出 `normalizeErrorShape` 供测试，仅暴露既有纯函数，运行时行为不变）
- 只读重建：`server/scripts/analyze_phase4.js:28`（`toIso` 将 epoch-ms 转为 ISO）、`:130-149`（从 `observationAfter.previousObservationDiff` 读取真实 diff 并喂入 `aggregateEvidence`，评分函数本身未改）

### 最小 patch
```js
// stepManager.js:160-163 —— 仅字段透传，不新增存储、不改动评分
const diffSrc = (err.observationAfter && err.observationAfter.previousObservationDiff) || err.previousObservationDiff;
if (diffSrc && typeof diffSrc === 'object') out.previousObservationDiff = diffSrc;
```
- **未修改 `verificationIntelligence.aggregateEvidence`**（评分权重/公式/语义全部冻结）。

### 测试
`server/scripts/test_phase4_blockers.js`
- 调用**真实** `normalizeErrorShape`：传入含 diff 的 `observationAfter` → `error.previousObservationDiff` 被透传（✓ 修复原 =0 根因）
- 无 diff 时不误填（✓ 回归干净）
- 链路闭合：透传真实 diff + `capturedAt` ISO 兼容 → 调用未改的 `aggregateEvidence` 得 `score>0` 且 `freshObservation=true`（✓）
- 旧路径（空 diff）得 `score=0`，印证此前 `previousObservationDiff=0` 的观测（✓）

### 回归
- `aggregateEvidence` 未被修改、仍可加载（✓）
- 既有 P3 验证测试不受影响（评分公式未变）

### C2 结果（对既有 live 数据重建，无需重跑）
- Evidence 链路 **Observation → Diff → Evidence → Trace 完整**（chainComplete = true）。
- coverage = **1.0**；其中含真实观察变化（realDiff）的任务占 **47%**（其余为稳定页观察，diff 已知为全 false，属真实"无变化"，非缺失）。
- 分数分布（修复后）：`0.0:53 / 0.1-0.3:3 / 0.31-0.5:14 / 0.51-0.7:16 / 0.71-1.0:14` —— 评分首次产生有意义的区分度。
- **B2 关闭**：所谓"零捕获"实为传输/读取断点，已修复；既有数据可在只读层完整重建证据链路，无需重跑 benchmark。

---

## C3 — CANCELLED 归因（100%，不重新定义 CANCELLED）

### 业务问题
Live100 有 3 个 `CANCELLED`，STEP 2 未给出原因，即 B3。

### 代码位置（只读归因，非修改）
- 分类器：`server/agent/executionFailureTaxonomy.js` 的 `deriveTerminalCause`（仅基于既有 events / task.error 判定，未改动 CANCELLED 语义）
- 归因脚本：`server/scripts/analyze_phase4.js:95-118`（C3 段）

### 根因（数据定位）
`phase10Benchmark.js:126-135` 的 `PER_TASK_TIMEOUT` 默认 **120000ms（120s）** 循环等待，超时即调用 `taskManager.cancel(task.id)` → status=`CANCELLED`、error=`"用户取消"`。
3 个任务均为**动态DOM**场景，执行进入"验证失败（STATE_UNKNOWN / RECHECK_OBSERVATION）→ 修复 VERIFY_RETRY → 恢复 → 新步骤 → 再次验证失败"的**无法收敛循环**，累计执行时长触及 120s 上限被 runner 取消。观测时长：120.7s / 120.8s / 120.8s，与 120s 上限精确吻合。

### 最小 patch
无代码逻辑改动。仅新增只读归因函数 `deriveTerminalCause`，输出 `PER_TASK_TIMEOUT_CANCEL`；CANCELLED 的 `status` 语义与终态判定完全保持不变。

### 测试
`server/scripts/test_phase4_blockers.js`
- CANCELLED 共 3 个（✓）
- 3/3 全部归因为 `PER_TASK_TIMEOUT_CANCEL`（✓）

### 回归
- `CANCELLED` 状态定义、终态集合、取消入口均未改动（✓）

### C3 结果（100% 说明）
| 任务 | 时长 | 执行层根因(taxonomy) | terminalCause | 说明 |
|---|---|---|---|---|
| P9 动态DOM1 | 120.7s | ELEMENT_NOT_FOUND | PER_TASK_TIMEOUT_CANCEL | 搜索框元素在动态加载下始终未被 VIL 确认，验证/修复循环触顶 120s 被取消 |
| P9 动态DOM3 | 120.8s | ELEMENT_NOT_FOUND | PER_TASK_TIMEOUT_CANCEL | 商品列表元素未找到，循环无法收敛，触顶 120s |
| P9 动态DOM4 | 120.8s | ELEMENT_NOT_FOUND | PER_TASK_TIMEOUT_CANCEL | 搜索按钮元素未找到，循环无法收敛，触顶 120s |

- **B3 关闭**：3/3 CANCELLED 根因明确（动态 DOM 元素未被确认 → 验证循环超 120s 预算被 runner 取消），且与 B1 的 `ELEMENT_NOT_FOUND` 主因同源。

---

## C4 — 汇总与结论

### 交付物
| 文件 | 类型 | 说明 |
|---|---|---|
| `server/agent/executionFailureTaxonomy.js` | 新增（只读纯函数） | C1 九类执行失败分类器 |
| `server/scripts/analyze_phase4.js` | 新增（只读后处理） | C1/C2/C3 对既有 live store 的归因，输出 `phase4_blocker_analysis.json` |
| `server/scripts/test_phase4_blockers.js` | 新增（纯测试） | C1/C2/C3 + 回归，23/0 通过 |
| `server/agent/stepManager.js:160-163,180` | 最小 patch | C2 透传 `previousObservationDiff` + 导出既有函数供测试 |
| `phase4_blocker_analysis.json` | 数据产物 | C1 分布 + C2 重算 + C3 归因 |
| `PHASE4_BLOCKER_CLOSURE_REPORT.md` | 本报告 | C4 |

### 三个 Blocker 状态
- **B1 执行层归因**：✅ 已闭合（39/39 拆解；主因动态 DOM 元素未确认 74%）
- **B2 Evidence 遥测缺口**：✅ 已闭合（传输断点修复；链路完整；既有数据可只读重建，无需重跑）
- **B3 CANCELLED 归因**：✅ 已闭合（3/3 = PER_TASK_TIMEOUT_CANCEL，执行根因 ELEMENT_NOT_FOUND）

### 冻结边界合规声明
- ❌ 未新增 Agent 能力；❌ 未重写 planner；❌ 未修改 success definition；❌ 未修改 benchmark；❌ 未修改 decision 语义；❌ 未修改 Evidence 评分逻辑（`aggregateEvidence` 完全未动）。
- ✅ 仅：新增只读分类器 + 只读分析脚本 + 只读测试；对 `stepManager.normalizeErrorShape` 做 1 处字段透传（传输修复，非评分）；未重跑 benchmark、未启动 beta、未自动发布/上线。

### 后续（等待下一步授权，本阶段已停止）
当前仅消除"归因盲区"，**未改变产品就绪等级**（仍为 B）。若要推进 beta 准入，需后续授权执行（不在本阶段范围）：动态 DOM 验证收敛优化、CANCELLED 预算/退避策略、以及基于 C1 分布的执行层修复。按用户指令，本阶段完成后停止，不启动 beta、不跑新 benchmark。
