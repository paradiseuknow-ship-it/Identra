# Phase 13 — v2 Clean Baseline 修复验证阶段 · 最终报告

> 生成时间：2026-09-02 ｜ 状态：P1.1 取证 ✅ / P1.2 修复 ✅ / P1 smoke ✅ / P2 双口径 ✅ —— **完案，STOP 等待授权**
> 授权链：Phase 13 指令（P1→rw.079→双回归→P2 严格顺序）+ P1.2 OPT-2 授权令

---

## 1. Baseline（v2 canonical，冻结参照系）

`phase12_tag_v2baseline_1788306100968.json`（120s deadline，sha256 50a035f1…，未改动）：

| 口径 | 数值 |
|---|---|
| SUCCESS | 82 / 100（nominal 82%） |
| CREDIBLE | 1（rw.014，凭据空清单正确升级，纯度 100%） |
| REAL | 6（rw.046/053/054/068/079/085） |
| TIMEOUT/CANCELLED | 11（全部 latency≈121s 硬门杀，无一到达真实终态） |
| ENGINEERING_FAILURE | 0 |
| Agent Score | overall 94 |
| failureTaxonomy | ELEMENT_NOT_FOUND=0 / VERIFY_FAILED=6 / POLICY_BLOCK=1 / TIMEOUT=11 / NETWORK=0 / OTHER=0 |

---

## 2. P1 Root Cause（P1.1 只读取证 → `.benchmark/P1_EVIDENCE.md`）

**核心证伪：6 个 REAL 全部不是 E2/E4 readiness convergence failure。** 真实复现（mock server + Playwright 实测）证明页面就绪正常（list/download/search t=0 即 complete；search_lazy 800ms E2 正确等到）。真凶两类：

| 类别 | 任务 | 证据 |
|---|---|---|
| ① semanticResolver 缺 bare-tag 匹配信号（B 类引擎缺口，**允许修复**） | rw.068 | `resolve("h2")` 返回 0 候选，尽管 h2 在候选池内——五信号无一能匹配裸标签名 |
| ② planner 契约编造（CONTRACT_SELECTOR_MISMATCH 家族，**禁改区**） | rw.046/053/054/079/085 | 「商品列表容器」对应 div 刻意不入候选池（防稀释设计）；rw.085 页面无 form 元素；任何 readiness/wait 修复无法桥接 |

**非确定性解密**：同 fixture 同 expect 1 PASS / 4 FAIL——唯一 PASS 恰好被 planner 附带可满足合约 `text_present "共 10 条商品"`。成败由「最终被评估的证据子句可满足性」单点决定。

**rw.079 分类（本阶段第二指令）**：**P1 同构（planner 契约编造）**，排除 elementMemory（全程零参与，Native）/ selector resolution / 等待——click 成功执行（池中出现 addBtn 铁证），卡在 click 后不可满足的 `element_present "商品列表容器"`。3×记录一致。

---

## 3. P1 最小修复（OPT-2 授权范围，唯一代码修改）

**修改面（3 文件，frozen semantics 零触碰）**：
- `server/agent/semanticResolver.js`：新增第 6 信号 bare-tag——`BARE_TAGS = CONTROL_TAGS ∪ DESCRIPTIVE_TAGS`（12 项显式 HTML tag 词表：input/textarea/select/button/a/summary/form/label/h1/h2/h3/img，复用项目已有定义，非猜测 heuristic）；`bareTagHint()` 仅当 expect 恰为词表内全词、非 CSS 形态时激活；`scoreBareTag()` 0.85 参与 TIER 竞争；`canonicalMatchedBy` tag→attribute。**不扩大 observation 候选池、不降级 element_present、不触碰 planner/verification/E2/E4/Success Definition。**
- `server/scripts/test_resolution_fixes.js`：⑤ 节 targeted tests Case A–E。
- `.benchmark/p12_smoke_p1_2.js`、`.benchmark/p2_240s_diagnostic.js`：诊断驱动脚本（不进回归）。

