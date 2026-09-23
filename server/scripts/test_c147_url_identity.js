'use strict';

// C147 守护：URL 身份解析的**唯一实现性** + 归一化不变量 + 凭据闸未被放宽。
//
// 守护对象：新增的 `server/agent/urlIdentity.js` 与它的全部消费点。
//
// 缺陷背景（A 类真缺陷，2026-09-18 端到端实测，非推理）：
//   用户自然语言里的**裸域名**（`sonymaxweb.com`）是合法输入，LLM parser 原样返回为 target。
//   而下游每一处 URL→hostname 提取都直接 `new URL(url)` → 对裸域抛 TypeError → 被 catch 吞成
//   null ⇒「站点识别链」整段静默失效：
//     · Profile 推荐拿不到 site ⇒ profileId 恒 null ⇒ runtime.ensureBrowser 硬失败
//       （实测 task_mu7446n8rpge6：519ms / actions=[] / "任务未绑定 Profile"，不重试不升级）
//     · 五层记忆（Profile/Flow/Failure/Element/Site）全关
//     · 凭据闸 originOf(targetUrl) 为 null ⇒ 锚点缺失 ⇒ 凭据动作一律 AUTHORIZATION_CONTEXT_MISSING
//     · 入口归因保新静默跳过、302 入口验证放宽失效
//   同一份逻辑在库内被**复制了 8 次**（三个函数名、一份完全相同实现），修一处不修其余。
//
// 本批方向（诚实声明）：
//   · **放宽**：裸域/IPv4/裸域带端口的输入从此可被正确解析（改前恒为 null）—— 这是修复，
//     但确实扩大了「可解析输入集合」。真实语料暴露面：652 个任务中 targetUrl 为裸域的仅 2 例。
//   · **收紧**：无函数级收紧；`diagnosisDecision` 的跨域漂移判定此前因 th=null 被**跳过**
//     （对凭据动作 fail-open），归一化后该判定开始生效 —— 属消费点收紧。
//   · **未动**：已有 scheme 的 URL、相对路径、about:/data:/blob:/file:/fixture:/javascript:、
//     localhost（单标签主机名）、含空白文本 —— 一律原样返回，绝不猜测。
//
// 判据按「内容形状」建立（不按标识符枚举）：A 组扫描**库内是否还存在内联 hostname 提取**，
// 新增调用点自动被覆盖，不会出现覆盖面漂移；B/D 组用**真实调用**（非手写模拟）验证行为。

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

let pass = 0;
let fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
const j = (x) => { try { return JSON.stringify(x); } catch (e) { return String(x); } };

function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// 产品代码扫描面：server/ 下除 scripts/（套件自身）与 data/（运行时数据）之外的全部 .js
const PROD_ROOT = path.join(ROOT, 'server');
const SKIP_DIRS = new Set(['node_modules', 'scripts', 'data', '.git', '_phase12_backup', '_final100_backup']);
function walkJs(dir, out) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return; }
  for (const n of names) {
    const p = path.join(dir, n);
    let st = null;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (st.isDirectory()) { if (!SKIP_DIRS.has(n)) walkJs(p, out); continue; }
    if (!/\.js$/i.test(n)) continue;
    out.push(p);
  }
}
const PROD_FILES = [];
walkJs(PROD_ROOT, PROD_FILES);

// 形状：内联的 URL→hostname 提取（`new URL(...)` 结果上直接取 hostname）。
// 唯一实现里是「先返回 URL 对象、再由 hostOf 读取」的两步形态，命中不了本形状 —— 这正是收口语义。
const INLINE_HOSTNAME_RE = /new\s+URL\s*\([^)]*\)\s*\.\s*hostname/;

// 委托形态：require 唯一实现后调用其导出
const DELEGATE_RE = /urlIdentity'\)\s*\.\s*(hostOf|originOf|isOriginlessLocalContext|normalizeUrl|parseUrl)\s*\(/;

