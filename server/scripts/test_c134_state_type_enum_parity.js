'use strict';

// =============================================================================
// C134 守护：stateType 业务态枚举的**唯一事实源**收口（L14 多清单漂移族）。
//
// ── 事实链（改前实测，探针 .benchmark/tools/c134_probe.js）──────────────────
// ① F1（B 类，生产可达）ACTION_TO_STATE.uncheck.stateType = 'UNCHECKED'
//    而 STATE_TYPES 无此项 ⇒ validateContract 拒绝（"stateType 非法: UNCHECKED"）
//    且 normalizeContract 静默降级为 GENERIC_STATE。探针 B 组：非法 1 / 10。
//    可达性：verification.js:254 buildEffectiveVerification() 的 deriveContract 是生产主链路。
// ② F2（B 类）**四处**字面清单均缺 LOGOUT_SUCCESS：
//      contract.js:15（注释）/ planner.js:102（ACTION_CONSTRAINTS，structured fallback）
//      / plan.js:180（INSTRUCTIONS）/ plan.js:250（PLAN_STRICT_INSTRUCTIONS，经 deepseek.js:106
//      进入真实 LLM prompt）——即 **三处 prompt 同步点**，而裁决白名单是 12 项。
//      ⇒ prompt 明示禁止 LOGOUT_SUCCESS，校验器（schema/action.js:162）却允许：自相矛盾。
// ③ F3（C 类，不可达）STATE_BY_OBJECTIVE 的 DOWNLOAD 行无对应 base ⇒ 恒等价于不存在。
// ④ F4（C 类，不可达）STATE_BY_OBJECTIVE 顺序反向 ⇒「退出登录」实得 LOGIN_SUCCESS。
//    不可达依据（探针 D 组）：contractFromObjective 在 server/agent 下仅 :189 自调用，生产零外部调用。
//
// ── 修法（方向：**放宽词表 1 项** + **清单同源化** + **顺序修正**）──────────
//   D1 STATE_TYPES 补登 'UNCHECKED'（12 → 13 项；与 CHECKED/SELECTED/FIELD_FILLED 同为元素级结果态）
//   D2/D3/D3b planner.js:102 / plan.js:180 / plan.js:250 改为从 STATE_TYPES **派生**
//   D4 contract.js:15 注释改为指针（消除第四份同义清单）
//   D5 STATE_BY_OBJECTIVE 顺序：LOGOUT 行移到 LOGIN 行之前 + DOWNLOAD 行加恒不可达登记
//
// ── 门槛未降证明（E 组，行为探针而非源码正则）─────────────────────────────
//   evaluateContract 只消费 requiredEvidence / forbiddenEvidence / evidenceLogic /
//   confidence / timeout / allowedAlternatives，**从不读 stateType**。
//   ⇒ 仅改 stateType 的两个契约必须得到**逐字段相同**的判定结果（注入桩 clauseVerify）。
//
// ── 组说明 ──────────────────────────────────────────────────────────────────
// A 组 = 唯一事实源形状 + 反真空（白名单定义处全库唯一）
// B 组 = 生产 ⊆ 白名单（真实 deriveContract → validateContract 全枚举）+ **revert 分辨力自证**
// C 组 = 三处 prompt 同步点（**求值后字符串**）+ 改前形状反向探针
// D 组 = 顺序不变量（真实入口 contractFromObjective）+ 登记型断言（DOWNLOAD 恒不可达）
// E 组 = 门槛未降（行为等价探针，桩注入）
// F 组 = 源码残留扫描（旧 11 项字面必须为 0）+ 扫描面非空（反真空）+ **正则分辨力自证**（L17）
// =============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// planner.js 间接引入 plannerEvidence / secretManager / stepManager（触达数据根）——
// 数据根指到仓库内临时目录，避免污染 server/data（C116 数据根纪律）。
if (!process.env.FPB_DATA_DIR) {
  process.env.FPB_DATA_DIR = path.join(ROOT, '.benchmark', 'c134_guard_tmp');
}

const contract = require('../agent/verification/contract.js');
const planSchema = require('../agent/schema/plan.js');
const planner = require('../agent/planner.js');

