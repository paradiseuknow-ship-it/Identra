'use strict';

// Planner：Objective → Plan（必须通过 schema/plan.js 校验，非法拒绝）。
//
// 5.9-E 修复（接口契约缺陷）：原实现无条件调用 provider.plan(ctx, task)，
// 但 deepseek/openai 等真实 provider 仅实现 chat（无 raw.plan），
// 导致 TypeError: raw.plan is not a function。
//
// 改为「能力检测 + 统一 Provider Contract」：
//   provider.plan      → 有（如 mock）  → 调用 plan，期望返回步骤数组
//   provider.plan      → 没有           → 降级用 provider.structured（如 deepseek/openai，底层走 chat）
//     provider.structured → 有           → 调用 structured，传入 Plan Schema，取 JSON 作为 Plan 草稿
//   都没有                          → 明确返回 PLANNER_PROVIDER_CAPABILITY_ERROR
// 这样以后换 OpenAI / DeepSeek / 其他 Provider，不会再出现隐式接口 TypeError。

const { validatePlan, INSTRUCTIONS, normalizeStrictToCanonical } = require('./schema/plan');
const { ACTION_TYPES, VERIFICATION_TYPES } = require('./schema/action');
// 注意：plannerEvidence.js 导出名为 record（非 recordPlannerEvidence），此处用别名绑定，
// 否则解构得到 undefined → 调用抛 TypeError 被下方 catch 静默吞掉 → 证据永不落库（真实缺陷）。
const { record: recordPlannerEvidence } = require('./plannerEvidence');
// TARGET_KEYS 未在 action.js 导出，这里复用同一定义（与 schema/action.js 保持一致）
const TARGET_KEYS = ['semantic', 'role', 'field', 'text', 'selector', 'index', 'url'];
const stepManager = require('./stepManager');

// 5.9-E 修复：把 Action 级别的关键约束合并进交给 LLM 的 instructions，
// 避免 DeepSeek 产出「target.semantic=占位符 / navigate 缺 url / fill 缺 value」等非法结构。
// 注意：这只是把【已有 schema 规则】文本化喂给模型，不改变校验逻辑本身（校验仍在 schema/plan·action）。
// Phase 7 Step 2-B：强化「每个交互动作必须可验证」与「target 双键定位」契约。
const ACTION_CONSTRAINTS = [
  '每个 step 必须含 action 对象。',
  `action.type 仅允许: ${ACTION_TYPES.join(', ')}。`,
  `action.target 至少提供以下之一: ${TARGET_KEYS.join(', ')}。`,
  'NAVIGATE 动作必须用 action.target.url（字符串，可为相对路径如 "/"），不要用 semantic 占位。',
  'OBSERVE/INSPECT 用 action.target.role="page" 或语义描述。',
  'target 定位应使用「双键」：field（如 email/username/password/search，用于精确匹配 name/id/placeholder/aria-label/label）+ semantic（中文语义描述，如 "企业邮箱"）。两者都提供时定位最稳。',
  `fill/press 必须提供 action.value（普通字段）或 action.credentialRef（敏感字段），二者至少其一。`,
  'fill/press 敏感字段（password/card/cvv/otp/token 等）必须用 credentialRef 引用，禁止 value 字面量（安全约束，不可违反）。',
  `action.verification.type 仅允许: ${VERIFICATION_TYPES.join(', ')}。`,
  'VERIFICATION 强制：每个 click / fill / submit 步骤都必须提供有意义的 verification（type 非空 none）。这是硬性要求，缺少将被拒绝。',
  'verification 优先使用可观测判定：text_present（页面出现某文本）/ element_present（某元素出现）/ url_contains（URL 变化）；无可观测量时用 action_success。',
  '每个 step 的 expectedOutcome 必须描述「执行成功后页面应出现的可观测状态」，作为 verification 的依据。',
  'submit/login/purchase 等高风险动作同样必须提供有意义的 verification.type。',
  '不要臆造任务 objective 中不存在的 fill/click 步骤；纯导航任务只需 NAVIGATE→OBSERVE→VERIFY。',
  // Phase 11 — ExpectedBusinessState 业务完成契约（核心）
  '【强制】每个交互动作（login / search / fill / submit / select / check / click 提交类）必须输出 expectedBusinessState 业务完成契约，验证「业务结果」而不是「动作执行」。',
  'expectedBusinessState.stateType 必须从固定集合选取：LOGIN_SUCCESS / SEARCH_SUCCESS / FORM_SUBMIT_SUCCESS / FIELD_FILLED / SELECTED / CHECKED / NAVIGATED / CONFIRMATION / DOWNLOAD / GENERIC_STATE / CUSTOM。',
  'expectedBusinessState 必须含 requiredEvidence（至少一条，可用 text_present/element_present/url_contains/element_absent/login_state，多条用 evidenceLogic=AND/OR 组合）与 forbiddenEvidence（绝不出现的错误信号）。',
  '禁止把 action_success 当作业务完成证据；action_success 只允许用于非关键/纯观测动作。',
  'verification 与 expectedBusinessState 都必须能从 objective 推导，禁止凭空臆造预期结果。',
].join('\n');

