'use strict';

// Phase 5.1 — Benchmark Runner 抽象基类
// 三组 Runner（A: Playwright / B: Playwright+LLM / C: Experience Agent）
// 统一接口：run(task) -> BenchmarkResult
//
// BenchmarkResult 标准化字段（5.6 report.js 直接消费）：
//   taskId        任务 id
//   category      任务类别
//   runner        标识 'A' | 'B' | 'C'
//   success       boolean
//   latencyMs     端到端耗时（含 recovery 重试）
//   llmCalls      number（A=0）
//   tokens        number（A=0）
//   cost          number（美元估算，A=0）
//   recovery      是否发生过 recovery（boolean）
//   recoveryOk    recovery 是否成功（boolean）
//   humanEscalation 是否升级人工（boolean）
//   memoryHit     Memory 命中率 0..1（A/B=0）
//   routerAccuracy Router 决策准确率 0..1（仅 C）
//   error         string|null
//   raw           各 runner 私有细节（不计入对照表）

class BenchmarkRunner {
  constructor(opts = {}) {
    this.name = opts.name || 'base';
    this.runner = opts.runner || '?'; // 'A' | 'B' | 'C'
    this.mockBaseUrl = opts.mockBaseUrl || process.env.BENCH_MOCK_URL || 'http://localhost:4599';
  }

  // 子类必须实现
  async run(task) {
    throw new Error(`${this.name}.run() not implemented`);
  }

  // 统一构造标准化结果（子类填充差异字段）
  result(task, patch = {}) {
    return Object.assign(
      {
        taskId: task.id,
        category: task.category,
        runner: this.runner,
        success: false,
        latencyMs: 0,
        llmCalls: 0,
        tokens: 0,
        cost: 0,
        recovery: false,
        recoveryOk: false,
        humanEscalation: false,
        memoryHit: 0,
        routerAccuracy: null,
        error: null,
        raw: {},
      },
      patch
    );
  }

  // 估算成本（B/C 用）：每 LLM call ~ token 估算
  estimateCost(llmCalls, tokens) {
    // 简化：input+output 平均 $0.01 / 1K tokens，call 固定开销 $0.002
    return Number((llmCalls * 0.002 + (tokens / 1000) * 0.01).toFixed(4));
  }

  async close() {}
}

module.exports = { BenchmarkRunner };