const STATE_TYPES = contract.STATE_TYPES;

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
function readCode(rel) {
  return stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

// 改前的两份字面清单（**逐字**取自 HEAD 866766f 的四处方言）
const PRE_FIX_PIPE = 'LOGIN_SUCCESS|SEARCH_SUCCESS|FORM_SUBMIT_SUCCESS|FIELD_FILLED|SELECTED|CHECKED|NAVIGATED|CONFIRMATION|DOWNLOAD|GENERIC_STATE|CUSTOM';
const PRE_FIX_SLASH = 'LOGIN_SUCCESS / SEARCH_SUCCESS / FORM_SUBMIT_SUCCESS / FIELD_FILLED / SELECTED / CHECKED / NAVIGATED / CONFIRMATION / DOWNLOAD / GENERIC_STATE / CUSTOM';
// 探测「改前形状是否在场」的正则（F 组扫描用；其分辨力由 F2 自证）
const PRE_FIX_RE = /LOGIN_SUCCESS\s*[|\/]\s*SEARCH_SUCCESS\s*[|\/]\s*FORM_SUBMIT_SUCCESS/;

// =============================================================================
console.log('\n── A 组：唯一事实源（STATE_TYPES）形状与反真空 ──');
{
  ok(Array.isArray(STATE_TYPES) && STATE_TYPES.length > 0,
    'A1 反真空：STATE_TYPES 是非空数组',
    'len=' + (Array.isArray(STATE_TYPES) ? STATE_TYPES.length : 'n/a'));
  ok(STATE_TYPES.length >= 12,
    'A2 反真空：白名单规模未被削减（>=12）——本批只放宽 1 项，不收紧',
    'len=' + STATE_TYPES.length);
  ok(STATE_TYPES.every((t) => typeof t === 'string' && /^[A-Z][A-Z_]*$/.test(t)),
    'A3 形状：全部成员是 UPPER_SNAKE 字符串（无 null / 无对象 / 无拼写漂移）',
    JSON.stringify(STATE_TYPES.filter((t) => !(typeof t === 'string' && /^[A-Z][A-Z_]*$/.test(t)))));
  ok(new Set(STATE_TYPES).size === STATE_TYPES.length,
    'A4 形状：无重复成员',
    'unique=' + new Set(STATE_TYPES).size + '/' + STATE_TYPES.length);

  // A5 白名单**定义处**全库唯一（防止再长出第二份白名单）
  const defs = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'data' && e.name !== 'node_modules') walk(p); }
      else if (e.name.endsWith('.js')) {
        const src = stripComments(fs.readFileSync(p, 'utf8'));
        if (/const\s+STATE_TYPES\s*=\s*\[/.test(src)) defs.push(path.relative(ROOT, p).replace(/\\/g, '/'));
      }
    }
  })(path.join(ROOT, 'server', 'agent'));
  ok(defs.length === 1 && defs[0] === 'server/agent/verification/contract.js',
    'A5 全库扫描：STATE_TYPES 的**定义处**在 server/agent 下唯一（= contract.js）',
    JSON.stringify(defs));

  // A5b 静态委托：schema/action.js 必须 require 同一常量（而非自带副本）
  const actionSrc = readCode('server/agent/schema/action.js');
  ok(/const\s*\{\s*STATE_TYPES\s*\}\s*=\s*require\('\.\.\/verification\/contract'\)/.test(actionSrc),
    'A5b 静态委托：schema/action.js 以 require 引用同一 STATE_TYPES（L15：口径唯一须有静态证据）');
}

