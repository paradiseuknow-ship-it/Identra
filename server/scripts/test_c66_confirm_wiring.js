'use strict';
// C66 守护测试 —— 确认弹窗签名错配修复 + 恢复两步确认接线（C47 半成品收尾）。
// 缺陷背景（均为实锤 A/B 类，零浏览器可证）：
//   D1 A类 GovernancePanel：旧 confirmIt = requestConfirm || (msg => Promise.resolve(window.confirm(msg)))
//      但 App.requestConfirm(message, onConfirm) 是 callback 式且返回 undefined →
//      `await confirmIt(msg)` 恒 undefined → 撤销 API Key / 删除凭据引用两个破坏性操作
//      确认后永远静默 return（按钮点了没反应，功能完全失效）。
//   D2 B类 SettingsPanel：恢复流程仍走原生 window.confirm（C47 已证明自动化浏览器/部分
//      WebView 静默拦截恒 false → 恢复按钮是死的）；且 C47 引入的 pendingRestore 两步确认
//      UI 块从未接线 —— restoreBackup 从不 setPendingRestore，JSX 引用的 confirmRestore
//      函数在文件中不存在（靠 pendingRestore 恒 null 的短路才没在 render 时 ReferenceError）。
// 本测试（纯文件断言 + 结构校验，零浏览器、零网络、任意环境可跑）：
//   P1 GovernancePanel confirmIt 改 callback 桥接（不再有 await boolean 式调用）
//   P2 两个破坏性操作（revokeKey / removeSecretRef）都经 confirmIt(msg, onConfirm) 回调
//   P3 App 向 GovernancePanel 传 requestConfirm（应用内弹窗路径恒可达）
//   P4 SettingsPanel 恢复流程零原生 confirm；先解析校验后挂起；confirmRestore 真实存在
//   P5 挂起 UI 块与 confirmRestore / 取消按钮接线完整
//   P6 其余面板确认弹窗 callback 式语义回归锚（防本修复误伤）
//   P7 USER_GUIDE 恢复两步确认语义对账（防手册漂移）

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// C58 P7b 教训：注释里引用旧代码字样会污染字面匹配 —— 断言前剥离 // 与 /* */ 注释。
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

const govRaw = read('client/src/components/GovernancePanel.jsx');
const settingsRaw = read('client/src/components/SettingsPanel.jsx');
const gov = stripComments(govRaw);
const settings = stripComments(settingsRaw);
const app = read('client/src/App.jsx');
const guide = read('docs/USER_GUIDE.md');

