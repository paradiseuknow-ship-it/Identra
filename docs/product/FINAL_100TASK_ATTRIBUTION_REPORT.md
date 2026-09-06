# 最终 100-task 归因报告（FINAL RUN）

- **Run 文件**: `.benchmark/phase12_100task_1788130207425.json`
- **执行窗口**: FINAL_RUN_START=2026-08-30T20:55:01Z → 自然结束，EXIT=0，全程 1h55m（无假死拖死、无手工干预）
- **纪律声明**: 本 run 为「最终 benchmark 只允许跑一次」约束下的唯一全量验收；报告完成后进入代码冻结，任何后续修复与再验证均需用户新授权。

---

## 1. 执行摘要

| 指标 | 历史 run5 (…88535) | 历史 run6 (…22280) | **最终 run (…207425)** | 变化 |
|---|---|---|---|---|
| **Business Success** | 5.0% | 6.0% | **40.0%** | **6.7× ↑** |
| Planner Success | 96.0% | 96.0% | **98.0%** | +2pt |
| Execution Success | 54.9% | 57.8% | **67.0%** | +12pt |
| Verification Accuracy | 36.8% | 36.8% | **60.2%** | **+23.4pt** |
| Repair Success | 60.9% | 60.8% | 56.5% | 基本持平 |
| Avg 成本/任务 | — | — | $0.0021 | — |
| Avg 时长/任务 | — | — | 65.8s | — |
| Agent Score | — | — | 76（run11 小样本 99） | — |

结论：五组修复（P1 credentialRef 契约、P2 verification 恒真守卫、cancel deadline、stateReset 证据降级、P3 登录证据契约）在真实 100-task 全量中全部兑现。核心收益来自 **VerifAcc 60.2%**（验证真实性）与 **Business Success 40%**，而非放宽任何成功语义——本 run 全程未触碰 Success Definition、benchmark 聚合口径、fingerprint/Runtime 成功语义。

---

## 2. 最终状态分布与 Taxonomy

### 状态分布（100 任务）
| 状态 | 数量 | 占比 |
|---|---|---|
| SUCCESS | 40 | 40% |
| HUMAN_ESCALATION | 40 | 40%（CREDIBLE 19 + REAL 21） |
| CANCELLED | 15 | 15%（per-task 180s 超时） |
| FAILED | 5 | 5% |

### Taxonomy
| 类别 | 数量 | 说明 |
|---|---|---|
| VERIFY_FAILED | 31 | 验证重试耗尽型（含 CANCELLED 中的 10 个超时归类） |
| POLICY_BLOCK | 19 | **全部为 CREDENTIAL_UNAVAILABLE，非真实凭据错误**（见 §3.1） |
| ELEMENT_NOT_FOUND | 8 | 含 CANCELLED 中的 5 个 |
| OTHER | 2 | 含 rw.095 worker 级失败 |

---

## 3. 升级逐任务核对（核心归因）

### 3.1 CREDIBLE 19 个 = P1 副作用缺陷（新发现，B 类）
**100% 命中同一模式**：19 个 CREDIBLE 任务全部是 `credReq=none`（任务本身无需凭据），final.error 一律为「凭据不可用：credentialRef 不可用（未注册或 vault 未解密）」。

因果链：P1 修复在 planner prompt 输出示例中加入了 `step_002 fill + credentialRef` 行为模板 → planner 在**无凭据任务**上也照猫画虎输出 credentialRef → tools.resolveFill 走 credentialUnavailableError fail-closed（tools.js:856-874）→ runtime.js:234-243 CREDENTIAL_UNAVAILABLE 直送 HUMAN_ESCALATION（CREDIBLE，不进 repair）。

**定性**：
- 不是真实业务升级（页面无任何凭据错误）；
- 是 P1 修复的**副作用**（Q3：引入新不一致——示例模板污染了无凭据场景）；
- 小样本 rw.001-005 全是 required 凭据任务，存在**抽样盲区**，故 1×3/1×5 未暴露。

**候选修复（待授权）**：P1 守卫反向扩展——当任务 credentialRefs 为空而 step 的 fill 带 credentialRef 时判违规、拒绝回灌重试；prompt 示例同步补充「仅当任务提供凭据引用时才输出 credentialRef」。

### 3.2 REAL 21 个 = VERIFY_RETRY 工程型升级（非真实业务升级）
逐任务核对：21 个 REAL 升级 **全部** 是验证重试耗尽（VERIFY_RETRY）转人工，error 为验证类文案；**无任何 CAPTCHA / OTP / 审批类真实业务升级**。

**定性**：这是 escalationSplit 的**口径缺陷**——`/凭据|凭证|审批|支付.*需/.test(final.error)` 粗二分把验证耗尽型工程升级误标为「真实业务升级」。工程失败与可信业务升级的区分在本 run 的原始数据层是正确的（taxonomy 精确），仅在聚合统计的 escalationSplit 环节失真。候选修复：escalationSplit 引入 finalEvent / eventChain 判据，VERIFY_RETRY 单列。

### 3.3 CANCELLED 15 个 = per-task 180s 超时（分类正确）
15 个全部为单任务 180s 超时被 cancel 收割，taxonomy 已正确归入 VERIFY_FAILED 10 + ELEMENT_NOT_FOUND 5，无语义问题。cancel deadline 树杀机制工作正常（收割后下一任务继续，无假死拖死）。

