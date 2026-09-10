#!/usr/bin/env node
// C71 —— tools.js 深扫修复守护（agent 子模块深扫第 3 批，tools.js 880 行）：
//   D1 (B 类·凭据卫生)：resolveFill 未知字段回退 s.email || s.password —— 只存密码无 email
//     的凭据会把明文密码打进 username/phone 等 type=text 明文输入框（回显/自动保存/页面脚本
//     皆可读取）。修复：密码唯一出口 = field 含 'password'；未知字段只回退 email。
//   D2 (B 类·进程健壮性)：download case 外层 withBrowserOp('download.wait') 入口抛错
//     （任务 CANCELLED / 页面已死）时，已启动的 trigger / downloadEvent 成为浮动 promise →
//     Node 15+ unhandledRejection 默认崩溃整个 server 进程。修复：创建后立即挂观察者 catch
//     （Promise.all 语义不变）。
//   D3 (C 类)：assertPageAlive 不可靠 session 探测死代码删除。
//   D4 (C 类·证据血缘)：inspect/开合标签类工具 before/after 同引用，_enrich 先后两次写
//     同一对象 → 最终 source='before_action' 但 fresh=true 矛盾血缘。修复：同引用跳过 before
//     enrich（该对象本质是动作后的 fresh 观察）。
//   D5 (C 类 hardening)：download 文件名清洗后 '..' / '.' 残留 → saveAs 指向下载目录外。
// 零浏览器零网络；FPB_DATA_DIR tmp 隔离（vault/secretManager/store 路径模块加载时解析，
// 子进程 env 注入）；observation/browserManager/taskManager/lock 同模块对象属性补丁。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const here = __dirname;
let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + ': ' + detail); console.log('  FAIL ' + name + ' — ' + detail); }
}

function runInChild(tag, script) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c71-data-'));
  const tmpJS = path.join(os.tmpdir(), 'c71-' + tag + '-' + Date.now() + '.js');
  fs.writeFileSync(tmpJS, script, 'utf8');
  const r = spawnSync(process.execPath, [tmpJS], {
    env: Object.assign({}, process.env, { FPB_DATA_DIR: dataDir, AI_PROVIDER: 'mock' }),
    encoding: 'utf8',
    timeout: 60000,
  });
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(tmpJS, { force: true }); } catch (e) {}
  return r;
}

const BASE = here.replace(/\\/g, '/') + '/../agent';
const ROOT = here.replace(/\\/g, '/') + '/..';

function extractResult(stdout) {
  const m = String(stdout || '').split('\n').find((l) => l.startsWith('RESULT_JSON:'));
  if (!m) return null;
  try { return JSON.parse(m.slice('RESULT_JSON:'.length)); } catch (e) { return null; }
}

const PAGE_HELPER = `
const fakePage = {
  isClosed: () => false,
  url: () => 'https://shop.test/login',
  waitForTimeout: async () => {},
  $eval: async () => { throw new Error('no-eval'); },
  locator: () => ({ fill: async (v) => { out.typed.push(['fill', v]); }, click: async () => {} }),
  waitForEvent: () => new Promise((_, rej) => setTimeout(() => rej(new Error('no-download-event')), 800)),
};
`;

