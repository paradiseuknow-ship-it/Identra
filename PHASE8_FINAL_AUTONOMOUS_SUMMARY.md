# Phase 8 — VERIFY_RETRY 分析与自主推进收尾报告

> 模式：Phase 自主推进模式（用户授权：分析→修改→测试→回归→报告，仅 5 类情况停止）。
> 目标：真实 100-task 基准 Business Success >30% & HUMAN_ESCALATION <30%，再进 Product Ready 评审。
> 本阶段结论：数据驱动的、不触碰冻结红线的代码修复已抵达上限；真实量化被「缺 DeepSeek Key」硬阻塞。

---

## 1. 业务问题

Phase 7 修复后，真实基准（phase3_live100_raw.json，LIVE/deepseek-chat，100 全跑完）中剩余主要失败桶：

| 桶 | 数量 | 性质 |
|---|---|---|
| HUMAN_ESCALATION | 55 | 含 POLICY_BLOCK 20（设计内 CREDIBLE 升级）+ VERIFY_RETRY 23 + 其他 |
| FAILED | 36 | 其中 **27 已被 Phase 7 修复**（非法状态转换崩溃，非真实失败） |
| SUCCESS | 6 | — |
| CANCELLED | 3 | — |

剩余待处理最大桶：**23 例 VERIFY_RETRY 升级**（ecommerce 7 / data_entry 9 / longflow 6 / saas 1），全部 `repairCount>0`（已尝试修复但验证仍不匹配），平均 verificationPassed 1.39 / total 5.04。

## 2. 根因分析

23 例 VERIFY_RETRY 的本质是「action 已执行但 verification 仍未确认」。可能根因有三：
1. **resolver 匹配强度不足**：语义/字段未命中真实元素（Phase 6.3 的 CSS 回退已覆盖 CSS 形态 target，但自然语言语义仍未完全覆盖）。
2. **验证 success 语义过严**：`verification.js` 的 `ok = cands.length > 0` 判定（冻结红线，禁止修改）。
3. **导航/条件渲染未稳定**：部分步骤 action 在页面未挂载完成时执行（Phase 6.4 的 `waitForPageReady` 已缓解）。

由于 `phase3_live100_raw.json` 仅持久化聚合计数（`actions`/`verifications` trace 为空），无法做逐步骤取证；且 `verification.js` 成功逻辑属**禁止修改**项，进一步调 resolver 属于「无真实基准量化的盲调」，可能悄然改变 success 语义。

## 3. 修改文件

**本阶段未新增代码修改。** 理由：
- 触及 `verification.js` 成功逻辑 = 违反冻结边界（禁止：verification success logic / success definition）。
- 在未跑真实基准的情况下改 resolver 匹配强度 = 无度量调参，风险高于收益。

已落地的修复（前序 Phase，均在边界内）：
- `server/agent/pageStateClassifier.js`（新增，Phase 6.1）
- `server/agent/contextGuard.js` + `tools.js` 守卫（新增+patch，Phase 6.2）
- `server/agent/selectorFallback.js` + `semanticResolver.js` patch（新增+patch，Phase 6.3，E1）
- `server/agent/pageReady.js` + `tools.js` patch（新增+patch，Phase 6.4，E2/E4）
- `runtime.js` 3 处最小 patch（Phase 7，状态机崩溃）

## 4. 最小 patch

不适用（本阶段未改代码）。

## 5. 测试结果

- `server/scripts/test_phase7_statetransition.js`：**10/0**（Phase 7 状态机修复）
- `server/scripts/test_phase6.js`：**36/0**（Phase 6 全绿）
- `server/scripts/test_phase4_blockers.js`：**23/0**（回归）
- `server/scripts/test_benchmark_framework.js`：**27/0**（回归）
- `server/scripts/test_runtime_replan_const_regression.js`：**PASSED**（回归）

全部既有测试通过，无回归。

## 6. 回归结果

冻结边界合规（测试显式断言）：
- ✅ `verification.js` 成功逻辑（`cands.length>0`）未改
- ✅ `verificationIntelligence.js`（previousObservationDiff 仍 4 处）未改
- ✅ `planner.js` 未重写
- ✅ success definition / benchmark pool / Evidence 评分 / decision 语义 未触碰

## 7. 当前能力提升

| 能力 | 状态 |
|---|---|
| 消除运行时状态机崩溃（27/100 继发性 FAILED） | ✅ Phase 7 已修复，待真实基准量化 |
| 页面状态感知 / 上下文守卫 / selector 回退 / 就绪等待 | ✅ Phase 6 已落地 |
| VERIFY_RETRY 23 例精确修复 | ⏸ 需真实基准驱动，禁止盲调 |
| POLICY_BLOCK 20 例（CREDIBLE 升级） | ⏸ 设计内，非 bug，不改 success def |

## 8. 下一阶段建议（需人工提供 DeepSeek Key 后继续）

1. **重跑真实 100-task 基准**：`DEEPSEEK_API_KEY=sk-... node server/scripts/run_live100.js`（顶部守卫缺 key 直接 exit(2)）。
   - 量化 Phase 6 + Phase 7 的真实收益。
   - 确认是否已达 Business Success >30% & HUMAN_ESCALATION <30%。
2. **若未达标，按真实数据精调 VERIFY_RETRY**：
   - 针对 data_entry(9)/ecommerce(7) 的 field 语义匹配增强（resolver 同义/标签邻近匹配）——在真实基准回归保护下做，绝不改 `verification.js` 成功逻辑。
   - 增强修复环路的导航恢复（recover 后重新 `waitForPageReady`）。
3. **POLICY_BLOCK 20 例**：属设计内 CREDIBLE 升级，需产品决策是否放宽策略，非代码 bug，按冻结边界不擅改。

---

## ⚠️ 自动关机说明

按用户指令「这个模块做完自动关机」执行。本自主代码模块（Phase 6 + Phase 7，数据驱动、零红线触碰、全测试通过）已做完；唯一剩余项「真实 100-task 基准量化」因**当前环境缺 `DEEPSEEK_API_KEY`**（上一轮仅临时注入、未持久化，本地无留存）被硬阻塞——此即用户设定的停止条件「需要人工提供密钥」。

本次自动关机仅为结束本会话算力占用；所有修复代码与报告均已落盘，提供 key 后可在新会话直接重跑基准验证。

- 关机命令（含 60s 宽限期，可 `shutdown /a` 取消）：`cmd /c "shutdown /s /t 60"`
- 提供 key 后的一键基准+关机封装建议：`DEEPSEEK_API_KEY=sk-... node server/scripts/run_live100.js && shutdown /s /t 0`
