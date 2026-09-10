'use strict';

// ============================================================================
// PHASE 17-C — Skill Evidence Chain（设计依据：§11 Evidence Model）
//
// 唯一目的：回答「**为什么认为这一步是正确的？**」（用户 §10 原问题）。
//
// 三条硬约束（§11.2 / §11.3）：
//   1. **摘要 + 引用，不存全文** —— 全文在 aiAttempts；证据链只放 digest 与 attempt 引用，
//      否则会重演 aiAttempts 42MB / 14446 条、同步阻塞事件循环数小时的事故。
//   2. **不存 selector / 坐标 / 值** —— 只存 groundedRole / groundedTag（供分析，不供重放）
//      + valueSource（值本身不入库）。
//   3. **绝不依赖 aiEvents** —— 它是 500 条环形缓冲（jsonStore.EVENT_MAX），
//      证据链必须独立持久化（aiSkillEvidence），否则 Skill 还在 ACTIVE 而证据已蒸发。
// ============================================================================

const crypto = require('crypto');

const COLLECTION = 'aiSkillEvidence';

// 摘要：sha256 前 16 hex（足够去重/比对，不构成体积负担）
function digestOf(value) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch (e) { text = String(value); }
  if (text == null) return null;
  return 'sha256:' + crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

function uid(prefix) {
  return (prefix || 'evchain') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 单个迁移的五要素（§11.1）：Observation(before) / Target / Action / Post-action Observation / Verification
// 输入为**运行时提炼好的**结构（Builder 负责从 step+attempt 抽取），此处只做形状收敛与脱敏兜底。
function makeTransition(input) {
  const t = input || {};
  const target = t.target || {};
  const action = t.action || {};
  const v = t.verification || {};
  return {
    stateFrom: t.stateFrom || null,
    stateTo: t.stateTo || null,
    // ① 动作前观察：摘要 + 指向 aiAttempts 的引用（全文在那里）
    obsBeforeDigest: t.obsBeforeDigest || null,
    obsBeforeRef: t.obsBeforeRef || null,
    // ② 目标：语义意图 + field + 接地结果（**绝不存 selector/坐标**）
    target: {
      intent: target.intent || null,
      field: target.field || null,
      groundedRole: target.groundedRole || null,
      groundedTag: target.groundedTag || null,
    },
    // ③ 动作：类型 + 取值来源（值本身不入库）
    action: {
      type: action.type || null,
      valueSource: action.valueSource || 'NONE',
    },
    // ④ 动作后观察
    obsAfterDigest: t.obsAfterDigest || null,
    obsAfterRef: t.obsAfterRef || null,
    // ⑤ 验证：契约原文 + 子句判定 + 总结论
    verification: {
      contract: v.contract || null,
      result: v.result || null,
    },
    at: t.at || Date.now(),
  };
}

function buildChain({ skillId, skillVersion, capability, intent, transitions }) {
  const list = (Array.isArray(transitions) ? transitions : []).map(makeTransition);
  return {
    id: uid('evchain'),
    skillId: skillId || null,
    skillVersion: typeof skillVersion === 'number' ? skillVersion : null,
    capability: capability || null,
    intent: intent || null,
    transitions: list,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// 五要素完整性：任一环缺失即不可晋升（§11.4）
//
// 关于「观察」这一环的判定口径（§11.2「**摘要 + 引用**，不存全文」）：
//   观察是否留痕 = 有 digest **或** 有指向 aiAttempts 的引用（ref）。二者任一即视为可追溯。
//   之所以不接受「必须同时有 digest」：成功路径的 observation 目前**不落在 attempt 上**
//   （只有 error.observationBefore 在失败时才落，见 stepManager.normalizeErrorShape），
//   若强制 digest 则任何真实证据链都恒不完整 —— 门槛会退化成恒假断言（本项目明令禁止）。
//   真实缺口以 digestAvailable 字段**如实暴露**，供 17-D/17-E 决定是否补持久化。
const REQUIRED_PARTS = ['obsBefore', 'obsAfter'];

function transitionMissing(tr) {
  const missing = [];
  if (!tr) return ['transition'];
  if (!(tr.obsBeforeDigest || tr.obsBeforeRef)) missing.push('obsBefore');
  if (!(tr.obsAfterDigest || tr.obsAfterRef)) missing.push('obsAfter');
  if (!tr.target || (!tr.target.intent && !tr.target.field)) missing.push('target');
  if (!tr.action || !tr.action.type) missing.push('action.type');
  if (!tr.verification || !tr.verification.contract) missing.push('verification.contract');
  if (!tr.verification || !tr.verification.result || tr.verification.result.ok !== true) missing.push('verification.result.ok');
  if (!tr.stateFrom || !tr.stateTo) missing.push('state.from/to');
  return missing;
}

function digestAvailable(tr) {
  return {
    obsBefore: !!(tr && tr.obsBeforeDigest),
    obsAfter: !!(tr && tr.obsAfterDigest),
  };
}

// 返回 { complete, missing: [{ index, stateFrom, stateTo, parts }] }
function chainCompleteness(chain) {
  const list = (chain && Array.isArray(chain.transitions)) ? chain.transitions : [];
  const missing = [];
  list.forEach((tr, index) => {
    const parts = transitionMissing(tr);
    if (parts.length) {
      missing.push({
        index,
        stateFrom: (tr && tr.stateFrom) || null,
        stateTo: (tr && tr.stateTo) || null,
        parts,
      });
    }
  });
  return { complete: list.length > 0 && missing.length === 0, total: list.length, missing };
}

function appendTransitions(chain, transitions) {
  if (!chain) return chain;
  const add = (Array.isArray(transitions) ? transitions : []).map(makeTransition);
  chain.transitions = (chain.transitions || []).concat(add);
  chain.updatedAt = Date.now();
  return chain;
}

module.exports = {
  COLLECTION, digestOf, uid, makeTransition, buildChain, chainCompleteness, appendTransitions,
  REQUIRED_PARTS, transitionMissing, digestAvailable,
};
