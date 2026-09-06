# P2 修复报告：Fix A（evidence 生成约束）+ Fix B（replan step id 冲突）

日期：2026-09-01 ｜ 范围：P2 VERIFY_RETRY 21 事件中的 A3（×12）与 B1（×5）两类 ｜ 性质：B 类一致性/工程缺陷修复 + 确定性守卫（只收紧）

---

## 1. 改了什么

### Fix B — replan 步骤 id 冲突修复（B1 PENDING 残留 ×5 的根因，实锤）

**ROOT CAUSE**（Final100 证据铁证级）：
`normalizeStrictToCanonical` 把 plan 步骤统一重编号为 `step_001..N`；`runtime.tryReplan` 直接
`createStep(planStep.id)` 挂载 replan 生成的剩余步骤（LLM 重新从 step_001 编号）→ 与既有
**已 SUCCESS** 步骤 id 冲突 → `getStep` 命中旧步骤 → 主循环「已终态跳过」逻辑
（runtime.js:524-525 `_liveStatus === 'SUCCESS' → index++`）误跳过 replan 新步骤 → 循环正常
退出 → B.4 收口守卫发现 PENDING 残留 → 任务 FAILED「任务完成但存在未成功步骤」。

铁证：5 个 B1 任务错误中的 id 与步骤位置全部错位——rw.005 step_001(PENDING) 在 pos2、
rw.075 step_001(PENDING) 在 pos9（9/10 成功）、rw.060 step_001(PENDING) 在 pos2、
rw.061 四个 PENDING（step_001..004，与旧 SUCCESS 0..3 完全对应）；rw.061 中唯一成功执行的
replan 步骤恰是 id 无冲突的 step_005（旧 step_005 已被 tryReplan 移除）。机制 100% 吻合。

**修复**（最小改动，不触碰 replan 触发条件/状态机）：
- `stepManager.uniqueStepId(taskId, baseId)`：base 未占用原样返回；占用则追加 `_rp1`
  （再冲突递增 `_rp2`…）；空 base 原样透传（createStep 走 uid 兜底）。
- `runtime.tryReplan`：挂载前对每个 replan 步骤 `clone.id = uniqueStepId(...)`；
  原 id 语义保留（`step_003_rp1` 可读可追溯）。
- `runtime.tryReplan` 导出供测试（吸取 phase10Benchmark secretRefs 接线盲区教训——
  测试必须断言真正会执行的那份接线）。

### Fix A — element 证据 expect 的 CSS 形态确定性守卫（A3 ×12 的确定性子集）

**口径**：semanticResolver 对 element_present expect 同时支持 CSS 形态与语义中文形态，
schema 层无法判定「语义在页面上是否存在」（登录前不可知页面内容 = C 类边界）。确定性
可守卫的子集 = 「长得像 CSS 但语法非法」的形态（rw.065 `id=regForm` 缺 # 前缀）——
这类 expect 执行期语义匹配必然落空 → VERIFY_FAILED，提前到 plan 期拒绝并触发重规划。

**修复**（`schema/plan.js`）：
- `isValidCssSelectorShape`：保守 compound 语法扫描。规则：
  - `looksLikeCss`（与 semanticResolver 同源启发式）命中的 expect 才进入校验；
    **语义中文 expect 完全不受限**（不一刀切禁 CJK）。
  - 属性子句 `[...]` 内允许任意字符（`[aria-label='商品列表']` 合法）；
    括号外禁止 CJK / 裸等号（`id=regForm`、`class=foo` 拒绝）/ 引号残留
    （Playwright 专有伪类如 `:has-text("…")`，语义匹配器不支持，拒绝）。
  - ` >> ` 跨 frame 前缀逐段校验（与 tools.makeLocator 同一寻址方案）；
    纯属性 compound（`[hidden]` 类）合法；括号不平衡拒绝。
- `cssEvidenceViolations`：收集 strict step 中 verification + requiredEvidence +
  forbiddenEvidence 三处的 element_present/element_absent expect 校验；
  错误文案自动进入 planner 重试 hint（validatePlanStrict 既有回灌机制）。
- **三处 prompt 同步**：`PLAN_STRICT_INSTRUCTIONS`（element 证据 expect 契约 + 点名
  id=regForm 反例）、`planner.ACTION_CONSTRAINTS`（P2 element 证据 expect 契约 + 臆造禁令）、
  `deepseek.js` system prompt（同源文本）。

---

## 2. 为什么

- P2 taxonomy（21 全集）排序：evidence 生成约束 ≈14 > PENDING 对账 5。取证推翻了
  「PENDING 对账/计划版本脱节」假说——真实根因是 replan id 冲突（纯工程缺陷，B 类），
  修复后 5 个 B1 全部消除，且不掩盖任何真实未完成工作（B.4 守卫保持原样）。
