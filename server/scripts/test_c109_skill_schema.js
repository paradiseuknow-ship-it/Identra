'use strict';
/**
 * PHASE 17-C —— Project Skill Schema / 安全边界契约守护（零浏览器、零 LLM）。
 *
 * 设计依据：.benchmark/PHASE17B_PROJECT_SKILL_ARCHITECTURE.md §5 / §6 / §11.4 / §16.3 / 附录 C
 *
 * 覆盖设计报告附录 C 的 T1–T5，以及「安全边界可测试形式」的全部 8 条（SEC1–SEC8）。
 *
 * 本测试的第一条断言是**正向对照**（validSkill() 必须 ok）——
 * 没有它，"全部拒绝"这种恒假实现也会看起来全绿。
 *
 * 另含两类静态断言（沿用 Phase 17-A 守护 S1/S2 的纪律）：
 *   S1 Skill 域四个模块不得出现任何具体站点名字面量（禁止站点白/黑名单方案）；
 *   S2 skillBuilder 不得**读取** target.selector（污染源 P1 的结构性防线）。
 */

const fs = require('fs');
const path = require('path');
const schema = require('../agent/skill/skillSchema');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + detail); }
}

const SKILL_DIR = path.join(__dirname, '..', 'agent', 'skill');

// ── 基线合法 Skill（正向对照）──────────────────────────────────────────────
function validSkill(overrides) {
  const base = {
    id: 'skill_test',
    schemaVersion: 1,
    version: 1,
    status: 'CANDIDATE',
    capability: 'SEARCH',
    intent: 'search',
    intentAliases: ['search', '搜索'],
    environmentScope: {
      originAnchor: 'https://example.test',
      locale: ['en'],
      loginState: '*',
      profileClass: '*',
      viewportClass: '*',
    },
    states: [
      {
        id: 'LANDING',
        name: '落地页',
        stateContract: { observable: [{ type: 'url_pattern', expect: '/', weight: 'SOFT' }], logic: 'AND', cooldownMs: 0 },
        actions: [],
      },
      {
        id: 'S01_FILL_SEARCH',
        name: '输入搜索词',
        stateContract: { observable: [{ type: 'element_present', target: { field: 'search' }, weight: 'REQUIRED' }], logic: 'AND', cooldownMs: 0 },
        actions: [{
          id: 'ACT_1',
          type: 'fill',
          targetSemantic: { intent: 'SEARCH_FIELD', field: 'search', roleHint: 'input', variants: [{ locale: 'en', lexicalEvidence: ['search'] }] },
          valueSource: 'LITERAL',
          credentialRef: null,
          preconditions: [],
          expectedTransition: { from: 'LANDING', to: 'S01_FILL_SEARCH', kind: 'SAME_ORIGIN', authorizationCarryOver: 'NONE' },
          verification: { type: 'element_present', target: { field: 'search' } },
          risk: 'LOW',
          requiresCredentialAuthorization: false,
        }],
      },
      {
        id: 'CONFIRMED',
        name: '业务完成',
        stateContract: { observable: [{ type: 'url_pattern', expect: '/', weight: 'SOFT' }], logic: 'AND', cooldownMs: 0 },
        actions: [],
      },
    ],
    entryState: 'LANDING',
    terminalStates: ['CONFIRMED'],
    boundaries: {
      excludesPayment: true,
      involvesCredentials: false,
      involvesExternalOrigin: false,
      requiresHumanOn: ['SECURITY_CHALLENGE', 'MFA', '3DS'],
    },
    confidence: 0.3,
    samples: { success: 1, failed: 0 },
    replays: 1,
    distinctSessions: 1,
    stats: {
      hits: 0, prestatesPassed: 0, prestatesFailed: 0, midFailures: 0,
      fallbacks: 0, falsePromotions: 0, authorizationBlocks: 0, contractObservations: 1,
    },
    evidenceChainRef: 'evchain_test',
    lifecycle: { promotedAt: null, lastSuccessAt: null, lastFailureAt: null, stalenessReasons: [], revalidateAttempts: 0, deprecatedReason: null },
    provenance: { sourceFlowId: null, sourceTaskIds: ['task_1'], builderVersion: '1.0' },
    createdAt: 1,
    updatedAt: 1,
  };
  return Object.assign({}, base, overrides || {});
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function errIds(res) { return (res.errors || []).map((e) => e.id); }

// ── P0 正向对照：基线必须通过 ────────────────────────────────────────────────
{
  const r = schema.validateSkill(validSkill());
  check('P0 基线合法 Skill 必须通过（防空实现恒假绿）', r.ok === true, r.ok ? '' : JSON.stringify(r.errors));
}

// ── S0 安全检查集合完整性 ───────────────────────────────────────────────────
{
  const ids = schema.securityCheckIds();
  const want = ['SEC1', 'SEC2', 'SEC3', 'SEC4', 'SEC5', 'SEC6', 'SEC7', 'SEC8'];
  check('S0a 安全检查集合恰为 SEC1–SEC8', JSON.stringify(ids) === JSON.stringify(want), JSON.stringify(ids));
  check('S0b REQUIRES_HUMAN_ON 固定三类且不可配置',
    JSON.stringify(schema.REQUIRES_HUMAN_ON) === JSON.stringify(['SECURITY_CHALLENGE', 'MFA', '3DS']));
  check('S0c authorizationCarryOver 固定为 NONE（跨域不继承授权）', schema.AUTHORIZATION_CARRY_OVER === 'NONE');
}

// ── T1 / SEC7：定位器 ───────────────────────────────────────────────────────
{
  const s = clone(validSkill());
  s.states[1].actions[0].targetSemantic.selector = '#search-input';
  const r = schema.validateSkill(s);
  check('T1 含 selector 的 Skill 落库必须失败', r.ok === false && errIds(r).includes('SEC7'), JSON.stringify(errIds(r)));
}
{
  const s = clone(validSkill());
  s.states[1].actions[0].targetSemantic.xpath = '//input';
  check('T1b 含 xpath 的 Skill 落库必须失败', errIds(schema.validateSkill(s)).includes('SEC7'));
}
{
  const s = clone(validSkill());
  s.states[1].actions[0].offsetX = 12;
  check('T1c 含坐标字段 offsetX 的 Skill 落库必须失败', errIds(schema.validateSkill(s)).includes('SEC7'));
}
{
  const s = clone(validSkill());
  s.states[1].name = 'document.querySelector("#search")';
  check('T1d 含 querySelector 值形态的 Skill 落库必须失败', errIds(schema.validateSkill(s)).includes('SEC7'));
}

// ── T2 / SEC6：成功裁决 ────────────────────────────────────────────────────
{
  const s = clone(validSkill());
  s.success = true;
  check('T2 含 success:true 的 Skill 落库必须失败', errIds(schema.validateSkill(s)).includes('SEC6'));
}
{
  const s = clone(validSkill());
  s.verified = true;
  check('T2b 含 verified 字段的 Skill 落库必须失败', errIds(schema.validateSkill(s)).includes('SEC6'));
}
{
  const s = clone(validSkill());
  s.businessSuccess = 'YES';
  check('T2c 含 businessSuccess 字段的 Skill 落库必须失败', errIds(schema.validateSkill(s)).includes('SEC6'));
}
{
  // [D2] 偏差守卫：samples.success 是**计数**不是裁决，必须放行（否则 memoryRecord 基座无法落库）
  const s = clone(validSkill());
  s.samples = { success: 7, failed: 0 };
  const r = schema.validateSkill(s);
  check('T2d [D2] samples.success 计数不得被误判为成功裁决', !errIds(r).includes('SEC6'), JSON.stringify(errIds(r)));
}

// ── T3 / SEC8：站点名字面量 ────────────────────────────────────────────────
{
  for (const w of ['webflow', 'github.com', 'google.com', 'apple.com']) {
    const s = clone(validSkill());
    s.intentAliases = [w];
    check('T3 含站点名字面量 "' + w + '" 的 Skill 落库必须失败', errIds(schema.validateSkill(s)).includes('SEC8'));
  }
}

// ── T4 / SEC4：外部 origin 授权继承 ────────────────────────────────────────
{
  const s = clone(validSkill());
  s.states[1].actions[0].expectedTransition.kind = 'EXTERNAL_ORIGIN';
  s.states[1].actions[0].expectedTransition.authorizationCarryOver = 'INHERIT';
  const r = schema.validateSkill(s);
  check('T4 EXTERNAL_ORIGIN + 授权继承必须失败', errIds(r).includes('SEC4'), JSON.stringify(errIds(r)));
}
{
  const s = clone(validSkill());
  s.states[1].actions[0].expectedTransition.kind = 'EXTERNAL_ORIGIN';
  s.states[1].actions[0].expectedTransition.authorizationCarryOver = 'NONE';
  check('T4b EXTERNAL_ORIGIN + authorizationCarryOver=NONE 必须放行', schema.validateSkill(s).ok === true,
    JSON.stringify(schema.validateSkill(s).errors));
}

// ── T5 / SEC5：凭据明文 ────────────────────────────────────────────────────
{
  const s = clone(validSkill());
  s.states[1].actions[0].targetSemantic.field = 'password';
  s.states[1].actions[0].valueSource = 'LITERAL';
  s.states[1].actions[0].value = 'hunter2';
  check('T5 敏感字段明文值必须失败', errIds(schema.validateSkill(s)).includes('SEC5'));
}
{
  const s = clone(validSkill());
  s.states[1].actions[0].targetSemantic.field = 'password';
  s.states[1].actions[0].valueSource = 'CREDENTIAL_REF';
  s.states[1].actions[0].credentialRef = 'hunter2-not-a-ref';
  check('T5b 非法凭据引用（非 vault:/secret:）必须失败', errIds(schema.validateSkill(s)).includes('SEC5'));
}
{
  const s = clone(validSkill());
  s.states[1].actions[0].targetSemantic.field = 'password';
  s.states[1].actions[0].valueSource = 'CREDENTIAL_REF';
  s.states[1].actions[0].credentialRef = 'vault:signup_password';
  const r = schema.validateSkill(s);
  check('T5c 合法 vault: 引用必须放行（凭据只存引用）', !errIds(r).includes('SEC5'), JSON.stringify(errIds(r)));
}

// ── SEC1 / [D1]：绕过语义，只扫可执行体 ────────────────────────────────────
{
  const s = clone(validSkill());
  s.states[1].name = 'solve captcha then continue';
  check('SEC1a 可执行体含绕过语义必须失败', errIds(schema.validateSkill(s)).includes('SEC1'));
}
{
  const s = clone(validSkill());
  s.transitions = [{ from: 'LANDING', to: 'S01_FILL_SEARCH', trigger: 'ACT_1', kind: 'SAME_ORIGIN', authorizationCarryOver: 'NONE' }];
  s.states[1].actions[0].expectedTransition.kind = 'SAME_ORIGIN';
  s.transitions[0].note = 'perimeterx bypass';
  check('SEC1b 顶层 transitions 含绕过语义必须失败', errIds(schema.validateSkill(s)).includes('SEC1'));
}
{
  // [D1] 偏差守卫：boundaries.requiresHumanOn 的 "MFA"/"3DS" 是**安全声明**，不是绕过
  const s = clone(validSkill());
  s.boundaries.requiresHumanOn = ['SECURITY_CHALLENGE', 'MFA', '3DS'];
  const r = schema.validateSkill(s);
  check('SEC1c [D1] boundaries 的 MFA/3DS 安全声明不得被判为绕过', !errIds(r).includes('SEC1'), JSON.stringify(errIds(r)));
}

// ── SEC2：授权 origin 列表 ─────────────────────────────────────────────────
{
  const s = clone(validSkill());
  s.preconditions = [{ type: 'ORIGIN_AUTHORIZED', allowedOrigins: ['https://example.test'] }];
  check('SEC2 含 allowedOrigins 必须失败', errIds(schema.validateSkill(s)).includes('SEC2'));
}
{
  const s = clone(validSkill());
  s.states[1].actions[0].preconditions = [{ type: 'ORIGIN_AUTHORIZED', by: 'credentialAuthorization.authorize' }];
  const r = schema.validateSkill(s);
  check('SEC2b 运行时授权前置声明（by=闸门）必须放行', !errIds(r).includes('SEC2'), JSON.stringify(errIds(r)));
}

// ── SEC3：域名匹配谓词 ─────────────────────────────────────────────────────
{
  for (const bad of ['host.includes("x")', 'isSameSite(a,b)', "endsWith('.')"]) {
    const s = clone(validSkill());
    s.intentAliases = [bad];
    check('SEC3 含域名匹配谓词 ' + JSON.stringify(bad) + ' 必须失败', errIds(schema.validateSkill(s)).includes('SEC3'));
  }
}

// ── 结构校验：§11.4 硬门禁 ─────────────────────────────────────────────────
{
  const s = clone(validSkill());
  delete s.states[1].actions[0].verification;
  check('ST1 无 verification 的步骤不得入 Skill（§11.4）', errIds(schema.validateSkill(s)).includes('STRUCT_VERIFICATION'));
}
{
  const s = clone(validSkill());
  s.states[1].actions[0].verification = { type: 'page_change' };
  check('ST1b 无状态区分度的 verification（page_change）不得入 Skill',
    errIds(schema.validateSkill(s)).includes('STRUCT_VERIFICATION'));
}
{
  const s = clone(validSkill());
  s.entryState = 'NOPE';
  check('ST2 entryState 必须指向存在的状态', errIds(schema.validateSkill(s)).includes('STRUCT_ENTRY'));
}
{
  const s = clone(validSkill());
  s.terminalStates = ['NOPE'];
  check('ST3 terminalStates 必须指向存在的状态', errIds(schema.validateSkill(s)).includes('STRUCT_TERMINAL'));
}
{
  const s = clone(validSkill());
  s.boundaries.requiresHumanOn = ['SECURITY_CHALLENGE'];
  check('ST4 requiresHumanOn 缺 MFA/3DS 必须失败（§16.1 不可配置）',
    errIds(schema.validateSkill(s)).includes('STRUCT_HUMAN_ON'));
}
{
  const s = clone(validSkill());
  s.environmentScope.originAnchor = 'about:blank';
  check('ST5 originAnchor 不可解析为 http(s) 必须失败', errIds(schema.validateSkill(s)).includes('STRUCT_ORIGIN'));
}
{
  const s = clone(validSkill());
  s.environmentScope.originAnchor = 'file:///c:/tmp/x.html';
  check('ST5b originAnchor=file: 必须失败', errIds(schema.validateSkill(s)).includes('STRUCT_ORIGIN'));
}
{
  const s = clone(validSkill());
  delete s.evidenceChainRef;
  check('ST6 无证据链引用必须失败（无证据禁止落库）', errIds(schema.validateSkill(s)).includes('STRUCT_EVIDENCE'));
}
{
  const s = clone(validSkill());
  s.capability = 'WEBFLOW_MAGIC';
  check('ST7 capability 必须在受控词表内', errIds(schema.validateSkill(s)).includes('STRUCT_CAPABILITY'));
}
{
  const s = clone(validSkill());
  s.status = 'PROMOTED';
  check('ST8 status 必须在 SKILL_STATUS 内', errIds(schema.validateSkill(s)).includes('STRUCT_STATUS'));
}
{
  const s = clone(validSkill());
  s.states[1].stateContract.observable = [{ type: 'element_present', expect: 'x', weight: 'OPTIONAL' }];
  check('ST9 observable.weight 只允许 REQUIRED|SOFT', errIds(schema.validateSkill(s)).includes('STRUCT_CLAUSE'));
}
{
  const s = clone(validSkill());
  s.states[1].stateContract.observable = [{ type: 'dom_path', expect: 'x', weight: 'SOFT' }];
  check('ST10 observable.type 只允许存在性/文本/URL 类', errIds(schema.validateSkill(s)).includes('STRUCT_CLAUSE'));
}
{
  const s = clone(validSkill());
  s.states[1].actions[0].expectedTransition.to = 'GONE';
  check('ST11 expectedTransition.to 必须指向存在的状态',
    errIds(schema.validateSkill(s)).includes('STRUCT_TRANSITION'));
}

// ── S1 静态断言：零站点名字面量（禁止白/黑名单方案）─────────────────────────
// 口径说明：SEC8 这条检查**本身必须知道**要拒绝哪些站点名，因此 skillSchema 允许在
// SEC8 定义内出现这些字面量；除此之外的任何位置（含其余三个数据产出模块）一律禁止 ——
// 否则就等于把站点名单硬编码进了通用模型。
{
  const banned = ['webflow', 'github.com', 'google.com', 'apple.com'];
  for (const f of ['skillLifecycle.js', 'skillEvidence.js', 'skillBuilder.js', 'index.js']) {
    const src = fs.readFileSync(path.join(SKILL_DIR, f), 'utf8').toLowerCase();
    const hits = banned.filter((w) => src.indexOf(w) >= 0);
    check('S1 ' + f + ' 无站点名字面量', hits.length === 0, 'hits=' + JSON.stringify(hits));
  }
  const schemaSrc = fs.readFileSync(path.join(SKILL_DIR, 'skillSchema.js'), 'utf8');
  const sec8At = schemaSrc.indexOf("id: 'SEC8'");
  check('S1b skillSchema 存在 SEC8 定义', sec8At > 0, 'at=' + sec8At);
  const beforeSec8 = schemaSrc.slice(0, sec8At).toLowerCase();
  const leaked = banned.filter((w) => beforeSec8.indexOf(w) >= 0);
  check('S1c 站点名字面量只允许出现在 SEC8 定义内（不得硬编码进通用模型）',
    leaked.length === 0, 'leaked=' + JSON.stringify(leaked));
}

// ── S2 静态断言：Builder **不读取** selector（污染源 P1 结构性防线）──────────
{
  const src = fs.readFileSync(path.join(SKILL_DIR, 'skillBuilder.js'), 'utf8');
  const hits = ['.selector', 'xpath', 'offsetX'].filter((k) => src.indexOf(k) >= 0);
  check('S2a skillBuilder 不读取定位符（selector/xpath/坐标）', hits.length === 0, 'hits=' + JSON.stringify(hits));
}

// ── S3 静态断言：跨域固定不继承授权（与 17-A 的结构兼容）────────────────────
{
  const src = fs.readFileSync(path.join(SKILL_DIR, 'skillSchema.js'), 'utf8');
  check('S3a EXTERNAL_ORIGIN 判定存在', src.indexOf("'EXTERNAL_ORIGIN'") >= 0);
  check('S3b authorizationCarryOver 固定 NONE', src.indexOf("AUTHORIZATION_CARRY_OVER = 'NONE'") >= 0);
}

// ── S4 集合注册（不注册会抛「未知 AI 集合」，Skill 域直接不可用）────────────
{
  const jsonStore = require('../agent/storage/jsonStore');
  const FILES = jsonStore.FILES || {};
  for (const c of ['aiSkill', 'aiSkillHistory', 'aiSkillEvidence', 'aiSkillRuns']) {
    check('S4 FILES 已注册集合 ' + c, !!FILES[c], String(FILES[c]));
  }
  const lim = jsonStore.AUTO_ARCHIVE_LIMITS || {};
  check('S4b aiSkillEvidence 配水位（防重演 aiAttempts 42MB 事故）', typeof lim.aiSkillEvidence === 'number');
  check('S4c aiSkillRuns 配水位', typeof lim.aiSkillRuns === 'number');
  check('S4d aiSkill 主记录刻意不设水位（规模 10²–10³）', lim.aiSkill === undefined);
}

// ── S5 静态断言：本阶段无执行接线（Skill 不驱动动作）────────────────────────
{
  for (const f of ['skillSchema.js', 'skillLifecycle.js', 'skillEvidence.js', 'skillBuilder.js']) {
    const src = fs.readFileSync(path.join(SKILL_DIR, f), 'utf8');
    check('S5 ' + f + ' 不引入工具层/运行时（无执行旁路）',
      src.indexOf("require('../tools')") < 0 && src.indexOf("require('../runtime')") < 0);
  }
}

console.log('\n=== 结果: ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail === 0 ? 0 : 1);
