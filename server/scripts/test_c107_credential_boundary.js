'use strict';
/**
 * PHASE 17-A / P0-A —— Credential Safety Boundary 契约守护（零浏览器）。
 *
 * 覆盖用户给定的 A1–A8：
 *   A1 同 origin 允许 / A2 跨注册域未授权禁止 / A3 第三方 OAuth 面禁止 /
 *   A4 同源 iframe 允许 / A5 跨 origin iframe 默认禁止 / A6 导航后旧授权不继承 /
 *   A7 授权上下文缺失 fail closed / A8 挑战页禁止凭据动作。
 *
 * 另含两条静态断言：
 *   S1 模块内不得出现任何具体站点名字面量（禁止站点白名单/黑名单方案）；
 *   S2 tools.js 的 fill 分支必须在**任何解析/观察之前**调用授权闸。
 */

const fs = require('fs');
const path = require('path');
const ca = require('../agent/credentialAuthorization');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + detail); }
}

const ORIGIN_A = 'https://shop.example.com';
const ORIGIN_B = 'https://accounts.example.org';
const ORIGIN_C = 'https://auth.provider.test';

function task(targetUrl, decl) {
  return { id: 'task_x', targetUrl, credentialAuthorization: decl || null };
}
function ctxFor(targetUrl, decl, exec) {
  return ca.createContext({ task: task(targetUrl, decl), executionId: exec || 'exe_1' });
}

// ── 基础：凭据动作识别 ────────────────────────────────────────────────
check('B1 field=password 属凭据动作', ca.isCredentialAction({ type: 'fill', target: { field: 'password' } }) === true);
check('B2 field=email 属凭据动作', ca.isCredentialAction({ type: 'fill', target: { field: 'email' } }) === true);
check('B3 credentialRef 属凭据动作', ca.isCredentialAction({ type: 'fill', target: { credentialRef: 'c1' } }) === true);
check('B4 login 动作类型属凭据动作', ca.isCredentialAction({ type: 'login', target: {} }) === true);
check('B5 field=search 非凭据动作（不得误伤）', ca.isCredentialAction({ type: 'fill', target: { field: 'search' } }) === false);
check('B6 复合键 billing.card 属凭据动作', ca.isCredentialAction({ type: 'fill', target: { field: 'billing.card' } }) === true);

// ── 基础：第三方授权面识别（通用协议特征，与域名无关）────────────────
check('C1 /login?client_id&return_to=...oauth/authorize 判定为授权面',
  ca.isThirdPartyAuthSurface({ url: ORIGIN_C + '/login?client_id=abc&return_to=%2Flogin%2Foauth%2Fauthorize' }) === true);
check('C2 /oauth2/authorize 判定为授权面',
  ca.isThirdPartyAuthSurface({ url: ORIGIN_C + '/oauth2/authorize?response_type=code&scope=openid' }) === true);
check('C3 普通页面不判为授权面',
  ca.isThirdPartyAuthSurface({ url: ORIGIN_A + '/signup?plan=pro' }) === false);

// ── A1 同 origin 允许 ────────────────────────────────────────────────
{
  const ctx = ctxFor(ORIGIN_A + '/landing');
  const v = ca.authorize({ context: ctx, pageUrl: ORIGIN_A + '/signup', action: { type: 'fill', target: { field: 'email' } } });
  check('A1 同 origin 凭据 fill 允许', v.allowed === true, 'reason=' + v.reason);
}

// ── A2 跨注册域（无显式授权）→ 禁止 ──────────────────────────────────
{
  const ctx = ctxFor(ORIGIN_A + '/landing');
  const v = ca.authorize({ context: ctx, pageUrl: ORIGIN_B + '/signup', action: { type: 'fill', target: { field: 'email' } } });
  check('A2 跨注册域未授权 → 禁止', v.allowed === false && v.reason === 'ORIGIN_NOT_AUTHORIZED', 'reason=' + v.reason);
  check('A2b 拒绝证据点明「不继承授权」', (v.evidence || []).join(' ').indexOf('不继承') >= 0, JSON.stringify(v.evidence));
}
// A2 强化：字符串包含 ≠ 授权（"barfoo.com" 以 "foo.com" 结尾，旧子域包含判据会误放行）
{
  const ctx = ctxFor('https://foo.com/landing');
  const v = ca.authorize({ context: ctx, pageUrl: 'https://barfoo.com/signup', action: { type: 'fill', target: { field: 'email' } } });
  check('A2c 域名字符串包含不产生授权（barfoo.com ⊃ foo.com 仍拒绝）', v.allowed === false, 'reason=' + v.reason);
}