// ---- P1-P3: D1 凭据卫生（最强实证：password-only 凭据 + username 字段 = 不打密码）----
{
  const script = `
'use strict';
const vault = require('${ROOT}/vault');
const secretManager = require('${BASE}/secretManager');
const tools = require('${BASE}/tools');
const browserManager = require('${ROOT}/browserManager');
const observation = require('${BASE}/observation');
const taskManager = require('${BASE}/taskManager');
const out = { typed: [], results: {} };
(async () => {
${PAGE_HELPER}
  observation.inspect = async () => ({ ok: true, observation: { url: 'https://shop.test/login', elements: [], capturedAt: Date.now() } });
  browserManager.getSession = () => ({ page: fakePage, profileId: 'p-c71' });
  browserManager.humanType = async (page, sel, v) => { out.typed.push(v); };
  // P0-A（C107）：凭据类动作需要真实授权上下文（显式 targetUrl + 可解析 origin）。
  // 本 fixture 的 fakePage 声明 url = https://shop.test/login，故任务锚点必须与之一致；
  // 否则安全闸 fail closed（AUTHORIZATION_CONTEXT_MISSING）——这是**正确**行为，不得放宽。
  taskManager.getTask = () => ({ id: 't-c71', profileId: 'p-c71', status: 'RUNNING', targetUrl: 'https://shop.test/login' });

  vault.setProfileSecrets('p-c71a', { password: 'TopS3cret!' });
  const credA = secretManager.createSecret({ profileId: 'p-c71a', type: 'email_password' });
  vault.setProfileSecrets('p-c71b', { email: 'u@x.test', password: 'TopS3cret!' });
  const credB = secretManager.createSecret({ profileId: 'p-c71b', type: 'email_password' });

  // S1: username 字段 + password-only 凭据 → NO_VALUE 且明文密码绝不流入输入层
  const r1 = await tools.runTool({ type: 'fill', target: { selector: '#username', field: 'username' }, credentialRef: credA.id }, { page: fakePage, session: { profileId: 'p-c71' } }, { taskId: 't-c71' });
  out.results.s1 = { code: r1.error && r1.error.code, typedCount: out.typed.length };

  // S2: password 字段 + password-only 凭据 → 正常打密码（安全出口保留）
  const r2 = await tools.runTool({ type: 'fill', target: { selector: '#pwd', field: 'password' }, credentialRef: credA.id }, { page: fakePage, session: { profileId: 'p-c71' } }, { taskId: 't-c71' });
  out.results.s2 = { success: r2.success, typed: out.typed.slice() };

  // S3: username 字段 + email 凭据 → 回退 email（既有行为保留）
  const r3 = await tools.runTool({ type: 'fill', target: { selector: '#username', field: 'username' }, credentialRef: credB.id }, { page: fakePage, session: { profileId: 'p-c71' } }, { taskId: 't-c71' });
  out.results.s3 = { success: r3.success, typed: out.typed.slice() };

  console.log('RESULT_JSON:' + JSON.stringify(out));
  process.exit(0);
})().catch((e) => { console.log('CHILD_ERROR:' + (e.message || e)); process.exit(2); });
`;
  const r = runInChild('d1', script);
  const res = extractResult(r.stdout);
  chk('P1 child exits 0', r.status === 0, 'status=' + r.status + ' stderr=' + String(r.stderr || '').slice(0, 200));
  chk('P1 result parsed', !!res, 'no RESULT_JSON in stdout');
  if (res) {
    chk('P1a username+passwordOnly -> NO_VALUE (not typed)', res.results.s1 && res.results.s1.code === 'NO_VALUE', JSON.stringify(res.results.s1));
    chk('P1b zero plaintext typed in S1', res.results.s1 && res.results.s1.typedCount === 0, 'typedCount=' + (res.results.s1 && res.results.s1.typedCount));
    chk('P2 password field still fills password', res.results.s2 && res.results.s2.success === true && res.results.s2.typed && res.results.s2.typed.length === 1 && res.results.s2.typed[0] === 'TopS3cret!', JSON.stringify(res.results.s2));
    chk('P3 username+email cred -> fills email', res.results.s3 && res.results.s3.success === true && res.results.s3.typed && res.results.s3.typed.length === 2 && res.results.s3.typed[1] === 'u@x.test', JSON.stringify(res.results.s3));
  }
}

// ---- P4: D2 浮动 promise —— download.wait 入口 CANCELLED 后 trigger 拒绝不得成 unhandledRejection ----
{
  const script = `
'use strict';
const tools = require('${BASE}/tools');
const observation = require('${BASE}/observation');
const browserManager = require('${ROOT}/browserManager');
const taskManager = require('${BASE}/taskManager');
let unhandled = null;
process.on('unhandledRejection', (e) => { unhandled = String((e && e.message) || e); });
let taskCalls = 0;
taskManager.getTask = () => { taskCalls++; return { id: 't-dl', profileId: 'p-dl', status: taskCalls >= 3 ? 'CANCELLED' : 'RUNNING' }; };
observation.inspect = async () => ({ ok: true, observation: { url: 'https://x.test/d', elements: [], capturedAt: Date.now() } });
browserManager.humanClick = async () => { await new Promise((_, rej) => setTimeout(() => rej(new Error('humanClick-boom')), 60)); };
${PAGE_HELPER}
(async () => {
  // runTool 契约：错误以 RESULT.error 返回（不抛出）
  const r = await tools.runTool({ type: 'download', target: { selector: '#dl' }, value: '' }, { page: fakePage, session: { profileId: 'p-dl' } }, { taskId: 't-dl' });
  const errCode = r.error && r.error.code;
  await new Promise((r2) => setTimeout(r2, 400));
  console.log('RESULT_JSON:' + JSON.stringify({ errCode, unhandled }));
  process.exit(unhandled ? 3 : 0);
})().catch((e) => { console.log('CHILD_ERROR:' + (e.message || e)); process.exit(2); });
`;
  const r = runInChild('d2', script);
  const res = extractResult(r.stdout);
  chk('P4 child exits 0 (no unhandledRejection crash)', r.status === 0, 'status=' + r.status + ' stderr=' + String(r.stderr || '').slice(0, 200));
  // 既有契约：download.wait 段任何失败（含入口 CANCELLED 抛错）都被 case 内 try/catch 收敛为
  // DOWNLOAD_FAILED 返回值 —— post-fix 语义 = 不崩溃 + 结构化错误返回。
  chk('P4a download.wait failure surfaces DOWNLOAD_FAILED', res && res.errCode === 'DOWNLOAD_FAILED', JSON.stringify(res));
  chk('P4b zero unhandled rejections', res && res.unhandled === null, JSON.stringify(res));
}

