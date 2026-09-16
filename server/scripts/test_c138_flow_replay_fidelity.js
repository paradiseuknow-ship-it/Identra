'use strict';

/**
 * test_c138_flow_replay_fidelity.js
 *
 * C138 守护：把 testAgentPhase32 归因所依赖的三条**生产契约**钉住。
 *
 * 背景（C138 §A 归因结论）：Phase32 的 B2「二次同目标跳过 LLM」长期红，红因不是生产缺陷，
 * 而是**用例构造了生产不可发生的输入** —— 它的 LLM_PLAN 里 fill 既无 value 也无 credentialRef
 * （违反 schema/action.js:174），而生产 planner 出口强制 validatePlan（planner.js:465）⇒ 这种
 * plan 永远进不了系统、也永远落不成 flow；读侧 CAP-K1 守卫（tryFlowPlan 重建后先过 validatePlan）
 * 正确地拒绝了带病重放，于是断言红。归属证据：把同一 plan 的 fill 补成合法（credentialRef）后，
 * 整条复用链转绿（fromFlow=true / calls=1）。
 *
 * 为什么必须单独建守护：这个红项曾两次被登记为「可能为真缺陷（高优先级）」。若只修用例而不钉契约，
 * 未来任何一侧漂移（阈值被下调、读侧守卫被去掉、写侧丢字段）都会再次表现为「测试过时」而遭放宽。
 * 本守护断言的是**形状与行为**，不是数值快照：
 *   ① 「不可发生的输入」：契约层真的拒绝非法 fill / 敏感明文 value；用例 fixture 必须合法。
 *   ② 写读保真（CAP-K1）：stateFromStep → toPlan 往返保留可重放字段，动作类型不退化。
 *   ③ 复用入口守卫：高置信度但非法的 flow 必须被拒（降级 LLM），阈值仍锚在事实源 0.85。
 *
 * 隔离：FPB_DATA_DIR 指向 tmp（本守护会真实落库 flow，绝不能碰 server/data）。
 */

process.env.FPB_DATA_DIR = require('path').join(require('os').tmpdir(), 'c138_fidelity_' + Date.now());

const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../agent/store');
const taskManager = require('../agent/taskManager');
const fm = require('../agent/intelligence/flowMemory');
const fp = require('../agent/intelligence/flowPlanner');
const flowMatcher = require('../agent/intelligence/flowMatcher');
const { validatePlan } = require('../agent/schema/plan');

const ROOT = path.join(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server');
const PLANNER_PATH = path.join(SERVER, 'agent', 'planner.js');
const FLOWPLANNER_PATH = path.join(__dirname, '..', 'agent', 'intelligence', 'flowPlanner.js');
const PHASE32_PATH = path.join(__dirname, 'testAgentPhase32.js');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + (detail || '')); }
}

// 只剥**整行注释**（与 C135/C137 守护同一判据：内联注释里的示例属合法文档）
const stripComments = (s) => s.split('\n').filter((l) => {
  const t = l.trim();
  return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
}).join('\n');

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'data' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// ── fixture：与真实契约同形（每一条的形状已由 §A 探针实测过，不靠猜） ──────────────
function mkPlan(site, goal, fillTarget, fillExtra) {
  return {
    goal,
    steps: [
      { id: 'nav', type: 'NAVIGATE', description: 'open', expectedOutcome: 'o', risk: 'LOW', action: { type: 'navigate', target: { url: 'http://' + site + '/p' }, risk: 'LOW', verification: { type: 'page_change' } } },
      { id: 'fill_x', type: 'ACT', description: 'fill', expectedOutcome: 'o', risk: 'MEDIUM', action: Object.assign({ type: 'fill', target: fillTarget, risk: 'MEDIUM', verification: { type: 'page_change' } }, fillExtra) },
      { id: 'click_submit', type: 'ACT', description: 'submit', expectedOutcome: 'o', risk: 'MEDIUM', action: { type: 'click', target: { semantic: 'submit' }, risk: 'MEDIUM', verification: { type: 'page_change' } } },
    ],
  };
}
const LEGAL = mkPlan('fx-legal.test', 'g legal', { semantic: 'email_box', field: 'email' }, { credentialRef: 'cred_email' });
const WITHVAL = mkPlan('fx-val.test', 'g val', { semantic: 'query_box', field: 'search_query' }, { value: 'hello world' });
const SENSITIVE = mkPlan('fx-sec.test', 'g sec', { semantic: 'pwd_box', field: 'password' }, { value: 'secret123' });
const NOVALUE = mkPlan('fx-noval.test', 'g noval', { semantic: 'email_box' }, {});

function seedFlow(site, goal, plan) {
  const t = taskManager.createTask({ name: 'f', objective: goal, targetUrl: 'http://' + site + '/p', profileId: null, executionMode: 'AUTONOMOUS' });
  taskManager.attachPlan(t.id, plan);
  return fm.recordFlowFromTask(t);
}

