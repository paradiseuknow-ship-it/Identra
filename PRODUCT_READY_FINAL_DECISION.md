# Product Readiness Final Decision

**Date**: 2026-08-28
**Basis**: Phase 3 Live 100-task Evaluation（真实 DeepSeek + Chromium，冻结 100 场景）vs STEP 1 修正后基线
**Verdict**: **B — CONDITIONALLY READY**（条件就绪，可进入受控 beta）

---

## 判定依据（仅以 live 客观数据为准，不仅凭测试绿）

| 维度 | 数据 | 判定 |
|------|------|------|
| Business Success | 6% (6/100)，基线 5% | 微增，仍低 → 非 A |
| HUMAN_ESCALATION | 55 vs 基线 81（−26, −32%） | 显著改善 ✅ |
| STATE_UNKNOWN (FT) | 5 vs 基线 38（−33, −87%） | 显著改善 ✅ |
| false-success / silent pass | 0 | 安全 ✅ |
| sensitive auto-success | 0（12 敏感场景全升级/失败） | 安全 ✅ |
| ErrorClassifier 覆盖 | 100% (49/49) | 达标 ✅ |
| raw/derived 一致性 | 0 mismatch / 0 conflict | 口径一致 ✅ |
| Evidence Score 可测性 | 不可测（store 捕获缺口） | 缺口 ⚠️ |
| 执行层失败（FAILED/CANCELLED） | FAILED 36 + CANCELLED 3 | 执行层瓶颈 ⚠️ |

**为什么不是 A**：Business Success 仅 6%，系统仍无法完成绝大多数真实任务。验证层改善不能掩盖执行/规划层的能力缺口。
**为什么不是 C**：验证与决策层已被 live 数据证实有效——歧义态大幅消解、零误判成功、敏感动作零越权、分类覆盖率 100%，无口径冲突。系统“判断得更好、且判断得安全”，只是“做得成的事仍少”。

---

## 剩余 Blocker（进入 controlled beta 前须明确）

1. **B1 — 业务完成率瓶颈在验证层之外**
   - FAILED 36 + CANCELLED 3 占 39%，主要由登录墙、验证失败、执行超时/资源取消导致。
   - 归因指向 planner / action / browser 执行层，不在本 Measurement Gate 冻结范围内（已严守冻结边界）。

2. **B2 — Evidence Score 生产遥测缺失**
   - store 未落盘 `previousObservationDiff`（0/715），且 snapshot 时间戳为 epoch-ms 数字导致 `aggregateEvidence.toTs` 解析失败。
   - 影响：无法在线上量化验证证据强度（P3 能力本身单测 24/0 通过，属可观测性缺口）。

3. **B3 — CANCELLED 3 个任务需执行层归因**
   - 3/100 任务被主动取消，需确认是预算/超时策略还是执行异常。

---

## 进入 Controlled Beta 的条件

满足以下全部方可有限放开：

- [ ] **C1**：B1 中 FAILED/CANCELLED 至少抽样 10 个做根因分析，确认非验证层回归且给出执行层最小 patch 计划。
- [ ] **C2**：B2 补齐 store 对 `previousObservationDiff` 的落盘 + 时间戳统一为 ISO 字符串，使 Evidence Score 可在下一轮 live 中测量。
- [ ] **C3**：B3 的 3 个 CANCELLED 归因关闭或确认为预期策略行为。
- [ ] **C4**：保留本 live run 的 raw artifact（`phase3_live100_raw.json` + `phase3_live_raw_store/`）作为 beta 对比基线，后续重跑须可逐项 diff。

---

## 安全与冻结合规确认

- ✅ 全程未修改 Business Success Definition / benchmark task pool / decision 语义 / 历史 baseline。
- ✅ 所有改动为新增 orchestrator/后处理脚本（run_live100.js / analyze_live100.js），既有 harness 与口径零改动。
- ✅ live 运行：无 mock、无假跑、无手工修正、无特殊适配。
- ✅ 敏感动作安全边界在 live 中实证有效（0 越权）。

---

## 一句话结论

**验证与决策层 CONDITIONALLY READY**（改善可测、安全可证、口径一致），但整体产品 **NOT FULLY READY**——业务完成率 6% 的瓶颈在验证层之外的执行/规划层。建议进入受控 beta，并按 C1–C4 收口后复评。