- Fix A 只做确定性守卫（A3 中「非法 CSS 形态」子集）；臆造语义元素名（rw.082/097/079 等）
  属 C 类边界（登录前无法预知登录后内容）+ LLM 规划质量，由 prompt 契约缓解，
  不做站点类型判定、不做语义层伪造。
- 红线核对：未改 Success Definition / 评分口径 / Verification Success Logic / Evidence Score /
  fixture / escalation 语义。守卫方向只收紧（新增拒绝路径），B13/C4 断言锁定既有路径零混入。

## 3. 文件

| 文件 | 变更 |
|---|---|
| `server/agent/stepManager.js` | +`uniqueStepId`（+导出） |
| `server/agent/runtime.js` | tryReplan 挂载前分配无冲突 id；导出 tryReplan |
| `server/agent/schema/plan.js` | +`isValidCssSelectorShape`/`cssEvidenceViolations`/`CSS_EVIDENCE_TYPES`；validatePlanStrict 接线；PLAN_STRICT_INSTRUCTIONS +1 条契约；导出守卫函数 |
| `server/agent/planner.js` | ACTION_CONSTRAINTS +1 条（P2 element 证据 expect 契约） |
| `server/agent/llm/providers/deepseek.js` | system prompt +1 句（同源文本） |
| `server/scripts/test_replan_step_ids.js` | 新建，12 项 targeted test |
| `server/scripts/test_evidence_selector_guard.js` | 新建，29 项 targeted test |

## 4. 测试（targeted ×2，全绿）

- **test_replan_step_ids.js 12/0 ×2**：uniqueStepId 单元 4 项；tryReplan 接线 rw.061 最小重放
  5 项（关键不变量 B2：挂载后 `getStep(新id)` 必须返回新描述——修复前命中旧 SUCCESS 步骤；
  旧步骤 id/描述/状态零改动；store id 全局唯一；主循环 live 状态必为 PENDING）；二次 replan
  `_rp` 递增 + 无 id 步骤 uid 兜底 + 失败/抛错路径 store 零改动。
- **test_evidence_selector_guard.js 29/0 ×2**：9 种非法形态拒绝（含 rw.065 实证形态、
  requiredEvidence/forbiddenEvidence 路径）；9 种合法形态 + 语义中文 + text_present 中文 +
  element_absent 放行；prompt 三处同源断言（求值后字符串）；既有校验路径零混入。
- 途中修 3 个测试自身缺陷（守卫器引号闭合重开 bug、A4 前置错位、ACTION_CONSTRAINTS 类型），
  生产守卫器 bug 已修并锁定。

## 5. 回归 + 5-task 真实 LLM smoke

**双回归（顺序执行）**：
- `runRegression.js`：**65 通过 / 0 失败**（62 基线 + P1 新测试 + 2 新测试自动收编）
- `run_phase9_regression.sh`：**OK=58 / BAD=0**（55 基线 + 3 收编）
- 零语义回归。

**5-task 分层 smoke**（真实 DeepSeek，`phase12_tag_p2fix_smoke`，0 轮询一次跑完，9m19s）：

| 任务 | 分层 | 历史 P2 形态 | 本次结果 |
|---|---|---|---|
| rw.005 | required 登录 | **B1 PENDING 残留 FAILED** | ✅ **SUCCESS**（Fix B 实证） |
| rw.060 | 表单（none） | B1 PENDING 残留 FAILED | CANCELLED=TIMEOUT（120s harness deadline 工程口径，非用户取消） |
| rw.065 | 多步骤 | A3 id=regForm 非法 selector | CANCELLED=TIMEOUT（同上） |
| rw.091 | payment/high-risk 长 objective | P1 截断形态（已修） | CANCELLED=TIMEOUT（同上） |
| rw.094 | 多步骤搜索+加购 | A2 中文语义当 selector | CANCELLED=TIMEOUT（同上） |

链路验证结论（按授权「只验证链路不评分」）：
- **Planner 5/5 = 100%**：无 JSON parse failure（P1 修复保持），无截断。
- **「任务完成但存在未成功步骤」= 0 次**（Final100 同类任务 5/5 触发）→ B1 修复实证。
- **CSS 守卫拒绝文案 0 次**且 planner 全成功 → 守卫未误伤合法规划；schema gate 未绕过。
- **Escalation 0（Credible/Real 均 0）**：required(rw.005) 凭据正常走 credentialRef、
  none 任务零串线、无 CREDIBLE 误升级污染。
- **TIMEOUT 分类语义正确**：4 个 CANCELLED 全部带 `benchmark_deadline` 标记归 TIMEOUT
  （Fix#2 语义保持），与修复无关——多步骤任务撞 120s 固定 harness deadline（已知工程口径；
  `--timeout` 参数不影响该 deadline，属 harness 常量，本轮不改）。