**四 Gate 全绿**：
| Gate | 结果 |
|---|---|
| ① targeted tests | **32/0**（Case A 正向命中 / B 大小写归一 / C「商品列表容器」仍 0 候选 / D 无 form 仍 0 / E CSS fallback 零回归） |
| ② runRegression.js | **78/0**（SMOKE5 后既有基线，零回归） |
| ② run_phase9_regression.sh | **OK=71/BAD=0** |
| ③ P1 smoke | rw.068 ×3 全 SUCCESS（verif 2/2，~25s，REAL 6→5）；anchors rw.094/027/034 全 SUCCESS 零回归 |

**rw.004 anchor 波动归因（未触发 STOP B）**：首跑 CANCELLED（120s）→ 铁证排除 bare-tag 因果（全链 expect 均非裸 tag）+ 失败模式 = elementMemory 命中旧记忆打错元素 + LLM plan 波动；复跑 ×2 = 1 CANCELLED + 1 SUCCESS（store 铁证）→ 非确定性波动，噪声带既有面。**element_memory matchedBy 干扰列为后续独立观察项。**

---

## 4. Before → After 逐任务

| 任务 | v2 baseline | P1.2 后 | 说明 |
|---|---|---|---|
| rw.068 | REAL（element_present "h2" 0 候选） | **SUCCESS**（smoke ×3） | bare-tag 信号修复 |
| rw.046/053/054/079/085 | REAL | REAL（维持） | CONTRACT_SELECTOR_MISMATCH，本阶段禁改，C 类边界 |
| 11×TIMEOUT | CANCELLED@120s | 见 §5 P2 | 240s diagnostic |

---

## 5. P2 双口径：11×TIMEOUT 120s vs 240s（唯一变量 deadline）

| 任务 | fixture | 120s | 240s | verif(240s) | wall(240s) | 成本(240s) |
|---|---|---|---|---|---|---|
| rw.026 | saas/login | CANCELLED | **SUCCESS** | 6/6 | 88s | $0.0016 |
| rw.082 | search_lazy | CANCELLED | **SUCCESS** | 4/5 | 75s | $0.0015 |
| rw.095 | search | CANCELLED | **SUCCESS** | 6/7 | 90s | $0.0013 |
| rw.019 | saas/login | CANCELLED | HUMAN_ESCALATION（BUSINESS_INVALID_CREDENTIAL，正确升级） | 4/8 | 195s | $0.0037 |
| rw.044 | search | CANCELLED | HUMAN_ESCALATION（VERIFY_RETRY 耗尽） | 2/6 | 137s | $0.0018 |
| rw.077 | search | CANCELLED | HUMAN_ESCALATION（VERIFY_RETRY 耗尽） | 5/9 | 172s | $0.0025 |
| rw.091 | search | CANCELLED | HUMAN_ESCALATION（VERIFY_RETRY 耗尽） | 6/10 | 134s | $0.0031 |
| rw.092 | search | CANCELLED | HUMAN_ESCALATION（VERIFY_RETRY 耗尽） | 6/11 | 236s | $0.0021 |
| rw.096 | search | CANCELLED | HUMAN_ESCALATION（VERIFY_RETRY 耗尽） | 2/6 | 147s | $0.0024 |
| rw.100 | search | CANCELLED | HUMAN_ESCALATION（VERIFY_RETRY 耗尽） | 6/10 | 127s | $0.0024 |
| rw.056 | data_entry/form | CANCELLED | CANCELLED（240s 仍不够） | 4/12 | 244s | $0.0033 |

汇总：**SUCCESS uplift +3**（nominal 82%→85%@240s）；7 个到达真实升级终态（6×VERIFY_RETRY 耗尽 + 1×凭据错误）；1 个 240s 仍不够（rw.056）。总时长 1645s（120s 侧 11×~121s=1331s，增量 +26%）；总成本 $0.0257（avg $0.0023/任务）。

