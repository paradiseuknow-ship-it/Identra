'use strict';
// Phase 9 P3 — 量化「VIL 观察窗口 100% 失效」的真实影响面（纯只读分析）。
//
// 背景：runtime.js 中 `browserManager.getPage(...)` 漏 await（getPage 是 async 函数），
// 传入观察窗口的是 Promise 而非 Page，导致窗口内每次 observation.inspect 都失败于
// `page.evaluate is not a function`，且失败被窗口内 catch 静默吞掉 → 窗口从不 recovered。
//
// 本脚本回答：在 phase68 的 100-task 真实跑批中，有多少失败本该被观察窗口处理？
// 判定依据：aiEvents 中 `ai.verification.decision` 的 failureType + decision。
//   - isReobservableDecision(WAIT / RECHECK_OBSERVATION / RETRY_VERIFY) → 本应进入观察窗口
//   - 这些在修复前全部空转（窗口内 0 次有效观察）→ 即为受影响样本
//
// 只读：不修改任何 store / 源码 / 判定逻辑。

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const STORE = process.env.PHASE68_STORE
  || path.join(ROOT, '.benchmark', 'phase68_100task_store');

const vil = require('../agent/verification/verificationIntelligence');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return null; }
}
function arr(v) { return Array.isArray(v) ? v : []; }

const attempts = arr(readJson(path.join(STORE, 'aiAttempts.json')));
const events = arr(readJson(path.join(STORE, 'aiEvents.json')));
const steps = arr(readJson(path.join(STORE, 'aiSteps.json')));
const tasks = arr(readJson(path.join(STORE, 'aiTasks.json')));

const stepById = new Map(steps.map((s) => [s.id, s]));
const taskById = new Map(tasks.map((t) => [t.id, t]));

// 1) 所有 VIL 决策事件
const decisions = events.filter((e) => e && e.type === 'ai.verification.decision');
const recoveredEvents = events.filter((e) => e && e.type === 'ai.verification.recovered');
const windowEvents = events.filter((e) => e && e.type === 'ai.verification.window');

// 2) 按 decision 分类
const byDecision = {};
const byFailureType = {};
let reobservable = 0;
const reobservableSamples = [];
for (const e of decisions) {
  const p = e.payload || {};
  const d = p.decision || '?';
  const ft = p.failureType || '?';
  byDecision[d] = (byDecision[d] || 0) + 1;
  byFailureType[ft] = (byFailureType[ft] || 0) + 1;
  if (vil.isReobservableDecision(d)) {
    reobservable += 1;
    const step = stepById.get(e.stepId) || {};
    const action = step.action || {};
    reobservableSamples.push({
      stepId: e.stepId, taskId: e.taskId, attemptId: e.attemptId,
      decision: d, failureType: ft,
      actionType: action.type || null,
      risk: action.risk || null,
      semantic: (action.target && (action.target.semantic || action.target.field || action.target.text)) || null,
      taskName: (taskById.get(e.taskId) || {}).name || null,
    });
  }
}

// 3) 受影响样本的「动作类型」分布 —— 判断修复的主要受益面
const byActionType = {};
for (const s of reobservableSamples) {
  byActionType[s.actionType || '?'] = (byActionType[s.actionType || '?'] || 0) + 1;
}
// 敏感动作（submit/login/... 与 CRITICAL）在 VIL 中会被一刀切 HUMAN_ESCALATE，
// 此处统计「可重观察但因敏感而被拦截」的规模，用于评估下一个断裂点。
const SENSITIVE_TYPES = new Set(['purchase', 'payment', 'password_change', 'delete', 'update_account_settings', 'submit', 'login', 'logout']);
const escalateSensitive = decisions.filter((e) => {
  const p = e.payload || {};
  if (p.decision !== 'HUMAN_ESCALATE') return false;
  const step = stepById.get(e.stepId) || {};
  const action = step.action || {};
  return action.risk === 'CRITICAL' || SENSITIVE_TYPES.has(action.type);
});
const escalateSensitiveByType = {};
for (const e of escalateSensitive) {
  const step = stepById.get(e.stepId) || {};
  const t = (step.action || {}).type || '?';
  escalateSensitiveByType[t] = (escalateSensitiveByType[t] || 0) + 1;
}

// 4) 受影响的独立任务数（去重）
const affectedTasks = new Set(reobservableSamples.map((s) => s.taskId));

// 5) 验证失败总规模（attempt 级）
const verifyFailed = attempts.filter((a) => a && a.error && a.error.code === 'VERIFY_FAILED');

const out = {
  source: STORE,
  totals: {
    tasks: tasks.length, steps: steps.length, attempts: attempts.length,
    verifyFailedAttempts: verifyFailed.length,
    vilDecisions: decisions.length,
    vilRecoveredEvents: recoveredEvents.length,
    vilWindowEvents: windowEvents.length,
  },
  byDecision,
  byFailureType,
  reobservable: {
    count: reobservable,
    affectedTaskCount: affectedTasks.size,
    affectedTaskIds: Array.from(affectedTasks),
    byActionType,
    // 按 failureType 分组的 taskId：DOM_CHANGED / VERIFICATION_TOO_STRICT 是最可能真正被
    // 窗口恢复的类型（页面确实变了 / 目标确实存在）；STATE_UNKNOWN 多为契约问题，恢复概率低。
    taskIdsByFailureType: reobservableSamples.reduce((acc, s) => {
      const k = s.failureType || '?';
      (acc[k] = acc[k] || []).push(s.taskId);
      return acc;
    }, {}),
    samples: reobservableSamples.slice(0, 40),
  },
  sensitiveEscalate: {
    count: escalateSensitive.length,
    byActionType: escalateSensitiveByType,
  },
};

const outPath = path.join(ROOT, '.benchmark', 'phase9_p3_vil_window_impact.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf-8');

console.log('== Phase 9 P3：VIL 观察窗口失效影响面（只读分析）==');
console.log('数据源：' + STORE);
console.log('  tasks=' + out.totals.tasks + '  steps=' + out.totals.steps + '  attempts=' + out.totals.attempts);
console.log('  VERIFY_FAILED attempts : ' + out.totals.verifyFailedAttempts);
console.log('  VIL decisions          : ' + out.totals.vilDecisions);
console.log('  VIL recovered 事件     : ' + out.totals.vilRecoveredEvents + '   ← 修复前应为 0（窗口 100% 空转）');
console.log('  VIL window 迭代事件    : ' + out.totals.vilWindowEvents + '   ← 空转的窗口迭代');
console.log('\n  本应进入观察窗口（reobservable）: ' + out.reobservable.count
  + '  涉及独立任务 ' + out.reobservable.affectedTaskCount + ' 个');
console.log('  动作类型分布: ' + JSON.stringify(out.reobservable.byActionType));
console.log('\n  决策分布: ' + JSON.stringify(out.byDecision));
console.log('  失败类型分布: ' + JSON.stringify(out.byFailureType));
console.log('\n  敏感动作被一刀切 HUMAN_ESCALATE（不进窗口）: ' + out.sensitiveEscalate.count);
console.log('  按动作类型: ' + JSON.stringify(out.sensitiveEscalate.byActionType));
console.log('\n结果已写入: ' + outPath);
