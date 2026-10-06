'use strict';

// C170 — vault→credentialRef 自动接线**收口到任务唯一写入口**。
//
// 触发事件（C169 真实任务 task_muwco0lhxixif，真实环境、真实 LLM、真实浏览器）：
//   用户已在 profile「01」(p_muw9o4qjppz0) 的 vault 里配好 email / password / card，
//   任务却落库 `secretRefs: []`，执行记录 8 个动作 = navigate + 5×click + reload + wait，
//   **fill 动作数 = 0** —— 真实站点上「一个输入框都没填」。
//
// 根因（本测试锁定的契约）：
//   原 C99 接线写死在 `/api/ai/chat` 一条路由里（index.js 内联 ensureProfileRefs），
//   而 `POST /api/ai/tasks`、scheduleTrigger 派遣等**全部其余创建路径绕过**它。
//   后果是双重的：
//     ① planner 的「凭据字段契约」（test_credential_contract.js 锁定）以「任务挂载可用凭据」
//        为**前置条件**——清单为空 ⇒ 前置不成立 ⇒ 身份字段（email）允许 literal value
//        ⇒ 规划器编造邮箱；
//     ② runtime 凭据闸恒见空清单 ⇒ needsCredentials 恒成立。
//   ⇒ 「用户已配置凭据」这一产品承诺在规划链路上整体断裂。
//
// 修复：接线是「任务创建」的固有语义，与「谁发起创建」无关 ⇒ 收口到 taskManager.createTask
//   （任务唯一写入口，grep 实证 3 个调用点全部经此）。
//
// 纪律：断言真正执行的那份（真实 createTask + 真实 vault + 真实 secretManager），不 eval 源码；
//       不放宽任何门禁；revert 对照必须红（有分辨力）。

const os = require('os');
const path = require('path');
const fs = require('fs');

// ⚠️ 隔离必须在 require 任何 agent 模块**之前**（数据根为模块加载期解析）
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c170-'));
process.env.FPB_DATA_DIR = tmpData;
process.env.FPB_VAULT_FILE = path.join(tmpData, 'vault.json');
// 固定主密钥 → 确定性、无一次性密钥告警（32 字节 base64）
process.env.FPB_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

const assert = require('assert');
const ROOT = path.join(__dirname, '..', '..');

const taskManager = require('../agent/taskManager');
const secretManager = require('../agent/secretManager');
const vault = require('../vault');

const PROFILE_WITH = 'p_c170_with';
const PROFILE_WITHOUT = 'p_c170_without';

// 真实 vault 写入（走生产加密路径，非 monkeypatch）
vault.setProfileSecrets(PROFILE_WITH, {
  email: 'c170.tester@example.com',
  password: 'C170-pass-not-printed',
  card: { number: '4111111111116316', expMonth: '06', expYear: '2028', name: 'Bite Tester', cvv: '123' },
});

let pass = 0;
let fail = 0;
const failures = [];
function check(name, fn) {
  try {
    const r = fn();
    pass++;
    console.log('  PASS ' + name + (r ? ' :: ' + r : ''));
  } catch (e) {
    fail++;
    failures.push(name + ' :: ' + String(e.message || e).slice(0, 220));
    console.log('  FAIL ' + name + ' :: ' + String(e.message || e).slice(0, 220));
  }
}

// ── A 组：行为契约（真实 createTask）────────────────────────────────────
const created = [];
function mkTask(input) {
  const t = taskManager.createTask(input);
  created.push(t.id);
  return t;
}

check('A1 配了 vault 凭据的 profile → 任务 secretRefs 非空（真实写入口自动接线）', () => {
  const t = mkTask({ name: 'C170-A1', objective: '注册并订阅', targetUrl: 'https://app.spocket.co/signup', profileId: PROFILE_WITH });
  assert.ok(Array.isArray(t.secretRefs) && t.secretRefs.length >= 1,
    'secretRefs 应非空，实测=' + JSON.stringify(t.secretRefs));
  return 'refs=' + t.secretRefs.length;
});

check('A2 自动接线产出的引用**真实可用**（email_password + payment 均 available，且能解析出值）', () => {
  const t = created.length ? taskManager.getTask(created[0]) : null;
  const src = t ? t.secretRefs : [];
  const types = [];
  for (const ref of src) {
    const rec = secretManager.getByRef(ref);
    assert.ok(rec, 'ref 必须可查到记录: ' + ref);
    assert.strictEqual(rec.available, true, 'ref 必须 available=true（vault 有对应凭据）: ' + ref + '/' + rec.type);
    types.push(rec.type);
    const res = secretManager.resolve(ref);
    assert.ok(res && res.secrets, 'resolve 必须能取到 secrets（供执行层即时解密）: ' + ref);
    if (rec.type === 'email_password') assert.ok(res.secrets.email, 'email_password 必须含 email');
    if (rec.type === 'payment') assert.ok(res.secrets.card && res.secrets.card.number, 'payment 必须含 card.number');
  }
  assert.ok(types.includes('email_password'), '必须含 email_password，实测=' + types.join(','));
  assert.ok(types.includes('payment'), '必须含 payment，实测=' + types.join(','));
  return 'types=' + types.join('+');
});

check('A3 无 vault 凭据的 profile → 维持空清单（不凭空造引用；门禁语义不变）', () => {
  const t = mkTask({ name: 'C170-A3', objective: '注册', targetUrl: 'https://example.com/signup', profileId: PROFILE_WITHOUT });
  assert.deepStrictEqual(t.secretRefs, [], '无凭据不得造引用，实测=' + JSON.stringify(t.secretRefs));
  return 'refs=[]';
});