// ── A「生产不可发生的输入」：契约与用例两侧都必须咬住 ────────────────────────────
{
  const plannerNc = stripComments(fs.readFileSync(PLANNER_PATH, 'utf8'));
  const i = plannerNc.indexOf('const vr = validatePlan(canonical);');
  const seg = i >= 0 ? plannerNc.slice(i, i + 260) : '';
  check('A1 planner 出口以 validatePlan 为终态门（未过即不产出 plan）',
    i >= 0 && /if \(vr\.ok\)/.test(seg),
    i >= 0 ? JSON.stringify(seg.replace(/\s+/g, ' ').slice(0, 110)) : '未找到 validatePlan(canonical)');

  const bad = validatePlan(NOVALUE);
  check('A2 ★ 契约层拒绝「fill 无 value/credentialRef」（旧用例的输入即此形态）',
    bad.ok === false && (bad.errors || []).some((e) => /fill 必须提供 value 或 credentialRef/.test(e)),
    (bad.errors || []).join(' | '));
  // 反向：合法 fill 必须过（防「一律拒绝」式假绿）
  check('A2b 反向上限：合法 fill（credentialRef）必须通过校验',
    validatePlan(LEGAL).ok === true, JSON.stringify(validatePlan(LEGAL).errors));

  const sec = validatePlan(SENSITIVE);
  check('A3 ★ 契约层拒绝敏感字段的 value 字面量（17-A 凭据红线在 schema 层的落地）',
    sec.ok === false && (sec.errors || []).some((e) => /敏感字段/.test(e)),
    (sec.errors || []).join(' | '));

  // 用例 fixture 不得退化成「不可发生的输入」
  const p32 = stripComments(fs.readFileSync(PHASE32_PATH, 'utf8'));
  const fillLine = (p32.match(/^.*id: 'fill_email'.*$/m) || [''])[0];
  check('A4 回归用例的 fill 步骤自身合法（含 credentialRef 或 value）',
    /credentialRef:|value:/.test(fillLine) && !/\.\.\./.test(fillLine),
    fillLine.replace(/\s+/g, ' ').slice(0, 130));
}

// ── B 写读保真（CAP-K1 核心不变量）──────────────────────────────────────────────
{
  store.write('aiFlowMemory', []);
  store.write('aiElementMemory', []);
  store.write('aiSiteMemory', []);

  // 防空：所有往返断言的地基 fixture 必须自身合法
  check('B0 前置：LEGAL fixture 通过 validatePlan（防空断言）', validatePlan(LEGAL).ok === true, '');

  const rec = seedFlow('fx-legal.test', 'g legal', LEGAL);
  check('B0b 前置：flow 真实落库且指标可复用（防空断言）',
    !!(rec && rec.id && rec.confidence >= 0.85), rec ? 'conf=' + rec.confidence : 'rec=null');

  const rebuilt = fm.toPlan(rec, 'http://fx-legal.test/p');
  const f = (rebuilt.steps || []).find((s) => s.action && s.action.type === 'fill');
  check('B1 ★ 动作类型不退化：fill 往返后仍是 fill（旧实现一律重建成 click）',
    !!f, f ? JSON.stringify(f.action) : JSON.stringify((rebuilt.steps || []).map((s) => s.action && s.action.type)));
  check('B1b ★ credentialRef 往返保留',
    !!(f && f.action.credentialRef === 'cred_email'), f && JSON.stringify(f.action));
  check('B1c 重建结果仍通过 validatePlan（读侧可重放）',
    validatePlan(rebuilt).ok === true, JSON.stringify(validatePlan(rebuilt).errors));
  check('B1d 禁止项不落库：重建产物无 selector/坐标/xpath',
    (rebuilt.steps || []).every((s) => !s.action.target.selector && !s.action.target.coordinates && !s.action.target.xpath), '');

  // 非敏感 value：允许往返（写读保真）
  const recV = seedFlow('fx-val.test', 'g val', WITHVAL);
  const rebuiltV = fm.toPlan(recV, 'http://fx-val.test/p');
  const fv = (rebuiltV.steps || []).find((s) => s.action && s.action.type === 'fill');
  check('B2 非敏感字段的 value 往返保留',
    !!(fv && fv.action.value === 'hello world'), fv && JSON.stringify(fv.action));

  // ★ 敏感明文：落库必须剥掉（凭据红线）
  const recS = seedFlow('fx-sec.test', 'g sec', SENSITIVE);
  const rawS = JSON.stringify(recS || {});
  check('B3 ★★ 敏感字段的 value 明文绝不落库（写侧剥离）',
    !/secret123/.test(rawS), 'len=' + rawS.length);
  // ★ 读侧纵深：即便绕过写侧门强行落库，重建后也无取值 ⇒ 重放被 validatePlan 拦下
  const rebuiltS = fm.toPlan(recS, 'http://fx-sec.test/p');
  const vs = validatePlan(rebuiltS);
  check('B3b ★★ 读侧纵深：敏感 flow 重建后无取值 ⇒ 仍被 validatePlan 拒绝（重放不了）',
    vs.ok === false && (vs.errors || []).some((e) => /必须提供 value 或 credentialRef/.test(e)),
    (vs.errors || []).join(' | '));
}

