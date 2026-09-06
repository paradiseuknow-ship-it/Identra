'use strict';

// Step / Attempt / Repair 管理：Task 下执行单元的唯一写入口。
// 状态转换经 taskStateManager 校验；Repair 不覆盖原 Attempt（各自独立记录）。

const store = require('./store');
const tsm = require('./taskStateManager');
const fs = require('fs');
const path = require('path');

// 存储治理（2026-09-04）：aiAttempts error 内嵌完整 observation 曾产生 171KB 长尾记录
// （42MB 主文件的主要来源）。超过阈值的大证据体外置到 data/evidence/attempt_errors/，
// store 内保留 { externalized, file, byteSize } 指针 + url/title 轻摘要。
// 离线分析脚本（analyze_phase10 / trace_single_task 等）读 externalized 字段可按 file 还原。
const EVIDENCE_EXTERNAL_LIMIT = 4 * 1024;

function evidenceErrorDir() {
  const base = process.env.FPB_DATA_DIR
    ? path.resolve(process.env.FPB_DATA_DIR)
    : path.join(__dirname, '..', 'data'); // server/agent → server/data（与 storage/index.js resolveDataDir 一致）
  return path.join(base, 'evidence', 'attempt_errors');
}

function externalizeEvidence(attemptId, field, value) {
  let size = 0;
  try { size = (JSON.stringify(value) || '').length; } catch (e) { size = 0; }
  if (!value || typeof value !== 'object' || size <= EVIDENCE_EXTERNAL_LIMIT) {
    return { kept: value, externalized: false };
  }
  const file = attemptId + '.' + field + '.json';
  try {
    const dir = evidenceErrorDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), JSON.stringify({ externalizedAt: Date.now(), attemptId, field, value }), 'utf8');
    return {
      kept: {
        externalized: true,
        file: 'evidence/attempt_errors/' + file,
        byteSize: size,
        url: value.url || null,
        title: value.title || null,
      },
      externalized: true,
    };
  } catch (e) {
    // 外置失败（磁盘/权限）不改变失败记录语义：退回原值（宁可记录大，不丢证据）
    return { kept: value, externalized: false };
  }
}