- Avg latency 108.2s / Avg cost $0.002。

## 6. 下一步（需用户新授权）

1. **harness per-task deadline 可配置化评估**（120s 固定值让 ≥4 类长任务 smoke 只能跑到一半；
   属 benchmark harness 范畴，按纪律不在评估周期中途改动）。
2. 以 Fix A/B + P1 修复重跑 **100-task 业务基线**（预期：B1 5 任务挽回 ≈+5pp，A3 非法
   selector 子集挽回；Planner 98%→~100%）。
3. C 类边界（臆造语义元素/文案）保持单列，不做语义层修复。

---

## 7. 追加：Fix A1 — navigate 冒充 fill 守卫（2026-09-01 晚，同授权范围）

### 7.1 改了什么

**ROOT CAUSE**（taxonomy A1 / rw.099 铁证）：step 描述「在搜索框中输入商品关键词」但
`action=navigate`，`verification=element_present input#q`（输入框存在即过，值从未输入）
→ step_002 点击搜索时 q 为空 → `text_present "机械键盘"` 恒假 → VERIFY_FAILED ×4。

**修复**（确定性窄口径，只收紧）：
- `schema/plan.js` 新增 `navigateFillViolations(s)`：
  - 判定 = **组合动词短语模式**（在…框中输入 / 输入…到…框 / 填写…表单|字段 /
    英文 fill/enter + field noun）——避免「输入框正常展示」类名词短语误报；
  - semantic 与 expectedResult **part 级独立判定**（一个 part 的导航词不遮蔽
    另一个 part 的 fill 语义）；
  - part 内含**导航宾语**（网址/地址栏/URL/页面/访问/跳转/打开）则该 part 保守放行
    ——「输入网址」「在地址栏输入网址并访问」等合法导航零误伤。
  - 接线 `validatePlanStrict`（Fix A CSS 守卫之后，多错误共存不挤占）。
- prompt 三处同源：`PLAN_STRICT_INSTRUCTIONS`（navigate 契约条目）、
  planner `ACTION_CONSTRAINTS`（navigate 冒充 fill 禁令）、deepseek system prompt。
- 导出 `navigateFillViolations` 供测试。

### 7.2 文件

- `server/agent/schema/plan.js`（守卫 + 接线 + strict 指令 + 导出）
- `server/agent/planner.js`（ACTION_CONSTRAINTS 同步 1 条）
- `server/agent/llm/providers/deepseek.js`（system prompt 同步）
- `server/scripts/test_a1_navigate_fill_guard.js`（新建，21 项）

### 7.3 测试与回归

- targeted：`test_a1_navigate_fill_guard.js` **21/0 ×2**
  （A 组 8 拒绝：rw.099 铁证重放/三种中文动词短语/英文两形态/strict 接线/part 级独立判定/
  与 Fix A 多错误共存；B 组 8 放行：URL 宾语/地址栏/纯导航/名词短语非命中/fill 动作不受限/
  整 plan 合法；C 组 5 契约：三处 prompt 同源 + 既有校验零混入 + 纯函数边界）。
- 相邻守卫零回归：Fix A 29/0、Fix B 12/0、P1 空集 32/0。
- 双回归（顺序）：runRegression.js **66/0** + run_phase9_regression.sh **OK=59/BAD=0**
  （新测试自动收编，零语义回归；新基线）。

### 7.4 rw.099 真实 LLM smoke（`phase12_tag_a1_guard_smoke`）

| 证据 | 结果 |
|---|---|
| 任务状态 | CANCELLED=TIMEOUT（120s harness deadline，`benchmark_deadline` 标记，工程口径） |
| step_001 | navigate「打开商品搜索页面」→ **SUCCESS**（守卫零误伤） |
| step_002 | 「在搜索框中输入关键词」→ **fill SUCCESS**（Final100 中同语义曾是 navigate 冒充、值从未输入 → A1 核心实证） |
| step_003 | click「点击搜索按钮提交表单」→ **SUCCESS** |
| step_004 | OBSERVE「检查页面是否显示搜索结果或提示无记录」→ HEALING 时被 deadline 截断 |
| Planner / Escalation | 100% / 0（Credible 0、Real 0）；Avg cost $0.0012 |

结论：A1 守卫在真实 planner 上零误伤，planner 按契约将输入语义正确落为 fill 且真实执行成功；
业务链前 3 步（导航→输入→搜索）真实完成，仅观察步骤被 120s deadline 截断（B2 工程口径，
与修复无关）。

### 7.5 下一步（需用户新授权）

1. harness per-task deadline（120s 固定值）可配置化评估——rw.099 的观察步骤与 4 个 smoke
   任务均被其截断，是当前 smoke「无法看到最终业务结果」的唯一剩余瓶颈。
