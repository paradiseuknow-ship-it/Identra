'use strict';

// Phase 5.3 — Baseline Runner B：Playwright + LLM（每步决策都问 LLM）
// 与 A 的区别：不写死选择器，每步把页面快照发给 LLM，让它返回下一步 action。
// 记录 llmCalls / tokens / cost。无 memory / router（memoryHit=0, routerAccuracy=null）。

const { chromium } = require('playwright');
const { createProvider } = require('../../server/agent/llm/provider');
require('../../server/agent/provider.mock'); // 注册 mock provider（无网可跑）
const { BenchmarkRunner } = require('../runner');
const { verifyResult } = require('../verify');

class LlmRunner extends BenchmarkRunner {
  constructor(opts = {}) {
    super({ ...opts, name: 'Playwright+LLM(B)', runner: 'B' });
    this.browser = null;
    this.provider = createProvider(opts.providerKind || process.env.BENCH_LLM || 'mock', opts.providerConfig || {});
  }

  async ensureBrowser() {
    if (!this.browser) this.browser = await chromium.launch();
  }

  async run(task) {
    await this.ensureBrowser();
    const ctx = await this.browser.newContext();
    const page = await ctx.newPage();
    const started = Date.now();
    let llmCalls = 0, tokens = 0;
    try {
      const url = this.mockBaseUrl + (task.targetUrl || '/');
      await page.goto(url, { waitUntil: 'domcontentloaded' });

      // LLM 驱动循环：最多 N 步
      const MAX_STEPS = 12;
      for (let step = 0; step < MAX_STEPS; step++) {
        const snap = await this._snapshot(page);
        const decision = await this._askLlm(task, snap, step);
        llmCalls++;
        tokens += decision._tokens || 0;
        if (decision.action === 'done' || decision.action === 'verify') break;
        await this._apply(page, decision);
      }

      const ok = await verifyResult(task, page, { baseUrl: this.mockBaseUrl });
      return this.result(task, {
        success: ok,
        latencyMs: Date.now() - started,
        llmCalls,
        tokens,
        cost: this.estimateCost(llmCalls, tokens),
        recovery: false,
        recoveryOk: false,
        humanEscalation: false,
        memoryHit: 0,
        routerAccuracy: null,
        error: ok ? null : 'verify-failed',
        raw: { steps: MAX_STEPS },
      });
    } catch (e) {
      return this.result(task, {
        success: false,
        latencyMs: Date.now() - started,
        llmCalls,
        tokens,
        cost: this.estimateCost(llmCalls, tokens),
        error: String(e.message || e).slice(0, 200),
      });
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  async _snapshot(page) {
    return await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      text: (document.body.innerText || '').slice(0, 600),
      inputs: Array.from(document.querySelectorAll('input,textarea,button,a')).map((el) => ({
        tag: el.tagName, id: el.id, text: (el.innerText || el.value || '').slice(0, 40),
      })).slice(0, 20),
    }));
  }

  async _askLlm(task, snap, step) {
    const messages = [
      { role: 'system', content: '你是浏览器自动化助手。根据页面快照返回下一步动作 JSON：{action:"click"|"fill"|"done", selector, value}。task 完成时返回 action:"done"。' },
      { role: 'user', content: `目标: ${task.objective}\n步骤${step}\n页面: ${JSON.stringify(snap)}` },
    ];
    const r = await this.provider.chat({ taskId: task.id }, messages, {});
    // 尝试解析 JSON；mock provider 返回文本时退化为启发式
    let decision = { action: 'done' };
    try { decision = JSON.parse(r.content); } catch { decision = this._heuristic(snap, task); }
    decision._tokens = (r.usage && (r.usage.total_tokens || r.usage.completion_tokens || 0)) || 300;
    return decision;
  }

  _heuristic(snap, task) {
    // 无 LLM 时的退化策略（mock provider 跑无网环境）
    const t = (snap.text || '').toLowerCase();
    if (t.includes('登录')) return { action: 'fill', selector: '#username', value: 'alice' };
    if (t.includes('提交') || t.includes('搜索')) return { action: 'click', selector: 'button' };
    return { action: 'done' };
  }

  async _apply(page, d) {
    if (d.action === 'fill') { await page.fill(d.selector, d.value || '').catch(() => {}); }
    else if (d.action === 'click') { await page.click(d.selector, { timeout: 3000 }).catch(() => {}); }
  }

  async close() {
    if (this.browser) await this.browser.close().catch(() => {});
  }
}

module.exports = { LlmRunner };
