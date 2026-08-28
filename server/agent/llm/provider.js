'use strict';

// AIProvider 统一门面 + LLM 调用治理（重试 / 记录 / 预算 / 事件）。
// 提供统一接口：chat() / structured() / plan()。
// structured() 负责：调模型 → 解析 JSON → Schema 校验 → 失败带修复提示重试（上限）。
// 所有调用写入 recorder.llmCalls 并扣减 budget；预算超限抛 BudgetExceededError。

const recorder = require('../recorder');
const budget = require('../budget');
const events = require('../events');

const factories = {}; // kind -> factory(config)
function register(kind, factory) { factories[kind] = factory; }

class ProviderError extends Error {
  constructor(message, code) { super(message); this.name = 'ProviderError'; this.code = code || 'PROVIDER_ERROR'; }
}
class BudgetExceededError extends ProviderError {
  constructor(message) { super(message, 'BUDGET_EXCEEDED'); this.name = 'BudgetExceededError'; }
}

// 'auto'：按环境变量选择 openai / deepseek / mock
function resolveKind(kind) {
  const k = (kind || process.env.AI_PROVIDER || 'auto').toLowerCase();
  if (k !== 'auto') return k;
  if (process.env.OPENAI_API_KEY || process.env.AI_API_KEY) return 'openai';
  if (process.env.DEEPSEEK_API_KEY) return 'deepseek';
  return 'mock';
}

function createProvider(kind = 'auto', config = {}) {
  const k = resolveKind(kind);
  const factory = factories[k];
  if (!factory) throw new ProviderError('未知 AI Provider: ' + k, 'UNKNOWN_PROVIDER');
  return wrap(factory(config), k);
}

// 包装：给原始 provider 叠加 记录/预算/事件
function wrap(raw, kind) {
  const tracked = { name: raw.name, kind, model: raw.model || null, raw };

  async function track(ctx, type, fn) {
    const start = Date.now();
    let ok = true, content = null, usage = {};
    try {
      content = await fn();
      usage = (content && content.usage) || {};
      return content;
    } catch (e) {
      ok = false;
      throw e;
    } finally {
      const duration = Date.now() - start;
      if (ctx && ctx.executionId) {
        try {
          recorder.recordLLMCall(ctx.executionId, {
            type, provider: kind, model: raw.model || null,
            tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
            promptTokens: usage.prompt_tokens || 0,
            completionTokens: usage.completion_tokens || 0,
            durationMs: duration, cost: 0, success: ok,
          });
        } catch (e) {}
      }
      if (ctx && ctx.taskId) {
        try {
          const b = budget.check(ctx.taskId);
          if (!b.ok) throw new BudgetExceededError(b.reason);
          budget.spend(ctx.taskId, { tokens: usage.total_tokens || 0, calls: 1, cost: 0 });
        } catch (e) {
          if (e instanceof BudgetExceededError) throw e;
        }
      }
      events.emit({
        taskId: ctx && ctx.taskId, executionId: ctx && ctx.executionId,
        type: ok ? 'agent.tool_result' : 'task.failed',
        payload: { llm: true, provider: kind, type, ok, durationMs: duration, tokens: usage.total_tokens || 0 },
      });
    }
  }

  // 提取 JSON（容忍 ```json 围栏）
  function extractJson(text) {
    const t = String(text || '').trim();
    const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : t;
    const start = candidate.search(/[{[]/);
    if (start < 0) throw new ProviderError('LLM 输出无 JSON', 'INVALID_JSON');
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
    if (end <= start) throw new ProviderError('LLM 输出 JSON 不完整', 'INVALID_JSON');
    return JSON.parse(candidate.slice(start, end + 1));
  }

  async function structured(ctx, { system, prompt, schema, maxRetries = 2, label = 'output' }) {
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const resp = await track(ctx, 'structured', () => raw.chat([
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ], { temperature: 0.1 }));
        const json = extractJson(resp.content);
        const vr = schema.validate(json);
        if (!vr.ok) {
          lastErr = new ProviderError(`Schema 校验失败: ${(vr.errors || []).join('; ')}`, 'SCHEMA_FAIL');
          prompt = `上一次输出不符合要求：${(vr.errors || []).join('; ')}\n请修正并只输出 JSON。\n\n要求：\n${schema.instructions || ''}`;
          continue;
        }
        return vr.plan || vr.action || json;
      } catch (e) {
        lastErr = e;
        if (e instanceof BudgetExceededError) throw e;
        if (attempt >= maxRetries) break;
        prompt = `调用失败：${String(e.message || e).slice(0, 200)}。请重试，并只输出符合要求的 JSON。`;
      }
    }
    throw lastErr || new ProviderError(label + ' 生成失败', 'PROVIDER_FAIL');
  }

  async function chat(ctx, messages, opts) {
    const resp = await track(ctx, 'chat', () => raw.chat(messages, opts));
    return resp.content;
  }

  async function plan(ctx, task) {
    let resp;
    try {
      resp = await track(ctx, 'plan', () => raw.plan(task, ctx));
    } catch (e) {
      // 能力缺失（raw.plan is not a function）或规划失败，原样上抛，由 planner.js 统一处理
      throw e;
    }
    // 归一化 contract：raw 可返回
    //   { ok:true, plan:{steps} }  → 成功
    //   { ok:false, error }         → 规划失败，明确抛 PLAN_FAIL（不靠空数组 truthy）
    //   steps 数组                  → 兼容裸数组形式
    if (resp && resp.ok === false) {
      throw new ProviderError(resp.error || 'Plan 生成失败', 'PLAN_FAIL');
    }
    const steps = (resp && resp.plan && resp.plan.steps) || (resp && resp.steps) || (Array.isArray(resp) ? resp : null);
    if (steps === null) {
      throw new ProviderError('Plan 返回结构无法识别', 'PLAN_FAIL');
    }
    return steps;
  }

  return { name: raw.name, kind, model: raw.model || null, chat, structured, plan };
}

module.exports = { createProvider, register, ProviderError, BudgetExceededError };
