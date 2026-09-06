# 双口径证据审计报告（B1+B2+B3+C 专项 · 2026-09-01）

前置：dl240 基线（名义 Business Success 66%）+ 池错配归因报告（POOL_FIXTURE_MISMATCH_REPORT.md，口径 43/82.5% provisional）。
本轮按授权执行：B1 双口径分析器 → B2 假阳性逐任务审计 → B3 对齐 lint v2 → C 专项裁定。全程零改动：池/fixture/runtime/Success Definition 均未触碰。

## 0. 一句话结论

**19pp 假阳性是低估，真实假阳性为 26pp**；错配任务从报告口径 43 修正为 **55**；feasible 分母 45、feasible SUCCESS 40 → **adjusted ≈ 88.9%（provisional）**。真实 Agent 能力缺口收敛为 **2 个**（rw.094 planner 语义放大、rw.083 懒加载就绪检测），其余全部为池错配/凭据供给/已修复工程缺陷。**名义 66% 中近 4 成是「目标资源在页面上根本不存在却判成功」**。

## 1. B1 双口径分析器（已完成，48/0 ×2）

- 新建 `server/scripts/analyze_phase12.js`（用户指令点名的文件此前不存在——phase12 产物从未被任何分析器消费，`analyze_phase10.js` 只扫 `phase10_*.json`）。
- 视图一 Nominal：历史口径逐字段透出 + perTask 复算交叉校验（不一致即抛错拒绝输出，防静默漂移）。
- 视图二 Feasible-Task Adjusted：消费冻结快照 `pool_fixture_mismatch_list.json`，输出 feasible 分母/SUCCESS among feasible/adjusted 率/被剔除 ID+理由/终态交叉表，全部标记 `provisional:true`，绝不回写 nominal。
- 只读纪律：输入文件 size+mtime 指纹校验，违规退出码 2。
- 测试 `test_analyze_phase12.js`：spawn 子进程断言真正执行的产物，48 项断言 ×2 全绿。

## 2. 错配精确分类（第 1 项）

**演进**：报告口径 43 → v1 快照 44（词典扩充差 1）→ **v2 lint + 逐任务人工复核后最终 55**。

| 环节 | 数值 |
|---|---|
| v2 机械 lint（增强词典+语义规则） | 57 命中 |
| 人工灰区剔除（保留 feasible） | −3（rw.064/065/089） |
| 人工补判（词典盲区） | +1（rw.076） |
| **最终 mismatch** | **55** |

v2 新增能力：同义词组（仪表盘↔数据看板防误报）、searchOnly 语义规则（纯搜索空结果可执行，且要求 fixture 真有搜索能力——修正 rw.015 login.html 无搜索框的误放行）、设置页实体规则（rw.010「打开设置页」）、扩词（编辑/个人资料/显示名/语言/时区/API 密钥/去重/会员）。

**55 个错配在 dl240 的终态**：SUCCESS 26（假阳性）+ CREDIBLE 10 + VERIFY_RETRY 16 + ENGINEERING 2 + TIMEOUT 1 = 55。
**分 fixture**：saas/login 17 · scraping/list 14 · ecommerce/search 19 · form 1（rw.075）· download 1 · search_lazy 1（rw.082）· 人工 1（rw.076→search）。

## 3. 假阳性逐任务核验（第 2 项）：26 个，非 19 个

**26 人名单**（原 19 + 新增 7）：
原 19：rw.006/015/016/018/021/027/028/029/030/037/043/045/047/048/067/077/093/096/098
新增 7：**rw.014（API 密钥设置项）、rw.022（语言设置）、rw.025（时区设置）、rw.036（编辑页）、rw.039（编辑页价格）、rw.040（分类标签）、rw.078（注册会员——fixture 是 search.html 非表单页）**

**机制（代码级三重实证）**：
1. harness 三脚本（phase12Benchmark/phase12_task_worker/phase10Benchmark）对池的 `expectedBusinessState`/`expectedVerification` **零引用——双重死字段**，验证只消费 planner LLM 产出的合约；
2. `contract.js ACTION_TO_STATE`（DERIVABLE）不含 observe/extract → `deriveContract` null → `buildEffectiveVerification` 回退路径执行成功即 SUCCESS；
3. dl240 计数器指纹：26 个全部 `verificationPassed == verificationTotal`（自验证 100%）+ 极少步数（2-8 步），与 action-level 成功形态完全一致。

**四分类输出**：STRUCTURALLY_INFEASIBLE 55（资源确定性不存在）∥ SUSPECT_FALSE_POSITIVE 26（上述机制+指纹，置信度高；步骤级动作链未被 harness 持久化，无法逐动作回放——见工程发现 E1）∥ VERIFIABLE_SUCCESS（灰区 5 个 SUCCESS：rw.034/064/065/081/085，动作本身可执行且有真合约）∥ TRUE_SUCCESS 0（按构造不适用于错配集）。

**工程发现**：
- **E1**：phase12 harness 不持久化步骤级动作链（store/日志均无 payload），B2 审计只能到「高置信疑似」，建议后续运行在 jsonl 增加 actions 摘要字段（分析层建议，未改代码）。
- **E2**：池级期望字段双死（见上），池生成缺陷被运行期完全掩盖。

