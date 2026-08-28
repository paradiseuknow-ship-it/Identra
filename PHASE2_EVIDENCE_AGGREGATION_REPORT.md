# Phase 2 Step 4 — B 类 P3 Evidence Aggregation 报告

> 范围：仅 `server/agent/verificationIntelligence.js` 新增纯函数 + 附加字段。
> 红线已遵守：未改 Business Success 定义 / 未改 benchmark / 未改任务池 / 未改 failure decision 枚举 /
> 未替换 VIL 主流程 / 未引入 mock-fake success。仅新增纯函数与附加字段。

## 1. 业务问题

VIL（`verificationIntelligence.js`）当前是「单信号 if-else 链」：每条分支依据单一事实
（如 `networkState=pending`、`domChanged=true`）直接产出 `failureType/decision`，
`confidence` 是写死的常量。它**缺一个把多次观察的多维证据聚合为「可解释分数」的层**，
导致：

- 未来验证层无法拿到「这次验证有多少证据支撑」的量化值；
- 无法区分「稳定无任何变化（证据=0）」与「多个强证据但暂未命中契约（证据高）」；
- 触发 Observation Window 重观察后，也没有统一的「窗口重观察」证据标记。

目标：在 Observation → Evidence → Verification 之间补一层**只读、可解释加权**的证据聚合，
输出供未来验证层消费，但**绝不**替 verification.js 做成功判定。

## 2. 代码位置

- `server/agent/verificationIntelligence.js`
  - 新增纯函数 `aggregateEvidence(beforeObservation, afterObservation, verificationWindow)`（插入在 `isReobservableDecision` 之后）。
  - 原 `analyze` 重命名为内部 `_analyze`（逻辑一字未改）。
  - 新增对外 `analyze(opts)` 包装层，仅向返回对象**附加** `verificationEvidence` 字段，原 `failureType/decision/confidence/evidence` 完全不变。
  - `module.exports` 增加 `aggregateEvidence`。

## 3. 最小 patch

### 3.1 新增 `aggregateEvidence`（纯函数，无副作用）

输入：`beforeObservation, afterObservation, verificationWindow(可选)`。
从观察事实派生 7 个信号（仅读 `previousObservationDiff / capturedAt / url`，不臆测 success）：

| 信号 | 来源 |
|---|---|
| `urlChanged` | `diff.urlChanged` 或 before/after url 不一致 |
| `keyTextChanged` | `diff.keyTextChanged \|\| diff.textChanged` |
| `elementStateChanged` | `diff.elementStateChanged` |
| `pageStructureChanged` | `diff.pageStructureChanged` |
| `freshObservation` | after 的 `capturedAt` 晚于 before（或 before 无时间戳） |
| `observationAge` | `now - after.capturedAt`（ms，无时间戳为 null） |
| `verificationWindowObserved` | 调用方传入的窗口标记 `{reobserved\|observed\|reObserve\|verified}` |

### 3.2 可解释加权（不硬编码 SUCCESS）

```
keyTextChanged          +0.35
urlChanged              +0.25
elementStateChanged     +0.15
pageStructureChanged    +0.10
freshObservation         +0.10
verificationWindowObserved +0.05
```
- 各信号独立加分，命中才加；总分防御性 clamp 到 [0,1]（权重和恰为 1.00）。
- 仅量化「证据多寡」，从不做 `score >= X → SUCCESS` 的结论。

返回：

```js
{
  evidenceScore: number,        // [0,1]
  evidenceReasons: string[],    // 每条加分的人类可读理由
  evidenceSignals: {            // 上述 7 个信号
    urlChanged, keyTextChanged, elementStateChanged,
    pageStructureChanged, freshObservation, observationAge, verificationWindowObserved
  }
}
```

### 3.3 `analyze` 包装层（仅附加，不改动决策）

```js
function analyze(opts) {
  const result = _analyze(opts || {});
  result.verificationEvidence = aggregateEvidence(
    (opts||{}).beforeObservation, (opts||{}).afterObservation, (opts||{}).verificationWindow
  );
  return result; // failureType / decision / confidence / evidence 原样保留
}
```

## 4. 测试

新增 `server/scripts/test_evidence_aggregation.js`（24/0）：

- **Case 1 多个强证据 → 高分**：url+keyText+elementState+pageStructure+fresh 全中，`evidenceScore=0.95`，reasons≥5。
- **Case 2 只有 DOM/结构变化 → 低分**：仅 `pageStructureChanged` 命中，`evidenceScore=0.10`，其余信号 false。
- **Case 3 无变化 → 接近 0**：无时间戳、无 diff，`evidenceScore=0`，reasons 为空。
- **Case 4 旧 Observation → fresh=false**：after 比 before 更旧，`freshObservation=false`，但 `keyTextChanged` 仍被检测。
- **Case 5 Verification Window 重观察**：传入 `{reobserved:true}`，`verificationWindowObserved=true`，score 含新鲜+窗口加分。
- **Case 6 analyze 集成守卫**：`analyze()` 返回的 `failureType/decision` 不变，`verificationEvidence` 正确附加（含 `observationAge>=0`）。

## 5. 回归

| 套件 | 结果 |
|---|---|
| test_phase10.js | PASS=19 FAIL=0 |
| test_phase11_business_contract.js | PASS=23 FAIL=0 |
| test_business_loop_repair.js | 25 passed, 0 failed |
| test_b1_b5_blocker_fix.js | PASS=31 FAIL=0 |
| test_resolver_repair.js | 11 通过 / 0 失败 |
| test_resolver_matchedby.js | 5 passed, 0 failed |
| test_submit_result_landing.js | 10 通过 / 0 失败 |
| test_evidence_aggregation.js | 24 passed, 0 failed |

全部 exit=0，无破坏。

## 6. 冻结边界确认

- ✅ 未修改 Business Success 定义（`verification.js` 最终判定权未动）。
- ✅ 未修改 benchmark 统计口径 / 任务池。
- ✅ 未修改任何 `failureType` / `decision` 枚举值（`analyze` 仅附加字段，原分支逻辑来自 `_analyze`，一字未改）。
- ✅ 未替换 verificationIntelligence 主流程（仅包一层附加字段）。
- ✅ 未引入 mock / fake success（`aggregateEvidence` 纯函数只读观察事实，无 SUCCESS 结论）。
- ✅ 改动仅落在 `verificationIntelligence.js` 单文件 + 新增测试；向后兼容——既有调用方拿到的是「原返回 + 多一个可选 `verificationEvidence` 字段」。

---
**状态**：Step 4 (B 类 P3) 完成。已停止，未进入 C/D，未运行 100-task，等待下一步授权。
