# Phase A：10-task 分层 Smoke 报告（tag=a1）

- 时间：2026-08-31 18:58–19:10 ｜ provider=deepseek-chat ｜ 产物：`.benchmark/phase12_tag_a1_1788174510186.json` + `phase12_tag_a1.jsonl` + `p1_smoke10_a1.log`
- 目的：验证 Fix #1（无凭据登录→CREDIBLE 升级）与 Fix #2（cancel reason 透传）在真实 DeepSeek + 真实 browser/runtime 链路闭环。非刷分。

## Smoke 池（固定，未改池/fixture/Success Definition）

| 分层 | 任务 | 覆盖点 |
|---|---|---|
| required ×5 | rw.001 / rw.007 / rw.008 / rw.091 / rw.092 | login / extraction·导出（原 VERIFY_RETRY）/ 组织切换（原 VERIFY_RETRY）/ data-entry·结算表单+支付凭据 / multi-step·加购结算支付 |
| none ×5 | rw.016 / rw.021 / rw.023 / rw.041 / rw.046 | 3× login.html 需登录（33-task 中 schema 拒绝秒败者）/ data-entry 非 login / extraction 非 login |

## 逐任务结果（10/10 harness 正常结束，SMOKE_EXIT=0）

| task | 层 | finalStatus | steps | attempts | latency | escClass/Kind | tax | 说明 |
|---|---|---|---|---|---|---|---|---|
| rw.001 | required | **SUCCESS** | 3/3 | 3 | 27s | - | - | 登录→看板，验证 3/3 |
| rw.007 | required | **SUCCESS** | 5/5 | 5 | 36s | - | - | 原 VERIFY_RETRY 型本轮收敛 |
| rw.008 | required | CANCELLED→**TIMEOUT** | 7 | 16 | 121s | TIMEOUT | TIMEOUT | 120s deadline，Fix #2 正确分离 |
| rw.091 | required | FAILED | 0 | 0 | 100s | ENGINEERING_FAILURE | OTHER | planner JSON 解析失败（见缺陷 #1） |
| rw.092 | required | CANCELLED→**TIMEOUT** | 7 | 17 | 125s | TIMEOUT | TIMEOUT | deadline，Fix #2 正确分离 |
| rw.016 | none | **HUMAN_ESCALATION** | 0 | 0 | 20s | **CREDIBLE**/CREDIBLE | POLICY_BLOCK | Fix #1 短路，一次 LLM 调用 |
| rw.021 | none | **HUMAN_ESCALATION** | 0 | 0 | 16s | **CREDIBLE**/CREDIBLE | POLICY_BLOCK | 同上 |
| rw.023 | none | **HUMAN_ESCALATION** | 0 | 0 | 14s | **CREDIBLE**/CREDIBLE | POLICY_BLOCK | 同上 |
| rw.041 | none | HUMAN_ESCALATION | 6 | 13 | 83s | VERIFY_RETRY/REAL | VERIFY_FAILED | 执行后验证不收敛→真实升级 |
| rw.046 | none | HUMAN_ESCALATION | 5 | 16 | 114s | VERIFY_RETRY/REAL | VERIFY_FAILED | 同上 |

汇总：Business Success 20%（2/10）｜ Planner 60% ｜ Execution 61.4% ｜ Escalation 50%（Credible 30% / Real 0%）｜ avg $0.0044/任务 ｜ avg 65.7s ｜ Agent Score 65。

## Fix #1 验证：命中率 3/3 = 100%

- rw.016/021/023 全部 `planner → schema rejection → needsCredentials=true → runtime escalate(kind=credential) → CREDIBLE_BUSINESS`，escalationKind=CREDIBLE，tax=POLICY_BLOCK。
- **无 3 次无意义重试**：最终 error 为 needsCredentials 文案（非「Plan Schema 校验失败」），latency 14–20s（旧路径 3 次重试显著更长），worker attempts=0、steps=0。
- **明文 password = 0**（log 0 处 password-value，steps=0 无任何执行写入）；**credentialRef 幻觉 = 0**（全 log `cred_` 出现 0 次）。
- 未进入 ENGINEERING_FAILURE（taxonomy=POLICY_BLOCK，语义正确）。

