'use strict';

// OpenAI Provider（OpenAI-compatible API，如 /chat/completions）。
// API Key 只从环境变量读取（OPENAI_API_KEY / AI_API_KEY），绝不进入任何日志/上下文。

const llm = require('../provider');

function openaiFactory(config = {}) {
  const baseURL = config.baseURL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const apiKey = config.apiKey || process.env.OPENAI_API_KEY || process.env.AI_API_KEY || '';
  const model = config.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const timeoutMs = config.timeoutMs || 60000;

  return {
    name: 'openai',
    model,
    async chat(messages, opts = {}) {
      if (!apiKey) throw new Error('未配置 OPENAI_API_KEY / AI_API_KEY');
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
  };
}

llm.register('openai', openaiFactory);
module.exports = { openaiFactory };