### 3.4 FAILED 5 个
含 rw.095 worker 级 OTHER 失败，其余为执行层确定性失败，量级 5%，非本轮修复目标。

---

## 4. 修复动作有效性实证（run7 停止 → 最终 run）

| 修复项 | 针对问题 | 全量实证效果 |
|---|---|---|
| P1 credentialRef 契约 | required 任务凭据引用缺失/伪造 | required 凭据任务路径修复；但暴露 §3.1 无凭据副作用（19 个） |
| P2 verification 恒真守卫 | expectedBusinessState 恒真判成功 | VerifAcc 36.8%→60.2%，虚假 SUCCESS 消除 |
| cancel deadline 树杀 | 卡死 worker 拖死整轮 | 1h55m 自然完成，EXIT=0，15 超时全部被收割 |
| stateReset 证据降级 | reload 清表单→空提交→page.text 误升 CREDIBLE | 真凭据错误首败即升不受影响；「邮箱或密码错误」类次生污染归零 |
| P3 登录证据契约 | LOGIN_SUCCESS 全 URL 证据在 SPA 恒假 | url_contains "dashboard" 类恒假证据在出口被拒绝回灌重试 |

---

## 5. 分类别表现

| 类别 | 任务数 | SUCCESS | ESC | CANCEL | FAIL | Success 率 |
|---|---|---|---|---|---|---|
| data_entry | 20 | 15 | 0 | 4 | 1 | **75%** |
| saas | 30 | 10 | 15 | 2 | 3 | 33% |
| longflow | 25 | 8 | 11 | 5 | 1 | 32% |
| ecommerce | 25 | 7 | 14 | 4 | 0 | 28% |

- data_entry 最强（无凭据依赖、证据简单）；其 4 个 CANCELLED 是主要损耗。
- saas/ecommerce 的 ESC 主要由 §3.1 P1 副作用贡献（credReq=none 任务占比高）。
- longflow 多步链路验证耗尽为主。

---

## 6. C 类边界桶（架构固有，记录不改）

- **登录前无法预知登录后内容**：P3 守卫要求内容类证据，planner 只能臆造（如「数据看板」「项目列表」「工作区」面板名），fixture 不存在该文案 → VERIFY_FAILED。约 2 个 VERIFY_RETRY 即源于此。**分类正确，不阻塞**——这是「证据真实性与可达成性」的固有张力，正解是 fixture 侧提供真实登录后内容或 planner 先探察后规划（下一阶段候选）。
- 纯 headless Worker/UA-CH 层反检测 = C 类（STEP 19 结论，未变）。

---

## 7. 成本与运营指标

- 总成本 ≈ $0.21（$0.0021/任务 × 100），总时长 1h55m，20 worker 隔离 spawn。
- Planner 98%：2 个 planner 级失败（含 D5 守卫拒绝回灌耗尽的正确失败）。
- Repair Success 56.5%（略降 4pt）：stateReset 降级使部分任务多走一轮重试（设计意图：宁多试不误杀），属于**用重试预算换分类纯度**的预期代价。

---

## 8. 语义变化声明

本阶段（run7 停止 → 最终 run）修复共引入两类语义变化，均已声明并通过双回归 + 故障注入测试验证：

1. **stateResetByRepair 证据降级**：page.text 来源的 blocking 证据在 reload/back 后降级为保守 replan。方向是「多走重试」，绝不转 SUCCESS；network/pageerror 客观证据不受影响；真实凭据错误首败即升路径不变。
2. **P3 登录证据契约**：LOGIN_SUCCESS 的 requiredEvidence 禁止全 URL 类，出口守卫拒绝回灌。OR 混合放行、纯内容放行、非 LOGIN_SUCCESS 不拦，范围最小化。

未触碰：Success Definition、benchmark 聚合口径、fingerprint/Runtime 成功语义、HUMAN_ESCALATION 转换、verification 放宽。

---

## 9. 回归与测试基线（最终状态）

- `runRegression.js`：**58/0**
- `run_phase9_regression.sh`：**OK=51 / BAD=0**
- cancel 故障注入：**12/0 ×2**
- stateReset+P3 专项测试：**19 用例 ×2 幂等全绿**
- 双回归严格顺序执行，无并行假失败。

---

## 10. 下一步（全部需用户授权，最终 benchmark 已消耗）

按优先级：

1. **P1 副作用反向守卫**（修复 19 个 CREDIBLE 的最大单一损失源）：credentialRefs 为空时 fill 带 credentialRef → 违规拒绝回灌 + prompt 示例补充说明。预期若修复，Business Success 理论上限 ≈ 40% + 19% ×（重试可挽回比例）。
2. **escalationSplit 口径修正**：VERIFY_RETRY 单列，REAL 只保留真业务升级——纯统计口径，不改运行时行为。
3. **C 类边界缓解**：登录后内容先探察后规划（planner 探察步）或 fixture 侧补充真实内容。
4. 遵循纪律：修复 → targeted test → 小样本（扩大凭据分层抽样，消除 rw.001-005 盲区）→ **才允许再跑全量，且需新授权**。

---

*报告人: WorkBuddy · 数据源: `.benchmark/phase12_100task_1788130207425.json`（最终）、`…88535.json` / `…22280.json`（历史基线）、`.benchmark/final_run_start.txt`、`data/evidence/snapshots/`、aiSteps/failureSnapshots。取证受环形缓冲限制（aiEvents 500 条），旧 run 事件已被挤出，以截图与 step 快照为补充证据。*
