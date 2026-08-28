'use strict';

// Plan Schema：所有 LLM 生成的 Plan 必须经此校验，非法即拒绝。
// Plan 结构：
// {
//   goal: string,
//   steps: [{
//     id, type(NAVIGATE/OBSERVE/ACT/VERIFY/EXTRACT), description, expectedOutcome, risk,
//     action?: Action(可选，运行时二次校验)
//   }]
// }

const { validateAction, RISK_LEVELS, ACTION_TYPES, TYPE_RISK_FLOOR, VERIFICATION_TYPES } = require('./action');

// 与 schema/action.js 的 TARGET_KEYS 保持一致（action.js 未导出，此处本地定义单一真源）
const TARGET_KEYS = ['semantic', 'role', 'field', 'text', 'selector', 'index', 'url'];

const STEP_TYPES = ['NAVIGATE', 'OBSERVE', 'ACT', 'VERIFY', 'EXTRACT'];

const INSTRUCTIONS = `输出 JSON 格式的 Plan：
{
  "goal": "一句话目标",
  "steps": [
    {
      "id": "step_001",
      "type": "NAVIGATE|OBSERVE|ACT|VERIFY|EXTRACT",
      "description": "步骤说明",
      "expectedOutcome": "预期结果",
      "risk": "LOW|MEDIUM|HIGH|CRITICAL",
      "action": { "type": "...", "target": { "semantic|field|role|text": "..." }, "risk": "...", "verification": { "type": "...", "expect": "..." }, "expectedBusinessState": { "stateType": "LOGIN_SUCCESS|SEARCH_SUCCESS|FORM_SUBMIT_SUCCESS|FIELD_FILLED|SELECTED|CHECKED|NAVIGATED|CONFIRMATION|DOWNLOAD|GENERIC_STATE|CUSTOM", "expected": "业务结果描述", "requiredEvidence": [{"type":"text_present","expect":"..."}], "forbiddenEvidence": [{"type":"text_present","expect":"error"}], "evidenceLogic": "AND|OR" } }
    }
  ]
}`;

// 校验 Plan；返回 { ok, plan?, errors[] }
function validatePlan(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['Plan 必须是对象'], instructions: INSTRUCTIONS };
  }

  if (typeof raw.goal !== 'string' || !raw.goal.trim()) errors.push('goal 缺失或为空');
  if (!Array.isArray(raw.steps) || !raw.steps.length) {
    errors.push('steps 必须是非空数组');
    return { ok: false, errors, instructions: INSTRUCTIONS };
  }

  const steps = [];
  raw.steps.forEach((s, i) => {
    const e = [];
    const step = { id: null, type: 'ACT', description: '', expectedOutcome: '', risk: 'MEDIUM', action: null };
    if (!s || typeof s !== 'object') { errors.push(`steps[${i}] 不是对象`); return; }
    if (typeof s.id === 'string' && s.id.trim()) step.id = s.id; else e.push('id 缺失');
    if (STEP_TYPES.includes(s.type)) step.type = s.type; else e.push(`type 非法: ${String(s.type)}`);
    if (typeof s.description === 'string' && s.description.trim()) step.description = s.description; else e.push('description 缺失');
    if (typeof s.expectedOutcome === 'string') step.expectedOutcome = s.expectedOutcome;
    if (RISK_LEVELS.includes(s.risk)) step.risk = s.risk;
    else if (s.action && RISK_LEVELS.includes(s.action.risk)) step.risk = s.action.risk; // 从 action.risk 兜底
    else e.push(`risk 非法: ${String(s.risk)}`);
    if (s.action) {
      const ar = validateAction(s.action);
      if (ar.ok) step.action = ar.action;
      else e.push(`action 非法: ${ar.errors.join('; ')}`);
    }
    if (e.length) errors.push(`steps[${i}](${s.id || '?'}): ${e.join('; ')}`);
    steps.push(step);
  });

  if (errors.length) return { ok: false, errors, instructions: INSTRUCTIONS };

  return { ok: true, plan: { goal: raw.goal.trim(), steps } };
}

