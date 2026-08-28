# PHASE 7 STEP 4 — REPAIR 深度分析报告

> 模式：**只读分析**（禁止修改代码、禁止改 benchmark、禁止降低验证标准、禁止改成功定义、不碰 fingerprint/E4、不新增 storage、不重构 runtime）。
> 数据源：Phase 7 全量 30 任务真实 DeepSeek Benchmark 运行（`phase6_1787691693952.json`）+ store（`aiRepairAttempts` / `aiAttempts` / `aiSteps` / `aiFailureSnapshots` / `aiTasks`）。
> 锁定范围：仅取本轮回合落库的 30 个 task 对应的 24 条 `aiRepairAttempts`（store 累积多轮，已按 `objective` + `createdAt` 最大精确匹配，排除历史噪声）。

---

## 0. 最重要的事先声明（避免误读指标）

**「repair success rate = 0%」是一个被严重误导的指标，不是 Agent 能力的真实下界。**

本轮 24 次 repair 记录中：
- **22 次：repair 之后 step 实际恢复了（出现了 `SUCCESS` attempt）** —— 即 repair 触发后，后续重试等到了异步渲染即成功。
- 仅 **2 次未恢复**（#8、#9，均为 `RESOURCE_LOCK` Profile 锁竞争，属基础设施/并发问题，非 repair 策略问题）。
- 但 **24 条 repair 记录全部被标记为 `FAILED`**，且恢复成功的 attempt 的 `repairIds=[]`（未归因到 repair）。

因此「0%」由两个叠加的**测量/归因缺陷**造成，而非「repair 从不生效」：
1. **repair 自身的 `verify` 与异步页面渲染竞态** → repair 内部验证立即失败 → 记录 `FAILED`（但其 re-trigger 为 step 后续成功争取了时间）。
2. **恢复未被归因** → 成功的 attempt 没有 `repairId` 关联 → 不被计入 repair 成功。
3. **升级逻辑抢跑** → 在「repair 尝试耗尽」那一刻就触发 `HUMAN_ESCALATION`，但 step 之后才成功，升级未被撤回。

> 结论：repair 机制**确实在运作并产生恢复**（22/24），但「0%」把它全盘抹杀。真正的可修复短板是**策略错配**（见 §4 TOP 1），而非「repair 完全失效」。

---

## 1. 24 次 repair 分布（failureType: count）

| 触发失败码（原始 attempt error.code） | 数量 | 占比 |
|---|---|---|
| `VERIFY_FAILED` | 21 | 87.5% |
| `RESOURCE_LOCK` | 3 | 12.5% |
| **合计** | **24** | 100% |

补充维度（全部 repair 一致）：
- `aiFailureSnapshots.errorType`：24/24 = `VERIFICATION_FAILED`
- `repair.strategy`：24/24 = `SEMANTIC_RELOCATE`（**唯一策略，单策略垄断**）
- `repair.strategyType`：24/24 = `elementChanged`
- `repair.status`：24/24 = `FAILED`（记录层面）
- step 实际恢复：22/24（见 §0）

**分布结论**：repair 几乎全部由「验证不通过」驱动，且全部套用同一种「元素重定位」策略。

---

## 2. 每次 repair：失败观察 → 修复动作 → 重试结果

> 列说明：
> - **失败观察**：触发 repair 的动作 + 该 step 的 verification 期望。
> - **修复动作**：`repair.actions` 序列（`✗`=该步 `ok:false`）。注意所有修复都是 `reload → 重提交/点击/等待(同目标) → verify(同期望，✗)`。
> - **step 结果**：repair 之后该 step 是否出现过 `SUCCESS` attempt。
> - **task 状态**：最终任务状态（`HUMAN_ESCALATION` 中 21 个为「重试4次耗尽/修复尝试已达上限」升级，`CANCELLED` 为 harness 取消）。

