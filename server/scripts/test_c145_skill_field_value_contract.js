'use strict';

// C145 守护：`field_value` 在 Skill 层的「语义接地 + 可判定性」。
//
// ── 本批修的是什么（§A 事实链，全部为实测数据，非推断）────────────────────────
//
// 缺陷：`field_value` 是 schema 注册的 Skill 可观察子句类型
// （skillSchema.OBSERVABLE_TYPES 含它；skillSchema:278 的规范只要求
//  `target` 或 `expect` **二者之一**），也是 fill 步的**权威业务契约**
// （contract.deriveContract('fill') → [{type:'field_value', expect, target}]）。
// 但它在这条链上被**两道死条件**全量拦死：
//
//   ① builder 侧：`clauseFromContract` 对非元素类型只认 `expect`；而真实 fill 步的
//      verification **100% 无 expect**（值由凭据/运行时注入）
//      ⇒ 恒返回 null ⇒ normalizeStep 判 CONTRACT_NOTIDENTIFYING ⇒ **fill 步永不入 Skill**。
//   ② router 侧：`clauseVerdict` 的 field_value 分支把 `clause.expect` 直接串进比较，
//      而 builder 从不透传值 ⇒ `String(val) === 'undefined'` **永假** ⇒ 即便绕过 ①，
//      该子句也**永不 TRUE**（值在场时恒 FALSE、值缺失时才 INDETERMINATE），
//      且 AND 契约下主动判成 MISMATCH —— 比 INDETERMINATE 更糟：既不可判定，又误判为确定不匹配。
//
// 实测危害（改前，可复现）：
//   · 全库步级 verification 中 `field_value` 共 **3951 例**，形状 100% 一致：
//     `{type:'field_value', target:'#email'}`（selector-like、无 expect），
//     `action.target.field` 100% 在场，`action.type` 100% 为 fill。
//   · 176 个真实落盘 Skill（server/data/aiSkill.json）的 action.type **全部只有 submit**，
//     **fill = 0** ⇒ 每个 Skill 都是「LANDING → submit → CONFIRMED」，
//     填表步整段缺失（builder 的 kept.forEach 直接跨过被丢弃的步，
//     transitions 不会补洞）⇒ 回放会跳过填表直接提交，流程结构性残缺。
//   · 与 contract.js:legacyToContract 的 C73 D4 同源（「只透传 type/expect 会丢定位键」）——
//     **那一处已修，这一处漏修**（L6：同一后果面不对称）。
//
// ── 修复方向与边界（报告须逐条对齐）────────────────────────────────────────
//   · 放宽：入集面（fill 步从 0% 入集 → 只要 action.target.field 在场即可入集，实测 3951/3951）；
//           判定面（无 expect 的真实形状在「已填写」时 FALSE→TRUE；其余 4 个探针态未动）。
//   · 收紧：无。
//   · 未动：url_pattern（E6/E7 有意跨层分离）/ url_contains（前置态语义，无 P2）/
//           text_present / element_present / element_absent / verification.js / VIL / schema。
//   · ★ 有界放宽：缺 `action.target.field` 时**仍拒绝**该步 —— 不得为了「让 fill 步入集」
//     而把源 verification 的 CSS 值（真实形态是 `#email`）持久化进 Skill（SEC7）。
//   · ★ 值未知的退化语义有据可依：与 verification.js / VIL 的 field_value 一致
//     （C73 D3：「空期望 = 期望值未知 ⇒ 退化为『已填写』；includes('') 恒真与硬 fail-closed 都不对」）。
//
// ★ 隔离纪律（17-C/17-D 血泪）：必须在 require 任何业务模块**之前**设置 FPB_DATA_DIR，
//   否则 store 落到真实数据目录。

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DIR = path.join(os.tmpdir(), 'c145_field_value_' + Date.now());
try { fs.mkdirSync(TMP_DIR, { recursive: true }); } catch (e) { /* 已存在 */ }
process.env.FPB_DATA_DIR = TMP_DIR;

const builder = require('../agent/skill/skillBuilder.js');
const router = require('../agent/skill/skillRouter.js');
const schema = require('../agent/skill/skillSchema.js');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0;
let fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
function read(rel) {
  return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}
function fnBody(src, name) {
  const m = src.match(new RegExp('function\\s+' + name + '\\b[\\s\\S]*?\\n\\}'));
  return m ? m[0] : '';
}
function j(x) { return JSON.stringify(x); }

