'use strict';
// C106 F16 — field 权威校验【零浏览器契约守护】。
//
// 真实站点实证（Webflow 注册 task_mtuqje3txasfd）：
//   fill {semantic:'email', field:'password'} → 值被写进 email 框并判 SUCCESS。
// 对 write 类动作，「写错字段」比「找不到字段」危险得多：前者污染站点数据、
// 验证常常看不见，后者至少走恢复链。故 field 存在且与 semantic 不等价时，
// 候选元素必须自带 field 证据（属性命中 field token，或 input type 语义等价）。
//
// 本文件锁定三条边界：
//   P1 fieldMatchesElement 的接受/拒绝边界（含 type 等价通道与负例）
//   P2 fieldSemanticEquivalent 的豁免边界（避免误伤 {semantic:'Password', field:'password'}）
//   P3 整类守卫：F16 不得把 field 校验放宽到「任意可填字段」

const sr = require('../agent/semanticResolver');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('✅ PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('❌ FAIL | ' + name + ' | ' + detail); }
}

const el = (o) => Object.assign({ tag: 'input', type: 'text' }, o);

// ---------- P1 fieldMatchesElement ----------
check('P1.1 field=password 命中 name=password', sr.fieldMatchesElement('password', el({ name: 'password' })) === true);
check('P1.2 field=password 命中 id=new-password（包含）', sr.fieldMatchesElement('password', el({ id: 'new-password' })) === true);
check('P1.3 field=password 命中 type=password（type 等价通道）', sr.fieldMatchesElement('password', el({ type: 'password', name: 'x' })) === true);
check('P1.4 field=password 命中 placeholder="Password"', sr.fieldMatchesElement('password', el({ placeholder: 'Password' })) === true);
check('P1.5 field=email 命中 type=email', sr.fieldMatchesElement('email', el({ type: 'email', name: 'x' })) === true);
check('P1.6 field=password 拒绝 email 输入框（F16 核心负例）',
  sr.fieldMatchesElement('password', el({ name: 'email', id: 'email', type: 'email', placeholder: 'Email', text: 'Email' })) === false);
check('P1.7 field=password 拒绝无 field 证据的通用输入框',
  sr.fieldMatchesElement('password', el({ name: 'q', id: 'q' })) === false);
check('P1.8 field 缺失 → false（不启用校验）', sr.fieldMatchesElement(null, el({ name: 'password' })) === false);
check('P1.9 el 缺失 → false', sr.fieldMatchesElement('password', null) === false);

// ---------- P2 fieldSemanticEquivalent（豁免边界） ----------
check('P2.1 password/Password 等价（大小写归一）', sr.fieldSemanticEquivalent('password', 'Password') === true);
check('P2.2 password/注册密码输入框 不等价', sr.fieldSemanticEquivalent('password', '注册密码输入框') === false);
check('P2.3 password/email 不等价（必须启用强校验）', sr.fieldSemanticEquivalent('password', 'email') === false);
check('P2.4 semantic 缺失 → false', sr.fieldSemanticEquivalent('password', null) === false);
check('P2.5 field 缺失 → false', sr.fieldSemanticEquivalent(null, 'email') === false);

// ---------- P3 整类守卫 ----------
check('P3.1 FIELD_TYPE_EQUIV 覆盖 password/email/tel/url',
  sr.FIELD_TYPE_EQUIV.password === 'password' && sr.FIELD_TYPE_EQUIV.email === 'email'
  && sr.FIELD_TYPE_EQUIV.tel === 'tel' && sr.FIELD_TYPE_EQUIV.url === 'url');
check('P3.2 FIELD_TYPE_EQUIV 不把任意字段映射到可填通配（不得放宽到 submit/button）',
  !Object.values(sr.FIELD_TYPE_EQUIV).includes('submit') && !Object.values(sr.FIELD_TYPE_EQUIV).includes('button'));
check('P3.3 fieldMatchesElement 对 button 元素返回 false（write 目标不应是按钮）',
  sr.fieldMatchesElement('password', { tag: 'button', role: 'button', text: 'Password' }) === false);

console.log(`\n=== C106 F16 零浏览器契约: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