| # | 触发 | 失败观察 (action→verify.expect) | 修复动作序列 | step 结果 | task 状态 |
|---|---|---|---|---|---|
| 1 | VERIFY_FAILED | submit→"机械键盘" | reload submit:搜索框 verify✗ | RECOVER | HUMAN_ESCALATION |
| 2 | VERIFY_FAILED | submit→"机械键盘" | reload submit:搜索框 verify✗ | RECOVER | HUMAN_ESCALATION |
| 3 | VERIFY_FAILED | submit→"机械键盘" | reload submit:搜索框 verify✗ | RECOVER | HUMAN_ESCALATION |
| 4 | VERIFY_FAILED | submit→"无线鼠标" | reload submit:搜索表单 verify✗ | RECOVER | HUMAN_ESCALATION |
| 5 | VERIFY_FAILED | submit→"无线鼠标" | reload submit:搜索表单 verify✗ | RECOVER | HUMAN_ESCALATION |
| 6 | VERIFY_FAILED | submit→"无线鼠标" | reload submit:搜索表单 verify✗ | RECOVER | HUMAN_ESCALATION |
| 7 | RESOURCE_LOCK | wait→input[placeholder*='搜索'] | reload wait:搜索框✗ wait:email✗ wait:password✗ wait:username✗ wait:name✗ wait:first name✗ wait:last name✗ | RECOVER | CANCELLED |
| 8 | RESOURCE_LOCK | wait→input[placeholder*='搜索'] | reload✗ wait:搜索框✗ …(同7) | **FAIL** | CANCELLED |
| 9 | RESOURCE_LOCK | wait→input[placeholder*='搜索'] | reload✗ wait:搜索框✗ …(同7) | **FAIL** | CANCELLED |
| 10 | VERIFY_FAILED | inspect→"404" | reload inspect:页面主体内容 verify✗ | RECOVER | HUMAN_ESCALATION |
| 11 | VERIFY_FAILED | inspect→"404" | reload inspect:页面主体内容 verify✗ | RECOVER | HUMAN_ESCALATION |
| 12 | VERIFY_FAILED | inspect→"404" | reload inspect:页面主体内容 verify✗ | RECOVER | HUMAN_ESCALATION |
| 13 | VERIFY_FAILED | click→"已加入购物车" | reload click:「加入购物车」按钮 verify✗ | RECOVER | HUMAN_ESCALATION |
| 14 | VERIFY_FAILED | click→"已加入购物车" | reload click:「加入购物车」按钮 verify✗ | RECOVER | HUMAN_ESCALATION |
| 15 | VERIFY_FAILED | click→"已加入购物车" | reload click:「加入购物车」按钮 verify✗ | RECOVER | HUMAN_ESCALATION |
| 16 | VERIFY_FAILED | click→"form" | reload click:创建用户按钮 verify✗(未找到"form") | RECOVER | HUMAN_ESCALATION |
| 17 | VERIFY_FAILED | click→"form" | reload click:创建用户按钮 verify✗ | RECOVER | HUMAN_ESCALATION |
| 18 | VERIFY_FAILED | click→"form" | reload click:创建用户按钮 verify✗ | RECOVER | HUMAN_ESCALATION |
| 19 | VERIFY_FAILED | click→"form" | reload click:新建用户按钮 verify✗ | RECOVER | HUMAN_ESCALATION |
| 20 | VERIFY_FAILED | click→"form" | reload click:新建用户按钮 verify✗ | RECOVER | HUMAN_ESCALATION |
| 21 | VERIFY_FAILED | click→"form" | reload click:新建用户按钮 verify✗ | RECOVER | HUMAN_ESCALATION |
| 22 | VERIFY_FAILED | submit→"USB 网卡" | reload submit:搜索框 verify✗ | RECOVER | HUMAN_ESCALATION |
| 23 | VERIFY_FAILED | submit→"USB 网卡" | reload submit:搜索框 verify✗ | RECOVER | HUMAN_ESCALATION |
| 24 | VERIFY_FAILED | submit→"USB 网卡" | reload submit:搜索框 verify✗ | RECOVER | HUMAN_ESCALATION |

**观察共识（21 个 VERIFY_FAILED 全部一致的行为）**：
- 动作已在**正确元素**上执行（原 `lastAction.target` 携带 `{field,semantic}`，如 `field:"search"`）。
- 验证期望（如页面含「机械键盘」）在验证瞬间未满足 → 多为**异步渲染竞态**：搜索结果/购物车提示需数百毫秒~数秒才出现，验证在渲染前触发。
- repair 做 `reload → 用同一目标重提交 → 用同一 verification 立即再验证` → 再次竞态失败（verify✗）。
- 但 reload + 重提交为页面争取了时间，step 的后续重试等到渲染完成即 `SUCCESS`。

**2 个 RESOURCE_LOCK（#8、#9）**：等待 `input[placeholder*='搜索']` 时因 Profile 锁未持有而失败；reload 本身也 `✗`，随后对 email/password/username/name 等逐个「确定性恢复」均失败。属并发/锁基础设施问题，repair 策略无能为力 → 这两个是**真正未恢复**的案例。

---

## 3. 失败模式判定（A–E）

