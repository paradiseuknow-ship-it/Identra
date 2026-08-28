# Final 100-Task Real Acceptance Report — B1–B5 Fix Phase

**Run ID:** `phase12_100task_1787785122280.json`
**Generated:** 2026-08-27 (real DeepSeek `deepseek-chat` + real Chromium, `simulated=false`, serial, `--timeout 300000`)
**Code state:** CODE FREEZE during run. This report is **read-only analysis**; no code was modified during or after the run based on results.

---

## 0. 一句话结论

**B1–B5 真正解决的是「口径/归因」问题（harness==store 已一致、不再 silent pass），但没有解决「真实业务闭环」问题。** 真实 Business Success = **6.0%**（与修复前的 5% 基本持平），且其中 14 个任务死于一个**与本阶段无关的纯运行时 bug**（`Assignment to constant variable`）。核心瓶颈仍在：**执行层点击/提交几乎不成功（click 4% / submit 10%）+ 验证层永远无法确认成功（verification.window 0%）**。

→ **不是 A（Product Ready）。** 详见第 12 节判定。

---

## 1. 冻结与可比对性（与上一轮 Phase 12 直接可比）

| 项 | 值 |
|---|---|
| 任务池 | SaaS 30 / Ecommerce 25 / Data Entry 20 / Long Workflow 25 = **100** |
| 池 selection sha256 | `97ced9a71215660ebcaed9f628ddaf6babae974b2875003956af6c2664d663d1` —— 与修复前 Phase 12 完全一致 |
| 回归测试 | **157/157 通过**（8 文件全绿）|
| FREEZE_MANIFEST | 已生成，含全部冻结代码 + pool + runner + successMetrics SHA256 |
| Store 隔离 | 内存/智能库（8 个）保留以保可比性；15 个运行时集合清空后由本 run 重写 |
| 运行期纪律 | 未改任何代码、未重跑失败任务、未调 success definition / fixture / scenario |

---

## 2. ✅ SUCCESS AUTHORITY（唯一被真正解决的问题）

权威口径统一为 `successMetrics.isBusinessSuccess(status==='SUCCESS')`，并接入 `consistencyCheck`。

| 口径 | Business Success |
|---|---|
| **harness**（perTask） | **6 / 100 = 6.0%** |
| **store**（aiTasks） | **6 / 100 = 6.0%** |
| **per-task 一致率** | **100/100，差异 = 0** |

**5% vs 0% 的旧账彻底了结。** 这是本阶段唯一被完全证实解决的项，也是 B3（P0）的真正价值。

---

## 3. 四大核心结果（你点名的 4 个）

### 3.1 Business Success = 6.0%（最终产品价值）
- 执行成功 **57.8%**、规划成功 **96.0%** → 系统「知道该做什么、大多能把动作跑起来」，但**只有 6% 真正达成业务结果**。
- 对比修复前 5%：**无实质提升**。B1–B5 没有把执行成功转化为业务成功。

### 3.2 Real Escalation = 67%（系统还欠多少人工）
- **67/100 任务升级到人工**（Real Escalation 67.0%，n=67）；其中 Credible（合理升级）仅 13/100。
- 意味着每 3 个任务就有 2 个需要人接手。这是产品级不可用信号。

### 3.3 VERIFY_FAILED / Business Recovery（B1–B5 是否解决核心瓶颈 → **没有**）
- **VERIFY_FAILED = 66/100（66%）** —— 绝对主导失败模式。
- **Verification accuracy = 36.8%** —— 动作执行后，验证层 63% 判定失败/错误。
- **Business Recovery = 2.2%** —— repair 几乎**不产生真实业务恢复**。
- 结论：**B1–B5 让失败「可被解释」（STATE_UNKNOWN 正确归因、不再 silent pass），但没有让失败「被解决」。** 验证契约推演存在，但验证/观察层本身失效。

### 3.4 harness == store = 6% == 6%，差异 0 ✅（见第 2 节）

---

## 4. Action → Outcome（动作成功后为何没转业务成功）

| Action | 执行次数 | 执行成功 | 执行成功率 |
|---|---:|---:|---:|
| navigate | 105 | 86 | **82%** |
| fill | 169 | 71 | 42% |
| click | 158 | 7 | **4%** |
| submit | 31 | 3 | **10%** |
| inspect | 53 | 11 | 21% |
| select | 5 | 0 | 0% |
| extract | 5 | 0 | 0% |
| wait | 3 | 2 | 67% |
| press/uncheck | 2 | 0 | 0% |

