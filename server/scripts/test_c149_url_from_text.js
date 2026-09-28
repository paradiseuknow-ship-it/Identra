'use strict';

// C149 守护：自然语言里的「无 scheme 裸域」必须能被提取为入口 URL。
//
// 缺陷背景（A 类真缺陷，2026-09-28 端到端实测，非推理）：
//   用户把网址写在目标文字里 —— 实测原文「注册并购买最便宜的月度会员（目标站点 sonymaxweb.com）」，
//   `targetUrl` 字段留空（`task_mue92wqu9fp3g` / `task_mue95y79eylwj`，2026-09-23）。
//   而启发式只认带 scheme 的完整 URL ⇒ `target` 恒为 null ⇒ 落库 `targetUrl` 为空
//   ⇒ Profile 推荐拿不到 site ⇒ `runtime.ensureBrowser` 硬失败「任务未绑定 Profile」
//   （519ms，不重试不升级）。**这是用户实例 4/5 次真实尝试的唯一致死点，横跨 10 天未被立项。**
//   注：C147 修的是「裸域填在 targetUrl 字段」这一形态（已生效）；本批补的是
//   「网址只在 objective 文字里」这一形态 —— C147 曾明确声明它「结构性不可验证、非缺陷」而未修。
//
// 本批方向（诚实声明）：
//   · **放宽**：`target` 的「可解析输入集合」扩大了 —— 无 scheme 的裸域 / IPv4 从
//     「恒为 null」变为「可提取」。这是修复本身的目的。真实语料暴露面：用户真实任务 8 条，
//     其中 2 条正落在此形态（改前 100% 硬失败）。
//   · **收紧**：无。未改任何既有判定、未删任何登记项。
//   · **未动**：带 scheme 的 URL（C102 入口保真 + 中文标点边界）、空目标、错误信息、
//     Profile 推荐算法、凭据闸 —— 一律未动。
//
// 安全边界（本批最大风险面）：`report.pdf` / `index.html` / `1.5` / `v2.0` / `3.14` 全都命中
//   「裸域形状」。一律当 URL 提取 ⇒ 凭空造出 `https://report.pdf` 这类不存在的入口 = 新缺陷类。
//   故按形状三重门控（末段全字母 → TLD 白名单 → 文件扩展名黑名单优先）。B 组双向断言。
//
// 判据按「内容形状 / 真实调用」建立，不按标识符枚举；A 组走**真实调用链**（parser → Router →
// taskManager），不是手写模拟。

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 数据根隔离（必须在首个 require 之前；否则会把夹具写进产品数据根）──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'c149_url_from_text_'));
process.env.FPB_DATA_DIR = TMP;

const ROOT = path.join(__dirname, '..', '..');

let pass = 0;
let fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
const j = (x) => { try { return JSON.stringify(x); } catch (e) { return String(x); } };

// 用户实例的**逐字原文**（不加工，直接取自语料）
const USER_MSG = '注册并购买最便宜的月度会员（目标站点 sonymaxweb.com）';
const USER_MSG_NO_URL = '注册并购买最便宜的月度会员';

