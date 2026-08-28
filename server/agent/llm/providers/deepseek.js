'use strict';

// DeepSeek Provider（OpenAI-compatible API）。
// API Key 只从环境变量读取（DEEPSEEK_API_KEY）。

const llm = require('../provider');
const { validatePlanStrict, PLAN_STRICT_INSTRUCTIONS } = require('../../schema/plan');

// DeepSeek 真实 LLM 规划入口：复用现有 chat 能力与「严格 Plan Schema」校验，
// 使 provider.js 的 plan() → raw.plan(task, ctx) 形成真实可用闭环。
//
// 输入（Phase 2）：
//   task  : { objective, targetUrl, constraints, ... }
//   ctx   : { context: ContextBuilder 输出（objective / observation summary / previous steps / checkpoint / error history / verification state） }
//
// 统一 Contract（P0-1，沿用）：
//   成功 → { ok: true, plan: { steps: [严格 Step] } }
//   失败 → { ok: false, error: '校验未通过: ...' }
// 严格 Step 形状见 schema/plan.js 的 PLAN_STRICT_INSTRUCTIONS（action/target/semantic/expectedResult）。
// provider.js 的 plan() wrap 层据此归一化为 steps 数组（成功）或抛出明确 PLAN_FAIL（失败）。
async function deepseekPlan(chatFn, task, ctx) {
  const goalText = (task && (task.objective || task.goal)) || '执行任务';
  const target = (task && task.targetUrl) || '';
  const constraints = (task && (task.constraints || [])) || [];

  // 从 ContextBuilder 输出构造上下文块（objective/observation summary/previous steps/verification state）
  const ctxSection = buildContextSection(ctx);

  // 仅作为 schema 强制（validatePlanStrict + action.js MUST_VERIFY）的 LLM 层强化；
  // 真正的拒绝发生在 schema 校验，prompt 只是把已有契约文本化喂给模型。
  const system = '你是严格遵循 JSON Schema 的浏览器自动化任务规划器。只输出 JSON，不要任何解释或 Markdown 代码块之外的文字。'
    + 'target 必须用双键对象 {field, semantic}：field 用于精确匹配元素的 name/id/placeholder/aria-label/label（如 email/username/password/search），semantic 为中文语义描述；两者都提供时定位最稳。'
    + '每个 click / fill / submit 步骤都必须包含 verification（type 为 text_present/element_present/url_contains/action_success 之一，禁止 none），否则 Plan 将被 schema 拒绝。';
  const buildPrompt = (fixHint) =>
    `目标：${goalText}\n` +
    (target ? `入口地址（相对路径，base 为站点根）：${target}\n` : '') +
    (constraints.length ? `约束：${constraints.join('; ')}\n` : '') +
    ctxSection +
    `\n请按下列 Plan Schema 输出 JSON：\n${PLAN_STRICT_INSTRUCTIONS}\n\n` +
    (fixHint ? `上一次输出不符合要求：${fixHint}\n请修正并只输出合法 JSON。` : '');

  let lastHint = '';
  for (let attempt = 0; attempt <= 2; attempt++) {
    const resp = await chatFn([
      { role: 'system', content: system },
      { role: 'user', content: buildPrompt(lastHint) },
    ], { temperature: 0.1, maxTokens: 2048 });
    const content = (resp && resp.content) || '';
    // 容忍 ```json 围栏 + 提取首个 JSON 对象
    const t = content.trim();
    const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : t;
    const start = candidate.search(/[{[]/);
    if (start < 0) { lastHint = '输出中未找到 JSON 对象'; continue; }
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
    let json;
    try { json = JSON.parse(candidate.slice(start, end + 1)); } catch (e) { lastHint = 'JSON 解析失败'; continue; }

    // 严格 Schema 校验（provider 边界契约）
    const vr = validatePlanStrict(json);
    if (vr.ok) return { ok: true, plan: { steps: vr.plan.steps } };
    lastHint = (vr.errors || []).join('; ');
  }
  // 校验最终未通过：明确失败 contract，由 provider wrap 层转抛 PLAN_FAIL
  return { ok: false, error: lastHint || 'Plan 校验未通过' };
}

// 将 ContextBuilder 的结构化上下文序列化为 prompt 上下文块。
function buildContextSection(ctx) {
  const c = ctx && ctx.context;
  if (!c) return '';
  const lines = [];
  if (c.task && c.task.objective) lines.push('任务目标：' + c.task.objective);
  if (c.page && c.page.url) {
    lines.push('当前页面：' + c.page.url + (c.page.title ? '（' + c.page.title + '）' : ''));
    // Phase 9 P4（断裂点 3/3，与 planner.contextBlock 同步修复）：
    // 此前本函数只输出 url/title，Planner 看不到页面真实文本与元素，只能臆造契约。
    // 修复：注入真实可见文本与元素清单，并约束契约必须取自清单。
    if (c.page.textSummary) lines.push('页面可见文本：' + c.page.textSummary);
    if (Array.isArray(c.page.elements) && c.page.elements.length) {
      lines.push('页面元素清单（写 expectedResult / verification 时，必须从中选取真实存在的 '
        + 'id / name / text / ariaLabel，禁止臆造页面上不存在的标识）：' + JSON.stringify(c.page.elements));
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
  return lines.length ? '\n\n任务上下文（ContextBuilder）：\n' + lines.join('\n') : '';
}

function deepseekFactory(config = {}) {
  const baseURL = config.baseURL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  const apiKey = config.apiKey || process.env.DEEPSEEK_API_KEY || '';
  const model = config.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const timeoutMs = config.timeoutMs || 60000;

  return {
    name: 'deepseek',
    model,
    async chat(messages, opts = {}) {
      if (!apiKey) throw new Error('未配置 DEEPSEEK_API_KEY');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs || timeoutMs);
      try {
        const res = await fetch(baseURL.replace(/\/$/, '') + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
          body: JSON.stringify({
            model,
            messages,
            temperature: opts.temperature !== undefined ? opts.temperature : 0.2,
            max_tokens: opts.maxTokens || 2048,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = (await res.text()).slice(0, 200);
          throw new Error('LLM HTTP ' + res.status + ': ' + body);
        }
        const data = await res.json();
        return { content: (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '', usage: data.usage || {} };
      } finally {
        clearTimeout(timer);
      }
    },
    // 真实 LLM 规划入口：provider.js 的 plan() → raw.plan(task, ctx) 闭环
    async plan(task, ctx) {
      return deepseekPlan(this.chat.bind(this), task, ctx);
    },
  };
}

llm.register('deepseek', deepseekFactory);
module.exports = { deepseekFactory, deepseekPlan };
