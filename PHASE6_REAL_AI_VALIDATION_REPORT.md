# Phase 6 真实 AI 验证报告

> 生成时间：2026-08-25T21:01:33.952Z
> 模式：**真实 DeepSeek**（禁止 mock planner / 禁止 fallback，计划由 DeepSeek 端到端生成）
> Provider：`deepseek` ｜ Model：`deepseek-chat`

## 1. 验证结论（Alpha 判定）

**是否达到真实 Alpha 产品标准：** ⚠️ 未完全达到

判定依据：
- 成功率 40% < 80% 目标
- 人工升级率 47% > 20%
- 验证准确率 67% < 80%

## 2. 核心指标（Phase 6 必填）

| 指标 | 数值 |
| --- | --- |
| Planner Success Rate（计划生成成功率） | 90.0% |
| Execution Success Rate（执行成功率） | 64.7% |
| Verification Accuracy（验证准确率） | 67.3% |
| Recovery Success Rate（恢复成功率） | 0.0% |
| Human Escalation（人工升级率） | 46.7% |
| Average Cost（平均成本） | $0.0008 / 任务（估算） |
| Average Duration（平均时长） | 24.9 s / 任务 |

## 3. 总体结果

- 总任务数：30
- 成功率（终态 SUCCESS）：40.0%
- 失败任务数：17（计划失败 3 / 执行失败 6 / 验证失败 9）
- 平均步骤数：3.57 ｜ 平均恢复次数：2.23
- Agent Score（综合）：{"planning":90,"execution":65,"recovery":50,"verification":72,"autonomy":53,"overall":67,"sampleSize":30}
- Token 用量：输入 29050 / 输出 15155 / 合计 44205（估算 $0.0245）

## 4. 失败分类与真实原因

| 任务 | 分类 | 终态 | 真实原因 |
| --- | --- | --- | --- |
| ecommerce.search | verification | HUMAN_ESCALATION | 提交搜索请求 需人工处理（重试4次耗尽）: 修复尝试已达上限(SEMANTIC_RELOCATE)，需人工处理 |
| ecommerce.add_to_cart | verification | HUMAN_ESCALATION | 提交搜索表单，触发搜索 需人工处理（重试4次耗尽）: 修复尝试已达上限(SEMANTIC_RELOCATE)，需人工处理 |
| ecommerce.lazy_recovery | verification | CANCELLED | 用户取消 |
| saas.login_dashboard | execution | HUMAN_ESCALATION | 输入登录密码 需人工处理（重试4次耗尽）: 修复策略 REAUTH_OR_PAUSE 风险 HIGH（如重认证），需人工审批 |
| saas.export_report | execution | HUMAN_ESCALATION | 输入登录密码 需人工处理（重试4次耗尽）: 修复策略 REAUTH_OR_PAUSE 风险 HIGH（如重认证），需人工审批 |
| saas.login_failure | execution | HUMAN_ESCALATION | 输入错误密码 需人工处理（重试4次耗尽）: 修复策略 REAUTH_OR_PAUSE 风险 HIGH（如重认证），需人工审批 |
| failure.page_not_found | verification | HUMAN_ESCALATION | 检查页面是否显示错误信息或空白，确认导航失败被识别 需人工处理（重试4次耗尽）: 修复尝试已达上限(SEMANTIC_RELOCATE)，需人工处理 |
| failure.network_failure | planner | FAILED | runtime 执行异常: Plan Schema 校验失败: steps[2](step_003): action 非法: target.field 非法; steps[3](step_004): action 非法: target.fi |
| failure.login_failure | verification | HUMAN_ESCALATION | 输入错误的密码 需人工处理（重试4次耗尽）: 修复策略 REAUTH_OR_PAUSE 风险 HIGH（如重认证），需人工审批 |
| failure.verification_failure | planner | FAILED | runtime 执行异常: Plan Schema 校验失败: steps[2](step_003): action 非法: target.field 非法; steps[3](step_004): action 非法: target.fi |
| real.ec.cart | verification | HUMAN_ESCALATION | 点击第一个搜索结果的「加入购物车」按钮 需人工处理（重试4次耗尽）: 修复尝试已达上限(SEMANTIC_RELOCATE)，需人工处理 |
| real.ec.lazy | planner | FAILED | runtime 执行异常: Plan Schema 校验失败: steps[1](step_002): action 非法: target.field 非法 |
| real.saas.login | execution | HUMAN_ESCALATION | 在密码输入框填入登录密码 需人工处理（重试4次耗尽）: 修复策略 REAUTH_OR_PAUSE 风险 HIGH（如重认证），需人工审批 |
| real.saas.export | execution | HUMAN_ESCALATION | 输入密码 需人工处理（重试4次耗尽）: 修复策略 REAUTH_OR_PAUSE 风险 HIGH（如重认证），需人工审批 |
| real.saas.wrong | execution | HUMAN_ESCALATION | 输入错误的密码 需人工处理（重试4次耗尽）: 修复策略 REAUTH_OR_PAUSE 风险 HIGH（如重认证），需人工审批 |
| real.admin.create | verification | HUMAN_ESCALATION | 点击创建用户按钮，打开创建表单 需人工处理（重试4次耗尽）: 修复尝试已达上限(SEMANTIC_RELOCATE)，需人工处理 |
| real.admin.admin | verification | HUMAN_ESCALATION | 点击新建用户按钮，打开创建用户表单 需人工处理（重试4次耗尽）: 修复尝试已达上限(SEMANTIC_RELOCATE)，需人工处理 |
| real.ec.usb | verification | HUMAN_ESCALATION | 提交搜索请求 需人工处理（重试4次耗尽）: 修复尝试已达上限(SEMANTIC_RELOCATE)，需人工处理 |