// =============================================================================
console.log('\n── B 组：生产 ⊆ 白名单（真实 deriveContract → validateContract 全枚举）──');
{
  const act = (t) => ({ type: t, value: 'v', target: { semantic: 's', url: 'https://a.com/x' } });
  ok(contract.DERIVABLE.length >= 10,
    'B0 反真空：DERIVABLE 枚举面非空（否则 B1/B2 真空绿）',
    'DERIVABLE=' + contract.DERIVABLE.length);

  const derived = contract.DERIVABLE.map((t) => ({ t, d: contract.deriveContract(act(t)) }));
  const notProduced = derived.filter((x) => !x.d);
  ok(notProduced.length === 0,
    'B0b 正向：每个 DERIVABLE 动作都能派生出契约（deriveContract 非 null）',
    JSON.stringify(notProduced.map((x) => x.t)));

  const outOfVocab = derived.filter((x) => x.d && STATE_TYPES.indexOf(x.d.stateType) < 0);
  ok(outOfVocab.length === 0,
    'B1 生产 ⊆ 白名单：全部派生契约 stateType 都在 STATE_TYPES 内（改前 uncheck=UNCHECKED 越界）',
    JSON.stringify(outOfVocab.map((x) => x.t + '→' + x.d.stateType)));

  const rejected = derived.filter((x) => !contract.validateContract(x.d).ok);
  ok(rejected.length === 0,
    'B2 自洽：全部派生契约通过自身校验器 validateContract（改前 uncheck 被拒绝 1/10）',
    JSON.stringify(rejected.map((x) => x.t + '→' + JSON.stringify(contract.validateContract(x.d).errors))));

  // B3 形状：uncheck 的派生结果**不再被静默降级**（改前 normalize → GENERIC_STATE）
  const uncheckDerived = contract.deriveContract(act('uncheck'));
  ok(uncheckDerived && uncheckDerived.stateType === 'UNCHECKED',
    'B3 形状：uncheck 派生契约 stateType = UNCHECKED（词表补登生效）',
    JSON.stringify(uncheckDerived && uncheckDerived.stateType));
  ok(uncheckDerived && contract.normalizeContract(uncheckDerived).stateType === 'UNCHECKED',
    'B3b 形状：uncheck 派生契约经 normalizeContract 后**保持** UNCHECKED（改前降级为 GENERIC_STATE）',
    JSON.stringify(uncheckDerived && contract.normalizeContract(uncheckDerived).stateType));

  // B4 **revert 分辨力自证**（L17）：降级路径仍然存在 ⇒ 改前 UNCHECKED 必然落此路。
  //   用真实函数（normalizeContract）而非另写同义实现。
  const rogue = contract.normalizeContract({ stateType: 'UNCHECKED_NOT_IN_WHITELIST', requiredEvidence: [{ type: 'text_present', expect: 'a' }] });
  ok(rogue && rogue.stateType === 'GENERIC_STATE',
    'B4 分辨力自证：白名单外 stateType 仍被 normalizeContract 降级为 GENERIC_STATE'
    + '（⇒ 若移除 D1 补登，B1/B2/B3 必红，本组不真空）',
    JSON.stringify(rogue && rogue.stateType));
  ok(contract.validateContract({ stateType: 'UNCHECKED_NOT_IN_WHITELIST', requiredEvidence: [{ type: 'text_present', expect: 'a' }] }).ok === false,
    'B4b 分辨力自证：白名单外 stateType 仍被 validateContract 拒绝（拒绝通道未被放宽）');

  // B5 负向对照：未知动作类型仍返回 null（防止 deriveContract 被改成「永不返回 null」后 B1 真空真）
  ok(contract.deriveContract({ type: '__NO_SUCH_ACTION__' }) === null,
    'B5 负向对照：未知 action.type 仍产出 null（deriveContract 未被放宽为恒有值）');
}

// =============================================================================
console.log('\n── C 组：三处 prompt 同步点（求值后字符串）──');
{
  const PIPE_EXPECT = STATE_TYPES.join('|');
  const SLASH_EXPECT = STATE_TYPES.join(' / ');
  const hasPipe = (s) => String(s).indexOf(PIPE_EXPECT) >= 0;
  const hasSlash = (s) => String(s).indexOf(SLASH_EXPECT) >= 0;

  // C0 反真空：待比对的目标串本身非空且含 LOGOUT_SUCCESS
  ok(PIPE_EXPECT.length > 40 && PIPE_EXPECT.indexOf('LOGOUT_SUCCESS') >= 0,
    'C0 反真空：期望枚举串（STATE_TYPES.join(\'|\')）非空且含 LOGOUT_SUCCESS',
    'len=' + PIPE_EXPECT.length);

  ok(hasPipe(planSchema.INSTRUCTIONS),
    'C1 plan.js INSTRUCTIONS（非 strict 路径，求值后）含**完整** STATE_TYPES 枚举');
  ok(hasPipe(planSchema.PLAN_STRICT_INSTRUCTIONS),
    'C2 plan.js PLAN_STRICT_INSTRUCTIONS（strict 路径 → deepseek.js:106 真实 LLM）含完整枚举');
  ok(hasSlash(planner.ACTION_CONSTRAINTS),
    'C3 planner.js ACTION_CONSTRAINTS（structured fallback 路径）含完整枚举');
  ok(hasSlash(planner.PLANNER_INSTRUCTIONS),
    'C4 planner.js PLANNER_INSTRUCTIONS（组合后交付 LLM 的字符串）含完整枚举');

  // C5 关键：四处求值后**都**含 LOGOUT_SUCCESS（改前四处全缺）
  const texts = {
    INSTRUCTIONS: planSchema.INSTRUCTIONS,
    PLAN_STRICT_INSTRUCTIONS: planSchema.PLAN_STRICT_INSTRUCTIONS,
    ACTION_CONSTRAINTS: planner.ACTION_CONSTRAINTS,
    PLANNER_INSTRUCTIONS: planner.PLANNER_INSTRUCTIONS,
  };
  const missingLogout = Object.keys(texts).filter((k) => String(texts[k]).indexOf('LOGOUT_SUCCESS') < 0);
  ok(missingLogout.length === 0,
    'C5 三处 prompt 同步点（四处求值后字符串）均含 LOGOUT_SUCCESS（改前 4/4 缺失）',
    JSON.stringify(missingLogout));

  // C6 **revert 反向探针**（L17）：同一判定函数对**改前形状**必须返回 false。
  ok(!hasPipe(PRE_FIX_PIPE) && !hasSlash(PRE_FIX_SLASH),
    'C6 反向探针：判定函数对改前 11 项字面清单返回 false（⇒ 回退必被 C1–C4 咬住，不真空绿）');
  ok(hasPipe(PIPE_EXPECT) && hasSlash(SLASH_EXPECT),
    'C6b 正向对照：同一判定函数对改后枚举返回 true（证明 C6 不是「恒 false」的死断言）');
}

