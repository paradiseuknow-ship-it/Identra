'use strict';
/**
 * C121 —— 「文档数值声明 × 事实源」一致性自动化守护（零浏览器、零 LLM、零网络、零业务数据 require）。
 *
 * 缺陷背景（C120 登记，本套件 = 其「未做」项的兑现）：
 *   README「Native 身份架构（16-B）」能力行声明 6 个 patch ACTIVE，而事实源
 *   server/fp/nativePatchManifest.js 实为 10 个 enabled:true / status:ACTIVE
 *   ⇒ 文档静默落后 4 个 patch。漂移成因 = ★单调递增字段 × 人工快照 = 必然漂移：
 *   `enabled` 只 false→true（C120 确认该字段单调翻真），patch 走完全链在**外部 16-B
 *   窗口**翻真，不经过逐批 README 基线更新协议 ⇒ 人工快照无人强制同步。
 *
 *   C120 修了事实（6→10）但明确登记「未建自动化守护，候选入下批」——本套件即该候选。
 *
 * 守护策略：
 *   A 提取器自洽 —— 从真实 README.md 与 manifest 源码解析，不硬编码期望值
 *   B 硬不变量   —— README 声明数 === 事实源 ACTIVE 数（文本计数 × 模块行为双重 grounding）
 *   C 双向覆盖   —— 每个 ACTIVE patch 在 README 有 verbatim 标识符；每个 README 标识符
 *                  能映射回 ≥1 个 patch（防过期名字残留）
 *   D 事实源指针 —— README 指认的 manifest 路径真实存在且模块可 require、isPatchActive 可用
 *   E 防空断言   —— 提取器对人造输入返回预期值（非恒空/恒真）
 *   F 双向验证   —— 五探针精确咬住（计数漂移 / 新 patch 翻真 / 标识符缺失 / 指针断链 / no-op）
 *   G 隔离与文本面 —— stripComments 生效自检 + CRLF 容错
 *
 * ★ 边界登记（L9 原语缺口，如实不守护）：
 *   README「评估基准」行的 runRegression 套件计数（227）与 phase9 OK 计数**不在本守护范围**：
 *   ① 这些数字是**逐批基线协议**维护的快照——每批跑完双回归后由协议强制同步，自纠率高；
 *   ② 套件数是**自引用量**——本套件自身入库即使其 +1，任何「声明数 === 当前数」的自动断言
 *      会在自己入库的下一刻变红（C119 G3 同源教训）。正解不是断言数字相等，而是依赖
 *      逐批协议 + c48 P5 的模式级守卫（**N/0** + OK=N/BAD=0 必须存在于 README）。
 *   「enabled 计数」不同：它只在 16-B 外部窗口翻真、不经过逐批协议 ⇒ 正是无人守护的
 *   漂移面，也是 C120 真实事故的发生地。本套件只守护「协议外单调字段」。
 *
 * 锚点上移（L3）：本批同时把 README 16-B 列表从人写描述名（「CDP platform 让位回退」
 *   「hardwareConcurrency」）升级为 verbatim patchId/surface——人写别名既不能被严格
 *   匹配，也是漂移土壤本身。守护自此只认事实源里的规范标识符。
 *
 * 隔离：require 的 nativePatchManifest.js 为纯数据模块（零 I/O、零副作用）；
 * FPB_DATA_DIR / AI_PROVIDER=mock 显式声明以固化环境契约。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.FPB_DATA_DIR = path.join(os.tmpdir(), 'c121_doc_fact_' + Date.now());
process.env.AI_PROVIDER = 'mock';

const ROOT = path.join(__dirname, '..', '..');
const README_PATH = path.join(ROOT, 'README.md');
const MANIFEST_PATH = path.join(ROOT, 'server', 'fp', 'nativePatchManifest.js');

let pass = 0; let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + (detail || '')); }
}
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ══════════════════════════════════════════════════════════════════════════════
// 提取器（纯函数，供真实文件与探针共用）
// ══════════════════════════════════════════════════════════════════════════════

// 事实源文本计数：stripComments 后统计 enabled:true / status:'ACTIVE'
function countActiveInManifestSrc(src) {
  const code = strip(src);
  const en = (code.match(/enabled:\s*true/g) || []).length;
  const st = (code.match(/status:\s*'ACTIVE'/g) || []).length;
  return { enabledTrue: en, statusActive: st };
}

// 提取 manifest 源码中每个 patch 的 patchId 与 surface（规范标识符）
function extractPatchIdentities(src) {
  const code = strip(src);
  const out = [];
  const blocks = code.split(/patchId:/).slice(1);
  for (const b of blocks) {
    const pid = (b.match(/^\s*'([^']+)'/) || [])[1];
    const surf = (b.match(/surface:\s*'([^']+)'/) || [])[1];
    if (pid) out.push({ patchId: pid, surface: surf || null });
  }
  return out;
}

// README 能力行声明：N 与（item / item / ...）列表
function parseReadmeClaim(readmeText) {
  const line = readmeText.split(/\r?\n/).find((l) => l.includes('Native 身份架构（16-B）'));
  if (!line) return null;
  const n = (line.match(/\*\*(\d+)\s*个\s*Chromium native patch 全 ACTIVE\*\*/) || [])[1];
  const itemsM = line.match(/全 ACTIVE\*\*（([^）]+)）/);
  const ptr = (line.match(/`([^`]*nativePatchManifest\.js)`/) || [])[1];
  if (n === undefined || !itemsM) return null;
  return {
    claimedCount: Number(n),
    items: itemsM[1].split('/').map((s) => s.trim()).filter(Boolean),
    factSourcePtr: ptr || null,
  };
}

// 核心验证：声明数 × 事实源 ACTIVE 数 × 双向标识符覆盖 × 指针存在
function verify(readmeText, manifestSrc) {
  const claim = parseReadmeClaim(readmeText);
  const cnt = countActiveInManifestSrc(manifestSrc);
  const ids = extractPatchIdentities(manifestSrc);
  const r = {
    claimParsed: !!claim, claim: claim, counts: cnt, idsCount: ids.length,
    countOk: false, textCrossOk: false, missingInReadme: [], unknownItems: [],
    pointerOk: false, fs: require('fs'),
  };
  if (!claim) return r;
  r.countOk = claim.claimedCount === cnt.enabledTrue;
  r.textCrossOk = cnt.enabledTrue === cnt.statusActive;
  const joined = claim.items.join(' | ').toLowerCase();
  for (const p of ids) {
    const hit = (p.patchId && joined.includes(p.patchId.toLowerCase())) ||
                (p.surface && joined.includes(p.surface.toLowerCase()));
    if (!hit) r.missingInReadme.push(p.patchId);
  }
  for (const it of claim.items) {
    const low = it.toLowerCase();
    const known = ids.some((p) =>
      (p.patchId && p.patchId.toLowerCase().includes(low)) ||
      (p.surface && p.surface.toLowerCase().includes(low)));
    if (!known) r.unknownItems.push(it);
  }
  r.pointerOk = !!claim.factSourcePtr && fs.existsSync(path.join(ROOT, claim.factSourcePtr));
  return r;
}

// ══════════════════════════════════════════════════════════════════════════════
// A/B/C/D —— 真实文件验证
// ══════════════════════════════════════════════════════════════════════════════

const readmeText = fs.readFileSync(README_PATH, 'utf8');
const manifestSrc = fs.readFileSync(MANIFEST_PATH, 'utf8');
const real = verify(readmeText, manifestSrc);
// 行为 grounding：require 真实模块（纯数据模块），isPatchActive 真实判定
const manifest = require(MANIFEST_PATH);
const activePatches = manifest.PATCHES.filter((p) => manifest.isPatchActive(p.patchId));

check('A1 README 16-B 能力行可解析', real.claimParsed,
  'claimed=' + (real.claim ? real.claim.claimedCount : 'null') + ' items=' + (real.claim ? real.claim.items.length : 0));
check('A2 manifest 文本提取 patchId/surface 对 = 10', real.idsCount === 10, 'ids=' + real.idsCount);
check('B1 ★ README 声明数 === 事实源 enabled:true 数（C120 事故断言）', real.countOk,
  'claimed=' + (real.claim ? real.claim.claimedCount : '?') + ' actual=' + real.counts.enabledTrue);
check('B2 文本计数交叉一致 enabled:true === status:ACTIVE', real.textCrossOk,
  JSON.stringify(real.counts));
check('B3 模块行为 grounding：isPatchActive 数 === 文本计数 === 声明数',
  activePatches.length === real.counts.enabledTrue && real.counts.enabledTrue === (real.claim ? real.claim.claimedCount : -1),
  'module=' + activePatches.length);
check('B4 enabledPatchesInDependencyOrder() 数 === ACTIVE 数',
  manifest.enabledPatchesInDependencyOrder().length === activePatches.length);
check('C1 正向覆盖：每个 ACTIVE patch 在 README 有 verbatim 标识符', real.missingInReadme.length === 0,
  'missing=' + JSON.stringify(real.missingInReadme));
check('C2 反向覆盖：每个 README 标识符映射回 ≥1 个 patch（防过期名残留）', real.unknownItems.length === 0,
  'unknown=' + JSON.stringify(real.unknownItems));
check('D1 README 事实源指针指向真实存在的文件', real.pointerOk, 'ptr=' + (real.claim ? real.claim.factSourcePtr : null));
check('D2 manifest 模块导出面可用（PATCHES/isPatchActive）',
  Array.isArray(manifest.PATCHES) && typeof manifest.isPatchActive === 'function');
check('D3 isPatchActive 真实契约：enabled 为唯一激活源 + 未知 id fail-loud',
  manifest.isPatchActive('identity-config-plumbing') === true &&
  (() => { try { manifest.isPatchActive('ghost-patch-xyz'); return false; } catch (e) { return String(e).indexOf('未知 patch') !== -1; } })() &&
  manifestSrc.indexOf('FPB_FORCE_ACTIVE_PATCHES') !== -1);

// ══════════════════════════════════════════════════════════════════════════════
// E/F —— 防空断言 + 双向验证探针（合成输入，精确咬住）
// ══════════════════════════════════════════════════════════════════════════════

// 人造 README/manifest（运行时拼接，防测试数据污染本文件文本面——C119 G3/G4 同源纪律）
const SYN_ITEMS = ['patch-a', 'navigator.x', 'patch-c'].join(' / ');
const synReadme = '| Native 身份架构（16-B） | **3 个 Chromium native patch 全 ACTIVE**（' + SYN_ITEMS +
  '）；`server/fp/nativePatchManifest.js` 为**唯一事实源** |';
const synManifest = strip([
  "const PATCHES = [",
  "  { patchId: 'patch-a', surface: 'identity.pipeline', enabled: true, status: 'ACTIVE' },",
  "  { patchId: 'patch-b', surface: 'navigator.x', enabled: true, status: 'ACTIVE' },",
  "  { patchId: 'patch-c', surface: 'navigator.y', enabled: true, status: 'ACTIVE' },",
  "];",
].join('\n'));

const e1 = verify(synReadme, synManifest);
check('E1 合成输入解析非空（防空断言）', e1.claimParsed && e1.claim.items.length === 3,
  'items=' + (e1.claim ? e1.claim.items.length : 0));
check('E2 合成文本计数 = 3', e1.counts.enabledTrue === 3 && e1.counts.statusActive === 3,
  JSON.stringify(e1.counts));

// P1 计数漂移（C120 事故形态：声明 9 实际 10）
const p1 = verify(synReadme.replace('**3 个', '**9 个'), synManifest);
check('F1 探针 P1 声明数漂移 → countOk 精确红', !p1.countOk && p1.claim.claimedCount === 9);

// P2 新 patch 翻真未同步 README（C120 漂移的真实发生路径）
const p2 = verify(synReadme, synManifest + "\n  { patchId: 'patch-d', surface: 'navigator.z', enabled: true, status: 'ACTIVE' },\n");
check('F2 探针 P2 新 patch 翻真 → countOk 红 + 正向覆盖红', !p2.countOk && p2.missingInReadme.includes('patch-d'));

// P3 README 标识符缺失（列表漏一个 patch）
const p3 = verify(synReadme.replace(' / patch-c', ''), synManifest);
check('F3 探针 P3 标识符缺失 → missingInReadme 精确命中 patch-c',
  p3.missingInReadme.length === 1 && p3.missingInReadme[0] === 'patch-c');

// P4 事实源指针断链
const p4 = verify(synReadme.replace('server/fp/nativePatchManifest.js', 'server/fp/ghost_manifest.js'), synManifest);
check('F4 探针 P4 指针断链 → pointerOk 红', !p4.pointerOk);

// P5 no-op 对照：合成基线本身全绿（探针红是「变异」导致，非提取器病态）
check('F5 探针 P5 no-op 对照：合成基线 countOk+双向覆盖全绿',
  e1.countOk && e1.missingInReadme.length === 0 && e1.unknownItems.length === 0);

// ══════════════════════════════════════════════════════════════════════════════
// G —— 隔离与文本面
// ══════════════════════════════════════════════════════════════════════════════

check('G1 stripComments 生效：注释内的 enabled:true 不计入',
  countActiveInManifestSrc('/* enabled: true */ enabled: true, // status: \'ACTIVE\'\nstatus: \'ACTIVE\'').enabledTrue === 1,
  '注释污染会使文本计数虚高');
check('G2 CRLF 容错：\\r\\n 行尾的 README 可解析',
  !!parseReadmeClaim(synReadme.replace(/\n/g, '\r\n')));
check('G3 真实 README 非空且为本仓文件', readmeText.length > 1000 && readmeText.includes('功能总览'));
check('G4 本套件零业务数据写入：FPB_DATA_DIR 指向 tmp',
  process.env.FPB_DATA_DIR.indexOf(os.tmpdir()) === 0);

console.log('\n==== C121 RESULT: PASS=' + pass + ' FAIL=' + fail + ' ====');
process.exit(fail === 0 ? 0 : 1);