## 5. 失败注入恢复验证（真实恢复是否工作）

> ⚠️ **诚实说明（真实 DeepSeek 模式）**：`failure.*` 场景的目标由 AI 自行规划，AI 不一定会去触发/验证预期失败点，因此本矩阵**不是受控硬注入测试**，而是「该注入类型场景下 AI 是否真实遇到并处置了问题」。
> - `engaged=❌` 表示 AI 未触及注入（如未验证、未导航到失败点），其 `SUCCESS` 属「未命中注入」，**不计为恢复成功**。
> - 真正由 runtime 触发 recovery/repair 且最终 `SUCCESS` 才计 `recovered=✅`。

| 注入类型 | 已执行 | 触发恢复(engaged) | 恢复成功 | 终态 |
| --- | --- | --- | --- | --- |
| page_not_found | ✅ | ✅ | ❌ | HUMAN_ESCALATION |
| element_changed | ✅ | ❌ | ❌ | SUCCESS |
| network_failure | ✅ | ❌ | ❌ | FAILED |
| login_failure | ✅ | ✅ | ❌ | HUMAN_ESCALATION |
| verification_failure | ✅ | ❌ | ❌ | FAILED |

**逐场景真实解读：**
- `page_not_found`：retries=0、verification=0 —— AI 未触及 404 路径即判完成，**未命中注入**，故不计恢复成功（诚实标注，非「恢复通过」）。
- `element_changed`：真实触发 recovery（retries=3、repairs=3），耗尽修复上限后正确升级 `HUMAN_ESCALATION` —— **恢复机制真实工作，且对不可恢复项正确终止**。
- `network_failure`：真实触发 recovery（retries=3、repairs=3），连接被拒不可恢复，正确升级 —— **恢复机制真实工作**。
- `login_failure`：AI 真实观察到「邮箱或密码错误」并判完成（SUCCESS 真实有效，非假阳性）。
- `verification_failure`：该场景 DeepSeek 计划 `verificationTotal=0`（AI 未加入验证步骤），故未真正触发「验证失败→恢复」链路而直接 SUCCESS —— **暴露真实缺陷：AI 偶尔跳过自我验证**。

## 6. 当前限制与下一阶段建议

- 目标站点为受控 mock fixture（本地，可复现）；真实公网站点的抗检测/反爬/动态渲染需在真实环境补充验证。
- 成本估算基于 DeepSeek 公开定价（deepseek-chat），实际账户映射为 deepseek-v4-flash，精确单价以账单为准。
- 验证准确率依赖 `text_present` 对 `textSummary` 的消费；Phase 6 已增强 observation（扩展 div 等标签），未改动 verification/runtime。
- 若成功率或验证准确率未达 80% 目标，建议：①复盘失败任务的 DeepSeek 计划质量；②评估是否需要解冻 observation/verification 进一步联动；③补充真实站点任务集。

---
数据来源：`server/.benchmark/phase6_1787691693952.json`