check('A4 profileId 缺失 → 不接线、不抛异常（fail-soft，不阻断创建）', () => {
  const t = mkTask({ name: 'C170-A4', objective: '只读浏览', targetUrl: 'https://example.com' });
  assert.deepStrictEqual(t.secretRefs, []);
  return 'refs=[] profileId=' + String(t.profileId);
});

check('A5 调用方显式传入的 secretRefs 与自动接线**合并去重**（既有能力不丢）', () => {
  const t = mkTask({
    name: 'C170-A5', objective: '注册', targetUrl: 'https://app.spocket.co/signup',
    profileId: PROFILE_WITH, secretRefs: ['cred_manual_x', 'cred_manual_x'],
  });
  assert.ok(t.secretRefs.includes('cred_manual_x'), '显式引用必须保留');
  assert.strictEqual(t.secretRefs.filter((r) => r === 'cred_manual_x').length, 1, '显式引用必须去重');
  assert.ok(t.secretRefs.length >= 2, '显式 + 自动应合并，实测=' + JSON.stringify(t.secretRefs));
  return 'refs=' + t.secretRefs.length;
});

check('A6 幂等：同一 profile 连续创建多次任务，凭据记录不重复膨胀', () => {
  const before = secretManager.listRecords().filter((r) => r.profileId === PROFILE_WITH).length;
  for (let i = 0; i < 3; i++) mkTask({ name: 'C170-A6-' + i, objective: '注册', targetUrl: 'https://app.spocket.co/signup', profileId: PROFILE_WITH });
  const after = secretManager.listRecords().filter((r) => r.profileId === PROFILE_WITH).length;
  assert.strictEqual(after, before, '重复创建不得新增凭据记录: before=' + before + ' after=' + after);
  return 'records=' + after;
});

// ── B 组：静态收口断言（防「只挂在某一条路由」的旧形态复活）──────────────
// ⚠️ 判据先剥注释：本仓的历史教训是设计文档写在文件头注释里，注释含 require 原文会虚高计数（L20 同族）。
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
function readSrc(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const tmSrc = readSrc(path.join('server', 'agent', 'taskManager.js'));
const idxSrc = readSrc(path.join('server', 'agent', 'index.js'));
const tmCode = stripComments(tmSrc);
const idxCode = stripComments(idxSrc);

check('B1 接线委托被 taskManager（唯一写入口）真实持有', () => {
  assert.ok(/ensureProfileRefs\s*\(/.test(tmCode), 'taskManager 必须调用 ensureProfileRefs');
  assert.ok(/_autoCredentialRefs/.test(tmCode), 'taskManager 必须持有 _autoCredentialRefs 委托');
  assert.ok(/secretRefs:\s*_autoCredentialRefs\s*\(/.test(tmCode),
    'createTask 落库的 secretRefs 必须取自 _autoCredentialRefs');
});

check('B2 路由层不得再内联接线（旧形态复活即红）', () => {
  const inline = (idxCode.match(/ensureProfileRefs\s*\(/g) || []).length;
  assert.strictEqual(inline, 0, 'index.js 不得内联调用 ensureProfileRefs（应委托 taskManager），实测=' + inline);
});

check('B3 旧形态已消失（回退到「原样透传 input.secretRefs」即红）', () => {
  const legacy = /secretRefs:\s*Array\.isArray\(input\.secretRefs\)\s*\?\s*input\.secretRefs\s*:\s*\[\]/.test(tmCode);
  assert.strictEqual(legacy, false, '不得存在「原样透传」的旧实现（它正是 C169 缺陷的代码形态）');
});

check('B4 全部创建路径都经 createTask（无旁路写入口）', () => {
  const hits = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) hits.push(p);
    }
  }
  walk(path.join(ROOT, 'server', 'agent'));
  const writers = hits
    .filter((p) => !p.endsWith(path.join('agent', 'taskManager.js')))
    .filter((p) => /function\s+createTask\s*\(/.test(stripComments(fs.readFileSync(p, 'utf8'))));
  assert.deepStrictEqual(writers, [], '不得在 taskManager 之外定义 createTask（否则存在旁路）：' + writers.join(','));
});

// ── C 组：revert 咬（断言必须有分辨力，否则是真空绿）────────────────────
check('C1 revert 对照：旧实现（原样透传 input.secretRefs）在同一场景必得空清单 → 断言有分辨力', () => {
  const legacyWire = (input) => (Array.isArray(input.secretRefs) ? input.secretRefs : []);
  const legacyRefs = legacyWire({ profileId: PROFILE_WITH, targetUrl: 'https://app.spocket.co/signup' });
  assert.deepStrictEqual(legacyRefs, [], '旧实现必须得空清单（与 A1 形成对照）');
  const prodRefs = mkTask({ name: 'C170-C1', objective: '注册', targetUrl: 'https://app.spocket.co/signup', profileId: PROFILE_WITH }).secretRefs;
  assert.ok(prodRefs.length >= 1, '生产实现必须非空');
  assert.notDeepStrictEqual(prodRefs, legacyRefs, '新旧必须可分辨');
  return 'legacy=[] prod=' + prodRefs.length;
});

// ── 清理（临时数据落在 os.tmpdir，绝不触碰真实 server/data）──────────────
try { vault.deleteProfileSecrets(PROFILE_WITH); } catch (e) {}

console.log('\nC170 credential wiring: PASS=' + pass + ' FAIL=' + fail);
if (fail) {
  console.log('失败项:');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
