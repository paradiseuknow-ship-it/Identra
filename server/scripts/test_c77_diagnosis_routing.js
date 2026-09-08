'use strict';
// C77 —— diagnosis/ 子目录深扫守护测试（零浏览器）。
// P1 fallbackDiagnosis 403 token 边界（D1，C76 D2 同族对齐）
// P2 错误类别字典四方交叉闭合（防未来新增类别漏登记策略）
// P3 failureDiagnoser diagnose 端到端路由抽检（backoff/escalate/wait_only + 证据降级）
// 子进程 FPB_DATA_DIR 隔离，与 c7x 系列同构。

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log('  ok - ' + name); } else { fail++; console.log('  FAIL - ' + name); } }

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c77-data-'));
const enginePath = path.join(ROOT, 'server', 'agent', 'diagnosis', 'diagnosisEngine.js');
const fdPath = path.join(ROOT, 'server', 'agent', 'diagnosis', 'failureDiagnoser.js');
const ecPath = path.join(ROOT, 'server', 'agent', 'recovery', 'errorClassifier.js');
const schemaPath = path.join(ROOT, 'server', 'agent', 'diagnosis', 'diagnosisSchema.js');
const rpPath = path.join(ROOT, 'server', 'agent', 'repair', 'repairPlanner.js');

const p1 = `
process.env.FPB_DATA_DIR = ${JSON.stringify(dataDir)};
const engine = require(${JSON.stringify(enginePath)});
const assert = (c, n) => { if (!c) throw new Error('assert: ' + n); console.log('  ok - ' + n); };
const step = { action: { type: 'click', target: { semantic: 'Continue' } } };

// 真 403（独立 token）仍命中
const r1 = engine.fallbackDiagnosis({ classifier: { type: 'NAVIGATION_FAILED', confidence: 0.8, evidence: [] }, failure: { url: 'http://x' }, observation: { textSummary: '403 Forbidden Access denied' }, step });
assert(r1.category === 'HTTP_FORBIDDEN', 'P1a 独立 403 token 仍判 HTTP_FORBIDDEN');

// 数字子串不命中（价格 $1403 / 编号 40321）
const r2 = engine.fallbackDiagnosis({ classifier: { type: 'ELEMENT_NOT_FOUND', confidence: 0.85, evidence: [] }, failure: { url: 'http://x' }, observation: { textSummary: 'total price $1403 item 40321 in cart' }, step });
assert(r2.category === 'ELEMENT_CHANGED', 'P1b 价格/编号数字子串不再误判 HTTP_FORBIDDEN');

// 既有语义不变：session / cookie 分支
const r3 = engine.fallbackDiagnosis({ classifier: { type: 'UNKNOWN', confidence: 0.6, evidence: [] }, failure: { url: 'http://x' }, observation: { textSummary: 'Please login again to continue' }, step });
assert(r3.category === 'SESSION_EXPIRED', 'P1c SESSION_EXPIRED 分支不变');
`;

const p2 = `
const ec = require(${JSON.stringify(ecPath)});
const schema = require(${JSON.stringify(schemaPath)});
const rp = require(${JSON.stringify(rpPath)});
const fd = require(${JSON.stringify(fdPath)});
const assert = (c, n) => { if (!c) throw new Error('assert: ' + n); console.log('  ok - ' + n); };

// errorClassifier 全类别 ⊆ repairPlanner.STRATEGY_FOR_CATEGORY（C.4 闭合意图固化）。
// 豁免 8 项 VIL failureType（errorClassifier P5 注释：登记性类别，recovery routing 由
// repair/strategies/verifyFailed 按 VIL taxonomy 处理，不经 STRATEGY_FOR_CATEGORY）。
const VIL_TAXONOMY = ['ASYNC_PENDING', 'SUBMIT_RESULT_UNKNOWN', 'DOM_CHANGED', 'EVENTUAL_CONSISTENCY', 'OBSERVATION_DELAY', 'VERIFICATION_TOO_STRICT', 'STATE_UNKNOWN', 'ACTION_REAL_FAILURE'];
const missingInRepair = ec.RECOVERY_CATEGORIES.filter((c) => !VIL_TAXONOMY.includes(c) && !rp.STRATEGY_FOR_CATEGORY[c]);
assert(missingInRepair.length === 0, 'P2a RECOVERY_CATEGORIES（VIL 8 项豁免）全部有 repair 策略映射（缺: ' + missingInRepair.join(',') + '）');

// errorClassifier 全类别 ⊆ failureDiagnoser.RETRY_POLICY_BY_CATEGORY（兜底策略闭合，无豁免）
const missingInPolicy = ec.RECOVERY_CATEGORIES.filter((c) => !fd.RETRY_POLICY_BY_CATEGORY[c]);
assert(missingInPolicy.length === 0, 'P2b RECOVERY_CATEGORIES 全部有兜底 retryPolicy（缺: ' + missingInPolicy.join(',') + '）');

// LLM 诊断 schema 类别 ⊆ failureDiagnoser 兜底表（LLM 输出可路由）
const missingSchema = schema.DIAGNOSIS_CATEGORIES.filter((c) => !fd.RETRY_POLICY_BY_CATEGORY[c]);
assert(missingSchema.length === 0, 'P2c DIAGNOSIS_CATEGORIES 全部可路由（缺: ' + missingSchema.join(',') + '）');

// retryPolicy 枚举闭合：所有映射值 ∈ POLICY_LABEL（无孤儿策略名）
const policies = new Set(Object.values(fd.RETRY_POLICY_BY_CODE).concat(Object.values(fd.RETRY_POLICY_BY_CATEGORY)));
const orphan = [...policies].filter((p) => !fd.PRE_ACTIONS_BY_POLICY[p]);
assert(orphan.length === 0, 'P2d 所有 retryPolicy 有前置动作序列条目（缺: ' + orphan.join(',') + '）');
`;