(async () => {
  // ---- P1 confirmIt callback 桥接 ----
  // C74：confirmIt/requestConfirm 增加可选第三参 okLabel（撤销 API Key 自定义按钮文案），
  // 桥接契约是超集扩展 —— 正则放宽为允许尾部可选参数。
  chk('P1a confirmIt 为 callback 式定义 (msg, onConfirm[, okLabel])',
    /const\s+confirmIt\s*=\s*\(\s*msg\s*,\s*onConfirm\s*,?\s*(okLabel)?\s*\)\s*=>/.test(gov),
    'confirmIt 未改为 (msg, onConfirm) => 形式');
  chk('P1b confirmIt 桥接 requestConfirm(msg, onConfirm[, okLabel])',
    /requestConfirm\s*\(\s*msg\s*,\s*onConfirm\s*(,\s*okLabel)?\s*\)/.test(gov),
    '未桥接应用内确认弹窗');
  chk('P1c 不再存在 confirm 式调用（await confirmIt）',
    !/await\s+confirmIt\s*\(/.test(gov),
    '仍残留 await confirmIt(...) —— 签名错配缺陷未清除');
  chk('P1d 保留独立渲染回退分支（无 requestConfirm 时原生 confirm 才可达）',
    /else\s+if\s*\(\s*window\.confirm\s*\(\s*msg\s*\)\s*\)\s*onConfirm\s*\(\s*\)/.test(gov),
    '回退分支缺失');

  // ---- P2 破坏性操作走回调式确认 ----
  chk('P2a revokeKey 经 confirmIt(msg, onConfirm)',
    /confirmIt\s*\(\s*`撤销 API Key[^`]*`\s*,\s*async\s*\(\s*\)\s*=>/.test(gov),
    '撤销 API Key 未走回调式确认');
  chk('P2b removeSecretRef 经 confirmIt(msg, onConfirm)',
    /confirmIt\s*\(\s*'删除凭据引用[\s\S]{0,120}?async\s*\(\s*\)\s*=>/.test(gov),
    '删除凭据引用未走回调式确认');
  chk('P2c 撤销动作真实调用 revokeApiKey（回调体内）',
    /await\s+api\.revokeApiKey\s*\(\s*k\.id\s*\)/.test(gov),
    'revokeApiKey 调用丢失');
  chk('P2d 删除动作真实调用 deleteSecret（回调体内）',
    /await\s+api\.deleteSecret\s*\(\s*s\.id\s*\)/.test(gov),
    'deleteSecret 调用丢失');

  // ---- P3 App 传 requestConfirm ----
  chk('P3 App 向 GovernancePanel 传 requestConfirm',
    /<GovernancePanel[^>]*requestConfirm=\{requestConfirm\}/.test(app),
    'GovernancePanel 未接 requestConfirm（回退分支将成为唯一路径）');

  // ---- P4 SettingsPanel 恢复流程 ----
  chk('P4a 恢复流程零原生 window.confirm',
    !/window\.confirm/.test(settings),
    'SettingsPanel 仍含 window.confirm');
  {
    // restoreBackup 函数体：函数级闭括号为 2 空格缩进 `\n  }`，内层均 ≥4 空格
    const m = settingsRaw.match(/async\s+function\s+restoreBackup\s*\([\s\S]*?\n  \}/);
    chk('P4b restoreBackup 函数体存在', !!m, 'restoreBackup 未找到');
    if (m) {
      const body = m[0];
      const parseAt = body.indexOf('JSON.parse');
      const pendingAt = body.indexOf('setPendingRestore(');
      chk('P4c restoreBackup 先解析后挂起（parse 在 setPendingRestore 前）',
        parseAt !== -1 && pendingAt !== -1 && parseAt < pendingAt,
        '顺序不符：parse@' + parseAt + ' pending@' + pendingAt);
      chk('P4d 挂起前拒绝非对象快照（Array/原始值校验）',
        /Array\.isArray\(snapshot\)/.test(body) && /typeof\s+snapshot\s*!==\s*'object'/.test(body),
        '缺少快照形状校验（恶意/手改备份可直接进入挂起态）');
      chk('P4e 挂起载荷含 snapshot 与 name',
        /setPendingRestore\(\s*\{\s*name:\s*file\.name\s*,\s*snapshot\s*\}\s*\)/.test(body),
        '挂起载荷结构不符');
      chk('P4f restoreBackup 不再直接调用 restore API（两步语义）',
        !/api\.restoreBackup/.test(body),
        '选文件阶段就发恢复请求 = 单步恢复，两步确认形同虚设');
    }
  }
  chk('P4g confirmRestore 函数真实存在（C47 死引用收尾）',
    /async\s+function\s+confirmRestore\s*\(\s*\)/.test(settings),
    'confirmRestore 仍未定义（JSX 引用悬空）');
  {
    const m = settings.match(/async\s+function\s+confirmRestore\s*\(\s*\)\s*\{[\s\S]*?\n\s*\}/);
    if (m) {
      chk('P4h confirmRestore 真实调用 api.restoreBackup',
        /await\s+api\.restoreBackup\(/.test(m[0]), 'confirmRestore 未调用恢复 API');
      chk('P4i confirmRestore 执行后清理挂起态',
        /setPendingRestore\s*\(\s*null\s*\)/.test(m[0]), '挂起态未清理（重复恢复风险）');
    }
  }
  chk('P4j 恢复成功提示保留「建议重启」引导',
    /恢复完成[\s\S]*?重启服务/.test(settings), '重启引导丢失');

  // ---- P5 挂起 UI 块接线 ----
  chk('P5a 确认按钮 onClick={confirmRestore}',
    /onClick=\{confirmRestore\}/.test(settings), '确认按钮未接线');
  chk('P5b 取消按钮清空挂起态',
    /onClick=\{\(\)\s*=>\s*setPendingRestore\(null\)\}/.test(settings), '取消按钮未接线');
  chk('P5c 挂起块仅在 pendingRestore 存在时渲染（短路不误触 confirmRestore 引用）',
    /\{pendingRestore\s*&&\s*\(/.test(settings), '挂起块条件渲染缺失');

  // ---- P6 其余面板回归锚（callback 式语义不被误伤） ----
  const others = [
    ['TemplatesPanel', 'client/src/components/TemplatesPanel.jsx', /requestConfirm\s*\(\s*`[^`]*`?\s*,\s*async\s*\(\s*\)\s*=>/],
    ['ProxyPanel', 'client/src/components/ProxyPanel.jsx', /requestConfirm\s*\(\s*'[^']*'\s*,\s*async\s*\(\s*\)\s*=>/],
    ['SchedulesPanel', 'client/src/components/SchedulesPanel.jsx', /requestConfirm\s*\(\s*`[^`]*`?\s*,\s*async\s*\(\s*\)\s*=>/],
  ];
  for (const [name, rel, re] of others) {
    chk('P6 ' + name + ' callback 式确认保持', re.test(read(rel)), name + ' 确认语义疑似被改动');
  }

  // ---- P7 手册对账 ----
  chk('P7 USER_GUIDE 描述恢复两步确认语义',
    /恢复为两步确认|两步确认/.test(guide) && /确认恢复/.test(guide),
    '手册恢复流程描述与新交互漂移');

  console.log('\n=== C66 guard: ' + pass + ' passed, ' + fail + ' failed ===');
  if (fail) { failures.forEach((f) => console.log('  FAILED: ' + f)); process.exit(1); }
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