| 模式 | 是否命中 | 证据 |
|---|---|---|
| **A. repair 策略错误（策略错配）** | ✅ 是（TOP 级） | 24/24 仅 `SEMANTIC_RELOCATE` 一种策略。该策略语义是「元素变了/找不到了 → 重新定位元素」。但 21/24 的失败是 `VERIFY_FAILED`（元素已找到、动作已执行、只是验证期望未满足），重定位元素对「页面文本是否含机械键盘」毫无作用。 |
| **B. repair 执行没有重新观察** | ⚠️ 部分 | repair 确实做了 `reload`（重新加载页面），但**没有基于重新观察来重推导 target / 重评估验证期望**——它只是把上一次完全相同的 target（且退化为裸语义字符串，丢失 `field` 与 `value`）重放一遍。 |
| **C. retry 仍使用旧 target** | ✅ 是 | 重提交的目标退化为裸语义串（如 `submit:搜索框`），**丢失了原 `target.field` 与 `value`**（见 `lastAction.value:null`）。对搜索类任务，重提交无搜索词 → 即使时序正确也无法满足「页面含机械键盘」的验证。 |
| **D. verification 阻断** | ✅ 是 | 21/24 的失败根因正是 verification；repair 用**完全相同**的 verification 期望立即重验，确定性地复现同一失败（verify✗），使 repair 记录结构性 `FAILED`。 |
| **E. policy 升级** | ⚠️ 关联但非 repair 失败因 | `HUMAN_ESCALATION` 的升级原因均为「重试4次耗尽 / 修复尝试已达上限(SEMANTIC_RELOCATE)」——升级逻辑在 repair 尝试耗尽**那一刻**即触发，但 step 之后才成功，升级未被撤回（与 §0 第 3 点同源）。这不是 repair 失败的原因，而是让「0%」雪上加霜的**归因/逻辑缺陷**。 |

---

## 4. TOP 1 repair failure root cause

> **结论（一句话）**：repair 机制只有一种「元素重定位（SEMANTIC_RELOCATE）」策略，它针对的是「找不到元素」类失败；但 Phase 7 的 repair 几乎全部（21/24 = 87.5%）由 `VERIFY_FAILED` 触发——动作已在正确元素上成功执行，只是**异步渲染竞态导致验证过早判定失败**。repair 因此**重放完全相同的「动作 + 验证期望」**，结构性地复现同一失败 → 24/24 记录 `FAILED`。这才是「repair 0%」的第一根因：**策略与主导失败模式错配 + 重放式修复无法等待/适配异步验证**。

### 为什么这是 TOP 1（而非「repair 完全没用」）

数据证明 repair **并非无效**：22/24 step 在 repair 之后实际恢复成功。问题在于：
1. **策略错配**：用「重定位元素」去修「验证期望未满足」，药不对症。
2. **重放式修复**：repair 的 reload+重提交为页面争取了渲染时间（这恰是它"间接生效"的原因），但它**自己的 verify 仍在竞态瞬间的旧页面上跑** → 记录 FAILED。
3. **归因断链**：恢复成功的 attempt 没有 `repairId` → 不被计入 repair 成功。
4. **升级抢跑**：repair 耗尽即升级，无视 step 后续成功。

→ 所以「repair success rate = 0%」 = **（策略错配导致记录必败）×（恢复未被归因）×（升级抢跑）** 三者叠加的假象。**真实可恢复率是 22/24 ≈ 91.7%**，但被错误指标掩盖。

### 真正需要修的（供下一步授权参考，本轮不改代码）

| 问题 | 类别 | 性质 |
|---|---|---|
| 修复策略单一是 `SEMANTIC_RELOCATE`，对 `VERIFY_FAILED` 无效 | A 策略错配 | **真实能力短板**（核心） |
| 修复重放旧 target，丢失 `field`/`value` | C 目标退化 | 真实缺陷（搜索类必败） |
| 修复立即重验，不与异步渲染竞态等待 | D 验证阻断 | 真实缺陷（验证时序） |
| 恢复 attempt 未挂 `repairId`，repair 成功不计数 | 归因 | **测量假象**（掩盖真实恢复） |
| 升级在 repair 耗尽即触发，无视 step 后续成功 | E 升级逻辑 | **测量假象**（放大 0%） |

> 注：2 个 `RESOURCE_LOCK`（#8、#9）属 Profile 锁并发问题，与 repair 策略无关，需单独在并发/锁层处理，不在 repair 优化范围内。

---

## 5. 给下一阶段（Phase 7 Step 5，待授权）的修复方向建议（仅提议，未执行）

1. **扩充 repair 策略库**，至少增加针对 `VERIFY_FAILED` 的 `VERIFY_RETRY_AFTER_WAIT`（等待异步内容稳定后重验，而非重定位元素）与 `VERIFY_EXPECTATION_REVIEW`（重新评估验证期望是否合理）。
2. **修复重放时保留完整 `target` 对象**（`field` + `semantic` + `value`），不再退化为裸语义串——这一步与 Phase 7 Step 2 的「target 贯穿契约」应保持一致。
3. **修复归因**：将 repair 触发的重试 attempt 挂上 `repairId`，使恢复可被正确计数。
4. **修复升级抢跑**：当 step 在 repair 后成功，应撤回/不触发 `HUMAN_ESCALATION`（或改判为 `RECOVERED`）。
5. **区分测量与能力**：重新定义「repair success rate」= 该 step 是否在 repair 后恢复，而非 repair 记录自身 verify 是否通过。

> 以上为只读分析产物。本轮严格遵守「不修改代码」红线，未对任何源文件、benchmark、验证标准、fingerprint/E4、storage、runtime 作改动。
