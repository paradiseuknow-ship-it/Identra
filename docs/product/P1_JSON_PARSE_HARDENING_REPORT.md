# P1 JSON Parse Failure 加固报告（2026-09-01）

## 1. ROOT CAUSE

**rw.063 / rw.091 不是「外壳不规范」，而是 completion 截断。**

证据链（token 取证，非错误字符串推断）：

| 证据 | rw.063 | rw.091 |
|---|---|---|
| tokensCompletion | **18432** | **18432** |
| 18432 ÷ 2048 | **= 9 整**（3 外层 planner attempt × 3 内层 deepseek 重试） | 同 |
| latency | 93.0 s | 97.6 s |
| 对照组（SUCCESS 任务）单次 completion | 300–1100 tokens | — |

即：两任务的 **9 次规划调用全部打满 `max_tokens: 2048` 上限被截断** → JSON 半途而废 →
提取必败 → `lastHint='JSON 解析失败'` → 同参数重试 → 确定性 9/9 失败。

六问回答：
1. **原始模型输出是什么**：一次超长的严格 Plan JSON，在 2048 token 处被 API 截断（`finish_reason=length`）。原始 content 未落盘（recorder 只记 tokens/时长），此为基于逐次调用的 token 数学 + 延迟拟合的强证据推断。
2. **属于哪类**：**token 截断**（不是 fence/解释文本/多 JSON/trailing comma/schema 外结构）。
3. **是否同一种失败**：是，两任务完全同构（9×2048）。
4. **共同触发条件**：多步骤长计划（rw.091 支付 longflow ~15 步；rw.063 五条手机号批量录入）+ 每步强制 verification/expectedBusinessState 使单步 verbose → 计划总长超 2048。prompt 长度无关（~1650 tokens/call）。
5. **parser 是否有 fallback**：有（fence 剥离 + 首 `{` 末 `}` 切片），但**截断属于「模型未表达完整」，本就不应恢复**。
6. **为什么救不回**：截断的 JSON 无法安全解析；正确行为是拒绝 + 让下次重试在预算内完成，而非 parser 补语义。

## 2. MINIMAL FIX

| # | 改动 | 文件 | 性质 |
|---|---|---|---|
| 1 | 新建**单一可审计 JSON 提取模块**：安全剥离 fence（含末尾未闭合围栏）、剥离前后解释文本、首 `{`/`[` 到末 `}`/`]` 单候选提取；截断/非法输出必须 `UNPARSEABLE` 拒绝；返回 `recovered: FENCE/SLICE/RAW` 审计标签 | `server/agent/llm/jsonExtract.js`（新） | parser robustness（授权范围内） |
| 2 | `deepseekPlan` 改用共享模块；**规划 maxTokens 2048→8192**（`DEEPSEEK_PLAN_MAX_TOKENS` 可覆盖）；`finish_reason=length` → 重试 hint 要求精简，最终错误携带「截断」标识（可审计，不再伪装成「JSON 解析失败」），返回 `truncated` 标记 | `server/agent/llm/providers/deepseek.js` | 生成参数 + 审计口径 |
| 3 | `provider.structured` 共用同一提取实现（消除两份同构逻辑漂移风险） | `server/agent/llm/provider.js` | 去重 |

**禁止项全部未触碰**：不猜字段/不补字段/不 canonicalize/不生成缺失 steps/不改 schema/Success Definition/评分/credentialRef 契约。截断 JSON 仍必须拒绝（test F 锁定）。

## 3. TEST RESULTS

`server/scripts/test_json_extract.js`（15 项，A–H 全覆盖 + I–O 扩展）：

- A 正常 JSON→RAW ✓ B fence→FENCE ✓ C 前后文本→SLICE ✓ D whitespace ✓
- E trailing comma→拒绝 ✓ **F 截断→必须拒绝** ✓
- G schema-invalid 可解析→parser ok 且 `validatePlanStrict` 拒绝 ✓
- **H credentialRef/value deep-equal 零修改** ✓ I 大括号文本不污染 ✓ J 未闭合围栏 ✓ K 空输出 ✓
- L deepseekPlan fence 成功+maxTokens=8192 ✓ M 截断→错误含「截断」标识+3 次收口 ✓ N schema 违规文案 ✓ O provider.structured 共用模块 ✓

**两遍运行：PASS=15 FAIL=0 ×2**

## 4. REGRESSION RESULTS

顺序执行（并行会假失败）：

- `runRegression.js`：**通过 63 失败 0**（基线 62 + 新测试自动收编）
- `run_phase9_regression.sh`：**OK=56 BAD=0**（基线 55 + 新测试）

零生产语义回归。

## 5. 5-TASK SMOKE（真实 DeepSeek，PHASE12_TAG=jsonfix5 隔离）

分层：rw.063（普通 none，**原 JSON-parse 失败任务**）/ rw.001（required）/ rw.091（payment CRITICAL，**原截断任务**）/ rw.057（长 objective）/ rw.086（多步骤 longflow）。

| 任务 | 结果 | 判定 |
|---|---|---|
| rw.063 | **planner OK**，8/12 步执行 → 120s deadline TIMEOUT | **JSON parse failure 消失** ✓ |
| rw.091 | **planner OK**，4/11 步执行 → 120s deadline TIMEOUT | **截断消失** ✓ |
| rw.001（required） | SUCCESS 5/5 | credentialRef 正常，无串线 ✓ |
| rw.057（长 objective） | SUCCESS 5 步 | ✓ |
| rw.086（多步骤） | Fix#1 正确触发：none+login 空清单 → CREDIBLE 升级 | 无明文凭据、无 cred_ 幻觉 ✓ |

汇总：Business 40%（2 SUCCESS + 2 deadline TIMEOUT + 1 正确 CREDIBLE）、Planner 80%、**JSON parse failure 2/2 → 0/2**、schema gate 未绕过、required/none 无串线。TIMEOUT 为已知 harness 120s 口径（多步 longflow 偏紧），与本修复无关、未改动。

## 6–7. P2

已进入并完成只读 taxonomy → 见 `VERIFY_FAILURE_TAXONOMY.md`。
