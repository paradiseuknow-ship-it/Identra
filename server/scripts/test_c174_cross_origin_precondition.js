'use strict';

// C174 守护：跨域闸门（CROSS_ORIGIN_DRIFT）的**适用前提** —— 「动作确实执行过」。
//
// 现场（真实任务 task_mv2iow71s3id5，2026-10-10 15:01，新环境 01；逐字取自 aiEvents/aiAttempts）：
//   step_003 click{Get Started} 判据 url_contains "/signup" —— 首次 after 观察仍读到联盟落点
//     https://www.spocket.co/?...ps_partner_key=Y29ydG5leXBlcnJ5NjQ0Nw... ，
//     验证窗口 250ms 后重观察才拿到 app.spocket.co/signup ⇒ 步成功（C172 面已通）。
//   step_004 fill{field:'email'} 紧接着执行，被 contextGuard 以 CONTEXT_NOT_READY 拦下
//     （durationMs=13，**动作零执行**；当时新文档仍在渲染，可见文本为空 ⇒ 分类 BLANK）。
//   derive() 随后命中「host 不一致」（app.spocket.co ≠ 任务入口 sonymaxweb.com）⇒
//     CROSS_ORIGIN_DRIFT（POLICY: escalate=true, noRepair=true, maxRepeats=0）
//     ⇒ 27.3s wait 后仍 HUMAN_ESCALATION。整条链路是「目录站 → 联盟链接 → 目标站」的
//     两跳结构，任务 objective 已显式声明 —— 属合法流程。
//
// 本守护钉住五件事（全程离线：纯函数调用，不起浏览器、不触任何站点）：
//   ① 前置拦截（动作零执行）**不再**被推导成跨域漂移，且**不升级人工**；
//   ② 执行后失败（VERIFY_FAILED / TOOL_EXECUTION / ELEMENT_NOT_FOUND …）**仍然**升级人工（零放宽）；
//   ③ C155 的只读豁免语义、挑战页优先级、非跨域基线一律保持；
//   ④ fail-closed 边界（静态）：豁免集合只能是 contextGuard 前置拦截码，且不得混入执行后失败码；
//   ⑤ revert 咬：把判据还原成旧形态（不带前提）后，①组现场必须变红 —— 证明①有分辨力。
//
// 运行：node server/scripts/test_c174_cross_origin_precondition.js

const os = require('os');
const path = require('path');
const fs = require('fs');

// C140 纪律：夹具一律隔离数据根，绝不写入 server/data（数据根为模块加载期解析）。
process.env.FPB_DATA_DIR = path.join(os.tmpdir(), 'c174_cross_origin_' + Date.now());