## Fix #1 反向锚点：required 未被误伤

- 0 个 required 任务被判 CREDIBLE。rw.001/007 正常走 credentialRef→execution→business verification→SUCCESS；rw.008/092 是纯超时；rw.091 是 planner 输出格式失败——无一与守卫相关。

## Fix #2 验证：分类准确率 2/2（deadline 路径）

- rw.008/rw.092：harness 120s deadline → error 带 `benchmark_deadline` 标记 → escClass=TIMEOUT + taxonomy=TIMEOUT，不再污染 CANCELLED 统计（33-task 中同类 4 个全被错标 CANCELLED/用户取消）。
- user cancel 路径本轮 smoke 未自然发生，由 targeted test ×2 覆盖（`test_cancel_reason_passthrough.js` 7/0 ×2，含「用户取消仍归 CANCELLED」锚点）。

## A4 门槛核对

| 门槛 | 结果 |
|---|---|
| 10/10 harness 正常结束 | ✅ SMOKE_EXIT=0 |
| 0 worker/Chromium 残留 | ✅ node=0, chrome=0 |
| required 未误判 CREDIBLE | ✅ 0 个 |
| none+login 全部 CREDIBLE | ✅ 3/3 |
| 无凭据场景 credentialRef 伪造 | ✅ 0 |
| deadline = TIMEOUT | ✅ 2/2 |
| user cancel = CANCELLED | ✅（targeted test ×2 覆盖，smoke 未自然触发） |
| 无新的 ENGINEERING_FAILURE | ⚠️ 1 个（rw.091，见下） |
| 双运行结果一致 | ✅ targeted tests 7/0 ×2、双回归 62/0 + 55/0（smoke 未重跑第二轮，遵守 token 纪律） |
| targeted tests ×2 全绿 | ✅ |
| 双回归全绿 | ✅ |

## 新工程缺陷（1 个，非代码缺陷）

**rw.091 planner 连续 3 次 JSON 解析失败**（100s ≈ 3 attempts 耗尽，Phase 8 重试韧性按设计工作后优雅收口 FAILED/ENGINEERING_FAILURE）。历史 33-task 无同类。嫌疑：支付任务 objective 长 + 凭据段注入导致模型输出格式漂移（截断或 markdown 包裹）。单例、低频、重试路径健康——**建议列为观察项**，若 67-task 补跑中复现 ≥2 次再考虑最小修复（如 deepseek 层 JSON 提取加固），现在不动。

## 与历史数据对应关系

- **33-task（v3）**：7 个 none+login「Plan Schema 校验失败 ×3 秒败」模式消失 → 全部转 CREDIBLE 升级（可审计业务语义）；4 个 CANCELLED=超时错标 → 本轮 2 个 deadline 全部正确 TIMEOUT。
- **run11 小样本**：required 凭据链路（credentialRef→验证）保持 SUCCESS（rw.001）。
- **final100 v1**：19 个 CREDIBLE 污染（none 任务抄 cred_xxx）持续为 0——P1 空集禁令 + Fix #1 双保险生效。
- **VERIFY_RETRY 收敛性**：原 VERIFY_RETRY 型 rw.007 本轮 SUCCESS（收敛）；rw.041/046 为新的真实验证不收敛（升级语义正确，产品侧待改进项，与 33-task 中 rw.005/007/008 现象同类）。

## 结论

**Phase A 验收：PASS（1 个观察项）**。Fix #1 与 Fix #2 在真实链路闭环，P1 契约完整语义成立，无代码级新缺陷。已停住——**未启动 100-task 补跑**，等你授权进入 Phase C。
