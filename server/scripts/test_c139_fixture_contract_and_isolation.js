'use strict';

// C139 守护：EX-06（testAgentPhase31 fixture 语义契约 + 崩溃面）与 EX-08（testAgentPhase34 数据根口径）的归因结论钉。
//
// 本批归属结论：
//   EX-06 = C105 F1「零证据兜底出局」**有意收紧**推翻旧 fixture 假设（语义/标签零词法关联也能命中）
//           ⇒ 测试过时（生产零改动）。旧测试另有两个自身缺陷：无 null 守卫（崩溃吃掉下游断言）、
//           异常路径自赋值 no-op（spy 不还原）。
//   EX-08 = 套件内 realProfileIds() 硬编码真实路径，是**第二份数据根口径** ⇒ 隔离不覆盖白名单
//           ⇒ 遗留真实 profile 进入 region 候选组。收口 = 委托 dataRoot()。
//
// 设计纪律：真实调用优先；静态断言必须带**上下文消歧**（L18）与**反向合成样本**（L17 双向咬），
// 并进行**防空断言**（fixture 非空），避免「空集/零候选恒真」式真空绿。
process.env.FPB_DATA_DIR = require('path').join(require('os').tmpdir(), 'c139_guard_' + Date.now());

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = path.resolve(__dirname, '..', '..');
const SCRIPTS = path.join(__dirname);
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name + (extra != null ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('  ✘ ' + name + (extra != null ? '  [' + extra + ']' : '')); }
}

// L18：逐字同形必须靠上下文锁位 —— 返回「该行紧随的下一行」
function lineAfter(src, needle) {
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(needle)) return lines[i + 1] || '';
  return null;
}
function lineIndexOf(src, needle) {
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(needle)) return i + 1;
  return -1;
}

const F1 = { semanticResolver: read('server/agent/semanticResolver.js') };
const P31 = { src: read('server/scripts/testAgentPhase31.js') };
const P34 = { src: read('server/scripts/testAgentPhase34.js') };

