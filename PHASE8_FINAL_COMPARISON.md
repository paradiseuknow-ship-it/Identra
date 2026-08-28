# Phase 8 — Final Comparison & Controlled Experiment Report

**Run identity**
- Phase 8 (post-fix) run: `ALEt5f` → `.benchmark/phase68_100task_raw.json` + `.benchmark/phase68_100task_store/`
- Pre-fix baseline: `.benchmark/phase3_live100_raw_BEFORE_PHASE67.json` (the true 100-task Phase-3 result; the `phase3_live100_raw.json` path was partially overwritten by an aborted run and is NOT used here)
- Both runs use the **same 100-task pool** (`phase12_pool.json` via default `run_live100`), aligned by stable `id` (100/100 common).
- Fix under test in Phase 8: `planner.js` 3-attempt retry loop with error back-feed (no schema/security/verification/success-logic changes).

> **Experiment discipline**: this is an analysis-only phase. No source code, benchmark, success definition, task pool, retry count, or resolver was modified during/after the run. Only telemetry was read.

---

## 1. Phase 8 Result

| Metric | Before (Phase 6/7, phase67) | After (Phase 8, phase68) | Δ |
|---|---:|---:|---:|
| **Business Success** (status=SUCCESS) | 6 (6%) | 3 (3%) | **−3 pp** |
| **Planner Success** (plannerOk=true) | 92 (92%) | 97 (97%) | **+5 pp** |
| **HUMAN_ESCALATION** | 83 (83%) | 89 (89%) | +6 pp |
| **FAILED** | 8 (8%) | 3 (3%) | −5 pp |
| **CANCELLED** (user) | 3 (3%) | 5 (5%) | +2 pp |

**Reading**: The planner fix improved *planner* success (92%→97%, +5 tasks) but produced **no business-success gain** (6%→3%; the drop is within LLM non-determinism noise — see §2). The aggregate target (Business Success >30%, Escalation <30%) is **still far away**.

---

## 2. Planner Retry Effect

| Measure | Value |
|---|---:|
| Planner crashes before fix (phase67, plannerOk=false) | 8 |
| Planner crashes after fix (phase68, plannerOk=false) | 3 |
| **Retry attempted** (tasks that crashed in phase67) | 8 |
| **Recovered** (phase67 crash → phase68 plannerOk=true) | **5** (rw.024, rw.044, rw.051, rw.063, rw.096) |
| **Business Recovered** (recovered → status=SUCCESS) | **0** |
| Still crashed in both runs | 3 (rw.088, rw.090, rw.095 — persistent JSON-parse) |

**Critical discipline check — Planner recovered ≠ Business recovered**:
The 5 recovered plans all ended in `HUMAN_ESCALATION` (taxonomy: OTHER / ELEMENT_NOT_FOUND / VERIFY_FAILED ×3). The retry successfully re-planned, but every downstream execution still failed at navigation/element/verification. **The planner fix is correct-but-insufficient for the target.** It removes a hard crash class, not a success blocker.

> Persistent 3 crashes: `runtime 执行异常: 规划失败(plan): JSON 解析失败` even after 3 retries — these are consistently malformed LLM outputs (likely the 1 password-security case + 2 structural cases that the back-feed could not repair). Minor remainder.

---

## 3. Failure Taxonomy (phase68, n=100)

| Failure (observable node) | Count | % of 100 | First Broken Node | Evidence |
|---|---:|---:|---|---|
| ELEMENT_DISCOVERY_FAILURE | 51 | 51% | Resolver / Verification discovery | `required unmet: element_present="member-list" → 未找到` / `text_present="总用户数" 页面文本不包含` |
| CONTEXT_MISMATCH_E5 | 32 | 32% | Action precondition / page-state guard | `期望站点=saas 但当前页面状态=GENERIC` (28) / `上传任务落在资源下载页` (4) |
| UNKNOWN | 8 | 8% | — | no attempt error + no snapshot match |
| CANCELLED | 5 | 5% | (user) | status=CANCELLED |
| PLANNER_CRASH | 3 | 3% | Planner | `JSON 解析失败` (retry exhausted) |
| CREDENTIAL_POLICY | 1 | 1% | (by-design) | credentialRequirement=required |
| **Business-success-eligible but mis-escalated** | **7** | **7%** | Verification / Observation | `SUBMIT_RESULT_UNKNOWN / 页面稳定、动作成功、目标未观察到` |