// ============================================================================
// Phase 2：Provider 严格输出 Schema（provider.plan 边界契约）
// LLM（DeepSeek/OpenAI）必须输出以下形状，经 validatePlanStrict 校验后才被接受：
// {
//   steps: [
//     {
//       action:        ACTION_TYPES 之一,
//       target:        字符串（url 或语义描述）或对象 {semantic|url|field|text|role|selector|index},
//       semantic:      自然语言步骤意图,
//       expectedResult: 执行成功后的可观测结果（用于验证）,
//       value?:        fill/press 需要,
//       credentialRef?: 敏感字段引用
//     }
//   ]
// }
// 该 Schema 是「LLM 输出契约」，与运行时消费的「规范化 Step」解耦：
// planner 收到严格 steps 后通过 normalizeStrictToCanonical 映射为运行时 Step。
const PLAN_STRICT_INSTRUCTIONS = `输出 JSON 格式的 Plan：
{
  "steps": [
    {
      "action": "navigate|click|fill|submit|login|extract|inspect|...",
      "target": { "field": "email|username|password|search|loginBtn|...", "semantic": "中文语义描述，如 企业邮箱 / 登录按钮" },
      "semantic": "这一步要做什么（自然语言）",
      "expectedResult": "执行成功后的可观测结果（用于验证）",
      "verification": { "type": "text_present|element_present|url_contains|action_success|login_state|page_change", "expect": "预期出现的文本或 URL 片段（action_success 可不填 expect）" },
      "expectedBusinessState": { "stateType": "LOGIN_SUCCESS|SEARCH_SUCCESS|FORM_SUBMIT_SUCCESS|FIELD_FILLED|SELECTED|CHECKED|NAVIGATED|CONFIRMATION|DOWNLOAD|GENERIC_STATE|CUSTOM", "expected": "业务结果描述", "requiredEvidence": [{"type":"text_present","expect":"..."}], "forbiddenEvidence": [{"type":"text_present","expect":"error"}], "evidenceLogic": "AND|OR" },
      "value": "仅 fill/press 需要：填入的值（敏感字段用 credentialRef 代替）",
      "credentialRef": "可选：敏感字段引用名（password/card/cvv 等必须用）"
    }
  ]
}
约束：
- action 仅允许: ${ACTION_TYPES.join(', ')}
- target 必须是对象 {field, semantic}（field 用于精确匹配 name/id/placeholder/aria-label/label，semantic 为中文语义）。navigate 可用 {url}。
- navigate 用 url；click/fill/submit 用 {field, semantic} 双键。
- fill/press 必须提供 value 或 credentialRef；敏感字段（password/card/cvv/otp/token）必须用 credentialRef，禁止 value 字面量。
- VERIFICATION 强制：每个 click / fill / submit 步骤都必须包含 verification（type 非空 none）或 expectedBusinessState 业务完成契约，二者至少其一；禁止仅用 action_success 作为完成证据。
- expectedBusinessState 验证「业务结果」而非「动作执行」：必须含 requiredEvidence（可多条，evidenceLogic=AND/OR）与 forbiddenEvidence（错误信号）。stateType 从固定集合选取。
- expectedResult 必须描述成功后页面可观测状态，作为 verification / expectedBusinessState 依据。
- 不要臆造 objective 中不存在的步骤；纯导航任务只需 navigate→inspect`;

