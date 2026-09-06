# 小样本第二轮修复报告（run9 归因 → 修复 → run10/run11 验证）

日期：2026-08-31 ｜ 阶段：⑧双回归 + ⑨小样本（含 run9 实证驱动的新一轮最小修复）
纪律锚点：禁止 100-task 循环调试；最终 benchmark 只跑一次（未启动）；小样本是允许的验证手段。

---

## 一、本阶段结论（TL;DR）

1. **⑥⑦ cancel 故障注入测试 ×2 全绿**（12 用例 ×2 幂等），cancel 最小修复零业务判定改动。
2. **⑧ 全量双回归三次全绿**：runRegression.js **58/0**（三次）+ run_phase9_regression.sh **OK=50→51 / BAD=0**（三次，顺序执行）。
3. **⑨ 小样本三轮**：
   - run9（1×5）：**0/5 SUCCESS + 5 个 CREDIBLE 升级** → 深度归因发现 2 个真实缺陷（B 类）；
   - 修复后 run10（1×5）：分类污染清零（Credible 0%）；
   - 修复后 run11（1×5）：**Business Success 60%（3/5）> 30% 门槛**，Escalation Credible/Real 全 0（分类纯度 100%），Execution Success 93.3%，Agent Score overall 99。
4. 剩余 2 个 VERIFY_FAILED 为 **C 类固有边界**（fixture/objective 语义不匹配 + 登录前无法预知登录后内容），分类正确、非代码缺陷、非本次修改引入。

## 二、run9 深度归因（事件链 + 截图证据）

以 run9 rw.001 为样本还原完整链路：

| # | 事件 | 证据 |
|---|------|------|
| 1 | P1 修复**完全生效** | fill email/password 的 action.credentialRef=cred_mtg7nibrybv9，无 value 编造 |
| 2 | 登录**真实成功** | 第一次 click 后截图：email=ops@cloudsaas.io、密码已填、**「数据看板」面板已显示**、无错误文案 |
| 3 | 但验证判失败 | planner 生成的唯一证据 `url_contains="dashboard"`，fixture 为 URL 不变 SPA → **恒假** → VERIFY_FAILED |
| 4 | repair 链放大 | replan → waitLong → **reload（清空表单）** → 第三次 click = 空表单提交 |
| 5 | 次生文案误判 | fixture 显示「邮箱或密码错误」→ businessErrorDetector 从 page.text 匹配凭据正则 → **误判 BUSINESS_INVALID_CREDENTIAL（CREDIBLE）升级** |

**两个真实缺陷（B 类）**：
- **层2（分类污染，违反「工程失败与可信升级严格区分」）**：repair reload 自己制造的次生错误文案，被当成对原始凭据的业务判定 → 工程失败（VERIFY_FAILED）被标成 POLICY_BLOCK/CREDIBLE。
- **层1（证据恒假陷阱）**：planner 习惯性为 LOGIN_SUCCESS 生成单条 `url_contains "dashboard"`；run10 复跑证明纯 prompt 引导不足以约束 LLM。

## 三、修复内容（全部 B 类最小修复）

### 修改 1：stateResetByRepair 证据降级（分类纯度）
- `server/agent/recovery/recoveryManager.js`：runPreAction 执行 reload/back 后按 `executionId::stepId` 标记状态重置（Set 上限 5000 防泄漏）；诊断时把 `stateResetByRepair` 传入 failureDiagnoser；导出 `hasStateResetRepair`/`runPreAction` 供测试断言。
- `server/agent/diagnosis/failureDiagnoser.js`：`stateResetByRepair=true` 时，**page.text 来源的 blocking 证据降级**（不作为业务性「不可重试」判定依据），pick 回落 category 保守 replan；network/pageerror 等客观证据不受影响；`fromObservation` 透传该参数。
- **关键性质**：真实凭据错误在第一次失败时（reload 未发生）即正常升级——本修复不影响该路径；降级方向是「多走一轮重试」而非「转 SUCCESS」，不触碰验证门槛。降级文案刻意不含「凭据/凭证/审批」字样（防 escalationSplit 的 final.error 文本匹配回染 CREDIBLE）。

### 修改 2：P3 登录证据契约（LOGIN_SUCCESS 仅 URL 证据守卫）
- `server/agent/planner.js`：新增机械出口守卫 `urlOnlyEvidenceViolations`（P1 同款模式）——`stateType=LOGIN_SUCCESS` 的 `requiredEvidence` **全部为 URL 类证据**时拒绝并回灌重试（最多 3 次）；OR 混合信号（URL+内容类）放行；纯内容类放行；非 LOGIN_SUCCESS 不拦（范围最小化）。planObjective 在 validatePlan 通过后集成。
- prompt 三处修正：ACTION_CONSTRAINTS 新增「P3 登录证据契约」规则行；url_contains 引导补充「确信 URL 会跳转才用」；输出示例 step_003 从 `url_contains dashboard` 改为 `element_present dashboard`（行为模板去毒）。
- `server/agent/schema/plan.js`：PLAN_STRICT_INSTRUCTIONS 同步登录证据契约行。
- 与推导合约设计对齐：verification/contract.js 的 login 合约本来就是 6 条 text 类 OR——planner 单条 url_contains 是对多信号设计的退化。