// ── A3 第三方 OAuth 面 → 禁止；显式授权该 provider → 允许 ─────────────
{
  const ctx = ctxFor(ORIGIN_A + '/landing');
  const url = ORIGIN_C + '/login?client_id=abc&return_to=%2Flogin%2Foauth%2Fauthorize';
  const v = ca.authorize({ context: ctx, pageUrl: url, action: { type: 'fill', target: { field: 'email' } } });
  check('A3 第三方授权面 → 禁止', v.allowed === false && v.reason === 'THIRD_PARTY_AUTH_SURFACE_UNAUTHORIZED', 'reason=' + v.reason);
  const ctx2 = ctxFor(ORIGIN_A + '/landing', { allowedOAuthProviders: ['auth.provider.test'] });
  const v2 = ca.authorize({ context: ctx2, pageUrl: url, action: { type: 'fill', target: { field: 'email' } } });
  check('A3b 任务显式授权该 provider → 允许', v2.allowed === true, 'reason=' + v2.reason);
}

// ── A4 同源 iframe 允许 / A5 跨 origin iframe 默认禁止 ────────────────
{
  const ctx = ctxFor(ORIGIN_A + '/landing');
  const v = ca.authorize({
    context: ctx, pageUrl: ORIGIN_A + '/signup', elementOrigin: ORIGIN_A,
    action: { type: 'fill', target: { field: 'password' } },
  });
  check('A4 同源 iframe 允许', v.allowed === true, 'reason=' + v.reason);
}
{
  const ctx = ctxFor(ORIGIN_A + '/landing');
  const v = ca.authorize({
    context: ctx, pageUrl: ORIGIN_A + '/signup', elementOrigin: ORIGIN_C,
    action: { type: 'fill', target: { field: 'password' } },
  });
  check('A5 跨 origin iframe → 禁止', v.allowed === false && v.reason === 'CROSS_ORIGIN_FRAME', 'reason=' + v.reason);
}

// ── A6 导航后旧运行期授权不继承 ──────────────────────────────────────
{
  const ctx = ctxFor(ORIGIN_A + '/landing', { authorizeFlowTransitions: true });
  const v1 = ca.authorize({ context: ctx, pageUrl: ORIGIN_B + '/signup', action: { type: 'fill', target: { field: 'email' } } });
  check('A6a 任务开启流程跳转授权时，新域被授予', v1.allowed === true, 'reason=' + v1.reason);
  const v2 = ca.authorize({ context: ctx, pageUrl: ORIGIN_C + '/signup', action: { type: 'fill', target: { field: 'email' } } });
  check('A6b 再导航到下一域 → 旧授权已清空 → 重新评估且新域需重新授权',
    v2.allowed === true && (v2.evidence || []).indexOf('flow_transition_auto_granted') >= 0, JSON.stringify(v2.evidence));
  // 严格默认（未开流程跳转授权）下，任何非显式授权域都不放行
  const ctx2 = ctxFor(ORIGIN_A + '/landing');
  ca.authorize({ context: ctx2, pageUrl: ORIGIN_B + '/signup', action: { type: 'fill', target: { field: 'email' } } });
  const v3 = ca.authorize({ context: ctx2, pageUrl: ORIGIN_C + '/signup', action: { type: 'fill', target: { field: 'email' } } });
  check('A6c 严格默认下跨域一律拒绝（无遗留授予）', v3.allowed === false, 'reason=' + v3.reason);
}

