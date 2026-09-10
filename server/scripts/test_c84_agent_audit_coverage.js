'use strict';
// C84 守护测试 —— AI 面（/api/ai/*）审计覆盖对账（C83 登记的后续批次，水平复审 round 4）：
//   D1 (B 类审计链断裂)：server/agent/index.js 全部 34 条 mutation 路由零审计（C83 对账
//     时登记边界：AI 面自带 trace/aiSteps 运行时证据链，插桩前需做意图归因）——AI 任务
//     全生命周期（创建/取消/删除/审批）在安全审计链上不可见，「谁在何时对哪个任务做了什么」
//     无法回答。本轮补 28 处埋点（+2 既有 secret.create/delete + 4 冻结豁免 = 34 面闭环）。
//   意图归因设计：审计层不重复记录运行细节（那是 trace/aiSteps 的职责），只补意图事件——
//     resourceId = taskId（或 worker/scheduler/profile id）；/chat 的审计点锚在任务创建
//     （而非规划成功）：mock 下规划恒失败（C79 已证边界）→ 任务被删除清理，但「用户发起过
//     这次 AI 规划意图」必须留存——本轮行为面 P1d 即此最强实证（400 响应 + 审计落盘）。
//   红线：聊天/目标/暂停原因等用户明文只记 *Len 形态，永不入审计（C81 红线同族；
//     audit.redact 兜底为第二层）。modify 只记 patch 字段名（keys），不落值。
//   共享原语：audit.logRequest 提升（C84）——index.js auditReq 与 agent aiAudit 同源，
//     消除本地 helper 重复（C62 fsSafe 纪律）。
//   豁免（冻结 allowlist，双向断言）：profile-recommend / decision（advisory 只读，仅建议
//     不执行）；schema/validate / policy/decide（纯校验/决策，无状态变更）。
//   守护：P2 结构化对账（agent/index.js 全部 mutation 路由必须含 aiAudit 或 audit.log 埋点
//     或命中冻结 allowlist；allowlist 反向活性防悬空）；28 个 action 逐一存在；红线字段
//     形态断言。P1 行为面（零浏览器 Mode A：create/cancel/delete/chat/intel 三面/scheduler
//     tick 审计落盘且意图字段正确；跨工作区 403 负向控制不产生审计；全量 ai.* 审计明文红线扫）。
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 23100 + (process.pid % 50);
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}

function req(method, p, body, token) {
  return new Promise((resolve) => {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = http.request('http://127.0.0.1:' + PORT + p, { method, timeout: 20000, headers }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ code: res.statusCode, body: d }));
    });
    r.on('error', (e) => resolve({ code: 0, body: String(e) }));
    r.on('timeout', () => { r.destroy(); resolve({ code: 0, body: 'TIMEOUT' }); });
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}
const j = (r) => { try { return JSON.parse(r.body); } catch (e) { return null; } };

function bootServer(port, dataDir) {
  return spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      AI_PROVIDER: 'mock',
      FPB_DATA_DIR: dataDir,
      FPB_VAULT_FILE: path.join(dataDir, 'vault.json'),
      FPB_SETTINGS_FILE: path.join(dataDir, 'runtime_settings.json'),
      FPB_MASTER_KEY: Buffer.alloc(32, 12).toString('base64'),
      DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', AI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitReady() {
  for (let i = 0; i < 40; i++) {
    const r = await req('GET', '/api/auth/me');
    if (r.code === 200 || r.code === 401) return true;
    await new Promise((s) => setTimeout(s, 300));
  }
  return false;
}

// ---- P2 结构化对账（agent/index.js）----
// 冻结 allowlist：{ 路由 path: 不审计理由 }。新增豁免必须在此登记理由。
const AI_AUDIT_ALLOWLIST = {
  '/intelligence/profile-recommend': 'advisory 只读（仅建议不执行），无状态变更',
  '/intelligence/decision': 'advisory 只读（决策+解释，不执行），无状态变更',
  '/schema/validate': '纯 schema 校验，无状态变更',
  '/policy/decide': '纯 policy 决策试算，无状态变更',
};
// C84 落地的 28 个 action（逐一存在断言）
const AI_ACTIONS = [
  'ai.task.create', 'ai.task.start', 'ai.task.cancel', 'ai.task.resume', 'ai.task.pause',
  'ai.task.retry', 'ai.task.delete', 'ai.task.recover', 'ai.task.approve', 'ai.task.reject',
  'ai.task.modify', 'ai.chat', 'ai.intel.record', 'ai.intel.export', 'ai.intel.import',
  'ai.worker.start', 'ai.worker.stop', 'ai.execution.recovery', 'ai.execution.submit',
  'ai.scheduler.start', 'ai.scheduler.stop', 'ai.scheduler.pause', 'ai.scheduler.resume',
  'ai.scheduler.drain', 'ai.scheduler.tick', 'ai.resource.acquire', 'ai.resource.release',
  'ai.resource.recover',
];