// ── 统一夹具：严格对齐真实落盘的形状（不手写「想象中的形状」）────────────────
const ORIGIN = 'https://shop.example.test';
const TASK = {
  id: 'task_c145',
  targetUrl: ORIGIN + '/checkout',
  objective: '填入邮箱并提交订单',
  planGoal: 'fill email and submit order',
  profileId: 'p_c145',
  currentExecutionId: 'exe_c145',
};

// 真实形状：verification = {type:'field_value', target:'#email'}（selector、无 expect）
function step(over) {
  const o = over || {};
  const action = Object.assign({
    type: 'fill',
    target: { field: 'email', semantic: '邮箱输入框' },
    value: null,
    credentialRef: 'cred_c145',
    verification: { type: 'field_value', target: '#email' },
  }, o.action || {});
  return {
    id: o.id || 'step_c145_fill',
    taskId: TASK.id,
    index: o.index == null ? 0 : o.index,
    type: o.type || 'ACT',
    description: o.description || '在邮箱框输入账号邮箱',
    risk: 'LOW',
    status: o.status || 'SUCCESS',
    action: action,
  };
}
function attemptOf(s) {
  return { id: 'att_' + s.id, stepId: s.id, taskId: TASK.id, executionId: TASK.currentExecutionId, status: s.status, startedAt: 1000, endedAt: 2000 };
}
function buildWith(steps) {
  return builder.build({ task: TASK, steps: steps, attempts: steps.map(attemptOf) });
}

// 观察夹具：元素字段名与 skill 的 target.field 语义接地对齐
function el(field, state) {
  return {
    tag: 'input', name: field, id: field, placeholder: '', label: '', ariaLabel: '',
    autocomplete: null, testId: null, text: '', roleText: '', innerText: '',
    visible: true, state: state || {},
  };
}
function obsWith(els) {
  return { url: ORIGIN + '/checkout', loadingState: 'complete', elements: els };
}
const CLAUSE_NO_VALUE = { type: 'field_value', target: { field: 'email' }, weight: 'REQUIRED' };
const AND1 = (c) => ({ observable: [c], logic: 'AND' });

// ── A 组：形状真实性（静态锚定；先剥注释，判据不撞自写注释）──────────────────
console.log('\n── A 组：静态形状锚定（防真空）──');
const BUILDER_SRC = read('server/agent/skill/skillBuilder.js');
const ROUTER_SRC = read('server/agent/skill/skillRouter.js');
let CFC_BODY = '';
{
  CFC_BODY = fnBody(BUILDER_SRC, 'clauseFromContract');
  ok(CFC_BODY.length > 0, 'A1 锚点定位：clauseFromContract 函数体已定位到（锚点失配即红）');

  // A2 正向：field_value 必须与 element_present/absent 同族（同一「需要语义定位键」分支）
  ok(/type === 'element_absent' \|\| type === 'field_value'/.test(CFC_BODY),
    'A2 field_value 与 element_present/absent 走同一份语义接地分支（action.target.field）');

  // A3 正向对照：text/url 类**仍必须**要求 expect（防 A2 收敛后靠删代码达成真空）
  ok(/if \(!expect\) return null;[\s\S]{0,80}?return \{ type, expect, weight: 'REQUIRED' \};/.test(CFC_BODY),
    'A3 正向对照：非定位键类子句（text/url）仍必须提供 expect（不得被一并放宽）');

  // A4 定位符不得成为 Skill 契约的字段来源：clauseFromContract 体内不得读 v.target
  //    （真实数据里源 verification 的 target 是 CSS 选择器 `#email`；SEC7 禁持久化定位符）
  ok(!/v\.target/.test(CFC_BODY),
    'A4 SEC7：clauseFromContract 体内不读 v.target（源 target 在真实数据里是 CSS 选择器）');
}

