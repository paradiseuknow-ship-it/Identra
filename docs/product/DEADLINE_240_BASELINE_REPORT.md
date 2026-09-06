# Deadline 240s 维度基线报告（fixes_baseline_dl240，2026-09-01）

## 0. 运行参数

| 项 | 值 |
|---|---|
| 任务池 / LLM / 代码状态 | 与 fixes_baseline 完全一致（P1+Fix A/B/A1），唯一变量 = per-task deadline 120s → 240s |
| 命令 | `phase12Benchmark.js --task-deadline 240000`（harness §8 已交付的配置入口，零代码改动） |
| 运行 | 100 任务一次跑完，EXIT=0，1h55m，avg cost $0.0012 |
| 产物 | `.benchmark/phase12_tag_fixes_baseline_dl240_1788229276002.json` + jsonl |

## 1. 核心结果（三基线纵向对比）

| 指标 | Final100（修复前 120s） | fixes_baseline（修复后 120s） | **本基线（240s）** |
|---|---|---|---|
| **Business Success** | 40% | 56% | **66%** |
| SUCCESS / ESC / CANCELLED / FAILED | 40/40/15/5 | 56/24/19/1 | **66/30/1/3** |
| Credible / Real | 19%(污染)/21% | 12%(合法)/0% | 12%(合法)/**0%** |
| Planner | 98% | 91% | 91%（同口径前移，见 fixes 报告 §3） |
| Execution / VerifAcc / Repair | 67/60.2/— | 70.6/62/47.4% | **75.3/66.5/53.8%** |
| Agent Score overall | 76 | 82 | **84** |

## 2. 核心问题解答：19 个 120s-TIMEOUT 的真实转化率

**18/19（94.7%）到达真实收敛终态**，仅 rw.075 在 240s 仍超时：

| 240s 结局 | 数量 | 任务 |
|---|---|---|
| SUCCESS | **8** | rw.006/060/061/063/064/065/093/097 |
| HUMAN_ESCALATION（重试耗尽，真实业务终态） | 8 | rw.038/042/076/083/091/092/094/100 |
| FAILED（工程缺口，见 §4） | 2 | rw.026/046 |
| 仍 CANCELLED@240s | 1 | rw.075 |

**+10pp Business Success 中 8pp 来自这批 SUCCESS 转化**（与跃迁矩阵 CANCELLED→SUCCESS ×8 完全对账）；fixes_baseline 报告 §4 的「≈19pp 观测回收上限」预测得到精确验证。

## 3. 全量状态跃迁矩阵（120s → 240s）

| 跃迁 | 数量 | 解读 |
|---|---|---|
| SUCCESS → SUCCESS | 54 | 稳定成功核心盘 |
| ESC → ESC | 20 | 稳定升级（真实业务缺口） |
| **CANCELLED → SUCCESS / ESC / FAILED** | 8/8/2 | 120s 截断任务全部显形 |
| **ESC → SUCCESS** | 4 | rw.002/021/032/035（LLM 非确定性红利） |
| **SUCCESS → ESC** | 2 | rw.010/087（反向波动） |
| FAILED → FAILED | 1 | rw.095（敏感字段门，稳定拦截） |

**非确定性噪声带 ≈±2 任务（±2pp）**：单次 run 数字解读需以此为下限。ESS 稳定核心 = 54+20+1(rw.095 稳定拦截) = 75% 任务行为跨 run 一致。

## 4. 240s 放开后新显形的工程缺口（下一候选修复）

1. **REPAIR_TIMEOUT [ELEMENT_NOT_FOUND] ×2（rw.026/046）**：验证 1/1 通过但修复编排对目标文本/输入框寻址 4 次重试耗尽——此前被 120s 截断掩盖（表现为 TIMEOUT），本质是 **repair 编排超时配置 + element 寻址兜底**缺口，≈2pp。
2. **ELEMENT_NOT_FOUND 0→4**：rw.026/046（repair 耗尽）+ rw.076/079（VERIFY_RETRY 上限）——与 scraping/search 列表类验证契约同根（页面结构对齐）。
3. **rw.075 在 240s 仍超时**：data_entry 10 步长任务，重试/修复开销叠加超 240s，属长流程时间预算问题。

## 5. 结论

1. **deadline 观测瓶颈定量闭环**：120s 基线的 19 CANCELLED 中 94.7% 是观测截断而非产品失败；240s 下全池 CANCELLED 归零（19→1）。
2. **Business Success 66% 的构成全部真实**：54 稳定 SUCCESS + 8 截断转化 + 4 非确定性红利 −2 反向波动；Credible 12% 合法升级、Real 0、零污染。
3. **剩余失败池已收敛到三个可命名的小池**：ESC 30%（真实业务缺口：scraping/search 列表类契约 + 长流程）、REPAIR_TIMEOUT ×2、凭据供给 12pp。
4. 240s 相对 120s 的 +10pp 是**纯观测红利**（零代码改动），证明 fixes_baseline 的修复效果被 120s 口径低估。

## 6. 下一步（需用户新授权）

1. **REPAIR_TIMEOUT [ELEMENT_NOT_FOUND] 修复**（rw.026/046，≈2pp）：repair 编排对 element 寻址的超时/兜底策略（属执行层 robustness 授权范畴）。
2. **scraping/search 列表类验证契约对齐**（ESC 30% 的最大构成）。
3. **池任务凭据配置**（12pp，benchmark 环境配置）。
4. 产品基线口径决策：正式口径采用 120s 还是 240s（或按任务类别分档）。
