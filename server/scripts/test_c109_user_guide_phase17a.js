'use strict';
// C109 守护测试 —— USER_GUIDE PHASE 17-A / C96-C98 文档契约（docs-only 批，静态守护，零浏览器）。
//   手册新增内容（17-A 凭据授权闸 + 诊断六态 + C96/C97/C98 用户可见行为）必须与实现逐锚点对账：
//   P1 手册包含 6.1 节与新红线 bullet 的关键锚词
//   P2 凭据授权闸文档断言 ↔ runtime/tools 真实代码（CREDENTIAL_ACTION_BLOCKED → escalate 不重试不 repair）
//   P3 诊断六态表 ↔ diagnosisDecision.js STATES 逐键对账（文档声称的状态必须存在于代码，且 policy 语义一致）
//   P4 C96/C97/C98 文档断言 ↔ 真实代码锚点（llm/provider.js 追加式重试 / NewTaskModal planError 持久化 /
//      ProfileEditor 掩码回显）
//   P5 手册安全卫生（无 sk- 明文、nav 面板覆盖不回退——沿用 C34 契约）

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}

(async () => {
  const guidePath = path.join(ROOT, 'docs', 'USER_GUIDE.md');
  const guide = fs.readFileSync(guidePath, 'utf8');

  // ---- P1 手册新章节锚词 ----
  const docAnchors = [
    '6.1 为什么任务会交给人',
    'CREDENTIAL_ACTION_BLOCKED',
    '凭据授权闸',
    '诊断门',
    'TARGET_NOT_PRESENT_YET',
    'MULTI_STEP_FORM',
    'NAVIGATION_IN_PROGRESS',
    'CROSS_ORIGIN_DRIFT',
    'SECURITY_CHALLENGE',
    'TARGET_STALE',
    '目标保真（C96）',
    '规划失败持久展示（C97）',
    '已保存凭据只回显掩码（C98）',
    '保存失败内联持久化（C98）',
  ];
  const missDoc = docAnchors.filter((k) => !guide.includes(k));
  chk('P1 手册包含 6.1 节与全部新锚词（' + docAnchors.length + ' 个）', missDoc.length === 0, 'missing=' + missDoc.join(' / '));

  // ---- P2 凭据授权闸 ↔ 真实代码 ----
  const runtime = fs.readFileSync(path.join(ROOT, 'server', 'agent', 'runtime.js'), 'utf8');
  const tools = fs.readFileSync(path.join(ROOT, 'server', 'agent', 'tools.js'), 'utf8');
  const credAuth = fs.readFileSync(path.join(ROOT, 'server', 'agent', 'credentialAuthorization.js'), 'utf8');
  chk('P2a runtime 消费 CREDENTIAL_ACTION_BLOCKED', runtime.includes("errCode === 'CREDENTIAL_ACTION_BLOCKED'"), 'missing runtime branch');
  chk('P2b 阻断即转人工（taskManager.escalate + reason）', (() => {
    const i = runtime.indexOf("errCode === 'CREDENTIAL_ACTION_BLOCKED'");
    if (i < 0) return false;
    const seg = runtime.slice(i, i + 700);
    return seg.includes('taskManager.escalate') && seg.includes("{ reason: 'CREDENTIAL_ACTION_BLOCKED' }");
  })(), 'missing escalate-with-reason');
  chk('P2c 手册「不重试不修复」与 runtime 一致（escalate 前无 retry/repair 调用）', (() => {
    const i = runtime.indexOf("errCode === 'CREDENTIAL_ACTION_BLOCKED'");
    const seg = runtime.slice(i, i + 900);
    return !/repair|replan|retry/i.test(seg) && seg.includes('escalate');
  })(), 'blocked branch 里出现 retry/repair 语义或缺少 escalate');
  chk('P2d tools 侧闸门存在（kind: CREDENTIAL_ACTION_BLOCKED 取证）', tools.includes("kind: 'CREDENTIAL_ACTION_BLOCKED'"), 'missing tools evidence anchor');
  chk('P2e 授权闸 fail-closed 判定存在（authorizationCarryOver/origin 判定）', credAuth.includes('origin') && /fail/i.test(credAuth), 'credentialAuthorization.js 缺少 origin/fail 判定痕迹');

  // ---- P3 诊断六态 ↔ STATES 逐键对账 ----
  const diag = fs.readFileSync(path.join(ROOT, 'server', 'agent', 'diagnosisDecision.js'), 'utf8');
  const six = ['TARGET_NOT_PRESENT_YET', 'MULTI_STEP_FORM', 'NAVIGATION_IN_PROGRESS', 'CROSS_ORIGIN_DRIFT', 'SECURITY_CHALLENGE', 'TARGET_STALE'];
  const missState = six.filter((s) => !new RegExp('^\\s*' + s + ':\\s*\\{', 'm').test(diag));
  chk('P3a 代码 STATES 六态齐全', missState.length === 0, 'missing=' + missState.join(' / '));
  // 手册表格里的状态行 ↔ 代码 policy：CROSS_ORIGIN_DRIFT 与 SECURITY_CHALLENGE 必须 escalate:true（手册声称「立即交人」）
  chk('P3b CROSS_ORIGIN_DRIFT 立即交人（escalate:true）', /CROSS_ORIGIN_DRIFT:\s*\{[^}]*escalate:\s*true/.test(diag), 'policy 漂移');
  chk('P3c SECURITY_CHALLENGE 立即交人（escalate:true）', /SECURITY_CHALLENGE:\s*\{[^}]*escalate:\s*true/.test(diag), 'policy 漂移');
  // 手册声称 NAVIGATION_IN_PROGRESS「最多 2 次」 ↔ maxRepeats:2
  chk('P3d NAVIGATION_IN_PROGRESS maxRepeats=2 与手册一致', /NAVIGATION_IN_PROGRESS:\s*\{[^}]*maxRepeats:\s*2/.test(diag), 'policy 漂移');
  // 诊断门不是 Verification（手册未声称，但反向守卫：手册不得写「诊断保证成功」类表述）
  chk('P3e 手册未声称诊断即验证（无「诊断保证成功」类表述）', !guide.includes('诊断保证成功'), 'found overclaim');

  // ---- P4 C96/C97/C98 ↔ 真实代码锚点 ----
  const llmProvider = fs.readFileSync(path.join(ROOT, 'server', 'agent', 'llm', 'provider.js'), 'utf8');
  chk('P4a C96 重试在原始 prompt 上追加（不整体替换）', llmProvider.includes('C96'), 'llm/provider.js 缺少 C96 追加式重试锚点');
  const newTask = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'NewTaskModal.jsx'), 'utf8');
  chk('P4b C97 规划失败持久内联展示（planError state + 内联渲染）', newTask.includes('C97') && newTask.includes('planError') && /planError &&\s*\(/.test(newTask), 'NewTaskModal 缺少 C97 锚点');
  const profEd = fs.readFileSync(path.join(ROOT, 'client', 'src', 'components', 'ProfileEditor.jsx'), 'utf8');
  chk('P4c C98 掩码回显 + 空字段≠数据丢失', profEd.includes('C98') && profEd.includes('vaultSummary'), 'ProfileEditor 缺少 C98 锚点');

  // ---- P5 手册安全卫生（C34 契约不回退） ----
  chk('P5a 手册不含真实凭据明文', !/sk-[A-Za-z0-9]{8,}/.test(guide), 'found sk- literal');
  const appSrc = fs.readFileSync(path.join(ROOT, 'client', 'src', 'App.jsx'), 'utf8');
  const navTabs = [...appSrc.matchAll(/\['([a-z]+)',\s*'([^']+)',\s*</g)].map((m) => m[2]);
  const missTabs = navTabs.filter((label) => !guide.includes(label));
  chk('P5b 手册 nav 面板覆盖不回退（' + navTabs.length + ' 个）', missTabs.length === 0, 'missing=' + missTabs.join(' / '));

  console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
  if (failures.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
