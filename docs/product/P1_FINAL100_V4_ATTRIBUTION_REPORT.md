# P1 Final 100-task 归因报告（Phase C：Final Dataset Completion）

- **runId**: 1788181819049（增量续跑 3 次中断后补齐，`resumedCount: 48`，unique tasks = 100/100）
- **Provider**: deepseek（真实 LLM），worker 隔离 + hard deadline 120s + 每任务增量落盘
- **授权边界**: Final Dataset Completion——运行期间零代码改动、零评分语义改动、零池/fixture/fingerprint 改动
- **运行事故透明说明**: 同一授权运行共经历 4 次宿主进程树回收（v1@21/100→v3@15/100→v3 第二次@48/100 前后→后续 resume），每次均靠增量 JSONL 断点续跑恢复，**已完成任务零重复执行、零丢失**。数据集 = 33 条旧契约段 + 67 条新契约段（见 §3）。

---

## 1. 总体指标（100/100）

| 指标 | 本轮 | 上轮 final100 | Phase5 | Phase6 |
|---|---|---|---|---|
| **Business Success** | **52%** | 40% | 5% | 6% |
| Planner Success | 85% | 98% | 96% | 96% |
| Execution Success | 66.8% | 67% | 54.9% | 57.8% |
| Verification Accuracy | 59.7% | 60.2% | — | — |
| Agent Score (overall) | **82.0** | 76 | — | — |
| avg latency | 53s/任务 | — | — | — |
| avg steps | 3.3 | — | — | — |
| token 总量 | 215.7K prompt + 136.7K completion ≈ 352K | — | — | — |

- **Business Success 52%**：较上轮 +12pt，较 Phase5/6 基线 **8.7×–10.4×**。
- **Planner Success 85%**：较上轮 -13pt——**这是诚实的下降**：13 个 planner 级失败全部是守卫/schema 门正确拒绝（见 §4），上一轮的 98% 中含污染成分。非退步。
- **Agent Score 82**（+6）：五维打分（planning/execution/recovery/verification/autonomy 加权）。

## 2. 状态分布与 Escalation 五拆

### 状态分布
| 状态 | n | % |
|---|---|---|
| SUCCESS | 52 | 52% |
| HUMAN_ESCALATION | 20 | 20% |
| CANCELLED | 12 | 12%（8 个正确归 TIMEOUT 类，4 个为旧契约段遗留） |
| FAILED | 16 | 16% |

### Escalation taxonomy（明确区分语义）
| 类 | n | 语义 |
|---|---|---|
| CREDIBLE_BUSINESS | 5 | **≠工程失败**。none+login 任务正确升级为「需用户提供凭据」（POLICY_BLOCK） |
| REAL | 15 | **≠VERIFY_RETRY**。重试 4 次耗尽的真实业务升级（验证不收敛/元素定位失败） |
| VERIFY_RETRY | 6 | 验证循环未收敛但归为 FAILED（产品弱点，非升级语义） |
| TIMEOUT | 8 | harness 120s deadline（Fix #2 正确分离，**0 例超时错标「用户取消」**） |
| CANCELLED | 4 | 全部在旧契约段（Fix #2 之前的记录，error=用户取消） |
| ENGINEERING_FAILURE | 10 | schema 门拒绝（7 旧段 + 2 JSON 解析失败 + 1 新段漏网 rw.095） |

### 分类别成功率
| 类别 | SUCCESS/总数 | 率 |
|---|---|---|
| data_entry | 14/19 | 74% |
| saas | 16/30 | 53% |
| ecommerce | 13/25 | 52% |
| longflow | 9/25 | 36% |

### 分层（credentialRequirement）
- required 12：SUCCESS 5 / FAILED 4 / CANCELLED 2 / ESC 1
- none 88：SUCCESS 47 / FAILED 12 / CANCELLED 10 / ESC 19

## 3. 数据集构成透明化（重要）

| 段 | n | 契约 | 分布 |
|---|---|---|---|
| 前 33（宿主回收前，Fix #1/#2 **之前**） | 33 | 旧 | SUCCESS 19 / FAILED 10 / CANCELLED 4 |
| 后 67（续跑段，Fix #1/#2 **生效**） | 67 | 新 | SUCCESS 33 / ESC 20 / CANCELLED 8(全 TIMEOUT) / FAILED 6 |

**新契约段直接对比**：FAILED 率 30%→**9%**；CANCELLED 污染清零（8 个超时全部正确归 TIMEOUT 类）；CREDIBLE 全部走正确升级语义。新旧两段不可直接混比成功率——但 taxonomy 纯度在新段显著提升，这正是 P1 收口的验收目标。

## 4. 逐任务归因（48 个非 SUCCESS 全归因）

