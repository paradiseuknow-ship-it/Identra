# 最小修复轮报告（P4/P5 planner 契约 + E1 动作链持久化 · 2026-09-01）

前置：DUAL_CALIBER_EVIDENCE_AUDIT_REPORT.md（双口径审计，真缺口=2：rw.094/rw.083）。
授权链：用户指令「只有确认属于 Agent 本身的问题，才进入下一轮代码修复」→ C 专项已确认。

## 1. 改了什么

### ① planner.js — P4 语义放大禁令 + P5 等待/观察证据契约（rw.094 铁证驱动）
在 ACTION_CONSTRAINTS（单源，经 PLANNER_INSTRUCTIONS 注入每次规划）新增两条：

- **P4**：子目标必须与 objective 同粒度。「查看/确认 X 数量/状态/文本」类观察目标必须通过观察页面现有元素完成，禁止放大为「打开 X 页面」等元素清单中不存在的页面实体。
  → 直指 rw.094 铁证：objective「查看购物车数量」被 planner 放大为「打开购物车页面」（fixture 无该页，只有 id=cart 计数条），进入无效修复循环直至 ESC。
- **P5**：等待异步渲染类步骤的验证证据必须指向「渲染后必然出现的内容」，禁止臆造「加载完成/内容已就绪」类页面从未承诺出现的文案；不确定时用 action_success 或验证页面骨架元素。
  → 覆盖 rw.083 的最可能失败路径（等待步骤的期望证据永不出现 → 观察窗口 3×3 次重验证全部落空）。

### ② phase10Benchmark.js — E1 步骤级动作摘要（工程发现 E1 驱动）
- 新增纯函数 `buildActionsSummary(steps)`：每步输出 `{i, type, desc(≤60字), status, verif}`；
- runScenario 返回记录新增 `actions` 字段 → **jsonl / 最终 JSON perTask / worker WORKER_RESULT 全链路自动携带**（append 原样透传，零接线改动）；
- 绝不透出 action.value 明文（摘要只取 type/description/status/verification.type）。

### ③ rw.083 readiness 修复 — 暂缓（证据归因纪律）
search_lazy.html 自注释「元素未就绪→恢复等待」路径与跨 run 复现已确认缺口存在，但 dl240 未持久化步骤级动作链，**精确失败动作无法确认**（fill 未就绪元素？等待步骤臆造证据？VIL 决策分类偏差？）。按「假设驱动、验证后再下结论」纪律：先用 ①+② 跑小样本 smoke 拿到 actions 摘要，确认 A/C 类归属后再修——盲修有引入 A3 同类风险。

## 2. 为什么这样修（对齐纪律）

- P4/P5 与 P1/P2/P3 先例同构：prompt 约束层（schema 校验不动），不改变决策语义/Success Definition/验证阈值；
- E1 只增观测字段，判定语义零改动（`DOM_CHANGED ≠ SUCCESS` 等红线不受影响）；
- 不修 rw.094 的动态按钮寻址、不动 verificationWindow（其有界重观察机制经查健全，rw.083 落空的最可能原因是期望证据本身臆造——属 P5 范畴）。

## 3. 文件

- `server/agent/planner.js`（ACTION_CONSTRAINTS +2 行）
- `server/scripts/phase10Benchmark.js`（buildActionsSummary + return 接线 + 导出）
- 测试：`server/scripts/test_planner_constraint_p4.js`（12/0 ×2）、`server/scripts/test_task_actions_summary.js`（18/0 ×2，含接线断言「恰好一处」与明文泄漏断言）

## 4. 测试与回归

- test_planner_constraint_p4.js：12 pass / 0 fail ×2（子进程求值 plannerInstructions() 实际产出）
- test_task_actions_summary.js：18 pass / 0 fail ×2（子进程调用导出纯函数 + 接线断言）
- 双回归（顺序执行 12m57s）：runRegression.js **通过 72 / 失败 0**（新收编 P4/E1 两测试，基线 70/0）+ run_phase9_regression.sh **OK=65 / BAD=0**（基线 OK=63）。零回归。

## 5. 下一步

- **smoke 被硬依赖阻塞**：DEEPSEEK_API_KEY 已从 .env 丢失，审计日志中已脱敏（[REDACTED]）无法恢复。需要 key 后执行 5-10 任务 smoke（rw.094/083/004/027/034），用 E1 actions 摘要完成 rw.083 归因，并验证 P4 对 rw.094 类目标的约束效果。
- smoke 全绿后再评估：是否值得以池 v2 对齐重生成启动新基线（需授权）。
