'use strict';
// test_scenario_dir_override.js —— FPB_SCENARIO_DIR / FPB_POOL_FILE 接线测试。
// 纪律：断言「真正会执行的那份东西」——子进程真实 require phase10Benchmark.loadTasks()
// 并在 env 注入下求值返回结果；默认路径（不设 env）行为必须与冻结 v1 池逐字节一致。
// 运行：node server/scripts/test_scenario_dir_override.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } }

const V2_DIR = path.join(ROOT, 'server', 'scenarios', 'real-world-v2');
const V1_DIR = path.join(ROOT, 'server', 'scenarios', 'real-world');
const LOAD_SNIPPET = "const P9=require('./phase10Benchmark');const l=P9.loadTasks();console.log(JSON.stringify({n:l.length,first:l[0].id,obj1:l[0].objective,last:l[l.length-1].id}));";

function loadWithEnv(envExtra) {
  const out = execFileSync(process.execPath, ['-e', LOAD_SNIPPET], {
    cwd: path.join(ROOT, 'server', 'scripts'),
    env: Object.assign({}, process.env, { DEEPSEEK_API_KEY: 'test-gate-only' }, envExtra),
    encoding: 'utf8', timeout: 60000,
  });
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  return JSON.parse(line);
}

// ── 前置：v2 场景目录就绪 ──
ok(fs.existsSync(V2_DIR) && fs.readdirSync(V2_DIR).filter((f) => f !== 'index.json').length === 100, 'v2 场景目录含 100 个任务文件');

// ── 1. 默认路径零变化（不设 env → 冻结 v1 池）──
const dflt = loadWithEnv({});
ok(dflt.n === 100, '默认加载 100 任务');
ok(dflt.obj1 === '登录系统并查看看板', '默认 rw.001 objective = v1 冻结值（未切换）');

// ── 2. FPB_SCENARIO_DIR 指向 v2 → 加载对齐池 ──
const v2 = loadWithEnv({ FPB_SCENARIO_DIR: V2_DIR });
ok(v2.n === 100, 'v2 目录加载 100 任务');
ok(v2.first === 'rw.001' && v2.last === 'rw.100', 'v2 任务 id 连续 rw.001..rw.100');
ok(v2.obj1 === '使用凭据登录 SaaS 控制台并查看看板', 'v2 rw.001 objective = v2 对齐值（env 生效，与 v1 不同）');

// ── 3. 相对路径解析 ──
const v2rel = loadWithEnv({ FPB_SCENARIO_DIR: path.relative(path.join(ROOT, 'server', 'scripts'), V2_DIR) });
ok(v2rel.n === 100 && v2rel.obj1 === v2.obj1, 'FPB_SCENARIO_DIR 相对路径（相对 cwd）同样生效');

// ── 4. 非法目录 → 显式失败（不静默为空池）──
let threw = false;
try { loadWithEnv({ FPB_SCENARIO_DIR: path.join(ROOT, 'server', 'scenarios', 'no-such-dir') }); } catch (e) { threw = true; }
ok(threw, 'FPB_SCENARIO_DIR 指向不存在目录时 loadTasks 显式抛错');

// ── 5. v2 与 v1 同 id 不同 objective（池替换语义成立）──
ok(dflt.obj1 !== v2.obj1, '同 id rw.001 在两池 objective 不同（env 切换真实生效）');

// ── 6. phase12Benchmark selection 元数据接线（该行仅在真实 benchmark 运行时执行，此处断言求值表达式存在于源码）──
const src = fs.readFileSync(path.join(__dirname, 'phase12Benchmark.js'), 'utf8');
ok(src.includes("poolFile: process.env.FPB_POOL_FILE || 'phase12_pool.json'"), 'selection.poolFile 接线 FPB_POOL_FILE（默认 phase12_pool.json 不变）');
ok(src.includes("scenarioDir: process.env.FPB_SCENARIO_DIR || 'server/scenarios/real-world'"), 'selection.scenarioDir 透传 FPB_SCENARIO_DIR（证据可溯源）');

console.log('test_scenario_dir_override: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