const PLANNER_INSTRUCTIONS = `${INSTRUCTIONS}\n\nAction 约束：\n${ACTION_CONSTRAINTS}`;

// 5.9-E 修复：明确的能力缺失错误码，便于 Benchmark / 调用方区分「provider 契约缺陷」与「规划失败」。
const PLANNER_PROVIDER_CAPABILITY_ERROR = 'PLANNER_PROVIDER_CAPABILITY_ERROR';

// 将 ContextBuilder 产出的结构化上下文（objective/observation/steps/checkpoint/errorHistory/verification）
// 序列化为紧凑文本块，注入 LLM prompt，使 Planner 拥有完整决策上下文。
function contextBlock(ctx) {
  if (!ctx || !ctx.context) return '';
  const c = ctx.context;
  const lines = [];
  if (c.task && c.task.objective) lines.push('任务目标：' + c.task.objective);
  if (c.page && c.page.url) {
    lines.push('当前页面：' + c.page.url + (c.page.title ? '（' + c.page.title + '）' : ''));
    // Phase 9 P4（断裂点 3/3）：此前本函数只输出 url/title，page 的 textSummary 与 elements
    // 从未进入 prompt —— 即使 runtime 传了 observation，Planner 也依然看不到页面内容。
    // 修复：把真实可见文本与元素清单注入 prompt，并显式约束「契约必须取自清单，禁止臆造」。
    if (c.page.textSummary) lines.push('页面可见文本：' + c.page.textSummary);
    if (Array.isArray(c.page.elements) && c.page.elements.length) {
      lines.push('页面元素清单（写 verification.expect 与 expectedBusinessState.requiredEvidence 时，'
        + '必须从中选取真实存在的 id / name / text / ariaLabel，禁止臆造页面上不存在的标识）：'
        + JSON.stringify(c.page.elements));
    }
  }
  if (Array.isArray(c.steps) && c.steps.length) {
    lines.push('已有步骤（含状态，不要重复已成功的步骤）：' + JSON.stringify(
      c.steps.map((s) => ({ id: s.id, type: s.type, status: s.status, desc: s.description }))
    ));
  }
  if (c.checkpoint) lines.push('检查点（断点续跑起点）：' + JSON.stringify(c.checkpoint));
  if (Array.isArray(c.errorHistory) && c.errorHistory.length) {
    lines.push('历史错误（避免重蹈覆辙）：' + JSON.stringify(c.errorHistory));
  }
  if (c.verification) lines.push('当前验证状态：' + JSON.stringify(c.verification));
  if (!lines.length) return '';
  return '\n\n任务上下文（Task Context，由 ContextBuilder 提供）：\n' + lines.join('\n');
}