// 必须委托的消费点（改前各自持有一份同义实现）
const CONSUMERS = [
  ['server/agent/taskManager.js', 'siteOfUrl'],
  ['server/agent/tools.js', 'siteFromUrl'],
  ['server/agent/index.js', 'siteOfUrl'],
  ['server/agent/repair/repairManager.js', 'siteOf'],
  ['server/agent/intelligence/router/contextBuilder.js', 'siteOfUrl'],
  ['server/agent/intelligence/failure/failureAdvisor.js', 'siteOf'],
  ['server/agent/intelligence/profile/profileAdvisor.js', 'siteOf'],
  ['server/agent/intelligence/flowMemory.js', 'siteOf'],
  ['server/agent/credentialAuthorization.js', 'hostOf'],
  ['server/agent/credentialAuthorization.js', 'originOf'],
  ['server/agent/credentialAuthorization.js', 'isOriginlessLocalContext'],
  ['server/agent/diagnosisDecision.js', 'hostOf'],
  ['server/agent/memory.js', 'safeHost'],
  ['server/agent/sites/index.js', 'safeHost'],
  ['server/browserManager.js', 'isVerificationHost'],
  ['server/agent/skill/skillRouter.js', 'originOf'],
  // 由 A 组扫描面咬出的两处（复查确认同受该根因影响：裸域 ⇒ 解析失败 ⇒ 归因保新静默跳过）
  ['server/agent/runtime.js', 'entryDomainOf'],
  ['server/agent/runtime.js', 'isTrackedEntry'],
];

