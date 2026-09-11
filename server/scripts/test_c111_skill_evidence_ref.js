'use strict';
/**
 * C111 —— skillBuilder.persist 证据链引用一致性守护（零浏览器、零 LLM）。
 *
 * 缺陷背景（C111 实锤）：
 *   aiSkillEvidence 有水位 3000（jsonStore.AUTO_ARCHIVE_LIMITS），超过后最老 1/3
 *   被归档截尾移出主文件。既有 Skill 再次被观察时，若其 evidenceChainRef 指向的链
 *   已不在集合中（归档截尾 / 历史 Skill 无 ref），persist 会落一条**新链**，但
 *   skill.evidenceChainRef 仍指旧 id → 引用悬挂：
 *     - store.find(aiSkillEvidence, skill.evidenceChainRef) 恒 null；
 *     - 17-D SkillRouter / 证据消费方读证据链恒失败；
 *     - 本次观察新提炼的迁移记录虽落库却成为孤儿（Skill 不可达）。
 *   修复：persist 在确定 useChain 后一律 skill.evidenceChainRef = useChain.id。
 *
 * 隔离：本测试在 require 业务模块**之前**把 FPB_DATA_DIR 指向临时目录，
 * 并断言真实数据目录未被写入（c109 / 附录 C 的 T24 模式）。
 * AI_PROVIDER=mock 显式声明：本套件零 LLM、零浏览器。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 必须在 require 业务模块之前设置（store 单例在 require 时创建）──────────────
const TMP_DIR = path.join(os.tmpdir(), 'c111_skill_ref_' + Date.now());
process.env.FPB_DATA_DIR = TMP_DIR;
process.env.AI_PROVIDER = 'mock';
const REAL_DATA_DIR = path.join(__dirname, '..', 'data');
const realSkillFile = path.join(REAL_DATA_DIR, 'aiSkill.json');
const realBefore = fs.existsSync(realSkillFile) ? fs.statSync(realSkillFile).mtimeMs : null;

const store = require('../agent/storage');
const builder = require('../agent/skill/skillBuilder');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + detail); }
}

// ── fixture：与 c109 同构的「真实成功」轨迹（含可区分验证契约）────────────────
const ORIGIN = 'https://shop.example.test/search';
function makeTask(id, executionId) {
  return { id, targetUrl: ORIGIN, objective: '搜索商品', planGoal: 'search products',
    profileId: 'p_c111', currentExecutionId: executionId };
}
function makeSteps(taskId) {
  const step = (sid, index, type, description, action, status) => (
    { id: taskId + '_' + sid, taskId, index, type, description, risk: 'LOW', status: status || 'SUCCESS', action });
  return [
    step('step_001', 0, 'NAVIGATE', '打开搜索页', {
      type: 'navigate',
      target: { url: ORIGIN },
      verification: { type: 'url_contains', expect: '/search' },
    }),
    step('step_002', 1, 'ACT', '在搜索框输入关键词', {
      type: 'fill',
      target: { field: 'search', semantic: '搜索框' },
      value: 'shoes',
      verification: { type: 'element_present', target: { field: 'results' } },
    }),
    step('step_004', 2, 'ACT', '点击搜索按钮', {
      type: 'click',
      target: { field: 'searchBtn', semantic: '搜索按钮' },
      verification: { type: 'element_present', target: { field: 'searchBtn' } },
    }),
  ];
}
function seed(taskId, executionId) {
  const steps = makeSteps(taskId);
  steps.forEach((s) => store.insert('aiSteps', s));
  steps.forEach((s) => store.insert('aiAttempts', {
    id: 'att_' + s.id, stepId: s.id, taskId, executionId, status: 'SUCCESS',
    startedAt: 1000, endedAt: 2000,
  }));
  return steps;
}

// ── P-neg 机制对照：find 对缺失 id 确实返回 null（悬挂引用的失败机制）─────────
{
  check('P-neg store.find 对不存在的链 id 返回 null（悬挂引用的失败机制实锤）',
    store.find('aiSkillEvidence', 'evchain_definitely_not_present') === null);
}

// ── P0 首次观察：Skill + 证据链正常落库，引用可解析 ─────────────────────────
const TASK_A = makeTask('task_c111_a', 'exe_c111_1');
seed(TASK_A.id, TASK_A.currentExecutionId);
let SKILL_ID = null; let CHAIN_1 = null;
{
  const p = builder.observe(TASK_A);
  check('P0a observe 落库成功', p.ok === true, String(p.reason));
  const stored = p.ok ? store.find('aiSkill', p.skillId) : null;
  check('P0b store 中可读回 Skill 记录', !!stored);
  CHAIN_1 = stored ? stored.evidenceChainRef : null;
  check('P0c evidenceChainRef 指向真实存在的链（基线可解析）',
    !!CHAIN_1 && store.find('aiSkillEvidence', CHAIN_1) !== null, String(CHAIN_1));
  SKILL_ID = p.skillId;
}

// ── ★ P1 杀手：链被归档截尾后再观察，引用必须重指到新链（修复前恒悬挂）────────
{
  // 模拟水位归档：把 C1 移出集合（与 jsonStore.archiveOldest 同效——主文件不再含该记录）
  const before = store.read('aiSkillEvidence', []);
  store.write('aiSkillEvidence', before.filter((c) => c && c.id !== CHAIN_1));
  check('P1a 归档模拟完成：C1 已不在集合中',
    CHAIN_1 && store.find('aiSkillEvidence', CHAIN_1) === null, String(CHAIN_1));

  const TASK_B = makeTask('task_c111_b', 'exe_c111_2');
  seed(TASK_B.id, TASK_B.currentExecutionId);
  const p = builder.observe(TASK_B);
  check('P1b 第二次观察走真实 persist 路径且命中**同一条** Skill',
    p.ok === true && p.skillId === SKILL_ID, 'ok=' + p.ok + ' skillId=' + p.skillId);

  const stored = p.ok ? store.find('aiSkill', SKILL_ID) : null;
  check('P1c 修复后 evidenceChainRef 已重指（不再悬挂在已归档的 C1 上）',
    !!stored && stored.evidenceChainRef !== CHAIN_1, String(stored && stored.evidenceChainRef));
  const live = stored ? store.find('aiSkillEvidence', stored.evidenceChainRef) : null;
  check('P1d 重指后的链真实存在且含本次观察的迁移记录',
    !!live && Array.isArray(live.transitions) && live.transitions.length >= 3,
    live ? 'n=' + live.transitions.length : 'missing');
  check('P1e 新链挂到同一 Skill（skillId 正确回填）', !!live && live.skillId === SKILL_ID,
    String(live && live.skillId));
  check('P1f 第二次观察计入独立样本（samples.success=2）',
    !!stored && stored.samples && stored.samples.success === 2,
    stored ? String(stored.samples && stored.samples.success) : 'missing');
}

// ── P2 追加路径保持：既有链存活时引用不变、迁移追加 ─────────────────────────
{
  const storedBefore = store.find('aiSkill', SKILL_ID);
  const refBefore = storedBefore.evidenceChainRef;
  const lenBefore = store.find('aiSkillEvidence', refBefore).transitions.length;

  const TASK_C = makeTask('task_c111_c', 'exe_c111_3');
  seed(TASK_C.id, TASK_C.currentExecutionId);
  const p = builder.observe(TASK_C);
  check('P2a 第三次观察成功且仍命中同一条 Skill', p.ok === true && p.skillId === SKILL_ID,
    'ok=' + p.ok + ' skillId=' + p.skillId);

  const stored = store.find('aiSkill', SKILL_ID);
  const chain = store.find('aiSkillEvidence', stored.evidenceChainRef);
  check('P2b 既有链存活 → 引用保持不变（追加而非换链）',
    stored.evidenceChainRef === refBefore, refBefore + ' → ' + stored.evidenceChainRef);
  check('P2c 既有链迁移数增长（append-only）',
    chain.transitions.length === lenBefore + 3,
    lenBefore + ' → ' + chain.transitions.length);
}

// ── P3 历史 Skill 无 ref（null）：同样必须自愈到可解析 ─────────────────────
{
  const storedBefore = store.find('aiSkill', SKILL_ID);
  store.upsert('aiSkill', Object.assign({}, storedBefore, { evidenceChainRef: null }));
  check('P3a 已构造 evidenceChainRef=null 的历史形态', store.find('aiSkill', SKILL_ID).evidenceChainRef === null);

  const TASK_D = makeTask('task_c111_d', 'exe_c111_4');
  seed(TASK_D.id, TASK_D.currentExecutionId);
  const p = builder.observe(TASK_D);
  const stored = p.ok ? store.find('aiSkill', SKILL_ID) : null;
  const live = stored ? store.find('aiSkillEvidence', stored.evidenceChainRef) : null;
  check('P3b null ref 历史形态观察后自愈为可解析引用',
    !!stored && !!live, String(stored && stored.evidenceChainRef));
  check('P3c 自愈后的链同样挂接 skillId', !!live && live.skillId === SKILL_ID, String(live && live.skillId));
}

// ── X1 修复锚点源码断言（行为测试之外的双保险）──────────────────────────────
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'skill', 'skillBuilder.js'), 'utf8');
  check('X1 persist 源码含 evidenceChainRef 重指锚点',
    src.indexOf('skill.evidenceChainRef = useChain.id') >= 0);
  const iAssign = src.indexOf('skill.evidenceChainRef = useChain.id');
  const iUseChain = src.indexOf('useChain.skillId = skill.id');
  check('X2 重指发生在 useChain 解析之后（先定链、后挂引用）', iUseChain > 0 && iAssign > iUseChain,
    'useChain=' + iUseChain + ' assign=' + iAssign);
}

// ── T24 隔离：真实数据目录未被写入 ─────────────────────────────────────────
{
  check('T24a 已启用隔离数据目录', TMP_DIR.indexOf('c111_skill_ref_') >= 0
    && store.read('aiSkill', []).length > 0);
  check('T24b 隔离目录内确实落盘 aiSkill.json', fs.existsSync(path.join(TMP_DIR, 'aiSkill.json')));
  const realAfter = fs.existsSync(realSkillFile) ? fs.statSync(realSkillFile).mtimeMs : null;
  check('T24c 真实数据目录未被写入', realBefore === realAfter, 'before=' + realBefore + ' after=' + realAfter);
}

console.log('\n=== 结果: ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail === 0 ? 0 : 1);