const ROOT = path.join(__dirname, '..', '..');
const AGENT = path.join(__dirname, '..', 'agent');
const dd = require(path.join(AGENT, 'diagnosisDecision'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  << ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// ---- 现场逐字参数（跨域发生在「任务入口域」与「真实落点域」之间）----
const LIVE_PAGE_URL = 'https://app.spocket.co/signup';   // 真实落点
const LIVE_TARGET_URL = 'https://sonymaxweb.com';        // 任务入口（targetUrl）

// ⚠️ 观察必须**非空**：derive() 对空观察一律 return null（C105 教训「空集 ≠ 不存在」）。
// 若此处留空，①组的「不产出跨域决策」会因「观察太贫瘠」而**真空绿** —— 与本次修复无关。
// ②组用**同一份**观察仍必须判跨域，正是这一点的对照证明。
const LIVE_OBS = {
  url: LIVE_PAGE_URL,
  networkState: 'idle',
  elements: [
    { tag: 'input', type: 'email', name: 'email', visible: true, bbox: { x: 10, y: 10, w: 200, h: 30 } },
    { tag: 'input', type: 'text', name: 'name', visible: true, bbox: { x: 10, y: 50, w: 200, h: 30 } },
    { tag: 'button', role: 'button', text: 'Get Started', visible: true, bbox: { x: 10, y: 90, w: 200, h: 30 } },
  ],
};

const LIVE_ACTION = { type: 'fill', target: { semantic: 'Email address', field: 'email' }, credentialRef: 'cred_mv2iow74wnq1' };
const LIVE_ERROR = { code: 'CONTEXT_NOT_READY', message: '页面未就绪（空白页/SPA 未挂载），动作 fill 需目标元素，阻止执行（E2）' };

function verdict(errorCode, action, pageUrl, targetUrl) {
  const dec = dd.derive({
    error: errorCode ? { code: errorCode } : LIVE_ERROR,
    observation: LIVE_OBS,
    action: action || LIVE_ACTION,
    pageUrl: pageUrl || LIVE_PAGE_URL,
    targetUrl: targetUrl || LIVE_TARGET_URL,
  });
  const blocked = dec ? dd.isActionBlocked(dec, action || LIVE_ACTION) : false;
  const pol = dec ? dd.evaluate({ decision: dec, action: action || LIVE_ACTION }) : null;
  return { state: dec ? dec.state : null, blocked, escalate: pol ? pol.escalate : false, require: pol ? pol.require : null };
}

// ⚠️ 旧判据的忠实重建（改动前形态：只看 host 差异 + 动作是否凭据类，**不看失败语义**）。
// 用途：证明①组的断言有分辨力 —— 同一现场在旧判据下**必然**产出跨域漂移。
function legacyDerive(errorCode, action, pageUrl, targetUrl) {
  const act = action || LIVE_ACTION;
  const pageUrlStr = pageUrl || LIVE_PAGE_URL;
  const targetUrlStr = targetUrl || LIVE_TARGET_URL;
  const hostOf = (u) => { try { return new URL(u).hostname; } catch (e) { return null; } };
  const ph = hostOf(pageUrlStr);
  const th = hostOf(targetUrlStr);
  if (ph && th && ph !== th) {
    const cred = dd.isCredentialTransmit(act);
    return { state: dd.STATES.CROSS_ORIGIN_DRIFT, cred };
  }
  return { state: null, cred: false };
}

async function main() {
  const GUARD_SRC = stripComments(read('server/agent/contextGuard.js'));
  const DD_SRC = stripComments(read('server/agent/diagnosisDecision.js'));

  // ─────────────────────────────────────────────────────────────
  section('A. 前置拦截（动作零执行）⇒ 不得推导成跨域漂移，且不得升级人工');

  const a1 = verdict('CONTEXT_NOT_READY');
  ok('A1 CONTEXT_NOT_READY + 跨域 + 凭据动作 ⇒ 不产出 CROSS_ORIGIN_DRIFT',
    a1.state !== dd.STATES.CROSS_ORIGIN_DRIFT, a1);
  ok('A2 同上 ⇒ 不阻塞该动作', a1.blocked === false, a1);
  ok('A3 同上 ⇒ 不升级人工（escalate=false）', a1.escalate === false, a1);

  const a4 = verdict('CONTEXT_WRONG_APP');
  ok('A4 CONTEXT_WRONG_APP + 跨域 + 凭据动作 ⇒ 同为动作前拦截，不产出跨域漂移',
    a4.state !== dd.STATES.CROSS_ORIGIN_DRIFT, a4);
  ok('A5 同上 ⇒ 不升级人工', a4.escalate === false, a4);

  const a6 = verdict(null); // 现场逐字错误对象
  ok('A6 用现场逐字 error 对象（含 message）⇒ 同样不产出跨域漂移',
    a6.state !== dd.STATES.CROSS_ORIGIN_DRIFT, a6);

  // ─────────────────────────────────────────────────────────────
  section('B. 执行后失败 ⇒ 跨域漂移仍必须成立（零放宽，安全边界不动）');

  for (const code of ['VERIFY_FAILED', 'TOOL_EXECUTION', 'ELEMENT_NOT_FOUND', 'ELEMENT_NOT_INTERACTABLE', 'BROWSER_TIMEOUT']) {
    const v = verdict(code);
    ok('B. ' + code + ' + 跨域 + 凭据动作 ⇒ 仍判 CROSS_ORIGIN_DRIFT',
      v.state === dd.STATES.CROSS_ORIGIN_DRIFT, v);
    ok('B. ' + code + ' ⇒ 仍阻塞且升级人工',
      v.blocked === true && v.escalate === true, v);
  }

  // B9：形状异常（error 存在但无 code）⇒ 默认 fail-closed，**不得**被豁免集合放过。
  // ⚠️ 不能经 verdict('') 走 —— 那里空串是 falsy，会退化成现场错误对象（夹具歧义）。
  const b9dec = dd.derive({ error: {}, observation: LIVE_OBS, action: LIVE_ACTION, pageUrl: LIVE_PAGE_URL, targetUrl: LIVE_TARGET_URL });
  const b9pol = b9dec ? dd.evaluate({ decision: b9dec, action: LIVE_ACTION }) : null;
  ok('B9 错误码缺失（形状异常）⇒ fail-closed，仍判跨域漂移并升级人工',
    !!b9dec && b9dec.state === dd.STATES.CROSS_ORIGIN_DRIFT && !!b9pol && b9pol.escalate === true,
    b9dec && b9dec.state);

  // ─────────────────────────────────────────────────────────────
  section('C. C155 语义保持：只读观察动作不因跨域被拦');

  const readonly = { type: 'inspect', target: { semantic: '邮箱输入框', field: 'email' } };
  const c1 = verdict('VERIFY_FAILED', readonly);
  ok('C1 只读 inspect + 跨域 ⇒ 不阻塞', c1.blocked === false, c1);
  ok('C2 同上 ⇒ 不升级人工', c1.escalate === false, c1);
  ok('C3 isCredentialTransmit 对观察类动作仍为 false',
    dd.isCredentialTransmit({ type: 'inspect', target: { semantic: 'x', field: 'email' } }) === false, '');
  ok('C4 观察类动作即便携带 credentialRef 仍按凭据类处理（异常形状 fail-closed）',
    dd.isCredentialTransmit({ type: 'inspect', target: { semantic: 'x', credentialRef: 'c' } }) === true, '');

  // ─────────────────────────────────────────────────────────────
  section('D. 非跨域基线（改动前后必须一致）');

  for (const code of ['CONTEXT_NOT_READY', 'VERIFY_FAILED', 'ELEMENT_NOT_FOUND']) {
    const v = verdict(code, null, 'https://sonymaxweb.com/listing', 'https://sonymaxweb.com');
    ok('D. ' + code + ' + 同 host ⇒ 不产出跨域漂移',
      v.state !== dd.STATES.CROSS_ORIGIN_DRIFT && v.escalate === false, v);
  }
  const d4 = dd.derive({ error: { code: 'VERIFY_FAILED' }, observation: LIVE_OBS, action: LIVE_ACTION, pageUrl: 'not-a-url', targetUrl: LIVE_TARGET_URL });
  ok('D4 pageUrl 不可解析 ⇒ 不产出跨域漂移（宁可不下结论）',
    !d4 || d4.state !== dd.STATES.CROSS_ORIGIN_DRIFT, d4 && d4.state);

  // ─────────────────────────────────────────────────────────────
  section('E. 挑战页优先级保持（不受新前提影响）');

  const e1 = dd.derive({
    error: LIVE_ERROR, observation: LIVE_OBS, action: LIVE_ACTION,
    pageUrl: LIVE_PAGE_URL, targetUrl: LIVE_TARGET_URL, challenge: { blocked: true },
  });
  ok('E1 挑战页 + CONTEXT_NOT_READY ⇒ 仍判 SECURITY_CHALLENGE',
    !!e1 && e1.state === dd.STATES.SECURITY_CHALLENGE, e1 && e1.state);

  // ─────────────────────────────────────────────────────────────
  section('F. fail-closed 边界（静态断言：豁免集合的形状与来源）');

  const set = dd.PRECLUDED_EXECUTION_CODES;
  ok('F1 豁免集合已导出且非空', set instanceof Set && set.size > 0, set && set.size);

  // F2：集合成员必须是 contextGuard 源码里真实产出过的 block code（防止「凭空造码」）
  const guardCodes = new Set();
  const reBlock = /block\(\s*'([A-Z_]+)'/g;
  let m;
  while ((m = reBlock.exec(GUARD_SRC)) !== null) guardCodes.add(m[1]);
  ok('F2 contextGuard 源码可提取到 block code（夹具前提）', guardCodes.size > 0, [...guardCodes]);
  let allFromGuard = true;
  const strangers = [];
  for (const c of set) { if (!guardCodes.has(c)) { allFromGuard = false; strangers.push(c); } }
  ok('F3 豁免集合的每个成员都必须是 contextGuard 实际产出的前置拦截码', allFromGuard, strangers);
  ok('F4 前置拦截集合必须包含 CONTEXT_NOT_READY', set.has('CONTEXT_NOT_READY'), [...set]);

  // F5：豁免集合**不得**混入任何「执行后失败」码（安全边界）
  const EXEC_FAILED = ['VERIFY_FAILED', 'TOOL_EXECUTION', 'ELEMENT_NOT_FOUND', 'ELEMENT_NOT_INTERACTABLE',
    'BROWSER_TIMEOUT', 'BROWSER_CONTEXT_LOST', 'OBSERVATION_FAILED', 'SELECTOR_STALE', 'ELEMENT_CHANGED',
    'CREDENTIAL_ACTION_BLOCKED', 'AUTHORIZATION_BLOCKED'];
  const leaked = EXEC_FAILED.filter((c) => set.has(c));
  ok('F5 豁免集合不得混入任何执行后失败码', leaked.length === 0, leaked);

  // F6：位置唯一性 —— 该前提在生产代码里只有一处使用
  const uses = (DD_SRC.match(/PRECLUDED_EXECUTION_CODES\.has\(/g) || []).length;
  ok('F6 该前提在 diagnosisDecision.js 里只有一处使用（唯一实现）', uses === 1, uses);
  const defs = (DD_SRC.match(/const PRECLUDED_EXECUTION_CODES\s*=/g) || []).length;
  ok('F7 该集合只有一处定义', defs === 1, defs);

  // F8：只读动作仍先于跨域判定放行（isCredentialTransmit 的调用仍在）
  ok('F8 跨域判定仍委托 isCredentialTransmit（唯一口径）',
    /isCredentialTransmit\(action\)/.test(DD_SRC), '');

  // ─────────────────────────────────────────────────────────────
  section('G. revert 咬：旧判据（不看失败语义）在同一现场必须变红');

  const g1 = legacyDerive('CONTEXT_NOT_READY');
  ok('G1 旧判据对 CONTEXT_NOT_READY 现场**必然**产出跨域漂移 ⇒ 证明 A 组有分辨力',
    g1.state === dd.STATES.CROSS_ORIGIN_DRIFT, g1);
  ok('G2 旧判据对该动作判为凭据类（故旧行为会升级人工）', g1.cred === true, g1);

  const g3 = legacyDerive('VERIFY_FAILED');
  ok('G3 新判据与旧判据在「执行后失败」上结论一致（未误伤安全边界）',
    g3.state === dd.STATES.CROSS_ORIGIN_DRIFT && verdict('VERIFY_FAILED').state === dd.STATES.CROSS_ORIGIN_DRIFT, g3);

  // ─────────────────────────────────────────────────────────────
  section('H. 端到端：现场完整决策链与修复前对比');

  const before = { state: g1.state, escalate: dd.evaluate({ decision: { state: dd.STATES.CROSS_ORIGIN_DRIFT, credentialOnly: true, blockedActions: [dd.blockKeyOf(LIVE_ACTION)] }, action: LIVE_ACTION }).escalate };
  const after = verdict('CONTEXT_NOT_READY');
  ok('H1 修复前：CONTEXT_NOT_READY 现场 ⇒ CROSS_ORIGIN_DRIFT + escalate（任务被终端升级）',
    before.state === dd.STATES.CROSS_ORIGIN_DRIFT && before.escalate === true, before);
  ok('H2 修复后：同一现场 ⇒ 无跨域决策、无升级 ⇒ 交既有重试链路（等待 + 重新观察）',
    after.state !== dd.STATES.CROSS_ORIGIN_DRIFT && after.escalate === false, after);
  ok('H3 修复只改变「动作零执行」这一类，执行后失败仍是终端升级（对照）',
    verdict('VERIFY_FAILED').escalate === true, verdict('VERIFY_FAILED'));

  console.log('\n结果: ' + pass + ' passed / ' + fail + ' failed');
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error('测试异常:', e); process.exit(1); });