function uid(p) {
  return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ---- Step ----
function createStep(taskId, planStep, index) {
  const step = {
    id: planStep.id ? taskId + '_' + planStep.id : uid('step_'), // 唯一：跨任务不复用固定 id，避免 aiSteps 串数据
    taskId,
    index,
    description: planStep.description || '',
    type: planStep.type || 'ACT',
    status: 'PENDING',
    action: planStep.action || null,
    verification: planStep.verification || (planStep.action && planStep.action.verification) || { type: 'none' },
    retryable: planStep.retryable !== false,
    attemptIds: [],
    currentAttemptId: null,
    maxRetries: planStep.maxRetries || 3,
  };
  store.insert('aiSteps', step);
  return step;
}

function listSteps(taskId) {
  return store.findWhere('aiSteps', (s) => s.taskId === taskId).sort((a, b) => a.index - b.index);
}

// B1 修复（2026-09-01）：replan 生成的 plan 步骤被 normalizeStrictToCanonical 统一重编号为
// step_001..N，若直接 createStep 会与既有（已 SUCCESS）步骤 id 冲突 —— getStep 命中旧步骤，
// 主循环「已终态跳过」逻辑误跳过 replan 新步骤，最终 B.4 收口守卫以 PENDING 残留判 FAILED
// （Final100 实证：rw.005/060/061/075，错误 id 与步骤位置错位是直接铁证）。
// 为 replan 步骤分配无冲突 id：base 未被占用原样返回；被占用则追加 _rp 序号（再冲突递增）。
// 无 base 时原样返回（createStep 走 uid 兜底，天然唯一）。
function uniqueStepId(taskId, baseId) {
  if (!baseId) return baseId;
  if (!getStep(taskId + '_' + baseId)) return baseId;
  let n = 1;
  while (getStep(taskId + '_' + baseId + '_rp' + n)) n++;
  return baseId + '_rp' + n;
}

function getStep(id) {
  return store.find('aiSteps', id);
}

function setStepState(stepId, next) {
  const step = getStep(stepId);
  if (!step) throw new Error('Step 不存在: ' + stepId);
  const prev = step.status;
  step.status = tsm.transitionStep(prev, next);
  store.upsert('aiSteps', step);
  return step;
}

// ---- Attempt ----
function createAttempt(stepId, executionId, action) {
  // v0.2.2：从 step 反推 taskId 一并落库，补齐观察血缘（Business Loop 专项 §七）。
  const step = getStep(stepId);
  const att = {
    id: uid('att_'),
    stepId,
    taskId: (step && step.taskId) || null,
    executionId,
    action: action || null,
    status: 'RUNNING',
    startedAt: Date.now(),
    endedAt: null,
    error: null,
    repairIds: [],
  };
  store.insert('aiAttempts', att);
  if (step) {
    step.attemptIds.push(att.id);
    step.currentAttemptId = att.id;
    store.upsert('aiSteps', step);
  }
  return att;
}

// v0.2.2：孤儿防护（Business Loop 专项 §十三~§十五）。
// 当 task 进入终态（SUCCESS/FAILED/HUMAN_ESCALATION/CANCELLED）时，任何仍停在 RUNNING 的 attempt
// 都视为孤儿（如 submit 整页导航导致 after-observation 挂起、被 STEP_TIMEOUT 抢跑，runStep 未收口即遗留）。
// 此处把这些在途 attempt 显式收口为 ORPHAN_ATTEMPT，杜绝「attempt 永久 RUNNING + step HEALING」的悬挂状态。
// v0.2.3（Engineering Phase P0-3）：孤儿 code 按动作类型精确分类。
// submit 类动作因整页导航导致 after-observation 挂起、被超时抢跑而遗留 RUNNING 孤儿，
// 其真实语义是「提交结果未知」，而非泛化 ORPHAN_ATTEMPT —— 便于 4-task Gate 精确计数
// 「submit 是否还产生孤儿 / 是否出现 SUBMIT_RESULT_UNKNOWN」。
function orphanCodeFor(attempt) {
  const t = attempt && attempt.action && attempt.action.type;
  return t === 'submit' ? 'SUBMIT_RESULT_UNKNOWN' : 'ORPHAN_ATTEMPT';
}

function finalizeOrphanAttempts(taskId) {
  const steps = listSteps(taskId);
  let count = 0;
  for (const s of steps) {
    const atts = listAttempts(s.id).filter((a) => a.status === 'RUNNING');
    for (const a of atts) {
      const code = orphanCodeFor(a);
      const msg = code === 'SUBMIT_RESULT_UNKNOWN'
        ? 'task 终态转换时 submit attempt 仍 RUNNING（提交结果未知），强制收口'
        : 'task 终态转换时 attempt 仍 RUNNING，强制收口（孤儿防护）';
      failAttempt(a.id, { code, message: msg });
      count += 1;
    }
  }
  return count;
}

function getAttempt(id) {
  return store.find('aiAttempts', id);
}

function updateAttempt(id, patch) {
  const att = getAttempt(id);
  if (!att) return null;
  store.upsert('aiAttempts', { ...att, ...patch });
  return getAttempt(id);
}

function succeedAttempt(id) {
  const att = updateAttempt(id, { status: 'SUCCESS', endedAt: Date.now() });
  attributeRepairOnSuccess(att);
  return att;
}

// Phase 7 Step 5 归因修复：当某 step 在 repair 之后出现 SUCCESS attempt，
// 将该（此前 FAILED 的）repair 归因为 SUCCESS，并把 repairId 记录到恢复成功的 attempt 上。
// 逻辑由 repairAttempts.reconcileRepair（纯函数）裁决，本函数仅负责落库。
function attributeRepairOnSuccess(att) {
  if (!att || !att.stepId) return;
  try {
    const repairAttempts = require('./repair/repairAttempts');
    const repairs = repairAttempts.listForStep(att.stepId).filter((r) => r.status === 'FAILED' && r.createdAt < att.startedAt);
    if (!repairs.length) return;
    const allAttempts = listAttempts(att.stepId);
    for (const r of repairs) {
      const recon = repairAttempts.reconcileRepair(r, allAttempts);
      if (recon.status === 'SUCCESS') {
        repairAttempts.update(r.id, { status: 'SUCCESS', error: null, finishedAt: Date.now(), attributedFrom: 'step_recovery' });
        for (const aid of recon.attributedAttemptIds) {
          const a = getAttempt(aid);
          if (a && !a.repairIds.includes(r.repairId)) {
            a.repairIds.push(r.repairId);
            store.upsert('aiAttempts', a);
          }
        }
      }
    }
  } catch (e) { /* 归因失败不影响主流程 */ }
}

// 失败错误必须保留结构化 { code, message }（Phase 3 契约）：原始失败不被二次异常覆盖，
// 也不降级为字符串——否则 errorClassifier / runtime errorHistory 读取 a.error.code 永远为 undefined，
// 导致错误被误分类（如导航失败被当成元素缺失）。
function normalizeErrorShape(err, attemptId) {
  if (err && typeof err === 'object') {
    const out = { code: err.code || 'UNKNOWN', message: String(err.message || '失败').slice(0, 300) };
    // v0.2.1：保留 Verification Intelligence 分类埋点字段（不新增 storage，随 error 落 aiAttempts）
    if (err.failureType) out.failureType = err.failureType;
    if (typeof err.confidence === 'number') out.confidence = err.confidence;
    if (Array.isArray(err.evidence)) out.evidence = err.evidence.slice(0, 5);
    // 存储治理：大观察体外置（>4KB），store 内留指针 + 轻摘要
    if (err.observationBefore) {
      const ex = externalizeEvidence(attemptId || 'att_unknown', 'observationBefore', err.observationBefore);
      out.observationBefore = ex.kept;
    }
    if (err.observationAfter) {
      const ex = externalizeEvidence(attemptId || 'att_unknown', 'observationAfter', err.observationAfter);
      out.observationAfter = ex.kept;
    }
    // C2（Phase 4）：透传 previousObservationDiff 到 error 顶层，保证 Observation→Diff→Evidence 链路完整。
    // 仅做字段透传，不新增存储、不改动 Evidence 评分逻辑（评分仍由 verificationIntelligence.aggregateEvidence 负责）。
    const diffSrc = (err.observationAfter && err.observationAfter.previousObservationDiff) || err.previousObservationDiff;
    if (diffSrc && typeof diffSrc === 'object') {
      const ex = externalizeEvidence(attemptId || 'att_unknown', 'previousObservationDiff', diffSrc);
      out.previousObservationDiff = ex.kept;
    }
    return out;
  }
  return { code: 'UNKNOWN', message: String(err || '失败').slice(0, 300) };
}
function failAttempt(id, error) {
  return updateAttempt(id, { status: 'FAILED', endedAt: Date.now(), error: normalizeErrorShape(error, id) });
}

function listAttempts(stepId) {
  return store.findWhere('aiAttempts', (a) => a.stepId === stepId).sort((a, b) => a.startedAt - b.startedAt);
}

module.exports = {
  createStep, listSteps, getStep, setStepState,
  uniqueStepId, // B1 修复：replan 步骤 id 无冲突分配（导出供 tryReplan 与针对性测试）
  createAttempt, getAttempt, updateAttempt, succeedAttempt, failAttempt, listAttempts, finalizeOrphanAttempts,
  orphanCodeFor,
  normalizeErrorShape, // 导出供测试（仅暴露既有纯函数，不改运行时行为）
};