// =============================================================================
console.log('\n── D 组：STATE_BY_OBJECTIVE 顺序不变量 + DOWNLOAD 恒不可达登记 ──');
{
  const SBO = contract.STATE_BY_OBJECTIVE;
  ok(Array.isArray(SBO) && SBO.length >= 9,
    'D0 反真空：STATE_BY_OBJECTIVE 行数非空（>=9）',
    'len=' + (Array.isArray(SBO) ? SBO.length : 'n/a'));

  const rowLogout = SBO.find((m) => m.stateType === 'LOGOUT_SUCCESS');
  const rowLogin = SBO.find((m) => m.stateType === 'LOGIN_SUCCESS');
  const iLogout = SBO.findIndex((m) => m.stateType === 'LOGOUT_SUCCESS');
  const iLogin = SBO.findIndex((m) => m.stateType === 'LOGIN_SUCCESS');

  ok(iLogout >= 0 && iLogin >= 0 && iLogout < iLogin,
    'D1 顺序不变量：LOGOUT_SUCCESS 行位于 LOGIN_SUCCESS 行**之前**（首命中即返回 ⇒ 顺序决定结果）',
    'iLogout=' + iLogout + ' iLogin=' + iLogin);

  // D2 **revert 分辨力自证**（L17）：该 objective 同时命中两行 ⇒ 顺序是唯一决定因素。
  //   （若回退顺序，D3 的真实入口断言必变为 LOGIN_SUCCESS ⇒ 被咬住。）
  ok(rowLogout && rowLogin && rowLogout.re.test('退出登录') && rowLogin.re.test('退出登录'),
    'D2 分辨力自证：「退出登录」同时命中 LOGOUT 行与 LOGIN 行 ⇒ 顺序唯一决定结果，回退必反向');

  ok((contract.contractFromObjective('退出登录', { type: 'click' }) || {}).stateType === 'LOGOUT_SUCCESS',
    'D3 真实入口：contractFromObjective(\'退出登录\') → LOGOUT_SUCCESS（改前 → LOGIN_SUCCESS，与意图相反）',
    JSON.stringify((contract.contractFromObjective('退出登录', { type: 'click' }) || {}).stateType));
  ok((contract.contractFromObjective('登录', { type: 'click' }) || {}).stateType === 'LOGIN_SUCCESS',
    'D3b 负向对照：contractFromObjective(\'登录\') 仍 → LOGIN_SUCCESS（顺序调整未误伤纯登录）',
    JSON.stringify((contract.contractFromObjective('登录', { type: 'click' }) || {}).stateType));
  ok((contract.contractFromObjective('sign out', { type: 'click' }) || {}).stateType === 'LOGOUT_SUCCESS',
    'D3c 真实入口（英文）：contractFromObjective(\'sign out\') → LOGOUT_SUCCESS');

  // D4 登记型断言：DOWNLOAD 行当前**恒不可达**（ACTION_TO_STATE 无对应 base）。
  //    这是**有意**的登记——若未来新增 download 基础契约，本断言会红，强制同步注释与报告（防注释过期）。
  const hasDownloadBase = Object.keys(contract.ACTION_TO_STATE)
    .some((k) => contract.ACTION_TO_STATE[k].stateType === 'DOWNLOAD');
  ok(hasDownloadBase === false,
    'D4 登记：ACTION_TO_STATE 当前**无** stateType=DOWNLOAD 的 base ⇒ STATE_BY_OBJECTIVE 的 DOWNLOAD 行'
    + '恒等价于不存在（新增 download 基础契约时本断言变红 = 强制对账）',
    'hasDownloadBase=' + hasDownloadBase);
  ok(SBO.some((m) => m.stateType === 'DOWNLOAD'),
    'D4b 登记在场：DOWNLOAD 行仍保留为待接线占位（而非被删）');

  // D5 白名单覆盖：STATE_BY_OBJECTIVE 的态值必须全部 ∈ STATE_TYPES（改前 A3 差集已为 []，此处钉住）
  const sboOut = [...new Set(SBO.map((m) => m.stateType))].filter((t) => STATE_TYPES.indexOf(t) < 0);
  ok(sboOut.length === 0,
    'D5 STATE_BY_OBJECTIVE ⊆ STATE_TYPES（映射表不得引用白名单外的态）',
    JSON.stringify(sboOut));
}