(async function main() {
  const ui = require('../agent/urlIdentity.js');
  const parser = require('../agent/parser.js');
  const router = require('../agent/intelligence/router');
  const analyzer = require('../agent/intelligence/profile/profileAnalyzer');
  const taskManager = require('../agent/taskManager');

  // ── A 组：用户真实输入 → 端到端（真实调用链）────────────────────────────
  console.log('\n── A 组：用户真实输入 → 端到端（parser → Router → createTask）──');

  // 自足夹具：造一个对该站点有成功记录的 Profile（不依赖用户真实数据）
  const FIX_PID = 'p_c149_fixture';
  analyzer.ensure(FIX_PID, { name: 'C149 夹具环境' });
  analyzer.recordTaskOutcome(FIX_PID, 'sonymaxweb.com', true, { name: 'C149 夹具环境' });
  ok(analyzer.listRecords().length > 0, 'A0 夹具环境已就绪（反真空：Profile 评分库非空）');

  const pMock = await parser.parse(USER_MSG, { kind: 'mock' }, {});
  ok(pMock && pMock.target === 'https://sonymaxweb.com',
    'A1 启发式路径：用户真实输入被提取并归一化（改前恒 null）', j(pMock && pMock.target));

  // C96 防御路径（parser.js: LLM 丢 target 时启发式兜底合并）
  const dropProv = {
    kind: 'test-double',
    structured: async () => ({ objective: '注册并购买最便宜的月度会员', target: null, constraints: [], credentialRefs: [] }),
  };
  const pDrop = await parser.parse(USER_MSG, dropProv, {});
  ok(pDrop && pDrop.target === 'https://sonymaxweb.com',
    'A2 LLM 丢 target 时启发式兜底救回', j(pDrop && pDrop.target));

  const pid = router.recommendProfileId({
    objective: pMock.objective, targetUrl: pMock.target, region: null, constraints: [], profileId: null, useCache: false,
  });
  ok(pid === FIX_PID, 'A3 Router 能为此 targetUrl 绑定 Profile（改前恒 null ⇒ 状态链整段失效）', j(pid));

  const task = taskManager.createTask({
    name: (pMock.objective || '任务').slice(0, 20),
    objective: pMock.objective || USER_MSG,
    targetUrl: pMock.target || '',
    profileId: pid,
    executionMode: 'ASSIST',
    constraints: pMock.constraints || [],
  });
  ok(task.targetUrl === 'https://sonymaxweb.com' && !!task.profileId,
    'A4 落库 targetUrl 非空且 profileId 已绑定 ⇒ "任务未绑定 Profile" 前提被消除',
    j({ targetUrl: task.targetUrl, profileId: task.profileId }));

  // ── B 组：形状门控（双向；本批最大风险面）──────────────────────────────
  console.log('\n── B 组：形状门控双向（正例命中 / 反例不命中）──');

  const POS = [
    [USER_MSG, 'https://sonymaxweb.com'],
    ['去 example.com 注册', 'https://example.com'],
    ['看看 https://a.com/x 然后 www.b.org/y 也行', 'https://a.com/x'], // 带 scheme 优先
    ['在 try.webflow.com/t0wz830c5n4y 注册', 'https://try.webflow.com/t0wz830c5n4y'],
    ['站点是 127.0.0.1:8787 本地服务', 'http://127.0.0.1:8787'],
    ['目标：sonymaxweb.com。', 'https://sonymaxweb.com'], // 尾部中文句号剥离
  ];
  const posBad = POS
    .map(([txt, want]) => [txt, ui.extractBareUrl(txt), want])
    .filter(([, got, want]) => got !== want)
    .map(([txt, got, want]) => j(txt) + ' → ' + j(got) + '（期望 ' + j(want) + '）');
  ok(posBad.length === 0, 'B1 正例 ' + POS.length + ' 条全部命中（含带 scheme 优先 / IPv4 / 中文标点）', j(posBad));

  const NEG = [
    '把报告导出成 report.pdf',
    '修一下 index.html 的样式',
    '版本号从 1.5 升到 2.0',
    '算一下 3.14 的平方',
    '打开 README.md 看说明',
    '把数据写进 out.json',
    '上传 avatar.png',
    '这是一个没有网址的目标',
    'v2.0 发布了',
    '1.2.3 版本',
  ];
  const negBad = NEG.filter((t) => ui.extractBareUrl(t) !== null)
    .map((t) => t + ' → ' + j(ui.extractBareUrl(t)));
  ok(negBad.length === 0, 'B2 反例 ' + NEG.length + ' 条全部不命中（不臆造入口 = 不引入新缺陷类）', j(negBad));

  const DENY = ['a.md', 'x.py', 'y.rs', 'z.sh', 'w.json', 'q.html'];
  const denyBad = DENY.filter((t) => ui.extractBareUrl('目标 ' + t) !== null);
  ok(denyBad.length === 0, 'B3 文件扩展名黑名单优先于 TLD 白名单（与白名单交集项按文件处理）', j(denyBad));

  // ── C 组：未被放宽 ───────────────────────────────────────────────────
  console.log('\n── C 组：未被放宽（不臆造 / 不误伤）──');
  const pNone = await parser.parse(USER_MSG_NO_URL, { kind: 'mock' }, {});
  ok(pNone && pNone.target === null,
    'C1 目标里真的没有网址时仍为 null（绝不臆造入口）', j(pNone && pNone.target));
  ok(router.recommendProfileId({
    objective: USER_MSG_NO_URL, targetUrl: '', region: null, constraints: [], profileId: null, useCache: false,
  }) === null, 'C2 无 targetUrl 时仍不绑定 Profile（Profile 推荐面未被放宽）');
  const pScheme = await parser.parse(
    '打开 https://try.webflow.com/t0wz830c5n4y。注册会员，购买最便宜的月度会员', { kind: 'mock' }, {});
  ok(pScheme && pScheme.target === 'https://try.webflow.com/t0wz830c5n4y',
    'C3 C102 入口保真语义未变（中文句号剥离 + 取第一个为入口）', j(pScheme && pScheme.target));

  // ── D 组：唯一实现性（形状判据）──────────────────────────────────────
  console.log('\n── D 组：唯一实现性 ──');
  const uiSrc = fs.readFileSync(path.join(ROOT, 'server', 'agent', 'urlIdentity.js'), 'utf8');
  const uiCode = uiSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  ok(!/\brequire\s*\(/.test(uiCode),
    'D1 urlIdentity 仍是零依赖叶子（C142 A9 锚定的不变量未被破坏）');
  const parserSrc = fs.readFileSync(path.join(ROOT, 'server', 'agent', 'parser.js'), 'utf8');
  ok(/require\('\.\/urlIdentity'\)\.extractBareUrl\(/.test(parserSrc),
    'D2 parser 以**委托**形态使用提取器（不留第二份同义实现）');
  ok(/out\.target\s*=\s*require\('\.\/urlIdentity'\)\.normalizeUrl\(/.test(parserSrc),
    'D3 C147 A5 锚定的上游归一化点仍在（未被本批改动波及）');

  // ── E 组：判据分辨力（防真空 + 双向咬）──────────────────────────────
  console.log('\n── E 组：判据分辨力（防空）──');
  // 改前原文形状（逐字取自改动前的 parser.js 启发式）：只认带 scheme
  const OLD_URL_RE = /https?:\/\/[^\s"'\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+/i;
  ok(USER_MSG.match(OLD_URL_RE) === null,
    'E1 分辨力：用户原文不含 scheme ⇒ 改前启发式必然提取不到（若此条失败说明判据无分辨力）');
  ok(ui.extractBareUrl(USER_MSG) !== null && OLD_URL_RE.test('https://x.com'),
    'E2 正向对照：新判据命中旧判据漏掉的形态，且旧判据自身并非恒假');
  const NEG_PROBE = 'C149_NEGATIVE_CONTROL_MUST_NOT_EXIST';
  ok(POS.length >= 5 && NEG.length >= 8 && DENY.length >= 5 && parserSrc.indexOf(NEG_PROBE) < 0,
    'E3 反真空：正/反例集合非空且来源不同（' + POS.length + '/' + NEG.length + '/' + DENY.length + '）');

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

  console.log('\n=== C149 守护结果：通过 ' + pass + ' / 失败 ' + fail + ' ===');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('  FAIL 测试主体抛异常（其后断言从未执行）:: '
    + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)));
  console.log('\n=== C149 守护结果：通过 ' + pass + ' / 失败 ' + (fail + 1) + ' ===');
  process.exit(1);
});
