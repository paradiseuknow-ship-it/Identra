# v0.2.0-rc1 最终发布评审报告 — 100-Task Real Product Validation

> 生成时间：2026-08-27
> 模式：**真实 DeepSeek + 真实 Chromium**（`simulated=false`，无 mock / fallback / attachPlan）
> 代码冻结：是（`.benchmark/FREEZE_MANIFEST.txt`，139 文件 SHA256 + 冻结池指纹 `97ced9a7…`）
> 数据来源：`.benchmark/phase12_100task_1787778388535.json`（harness 输出）+ `server/data/*.json`（原始 store 累积）
> 运行器后台任务：`7s0NO9`，100 任务串行一次跑完

---

## 0. 结论先行（VERDICT）

# ⛔ C — Not Ready（重大链路 / 真实能力问题）

**本版本不可发布。** 这不是边角缺陷，而是真实业务链路在端到端验证上的系统性失败。

| 优先级 | 指标 | 结果 | 发布门槛（参照） | 判定 |
|---|---|---|---|---|
| 1 | **Business Success** | **5.0%**（交叉校验 **0.0%**） | 70% | ❌ 严重不足 |
| 2 | **Real Escalation** | **67.0%**（67 任务） | ≤30% | ❌ 远超阈值 |
| 3 | VERIFY_FAILED / ELEMENT_NOT_FOUND | 61 / 4 | ELEMENT_NOT_FOUND≈0 | ⚠️ 验证失败为主瓶颈 |
| 4 | Business Recovery / VIL Recovery | 1.1% / **0.0%** | — | ❌ 自愈未产生业务价值 |
| 5 | 场景泛化 / Long Workflow | 全部 3–8% / **4.0%** | — | ❌ 无泛化能力 |
| 6 | Execution Success（辅助） | 54.9% | — | 仅辅助，不作为产品成功替代品 |

**最重要的一句话**：125/125 单元测试全绿证明的是"工程实现正确"，而 100-task 真实基准证明的是"这个 Agent 在真实业务里基本没用"——Business Success 仅 5%，Real Escalation 高达 67%。**工程测试通过 ≠ 产品验证通过。**

---

## 1. 第一优先级：Business Success（真实业务结果）

- 终端 `SUCCESS` 口径：**5 / 100 = 5.0%**
- **交叉校验（原始 `aiTasks` 终态）：0 / 100 = 0.0%**

⚠️ **数据一致性风险（必须在发布前澄清）**：harness 口径的 5% 与原始 store 终态的 0% 不一致。说明至少有 5 个任务被终端状态标为 SUCCESS，却未能在原始任务终态中得到一致印证——可能是恢复/归因逻辑把本应失败的任务标成了成功，或 success 定义在不同层存在偏差。**这个 5% 不能被当作"有 5 个成功"**，应按 0% 对待，并作为阻塞项复盘。

无论取 5% 还是 0%，都远低于任何产品发布门槛（目标 ≥70%）。

## 2. 第二优先级：Real Escalation（真实能力弱点升级）

- **Real Escalation = 67.0%（67 任务）**——超过三分之二的任务因真实能力弱点（验证失败 / 解析失败 / 锁等）升级，而非预期的安全门控。
- Credible Escalation = 14.0%（14 任务，属凭据/支付安全门控，属预期行为）。
- 真实升级率 67% 远超 ≤30% 的健康阈值，说明 Agent 在绝大多数真实任务上**无法自主完成**，只能交人工。

## 3. 能力瓶颈：VERIFY_FAILED / ELEMENT_NOT_FOUND

失败 taxonomy（100 任务）：

| 类别 | 数量 | 占比 |
|---|---|---|
| VERIFY_FAILED | 61 | 61% |
| OTHER | 16 | 16% |
| POLICY_BLOCK（安全门控，预期） | 14 | 14% |
| ELEMENT_NOT_FOUND | 4 | 4% |
| RESOURCE_LOCK | 0 | 0% |
| TIMEOUT | 0 | 0% |
| NETWORK | 0 | 0% |

- **VERIFY_FAILED 是绝对主瓶颈（61%）**：任务能走到"执行动作"，但执行后业务状态验证失败——即 **动作做对了但结果没达成 / 或验证判错**。
- ELEMENT_NOT_FOUND 仅 4%：说明**元素定位不是主要问题**（resolver 工作基本正常），问题集中在"做了动作却没验证出业务结果"。
- 无 TIMEOUT / NETWORK：运行稳定，不是基础设施问题，是**能力问题**。

## 4. 自愈价值：Business Recovery / VIL Recovery

- **Business Recovery = 1.1%**：触发了恢复（retry/repair）的任务中，最终 SUCCESS 的仅 1.1%。
- **VIL Decision Rate = 5.0%（仅 11 次 VIL 决策事件）**：VIL 几乎未被触发——绝大多数验证失败走的是直接失败/升级路径，没进入 VIL 重观察窗口。
- **VIL Recovery = 0.0%**：VIL 参与的少数决策中，**没有任何一次带来恢复成功**。
- Repair Attempt Success = 60.9%（修复动作本身 60.9% 能跑通），但 **Repair Business Recovery = 1.6%**——**修复动作能执行，却几乎从不转化为业务成功**。即自愈机制"看起来在动，但没有产生业务价值"。