// =============================================================================
console.log('\n── E 组：门槛未降证明（行为等价探针，注入桩 clauseVerify）──');
{
  // 隔离通道注入桩（纪律：探针用真实生成的契约、隔离通道须注入桩）
  const calls = [];
  const stub = (clause) => {
    calls.push(clause.type + ':' + String(clause.expect));
    return { success: clause.expect === 'OK', confidence: 0.8, evidence: ['stub:' + clause.type] };
  };
  const after = { url: 'https://a.com/x', textSummary: 'OK', elements: [] };
  const before = { url: 'https://a.com/x', textSummary: '', elements: [] };

  // 仅 stateType 不同、其余逐字相同的两份契约
  const mk = (st) => ({
    stateType: st, expected: 'same',
    requiredEvidence: [{ type: 'text_present', expect: 'OK' }],
    forbiddenEvidence: [{ type: 'text_present', expect: 'FATAL' }],
    evidenceLogic: 'AND', confidence: 0.8, timeout: 5000,
  });
  const pick = (r) => JSON.stringify({
    success: r.success, confidence: r.confidence, logic: r.logic,
    passed: r.passed, total: r.total, forbiddenHit: !!r.forbiddenHit,
  });

  const rA = contract.evaluateContract(mk('UNCHECKED'), after, before, stub);
  const rB = contract.evaluateContract(mk('GENERIC_STATE'), after, before, stub);
  const rC = contract.evaluateContract(mk('LOGOUT_SUCCESS'), after, before, stub);
  const rRogue = contract.evaluateContract(mk('__NOT_IN_WHITELIST__'), after, before, stub);

  ok(pick(rA) === pick(rB) && pick(rA) === pick(rC),
    'E1 行为等价：仅改 stateType（UNCHECKED / GENERIC_STATE / LOGOUT_SUCCESS）⇒ 判定逐字段相同'
    + '（evaluateContract 不读 stateType）',
    pick(rA) + ' vs ' + pick(rB) + ' vs ' + pick(rC));
  ok(pick(rA) === pick(rRogue),
    'E2 词表扩员无副作用：白名单外 stateType 的判定结果与白名单内**完全相同**'
    + '（⇒ D1 的放宽不可能改变任何判定门槛）',
    pick(rA) + ' vs ' + pick(rRogue));
  ok(rA.success === true && rA.passed === 1 && rA.total === 1,
    'E3 正向：桩命中路径确实走到成功分支（E1/E2 的「相同」不是「两边都失败」的假一致）',
    pick(rA));
  ok(calls.length > 0,
    'E4 反真空：桩确实被调用（否则 E1–E3 恒真）',
    'calls=' + calls.length);

  // E5 失效型对照：把禁止证据改成命中 ⇒ 必须硬失败（证明 forbidden 通道仍活着，E1 不是恒真）
  const rForbidden = contract.evaluateContract(
    { ...mk('UNCHECKED'), forbiddenEvidence: [{ type: 'text_present', expect: 'OK' }] }, after, before, stub);
  ok(rForbidden.success === false && !!rForbidden.forbiddenHit,
    'E5 失效型对照：禁止证据命中 ⇒ 硬失败（forbidden 通道未因本批失效）',
    pick(rForbidden));
}