async function planObjective({ objective, target, constraints, credentialRefs, executionMode, provider, ctx }) {
  const taskLike = {
    objective: objective || '',
    targetUrl: target || '',
    constraints: constraints || [],
    secretRefs: credentialRefs || [],
    executionMode: executionMode || 'ASSIST',
  };
  const goalText = objective || '执行任务';
  const CB = contextBlock(ctx); // 来自 ContextBuilder 的结构化上下文

  // ---- 能力检测：plan → structured 降级 ----
  // 注意：统一门面（provider.js wrap）对【所有】provider 都挂了 plan/structured 方法，
  // 但真实能力在底层 raw。deepseek/openai 的 raw 只有 chat，门面 plan 内部调 raw.plan
  // 会抛「raw.plan is not a function」。因此这里以真实可调用性为准：
  //   1) 先试 provider.plan；若抛 raw.plan/raw.chat 类「方法缺失」错误 → 视为能力缺失，降级 structured。
  //   2) 否则 structured 分支兜底。
  // 这样以后换 Provider 不会再现隐式 TypeError。
  const CAPABILITY_RE = /raw\.(plan|chat|structured) is not a function/i;
  // Phase 8 — 规划韧性修复：JSON 解析失败 / Schema 校验失败原本会让整任务崩溃（return ok:false）。
  // 现改为「最多 MAX_PLANNER_ATTEMPTS 次重试」，并把上一次拒绝原因回灌给模型重新生成。
  // 不改动 schema 规则、不弱化 password 等安全拦截、不动成功/验证逻辑、非 planner 重写（仅加重试环）。
  const MAX_PLANNER_ATTEMPTS = 3;

  // 契约缺陷（既无 plan 也无 structured 能力）一次性判定，避免无谓重试
  if (typeof provider.plan !== 'function' && typeof provider.structured !== 'function') {
    return {
      ok: false,
      error: `${PLANNER_PROVIDER_CAPABILITY_ERROR}: provider(${provider && provider.kind}) 既无 plan 也无 structured 能力`,
      code: PLANNER_PROVIDER_CAPABILITY_ERROR,
    };
  }

  // 构建 structured 调用参数；attempt>1 时把上一次拒绝原因回灌，给模型修正机会
  const buildStructuredOpts = (errorFeedback) => ({
    system: '你是严格遵循 JSON Schema 的浏览器任务规划器。只输出 JSON，不要任何解释或 Markdown 代码块之外的文字。每个 click/fill/submit 步骤都必须带 verification。'
      + (errorFeedback ? '\n\n上一次规划被拒绝，请修正以下问题后重新输出：\n' + errorFeedback : ''),
    prompt:
      `目标：${goalText}\n` +
      (target ? `入口地址（相对路径，base 为站点根）：${target}\n` : '') +
      (constraints && constraints.length ? `约束：${constraints.join('; ')}\n` : '') +
      `请按下列 Plan Schema 与 Action 约束输出 JSON：\n${PLANNER_INSTRUCTIONS}\n\n` +
      (CB || '') +
      `输出格式示例：{ "goal": "...", "steps": [ ` +
      `{ "id":"step_001","type":"NAVIGATE","description":"打开页面","expectedOutcome":"页面加载","risk":"LOW","action":{ "type":"navigate","target":{ "url":"${target || '/'}" },"risk":"LOW" } },` +
      `{ "id":"step_002","type":"ACT","description":"填写邮箱","expectedOutcome":"邮箱输入框已填入值","risk":"MEDIUM","action":{ "type":"fill","target":{ "field":"email","semantic":"企业邮箱" },"value":"user@example.com","risk":"MEDIUM","verification":{ "type":"text_present","expect":"登录" } } },` +
      `{ "id":"step_003","type":"ACT","description":"点击登录","expectedOutcome":"跳转至首页/仪表盘","risk":"MEDIUM","action":{ "type":"click","target":{ "field":"loginBtn","semantic":"登录按钮" },"risk":"MEDIUM","verification":{ "type":"url_contains","expect":"dashboard" } } } ] }`,
    schema: { instructions: PLANNER_INSTRUCTIONS, validate: validatePlan },
    maxRetries: 3,
    label: 'plan',
  });

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_PLANNER_ATTEMPTS; attempt++) {
    let rawSteps = undefined;
    let usedCapability = null;
    let planCapabilityFailed = false;

    if (typeof provider.plan === 'function') {
      try {
        rawSteps = await provider.plan(ctx, taskLike);
        usedCapability = 'plan';
      } catch (e) {
        if (CAPABILITY_RE.test(String(e.message || e))) {
          // 门面 plan 底层无 raw.plan —— 这是能力缺失，不是规划失败，降级 structured
          planCapabilityFailed = true;
        } else {
          // 瞬态失败（如 LLM 返回 JSON 解析失败）：记录后进入重试，不立即让整任务崩溃
          lastError = `规划失败(plan): ${String(e.message || e).slice(0, 200)}`;
        }
      }
    }

    if (rawSteps === undefined && (planCapabilityFailed || typeof provider.plan !== 'function') && typeof provider.structured === 'function') {
      try {
        const draft = await provider.structured(ctx, buildStructuredOpts(attempt > 1 ? lastError : ''));
        if (process.env.PLANNER_DEBUG) {
          console.error('[planner][debug] structured draft=', JSON.stringify(draft).slice(0, 1500));
        }
        if (draft && Array.isArray(draft.steps)) {
          rawSteps = draft.steps;
        } else if (draft && draft.plan && Array.isArray(draft.plan.steps)) {
          rawSteps = draft.plan.steps;
        } else if (draft && Array.isArray(draft)) {
          rawSteps = draft;
        } else {
          // structured 未返回可识别结构，做一次显式校验兜底
          const vr0 = validatePlan(draft || {});
          if (vr0.ok) rawSteps = vr0.plan.steps;
          else lastError = `Plan 生成结果无法解析: ${(vr0.errors || []).slice(0, 3).join('; ')}`;
        }
        usedCapability = 'structured';
      } catch (e) {
        lastError = `规划失败(structured): ${String(e.message || e).slice(0, 200)}`;
      }
    }

    if (!Array.isArray(rawSteps)) {
      // 生成未产出步骤数组：若还有重试额度则继续，否则收口为失败
      if (attempt < MAX_PLANNER_ATTEMPTS) continue;
      return { ok: false, error: lastError || 'Provider 未返回步骤数组' };
    }

    // 真实 provider.plan 路径产出「严格 Step」，需归一化为运行时规范化 Step；
    // structured 降级路径已直接产出规范化 Step（其 prompt 使用 canonical Plan Schema）。
    const canonical = usedCapability === 'plan'
      ? normalizeStrictToCanonical({ steps: rawSteps }, goalText)
      : { goal: goalText, steps: rawSteps };

    // ---- 校验（运行时 Step Schema 终态门）----
    const vr = validatePlan(canonical);
    if (vr.ok) {
      try {
        recordPlannerEvidence({
          taskId: ctx && ctx.taskId,
          executionId: ctx && ctx.executionId,
          provider: provider && (provider.kind || provider.name),
          model: provider && provider.model,
          objective: goalText,
          context: ctx && ctx.context ? JSON.stringify(ctx.context) : '',
          stepCount: vr.plan.steps.length,
          schemaOk: true,
          schemaErrors: [],
          capability: usedCapability,
        });
      } catch (e) {}
      return { ok: true, plan: vr.plan, capability: usedCapability };
    }

    // 真实规划失败：记录审计证据；把拒绝原因回灌，给模型一次修正机会（最多重试 MAX_PLANNER_ATTEMPTS 次）
    try {
      recordPlannerEvidence({
        taskId: ctx && ctx.taskId,
        executionId: ctx && ctx.executionId,
        provider: provider && (provider.kind || provider.name),
        model: provider && provider.model,
        objective: goalText,
        context: ctx && ctx.context ? JSON.stringify(ctx.context) : '',
        stepCount: canonical.steps.length,
        schemaOk: false,
        schemaErrors: (vr.errors || []).slice(0, 5),
        capability: usedCapability,
      });
    } catch (e) {}
    lastError = `Plan Schema 校验失败: ${(vr.errors || []).slice(0, 3).join('; ')}`;
    if (attempt < MAX_PLANNER_ATTEMPTS) continue;
    return { ok: false, error: lastError };
  }

  return { ok: false, error: lastError || '规划失败（已重试耗尽）' };
}