// ── C 复用入口守卫（行为）───────────────────────────────────────────────────────
{
  const hit = fp.tryFlowPlan('http://fx-legal.test/p', 'g legal');
  check('C1 合法高置信 flow ⇒ 复用入口命中', !!hit && hit.plan.fromFlow === true,
    hit ? 'conf=' + hit.confidence : 'null');
  check('C1b ★ 防真空绿：命中必须真的来自某条 flow（flowId 非空且回指落库记录）',
    !!(hit && hit.flowId && fm.getByKey('fx-legal.test', 'g legal') && fm.getByKey('fx-legal.test', 'g legal').id === hit.flowId),
    hit ? String(hit.flowId) : 'null');

  // ★ 高置信度 + 非法 ⇒ 必须拒绝（这正是 Phase32 旧用例命中的那条路）
  const legalRec = fm.getByKey('fx-legal.test', 'g legal');
  const stripped = JSON.parse(JSON.stringify(legalRec.states)).map((st) => {
    if (st.actionType === 'fill') { delete st.value; delete st.credentialRef; }
    return st;
  });
  const gRec = fm.recordFlow('guard.test', 'g illegal', stripped, { source: { type: 'ai_success' } });
  if (gRec.ok) fm.recordOutcomeFlow(gRec.flow.id, true); // 计成功 ⇒ 确保拦它的是契约而非阈值
  const gConf = fm.getByKey('guard.test', 'g illegal');
  const gHit = fp.tryFlowPlan('http://guard.test/p', 'g illegal');
  check('C2 ★★ 高置信度但非法的 flow 仍被复用入口拒绝（绝不带病重放）',
    !!(gConf && gConf.confidence >= 0.85) && gHit === null,
    'conf=' + (gConf && gConf.confidence) + ' hit=' + (gHit ? 'HIT' : 'null'));

  // 低置信度合法 ⇒ 不命中（阈值未被下调）
  fm.recordFlow('lowconf.test', 'g low', legalRec.states, { source: { type: 'ai_success' } });
  const low = fm.getByKey('lowconf.test', 'g low');
  check('C3 低置信度 flow 不命中（阈值未下调）',
    !!(low && low.confidence < 0.85) && fp.tryFlowPlan('http://lowconf.test/p', 'g low') === null,
    'conf=' + (low && low.confidence));

  check('C4 阈值锚在唯一事实源（flowMatcher.LOAD_THRESHOLD = 0.85）',
    fp.LOAD_THRESHOLD === flowMatcher.LOAD_THRESHOLD && flowMatcher.LOAD_THRESHOLD === 0.85 && fm.MIN_CONFIDENCE === 0.85,
    'planner=' + fp.LOAD_THRESHOLD + ' matcher=' + flowMatcher.LOAD_THRESHOLD + ' memory=' + fm.MIN_CONFIDENCE);
}

// ── D 单一事实源（防第二份实现）───────────────────────────────────────────────
{
  const files = walk(SERVER, []);
  const toPlanDefs = [];
  const readSideCallers = [];
  for (const f of files) {
    const s = stripComments(fs.readFileSync(f, 'utf8'));
    if (/function toPlan\s*\(/.test(s)) toPlanDefs.push(path.relative(ROOT, f));
    if (/validatePlan\(\s*[A-Za-z_$][\w$]*\.toPlan\(/.test(s)) readSideCallers.push(path.relative(ROOT, f));
  }
  check('D1 `toPlan` 全仓仅一个实现（无第二份重建逻辑）',
    toPlanDefs.length === 1 && /flowMemory\.js$/.test(toPlanDefs[0]), JSON.stringify(toPlanDefs));
  check('D2 读侧「重建后校验」只在 flowPlanner 一处（复用入口唯一）',
    readSideCallers.length === 1 && /flowPlanner\.js$/.test(readSideCallers[0]), JSON.stringify(readSideCallers));
}

// ── E 隔离 ──────────────────────────────────────────────────────────────────
{
  check('E1 本守护数据根已隔离到 tmp',
    /[\\/](Temp|tmp|t)[\\/]/i.test(String(process.env.FPB_DATA_DIR || '')),
    String(process.env.FPB_DATA_DIR || '').slice(-46));
  const src = fs.readFileSync(__filename, 'utf8').split('\n');
  const iso = src.findIndex((l) => /process\.env\.FPB_DATA_DIR\s*=/.test(l));
  const req = src.findIndex((l) => /^\s*(?:(?:const|let|var)\s+[^=]*=\s*)?require\(/.test(l));
  check('E2 隔离行先于首个 require（数据根为模块加载期解析）',
    iso >= 0 && req >= 0 && iso < req, 'iso=' + (iso + 1) + ' req=' + (req + 1));
}

console.log('\nPASS=' + pass + ' FAIL=' + fail + ' => ' + (fail === 0 ? 'TEST_OK' : 'TEST_FAILED'));
process.exit(fail ? 1 : 0);