function parseMutationRoutes(src) {
  const lines = src.split(/\r?\n/);
  const routeRe = /^router\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/;
  const out = [];
  lines.forEach((l, i) => {
    const m = l.match(routeRe);
    if (m) out.push({ line: i, verb: m[1], rpath: m[2] });
  });
  for (const r of out) {
    const end = lines.findIndex((l, i) => i > r.line && l === '});');
    if (end < 0) continue;
    r.body = lines.slice(r.line, end + 1).join('\n');
  }
  return out.filter((r) => r.body && ['post', 'put', 'delete', 'patch'].includes(r.verb));
}

function structuralScan() {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'agent', 'index.js'), 'utf8');
  const muts = parseMutationRoutes(src);
  chk('P2n mutation 路由数量符合预期(34)', muts.length === 34, '实际=' + muts.length + '（新 mutation 落地后须同步更新守护基数）');

  // P2a: 双向对账 —— 每条 mutation 路由必须含 aiAudit / audit.log 埋点，或命中冻结豁免
  for (const m of muts) {
    const audited = /aiAudit\(/.test(m.body) || /audit'\)\.log\(/.test(m.body);
    if (audited) {
      chk('P2a ' + m.verb.toUpperCase() + ' ' + m.rpath + ' 已审计', true, '');
      if (AI_AUDIT_ALLOWLIST[m.rpath] !== undefined) {
        chk('P2a ' + m.rpath + ' 同时命中 allowlist（漂移）', false, '路由已有审计但仍在豁免表，应从 allowlist 移除');
      }
    } else if (AI_AUDIT_ALLOWLIST[m.rpath] !== undefined) {
      chk('P2a ' + m.verb.toUpperCase() + ' ' + m.rpath + ' 冻结豁免（' + AI_AUDIT_ALLOWLIST[m.rpath] + '）', true, '');
    } else {
      chk('P2a ' + m.verb.toUpperCase() + ' ' + m.rpath + ' 已审计', false, 'mutation 路由零审计且未登记豁免 —— 补 aiAudit 或在 allowlist 登记理由');
    }
  }
  // P2b: allowlist 反向活性（豁免条目必须仍对应真实路由，防改名后悬空）
  for (const p of Object.keys(AI_AUDIT_ALLOWLIST)) {
    chk('P2b allowlist 活性 ' + p, muts.some((m) => m.rpath === p), '豁免表条目没有对应路由，应清理');
  }

  // P2c: 28 个 action 逐一存在
  for (const a of AI_ACTIONS) {
    chk('P2c action 落地 ' + a, src.includes("'" + a + "'"), 'source 中未找到 ' + a);
  }

  // P2d: 凭据/明文红线 —— 埋点 detail 只允许 *Len / keys / count 形态
  chk('P2d chat 只记 messageLen', /aiAudit\(req, 'ai\.chat'[\s\S]{0,220}messageLen: String\(message\)\.length/.test(src), 'chat 埋点未用 messageLen 形态');
  chk('P2d chat 不落消息原文', !/aiAudit\(req, 'ai\.chat'[\s\S]{0,300}message:\s*message(?!\s*\?)/.test(src), 'chat 埋点疑似携带消息原文');
  chk('P2d pause 只记 reasonLen', /ai\.task\.pause'[\s\S]{0,220}reasonLen: String\(reason\)\.length/.test(src), 'pause 埋点未用 reasonLen 形态');
  chk('P2d modify 只记 keys', /ai\.task\.modify'[\s\S]{0,220}keys: Object\.keys\(req\.body/.test(src), 'modify 埋点未用 keys 形态');
  chk('P2d intel.import 只记 flowCount', /ai\.intel\.import'[\s\S]{0,220}flowCount: Array\.isArray/.test(src), 'intel.import 埋点未用 count 形态');

  // P2e: 共享原语接线 —— audit.logRequest 存在，index.js auditReq 委托（不保留本地实现）
  let auditSrc = '';
  try { auditSrc = fs.readFileSync(path.join(ROOT, 'server', 'audit.js'), 'utf8'); } catch (e) {}
  chk('P2e audit.logRequest 共享原语存在', /function logRequest\(/.test(auditSrc) && /logRequest/.test(auditSrc.split('module.exports')[1]), 'audit.js 缺 logRequest 导出');
  const idxSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  chk('P2e index.js auditReq 委托共享原语', /function auditReq\(req, action, resourceType, resourceId, detail\) \{\s*\n\s*return require\('\.\/audit'\)\.logRequest/.test(idxSrc), 'auditReq 未委托 logRequest（本地实现重复）');
  chk('P2e agent aiAudit 走共享原语', /function aiAudit\(req, action, resourceType, resourceId, detail\) \{\s*\n\s*return require\('\.\.\/audit'\)\.logRequest/.test(src), 'aiAudit 未走 logRequest');
}

(async () => {
  structuralScan();

  // ---- P1: 行为面（零浏览器 Mode A）----
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c84-'));
  const srv = bootServer(PORT, dataDir);
  try {
    if (!(await waitReady())) { chk('P0 服务器启动', false, 'not ready'); throw new Error('server not ready'); }
    chk('P0 服务器启动', true, '');

    const rr = await req('POST', '/api/auth/register', { username: 'u84', password: 'u84-pass-1', email: 'u84@example.com' });
    chk('P0 register → 201', rr.code === 201, 'code=' + rr.code);
    const lg = j(await req('POST', '/api/auth/login', { username: 'u84', password: 'u84-pass-1' }));
    const tk = lg && lg.token;
    chk('P0 login → token', !!tk, JSON.stringify(lg).slice(0, 60));

    const auditOf = async (action) => j(await req('GET', '/api/auth/audit?action=' + encodeURIComponent(action) + '&limit=200', undefined, tk));

    // P1a: 创建任务 → ai.task.create 审计（意图归因三要素：resourceId=taskId + workspace + actor）
    const ct = j(await req('POST', '/api/ai/tasks', { name: 'c84-task', objective: '打开示例页面并截图', targetUrl: 'https://example.com/' }, tk));
    chk('P1a 建 AI 任务 → 200', !!ct && !!ct.id, JSON.stringify(ct).slice(0, 100));
    const aCreate = await auditOf('ai.task.create');
    const eCreate = aCreate && aCreate.entries && aCreate.entries.find((e) => e.resourceId === ct.id);
    chk('P1a ai.task.create 审计落盘', !!eCreate, JSON.stringify(aCreate).slice(0, 120));
    chk('P1a create 归属三要素', !!eCreate && eCreate.actorName === 'u84' && !!eCreate.workspaceId && eCreate.resourceType === 'ai_task', JSON.stringify(eCreate).slice(0, 160));
    chk('P1a create detail.name', !!eCreate && eCreate.detail && eCreate.detail.name === 'c84-task', JSON.stringify(eCreate).slice(0, 160));

    // P1b: cancel（PENDING 可取消）→ ai.task.cancel 审计
    const cc = await req('POST', '/api/ai/tasks/' + ct.id + '/cancel', {}, tk);
    chk('P1b cancel → 200', cc.code === 200, 'code=' + cc.code);
    const aCancel = await auditOf('ai.task.cancel');
    chk('P1b ai.task.cancel 审计落盘', !!aCancel && aCancel.entries && aCancel.entries.some((e) => e.resourceId === ct.id), JSON.stringify(aCancel).slice(0, 120));

    // P1c: delete → ai.task.delete 审计
    const del = await req('DELETE', '/api/ai/tasks/' + ct.id, undefined, tk);
    chk('P1c 删任务 → 200', del.code === 200, 'code=' + del.code);
    const aDel = await auditOf('ai.task.delete');
    chk('P1c ai.task.delete 审计落盘', !!aDel && aDel.entries && aDel.entries.some((e) => e.resourceId === ct.id), JSON.stringify(aDel).slice(0, 120));

    // P1d: /chat 意图归因 —— 审计点锚在任务创建（先于规划结果落定）。C108 修复 mock plan
    // strict 契约后规划成功 → 200 + taskId；审计 resourceId 必须锚定该任务 id
    //（比旧「400 + 审计留存」更强的归属断言：意图事件与存活任务可对账）。
    const CHAT_MSG = 'C84_INTENT_MARKER_open example and screenshot';
    const chat = await req('POST', '/api/ai/chat', { message: CHAT_MSG }, tk);
    const chatTask = j(chat);
    chk('P1d chat mock 规划成功 → 200（C108 契约修复）', chat.code === 200, 'code=' + chat.code + ' ' + chat.body.slice(0, 120));
    chk('P1d chat 200 返回 taskId', !!chatTask && !!chatTask.taskId, chat.body.slice(0, 120));
    const aChat = await auditOf('ai.chat');
    const eChat = aChat && aChat.entries && aChat.entries.find((e) => chatTask && e.resourceId === chatTask.taskId);
    chk('P1d ai.chat 意图审计落盘且锚定任务 id', !!eChat, JSON.stringify(aChat).slice(0, 120));
    chk('P1d chat detail.messageLen 正确', !!eChat && eChat.detail && eChat.detail.messageLen === CHAT_MSG.length, JSON.stringify(eChat).slice(0, 200));
    chk('P1d chat 审计不含消息原文', !JSON.stringify(eChat || {}).includes('C84_INTENT_MARKER'), JSON.stringify(eChat).slice(0, 200));

    // P1e: intel 三面（record 写面 / export 出域面 / import 写入面）
    const rec = await req('POST', '/api/ai/intelligence/profiles/p-c84/record', { site: 'example.com', ok: true, name: 'c84-profile-name' }, tk);
    chk('P1e intel.record → 200', rec.code === 200, 'code=' + rec.code);
    const aRec = await auditOf('ai.intel.record');
    chk('P1e ai.intel.record 审计落盘', !!aRec && aRec.entries && aRec.entries.length >= 1, JSON.stringify(aRec).slice(0, 120));
    const exp = await req('POST', '/api/ai/intelligence/export', { site: 'example.com', name: 'c84-pack' }, tk);
    chk('P1e intel.export → 200', exp.code === 200, 'code=' + exp.code);
    const aExp = await auditOf('ai.intel.export');
    chk('P1e ai.intel.export 审计落盘（数据出域面）', !!aExp && aExp.entries && aExp.entries.length >= 1, JSON.stringify(aExp).slice(0, 120));
    // import：审计点在 importPack 之前（包无效 → 400 也落审计）——只断言审计存在，不 pin 响应码
    await req('POST', '/api/ai/intelligence/import', { pack: { site: 'example.com', name: 'c84-pack', flows: [] } }, tk);
    const aImp = await auditOf('ai.intel.import');
    chk('P1e ai.intel.import 审计落盘', !!aImp && aImp.entries && aImp.entries.length >= 1, JSON.stringify(aImp).slice(0, 120));

    // P1f: scheduler 手动 tick（低频控制面）→ ai.scheduler.tick 审计
    const tick = await req('POST', '/api/ai/execution/scheduler/tick', {}, tk);
    chk('P1f scheduler.tick → 200', tick.code === 200, 'code=' + tick.code);
    const aTick = await auditOf('ai.scheduler.tick');
    chk('P1f ai.scheduler.tick 审计落盘', !!aTick && aTick.entries && aTick.entries.length >= 1, JSON.stringify(aTick).slice(0, 120));

    // P1g: 负向控制 —— 跨工作区 403 不产生审计（守卫在埋点之前）
    const rr2 = await req('POST', '/api/auth/register', { username: 'u84b', password: 'u84b-pass-1', email: 'u84b@example.com' });
    const lg2 = j(await req('POST', '/api/auth/login', { username: 'u84b', password: 'u84b-pass-1' }));
    const tk2 = lg2 && lg2.token;
    chk('P1g 第二用户登录 → token', !!tk2, '');
    const ct2 = j(await req('POST', '/api/ai/tasks', { name: 'c84-task-b', objective: 'x', targetUrl: 'https://example.com/' }, tk));
    chk('P1g 建 u84 第二任务', !!ct2 && !!ct2.id, '');
    const denied = await req('POST', '/api/ai/tasks/' + ct2.id + '/start', {}, tk2);
    chk('P1g 跨工作区 start → 403', denied.code === 403, 'code=' + denied.code);
    const aStartAll = await auditOf('ai.task.start');
    chk('P1g 403 未产生审计（actorName=u84b 零条目）', !!aStartAll && aStartAll.entries && !aStartAll.entries.some((e) => e.actorName === 'u84b'), JSON.stringify(aStartAll).slice(0, 120));

    // P1h: 明文红线全量扫 —— 全部 ai.* 审计条目不得含聊天明文标记
    const allChat = await auditOf('ai.chat');
    chk('P1h 全量 ai.chat 审计明文红线', !JSON.stringify(allChat || {}).includes('C84_INTENT_MARKER'), JSON.stringify(allChat).slice(0, 200));
  } catch (e) {
    chk('P1 流程异常', false, String(e.message || e));
  } finally {
    try { srv.kill(); } catch (e) {}
  }

  try {
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (f.startsWith('fpb-c84-')) { try { fs.rmSync(path.join(os.tmpdir(), f), { recursive: true, force: true }); } catch (e) {} }
    }
  } catch (e) {}

  console.log('\n===== C84 RESULT: ' + pass + ' passed, ' + fail + ' failed =====');
  if (fail) { failures.forEach((f) => console.log('  FAIL: ' + f)); process.exit(1); }
})();
