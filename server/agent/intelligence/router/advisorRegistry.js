'use strict';

// Advisor Registry：可扩展的 Advisor 注册表（Phase 3.5）。
// Router 不硬编码任何 advisor，新增能力（Cookie/Login/Payment/Region Advisor）只需 register，不改 Router。
// 每个 advisor 形如：{ name, priority, run(ctx) -> result }
//   - priority 越大越先执行（经验优先，LLM 最后）。
//   - run 必须纯函数、只读、不执行任何动作。

const registry = [];

function register(advisor) {
  if (!advisor || typeof advisor.run !== 'function' || !advisor.name) {
    throw new Error('advisor 必须包含 name 与 run(ctx)');
  }
  const existing = registry.findIndex((a) => a.name === advisor.name);
  if (existing >= 0) registry[existing] = advisor;
  else registry.push(advisor);
  return advisor;
}

function unregister(name) {
  const i = registry.findIndex((a) => a.name === name);
  if (i >= 0) registry.splice(i, 1);
}

function list() {
  return registry.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0));
}

// 按优先级顺序执行所有 advisor，返回 [{ name, priority, result }]
function runAll(ctx) {
  const out = [];
  for (const a of list()) {
    try {
      out.push({ name: a.name, priority: a.priority || 0, result: a.run(ctx) || null });
    } catch (e) {
      out.push({ name: a.name, priority: a.priority || 0, error: String(e.message || e) });
    }
  }
  return out;
}

module.exports = { register, unregister, list, runAll };