// ── B 组：真实 builder 调用（不手写模拟）────────────────────────────────────
console.log('\n── B 组：真实 builder.build 行为面 ──');
{
  const s = step({});
  const r = buildWith([s]);
  // ★ 健壮性（自检教训）：build 失败时 r.candidate 为 undefined —— 后续断言必须**干净地 FAIL**，
  //   不得抛异常。否则崩溃会伪装成「小面积红」：其后的 C/D/E/F 组从未执行，看起来只是 B 组红。
  const cand = r.candidate || null;
  const rejected = (r.rejectedSteps || []).map((x) => x.stepId + ':' + x.reason);
  ok(r.ok === true, 'B1a fill 步（真实 field_value 契约形状）可构建出候选', j({ ok: r.ok, reason: r.reason, rejected: rejected }));
  ok(!(r.rejectedSteps || []).some((x) => x.stepId === s.id),
    'B1b 该 fill 步**不再**被拒（改前恒 CONTRACT_NOTIDENTIFYING）', j(rejected));

  const st = (r.candidate && r.candidate.states || []).find((x) => (x.actions || []).some((a) => a.type === 'fill'));
  const cl = st && st.stateContract && st.stateContract.observable[0];
  ok(!!st, 'B1c 产出状态机中含 fill 动作的状态（改前 176 个真实 Skill 的 fill = 0）');
  ok(cl && cl.type === 'field_value' && cl.target && cl.target.field === 'email' && cl.weight === 'REQUIRED',
    'B1d 子句形状 = {type:field_value, target:{field}, weight:REQUIRED}', j(cl));
  ok(cl && cl.expect === undefined,
    'B1e 期望值不在场时不臆造值（子句不带 expect）', j(cl && cl.expect));
  ok(!!cand && j(cand).indexOf('#email') < 0,
    'B1f SEC7 双向咬：产物 blob 不含源 verification 的 CSS 值 "#email"');

  // B2：源 verification 给了 expect ⇒ 必须保留（丢了会把「值判定」降级成「已填写」）
  const s2 = step({ action: { verification: { type: 'field_value', expect: 'a@b.co', target: '#email' } } });
  const r2 = buildWith([s2]);
  const cl2 = ((r2.candidate && r2.candidate.states) || [])
    .flatMap((x) => ((x.stateContract && x.stateContract.observable) || []))
    .find((c) => c.type === 'field_value');
  ok(cl2 && cl2.expect === 'a@b.co' && cl2.target && cl2.target.field === 'email',
    'B2 值在场时保留：{target:{field}, expect:"a@b.co"}（不得丢值）', j(cl2));

  // B3：有界放宽 —— 无 action.target.field ⇒ 仍拒绝（不得退化成持久化 selector）
  const s3 = step({ action: { target: { semantic: '邮箱输入框' }, verification: { type: 'field_value', target: '#email' } } });
  const r3 = buildWith([s3]);
  const rej3 = (r3.rejectedSteps || []).find((x) => x.stepId === s3.id);
  ok(!!rej3 && rej3.reason === 'CONTRACT_NOT_IDENTIFYING',
    'B3 有界放宽：缺 action.target.field 的 fill 步**仍被拒**（不放宽到持久化定位符）', j(rej3));
}