## 5. 泛化能力：场景矩阵 / Long Workflow

| 场景 | 成功 | 总数 | 成功率 |
|---|---|---|---|
| saas | 1 | 30 | 3.3% |
| ecommerce | 2 | 25 | 8.0% |
| data_entry | 1 | 20 | 5.0% |
| longflow | 1 | 25 | 4.0% |
| **合计** | **5** | **100** | **5.0%** |

- 四类场景成功率全部落在 3–8%，**无任何一类达到可用水平**，说明失败是系统性的、非场景特有的。
- **Long Workflow 仅 4.0%（1/25）**：长流程多步任务几乎全部失败，Agent 不具备多步业务编排的泛化能力。

## 6. Action → Outcome（辅助诊断）

| 动作 | 成功 | 总数 | 成功率 |
|---|---|---|---|
| inspect | 162 | 266 | 60.9% |
| wait | 149 | 160 | 93.1% |
| navigate | 82 | 143 | 57.3% |
| reload | 15 | 15 | 100% |
| fill | 71 | 215 | 33.0% |
| click | 9 | 62 | 14.5% |
| submit | 1 | 30 | 3.3% |

- `wait`/`reload`/`inspect` 成功率高（这些是观察/等待类，不依赖业务结果判定）。
- **`fill` 33% / `click` 14.5% / `submit` 3.3% 极低**——即使用户交互动作（填表、点击、提交）执行了，最终也只有极少数被验证为业务成功。这与 VERIFY_FAILED 61% 互相印证：**动作能发出，业务结果没达成**。

## 7. 成本与运行

- 平均成本：**$0.0021 / 任务**（DeepSeek 极廉价，成本不是瓶颈）。
- 运行稳定：无 TIMEOUT / NETWORK / RESOURCE_LOCK，100 任务全部跑完、无崩溃。
- Agent Score（harness 口径）：`{planning:96, execution:62, recovery:20, verification:100, autonomy:19, overall:62}`——注意 `verification:100` 是"验证动作覆盖率"，`autonomy:19` 暴露了自主完成度极低，与 Real Escalation 67% 一致。

---

## 8. 阻塞项清单（发布前必须解决）

> 以下为基于真实数据的归因，**不涉及本次任何代码修改**（全程 CODE FREEZE，仅分析）。

**B1（致命）— 业务结果验证闭环断裂**
VERIFY_FAILED 占 61%，但 ELEMENT_NOT_FOUND 仅 4%。说明 Agent 能定位并操作元素，却无法让"业务状态"被验证为达成。根因大概率在：(a) 期望业务状态（contract）推导与真实页面状态不匹配；(b) 验证窗口对"异步业务结果"（如提交后跳转/数据落库）捕获不足。这是 Business Success 5% 的直接原因。

**B2（致命）— 自愈无效**
VIL Recovery 0%、Repair Business Recovery 1.6%。VIL 决策仅触发 11 次（Decision Rate 5%），绝大多数验证失败直接失败/升级，未进入重观察窗口。自愈机制形同虚设，未产生业务价值。

**B3（致命）— 交叉校验不一致**
harness SUCCESS 5% vs 原始 store 终态 0%。success 定义在不同层存在偏差，必须统一口径，否则无法可信判定"成功"。

**B4（严重）— 长流程编排失败**
Long Workflow 4%。多步任务（依赖前序步骤结果、跨页面状态）几乎全失败，缺乏稳定的多步业务编排能力。

**B5（严重）— 关键交互动作业务成功率极低**
submit 3.3% / click 14.5% / fill 33%。即便动作执行，业务验证也极少通过，与 B1 同源。

---

## 9. 下一步路线（按你定的原则：B/C 后不开无休止新 Phase）

当前为 **C**，路线为：

1. **复盘 + 修复阻塞项 B1–B5**（集中在 verificationWindow / VIL / contract 推导 / 长流程编排，**这是真正的工程修复阶段**，与本次冻结验证分离）。
2. **修复后统一 success 口径**（消除 B3 的 5% vs 0% 不一致）。
3. **最后一轮验证**：解除 CODE FREEZE → 修复 → 重新冻结 → 再跑 100-task 真实基准（同池、同口径）→ 出新评审报告。
4. 依据新数据做 A/B/C 决策，达标则发布 v0.2.0。

**不新开 Phase 13/14/15 空转**；以"阻塞项→修复→最后一轮验证→发布"为唯一收敛路径。

---

## 10. 附：冻结与数据完整性声明

- 代码冻结：`.benchmark/FREEZE_MANIFEST.txt`（139 文件 SHA256 + 冻结池 `97ced9a7…`）。运行期间未修改任何 `server/agent/**`、verification、VIL、resolver、repair/recovery、success definition、benchmark 判定逻辑。
- Store 隔离：运行前已备份 `server/data/_phase12_backup` 并清空 6 个分析集合，运行后原始 store 累积全部 100 任务数据供本分析脚本只读消费。
- 本分析脚本 `analyze_phase12.js` 为纯只读，不修改任何冻结代码。
- 指标交叉校验：Business Success 同时以 harness 终端态与原始 `aiTasks` 终态双重计算（见 §1 不一致告警）。