**关键归因（防误读）**：3 个 uplift 任务在 240s 下 75–90s 即完成——**并非任务本身需要 >120s**，而是 120s 基线里前序步骤的重试/恢复消耗了预算导致来不及收敛。deadline 的真实作用 = 给 recovery 留出收敛预算，而非单纯「多步链跑不完」。

---

## 6. 三口径终局

| 口径 | SUCCESS | 数值 | 性质 |
|---|---|---|---|
| **canonical（120s，冻结）** | 82/100 | 82% | 保真参照，永不覆盖 |
| **correct-escalation**（120s + 合理升级视为正确决策） | 82 + 1 CREDIBLE + 6 REAL 中 5 个 P1.2 后可修 1 | ≈84%（P1.2 后）+ 11 TIMEOUT 中 10 个 240s 到达合法终态 | 决策质量口径 |
| **deadline-adjusted（240s diagnostic，provisional）** | 82 + 3 uplift = 85（P1.2 后投影 86） | **85–86%** | 非权威，仅诊断 |

---

## 7. ROI 排序（下一阶段决策输入）

| 排名 | 项 | 预期收益 | 成本/风险 | 状态 |
|---|---|---|---|---|
| 1 | P1.2 bare-tag（resolver 层内） | +1 REAL→SUCCESS（82→83） | 极低，已交付，零回归 | ✅ 完成 |
| 2 | **VERIFY_RETRY 修复能力**（6/11 TIMEOUT 的真实瓶颈） | 潜在 +6（85→91 上限） | 中——需动 repair/healing 层，需单独取证+授权 | 待授权 |
| 3 | deadline 120→240 | +3（3pp），recovery 收敛预算 | 低风险高确定性；代价 +26% 时长、成本 ×1.5；7 个升级更真实但非 SUCCESS | 待授权 |
| 4 | planner 契约编造约束（rw.046/053/054/079/085 家族） | 潜在 +5 | **STOP A 禁改区**——需动 planner contract generation，风险最高 | 需显式授权 |
| 5 | rw.056 型（240s 仍不够，data_entry 12 项验证） | +1 | 疑似任务复杂度真实超预算，需个案取证 | 待授权 |
| 6 | elementMemory matchedBy 干扰（rw.004 波动面） | 稳定性收益 | 低；先观察不改 | 观察项 |

---

## 8. 合规声明

- frozen benchmark semantics（Success Definition / verification semantics / scoring）：**零修改**
- v2 pool / fixture / 120s canonical 数据 / v1 全部数据：**零修改、零覆盖**
- 本次运行：11 任务 240s diagnostic（独立落盘 `.benchmark/p2_240s_results.json`），**未跑** v2 100-task full benchmark，**未产生**新 benchmark success rate
- 双回归：78/0 + OK=71/BAD=0，零回归
- 5 个 CONTRACT_SELECTOR_MISMATCH 未被越权修复（smoke 复核确认未被「意外修通」）

## 9. 证据索引

- `.benchmark/P1_EVIDENCE.md`（P1.1 九问取证）
- `.benchmark/P1_P1.2_REPORT.md`（P1.2 修复报告）
- `.benchmark/p2_240s_results.json`（P2 240s 逐任务结果）
- `.benchmark/phase12_tag_v2baseline_1788306100968.json`（120s canonical，冻结）
- `.benchmark/p1_repro_element_present.js` / `p12_smoke_p1_2.js` / `p2_240s_diagnostic.js`（诊断脚本）

## 10. Decision Gate：STOP AND WAIT FOR AUTHORIZATION

Phase 13 全部指令完成（P1.1 → P1.2 → 双回归 → smoke → rw.079 分类 → P2 双口径）。下一阶段候选（ROI 排序见 §7），**未授权不启动任何新运行**：
- **A**：deadline 120→240 作为新 canonical（需重跑 v2 full baseline 才有权威数字）
- **B**：VERIFY_RETRY 修复能力专项（先 P1.1 式只读取证）
- **C**：planner 契约约束专项（触禁改区，需最高级别授权）