// ── C 组：真实 contractVerdict 判定面（不直调内部函数、不重实现被守护逻辑）────
console.log('\n── C 组：真实 contractVerdict 判定面 ──');
{
  const V = router.CLAUSE_VERDICT;
  const v1 = router.contractVerdict(AND1(CLAUSE_NO_VALUE), obsWith([el('email', { value: 'a@b.co' })]));
  ok(v1.verdict === router.PRESTATE.MATCH,
    'C1 字段已填写 ⇒ MATCH（改前为 FALSE⇒MISMATCH：String(val)==="undefined" 永假）', j(v1.verdict));

  const v2 = router.contractVerdict(AND1(CLAUSE_NO_VALUE), obsWith([el('email', { value: '' })]));
  ok(v2.verdict === router.PRESTATE.MISMATCH,
    'C2 ★防空：字段存在但为空 ⇒ MISMATCH（绝不因「元素在」就判已填写）', j(v2.verdict));

  const v3 = router.contractVerdict(AND1(CLAUSE_NO_VALUE), obsWith([el('email', { value: '', sensitive: true, valueLength: 8 })]));
  ok(v3.verdict === router.PRESTATE.MATCH,
    'C3 敏感字段（明文不出浏览器，value 为空串、仅 valueLength）⇒ MATCH', j(v3.verdict));

  const v4 = router.contractVerdict(AND1(CLAUSE_NO_VALUE), obsWith([el('email', { value: '', sensitive: true, valueLength: 0 })]));
  ok(v4.verdict === router.PRESTATE.MISMATCH,
    'C4 敏感字段未填写（valueLength=0）⇒ MISMATCH', j(v4.verdict));

  const v5 = router.contractVerdict(AND1(CLAUSE_NO_VALUE), obsWith([el('phone', { value: '138' })]));
  ok(v5.verdict === router.PRESTATE.INDETERMINATE,
    'C5 目标字段不在元素池 ⇒ INDETERMINATE（不得因「别处有值」判 TRUE）', j(v5.verdict));

  const v6 = router.contractVerdict(AND1(CLAUSE_NO_VALUE), obsWith([]));
  ok(v6.verdict === router.PRESTATE.INDETERMINATE,
    'C6 空集 ≠ 不存在：元素池为空 ⇒ INDETERMINATE（C105 教训）', j(v6.verdict));

  const v7 = router.contractVerdict(AND1({ type: 'field_value', expect: 'x', weight: 'REQUIRED' }), obsWith([el('email', { value: 'x' })]));
  ok(v7.verdict === router.PRESTATE.INDETERMINATE,
    'C7 缺 target.field ⇒ INDETERMINATE（不为不存在的形状加兜底）', j(v7.verdict));

  const v8 = router.contractVerdict(AND1({ type: 'field_value', target: { field: 'email' }, expect: 'a@b.co', weight: 'REQUIRED' }), obsWith([el('email', { value: 'a@b.co' })]));
  ok(v8.verdict === router.PRESTATE.MATCH, 'C8a 值在场且相等 ⇒ MATCH（原语义未动）', j(v8.verdict));
  const v9 = router.contractVerdict(AND1({ type: 'field_value', target: { field: 'email' }, expect: 'a@b.co', weight: 'REQUIRED' }), obsWith([el('email', { value: 'zzz' })]));
  ok(v9.verdict === router.PRESTATE.MISMATCH, 'C8b 值在场但不等 ⇒ MISMATCH（原语义未动）', j(v9.verdict));

  // C9 内部单元：三值本身（与 C1/C2 互为双向咬）
  const t = router.clauseVerdict(CLAUSE_NO_VALUE, obsWith([el('email', { value: 'v' })]));
  const f = router.clauseVerdict(CLAUSE_NO_VALUE, obsWith([el('email', { value: '' })]));
  ok(t === V.TRUE && f === V.FALSE,
    'C9 双向咬：同一条子句在「已填写 / 未填写」两态给出相反且确定的三值', j({ t, f }));
}