// ── A7 授权上下文缺失 → fail closed ──────────────────────────────────
{
  const v = ca.authorize({ context: null, pageUrl: ORIGIN_A, action: { type: 'fill', target: { field: 'email' } } });
  check('A7a 无授权上下文 → fail closed', v.allowed === false && v.reason === 'AUTHORIZATION_CONTEXT_MISSING', 'reason=' + v.reason);
  const ctx = ca.createContext({ task: { id: 't', targetUrl: '' }, executionId: 'e' });
  const v2 = ca.authorize({ context: ctx, pageUrl: ORIGIN_A, action: { type: 'fill', target: { field: 'email' } } });
  check('A7b targetUrl 缺失 → fail closed', v2.allowed === false && v2.reason === 'AUTHORIZATION_CONTEXT_MISSING', 'reason=' + v2.reason);
  const ctx3 = ctxFor(ORIGIN_A + '/landing');
  // C107 修正：浏览器初始页 about:blank / launch 欢迎页 data: 的 location.origin 恒为 "null"，
  // 与「origin 真的解析不出来」是不同的失败语义 —— 前者是「尚未进入任何站点」（先导航即可恢复），
  // 后者是「无法证明授权」。二者都必须 fail closed，但归因必须可区分，
  // 否则正常任务第一步凭据 fill 会被误报为「该域未授权」（C107 B 类缺陷）。
  const v3 = ca.authorize({ context: ctx3, pageUrl: '', action: { type: 'fill', target: { field: 'email' } } });
  check('A7c 空 URL（尚未进入文档）→ fail closed 且归因=NO_ORIGIN_CONTEXT',
    v3.allowed === false && v3.reason === 'NO_ORIGIN_CONTEXT', 'reason=' + v3.reason);
  const v3b = ca.authorize({ context: ctx3, pageUrl: 'about:blank', action: { type: 'fill', target: { field: 'email' } } });
  check('A7c2 about:blank → fail closed 且归因=NO_ORIGIN_CONTEXT',
    v3b.allowed === false && v3b.reason === 'NO_ORIGIN_CONTEXT', 'reason=' + v3b.reason);
  const v3c = ca.authorize({
    context: ctx3,
    pageUrl: 'data:text/html;charset=utf-8,%3Ch1%3Ewelcome%3C%2Fh1%3E',
    action: { type: 'fill', target: { field: 'email' } },
  });
  check('A7c3 data: 欢迎页（产品 launch 首屏）→ fail closed 且归因=NO_ORIGIN_CONTEXT',
    v3c.allowed === false && v3c.reason === 'NO_ORIGIN_CONTEXT', 'reason=' + v3c.reason);
  // 真正不可解析的 origin（相对路径 / 非绝对 URL）必须仍走 PAGE_ORIGIN_UNKNOWN，
  // 不得被「无 origin 上下文」吞掉（否则会掩盖授权判定失败）。
  const v3d = ca.authorize({ context: ctx3, pageUrl: '/relative/path', action: { type: 'fill', target: { field: 'email' } } });
  check('A7c4 相对路径（origin 真不可解析）→ PAGE_ORIGIN_UNKNOWN（不得误归因）',
    v3d.allowed === false && v3d.reason === 'PAGE_ORIGIN_UNKNOWN', 'reason=' + v3d.reason);
  // fail closed 不得误伤非凭据动作
  const v4 = ca.authorize({ context: null, pageUrl: ORIGIN_A, action: { type: 'fill', target: { field: 'search' } } });
  check('A7d 非凭据动作不受 fail closed 影响', v4.allowed === true, 'reason=' + v4.reason);
}

// ── A8 挑战页 → 禁止 ─────────────────────────────────────────────────
{
  const ctx = ctxFor(ORIGIN_A + '/landing');
  const v = ca.authorize({
    context: ctx, pageUrl: ORIGIN_A + '/signup', action: { type: 'fill', target: { field: 'email' } },
    challenge: { blocked: true, vendor: 'perimeterx' },
  });
  check('A8 挑战页 → 禁止凭据动作', v.allowed === false && v.reason === 'SECURITY_CHALLENGE', 'reason=' + v.reason);
}

// ── S1/S2 静态断言 ───────────────────────────────────────────────────
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'credentialAuthorization.js'), 'utf8');
  const banned = ['webflow', 'github', 'google.com', 'apple.com'];
  const hits = banned.filter((w) => src.toLowerCase().indexOf(w) >= 0);
  check('S1 授权模块无站点名字面量（禁止站点白/黑名单方案）', hits.length === 0, 'hits=' + JSON.stringify(hits));
  check('S1b 授权模块不含 includes 式同站判据',
    src.indexOf('endsWith(\'.\'') < 0 && src.indexOf('isSameSite') < 0, '旧子域包含判据残留');
}
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'tools.js'), 'utf8');
  const iFill = src.indexOf("case 'fill': {");
  const iGate = src.indexOf('guardCredentialAction(action, page, meta)', iFill);
  const iInspect = src.indexOf('fill.inspect', iFill);
  check('S2a fill 分支内部存在授权闸调用', iFill >= 0 && iGate > iFill, 'gate=' + iGate + ' fill=' + iFill);
  check('S2b 授权闸在观察/解析之前（不得先落值再判）', iGate < iInspect, 'gate=' + iGate + ' inspect=' + iInspect);
  check('S2c 拒绝码为 CREDENTIAL_ACTION_BLOCKED', src.indexOf("'CREDENTIAL_ACTION_BLOCKED'") >= 0);
  check('S2d 跨 origin iframe 第二道闸存在', src.indexOf('elementDocumentOrigin(page, sel.selector)') >= 0);
}

console.log('\n=== 结果: ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail === 0 ? 0 : 1);