// =============================================================================
console.log('\n── F 组：源码残留扫描（旧 11 项字面 = 0）+ 反真空 + 正则分辨力自证 ──');
{
  const FILES = [
    'server/agent/verification/contract.js',
    'server/agent/planner.js',
    'server/agent/schema/plan.js',
  ];
  // F1 反真空：扫描面非空
  const empty = FILES.filter((f) => readCode(f).length < 200);
  ok(empty.length === 0,
    'F1 反真空：待扫描的三个文件均存在且非空（否则 F3 真空绿）',
    JSON.stringify(empty));

  // F2 正则分辨力自证（L17）：同一正则对**改前两种方言**必须命中
  ok(PRE_FIX_RE.test(PRE_FIX_PIPE) && PRE_FIX_RE.test(PRE_FIX_SLASH),
    'F2 分辨力自证：残留正则对改前两种方言（`|` 与 ` / `）均命中（⇒ F3 的 0 命中非恒真）');

  // F3 残留扫描：三文件可执行面（去注释）不得再出现内联的旧清单
  const residual = FILES.filter((f) => PRE_FIX_RE.test(readCode(f)));
  ok(residual.length === 0,
    'F3 无残留：三文件可执行面不再内联旧 11 项清单（已全部改为从 STATE_TYPES 派生）',
    JSON.stringify(residual));

  // F4 形状：两处 prompt 文件确实以**派生表达式**引用 STATE_TYPES（而非仅删掉清单）
  //   断言必须锚定**真实产生的形状** `const { STATE_TYPES } = require('...')` ——
  //   本守护首版曾写成 `STATE_TYPES\s*=\s*require` 而误红（臆造形状，L16 反面教训）。
  const planCode = readCode('server/agent/schema/plan.js');
  const plannerCode = readCode('server/agent/planner.js');
  const REQ_PLAN = /const\s*\{\s*STATE_TYPES\s*\}\s*=\s*require\('\.\.\/verification\/contract'\)/;
  const REQ_PLANNER = /const\s*\{\s*STATE_TYPES\s*\}\s*=\s*require\('\.\/verification\/contract'\)/;
  ok(REQ_PLAN.test(planCode),
    'F4 plan.js 以 require 引入同一 STATE_TYPES（派生而非删除）');
  ok(REQ_PLANNER.test(plannerCode),
    'F4b planner.js 以 require 引入同一 STATE_TYPES');
  // F4c 分辨力自证：上述正则对**臆造形状**必须失配（否则 F4/F4b 恒真）
  ok(!REQ_PLAN.test('const STATE_TYPES = require("../verification/contract");'),
    'F4c 分辨力自证：F4 正则对「无解构直取」形状失配（⇒ 断言有分辨力）');
  ok((planCode.match(/STATE_TYPES\.join\('\|'\)/g) || []).length === 2,
    'F5 派生点计数：plan.js 恰有 2 处 STATE_TYPES.join(\'|\')（INSTRUCTIONS + PLAN_STRICT_INSTRUCTIONS）',
    'count=' + (planCode.match(/STATE_TYPES\.join\('\|'\)/g) || []).length);
  ok((plannerCode.match(/STATE_TYPES\.join\(' \/ '\)/g) || []).length === 1,
    'F5b 派生点计数：planner.js 恰有 1 处 STATE_TYPES.join(\' / \')',
    'count=' + (plannerCode.match(/STATE_TYPES\.join\(' \/ '\)/g) || []).length);

  // F6 反「只删不派生」真空：删除清单但未派生 ⇒ F5/F5b 计数为 0 ⇒ 红（上述断言即覆盖）
  //   此处补一条独立的等值断言：派生点总数必须 >= 3（两处 + 一处）
  const totalDerive = (planCode.match(/STATE_TYPES\.join\(/g) || []).length
    + (plannerCode.match(/STATE_TYPES\.join\(/g) || []).length;
  ok(totalDerive >= 3,
    'F6 反真空：派生点总数 >= 3（「只删不派生」会在此红）',
    'total=' + totalDerive);
}

console.log('\n=== C134 结果：' + pass + ' / ' + (pass + fail) + ' ===');
if (fail > 0) process.exitCode = 1;