## 4. 双口径（第 3 项）

| 口径 | 值 | 说明 |
|---|---|---|
| Nominal Business Success | **66%** | 历史口径原样保真（66/30/3/1，Agent Score 84） |
| 假阳性占比 | **26pp** | 名义 66% 中 39% 为目标资源不存在却 SUCCESS |
| Feasible 分母 | **45** | 100 − 55 错配 |
| SUCCESS among feasible | **40** | 66 − 26 |
| **Adjusted（provisional）** | **88.9%** | 40/45；B2 逐任务判定规则已固定于 v2 快照 |

诚实失败构成（错配 55 中）：CREDIBLE 10 + VERIFY_RETRY 16 + TIMEOUT 1 + ENGINEERING 2 = 29（53%），agent 对不可解任务的行为基本正确。

## 5. Feasible 45 最终构成（第 4 项）

- 常规可行 35：登录/看板/搜索/表单注册/下载/懒加载搜索等能力齐备任务；
- 灰区 watchlist 6：rw.034/064/065/081/085（动作可执行、字面目标部分满足，5 个 SUCCESS 待逐步骤确认）+ rw.089（半匹配，ESC CREDIBLE）；
- searchOnly 单列 4：rw.034/081/083/085（空结果搜索可执行）。
- 凭据 family：rw.004/010/023 等 ESC CREDIBLE 中 fixture 能力确实存在的部分保留在 feasible。

## 6. C 专项：真实 Agent 缺口裁定（第 5 项）

| 任务 | 裁定 | 证据 |
|---|---|---|
| **rw.094** | **真缺口（A 类 planner 语义放大 + 动态元素寻址复合）** | error=「打开购物车页面查看数量…重试耗尽」——fixture 无「购物车页面」，只有 `id=cart` 计数条；planner 把「查看购物车数量」放大为「打开购物车页面」进入不可满足子目标循环；且加购按钮为 JS 动态创建（`btn.id='addBtn'`，静态 HTML 无 button 标签） |
| **rw.083** | **真缺口（C 类 readiness，E2/E4 family）** | error=「等待页面懒加载内容完全加载…重试耗尽」——800ms 异步渲染就绪检测失败，dl120/dl240 双复现 |
| rw.026 | **已修复** | dl240 中 REPAIR_TIMEOUT[ELEMENT_NOT_FOUND] 正是促成 Fix② 的证据；修复后已验证 SUCCESS 15.1s |
| rw.004 | 凭据供给 family | BUSINESS_INVALID_CREDENTIAL——池配置的凭据本身错误，非能力问题 |
| rw.075 | 结构性 + 观测瓶颈 | 去重行为不存在（已归错配），agent 反复验证不存在的行为直至 240s deadline |

**结论：真实可满足任务上的 Agent 能力缺口 = 2 个（rw.094、rw.083），占 feasible 分母 4.4%。**

## 7. 下一阶段最小修复点（第 6 项，按性价比排序）

1. **planner 语义放大守卫（≈rw.094 类）**：planner 产出「打开 X 页面」类子目标时，对照 element list 校验该页面/实体存在性（A3 同根，属 evidence 约束 family，非新能力）。
2. **懒加载就绪检测（rw.083）**：waitUntil readyState 之外对 results 容器内容变化增加二次确认窗口（Phase 6 E2/E4 已知 family 的收尾）。
3. **E1 证据持久化**：phase12 jsonl 增加 per-task actions 摘要（只改 harness 记录层，不改语义），让下一轮审计可逐步骤回放。
4. 池 v2 对齐重生成（需授权，历史基线不可比，作为新基线）。

## 8. 是否值得再 benchmark（第 7 项）

**不值得立即重跑。** 理由：① 45 个 feasible 任务上 agent 已达 88.9%，剩余可回收空间 ≈ 4.4%（2 个真缺口）+ 灰区确认；② 重跑 100-task 只会把 26pp 假阳性再烧一遍 token；③ 建议路径：先做修复点 1+2（小改动+targeted test×2+双回归），跑 **5-10 任务小样本 smoke**（rw.094/083/004/027/034），确认 2 个真缺口修复后再评估是否需要新一轮全量基线（且应先授权池 v2 对齐重生成，否则名义口径永远失真）。

## 9. 交付物

- 双口径分析器：`server/scripts/analyze_phase12.js` + 测试 `test_analyze_phase12.js`（48/0 ×2）
- 对齐 lint v2：`server/scripts/audit_pool_fixture_alignment.js`（只读）+ 输出 `.benchmark/pool_alignment_v2.json`
- 冻结快照 v2：`server/scripts/pool_fixture_mismatch_list.json`（55 mismatch + 6 灰区 + provenance）
- 双回归：runRegression.js **70/0**（基线 69/0，新增收集 1 个配置测试，0 失败）+ run_phase9_regression.sh **OK=63/BAD=0**（基线 OK=62，0 失败）。顺序执行，耗时 13m31s。
- 本报告 + 双口径分析产物 `.benchmark/phase12_analysis_phase12_tag_fixes_baseline_dl240_1788229276002.json`
