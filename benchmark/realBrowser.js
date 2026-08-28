'use strict';

// Phase 5.5 — Real Browser Integration 框架
// 目标：在真实 Chrome + Profile + Proxy + CDP 下验证你列的 10 个工程点：
//   浏览器启动时间 / Chrome crash / CDP 断连 / Profile 锁 /
//   页面卡死 / 网络异常 / 多 Browser 并发 / 内存泄漏 /
//   长时间运行后的 Worker 状态 / 浏览器进程残留
//
// 设计纪律（按你的要求）：
//   - 先框架 + 已验证 headless 路径，不阻塞 A/B/C 主结论
//   - 复用现有 browserResourcePool / resourceRecovery，不造新资源层
//   - 真实站点任务通过 tasks 的 real 覆盖注入（1-2 个）
//
// 采集的指标写入 metrics[]，供 5.6 / 5.7 消费（尤其 SQLite->Postgres 临界点观察）。

const { chromium } = require('playwright');
const { browserResourcePool } = require('../server/agent/execution/browser/browserResourcePool');
const { resourceRecovery } = require('../server/agent/execution/browser/resourceRecovery');

class RealBrowserHarness {
  constructor(opts = {}) {
    this.opts = opts;
    this.metrics = [];
    this.browsers = [];
  }

  _mark(name, patch = {}) {
    this.metrics.push(Object.assign({ name, at: Date.now() }, patch));
  }

  // 启动单个真实 Chrome（headless 已验证路径，prod 可设 headless:false + proxy）
  async launchOne(profileId, proxy) {
    const t0 = Date.now();
    const args = [];
    if (proxy) args.push(`--proxy-server=${proxy}`);
    const browser = await chromium.launch({ headless: this.opts.headless !== false, args });
    const bootMs = Date.now() - t0;
    this.browsers.push({ browser, profileId });
    this._mark('browser-boot', { profileId, bootMs, pid: browser.process() && browser.process().pid });
    // 注册到资源池（复用现有资源层）
    browserResourcePool.preregister([profileId]);
    return { browser, bootMs };
  }

  // 多 Browser 并发启动（验证并发 + 后续利用率）
  async launchMany(profileIds, proxy) {
    const t0 = Date.now();
    const ps = profileIds.map((p) => this.launchOne(p, proxy));
    const res = await Promise.all(ps);
    this._mark('concurrent-boot', { count: profileIds.length, totalMs: Date.now() - t0 });
    return res;
  }

  // CDP 断连模拟：强制关闭 browser，触发 resourceRecovery.rebuildBrowser
  async simulateCrash(profileId) {
    const entry = this.browsers.find((b) => b.profileId === profileId);
    if (entry) {
      await entry.browser.close().catch(() => {});
      this._mark('chrome-crash', { profileId });
      const rebuilt = resourceRecovery.rebuildBrowser(profileId);
      this._mark('rebuild-browser', { profileId, ok: !!rebuilt });
      return rebuilt;
    }
  }

  // 进程残留检查：关闭后进程是否还在
  async checkProcessLeak() {
    const leaks = this.browsers.filter((b) => {
      const p = b.browser.process();
      return p && !p.killed && p.exitCode === null;
    }).map((b) => b.profileId);
    this._mark('process-leak-check', { leaked: leaks, count: leaks.length });
    return leaks;
  }

  // 真实站点单任务执行（供 5.5 真实站点验证）
  async runRealTask(task) {
    const proxy = this.opts.proxy;
    const { browser } = await this.launchOne(task.real.profileId || 'real', proxy);
    const page = await browser.newPage();
    const t0 = Date.now();
    try {
      await page.goto(task.real.url, { waitUntil: 'domcontentloaded', timeout: task.verify.timeoutMs || 15000 });
      const ok = await require('./verify').verifyResult(task, page, { baseUrl: '' });
      this._mark('real-task', { id: task.id, success: ok, ms: Date.now() - t0 });
      return ok;
    } catch (e) {
      this._mark('real-task-error', { id: task.id, error: String(e.message || e).slice(0, 160) });
      return false;
    } finally {
      await browser.close().catch(() => {});
    }
  }

  async closeAll() {
    for (const b of this.browsers) await b.browser.close().catch(() => {});
    this.browsers = [];
  }

  summary() {
    const boots = this.metrics.filter((m) => m.name === 'browser-boot');
    const avgBoot = boots.length ? Math.round(boots.reduce((s, m) => s + m.bootMs, 0) / boots.length) : 0;
    return {
      launches: boots.length,
      avgBootMs: avgBoot,
      maxBootMs: boots.length ? Math.max(...boots.map((m) => m.bootMs)) : 0,
      crashes: this.metrics.filter((m) => m.name === 'chrome-crash').length,
      rebuilds: this.metrics.filter((m) => m.name === 'rebuild-browser').length,
      processLeaks: (this.metrics.find((m) => m.name === 'process-leak-check') || {}).count || 0,
      metrics: this.metrics,
    };
  }
}

module.exports = { RealBrowserHarness };