(async function main() {
  const ui = require('../agent/urlIdentity.js');
  const ca = require('../agent/credentialAuthorization.js');

  // ── A 组：唯一实现性（内容形状）────────────────────────────────────────────
  console.log('\n── A 组：唯一实现性（内容形状，非标识符枚举）──');
  ok(typeof ui.normalizeUrl === 'function' && typeof ui.hostOf === 'function'
    && typeof ui.originOf === 'function' && typeof ui.isOriginlessLocalContext === 'function',
    'A1 唯一实现导出面完整（normalizeUrl/hostOf/originOf/isOriginlessLocalContext）');

  const hits = [];
  for (const p of PROD_FILES) {
    const src = stripComments(fs.readFileSync(p, 'utf8'));
    if (INLINE_HOSTNAME_RE.test(src)) hits.push(path.relative(ROOT, p).split(path.sep).join('/'));
  }
  ok(hits.length === 0,
    'A2 产品代码中不存在内联 URL→hostname 提取（此前 8 处；新增点自动覆盖）', j(hits));

  ok(fs.existsSync(path.join(ROOT, 'server', 'agent', 'urlIdentity.js')),
    'A3 唯一实现文件在位（改前不存在 —— 本项在旧版必红，即判据有分辨力）');

  const notDelegated = [];
  for (const [rel, fn] of CONSUMERS) {
    const p = path.join(ROOT, ...rel.split('/'));
    let src = '';
    try { src = stripComments(fs.readFileSync(p, 'utf8')); } catch (e) { notDelegated.push(rel + ':' + fn + ' (文件不可读)'); continue; }
    const idx = src.indexOf('function ' + fn + '(');
    if (idx < 0) { notDelegated.push(rel + ':' + fn + ' (函数不存在)'); continue; }
    const body = src.slice(idx, idx + 500);
    if (!DELEGATE_RE.test(body)) notDelegated.push(rel + ':' + fn);
  }
  ok(notDelegated.length === 0,
    'A4 全部 ' + CONSUMERS.length + ' 个消费点均为委托形态（不留第二份同义实现）', j(notDelegated));

  const parserSrc = stripComments(fs.readFileSync(path.join(ROOT, 'server', 'agent', 'parser.js'), 'utf8'));
  ok(/out\.target\s*=\s*require\('\.\/urlIdentity'\)\.normalizeUrl\(/.test(parserSrc),
    'A5 parser 出口归一化 target（/chat 路径的上游收口点）');
  const tmSrc = stripComments(fs.readFileSync(path.join(ROOT, 'server', 'agent', 'taskManager.js'), 'utf8'));
  ok(/normalizeUrl\(input\.targetUrl/.test(tmSrc),
    'A6 taskManager.createTask 归一化 targetUrl（POST /tasks 与直调路径的上游收口点）');

  // ── B 组：归一化不变量（真实调用）──────────────────────────────────────────
  console.log('\n── B 组：归一化不变量 ──');
  ok(ui.normalizeUrl('sonymaxweb.com') === 'https://sonymaxweb.com'
    && ui.normalizeUrl('Example.COM') === 'https://Example.COM',
    'B1 裸域名补 https（保留用户书写的大小写，保真）');
  ok(ui.normalizeUrl('sonymaxweb.com:8443/x') === 'https://sonymaxweb.com:8443/x',
    'B2 裸域 + 端口不被误判为 scheme（RFC 3986 scheme 语法允许点号 —— 判定顺序是正确性关键）');
  ok(ui.normalizeUrl('127.0.0.1:8787') === 'http://127.0.0.1:8787',
    'B3 IPv4 字面量补 http（本地/自托管服务默认）');

  const UNTOUCHED = ['https://example.com', 'http://example.com/x?utm_source=a', 'HTTP://EXAMPLE.COM',
    'about:blank', 'data:text/html,hi', 'blob:https://x.com/u', 'file:///C:/a.html',
    'fixture:saas/login.html', 'javascript:void(0)', 'chrome://version',
    'localhost', 'localhost:3000', 'login', './rel/path', '//cdn.example.com/x', 'not a url', '中文目标', ''];
  const touched = UNTOUCHED.filter((s) => ui.normalizeUrl(s) !== s);
  ok(touched.length === 0, 'B4 非裸域形态一律原样返回（绝不猜测）', j(touched));

  const SAMPLES = ['sonymaxweb.com', 'https://a.b/c', 'about:blank', 'data:x,y', '127.0.0.1', '', 'login', null, 42, {}];
  const nonIdem = SAMPLES.filter((s) => {
    const a = ui.normalizeUrl(s);
    const b = ui.normalizeUrl(a);
    return typeof a === 'string' && typeof b === 'string' ? a !== b : !Object.is(a, b);
  });
  ok(nonIdem.length === 0, 'B5 幂等：normalizeUrl(normalizeUrl(x)) === normalizeUrl(x)', j(nonIdem));

  ok(ui.hostOf('SonyMaxWeb.com') === 'sonymaxweb.com' && ui.hostOf('sonymaxweb.com:8443/x') === 'sonymaxweb.com'
    && ui.hostOf('about:blank') === null && ui.hostOf('') === null && ui.hostOf(null) === null
    && ui.hostOf(42) === null && ui.hostOf({}) === null,
    'B6 hostOf：大小写归一 + 裸域可用 + 非 URL 形态返回 null（与 8 处旧副本口径一致）');
  ok(ui.originOf('sonymaxweb.com') === 'https://sonymaxweb.com'
    && ui.originOf('about:blank') === null && ui.originOf('') === null
    && ui.originOf('ftp://x.y/z') === 'ftp://x.y'
    && ui.originOf('ftp://x.y/z', { httpOnly: true }) === null,
    'B7 originOf：裸域可用、originless 为 null、httpOnly 收窄口径保留（Skill 层调用形态）');

  const originless = ['', '   ', 'about:blank', 'about:config', 'data:text/html,hi', 'blob:https://x/u', 'file:///C:/a'];
  ok(originless.every((s) => ui.isOriginlessLocalContext(s) === true)
    && ui.isOriginlessLocalContext('https://x.com') === false
    && ui.isOriginlessLocalContext('sonymaxweb.com') === false,
    'B8 isOriginlessLocalContext 语义未变（本地上下文集合逐项一致）');

  // ── C 组：上游接入的真实行为（走真实函数，非静态断言）──────────────────────
  console.log('\n── C 组：上游接入的真实行为 ──');
  {
    const parser = require('../agent/parser.js');
    const fakeProv = {
      kind: 'test-double',
      structured: async () => ({ objective: '注册并购买会员', target: 'sonymaxweb.com', constraints: [], credentialRefs: [] }),
    };
    const out = await parser.parse('注册并购买会员 sonymaxweb.com', fakeProv, {});
    ok(out && out.target === 'https://sonymaxweb.com',
      'C1 parser.parse（LLM 路径）出口把裸域 target 归一化为绝对 URL', j(out && out.target));
  }
  {
    // 数据根隔离（必须在 require 之前设置）
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c147-'));
    process.env.FPB_DATA_DIR = tmp;
    const tm = require('../agent/taskManager.js');
    const t1 = tm.createTask({ objective: 'C147 归一化取证', targetUrl: 'sonymaxweb.com' });
    const t2 = tm.createTask({ objective: 'C147 幂等取证', targetUrl: 'https://sonymaxweb.com' });
    const t3 = tm.createTask({ objective: 'C147 空值取证', targetUrl: '' });
    ok(t1.targetUrl === 'https://sonymaxweb.com',
      'C2 createTask 落库时归一化裸域 targetUrl', j(t1.targetUrl));
    ok(t2.targetUrl === 'https://sonymaxweb.com',
      'C3 createTask 对已是绝对 URL 的输入保持不变（no-op）', j(t2.targetUrl));
    ok(t3.targetUrl === '',
      'C4 createTask 对空 targetUrl 不臆造（保持空串）', j(t3.targetUrl));
  }

  // ── D 组：凭据闸未被放宽（fail-closed 对照，方向核对）──────────────────────
  console.log('\n── D 组：凭据闸未被放宽 ──');
  {
    const credAction = { type: 'fill', target: { field: 'password', value: 'x' }, value: 'x' };
    const ctx = ca.createContext({ task: { id: 'c147-d1', targetUrl: 'sonymaxweb.com' }, executionId: 'e1' });
    ok(ctx.anchorOrigin === 'https://sonymaxweb.com',
      'D1 裸域 targetUrl 的锚点 origin 现在可解析（改前 null ⇒ 凭据动作一律被拒，属功能死锁）',
      j(ctx.anchorOrigin));

    const rAnchor = ca.authorize({ context: ctx, pageUrl: 'https://sonymaxweb.com/login', action: credAction });
    ok(rAnchor.allowed === true && rAnchor.evidence.indexOf('origin_explicitly_authorized') >= 0,
      'D2 锚点 origin 上的凭据动作放行', j(rAnchor.reason));

    const rCross = ca.authorize({ context: ctx, pageUrl: 'https://evil.example/login', action: credAction });
    ok(rCross.allowed === false && rCross.reason === 'ORIGIN_NOT_AUTHORIZED',
      'D3 跨注册域仍严格拒绝（归一化没有放宽任何跨域面）', j(rCross.reason));

    const rBlank = ca.authorize({ context: ctx, pageUrl: 'about:blank', action: credAction });
    ok(rBlank.allowed === false && rBlank.reason === 'NO_ORIGIN_CONTEXT',
      'D4 about:blank 仍为 NO_ORIGIN_CONTEXT（未被当作已授权 origin 放行）', j(rBlank.reason));

    const rNoCtx = ca.authorize({ context: null, pageUrl: 'https://sonymaxweb.com/login', action: credAction });
    ok(rNoCtx.allowed === false && rNoCtx.reason === 'AUTHORIZATION_CONTEXT_MISSING',
      'D5 无授权上下文仍 fail closed', j(rNoCtx.reason));

    const rNonCred = ca.authorize({ context: ctx, pageUrl: 'https://evil.example/x', action: { type: 'click', target: { semantic: '搜索' } } });
    ok(rNonCred.allowed === true,
      'D6 非凭据动作不拦（红线 1：不得误伤普通控件）', j(rNonCred.reason));

    const rOAuth = ca.authorize({
      context: ctx,
      pageUrl: 'https://idp.other.example/oauth/authorize?client_id=a&response_type=code',
      action: credAction,
    });
    ok(rOAuth.allowed === false,
      'D7 第三方授权面仍拒绝（OAuth 不继承主站凭据授权）', j(rOAuth.reason));
  }

  // ── E 组：判据分辨力（防空 + 双向咬）──────────────────────────────────────
  console.log('\n── E 组：判据分辨力（防空）──');
  {
    // 改前原文片段（逐字取自改动前版本，用于证明形状判据确有分辨力）
    const OLD_SHAPE = 'try { return new URL(url).hostname || null; } catch (e) { return null; }';
    ok(INLINE_HOSTNAME_RE.test(OLD_SHAPE),
      'E1 分辨力：形状判据命中「改前原文」（若此条失败说明扫描器恒假）');
    ok(!INLINE_HOSTNAME_RE.test(stripComments(fs.readFileSync(path.join(ROOT, 'server', 'agent', 'urlIdentity.js'), 'utf8'))),
      'E2 正向对照：唯一实现自身按两步形态书写，不命中内联形状（收口语义成立）');

    const NEG = 'C147_NEGATIVE_CONTROL_MUST_NOT_EXIST';
    ok(PROD_FILES.every((p) => stripComments(fs.readFileSync(p, 'utf8')).indexOf(NEG) < 0),
      'E3 负向对照：伪造锚点在产品代码中不存在（扫描面非空且有分辨力）');
    ok(PROD_FILES.length > 50,
      'E4 反真空：产品代码扫描面非空', 'files=' + PROD_FILES.length);
  }

  console.log('\n=== C147 守护结果：通过 ' + pass + ' / 失败 ' + fail + ' ===');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('  FAIL 测试主体抛异常（其后断言从未执行）:: ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)));
  console.log('\n=== C147 守护结果：通过 ' + pass + ' / 失败 ' + (fail + 1) + ' ===');
  process.exit(1);
});