### 修改 3：针对性测试
- `server/scripts/test_state_reset_evidence_guard.js`（新建）：**19 用例 ×2 幂等全绿**。
  - A 组 ×7：诊断降级行为（降级/原路径保持/network 不降级/无文案不误降/fromObservation 透传/未标记不误降/降级文案无 CREDIBLE 触发词）。
  - B 组 ×3：runPreAction reload/back 标记、waitLong 不标记、step 间隔离。
  - C 组 ×2：planner prompt 求值断言（引导句存在、示例不再示范 url_contains dashboard）。
  - D 组 ×7：P3 守卫单元（单条 URL 违规/OR 混合放行/纯内容放行/非 LOGIN_SUCCESS 不拦）+ planObjective 集成（违规拒绝回灌 3 次/合规通过）+ prompt 规则行。

## 四、回归与小样本对比

| 验证 | 结果 |
|------|------|
| runRegression.js（修复后 3 次） | **58/0**（含新测试纳入） |
| run_phase9_regression.sh（修复后 3 次） | **OK=51 / BAD=0** |
| test_state_reset_evidence_guard.js ×2 | **19/0 ×2** |
| run9（修复前 1×5） | SUCCESS 0%，CREDIBLE 5/5（污染） |
| run10（降级修复后 1×5） | SUCCESS 20%，CREDIBLE **0%**，VERIFY_FAILED 4 |
| **run11（全修复后 1×5）** | **SUCCESS 60%，CREDIBLE 0%，REAL 0%，VERIFY_FAILED 2，Execution 93.3%，Agent Score 99** |

## 五、剩余 2 个 VERIFY_FAILED 的归因（C 类边界，不阻塞）

- rw.003「登录后进入项目列表」：登录成功但 fixture 登录后只有「数据看板」面板，**页面上不存在项目列表内容**；LLM 臆造 `element_present="projectList"`（objective 语义推导）→ 永远找不到。
- rw.005「使用邮箱密码登录工作区」：LLM 猜 `text_present="工作区"`，fixture 实际文案是「数据看板」/「CloudSaaS 控制台」。
- 根因：**登录前的页面观察无法提供「登录后才出现的内容」的真实标识**（守卫已正确强制证据含内容类，但内容类 expect 只能凭 objective 语义猜测）；叠加部分任务 objective 的目标内容在 fixture 中不存在。
- 分类正确（VERIFY_FAILED 工程失败桶，非 POLICY_BLOCK 污染）；run7 时代 rw.003 也是升级/失败，非本次修改引入。100-task 最终报告中应单列该桶。

## 六、语义变化声明

1. stateResetByRepair：修复后，reload/back 之后的页面文本 blocking 证据不再触发业务性升级（多一轮重试，最终仍失败则按 VERIFY_FAILED 归类）。真实凭据错误首败即升级路径不变。
2. P3 守卫：LOGIN_SUCCESS 的 URL-only 证据计划会被拒绝重规划（最多 3 次后失败）。OR 混合与纯内容类证据不受影响。
3. 未触碰：Success Definition / benchmark 聚合口径 / verification 评估逻辑 / Runtime 主循环 / 指纹层 / secretManager / 明文注入红线。HUMAN_ESCALATION/TIMEOUT 未转 SUCCESS。

## 七、下一步（等待授权）

按交付顺序 ⑩：**最终一次 100-task 需用户授权后才启动**。启动口径（不变）：冻结池 / 真实 DeepSeek / 不 mock / 不改 Success Definition / 不改聚合口径 / 每任务独立 worker + hard deadline。完成后输出 ⑪ 最终归因报告（五档指标 vs Phase 5/6/7/8 基线、升级 taxonomy 逐任务核对、VERIFY_FAILED 边界桶单列）。

## 附：关键证据文件

- run9：`.benchmark/run9_small5_stdout.log`、`phase12_100task_1788118927877.json`
- run10：`.benchmark/run10_small5_stdout.log`、`phase12_100task_1788121616402.json`
- run11：`.benchmark/run11_small5_stdout.log`、`phase12_100task_1788123069319.json`
- run9 rw.001 截图（登录真实成功 + reload 后次生错误文案）：`data/evidence/snapshots/task_mtg7nif6ojyhx/step_003_verification_failed_*.png`
- 双回归：`.benchmark/regression_1788122010226.log`（58/0）、`.benchmark/phase9_regression_20260831_043810.txt`（OK=51）
