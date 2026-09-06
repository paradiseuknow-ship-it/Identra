# SMOKE5 就绪报告：离线取证收口 + P4/P5 执行路径修复（2026-09-01）

## 0. 一句话结论

**smoke 被外部条件硬阻塞（DEEPSEEK_API_KEY 不可用：无 .env、无环境变量）**；本轮完成全部可离线的 evidence/test 工作，并发现一个**直接决定 smoke 有效性的 B 类一致性缺陷**——P4/P5 修复此前根本没到达真实 LLM 执行路径——已修复并验证。smoke 执行器已预置，key 到位即可一键执行。

## 1. 阻塞声明

```
[smoke5] 硬阻塞：DEEPSEEK_API_KEY 不可用（.env 缺失/为空，环境变量未设置）。
```
按纪律：不等待、不重试 API。STEP 1-7 中依赖真实 LLM 的部分全部标注「待 smoke」。

## 2. 关键发现：P4/P5 未到达真实执行路径（B 类缺陷，本轮已修）

**证据链**：
- planner.js L308-311：真实路径 = `provider.plan` → `deepseekPlan`（deepseek.js）
- deepseekPlan 有**完全独立的 system prompt**，含自己的 fill/navigate 条款与 text_present 防臆造一般条款，**但无 P4/P5**
- P4/P5 只写入了 planner.js 的 `ACTION_CONSTRAINTS`（仅 structured fallback 路径 L290 消费）

**含义**：修复轮之后即便跑了 smoke，也验证不了 P4/P5——真实 LLM 收到的 prompt 里没有这两条约束。

**修复（单一事实源，最小侵入）**：
- 新建 `server/agent/plannerContractText.js`：P4_CONTRACT/P5_CONTRACT 文本唯一来源（逐字节等于修复轮原文）
- planner.js：ACTION_CONSTRAINTS 尾两项改为引用共享常量（文本零变化）
- deepseek.js：system prompt 末尾追加 P4/P5（真实执行路径现在携带约束）

## 3. smoke 执行器预置（run_smoke5.js）

- 仅跑 rw.094/083/004/027/034（v1 池），无评分、无 baseline
- evidence chain 全落盘 `.benchmark/smoke5_<ts>/`：planner 原始输出（`plans/*.json`）→ canonical plan（aiSteps 含 action/verification/startedAt）→ attempts 时序 → aiEvents 全量 → repair/replan → final state
- **planner 原始输出取证**：deepseekPlan 新增 `FPB_CAPTURE_PLAN_DIR` 可选捕获（纯增量，默认零写盘；每次 LLM IO 留证含 rawOutput/userPrompt/finishReason）
- rw.083 专项块：等待步骤 expectedEvidence（P5 判定对象）+ attempts/事件时序；缺失字段标 null 不臆造
- 无 key fail-fast exit 2（已实测）
- 目标任务接线已验证：rw.094→ecommerce/search.html(none)、rw.083→search_lazy.html(none)、rw.004→saas/login.html(required)、rw.027→scraping/list.html(none)、rw.034→search.html(none)

## 4. 旧 evidence 离线收敛（STEP 2/3 的可离线部分）

**rw.094（STEP 2）**：dl240 error 字段铁证 —— planner 生成子目标「**打开购物车页面查看数量**」（objective 为观察类「查看购物车数量」，被放大为导航类；fixture 无 cart 页面实体），VERIFY_RETRY 重试 4 次耗尽 → **planner semantic amplification 确证（A 类）**，与 P4 约束精确对应。最终判定待 smoke 验证 P4 后行为。

**rw.083（STEP 3）**：dl240 失败步骤「等待页面懒加载内容完全加载」，verifTotal=5 仅 1 通过；结合探针（基础设施全通过）→ A-F 六分类收敛为 **B/F（expected evidence 臆造 = P5 类）**：fixture 中不存在任何「懒加载完成」指示文案。C（timeout）/D（前置条件）/E（观察时机）均被探针排除。smoke 需对照：P5 后 planner 的 wait 证据 vs 实际 DOM readiness。

## 5. 测试与回归

| 测试 | 结果 |
|---|---|
| test_planner_contract_sync（真实执行路径 system 含 P4/P5 逐字节 + 同源） | 10/10 ×2 |
| test_plan_capture（开启落盘原文 + 关闭零写盘 + 重试每次留证） | 4/4 ×2 |
| test_planner_constraint_p4（文本引用化后不变） | 12/0 ×2 |
| 双回归 A（runRegression.js） | **77/0** |
| 双回归 B（run_phase9_regression.sh） | **OK=70 / BAD=0** |

生产代码修改仅 3 文件：plannerContractText.js（新）、planner.js（文本引用化，语义零变化）、deepseek.js（system 追加 P4/P5 + capturePlanIO 取证开关）。**零判定语义/Success Definition/验证逻辑改动。**

## 6. STEP 8 八问（当前可答部分；标注待 smoke）

1. **rw.094 根因**：planner semantic amplification（旧 evidence 铁证）；P4 已确认到达执行层，效果待 smoke
2. **rw.083 根因**：B/F（等待证据臆造 = P5 类），基础设施已排除；最终确认待 smoke
3. **P4/P5 有效性**：发现并修复「未到达执行路径」缺陷后，才首次具备被真实 LLM 验证的前提；有效性待 smoke
4. **rw.004/027/034 regression**：无新证据；smoke 反向锚点待跑（重点：credentialRef 契约、required/none 不串线）
5. **生产代码修改**：已完成两项最小修改（见 §5），均非判定语义
6. **测试+回归**：见 §5 表
7. **v1 最终能力**：nominal 66%（保真）｜adjusted 88.9%（provisional）｜mismatch 55｜假阳性 26pp（池错配，v2 已源头消除）｜真缺口 2（均 P4/P5 类）
8. **v2 baseline 建议**：Decision Gate 待 smoke。当前证据倾向：若 smoke 证实 P4/P5 生效且无 regression → 建议建立 v2 baseline（`FPB_SCENARIO_DIR=<v2> FPB_POOL_FILE=phase12_pool_v2.json`）；v2 与 v1 数字不可比。**未授权不启动。**

## 7. 下一步（唯一路径）

用户提供 DEEPSEEK_API_KEY → `node server/scripts/run_smoke5.js` → 按 STEP 2-6 逐任务归因 → Decision Gate（STEP 7）。
