'use strict';

/**
 * C155 守护 —— 跨域漂移闸门对「只读观察动作」的误分类
 *
 * 真实缺陷（用户联盟漏斗实测，非推断）：
 *   Planner 产出只读观察步 { type:'inspect', target:{ semantic:'邮箱输入框', field:'email' } }
 *   → credentialAuthorization.isCredentialAction() 仅按 field ∈ CREDENTIAL_FIELDS（'email' 在
 *     词表内）判定，**不看动作类型** → 判为「凭据类」
 *   → CROSS_ORIGIN_DRIFT 的 credentialOnly 守卫失效 → 该只读步被 BLOCK
 *   → POLICY.escalate=true → 任务 25s 直接 HUMAN_ESCALATION。
 *
 * 实测现场（C155，profile=p_phase23_mu3amqhd，targetUrl=https://sonymaxweb.com）：
 *   步1 click「Try Spocket →」SUCCESS → 落点 www.spocket.co（归因参数完整）
 *   步2 inspect → host 漂移 → error="诊断决策 CROSS_ORIGIN_DRIFT 阻止了当前动作（要求 REAUTH_CONTEXT）"
 *
 * 修复口径：跨域闸门只拦「会把凭据写出到当前域」的动作（isCredentialTransmit，唯一实现）。
 * 双向边界（本守护的核心价值）：
 *   正例 —— 只读观察（inspect/extract/screenshot/getUrl/getTitle/wait）**不再**被拦；
 *   反例 —— fill/click/submit 等写出类动作、未列出的未知类型、带 credentialRef 的动作
 *           **仍然**被拦并升级；credentialAuthorization.isCredentialAction 本体**零改动**。
 *
 * 纪律：本文件不改任何产品语义；断言真正执行的那份实现（require 后调用），不 eval 源码。
 */

// ── 数据根隔离（C140 纪律）：必须在首个 require 之前 ──
const path = require('path');
const os = require('os');
const fs = require('fs');
process.env.FPB_DATA_DIR = path.join(os.tmpdir(), 'c155_cross_origin_' + Date.now());

const ROOT = path.resolve(__dirname, '..', '..');
const dd = require('../agent/diagnosisDecision');
const cred = require('../agent/credentialAuthorization');
const { ACTION_TYPES } = require('../agent/schema/action');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : '')); }
};
const j = (v) => { try { return JSON.stringify(v); } catch (e) { return String(v); } };

// ── 真实形状夹具 ──
const INSPECT_EMAIL = { type: 'inspect', target: { semantic: '邮箱输入框', field: 'email' } };
const FILL_EMAIL = { type: 'fill', target: { semantic: '邮箱输入框', field: 'email' }, value: 'a@b.c' };
const FILL_PASSWORD = { type: 'fill', target: { semantic: '密码输入框', field: 'password' }, value: 'x' };
const CLICK_EMAIL = { type: 'click', target: { semantic: '提交', field: 'email' } };
const UNKNOWN_CRED = { type: 'frobnicate_future_type', target: { semantic: '邮箱', field: 'email' } };
const INSPECT_WITH_REF = { type: 'inspect', target: { semantic: 'observer', credentialRef: 'cred_x' } };
const CLICK_CTA = { type: 'click', target: { semantic: 'Try Spocket →', field: 'Try Spocket →' } };

const DRIFT_OPTS = (action) => ({
  pageUrl: 'https://www.spocket.co/?ps_partner_key=Y29ydG5leXBlcnJ5NjQ0Nw',
  targetUrl: 'https://sonymaxweb.com',
  action,
  observation: null,
});

console.log('\n════ A 组：isCredentialTransmit 动作类型口径（正反双向）════');
ok(dd.isCredentialTransmit(INSPECT_EMAIL) === false,
  'A1 只读 inspect + field=email 不算写出凭据（改前 true ⇒ 误杀根因）', dd.isCredentialTransmit(INSPECT_EMAIL));
ok(Array.isArray(dd.OBSERVE_ACTION_TYPES) && dd.OBSERVE_ACTION_TYPES.length > 0,
  'A2 OBSERVE_ACTION_TYPES 已导出且非空', dd.OBSERVE_ACTION_TYPES);
for (const t of dd.OBSERVE_ACTION_TYPES) {
  ok(dd.isCredentialTransmit({ type: t, target: { field: 'password' } }) === false,
    'A3 观察类 ' + t + ' + field=password 不豁免写出判定', t);
}
ok(dd.isCredentialTransmit(FILL_PASSWORD) === true, 'A4 fill+password 仍算写出凭据');
ok(dd.isCredentialTransmit(FILL_EMAIL) === true, 'A5 fill+email 仍算写出凭据');
ok(dd.isCredentialTransmit(CLICK_EMAIL) === true, 'A6 click+email 仍算写出凭据');
ok(dd.isCredentialTransmit(UNKNOWN_CRED) === true, 'A7 未知动作类型 → fail-closed 仍算写出凭据');
ok(dd.isCredentialTransmit(INSPECT_WITH_REF) === true, 'A8 观察类但带 credentialRef → fail-closed 仍算写出凭据');
ok(dd.isCredentialTransmit(CLICK_CTA) === false, 'A9 普通 CTA click（非凭据字段）不算凭据动作');

console.log('\n════ B 组：闸门裁决（LLM 路径 vs 确定性路径，且两者必须一致）════');
const eLLM = (action) => dd.evaluate({ decision: dd.fromLLM({ state: 'CROSS_ORIGIN_DRIFT', required: 'REAUTH_CONTEXT' }), action });
const eDet = (action) => dd.evaluate({ decision: dd.derive(DRIFT_OPTS(action)), action });

