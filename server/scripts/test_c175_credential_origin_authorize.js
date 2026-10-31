'use strict';

// C175 守护：跨域凭据 origin 人工授权（UI / 自动来源）。
//
// 立项失败面：跨域凭据动作被授权闸拦截后 pageOrigin 已落 task.securityBlocks，
// 但用户此前没有任何授权途径（无 UI / 无 API）⇒ 任务死在升级/失败。
// 本批交付：taskManager.authorizeOrigin + POST /api/ai/tasks/:id/authorize-origin
// + TaskDetail 凭据授权面板（securityBlocks 聚合 = 自动来源）。
//
// 红线锚（C3）：授权范围刻意只覆盖「域未授权族」三码；SECURITY_CHALLENGE /
// NO_ORIGIN_CONTEXT / PAGE_ORIGIN_UNKNOWN 绝不进授权集合 —— 挑战页授权即绕过人机验证。
//
// 运行：node scripts/test_c175_credential_origin_authorize.js（离线，无浏览器）

const os = require('os');
const path = require('path');
const fs = require('fs');

// 必须在任何 require 之前设置（数据根是模块加载期解析的）。
process.env.FPB_DATA_DIR = path.join(os.tmpdir(), 'c175_origin_' + Date.now());

const SERVER = path.join(__dirname, '..');
const AGENT = path.join(SERVER, 'agent');
const taskManager = require(path.join(AGENT, 'taskManager'));
const events = require(path.join(AGENT, 'events'));
const store = require(path.join(AGENT, 'store'));
const credAuth = require(path.join(AGENT, 'credentialAuthorization'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// ─────────────────────────────────────────────────────────────
// A 组：taskManager.authorizeOrigin 行为（真实执行，tmp 隔离数据根）
// ─────────────────────────────────────────────────────────────
console.log('A. authorizeOrigin 行为');

function freshTask(extra) {
  return taskManager.createTask(Object.assign({
    name: 'c175', objective: '测试任务', targetUrl: 'https://shop.example.com/signup',
    credentialAuthorization: extra || undefined,
  }, {}));
}

{
  // A1 裸域归一化：用户从 securityBlocks 看到的可能是 host 形态
  const t = freshTask();
  const r = taskManager.authorizeOrigin(t.id, 'idp.partner.com');
  check('A1 裸域 → 归一为 https origin',
    r.origin === 'https://idp.partner.com'
    && r.task.credentialAuthorization.authorizedOrigins.indexOf('https://idp.partner.com') >= 0,
    'origin=' + r.origin);

  // A2 带路径 URL 同样收敛到 origin（与闸门口径一致）
  const r2 = taskManager.authorizeOrigin(t.id, 'https://idp.partner.com/login?next=/x');
  check('A2 带路径 URL → 收敛同一 origin（幂等去重）',
    r2.origin === 'https://idp.partner.com'
    && r2.task.credentialAuthorization.authorizedOrigins.filter((x) => x === 'https://idp.partner.com').length === 1,
    'origins=' + JSON.stringify(r2.task.credentialAuthorization.authorizedOrigins));

  // A3 非默认端口保留
  const r3 = taskManager.authorizeOrigin(t.id, 'https://idp2.partner.com:8443/signin');
  check('A3 非默认端口保留',
    r3.task.credentialAuthorization.authorizedOrigins.indexOf('https://idp2.partner.com:8443') >= 0,
    JSON.stringify(r3.task.credentialAuthorization.authorizedOrigins));

  // A4 非法 origin → 抛错且不落垃圾
  const before = JSON.stringify(r3.task.credentialAuthorization);
  let threw = false;
  try { taskManager.authorizeOrigin(t.id, 'not a url $$$'); } catch (e) { threw = true; }
  const after = taskManager.getTask(t.id);
  check('A4 非法 origin → 抛错且声明不变',
    threw && JSON.stringify(after.credentialAuthorization) === before);
}

{
  // A5 保留既有声明字段（OAuth providers / flow transitions 不被清掉）
  const t = freshTask({
    authorizedOrigins: ['https://existing.example.com'],
    allowedOAuthProviders: ['idp.example.com'],
    authorizeFlowTransitions: true,
  });
  const r = taskManager.authorizeOrigin(t.id, 'https://new.partner.com');
  const d = r.task.credentialAuthorization;
  check('A5 保留既有声明（providers / transitions / 既有域）',
    d.authorizedOrigins.indexOf('https://existing.example.com') >= 0
    && d.authorizedOrigins.indexOf('https://new.partner.com') >= 0
    && d.allowedOAuthProviders.length === 1 && d.allowedOAuthProviders[0] === 'idp.example.com'
    && d.authorizeFlowTransitions === true,
    JSON.stringify(d));

  // A6 事件落库
  const evs = events.recent(t.id, 50);
  check('A6 授权事件落库（ai.credential_origin_authorized）',
    evs.some((e) => e.type === 'ai.credential_origin_authorized'
      && e.payload && e.payload.origin === 'https://new.partner.com'),
    'types=' + evs.map((e) => e.type).join(','));
}

{
  // A7 resume 联动：PAUSED_FOR_HUMAN 时 resume=true → 恢复执行；非暂停状态不改状态
  const t = freshTask(); // 无 profileId ⇒ start() 不占锁不起浏览器；executor 未注入 ⇒ _kick 零副作用
  taskManager.start(t.id);
  taskManager.pauseForHuman(t.id, 'credential blocked', {});
  let r = taskManager.authorizeOrigin(t.id, 'https://a.partner.com');
  check('A7a 默认不恢复（resume 未传）',
    r.resumed === false && r.task.status === 'PAUSED_FOR_HUMAN',
    'status=' + r.task.status);
  r = taskManager.authorizeOrigin(t.id, 'https://b.partner.com', { resume: true });
  check('A7b resume=true → 任务恢复 RUNNING',
    r.resumed === true && r.task.status === 'RUNNING',
    'status=' + r.task.status);
  const r2 = taskManager.authorizeOrigin(t.id, 'https://c.partner.com', { resume: true });
  check('A7c 非暂停状态下 resume=true 不抛错不改变状态',
    r2.resumed === false && r2.task.status === 'RUNNING');
}

// ─────────────────────────────────────────────────────────────
// B 组：闸门语义闭环（授权声明 → contextFor 刷新 → authorize 放行）
// ─────────────────────────────────────────────────────────────
console.log('B. 闸门语义闭环（授权即时生效）');

{
  const t = freshTask(); // anchor = https://shop.example.com
  const action = { type: 'fill', target: { field: 'password' } };

  // B1 授权前：第三方域被拒（ORIGIN_NOT_AUTHORIZED）
  credAuth.resetContexts();
  let ctx = credAuth.contextFor(taskManager.getTask(t.id), 'exec_c175');
  let v = credAuth.authorize({ context: ctx, pageUrl: 'https://idp.partner.com/login', action });
  check('B1 授权前跨域拒绝（ORIGIN_NOT_AUTHORIZED）',
    v.allowed === false && v.reason === 'ORIGIN_NOT_AUTHORIZED', 'reason=' + v.reason);

  // B2 授权后：同一执行上下文即时刷新放行（无需重建 context）
  taskManager.authorizeOrigin(t.id, 'https://idp.partner.com/login');
  ctx = credAuth.contextFor(taskManager.getTask(t.id), 'exec_c175');
  v = credAuth.authorize({ context: ctx, pageUrl: 'https://idp.partner.com/login', action });
  check('B2 授权后同执行即时放行（contextFor 刷新显式集合）',
    v.allowed === true, 'reason=' + v.reason + ' evidence=' + JSON.stringify(v.evidence));

  // B3 未授权的第四域仍拒（授权不外溢）
  ctx = credAuth.contextFor(taskManager.getTask(t.id), 'exec_c175');
  v = credAuth.authorize({ context: ctx, pageUrl: 'https://evil.example.net/login', action });
  check('B3 授权不外溢（其它域仍拒）',
    v.allowed === false && v.reason === 'ORIGIN_NOT_AUTHORIZED');

  // B4 锚点域不受影响（原本就放行）
  ctx = credAuth.contextFor(taskManager.getTask(t.id), 'exec_c175');
  v = credAuth.authorize({ context: ctx, pageUrl: 'https://shop.example.com/signup', action });
  check('B4 锚点域仍放行',
    v.allowed === true);
  credAuth.resetContexts();
}

// ─────────────────────────────────────────────────────────────
// C 组：接线断言（路由 / API / 前端 —— 锚形状，防改文件不改测试的静默漂移）
// ─────────────────────────────────────────────────────────────
console.log('C. 接线断言');

// 仓库根相对读取（server/agent 与 client/src 都在仓库根下）
const read = (p) => fs.readFileSync(path.join(SERVER, '..', p), 'utf8');

{
  // C1 路由：存在 + 归属守卫 + 审计
  const src = read(path.join('server', 'agent', 'index.js'));
  check('C1a 路由 /tasks/:id/authorize-origin 存在',
    src.indexOf("'/tasks/:id/authorize-origin'") >= 0);
  check('C1b 路由有归属守卫（aiTaskGuarded）',
    /authorize-origin[\s\S]{0,400}aiTaskGuarded/.test(src));
  check('C1c 路由有审计（ai.task.authorize_origin）',
    /authorize-origin[\s\S]{0,900}ai\.task\.authorize_origin/.test(src));
  check('C1d 审计 detail 只含 origin/resumed（不落凭据值）',
    /ai\.task\.authorize_origin[\s\S]{0,200}\{ origin: r\.origin, resumed: r\.resumed \}/.test(src));

  // C2 taskManager 导出
  check('C2 taskManager 导出 authorizeOrigin',
    typeof taskManager.authorizeOrigin === 'function');

  // C3 前端红线锚：授权范围 = 域未授权族三码；挑战页/无 origin 上下文绝不入集合
  const td = read(path.join('client', 'src', 'components', 'TaskDetail.jsx'));
  const m = td.match(/ORIGIN_BLOCK_REASONS = \[([^\]]*)\]/);
  check('C3a 前端授权范围 = 三码闭集',
    !!m && m[1].indexOf('ORIGIN_NOT_AUTHORIZED') >= 0
    && m[1].indexOf('THIRD_PARTY_AUTH_SURFACE_UNAUTHORIZED') >= 0
    && m[1].indexOf('CROSS_ORIGIN_FRAME') >= 0,
    m ? m[1] : 'NOT FOUND');
  check('C3b 挑战页不入授权集合（SECURITY_CHALLENGE 零出现）',
    !m || m[1].indexOf('SECURITY_CHALLENGE') < 0);
  check('C3c 无 origin 上下文不入授权集合',
    !m || m[1].indexOf('NO_ORIGIN_CONTEXT') < 0 && m[1].indexOf('PAGE_ORIGIN_UNKNOWN') < 0);

  // C4 前端消费 securityBlocks（自动来源）
  check('C4a 前端聚合 securityBlocks（CREDENTIAL_ACTION_BLOCKED）',
    td.indexOf('CREDENTIAL_ACTION_BLOCKED') >= 0 && td.indexOf('securityBlocks') >= 0);
  check('C4b 前端调用授权 API（aiAuthorizeOrigin）',
    td.indexOf('api.aiAuthorizeOrigin') >= 0);

  // C5 api.js 客户端函数
  const api = read(path.join('client', 'src', 'api.js'));
  check('C5 api.js 暴露 aiAuthorizeOrigin',
    /aiAuthorizeOrigin:\s*\(id,\s*origin,\s*resume\)/.test(api)
    && api.indexOf("'/ai/tasks/' + id + '/authorize-origin'") >= 0);
}

// ─────────────────────────────────────────────────────────────
console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
if (fail > 0) { process.exitCode = 1; }
try { fs.rmSync(process.env.FPB_DATA_DIR, { recursive: true, force: true }); } catch (e) { /* tmp 清理尽力而为 */ }
process.exit(fail > 0 ? 1 : 0);