// 重规划（REPLAN）：当 Plan 本身过期（DOM 结构变化 / 真实动作失败，且常规重定位与重试已耗尽）时，
// 基于【当前浏览器观察】与【已完成步骤】让 provider 重新生成「剩余步骤」。
// 防御：
//   - 任何异常/能力缺失 → 返回 { ok:false }，由调用方降级为 escalate/fail（不静默通过，不无限循环）。
//   - 不改动校验逻辑；新生成的 Plan 仍经 validatePlan 校验，非法即拒绝。
//   - 返回的 steps 是「完整剩余计划」，调用方负责替换原 plan 中从当前位置起的部分。
async function replan(task, observation, remainingSteps, provider) {
  try {
    if (!provider || typeof provider.plan !== 'function' && typeof provider.structured !== 'function') {
      return { ok: false, error: 'replan: 无可用 provider 能力' };
    }
    // 已完成步骤作为上下文，避免重规划时重复已成功的动作
    const completed = stepManager.listSteps(task.id)
      .filter((s) => s.status === 'SUCCESS')
      .map((s) => ({ id: s.id, type: s.type, status: s.status, description: s.description }));
    const ctx = {
      taskId: task.id,
      executionId: task.currentExecutionId,
      context: {
        task: { objective: task.objective },
        page: observation || null,
        steps: completed,
        checkpoint: null,
        errorHistory: [],
        verification: null,
      },
    };
    const resumeObjective = (task.objective || '执行任务') +
      `（从当前页面状态续跑：已完成 ${completed.length} 步，请仅规划尚未完成的剩余步骤）`;
    const pr = await planObjective({
      objective: resumeObjective,
      target: task.targetUrl,
      constraints: task.constraints || [],
      credentialRefs: task.secretRefs || [],
      executionMode: task.executionMode,
      provider,
      ctx,
    });
    if (!pr.ok) return { ok: false, error: pr.error };
    return { ok: true, steps: pr.plan.steps };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}

module.exports = { planObjective, replan, PLANNER_PROVIDER_CAPABILITY_ERROR };