// ---- P5: D5 '..' 文件名 —— saveAs 路径必须留在下载目录内 ----
{
  const script = `
'use strict';
const path = require('path');
const tools = require('${BASE}/tools');
const observation = require('${BASE}/observation');
const browserManager = require('${ROOT}/browserManager');
const taskManager = require('${BASE}/taskManager');
taskManager.getTask = () => ({ id: 't-dl2', profileId: 'p-dl2', status: 'RUNNING' });
observation.inspect = async () => ({ ok: true, observation: { url: 'https://x.test/d', elements: [], capturedAt: Date.now() } });
browserManager.humanClick = async () => {};
let savedPath = null;
const downloadObj = { suggestedFilename: () => '..', saveAs: async (p) => { savedPath = p; } };
${PAGE_HELPER}
fakePage.waitForEvent = () => new Promise((res) => setTimeout(() => res(downloadObj), 30));
(async () => {
  const r = await tools.runTool({ type: 'download', target: { selector: '#dl' }, value: '' }, { page: fakePage, session: { profileId: 'p-dl2' } }, { taskId: 't-dl2' });
  const expectedDir = path.join('${ROOT}', 'data', 'downloads');
  console.log('RESULT_JSON:' + JSON.stringify({
    success: r.success,
    code: r.error && r.error.code,
    filePath: r.result && r.result.filePath,
    inDir: savedPath && path.dirname(savedPath) === expectedDir,
    base: savedPath && path.basename(savedPath),
  }));
  process.exit(0);
})().catch((e) => { console.log('CHILD_ERROR:' + (e.message || e)); process.exit(2); });
`;
  const r = runInChild('d5', script);
  const res = extractResult(r.stdout);
  chk('P5 child exits 0', r.status === 0, 'status=' + r.status + ' stderr=' + String(r.stderr || '').slice(0, 200));
  chk('P5a download succeeds', res && res.success === true, JSON.stringify(res));
  chk('P5b saveAs stays inside download dir', res && res.inDir === true, JSON.stringify(res));
  chk('P5c ".." filename neutralized', res && typeof res.base === 'string' && /^download-\d+$/.test(res.base), JSON.stringify(res));
}

// ---- P6: D4 证据血缘 —— inspect（before/after 同引用）最终 source 必须是 after_action + fresh ----
{
  const script = `
'use strict';
const tools = require('${BASE}/tools');
const observation = require('${BASE}/observation');
const taskManager = require('${BASE}/taskManager');
const lock = require('${BASE}/lock');
const evidence = require('${BASE}/evidence');
const browserManager = require('${ROOT}/browserManager');
taskManager.getTask = () => ({ id: 't-x', profileId: 'p-x', status: 'RUNNING' });
lock.getOwner = () => ({ executionId: 'exec-x' });
evidence.saveSnapshot = async () => null;
browserManager.getSession = () => ({ page: fakePage, profileId: 'p-x' });
observation.inspect = async () => ({ ok: true, observation: { url: 'https://x.test/', elements: [], capturedAt: Date.now() } });
${PAGE_HELPER}
(async () => {
  const out = await tools.execute({
    action: { type: 'inspect', risk: 'LOW', target: { text: 'page' } },
    taskId: 't-x', executionId: 'exec-x', stepId: 's1', attemptId: 'a1',
  });
  const obs = out.observation;
  console.log('RESULT_JSON:' + JSON.stringify({
    success: out.success,
    code: out.error && out.error.code,
    sameRef: out.beforeObservation === obs,
    source: obs && obs.source,
    fresh: obs && obs.fresh,
    taskId: obs && obs.taskId,
    stepId: obs && obs.stepId,
    attemptId: obs && obs.attemptId,
  }));
  process.exit(0);
})().catch((e) => { console.log('CHILD_ERROR:' + (e.message || e)); process.exit(2); });
`;
  const r = runInChild('d4', script);
  const res = extractResult(r.stdout);
  chk('P6 child exits 0', r.status === 0, 'status=' + r.status + ' stderr=' + String(r.stderr || '').slice(0, 300));
  chk('P6a execute succeeds', res && res.success === true, JSON.stringify(res));
  chk('P6b lineage source=after_action (not before_action)', res && res.source === 'after_action', JSON.stringify(res));
  chk('P6c fresh=true preserved', res && res.fresh === true, JSON.stringify(res));
  chk('P6d lineage fields intact', res && res.taskId === 't-x' && res.stepId === 's1' && res.attemptId === 'a1', JSON.stringify(res));
}

// ---- P7: 文件断言守护（注释剥离后匹配，防回退）----
{
  const raw = fs.readFileSync(path.join(here, '..', 'agent', 'tools.js'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  chk('P7a D1 fallback removed (no s.email || s.password)', !src.includes('s.email || s.password'), 'password fallback still present');
  chk('P7b D2 observer catches present', src.includes('downloadEvent.catch(() => {})') && src.includes('trigger.catch(() => {})'), 'observer catch missing');
  chk('P7c D5 filename guard present', src.includes("fileName === '..'"), 'filename guard missing');
  chk('P7d D4 identity guard present', src.includes('toolOut.beforeObservation !== observationRes'), 'identity guard missing');
  chk('P7e D3 dead code removed', !src.includes('const sess = page && page._browser'), 'dead session probe still present');
}

console.log('\n===== test_c71: ' + pass + ' passed, ' + fail + ' failed =====');
if (failures.length) { console.log(failures.join('\n')); process.exit(1); }
process.exit(0);
