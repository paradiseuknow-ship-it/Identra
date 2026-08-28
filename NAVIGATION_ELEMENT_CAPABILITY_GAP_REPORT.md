# Navigation / Element Capability Gap — Controlled Audit

**Scope**: Locate the first real broken node for the ~83 non-success tasks in `phase68` (run `ALEt5f`), without modifying any code. This report addresses the user's §2–§6 audit questions: *is the "78 element failures" real, or a measurement problem?*

**Data sources** (read-only):
- `.benchmark/phase68_100task_raw.json` — per-task summary (status, taxonomy, plannerOk, credentialRequirement, verification pass/fail)
- `.benchmark/phase68_100task_store/aiAttempts.json` (995 attempts, with `error` + `status`)
- `.benchmark/phase68_100task_store/aiFailureSnapshots.json` (87 snapshots, `errorType`)
- `.benchmark/phase68_100task_store/aiEvents.json` (6469 events)
- `.benchmark/phase68_100task_store/aiTasks.json` / `aiSteps.json` / `aiRepairAttempts.json`

**Key limitation (stated up front)**: the captured store contains **no resolver candidate/ranking/visibility telemetry** (`matchedBy`, candidate count, score margin, bounding-box, aria-state are all absent). Therefore the 10 fine-grained failure categories cannot be *definitively* assigned. Every such category below is marked **UNOBSERVABLE** unless a coarser observable proxy exists. We do **not** guess.

---

## 1. Full execution-chain probe (per the requested 11-node chain)

| # | Node | Observable? | Finding |
|---|---|---|---|
| 1 | Planner | ✅ | 3 tasks crash (`JSON 解析失败`); 5 recovered by retry; 0 business gain |
| 2 | Target Contract | ⚠️ partial | Verification contracts use brittle forms: `element_present="input[value='无线鼠标']"`, `text_present="总用户数"`. Suggests TARGET_CONTRACT_AMBIGUOUS but not provable |
| 3 | Resolver | ❌ | **No candidate telemetry captured** → UNOBSERVABLE |
| 4 | Candidate Discovery | ❌ | UNOBSERVABLE |
| 5 | Candidate Ranking | ❌ | UNOBSERVABLE (no `matchedBy`/score/margin) |
| 6 | Element Resolution | ❌ | UNOBSERVABLE |
| 7 | Action Dispatch | ⚠️ partial | Failures are precondition blocks (E5) or `required unmet`, **not** dispatch errors. The 7 `动作成功` tasks prove dispatch can succeed |
| 8 | DOM Change | ⚠️ partial | 7 tasks report `页面稳定、动作成功` → DOM changed as intended |
| 9 | Observation | ❌ | No before/after observation diff captured → UNOBSERVABLE for staleness/visibility |
| 10 | Verification | ✅ (outcome) | 54/87 snapshots `VERIFICATION_FAILED`, 32 `UNKNOWN`, 1 `ELEMENT_NOT_FOUND` |
| 11 | Repair | ✅ | 253 repair attempts; dominant strategy `SEMANTIC_RELOCATE` exhausted after 4 retries (the `ai.failed` category is `ELEMENT_CHANGED`) |

**Net**: the only nodes with direct evidence are Planner, Action-precondition (E5), Verification-outcome, and Repair-exhaustion. Resolver/Discovery/Ranking/Element-Resolution/Observation are **black boxes** in this data.

---

## 2. Decomposing "78 navigation/element failures"

Original framing: ~78 tasks failed at navigation/element. After audit:

| Real bucket | Count | Nature |
|---|---:|---|
| ELEMENT_DISCOVERY_FAILURE | 51 | Resolver/verify could not satisfy the verification contract |
| CONTEXT_MISMATCH_E5 | 32 | **Guard blocked the action before dispatch** — NOT an element failure at all |
| └ of which saas-expected-GENERIC | 28 | Probable classifier/context misjudgment (see §4) |
| BUSINESS_STATE_MEASUREMENT_GAP | 7 | Action succeeded; verification could not confirm |
| PLANNER_CRASH | 3 | Separate class (not nav/element) |

**Important correction**: the "78 element failures" over-counts element problems. **32 of them are context-guard blocks** (the action never ran), and **7 are verification-too-strict** (action succeeded). The genuinely element-discovery-bound set is ~51, and even that is unproven to be TRUE absence (see §3).