function validatePlanStrict(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['Plan 必须是对象'] };
  }
  if (!Array.isArray(raw.steps) || !raw.steps.length) {
    errors.push('steps 必须是非空数组');
    return { ok: false, errors };
  }
  const steps = [];
  raw.steps.forEach((s, i) => {
    const e = [];
    if (!s || typeof s !== 'object') { errors.push(`steps[${i}] 不是对象`); return; }
    if (typeof s.action !== 'string' || !ACTION_TYPES.includes(s.action)) {
      e.push(`action 非法: ${String(s.action)}`);
    }
    // target 必须存在：字符串（url/语义）或对象（含任一 TARGET_KEYS）
    let hasTarget = false;
    if (typeof s.target === 'string' && s.target.trim()) hasTarget = true;
    else if (s.target && typeof s.target === 'object' && TARGET_KEYS.some((k) => s.target[k] != null && s.target[k] !== '')) hasTarget = true;
    if (!hasTarget) e.push('target 缺失（字符串 url/语义 或 对象）');
    if (typeof s.semantic !== 'string' || !s.semantic.trim()) e.push('semantic 缺失');
    if (typeof s.expectedResult !== 'string' || !s.expectedResult.trim()) e.push('expectedResult 缺失');
    // Phase 7 Step 2-B：verification 校验（类型合法 + MUST_VERIFY 动作强制）
    const v = s.verification;
    if (v != null) {
      if (typeof v !== 'object' || !VERIFICATION_TYPES.includes(v.type)) {
        e.push('verification.type 非法: ' + (v && v.type));
      }
    }
    if (MUST_VERIFY.includes(s.action)) {
      if (!v || !v.type || v.type === 'none') {
        e.push(`${s.action} 必须提供有意义的 verification（text_present/element_present/url_contains/action_success 等，禁止 none）`);
      }
    }
    if (e.length) errors.push(`steps[${i}]: ${e.join('; ')}`);
    else steps.push({
      action: s.action,
      target: s.target,
      semantic: s.semantic,
      expectedResult: s.expectedResult,
      // 透传 verification（禁止丢弃）—— 缺 verification 的 MUST_VERIFY 步骤已在上方被拒绝，
      // 此处若仍为 undefined 仅出现在绕过 validatePlanStrict 的非正常路径，交由下游 fail-loud。
      verification: s.verification || null,
      // Phase 11：透传 expectedBusinessState 业务完成契约（验证业务结果而非动作执行）
      expectedBusinessState: s.expectedBusinessState || null,
      value: s.value !== undefined ? s.value : null,
      credentialRef: s.credentialRef || null,
    });
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, plan: { goal: raw.goal || '任务', steps } };
}

// 严格 Step → 规范化运行时 Step（供 runtime/tools/verification 消费）
const STEP_TYPE_MAP = { navigate: 'NAVIGATE', inspect: 'OBSERVE', observe: 'OBSERVE', extract: 'EXTRACT', verify: 'VERIFY', check: 'VERIFY' };
const MUST_VERIFY = ['click', 'fill', 'select', 'check', 'submit', 'purchase', 'payment', 'login', 'logout', 'password_change', 'delete', 'update_account_settings'];

function normalizeTarget(t) {
  if (typeof t === 'string') {
    if (/^https?:\/\//i.test(t) || t.startsWith('/')) return { url: t };
    return { semantic: t };
  }
  if (t && typeof t === 'object') return t;
  return {};
}

function normalizeStrictToCanonical(strictPlan, goalText) {
  const steps = (strictPlan.steps || []).map((s, i) => {
    const type = s.action;
    const risk = TYPE_RISK_FLOOR[type] || 'MEDIUM';
    // Phase 7 Step 2-B：透传 LLM 提供的 verification（禁止静默补 none / 禁止自动补 action_success）。
    // 仅当未提供时回退 none；MUST_VERIFY 缺 verification 已在 validatePlanStrict 拒绝，
    // 正常路径下此处必能拿到非 none 的 verification。
    let verification;
    if (s.verification && s.verification.type && s.verification.type !== 'none') verification = s.verification;
    // 关键交互动作缺 verification 且无 expectedBusinessState：不静默补 none，
    // 置 null 交由 runtime.buildEffectiveVerification 从 action.type 推导业务完成契约（Phase 11 设计）。
    // 仅当非关键动作（navigate/scroll 等）才回退 none。
    else if (MUST_VERIFY.includes(type) && !s.expectedBusinessState) verification = null;
    else verification = { type: 'none' };
    return {
      id: `step_${String(i + 1).padStart(3, '0')}`,
      type: STEP_TYPE_MAP[type] || 'ACT',
      description: s.semantic || '',
      expectedOutcome: s.expectedResult || '',
      risk,
      action: {
        type,
        target: normalizeTarget(s.target),
        value: s.value !== undefined ? s.value : null,
        credentialRef: s.credentialRef || null,
        risk,
        verification,
        // Phase 11：透传业务完成契约（验证业务结果而非动作执行）
        expectedBusinessState: s.expectedBusinessState || null,
      },
    };
  });
  return { goal: goalText || strictPlan.goal || '任务', steps };
}

module.exports = {
  validatePlan, INSTRUCTIONS, STEP_TYPES,
  PLAN_STRICT_INSTRUCTIONS, validatePlanStrict, normalizeStrictToCanonical,
};
