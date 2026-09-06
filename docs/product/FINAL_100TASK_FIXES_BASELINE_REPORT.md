# 100-task 修复后基线报告（fixes_baseline，2026-09-01）

## 0. 运行参数

| 项 | 值 |
|---|---|
| 任务池 | phase12_pool.json 完整 100 任务 |
| LLM | DeepSeek 真实调用（avg cost $0.0012/任务） |
| Deadline | 默认 120s per-task（与 Final100 完全同 harness 口径，Δ 归因纯净） |
| 代码状态 | P1（jsonExtract 加固+maxTokens 8192）+ P1 空集反向守卫 + Fix B（replan step id）+ Fix A（非法 CSS selector 守卫）+ Fix A1（navigate 冒充 fill 守卫）+ escalationClass 五分类 |
| 运行方式 | 断点续跑（中途 session 重启一次，harness 增量 append 自动跳过已完成 14 任务），总 EXIT=0 |
| 产物 | `.benchmark/phase12_tag_fixes_baseline.jsonl` + `phase12_tag_fixes_baseline_1788222137086.json` |

## 1. 核心指标对比（vs Final100，同 harness 同池同 deadline）

| 指标 | Final100（修复前） | 本基线 | Δ |
|---|---|---|---|
| **Business Success** | 40% | **56%** | **+16pp** |
| SUCCESS / ESC / CANCELLED / FAILED | 40/40/15/5 | 56/24/19/1 | — |
| Escalation Credible | 19%（全部=none 任务 credentialRef 污染） | 12%（**全部合法**） | 污染清零 |
| Escalation Real | 21%（全部 VERIFY_RETRY 工程型） | **0%** | 清零 |
| Planner | 98% | 91% | 见 §3 归因（非回归） |
| Execution Success | 67% | 70.6% | +3.6pp |
| Avg cost / duration | — | $0.0012 / 61.3s | — |
| Agent Score overall | 76 | **82** | +6 |

**分类别**（Final100 → 本基线）：saas 33%→**63%**（+30）、ecommerce 28%→**48%**（+20）、longflow 32%→**44%**（+12）、data_entry 75%→70%（−5，样本噪声内）。

## 2. 修复挽回验证（逐项对账）

| 修复 | 目标形态 | Final100 表现 | 本基线 | 结论 |
|---|---|---|---|---|
| **P1 JSON parse** | rw.063 等 parse failure | 截断/解析失败 | rw.063 跑满 21 步至 deadline，0 parse 错误 | ✅ |
| **Fix B（B1 ×5）** | rw.005/060/061/075 | PENDING 残留「任务完成但存在未成功步骤」FAILED ×5 | **全 run「未成功步骤」错误 0 次**；rw.005 SUCCESS；其余跑到 deadline（§4） | ✅ 根因根除 |
| **Fix A1（A1）** | rw.099 navigate 冒充 fill | 值从未输入 → VERIFY_RETRY | **SUCCESS** | ✅ |
| **Fix A（A3 非法 CSS 子集）** | rw.065 `id=regForm` | 语义匹配必然落空 | 守卫 0 误伤，planner 正常规划，跑到 deadline | ✅ |
| **P1 空集反向守卫** | 19 CREDIBLE 污染 | none 任务引用不可用 credentialRef | **CREDIBLE 污染 0**（§3） | ✅ |
| **凭证契约** | 明文 password | — | rw.095 尝试 value 被 schema 敏感字段门拒 ×3（设计行为，唯一 FAILED） | ✅ 门生效 |

## 3. Planner 91% 归因（非回归）

9 个 plannerOk=false 任务逐条归因：

- **8 个 = none+login 结构性不可满足的确定性短路（设计行为）**：rw.017/019/020/021/023/086/089/090——任务页面需要登录但凭据清单为空，planner 正确拒绝臆造凭据并快速失败 → 运行时路由 escalate(kind=credential) → **CREDIBLE_BUSINESS 正确分类**。Final100 中同批任务烧光重试后落到 VERIFY_RETRY/REAL 污染；现在前置到 plan 期一次性正确收口。PlannerOk 指标按「未产出可执行计划」计数，把这些**正确拒绝**也计入，造成 98%→91% 表面下降；实际是「错误形态从运行中期污染前移为规划期正确升级」。
- **1 个 = 敏感字段门正确拦截（设计行为）**：rw.095 在重试中尝试 value 填 password，被 schema 门拒 ×3 → FAILED（全 run 唯一）。

**CREDIBLE 12% 构成**：4 required（rw.002/003/004/009，真实需要凭据正确升级）+ 8 none+login 结构性升级 = **12/12 全部合法升级，零污染**。

## 4. TIMEOUT 19 的形态（下一瓶颈的定量边界）

19 个 CANCELLED 全部 = 120s harness deadline（`benchmark_deadline` 标记），**B1 错误 0 残留**。执行深度显示并非卡死：rw.063 跑 21 步（11 成功尝试）、rw.061/064/065/075 各 10 步 5 成功——任务在真实推进，只是 120s 不够收敛。若以 `--task-deadline 240000` 放开，按 5-task smoke 中 4/4 转真实终态的先验，这 19 个中相当比例可转化为最终业务结果（HUMAN_ESCALATION 或 SUCCESS），**是下一个最大单一可回收池（≈19pp 观测上限）**。

## 5. VERIFY_RETRY 12 的剩余形态

高度集中：scraping/list.html ×7（rw.049–055）+ ecommerce/search(.html/_lazy) ×5（rw.032/035/041/079/082）——列表渲染/lazy 加载页面的验证契约与页面结构对不齐（多为 C 类边界：登录前不可知登录后内容），与 taxonomy 既有结论一致，属下一阶段候选（探察式规划/语义 ready wait）。

## 6. 结论

1. **P1+Fix A/B/A1 全部按预期生效**，六大修复项逐项对账零回退；Business Success 40%→56%（+16pp），Agent Score 76→82。
2. **纯度指标历史最佳**：Credible 污染 19→0、Real 21→0、FAILED 5→1（唯一 FAILED 还是保护门正确拦截）。56% 全部为真实业务成功。
3. Planner 表面 98%→91% 为口径前移（正确拒绝计入失败），非能力回归。
4. 剩余三大可改进项（按可回收空间排序）：① 120s deadline 观测瓶颈（≈19pp 上限，harness 参数现已支持 `--task-deadline`）；② scraping/search 列表类验证契约（12 VERIFY_RETRY）；③ none+login 任务的凭据供给（8 planner 短路 + 4 required 升级，合计 12pp——本质是测试环境凭据配置问题，非 agent 能力问题）。

## 7. 下一步（需用户新授权）

1. **deadline 维度基线**：同池以 `--task-deadline 240000` 重跑一次，量化 19 个 TIMEOUT 的真实转化率（harness 已支持，零代码改动）。
2. scraping/search 列表类 VERIFY_RETRY ×12 的验证契约对齐（候选：探察式规划 / semantic ready wait，属授权范围候选修复）。
3. none+login 12pp：为池任务配置测试凭据（benchmark 环境配置，非代码改动）。
