'use strict';

// Phase 5.2 — Baseline Runner A：纯 Playwright（硬编码脚本，零 LLM）
// 每个任务写死选择器操作，不调用任何 AI。作为对照基线。

const { chromium } = require('playwright');
const { BenchmarkRunner } = require('../runner');
const { verifyResult } = require('../verify');

class PlaywrightRunner extends BenchmarkRunner {
  constructor(opts = {}) {
    super({ ...opts, name: 'Playwright(A)', runner: 'A' });
    this.browser = null;
  }

  async ensureBrowser() {
    if (!this.browser) this.browser = await chromium.launch();
  }

  async run(task) {
    await this.ensureBrowser();
    const ctx = await this.browser.newContext();
    const page = await ctx.newPage();
    const started = Date.now();
    try {
      const url = this.mockBaseUrl + (task.targetUrl || '/');
      await page.goto(url, { waitUntil: 'domcontentloaded' });

      // 硬编码任务脚本（无 LLM、无 recovery 概念）
      await this._script(task, page);

      const ok = await verifyResult(task, page, { baseUrl: this.mockBaseUrl });
      return this.result(task, {
        success: ok,
        latencyMs: Date.now() - started,
        llmCalls: 0,
        tokens: 0,
        cost: 0,
        recovery: false,
        recoveryOk: false,
        humanEscalation: false,
        memoryHit: 0,
        routerAccuracy: null,
        error: ok ? null : 'verify-failed',
      });
    } catch (e) {
      return this.result(task, {
        success: false,
        latencyMs: Date.now() - started,
        error: String(e.message || e).slice(0, 200),
      });
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  async _script(task, page) {
    // 5.9-B：任务 id 在 100×3 扩展后变为 `login#0`，需用 base id 匹配脚本
    const id = task._baseId || task.id;
    switch (id) {
      case 'login':
        await page.fill('#username', 'alice');
        await page.fill('#password', 'secret123');
        await page.click('#submit');
        break;
      case 'search':
        await page.fill('#q', 'benchmark test');
        await page.click('#go');
        break;
      case 'form':
        await page.fill('#name', 'Bob');
        await page.fill('#email', 'bob@example.com');
        await page.fill('#msg', 'hello');
        await page.click('#submit');
        break;
      case 'nav':
        await page.click('a[href="/products"]');
        await page.click('a[href="/docs"]');
        break;
      case 'text-change':
        await page.click('#refresh');
        break;
      case 'timeout':
        // 硬编码脚本不设超时感知，会卡住直到 playwright 默认超时 -> 失败
        await page.click('#slow', { timeout: 3000 }).catch(() => {});
        break;
      case 'cookie':
        await page.click('#accept');
        break;
      case 'structure-change':
        await page.click('#submit');
        break;
      case 'session-expired':
        // 硬编码不知道要先登录，第一次被踢 -> 失败
        await page.click('#act');
        break;
      case 'browser-crash':
      case 'worker-crash':
        // 硬编码第一次点触发崩溃，无恢复 -> 失败
        await page.click('#go');
        break;
      default:
        throw new Error('no script for ' + task.id);
    }
  }

  async close() {
    if (this.browser) await this.browser.close().catch(() => {});
  }
}

module.exports = { PlaywrightRunner };
