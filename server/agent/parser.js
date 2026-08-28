'use strict';

// Task Parser：用户自然语言 → 结构化任务输入。
// 仅负责理解，不操作 Browser。输出：
// { objective, constraints[], target, credentialRefs[] }
// 真实 Provider 存在时用 LLM 结构化输出；否则用确定性启发式（保证无 key 也可用）。

const URL_RE = /https?:\/\/[^\s"']+/i;
const REF_RE = /cred_\w+/gi;
const CONSTRAINT_RE = /(不要|不能|禁止|必须|避免|不超过|确保|不要用)/;

function heuristicParse(text) {
  const t = String(text || '').trim();
  const target = (t.match(URL_RE) || [null])[0];
  const credentialRefs = (t.match(REF_RE) || []).map((x) => x.trim());
  const constraints = t.split(/[。\n；;]+/).filter((s) => CONSTRAINT_RE.test(s)).map((s) => s.trim()).slice(0, 5);
  let objective = t.replace(URL_RE, '').replace(REF_RE, '').replace(/\s+/g, ' ').trim();
  objective = objective.replace(/^(帮我|请|麻烦|我想要|我想)/, '').trim();
  if (!objective) objective = t.slice(0, 120);
  return { objective, constraints, target, credentialRefs };
}

// 供 LLM 结构化输出使用的简单 schema 描述
const PARSE_INSTRUCTIONS = `输出 JSON：
{
  "objective": "一句话目标（去掉网址）",
  "constraints": ["约束1"],
  "target": "网址或 null",
  "credentialRefs": ["cred_xxx"]
}`;

function parseSchema() {
  return {
    instructions: PARSE_INSTRUCTIONS,
    validate(o) {
      const errors = [];
      if (!o || typeof o !== 'object') return { ok: false, errors: ['解析结果必须是对象'] };
      if (typeof o.objective !== 'string' || !o.objective.trim()) errors.push('objective 缺失');
      if (o.target !== undefined && o.target !== null && typeof o.target !== 'string') errors.push('target 必须为字符串或 null');
      if (o.constraints !== undefined && !Array.isArray(o.constraints)) errors.push('constraints 必须为数组');
      if (o.credentialRefs !== undefined && !Array.isArray(o.credentialRefs)) errors.push('credentialRefs 必须为数组');
      if (errors.length) return { ok: false, errors };
      return {
        ok: true,
        plan: {
          objective: o.objective.trim(),
          constraints: Array.isArray(o.constraints) ? o.constraints : [],
          target: o.target || null,
          credentialRefs: Array.isArray(o.credentialRefs) ? o.credentialRefs : [],
        },
      };
    },
  };
}

async function parse(text, provider, ctx = {}) {
  if (provider && provider.kind && provider.kind !== 'mock') {
    try {
      const parsed = await provider.structured(ctx, {
        system: '你是任务解析器，只输出 JSON。',
        prompt: `请解析用户目标：\n"""${String(text || '').slice(0, 2000)}"""`,
        schema: parseSchema(),
        maxRetries: 1,
        label: 'parse',
      });
      if (parsed && parsed.objective) return parsed;
    } catch (e) {
      // LLM 解析失败回退启发式
    }
  }
  return heuristicParse(text);
}

module.exports = { parse, heuristicParse };