**关键诊断：** 真正"干活"的交互动作 `click` 仅 4%、`submit` 仅 10% 在执行层就失败。导航能成功（82%）说明环境/页面加载没问题，**问题出在「在正确页面上操作元素」这一层**——语义定位 + 动作执行 + 结果确认全线失守。这就是 Business Success 坍塌的根。

---

## 5. VERIFY_FAILED Taxonomy（VIL 最新分类）

来自 `aiEvents` 中 18 条 `ai.verification.decision`（VIL 真实输出）：

| failureType | 次数 | → decision |
|---|---:|---|
| STATE_UNKNOWN | 14 | RECHECK_OBSERVATION ×12 |
| DOM_CHANGED | 4 | RE_EXECUTE ×4 |
| （其余 → HUMAN_ESCALATE） | 2 | HUMAN_ESCALATE |

- `verification.window`：36 次重验证，**成功 0 次（0%）** —— 吸烟枪：验证层**从未成功确认过一次业务结果**。
- 任务级快照 errorType：VERIFICATION_FAILED / CREDENTIAL_MISSING / ELEMENT_NOT_FOUND。

**B2 修复后的回答：** VIL 现在能正确区分「STATE_UNKNOWN（无法判断）」与「DOM_CHANGED（重执行）」，不再 silent recheck（归因质量提升）。但**归因正确 ≠ 问题解决**：STATE_UNKNOWN 占绝大多数，说明系统常常「不知道动作到底有没有生效」，而重验证也永远 confirm 不了。

---

## 6. VIL 因果（recovered ≠ Business recovered）

- repair attempts = 186，repair 动作成功 = 113（**61%**）。
- 但 **Business Recovery = 2.2%**（见 3.3）。
- 即：**repair 动作跑了 61% 成功，却只有 2.2% 真正把业务救回来。** VIL/repair "recovered" 与 "Business recovered" 差距极大——这正是你要求的重点区分。B4 因果链在「重验证/重执行」层面跑通了，但底层执行（click 4%）与观察（window 0%）失效，使任何 recovery 都归于虚功。

---

## 7. Resolver（B5 是否真改善 → **无法确认，测量缺口**）

- `aiElementMemory` 共 81 条，但 **`matchedBy` 字段全部为 `"unknown"`** —— Resolver 的匹配来源遥测**根本没有被记录**。
- 因此 B5「真实任务泛化是否改善」**无法用 matchedBy 数据证实或证伪**，只能说：没有证据表明 resolver 标签被美化（因为标签没写）。
- 建议：后续在 resolver 落点补 `matchedBy`（id/name/aria/placeholder/label/class/semantic）遥测，否则 B5 永远不可测。

---

## 8. 四类场景矩阵

| 场景 | n | Business Success | Real Escalation | VERIFY_FAILED | ELEMENT_NOT_FOUND | POLICY_BLOCK |
|---|---:|---:|---:|---:|---:|---:|
| SaaS | 30 | 1 (3%) | 9 | 19 | 0 | 10 |
| Ecommerce | 25 | 1 (4%) | 24 | 19 | 1 | 0 |
| Data Entry | 20 | 2 (10%) | 17 | 17 | 0 | 0 |
| Long Workflow | 25 | 2 (8%) | 17 | 11 | 2 | 3 |

- **Ecommerce 最糟**：Real Escalation 24/25（96%）——几乎全部需人工，是最高优先级场景。
- SaaS 有 10 个 POLICY_BLOCK（支付/风险任务被正确拒绝，属合理拒止，非缺陷）。
- 四类 Business Success 都在 3%–10%，**无一类达到可用门槛**。

---

## 9. ⚠️ 运行时异常（独立 code bug，非业务失败）

- **14/100 任务**因未捕获异常 `Assignment to constant variable.` 直接 FAILED（rw.001,002,004,005,007,008,009,013,016,022,075,088,090,095）。
- 日志仅记录 `run 未捕获异常，转 FAILED 终态`，**无堆栈**；是 agent runtime 对 `const` 变量重赋值的真实缺陷。
- 影响：这 14 个任务与 B1–B5 无关，属于独立稳定性 bug，**单独把 Business Success 上限从 6% 压到 ~20%（6% + 14%）**。
- 修复后预期 ceiling ≈ 20%，但核心瓶颈（执行/验证）仍在，不会自动到可用线。

---

## 10. 诚实诊断：到底解决了什么 / 没解决什么