const l1 = eLLM(INSPECT_EMAIL), d1 = eDet(INSPECT_EMAIL);
ok(l1.blocked === false && l1.escalate === false,
  'B1 LLM 路径：跨域只读 inspect 不再被封、不再升级人工（改前 blocked/escalate 双 true）', j(l1));
ok(d1.blocked === false && d1.escalate === false,
  'B2 确定性路径：同上（改前 blockedActions 非空 ⇒ blocked true）', j(d1));
ok(l1.blocked === d1.blocked && l1.escalate === d1.escalate,
  'B3 两条诊断路径对同一动作裁决一致（改前:LLM=block,derive=block 经 credentialOnly 守卫后被绕过）',
  j({ llm: l1.blocked, det: d1.blocked }));

const l2 = eLLM(FILL_PASSWORD), d2 = eDet(FILL_PASSWORD);
ok(l2.blocked === true && l2.escalate === true,
  'B4 反向：跨域 fill password 仍被封且升级人工（闸门未放宽）', j(l2));
ok(d2.blocked === true && d2.escalate === true,
  'B5 反向：确定性路径同上', j(d2));

const l3 = eLLM(FILL_EMAIL), l4 = eLLM(UNKNOWN_CRED), l5 = eLLM(INSPECT_WITH_REF);
ok(l3.blocked === true, 'B6 反向：跨域 fill email 仍被封', j(l3));
ok(l4.blocked === true, 'B7 反向：未知类型带凭据字段仍被封（fail-closed）', j(l4));
ok(l5.blocked === true, 'B8 反向：观察类带 credentialRef 仍被封（fail-closed）', j(l5));

const same = dd.evaluate({ decision: dd.derive({ pageUrl: 'https://sonymaxweb.com/', targetUrl: 'https://sonymaxweb.com', action: INSPECT_EMAIL, observation: null }), action: INSPECT_EMAIL });
ok(same.blocked === false && same.state === null, 'B9 同域场景仍不产出任何结论', j(same));

console.log('\n════ C 组：结构不变量（不得放宽的边界）════');
const srcDD = fs.readFileSync(path.join(ROOT, 'server/agent/diagnosisDecision.js'), 'utf8');
// 去注释后再计数：否则注释里引用的旧实现会被算成真实调用（本守护实测咬出）。
const codeDD = srcDD.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const directCalls = (codeDD.match(/credentialAuthorization\.isCredentialAction\(/g) || []).length;
ok(directCalls === 1,
  'C1 代码面直接调用 credentialAuthorization.isCredentialAction 仅 1 处（= isCredentialTransmit 内部，唯一实现）',
  directCalls);
ok(dd.OBSERVE_ACTION_TYPES.every((t) => typeof t === 'string')
  && dd.isCredentialTransmit({ type: 'getUrl', target: { field: 'password' } }) === false,
  'C1b camelCase 观察类类型大小写匹配正确（getUrl 命中豁免）',
  dd.isCredentialTransmit({ type: 'getUrl', target: { field: 'password' } }));

ok(cred.isCredentialAction(INSPECT_EMAIL) === true,
  'C2 credentialAuthorization.isCredentialAction 本体零改动（17-A 凭据闸未放宽）',
  cred.isCredentialAction(INSPECT_EMAIL));
ok(cred.isCredentialAction(FILL_PASSWORD) === true, 'C3 17-A 口径：fill password 仍为凭据动作');

const pol = dd.POLICY.CROSS_ORIGIN_DRIFT;
ok(pol && pol.credentialOnly === true && pol.escalate === true && pol.noRepair === true,
  'C4 CROSS_ORIGIN_DRIFT 策略未被改动（credentialOnly/escalate/noRepair 保持）', j(pol));

const notInSchema = dd.OBSERVE_ACTION_TYPES.filter((t) => ACTION_TYPES.indexOf(t) < 0);
ok(notInSchema.length === 0,
  'C5 OBSERVE_ACTION_TYPES 全部是 schema 真实动作类型（不发明形状）', j(notInSchema));

const srcGuard = (srcDD.match(/decision\.credentialOnly \|\| pol\.credentialOnly/g) || []).length;
ok(srcGuard === 1, 'C6 credentialOnly 同时读 decision 与 POLICY（LLM 路径也生效）', srcGuard);

console.log('\n════ D 组：对照实现（错误实现必须被本守护咬住）════');
const wrongOldImpl = (action) => cred.isCredentialAction(action);
ok(wrongOldImpl(INSPECT_EMAIL) === true && dd.isCredentialTransmit(INSPECT_EMAIL) === false,
  'D1 被弃用的旧口径（直调 isCredentialAction）会误杀只读步 —— 本守护可分辨',
  j({ old: wrongOldImpl(INSPECT_EMAIL), new: dd.isCredentialTransmit(INSPECT_EMAIL) }));
const wrongNoFailClosed = (action) => dd.OBSERVE_ACTION_TYPES.indexOf(String((action || {}).type || '').toLowerCase()) < 0
  && cred.isCredentialAction(action);
ok(wrongNoFailClosed(INSPECT_WITH_REF) === false && dd.isCredentialTransmit(INSPECT_WITH_REF) === true,
  'D2 去掉 credentialRef fail-closed 的错误实现会放行异常形状 —— 本守护可分辨',
  j({ wrong: wrongNoFailClosed(INSPECT_WITH_REF), right: dd.isCredentialTransmit(INSPECT_WITH_REF) }));

console.log('\n══ 汇总 ══');
console.log('  通过 ' + pass + ' / 失败 ' + fail + '  (共 ' + (pass + fail) + ' 项)');
try { fs.rmSync(process.env.FPB_DATA_DIR, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
