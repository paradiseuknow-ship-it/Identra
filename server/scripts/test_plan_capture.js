'use strict';

// FPB_CAPTURE_PLAN_DIR 取证捕获测试：验证 deepseekPlan 在 env 开启时真实落盘
// planner 原始输出（rawOutput/userPrompt/finishReason），且 env 未设置时零写盘。
// fakeChatFn 不出网；捕获路径是真实执行代码（非源码检查）。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

function run(envSet) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-cap-'));
  if (envSet) process.env.FPB_CAPTURE_PLAN_DIR = tmp;
  else delete process.env.FPB_CAPTURE_PLAN_DIR;
  // 每次 require 重新求值 captureDir（deepseekPlan 内部读取 env）
  delete require.cache[require.resolve('../agent/llm/providers/deepseek')];
  const { deepseekPlan } = require('../agent/llm/providers/deepseek');
  const fakeChatFn = async () => ({ content: '{"goal":"g","steps":[]}', finishReason: 'stop' });
  return deepseekPlan(fakeChatFn, { objective: '测试捕获', targetUrl: '/' }, {})
    .catch(() => null)
    .then((r) => {
      const files = fs.readdirSync(tmp).filter((f) => f.startsWith('plan_'));
      return { tmp, files, r };
    });
}

(async () => {
  // 1. env 开启：文件必须落盘且含原始输出
  const a = await run(true);
  assert.strictEqual(a.files.length, 3, '每次 LLM IO（含 schema 拒绝后的重试，attempt 0..2）都必须留证，实际 ' + a.files.length);
  const rec = JSON.parse(fs.readFileSync(path.join(a.tmp, a.files[0]), 'utf8'));
  assert.ok(rec.rawOutput.includes('"goal":"g"'), 'rawOutput 必须是 planner 原始输出原文');
  assert.ok(rec.userPrompt.includes('测试捕获'), 'userPrompt 必须含目标文本');
  assert.strictEqual(rec.finishReason, 'stop');
  assert.ok(rec.ts && rec.seq === 1, '时戳与序号在场');
  fs.rmSync(a.tmp, { recursive: true, force: true });

  // 2. env 关闭：零写盘（默认行为不变）
  const b = await run(false);
  assert.strictEqual(b.files.length, 0, 'env 关闭时禁止写盘');
  fs.rmSync(b.tmp, { recursive: true, force: true });

  console.log('PASS 4/4  FPB_CAPTURE_PLAN_DIR: 开启落盘原文 + 关闭零写盘');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