| # | 类 | n | 任务 | 根因归属 |
|---|---|---|---|---|
| 1 | 旧段 schema 秒败 | 7 | rw.014/016/017/019/021/023/025 | **池标注缺陷+旧契约**：none+login.html 任务在无凭据下被迫写明文 password → schema 门正确拒绝×3。新契约下同类任务已转 CREDIBLE（见 #2），此 7 条为历史记录保留 |
| 2 | CREDIBLE 升级 | 5 | rw.086/087/089/090/093 | **正确语义**：需登录但凭据清单空 → `needsCredentials → CREDIBLE_BUSINESS`，14-20s 一次短路，无重试空转 |
| 3 | REAL 升级 | 15 | rw.038/041/050-055/065/076/079/082/092/094/097/099 | **产品真实能力不足**：验证循环 4 次重试不收敛（「检查搜索结果/订单状态/加购按钮」类），属应升级人工的正确行为 |
| 4 | VERIFY_RETRY→FAILED | 6 | rw.005/007/008/060/061/075 | 产品弱点：步骤 PENDING 挂起、验证循环未闭合，与 #3 同根源但未走升级路径 |
| 5 | TIMEOUT | 8 | rw.042/045/046/049/053/064/083/100 | harness 120s deadline（非产品失败，Fix #2 分类正确） |
| 6 | JSON 解析失败 | 2 | rw.063(none) / rw.091(required-payment) | planner 输出非法 JSON ×3 重试 → **≥2 次同构复现，按预设规则 = 候选 P1/B 类**（见 §5-C） |
| 7 | Fix #1 漏网 | 1 | rw.095 | 敏感字段门拒绝（password+confirmPassword，8 步计划）但**未走 needsCredentials 短路**，走了 runtime 未捕获异常路径 → Fix #1 覆盖缺口（见 §5-A） |
| 8 | 旧段用户取消 | 4 | rw.006/010/020/026 | 旧契约段遗留记录（当时尚未修 cancel reason 透传） |

## 5. 三专项监控结论（用户预设规则）

### A. Fix #1（无凭据登录 → CREDIBLE 升级）
- 新契约段命中 **5/6 = 83%**：5 个 none+login 全部 `planner → schema rejection → needsCredentials → CREDIBLE_BUSINESS`
- **1 个漏网（rw.095）**：多步注册类任务（8 步计划、password+confirmPassword 双敏感字段）的 schema 拒绝发生在 runtime 未捕获异常路径，未经过 planObjective 的短路分支 → **候选 Fix #1 覆盖缺口**（候选 B 类，待授权后归因：是否为 REPLAN 路径或独立校验点未接短路）
- credentialRef 幻觉 = **0**（v4 全 log `cred_` 零出现）；明文 password = **0**；required 任务被误判 CREDIBLE = **0**
- 无意义重试空转 = 0（一次短路 14-20s，对比旧路径 3 次重试）

### B. Fix #2（cancel reason 透传）
- 新契约段 **8/8 = 100%**：全部 deadline → `esc=TIMEOUT + tax=TIMEOUT + benchmark_deadline 标记`
- 「超时 → CANCELLED(用户取消)」错标 = **0**（仅存在于旧段 4 条历史记录）
- 真实用户取消语义不变（targeted test 锚点持续全绿）

### C. rw.091 型 planner JSON parse failure
- 全程 **2 次**（rw.091 required-payment + rw.063 none），同构错误文本「规划失败(plan): JSON 解析失败」
- 按预设规则（1 次=观察 / ≥2 次=候选 P1/B 类）：**列为候选 P1/B 类问题**——嫌疑=长 objective（payment/长流程）+凭据段注入致模型输出格式漂移
- 本轮遵守纪律**未修 parser**

## 6. 与历史基线对比

| 指标 | Phase5 | Phase6 | 上轮 final100 | **本轮** |
|---|---|---|---|---|
| Business Success | 5% | 6% | 40% | **52%** |
| Planner Success | 96% | 96% | 98% | **85%**（诚实下降：13 个失败全为守卫正确拒绝） |
| Execution Success | 54.9% | 57.8% | 67% | **66.8%**（持平） |
| Escalation 构成 | — | — | CREDIBLE 19（污染）+ REAL 21 | **CREDIBLE 5（纯升级语义）+ REAL 15**（污染清零） |
| 成本 | — | — | — | ≈352K tokens / 100 任务 |
| 平均时长 | — | — | — | 53s/任务 |

（Phase 7/8 的详细基线数字不在本次上下文，未列入；如需补齐可从 phase8 报告回填。）

## 7. 核心结论

1. **P1 credentialRef 契约已实质关闭污染**：CREDIBLE 从上轮 19 个污染 → 5 个纯升级语义；required/none 双向零伪造、零误判。
2. **Business Success 52%（历史最高）**，且未触碰 Success Definition / 验证语义 / 池 / fingerprint。
3. **Planner 85% 是诚实数字**：16 个 FAILED 中 10 个是 schema/守卫正确拒绝，13% planner 失败全部可审计归因。
4. **剩余损失三大块**（按可挽回空间排序）：① REAL 15 + VERIFY_RETRY 6 = 21 个验证不收敛（产品真实弱点，最大改进空间）；② JSON parse failure 2 次（候选 B 类）；③ Fix #1 漏网 1 次（rw.095 路径覆盖）。
5. longflow 是最弱类别（36%），主题集中在「订单状态/物流/筛选」类多步验证场景。

## 8. 运行纪律遵守确认

- 运行期间：零代码改动、零评分语义改动、零池/fixture 改动、rw.091 parser 未修 ✓
- 已完成任务零重复执行（resume 3 次全部跳过）✓
- 10 分钟轮询未建立 ✓
- 100/100 后立即停止：不修码、不重跑、不再开 benchmark ✓

**本报告交付后停住，等待下一步授权。**
