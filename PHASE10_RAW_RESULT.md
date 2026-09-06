# Phase 9 真实世界验证报告（v0.1-alpha）

> 生成时间：2026-08-31T00:50:29.893Z
> 模式：**真实 DeepSeek**（禁止 mock / fallback / attachPlan）
> Provider：`deepseek` ｜ Model：`deepseek-chat`
> 任务来源：`server/scenarios/real-world/`（100 真实世界任务）

## 1. Executive Summary

**v0.2.0 候选判定：** ⚠️ 继续 Alpha Hardening

- ✅ Completion ≥ 70%
- ✅ Real escalation ≤ 30%
- ❌ Recovery 62% < 85%
- ❌ ELEMENT_NOT_FOUND 5% > 0

## 2. Completion Rate

- 总任务：20
- 成功（终态 SUCCESS）：80.0%
- 失败/升级：4
- Planner 成功率（计划生成）：100.0%

## 3. Human Escalation

| 类型 | 数量 | 占比 |
| --- | --- | --- |
| 总计 | 0 | 15.0% |
| CREDIBLE_BUSINESS（凭据/支付/审批门控，预期安全行为） | 0 | 0.0% |
| REAL（真实业务拒绝：CAPTCHA/OTP/风控；VERIFY_RETRY 已单列不再计入） | 0 | 0.0% |

**升级/失败归因五分类（escalationClass，可由逐任务原始事件链复核）：**

| 类别 | 数量 | 占总任务 |
| --- | --- | --- |
| CREDIBLE_BUSINESS（凭据/支付/审批门控升级（能力边界）） | 0 | 0.0% |
| VERIFY_RETRY（验证反复失败升级（工程型，不计入 REAL）） | 3 | 15.0% |
| TIMEOUT（超时） | 0 | 0.0% |
| CANCELLED（任务取消） | 1 | 5.0% |
| ENGINEERING_FAILURE（元素定位/执行/恢复等工程型失败） | 0 | 0.0% |
| REAL（真实业务拒绝（CAPTCHA/OTP/风控）） | 0 | 0.0% |

## 4. Recovery Analysis

- 触发 repair 总数：13
- repair 成功（归因）：8
- Repair Success Rate：61.5%
- 恢复成功率（触发恢复的任务最终 SUCCESS）：33.3%

## 5. Failure Taxonomy

| 类别 | 数量 |
| --- | --- |
| ELEMENT_NOT_FOUND | 1 |
| VERIFY_FAILED | 3 |
| POLICY_BLOCK | 0 |
| RESOURCE_LOCK | 0 |
| TIMEOUT | 0 |
| NETWORK | 0 |
| OTHER | 0 |

## 6. Performance

- 平均时长：45.7 s / 任务
- 平均成本：$0.0012 / 任务（估算，共 46945 tokens）
- 平均步骤数：3.85
- Agent Score：{"planning":100,"execution":87,"recovery":80,"verification":100,"autonomy":85,"overall":91,"sampleSize":20}

## 7. Phase 6 / 7 / 9 对比

| 指标 | Phase 6/7 (30) | Phase 9 (100) |
| --- | --- | --- |
| Completion Rate | 40.0% (Phase7 含污染) | 80.0% |
| Planner Success | 1.0 (A1 修复后) | 100.0% |
| Execution Success | 64.7% | 75.6% |
| Verification Coverage | 100% | 67.0% (accuracy) |
| Recovery (repair) | 92% (归因) | 61.5% |
| ELEMENT_NOT_FOUND | 0% | 1 任务 |
| Human Escalation | 46.7% | 15.0% (Real 0.0%) |

## 8. 逐任务结果

| 任务 | 类别 | 终态 | 步数 | 验证 | repair | taxonomy |
| --- | --- | --- | --- | --- | --- | --- |
| rw.001 | saas | SUCCESS | 4 | 4/4 | 0/0 | - |
| rw.002 | saas | SUCCESS | 4 | 4/4 | 0/0 | - |
| rw.003 | saas | CANCELLED | 5 | 2/10 | 0/2 | VERIFY_FAILED |
| rw.004 | saas | SUCCESS | 4 | 4/4 | 0/0 | - |
| rw.005 | saas | SUCCESS | 3 | 3/3 | 0/0 | - |
| rw.011 | saas | SUCCESS | 2 | 2/2 | 0/0 | - |
| rw.012 | saas | SUCCESS | 2 | 2/2 | 0/0 | - |
| rw.013 | saas | SUCCESS | 2 | 2/2 | 0/0 | - |
| rw.031 | ecommerce | HUMAN_ESCALATION | 2 | 1/5 | 2/3 | VERIFY_FAILED |
| rw.032 | ecommerce | SUCCESS | 3 | 3/3 | 0/0 | - |
| rw.033 | ecommerce | SUCCESS | 3 | 2/6 | 1/1 | - |
| rw.034 | ecommerce | SUCCESS | 3 | 2/6 | 1/1 | - |
| rw.056 | data_entry | SUCCESS | 5 | 5/5 | 0/0 | - |
| rw.057 | data_entry | SUCCESS | 5 | 4/5 | 0/0 | - |
| rw.058 | data_entry | SUCCESS | 5 | 5/5 | 0/0 | - |
| rw.059 | data_entry | SUCCESS | 4 | 3/4 | 0/0 | - |
| rw.076 | longflow | HUMAN_ESCALATION | 5 | 1/5 | 2/3 | VERIFY_FAILED |
| rw.077 | longflow | SUCCESS | 4 | 4/4 | 0/0 | - |
| rw.078 | longflow | SUCCESS | 2 | 2/2 | 0/0 | - |
| rw.091 | longflow | HUMAN_ESCALATION | 10 | 4/7 | 2/3 | ELEMENT_NOT_FOUND |

---
数据来源：`.benchmark/phase10_1788137429893.json`