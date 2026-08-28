// Regression test for Phase 7 — Illegal Step state transition `SUCCESS -> HEALING` crash.
//
// Root cause (live 100-task analysis, phase3_live100_raw.json):
//   27/100 tasks (ALL FAILED) aborted with "runtime 执行异常: 非法 Step 状态转换: SUCCESS -> HEALING".
//   A repair action sets a step to SUCCESS in the store, but the local `steps[index]` snapshot is stale;
//   the runtime `while` loop (which does NOT increment `index` after the retry-exhausted repair branch)
//   re-enters the same step, re-runs it, fails, and calls `setStepState(step.id, 'HEALING')` — colliding
//   with the store's SUCCESS state. `transitionStep` then throws, crashing the whole task to FAILED.
//
// Fix (server/agent/runtime.js):
//   - The SUCCESS-skip guard now reads the AUTHORITATIVE store status via `stepManager.getStep(step.id)`.
//   - Both HEALING transitions (canRetry branch & retry-exhausted branch) are guarded: if the step is
//     already SUCCESS/SKIPPED in the store, advance (`index++`) instead of attempting an illegal HEALING.
//
// Test strategy (consistent with test_runtime_replan_const_regression.js):
//   [A] Static scan of the real runtime.js to assert the three guard sites are present and read store status.
//   [B] Functional micro-reproduction using the REAL taskStateManager.transitionStep:
//       - Original bug: setStepState(HEALING) on a SUCCESS step throws (reproduces the crash).
//       - Fixed logic: guard reads getStep -> SUCCESS -> advances, never calls setStepState(HEALING), no throw.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const tsm = require('../agent/taskStateManager'); // real transition authority

const RUNTIME_PATH = path.join(__dirname, '..', 'agent', 'runtime.js');
const src = fs.readFileSync(RUNTIME_PATH, 'utf8');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('  FAIL: ' + msg); }
  else console.log('  PASS: ' + msg);
}

// ---- [A] Static scan ----
console.log('[A] Static scan of real runtime.js');

// 1) SUCCESS-skip guard consults authoritative store status
assert(
  /const _liveStatus = \(stepManager\.getStep\(step\.id\) \|\| \{\}\)\.status;\s*\n\s*if \(_liveStatus === 'SUCCESS' \|\| _liveStatus === 'SKIPPED'\)/.test(src),
  'run() loop: SUCCESS-skip guard reads `stepManager.getStep(step.id)` (authoritative), not stale local `step.status`'
);

// 2) canRetry branch HEALING is guarded
assert(
  /const _live = \(stepManager\.getStep\(step\.id\) \|\| \{\}\)\.status;\s*\n\s*if \(_live === 'SUCCESS' \|\| _live === 'SKIPPED'\) \{ index\+\+; pendingAction = null; continue; \}\s*\n\s*stepManager\.setStepState\(step\.id, 'HEALING'\);/.test(src),
  'canRetry branch: HEALING transition guarded — advances if step already SUCCESS/SKIPPED in store'
);

// 3) retry-exhausted branch HEALING is guarded
assert(
  /const _liveR = \(stepManager\.getStep\(step\.id\) \|\| \{\}\)\.status;\s*\n\s*if \(_liveR === 'SUCCESS' \|\| _liveR === 'SKIPPED'\) \{ index\+\+; pendingAction = null; continue; \}\s*\n\s*stepManager\.setStepState\(step\.id, 'HEALING'\);/.test(src),
  'retry-exhausted branch: HEALING transition guarded — advances if step already SUCCESS/SKIPPED in store'
);

// 4) sanity: transitionStep still forbids SUCCESS->HEALING (proves the bug class is real & guard is needed)
let threw = false;
try { tsm.transitionStep('SUCCESS', 'HEALING'); } catch (e) { threw = /非法 Step 状态转换/.test(e.message); }
assert(threw, 'taskStateManager.transitionStep(SUCCESS, HEALING) still throws (bug class is real — guard is necessary)');

// ---- [B] Functional micro-reproduction ----
console.log('[B] Functional micro-reproduction (real transitionStep authority)');

// Fake stepManager mirroring the real one's contract: getStep = authoritative; setStepState throttled by real FSM.
function makeFakeStepManager(initialStatus) {
  const store = { step1: { id: 'step1', status: initialStatus } };
  return {
    getStep: (id) => (store[id] ? { ...store[id] } : null),
    setStepState: (id, next) => {
      const prev = store[id].status;
      store[id].status = tsm.transitionStep(prev, next); // real FSM — throws on illegal
      return store[id];
    },
  };
}

// B.1 — Original crash: a SUCCESS step is (incorrectly) sent to HEALING.
(function originalBugRepro() {
  const sm = makeFakeStepManager('SUCCESS');
  let crashed = false;
  try { sm.setStepState('step1', 'HEALING'); }
  catch (e) { crashed = /非法 Step 状态转换: SUCCESS -> HEALING/.test(e.message); }
  assert(crashed, 'B.1 original bug: setStepState(SUCCESS -> HEALING) throws the exact runtime crash');
})();

// B.2 — Fixed loop logic: guard reads authoritative store status and advances instead of healing.
(function fixedLoopLogic() {
  const sm = makeFakeStepManager('SUCCESS');
  // Replicate the exact guarded decision used at all three sites in runtime.js:
  let advanced = false, healed = false;
  const step = { id: 'step1' };
  const live = (sm.getStep(step.id) || {}).status;
  if (live === 'SUCCESS' || live === 'SKIPPED') { advanced = true; /* index++ */ }
  else { sm.setStepState(step.id, 'HEALING'); healed = true; }
  assert(advanced && !healed, 'B.2 fix: when store status is SUCCESS, loop advances (no HEALING, no crash)');
  assert(sm.getStep('step1').status === 'SUCCESS', 'B.2 fix: step remains SUCCESS (not corrupted by illegal transition)');
})();

// B.3 — Non-terminal case still heals correctly (guard must not over-skip).
(function nonTerminalStillHeals() {
  const sm = makeFakeStepManager('RUNNING');
  let advanced = false, healed = false;
  const step = { id: 'step1' };
  const live = (sm.getStep(step.id) || {}).status;
  if (live === 'SUCCESS' || live === 'SKIPPED') { advanced = true; }
  else { sm.setStepState(step.id, 'HEALING'); healed = true; }
  assert(!advanced && healed, 'B.3 guard does NOT skip a RUNNING step — HEALING still applied (no over-skip)');
  assert(sm.getStep('step1').status === 'HEALING', 'B.3 RUNNING -> HEALING transition succeeds as before');
})();

console.log('');
if (failures === 0) {
  console.log('PHASE 7 REGRESSION TEST PASSED — illegal SUCCESS->HEALING crash fixed & guard does not over-skip.');
  process.exit(0);
} else {
  console.error('PHASE 7 REGRESSION TEST FAILED — ' + failures + ' assertion(s) failed.');
  process.exit(1);
}