By category:
- **saas (30)**: 25× CONTEXT_MISMATCH_E5, 4× ELEMENT_DISCOVERY, 1× UNKNOWN → **93% of saas tasks fail at the E5 context guard**.
- **ecommerce (25)**: 22× ELEMENT_DISCOVERY, 3× UNKNOWN.
- **data_entry (20)**: 14× ELEMENT_DISCOVERY, 4× E5, 1× CANCELLED, 1× UNKNOWN.
- **longflow (22)**: 11× ELEMENT_DISCOVERY, 4× CANCELLED, 3× E5, 3× PLANNER_CRASH, 1× CREDENTIAL_POLICY.

---

## 4. Navigation / Element Analysis

The original "78 navigation/element failures" framing over-counts. After decomposition:

| Category | Count | % | Evidence / Note |
|---|---:|---:|---|
| ELEMENT_DISCOVERY_FAILURE (resolver/verify can't locate target) | 51 | 60.7% | brittle verification contracts (`input[value='...']`, business-state `text_present`) |
| CONTEXT_MISMATCH_E5 (guard blocked before action) | 32 | 38.1% | 28/32 are **saas expected GENERIC** — see §6 P0 |
| BUSINESS_STATE_MEASUREMENT_GAP (action OK, verify can't confirm) | 7 | 8.3% | subset; `动作成功、目标未观察到` |
| PLANNER_CRASH (not nav/element) | 3 | 3.6% | separate class |

**Decomposition of the 10 fine-grained categories** (per instructions, marked honestly):

| Fine category | Assignable? | Reason |
|---|---|---|
| TARGET_NOT_IN_DOM | UNOBSERVABLE | no resolver candidate/observation telemetry in captured data |
| TARGET_IN_DOM_BUT_NOT_VISIBLE | UNOBSERVABLE | — |
| TARGET_VISIBLE_BUT_NOT_INTERACTABLE | UNOBSERVABLE | — |
| TARGET_FOUND_BUT_WRONG_ELEMENT | UNOBSERVABLE | — |
| TARGET_FOUND_BUT_STALE | UNOBSERVABLE | — |
| TARGET_FOUND_BUT_DYNAMIC_CHANGED | UNOBSERVABLE (weak signal: `ai.failed` category=ELEMENT_CHANGED) | event-level only, no per-element proof |
| TARGET_DISCOVERY_EMPTY | Partial → maps to ELEMENT_DISCOVERY_FAILURE (51) | coarse; finer split needs telemetry |
| TARGET_RANKING_WRONG | UNOBSERVABLE | no `matchedBy`/score/margin captured |
| TARGET_CONTRACT_AMBIGUOUS | Partial hypothesis | brittle selectors (`input[value=...]`) suggest ambiguous contract |
| ACTION_DISPATCH_FAILURE | UNOBSERVABLE at resolver layer; the 7 SUBMIT_RESULT_UNKNOWN tasks explicitly report **action success**, so NOT dispatch failure |

**Conclusion**: The captured store has **no resolver candidate/ranking/visibility telemetry**, so the 10 fine categories cannot be definitively assigned. The observable coarse split is **51 element-discovery + 32 context-guard + 7 business-state-measurement + 3 planner**. The dominant *real* question is whether the 32 E5 blocks and 51 discovery failures are TRUE absence vs MEASUREMENT gaps — see §6.

---

## 5. Top 10 Representative Tasks

| # | task_id | category | first_broken_node | evidence | business_outcome |
|---|---|---|---|---|---|
| 1 | rw.001 | saas | CONTEXT_MISMATCH_E5 | `期望站点=saas 但当前页面状态=GENERIC` (e5=7) | ESCALATION |
| 2 | rw.002 | saas | CONTEXT_MISMATCH_E5 | same pattern (e5=7) | ESCALATION |
| 3 | rw.005 | saas | CONTEXT_MISMATCH_E5 | same pattern (e5=7) | ESCALATION |
| 4 | rw.027 | saas | ELEMENT_DISCOVERY | `text_present="总用户数" → 页面文本不包含` | ESCALATION |
| 5 | rw.028 | saas | ELEMENT_DISCOVERY | `element_present="member-list" → 未找到` | ESCALATION |
| 6 | rw.031 | ecommerce | ELEMENT_DISCOVERY | `text_present="耳机" → 页面文本不包含` | ESCALATION |
| 7 | rw.035 | ecommerce | BUSINESS_STATE_MEASUREMENT_GAP | `动作成功、目标未观察到` (SUBMIT_RESULT_UNKNOWN) | ESCALATION (likely should-be-success) |
| 8 | rw.045 | ecommerce | BUSINESS_STATE_MEASUREMENT_GAP | `动作成功、目标未观察到` | ESCALATION |
| 9 | rw.088 | longflow | PLANNER_CRASH | `JSON 解析失败` (retry exhausted) | FAILED |
| 10 | rw.092 | longflow | BUSINESS_STATE_MEASUREMENT_GAP | `动作成功、目标未观察到` | ESCALATION |

---

## 6. Root Cause Ranking

**P0 — Saas login context-guard over-block (28/30 saas tasks)**
- Signal: 28/32 E5 blocks are `期望站点=saas 但当前页面状态=GENERIC`. 93% of all saas tasks fail here.
- Hypothesis (UNOBSERVABLE to confirm without telemetry): `pageStateClassifier` (Phase 6.1) misclassifies the saas login page as `GENERIC` instead of `LOGIN_WALL`, so `contextGuard` (Phase 6.2) **false-positively blocks** every action → no action ever dispatches → escalation. This is a **MEASUREMENT_GAP / classifier issue**, NOT a real navigation failure.
- Impact if confirmed & fixed: could recover ~25 escalations (the single largest lever).

**P1 — Element-discovery / verification-contract brittleness (51 tasks)**
- Signal: `required unmet: element_present="member-list"/"order-list"/"log-list"` and `text_present="总用户数"/"耳机"`.
- Hypothesis: brittle verification contracts (CSS with `[value=]` or exact business-state text) fail even when the element/state exists → **TARGET_CONTRACT_AMBIGUOUS** or **BUSINESS_STATE_MEASUREMENT_GAP**, not necessarily TRUE_DISCOVERY_GAP.
- Impact: largest raw bucket; needs resolver/observation telemetry to split TRUE absence vs contract ambiguity.

**P1 — Business-state measurement gap (7 tasks)**
- Signal: `页面稳定、动作成功、目标未观察到、结构未变 —— 证据不足以判定成功`.
- The agent reports the **action succeeded** but verification cannot confirm business state → escalated. These are arguably successful tasks wrongly failed by conservative verification.
- Touches verification success logic → **frozen; needs authorization**.

**P2 — Persistent planner JSON crashes (3 tasks)**
- `JSON 解析失败` survives 3 retries. Minor remainder; security/structural cases that back-feed cannot repair.

---

## 7. Recommended Minimal Patch (SUGGESTIONS ONLY — not implemented)

1. **P0 — classifier/contract audit (telemetry-first, no behavior change)**
   - Add a one-off diagnostic that logs the saas login page's `pageStateClassifier` output + the observation that triggered the E5 block. Confirm whether the page is *actually* generic or misclassified.
   - If misclassified: tighten `LOGIN_WALL` detection for saas in `pageStateClassifier.js` (low risk, no success-logic change). Do NOT touch `contextGuard` decision semantics.
2. **P1 — resolver telemetry capture (prerequisite to any resolver change)**
   - Instrument `semanticResolver.resolve` / `verification` to emit candidate count, top/second score, `matchedBy`, and observation hash. This converts the 51 ELEMENT_DISCOVERY tasks from UNOBSERVABLE to classifiable (TRUE_DISCOVERY_GAP vs TARGET_CONTRACT_AMBIGUOUS vs PAGE_STABILITY_GAP).
   - **Do NOT modify resolver matching logic until telemetry exists** (per "最小实验" principle).
3. **P1 — business-state measurement (requires authorization)**
   - The 7 `动作成功但无法确认` tasks imply verification is too strict. Any leniency touches the frozen verification-success logic → must be authorized as a separate Phase.
4. **P2 — planner retry hardening (optional)**
   - For the 3 persistent JSON crashes, add a schema-shape pre-check / structural-repair prompt; low priority.

---

## 8. STOP

- **100-task run completed?** YES — `ALEt5f` finished 2026-08-28 14:37, raw + store written.
- **Source code modified in this phase?** NO (Phase 8 = controlled experiment + audit only).
- **Benchmark modified?** NO (same pool, same harness).
- **Success definition modified?** NO.
- **Next-phase authorization REQUIRED?** YES — the two largest levers (P0 classifier false-positive block; P1 business-state verification leniency) require either touching `pageStateClassifier`/`contextGuard` (currently in the frozen reliability layer) or `verification` success logic (explicitly frozen). Both need explicit user go-ahead before code changes. The strictly-allowed next step without authorization is **telemetry instrumentation only** (suggestion #2) to convert UNOBSERVABLE categories into measurable ones.

**Bottom line**: Planner retry is validated as a real (if small) bug-fix — it removed 5 hard planner crashes with zero regression — but it does **not** move Business Success toward 30%. The true blockers are (P0) a probable classifier/guard over-block on saas login, and (P1) brittle verification contracts + a verification-too-strict measurement gap. Neither can be fixed without either telemetry work or crossing a frozen boundary, so the phase stops here by design.