**✅ 已解决（可证明）：**
- 口径统一：harness == store，差异 = 0（B3 P0，5% vs 0% 旧账了结）。
- 归因质量：VIL 正确区分 STATE_UNKNOWN / DOM_CHANGED，不再 silent pass（B2）。
- 验证契约推演存在：click→GENERIC_STATE 等 Action→Outcome 映射已落地（B1 代码层）。
- 敏感字段不泄漏明文（B1 安全）。
- 157/157 工程回归无回归。

**❌ 未解决（真实瓶颈仍在）：**
1. **执行能力坍塌**：click 4% / submit 10% —— 在正确页面操作元素这一层失效。
2. **验证/观察失效**：verification.window 0% 成功、accuracy 36.8% —— 永远无法确认业务结果。
3. **Recovery 虚功**：repair 61% 动作成功 → 仅 2.2% 业务恢复（B4 因果链未产生真实价值）。
4. **运行时崩溃**：14% 任务死于 `Assignment to constant variable`（独立稳定性 bug）。
5. **B5 不可测**：resolver matchedBy 遥测缺失。

**回答你的核心问题：**
- 是「验证问题已解决但执行能力不足」吗？—— 部分。验证*归因*解决了，但验证*能力*（确认结果）没解决。
- 还是「B1–B5 仍未闭合真实业务闭环」？—— **更准确的是后者**。B1–B5 把失败变得"可解释、可对齐口径"，但**真实业务闭环（执行→观察→确认→恢复）仍断开**。修复前 5% → 修复后 6%，说明 B1–B5 修复的是"记账方式"，不是"产品能力"。

---

## 11. 发布门判定（A / B / C）

> 注：你下发的 A/B/C 细则文本在传输中被截断（"### A — Product Ready 必须"后缺失）。以下按产品验收常识给出判定，门槛由你最终拍板。

| 等级 | 含义 | 本 run 是否满足 |
|---|---|---|
| **A — Product Ready** | Business Success 达发布门槛、人工依赖可控 | **否（6%，远低于任何合理门槛；Real Esc 67%）** |
| **B — Engineering Ready** | 功能/架构完整，但真实指标不达标 → 列阻塞项 → 修复 → 最后一轮 → 发布 | **勉强可归此类，但阻塞项是"能力级"非"打磨级"** |
| **C — Not Ready** | 重大链路/稳定性断裂 | **更像 C**：执行层 + 验证层 + 运行时崩溃三线断裂 |

**推荐判定：C（Not Ready），且阻塞项是能力级缺口，不是调参能解决。**

理由：Business Success 6% 中，14% 是纯崩溃、66% 是验证失败、执行层 click 4%。这不是"再跑一轮 benchmark 就能好"的状态，而是需要回到执行/观察/验证核心能力做实质性修复。

---

## 12. 下一步（不开新空 Phase，直接列具体修复项）

按你的纪律"不再无限 Benchmark"，建议**冻结 benchmark，转回 Engineering**，优先顺序：

1. **P0 修运行时崩溃**：定位并修复 `Assignment to constant variable`（建议给 runtime 加堆栈 + 用 rw.001 等 14 个 fixture 复现），预期 ceiling 6%→~20%。
2. **P0 修执行层**：click/submit 4%/10% 的根因（语义定位后动作未真正落点 / 元素不可交互 / 表单提交后状态未捕获）。
3. **P0 修验证/观察层**：verification.window 0% 成功 —— 确认 observation 是否在动作后正确重采、契约 evidence 是否可判定；36.8% accuracy 说明契约与真实页面脱节。
4. **P1 修 recovery 价值**：B4 现在只"重验证/重执行"，需让 recovery 真正触发业务状态重建（而非重复已失败的路径）。
5. **P1 补 resolver 遥测**：`matchedBy` 必须落库，否则 B5 永远不可测。
6. **P2 分类处理 POLICY_BLOCK**：SaaS 10 个属合理拒止，可在报告中从"失败"中剥离，避免污染 Business Success 口径。

修复后**再跑一轮 100-task**（同一冻结池，selection hash 不变）做最终验收，届时给出 A/B/C 终判。

---

## 附录：数据来源

- 结果：`.benchmark/phase12_100task_1787785122280.json`（perTask ×100 + summary）
- Store：`.benchmark/_final100_store_backup/`（运行期写入的 aiTasks/aiSteps/aiAttempts/aiRepairAttempts/aiFailureSnapshots/aiEvents 等）
- 运行日志：`.benchmark/logs/final100_run.log`
- 冻结清单：`.benchmark/FREEZE_MANIFEST.txt`
- 报告：`B1_B5_BLOCKER_FIX_REPORT.md`（修复阶段）、本文件（验收阶段）