const p3 = `
process.env.FPB_DATA_DIR = ${JSON.stringify(dataDir)};
const fd = require(${JSON.stringify(fdPath)});
const assert = (c, n) => { if (!c) throw new Error('assert: ' + n); console.log('  ok - ' + n); };

// 凭据错误 → escalate
const d1 = fd.diagnose({ error: { code: 'VERIFY_FAILED', message: 'email or password is incorrect' }, pageText: '邮箱或密码错误', currentAction: { type: 'fill', target: { field: 'password' } } });
assert(d1.retryPolicy === 'escalate', 'P3a 凭据类 blocking 证据 escalate');

// 限流 → backoff（network 为 networkObserver.snapshot 完整结构，apiResponses 为 statusFindings 扫描字段）
const net = { attached: true, pending: 0, sinceTs: 0, counts: { requests: 1, completed: 1, failures: 1, api: 1, status4xx: 1, status5xx: 0, consoleErrors: 0, consoleWarnings: 0, pageErrors: 0 }, failures: [], apiResponses: [{ status: 429, url: 'https://x/api', method: 'GET', at: Date.now() }], console: [], pageErrors: [], lastRequestAt: Date.now(), lastResponseAt: Date.now() };
const d2 = fd.diagnose({ network: net, attempted: true });
assert(d2.retryPolicy === 'backoff', 'P3b 429 -> backoff（网络证据，rootCause=' + d2.rootCause + '）');

// stateResetByRepair：page.text 凭据类 blocking 证据降级后不再 escalate（多走一轮重试）
const d3 = fd.diagnose({ pageText: '邮箱或密码错误', currentAction: { type: 'fill', target: { field: 'password' } }, stateResetByRepair: true });
assert(d3.retryPolicy !== 'escalate' || d1.retryPolicy !== 'escalate', 'P3c stateResetByRepair 降级路径与正常路径可区分');
if (d3.retryPolicy === 'escalate') throw new Error('P3c-detail: stateResetByRepair 未降级, retryPolicy=' + d3.retryPolicy);
assert(true, 'P3c stateResetByRepair 后不 escalate');

// wait_only 前置动作只有等待（无 reload —— 支付防重复扣款）
assert(JSON.stringify(fd.PRE_ACTIONS_BY_POLICY.wait_only) === JSON.stringify(['waitLong']), 'P3d wait_only 序列仅 waitLong、无 reload');
assert(fd.PRE_ACTIONS_BY_POLICY.escalate.length === 0, 'P3e escalate 无前置动作（直接升级）');
`;

try {
  console.log('P1 (child):');
  console.log(execFileSync(process.execPath, ['-e', p1], { encoding: 'utf8', timeout: 30000 }).trim());
  pass += 3;
} catch (e) { fail += 3; console.log('P1 FAIL:', String(e.stderr || e.message).slice(0, 600)); }

try {
  console.log('P2 (child):');
  console.log(execFileSync(process.execPath, ['-e', p2], { encoding: 'utf8', timeout: 30000 }).trim());
  pass += 4;
} catch (e) { fail += 4; console.log('P2 FAIL:', String(e.stderr || e.message).slice(0, 600)); }

try {
  console.log('P3 (child):');
  console.log(execFileSync(process.execPath, ['-e', p3], { encoding: 'utf8', timeout: 30000 }).trim());
  pass += 5;
} catch (e) { fail += 5; console.log('P3 FAIL:', String(e.stderr || e.message).slice(0, 600)); }

console.log('RESULT pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