2. 以 P1 + Fix A/B + Fix A1 重跑 100-task 业务基线。

---

## 8. 追加：harness per-task deadline 可配置化（2026-09-01 晚，B2 工程瓶颈消除）

### 8.1 改了什么

**ROOT CAUSE**（上一 smoke「--timeout 未生效」的真相）：120s 从来不是硬编码常量——
`phase10Benchmark.js` 的 `PER_TASK_TIMEOUT` 本就支持 `--timeout` 参数；但 smoke 走
`phase12Benchmark`（worker 子进程复用 `phase10.runScenario`），phase10 的 deadline 只从
**自己的 argv** 解析，phase12 的 argv/env 传不进去 → 恒 120000ms。

**修复**（只加配置入口，默认语义零变化）：
- `phase10Benchmark.js`：deadline 解析序 = argv `--timeout` 显式优先 → `FPB_TASK_DEADLINE`
  env 回退 → 120000 默认；解析失败/0/负数一律回退默认（T3b 抓到负数 truthy 边界缺陷）。
  `PER_TASK_TIMEOUT` 加入导出（可审计面）。
- `phase12Benchmark.js`：新增 `--task-deadline <ms>` CLI 入口 → require phase10 **之前**
  预设 env（时序契约：P9 模块加载时即读取）→ spawn `env: process.env` 全量继承至 worker
  （worker 零改动）。hard deadline 树杀保护垫同步抬高 = max(--timeout, task-deadline + 90s)
  ——保证树杀永远晚于业务 deadline。未设该参数时不写 env（默认路径零副作用）。

### 8.2 文件

- `server/scripts/phase10Benchmark.js`（env 回退 + 导出，1 处解析式）
- `server/scripts/phase12Benchmark.js`（--task-deadline 入口 + env 预设 + 保护垫）
- `server/scripts/test_task_deadline_config.js`（新建，10 项）

### 8.3 测试与回归

- targeted：`test_task_deadline_config.js` **10/0 ×2**——全部断言**求值后的模块级常量**
  （子进程以不同 env/argv require 后读 `PER_TASK_TIMEOUT`，即真正会执行的那份接线）：
  T1 默认 120000 零变化 / T2 env=240000 生效 / T3-T3b env 非法回退（T3b 抓到负数 truthy
  真实缺陷并修复）/ T4 argv 显式优先 / T5 env 预设先于 require（时序）/ T6 保护垫公式 /
  T7 默认路径零副作用 / T8 cancel 文案动态插值 / T9 导出可审计。
- 双回归（顺序）：runRegression.js **67/0** + run_phase9_regression.sh **OK=60/BAD=0**
  （新测试自动收编，零语义回归；新基线）。

### 8.4 5-task smoke 端到端实证（`--task-deadline 240000`，`phase12_tag_deadline_smoke`）

| 任务 | 上轮（120s deadline） | 本轮（240s） | 归因 |
|---|---|---|---|
| rw.005 | SUCCESS | **SUCCESS**（4 步） | B1 修复保持 |
| rw.060 | CANCELLED=TIMEOUT 截断 | HUMAN_ESCALATION（重试 4 次耗尽） | 真实业务终态首次可见 |
| rw.065 | CANCELLED=TIMEOUT 截断 | HUMAN_ESCALATION（重试 4 次耗尽） | 同上 |
| rw.091 | CANCELLED=TIMEOUT 截断 | HUMAN_ESCALATION（VERIFY_RETRY 上限） | 同上 |
| rw.094 | CANCELLED=TIMEOUT 截断 | HUMAN_ESCALATION（VERIFY_RETRY 上限） | 同上 |

- **Deadline 覆盖端到端生效**：4 个此前被 120s 掐断的任务全部跑到真实收敛终态；
  Avg duration 132.9s（>120s 直接证明）。
- Planner 100%、Escalation Credible 0 / Real 0（80% escalation 全部 VERIFY_RETRY 口径，
  与 Final100 已知形态一致，无 CREDIBLE 污染）。
- Business Success 20%（1/5）与上轮持平——deadline 修复不改变业务成败，只消除
  「看不到业务结果」的观测瓶颈；rw.060/065 卡点=提交按钮重试耗尽（执行层真实缺口）、
  rw.091/094=VERIFY_RETRY（C 类边界/验证契约），归因口径已正确分类。

### 8.5 下一步（需用户新授权）

以 P1 + Fix A/B/A1 + deadline 可配置化的完整能力重跑 **100-task 业务基线**——
这是唯一尚未授权的大样本验证；预期 B1 ×5 挽回、A3 非法 selector 子集挽回、
A1 挽回、且全部任务可到达真实收敛终态（不再有 120s 截断型 CANCELLED）。