async function main() {
  console.log('== C139 守护：fixture 语义契约 + 数据根口径 ==\n');

  // ───────────────────────── A. C105 F1 零证据拒点（生产契约，真实调用双向）─────────────────────────
  console.log('[A] C105 F1 零证据拒点（真实调用）');
  {
    const semanticResolver = require(path.join(REPO, 'server/agent/semanticResolver'));
    const tools = require(path.join(REPO, 'server/agent/tools'));

    const elContinue = { id: 'g1', role: 'button', tag: 'button', text: 'Continue', visible: true };
    const elSubmit = { id: 'g2', role: 'button', tag: 'button', text: 'Submit', visible: true };
    const obsZero = { url: 'http://f1.test/form', elements: [elContinue] };
    const obsEvid = { url: 'http://f1.test/form', elements: [elSubmit] };

    // 防空：fixture 必须真带元素与非空文本，否则「零候选/恒 null」式假绿
    ok(obsZero.elements.length === 1 && String(obsZero.elements[0].text).length > 0
      && obsEvid.elements.length === 1 && String(obsEvid.elements[0].text).length > 0,
      'A0 防空：两组 observation 均含 1 个带非空文本的元素');

    const candsZero = semanticResolver.resolve({ semantic: 'submit' }, obsZero);
    ok(candsZero.length === 0, 'A1 零证据（submit vs Continue）⇒ 候选集为空', 'n=' + candsZero.length);

    const rZero = await tools.resolveSelector({ type: 'click', target: { semantic: 'submit' } }, obsZero);
    ok(rZero === null, 'A2 零证据 ⇒ resolveSelector 返回 null（快速失败，交恢复链）', rZero ? JSON.stringify(rZero) : 'null');

    const candsEvid = semanticResolver.resolve({ semantic: 'submit' }, obsEvid);
    ok(candsEvid.length >= 1, 'A3 正向对照（submit vs Submit）⇒ 必须出候选（防「一律拒绝」假绿）', 'n=' + candsEvid.length);
    const rEvid = await tools.resolveSelector({ type: 'click', target: { semantic: 'submit' } }, obsEvid);
    ok(!!(rEvid && rEvid.selector), 'A4 正向对照 ⇒ resolveSelector 返回可用 selector', rEvid ? rEvid.selector : 'null');

    // A5 结构（shape + revert 双向咬）：F1 兜底块必须以 lexical 为条件，且不得恒真
    const checkGate = (src) => {
      const i1 = src.indexOf('const lexical = semTokens.some(');
      const i2 = src.indexOf('if (lexical) { score = 0.4;');
      const i3 = src.indexOf('if (lexical === true)');
      const forced = /lexical\s*=\s*true\s*;/.test(src) || /if\s*\(\s*true\s*\)\s*\{\s*score = 0\.4/.test(src);
      return i1 > 0 && i2 > i1 && i3 < 0 && !forced;
    };
    ok(checkGate(F1.semanticResolver), 'A5 F1 兜底块以 lexical（token 相交）为条件（shape 在场）');
    // revert：把条件改成恒真 ⇒ 必须被检出
    ok(!checkGate(F1.semanticResolver.replace('if (lexical) { score = 0.4;', () => 'if (true) { score = 0.4;')),
      'A5b revert：条件改为恒真后必须被判否（防只检「字符串在场」的假绿）');
    // missing：整块删除 ⇒ 必须被检出
    ok(!checkGate(F1.semanticResolver.replace('const lexical = semTokens.some(', () => 'const lexicalRemoved = (')),
      'A5c missing：词法判定被删后必须被判否（覆盖面双向咬）');

    // A6 F1 的语义词表必须仍覆盖本套件涉及的语义（submit），否则 fixture 语义失去意义
    ok(/submit\|continue\|next\|proceed/.test(F1.semanticResolver), 'A6 F1 兜底动作语义词表仍含 submit/continue/next/proceed');
  }

  // ───────────────────────── B. fixture 语义契约（本批新不变量）─────────────────────────
  console.log('\n[B] Phase31 fixture 语义契约');
  {
    const s = P31.src;
    ok(/const SEM = 'submit signup';/.test(s), "B1 纯逻辑段使用 2-token 语义常量 SEM = 'submit signup'");
    const hasSubmitLabel = /text: 'Submit', visible: true/.test(s);
    const hasSignupLabel = /text: 'Signup', visible: true/.test(s);
    ok(hasSubmitLabel && hasSignupLabel, 'B2 两个标签各自带一个不同 token（Submit / Signup）');
    // ★ 关键不变量：两个标签互不包含 —— 否则 elementMemory.matchPattern 的 includes 会直接命中，
    //   「标签变更 → 记忆不匹配 → 新 pattern 演化」这条链就测不到了（会退化成命中反而变绿）。
    ok(!'Signup'.toLowerCase().includes('submit') && !'Submit'.toLowerCase().includes('signup'),
      'B3 两标签互不包含（保证 pattern 演化链可测）');
    // 词法关联：语义 token 与标签 token 相交（与 A1/A3 同口径，用真实 tokenize 复核）
    const semanticResolver = require(path.join(REPO, 'server/agent/semanticResolver'));
    const tokSem = new Set(String('submit signup').toLowerCase().match(/[a-z0-9]+/g));
    const inter = (t) => (String(t).toLowerCase().match(/[a-z0-9]+/g) || []).some((x) => tokSem.has(x));
    ok(inter('Submit') && inter('Signup'), 'B4 两标签与语义各有 token 相交（F1 前提成立）');
    ok(!inter('Continue'), 'B5 旧标签 Continue 与语义零相交（=旧红因，反向对照）');
    ok(!!semanticResolver, 'B6 语义解析器可加载（探针自身有效）');
    const candsSubmit = semanticResolver.resolve({ semantic: 'submit signup' }, { url: 'http://b.test/f', elements: [{ id: 'x', role: 'button', tag: 'button', text: 'Submit', visible: true }] });
    ok(candsSubmit.length >= 1, 'B7 SEM + Submit 标签必须真出候选（防空：否则 B4 只是纸上推理）', 'n=' + candsSubmit.length);
    const candsSignup = semanticResolver.resolve({ semantic: 'submit signup' }, { url: 'http://b.test/f', elements: [{ id: 'y', role: 'button', tag: 'button', text: 'Signup', visible: true }] });
    ok(candsSignup.length >= 1, 'B8 SEM + Signup 标签必须真出候选', 'n=' + candsSignup.length);
  }

  // ───────────────────────── C. 数据根隔离与口径唯一（EX-08）─────────────────────────
  console.log('\n[C] 数据根隔离与口径唯一');
  {
    const isolation = (src) => {
      const lines = src.split('\n');
      const iso = lines.findIndex((l) => /^process\.env\.FPB_DATA_DIR = /.test(l));
      const req = lines.findIndex((l) => /^const .* = require\(/.test(l));
      return { iso: iso + 1, req: req + 1, ok: iso >= 0 && req > 0 && iso < req };
    };
    const i31 = isolation(P31.src), i34 = isolation(P34.src);
    ok(i31.ok, 'C1 Phase31 隔离行先于首个 require', 'iso=' + i31.iso + ' req=' + i31.req);
    ok(i34.ok, 'C2 Phase34 隔离行先于首个 require', 'iso=' + i34.iso + ' req=' + i34.req);

    const roots = require(path.join(REPO, 'server/dataRoot'));
    const inTmp = (p) => String(p).indexOf(os.tmpdir()) === 0;
    ok(inTmp(roots.dataRoot()) && inTmp(roots.aiStoreRoot()),
      'C3 本守护自身隔离生效（两根均落 tmp）', roots.dataRoot());

    // C4 数据根口径唯一：Phase34 不得再出现硬编码真实 data 目录（第二份口径）
    const hardPath = /path\.join\(__dirname, '\.\.', '\.\.', 'data'/;
    ok(!hardPath.test(P34.src), 'C4 Phase34 无硬编码 `__dirname/../../data` 路径（口径唯一）');
    ok(hardPath.test("const p = path.join(__dirname, '..', '..', 'data', 'profiles.json');"),
      'C4b revert：合成含硬编码路径的样本必须被检出（防只认「不存在」的假绿）');
    ok(/path\.join\(require\('\.\.\/dataRoot'\)\.dataRoot\(\), 'profiles\.json'\)/.test(P34.src),
      'C5 Phase34 白名单路径委托 dataRoot()（唯一事实源）');

    // C6 症状直钉：隔离下白名单为空集（真实执行该函数语义的等价调用）
    ok(/realProfileIds\(\)\.size === 0/.test(P34.src) && /leftover\.length === 0/.test(P34.src),
      'C6 Phase34 含「白名单空集 + 无遗留非 fixture 记录」两条症状直钉断言');
  }

  // ───────────────────────── D. 崩溃面与异常路径（EX-06 的两个测试自身缺陷）─────────────────────────
  console.log('\n[D] 崩溃面与异常路径');
  {
    const s = P31.src;
    // D1 不存在「未受守卫的 .pattern 直接解引用」（历史崩溃形态）
    const lines = s.split('\n');
    const bad = lines.filter((l) => /\.pattern\b/.test(l) && !/if \(|ok\(|\?|：|:\s*\{|^\s*\/\//.test(l));
    ok(bad.length === 0, 'D1 无未受守卫的 .pattern 直接解引用（历史 TypeError 崩溃面）', bad.length ? bad[0].trim() : 'clean');
    ok(/ok\(!!\(r1 && r1\.pattern\), 'Case1 解析结果携带 pattern（null 守卫）'/.test(s),
      'D2 Case1 存在显式 null 守卫断言（失败必须 FAIL，不得崩溃）');
    ok(/ok\(!!\(r2 && r2\.pattern\), 'Case2 解析结果携带 pattern（null 守卫）'/.test(s),
      'D3 Case2 存在显式 null 守卫断言');
    // D4 异常路径必须真还原 spy（不得自赋值 no-op）
    // ★ 必须**先剥行注释**再判：本套件的注释里逐字引用了那行旧 no-op（"此前写的是
    //   `semanticResolver.resolve = semanticResolver.resolve`"），不剥注释会把「文档字面」
    //   当成「代码在场」⇒ 假红（C131/C137 同类陷阱）。
    const stripLineComments = (src) => src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    const NOOP = /semanticResolver\.resolve\s*=\s*semanticResolver\.resolve/;
    ok(!NOOP.test(stripLineComments(s)), 'D4 异常路径无 `resolve = resolve` 自赋值 no-op（已剥行注释）');
    ok(NOOP.test("semanticResolver.resolve = semanticResolver.resolve;"),
      'D4b 正向对照：真实 no-op 代码行必须被检出（防「剥注释」把判据剥成恒真）');
    ok(NOOP.test(s), 'D4c 留痕核对：旧 no-op 文本仍在本套件注释里（证明剥注释确实改变了判定）');
    ok(/if \(origResolve\) semanticResolver\.resolve = origResolve;/.test(s),
      'D5 异常路径真还原 origResolve（spy 不残留）');
    const declPos = lineIndexOf(s, 'let origResolve = null;');
    const usePos = lineIndexOf(s, 'origResolve = semanticResolver.resolve;');
    ok(declPos > 0 && usePos > declPos, 'D6 origResolve 在模块作用域声明且先于赋值（作用域可达）', 'decl=' + declPos + ' use=' + usePos);
  }

  // ───────────────────────── E. 诊断留痕（防「没保存 vs 存到别的 key」误读）─────────────────────────
  console.log('\n[E] 诊断留痕');
  {
    const s = P31.src;
    ok(/const memKeys = \(\) =>/.test(s) && /\[诊断\] Task1 后 memory keys =/.test(s),
      'E1 集成段打印实际落库 memory key（可区分「没保存」与「存到别的 key」）');
    ok(/ok\(!memOf\('submit'\), '记忆不按计划语义 submit 落库/.test(s),
      'E2 契约：零证据语义不按计划语义落库');
    ok(/ok\(spyCount > 0, '零证据语义不复用记忆/.test(s),
      'E3 契约：零证据语义不零推理复用（F1 被回退则该断言变红）');
    ok(/const labelPatterns = \(\) =>/.test(s) && /按观察标签积累 Continue pattern/.test(s),
      'E4 记忆断言 key 无关（按观察标签统计，不绑死恢复链选中的同义词）');
  }

  console.log('\n===== C139 GUARD RESULT: PASS=' + pass + ' FAIL=' + fail + ' =====');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('守护脚本异常:', e && e.stack); process.exit(2); });