// ── D 组：登记面（本批**未动**的东西；无声改变即红）─────────────────────────
console.log('\n── D 组：登记面（有意分离 / 本批未动）──');
{
  ok(/function\s+clauseVerdict\s*\(\s*clause\s*,\s*obs\s*\)/.test(ROUTER_SRC)
    && !/clauseVerdict\s*\(\s*clause\s*,\s*obs\s*,\s*before/.test(ROUTER_SRC),
    'D1 登记：clauseVerdict(clause, obs) 保持两参（前置态语义，无因果归因；与 C132 D1 同条）');

  const upBody = (ROUTER_SRC.match(/if \(type === 'url_pattern'\) \{[\s\S]*?\n  \}/) || [''])[0];
  ok(upBody.length > 0 && /pathOf\(url\)/.test(upBody) && /patternMatches\(clause\.expect, p\)/.test(upBody),
    'D2 登记：skill 层 url_pattern 仍「只匹配 path + 用 expect」（E6/E7 有意跨层分离，本批未动）', j(upBody.slice(0, 120)));

  const ucBody = (ROUTER_SRC.match(/if \(type === 'url_contains'\) \{[\s\S]*?\n  \}/) || [''])[0];
  ok(ucBody.length > 0 && !/before|surfaceContains/.test(ucBody),
    'D3 登记：skill 层 url_contains 仍无 P2（前置态语义，不是因果归因；本批未动）');

  const vilSrc = read('server/agent/verification/verificationIntelligence.js');
  const fvBody = (vilSrc.match(/case 'field_value': \{[\s\S]*?\n    \}/) || [''])[0];
  ok(/cl\.target \|\| cl\.expect/.test(fvBody),
    'D4 登记：VIL 的 field_value 语义（cl.target || cl.expect）本批未动（改的是 skill 层，不是裁决/诊断层）');
}

// ── E 组：规范自洽（新形状必须通过 schema 校验）+ 真实数据形状信息 ────────────
console.log('\n── E 组：schema 自洽与真实数据形状 ──');
{
  const r = buildWith([step({})]);
  const cand = r.candidate || null;
  const errs = cand
    ? schema.validateStructure(cand).filter((e) => /STRUCT_CLAUSE|STRUCT_VERIFICATION/.test(e.id))
    : [{ id: 'NO_CANDIDATE', message: 'build 未产出候选（该断言因此失败，而不是被跳过）' }];
  ok(errs.length === 0, 'E1 新形状通过 schema 校验（无 STRUCT_CLAUSE / STRUCT_VERIFICATION 错误）', j(errs));
  ok(schema.OBSERVABLE_TYPES.indexOf('field_value') >= 0,
    'E1b 反真空：field_value 确在 OBSERVABLE_TYPES 内（否则 E1 平凡通过）');

  // E2 真实落地数据的形状不变量（容错读取；文件不在场则明示跳过，不做假绿）
  const dataPath = path.join(ROOT, 'server', 'data', 'aiSkill.json');
  let info = { present: false, skills: 0, clauses: 0, fieldValue: 0, fieldValueNoTarget: 0, violatesSchemaRule: 0 };
  try {
    if (fs.existsSync(dataPath)) {
      const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      const arr = Array.isArray(raw) ? raw : [];
      info.present = true; info.skills = arr.length;
      for (const s of arr) {
        for (const st of (s.states || [])) {
          for (const c of ((st.stateContract && st.stateContract.observable) || [])) {
            info.clauses++;
            if (c.target == null && c.expect == null) info.violatesSchemaRule++;
            if (c.type === 'field_value') {
              info.fieldValue++;
              if (!(c.target && c.target.field)) info.fieldValueNoTarget++;
            }
          }
        }
      }
    }
  } catch (e) { info.readError = String(e && e.message || e); }
  console.log('    [信息] 真实 aiSkill.json 形状统计=' + j(info));
  ok(info.violatesSchemaRule === 0,
    'E2 真实数据无「target 与 expect 双缺」子句（与 skillSchema:278 同判据）', j(info));
  ok(info.fieldValue === 0 || info.fieldValueNoTarget === 0,
    'E3 真实数据中若存在 field_value 子句，必有 target.field（形状真实性）', j(info));
}

// ── F 组：判据分辨力（revert 夹具自证，不是注释）─────────────────────────────
console.log('\n── F 组：判据分辨力（防空）──');
{
  // 改前原文片段（逐字取自 C145 改动前的 git HEAD 版本，用于证明 revert 正则有分辨力）
  const OLD_BUILDER = [
    "  if (type === 'element_present' || type === 'element_absent') {",
    '    if (!field) return null;',
    "    return { type, target: { field }, weight: 'REQUIRED' };",
    '  }',
    "  const expect = typeof v.expect === 'string' && v.expect.trim() ? v.expect.trim() : null;",
    '  if (!expect) return null;',
    "  return { type, expect, weight: 'REQUIRED' };",
  ].join('\n');
  const OLD_ROUTER = [
    '    const val = hit.state && hit.state.value;',
    '    if (val == null) return CLAUSE_VERDICT.INDETERMINATE;',
    "    return String(val) === String(clause.expect) ? CLAUSE_VERDICT.TRUE : CLAUSE_VERDICT.FALSE;",
  ].join('\n');

  const R1 = /if \(type === 'element_present' \|\| type === 'element_absent'\) \{/;
  const R2 = /const val = hit\.state && hit\.state\.value;/;

  ok(R1.test(OLD_BUILDER) && !R1.test(BUILDER_SRC),
    'F1 revert 分辨力（builder）：旧二值分支命中改前原文、不命中现行');
  ok(R2.test(OLD_ROUTER) && !R2.test(ROUTER_SRC),
    'F2 revert 分辨力（router）：旧的直接比较形态命中改前原文、不命中现行');

  // F3 负向对照：校验器对「必不存在的锚点」必须无命中（证明 assert 不是真空）
  const NEG = 'C145_NEGATIVE_CONTROL_MUST_NOT_EXIST';
  ok(BUILDER_SRC.indexOf(NEG) < 0 && ROUTER_SRC.indexOf(NEG) < 0,
    'F3 负向对照：伪造锚点在两份源码中均不存在（校验器有分辨力）');

  // F4 反真空：A 组/ B 组的被扫面确实存在
  ok(/function\s+clauseFromContract\(/.test(BUILDER_SRC) && /function\s+clauseVerdict\(/.test(ROUTER_SRC)
    && /field_value/.test(CFC_BODY) && /field_value/.test(ROUTER_SRC),
    'F4 反真空：被扫面（clauseFromContract / clauseVerdict 的 field_value 分支）均在位');
}

console.log('\n=== C145 守护结果：通过 ' + pass + ' / 失败 ' + fail + ' ===');
process.exit(fail ? 1 : 0);
