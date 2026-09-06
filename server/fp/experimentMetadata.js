'use strict';

// Phase 14.5 — Controlled Experiment Metadata（受控实验元数据）
//
// 纪律（Phase 14 规格 §六）：受控实验必须单变量。
//   ✅ Experiment A: same browser / fingerprint / profile / task，ONLY network changed
//   ❌ network + fingerprint + timezone + locale + profile 同时变 → 无法归因，直接拒绝
//
// 单变量判定复用 EnvironmentDelta：baseline vs candidate 环境中，除 variableUnderTest
// 对应 section 外，任何其他 section 出现 CHANGED → EXPERIMENT_MULTI_VARIABLE 拒绝。
// 归因结论只允许「correlated」，禁止直接写「confirmed」。

const { computeEnvironmentDelta } = require('./environmentDelta');

// 变量名 → 快照 section 映射（variableUnderTest 必须落到明确的 section 上）
const VARIABLE_SECTION = {
  network: 'network',
  proxy: 'network',
  fingerprint: 'fingerprint',
  browser: 'browser',
  profile: 'profile',
  session: 'session',
};

const EXPERIMENT_ID_PREFIX = 'exp_';

function createExperiment({ variableUnderTest, baselineEnvironment, candidateEnvironment, controlId = null, label = null } = {}) {
  const section = VARIABLE_SECTION[variableUnderTest];
  if (!section) {
    const err = new Error(`[experiment] unknown variableUnderTest "${variableUnderTest}"（允许: ${Object.keys(VARIABLE_SECTION).join('/')}）`);
    err.code = 'EXPERIMENT_UNKNOWN_VARIABLE';
    throw err;
  }
  if (!baselineEnvironment || !candidateEnvironment) {
    const err = new Error('[experiment] baselineEnvironment 与 candidateEnvironment 均必填');
    err.code = 'EXPERIMENT_MISSING_ENVIRONMENT';
    throw err;
  }
  const delta = computeEnvironmentDelta(baselineEnvironment, candidateEnvironment);
  const illegal = delta.changedSections.filter((s) => s !== section);
  if (illegal.length) {
    const err = new Error(
      `[experiment] 多变量实验被拒绝：variableUnderTest=${variableUnderTest}（${section}）但 ${illegal.join('/')} 也发生变化——无法归因`
    );
    err.code = 'EXPERIMENT_MULTI_VARIABLE';
    err.delta = delta;
    throw err;
  }
  if (delta.status === 'UNCHANGED') {
    const err = new Error(`[experiment] baseline 与 candidate 环境完全一致——变量 ${variableUnderTest} 未实际改变，实验无意义`);
    err.code = 'EXPERIMENT_NO_VARIABLE_CHANGE';
    err.delta = delta;
    throw err;
  }
  return {
    experimentId: EXPERIMENT_ID_PREFIX + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    controlId,
    label,
    variableUnderTest,
    variableSection: section,
    baselineEnvironment, // 引用 baseline snapshot（含 fingerprintId / network.ip 等元数据，无凭证）
    candidateEnvironment,
    environmentDelta: delta,
    attributionRule: '结论仅允许表述为「network change correlated / did not change outcome」，禁止「IP reputation confirmed」（除非有独立证据）',
    createdAt: Date.now(),
  };
}

// 实验结果归因措辞守卫：拒绝 confirmed/sole cause 类越界表述
function validateAttributionWording(text) {
  const violations = [];
  if (/\b(confirmed|proven|sole cause|唯一原因|实锤)\b/i.test(String(text))) {
    violations.push('归因措辞越界：单变量实验只能得出 correlated / did not change outcome');
  }
  return { ok: violations.length === 0, violations };
}

module.exports = { createExperiment, validateAttributionWording, VARIABLE_SECTION, EXPERIMENT_ID_PREFIX };