---

## 3. Is it a measurement problem? (the central question)

For each hypothesized gap, the evidence:

| Hypothesis | Evidence | Verdict |
|---|---|---|
| **MEASUREMENT_GAP** (classifier misjudges saas login → guard over-blocks) | 28/30 saas tasks emit `期望站点=saas 但当前页面状态=GENERIC`. A login page should classify as `LOGIN_WALL`, not `GENERIC`. 93% concentration on one category is implausible as pure navigation failure. | **High-probability, but UNOBSERVABLE** to confirm without the classifier's input observation |
| **TRUE_DISCOVERY_GAP** (element truly absent) | `element_present="member-list"` etc. fail. Could be real absence OR brittle selector. No DOM proof either way. | UNOBSERVABLE |
| **TARGET_CONTRACT_AMBIGUOUS** (brittle verification selector) | `input[value='...']`, exact `text_present` of business-state strings. These are fragile contracts by construction. | **Plausible** (contract shape is observable) |
| **BUSINESS_STATE_MEASUREMENT_GAP** (action OK, verify can't confirm) | 7 tasks: `页面稳定、动作成功、目标未观察到、结构未变 —— 证据不足以判定成功`. Agent self-reports success. | **Confirmed subclass** (7 tasks) |
| **PAGE_STABILITY_GAP** (page not settled) | Phase 6.4 added `waitForPageReady`; no direct instability signal in data. | UNOBSERVABLE |
| **ACTIONABILITY_GAP** (found but not interactable) | No visibility/interactable telemetry. The 7 success-reporting tasks prove interactability works when found. | UNOBSERVABLE |

**Conclusion**: A material part of the "element failures" is **measurement/contract**, not capability:
- The 32 E5 blocks are most likely a **classifier false-positive** (P0), not missing elements.
- The 7 `动作成功但无法确认` are a **verification-too-strict** gap (confirmed subclass of business-state measurement gap).
- The remaining 51 element-discovery tasks **cannot be classified** without resolver telemetry and must not be assumed TRUE_DISCOVERY_GAP.

---

## 4. Why the saas-login E5 block is the prime suspect

Every saas login task (rw.001–rw.030) fails identically:

```
期望站点=saas 但当前页面状态=GENERIC，上下文明显错误（E5）   (e5=7 per task)
```

- `e5=7` means the guard fired on **every** action attempt (7 actions × retry), never allowing dispatch.
- If the page were *truly* generic (navigation failed), we would expect variety (some land on wrong site, some timeout). Instead it is **uniformly "GENERIC"** — the signature of a **classifier default/fallback label** when it cannot recognize the saas login page, not of a real navigation miss.
- This is exactly the `pageStateClassifier` (Phase 6.1) + `contextGuard` (Phase 6.2) interaction. The guard is *working as designed* (it blocks wrong-context actions); the likely defect is **upstream classification** mislabeling a valid login page as GENERIC.

> This is a **MEASUREMENT_GAP**, not an execution-capability gap. Fixing classification (not the agent's actions) could recover ~25 escalations — the largest single lever in the entire benchmark.

---

## 5. Recommended next instrumentation (prerequisite to any code fix)

To convert UNOBSERVABLE → measurable, add read-only telemetry (no behavior change) at:
1. `pageStateClassifier.classify` — log input `observation` + output `state/confidence/signals` for every saas-login page (confirms/denies §4).
2. `semanticResolver.resolve` — emit `{candidateCount, topScore, secondScore, matchedBy, canonicalMatchedBy, fellBack}` per call.
3. `verification` — emit before/after observation hash + the exact contract that failed.
4. `tools.execute` action dispatch — emit `{dispatched, dispatchError, domChanged}` so ACTION_DISPATCH_FAILURE vs precondition-block is distinguishable.

Until this exists, **do not modify the resolver** (per user §7/§9). The first broken node for the 51 discovery tasks remains unknown; guessing would violate the controlled-experiment discipline.

---

## 6. STOP

- Code modified: **NO**.
- Benchmark modified: **NO**.
- Success definition modified: **NO**.
- This report is **audit-only**. The actionable outcome is the telemetry plan above + the P0 classifier hypothesis, both requiring either authorization (to touch `pageStateClassifier`/`contextGuard`) or a telemetry-only Phase. No patch was applied.
