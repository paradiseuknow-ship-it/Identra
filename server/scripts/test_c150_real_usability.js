'use strict';

/**
 * C150 守护：真实站点可用性的三条底线（用户主诉的三个最基本缺陷）。
 *
 * 背景（用户原话）：
 *   「你连注册按钮都找不到，然后输入邮箱密码的时候，网页还在加载，你输入那么快，
 *     网页刷新后你继续输入 出现邮箱都输入不完整，这些最基本的问题你都没有想到。」
 *
 * 本套件锁定三件事：
 *   A. 恢复链 / 修复链的 CTA 探测词表必须覆盖真实站点文案，且探测窗口必须落在
 *      **具体长短语**上（不是 continue/next/submit 这类通用短动词）。
 *      夹具 = 真实站点首页快照（server/scripts/c150_site_snapshot.json，离线回放）。
 *   B. fill 的「字段稳定性守卫」返回值必须被真正消费：不稳定 ⇒ 重新观察 + 重新接地。
 *   C. fill 在 settle 之后必须回读：值丢失 ⇒ 重填一次 ⇒ 仍丢失则 fail-loud，
 *      绝不返回 ok:true（settle 期间的假成功）。
 *
 * 说明：
 *   - B/C 用**真实 tools.execute** 驱动，只把浏览器协作者替换为测试替身（不手写模拟业务逻辑）。
 *   - 本套件不联网、不开浏览器。
 *   - 数据根隔离到 os.tmpdir()，不得污染仓库 data/。
 */

// ⚠️ 数据根必须在任何 require 之前隔离（dataRoot/aiStoreRoot 于模块加载期解析）。
const path = require('path');
const fs = require('fs');
const os = require('os');
const DATA_TMP = path.join(os.tmpdir(), 'c150_guard_' + process.pid + '_' + Date.now());
process.env.FPB_DATA_DIR = DATA_TMP;
process.env.AI_PROVIDER = process.env.AI_PROVIDER || 'mock';

const ROOT = path.join(__dirname, '..', '..');
const tools = require(path.join(ROOT, 'server', 'agent', 'tools'));
const humanInput = require(path.join(ROOT, 'server', 'agent', 'humanInput'));
const observation = require(path.join(ROOT, 'server', 'agent', 'observation'));
const browserManager = require(path.join(ROOT, 'server', 'browserManager'));
const semanticResolver = require(path.join(ROOT, 'server', 'agent', 'semanticResolver'));
const elementMissing = require(path.join(ROOT, 'server', 'agent', 'recovery', 'strategies', 'elementMissing'));
const elementChanged = require(path.join(ROOT, 'server', 'agent', 'repair', 'strategies', 'elementChanged'));

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}

// ══════════════════════════════════════════════════════════════════════════════
// A. CTA 词表：形状不变量 + 真实站点回放
// ══════════════════════════════════════════════════════════════════════════════

const isSpecificCta = (s) => /\s/.test(String(s)) || /[\u4e00-\u9fa5]/.test(String(s));

console.log('=== A. CTA 探测词表（真实站点接地） ===');
{
  const vocab = elementMissing.CLICK_FALLBACK;

  // A1 内容形状：探测窗口（前 3 项）必须由具体短语占据。旧词表前 3 = continue/next/submit ⇒ 红。
  ok(vocab.slice(0, 3).every(isSpecificCta),
    'A1 探测窗口前 3 项均为具体多词/中文 CTA 短语（不是通用短动词）', vocab.slice(0, 3));

  // A2 通用短动词整体后置。submit 会命中目录类站点的 “Submit Tool”（提交工具，非注册）。
  const genericStart = vocab.indexOf('continue');
  ok(vocab.indexOf('submit') >= elementMissing.CTA_SPECIFIC.length
    && genericStart >= elementMissing.CTA_SPECIFIC.length,
    'A2 通用短动词（submit/continue/...）整体排在具体短语之后');

  // A3 保留 C105 F6.2 契约：英语页真实存在的 submit/next 仍必须在词表里。
  ok(vocab.indexOf('submit') >= 0 && vocab.indexOf('next') >= 0,
    'A3 英语页常用词 submit/next 仍在词表中（F6.2 契约不退化）');

  // A4 无重复（重复会让「变体数 = 1 + 词表长度」的不变量失真）。
  const lower = vocab.map((s) => String(s).toLowerCase());
  ok(new Set(lower).size === lower.length, 'A4 词表无重复项');

  // A5 真实站点回放：旧词表在真实页面上只有 submit 可解析，且 submit 会指向 “Submit Tool”。
  const snap = require(path.join(__dirname, 'c150_site_snapshot.json'));
  const obs = { url: snap.url, elements: snap.elements, textSummary: snap.textSummary };
  const resolvable = (w) => {
    try { return semanticResolver.resolve({ semantic: w }, obs) || []; } catch (e) { return []; }
  };
  const LEGACY = ['continue', 'next', 'submit', 'proceed', 'register', 'create account', 'sign up', 'done', 'save', 'ok', 'confirm'];
  const legacyHits = LEGACY.filter((w) => resolvable(w).length);
  ok(legacyHits.length <= 1,
    'A5a 夹具自证分辨力：旧词表在该真实页面上几乎没有可解析项', legacyHits);

  const cta = resolvable('start free trial')[0];
  ok(!!cta && /start free trial/i.test(String((cta.el && (cta.el.text || cta.el.innerText)) || '')),
    'A5b 真实站点注册入口可被具体短语命中（Start Free Trial）', cta && cta.selector);

  // A6 端到端：未知语义 + 真实观察 ⇒ 变体被接地过滤，且前 3 项是具体 CTA 短语。
  const variants = elementMissing.buildElementVariants(
    { type: 'click', target: { semantic: '注册' }, verification: { type: 'none' } }, obs);
  ok(variants[0].target.semantic === '注册', 'A6a 原动作恒在第 0 位');
  ok(variants.length >= 2 && variants.slice(1, 4).every((v) => isSpecificCta(v.target.semantic)),
    'A6b 接地过滤后的探测窗口仍是具体 CTA 短语', variants.slice(0, 5).map((v) => v.target.semantic));

  // A7 修复链（elementChanged）必须把失败现场观察透传进接地过滤：
  //    没有这一步，探测预算就花在「页面上根本不存在的词」上（旧行为 4 次 + 复探 2 次全空转）。
  ok(elementChanged && typeof elementChanged.execute === 'function', 'A7a elementChanged.execute 存在');
  const ecSrc = fs.readFileSync(path.join(ROOT, 'server', 'agent', 'repair', 'strategies', 'elementChanged.js'), 'utf8');
  ok(/buildElementVariants\(step\.action,\s*obs\)/.test(ecSrc),
    'A7b elementChanged 把观察传给 buildElementVariants（探测词先接地）');
  const exSrc = fs.readFileSync(path.join(ROOT, 'server', 'agent', 'repair', 'executor.js'), 'utf8');
  ok(/observation:\s*observation\s*\|\|\s*null/.test(exSrc),
    'A7c repair executor 把观察透传进策略 ctx');
}

// ══════════════════════════════════════════════════════════════════════════════
// B/C. fill 分支：稳定性守卫被消费 + settle 后回读（真实 tools.execute + 协作者替身）
// ══════════════════════════════════════════════════════════════════════════════

const ORIG = {
  inspect: observation.inspect,
  humanType: browserManager.humanType,
  waitFieldStable: humanInput.waitFieldStable,
  readBackValue: humanInput.readBackValue,
  sleep: humanInput.sleep,
};

/** 造一个「页面 + 协作者替身」的世界。 */
function makeWorld(cfg) {
  const c = cfg || {};
  const st = {
    value: '',                 // 页面上字段的真实值
    host: c.host || 'sim-c150.example',
    inspectCount: 0,
    selectorSeen: [],          // humanType 收到的 selector 序列
    typed: 0,
    readsToWipe: c.wipeOnReads || 0,   // 第 n 次回读时清空（模拟节点重建）
    waitCall: 0,
  };
  st.url = 'https://' + st.host + '/signup';

  const obsFor = (idx) => {
    const id = c.obsIds ? c.obsIds[Math.min(idx, c.obsIds.length - 1)] : '#email';
    const aria = c.elAria || 'Email';
    const el = {
      id: String(id).replace('#', ''), selector: id, tag: 'input', role: 'textbox',
      type: c.elType || 'text',
      text: '', innerText: '', value: null, ariaLabel: aria, placeholder: c.elPlaceholder || aria,
      label: null, cls: 'input', name: c.elName || 'email', state: { disabled: false, visible: true },
    };
    return { url: st.url, title: 'Sign up', elements: [el], textSummary: aria };
  };

  const locator = {
    first: () => locator,
    inputValue: async () => {
      if (st.readsToWipe > 0) { st.readsToWipe--; st.value = ''; }  // ★ 节点被重建 → 值丢
      return st.value;
    },
    fill: async (v) => { st.value = String(v); },
    elementHandle: async () => null,
    click: async () => {},
    scrollIntoViewIfNeeded: async () => {},
    boundingBox: async () => ({ x: 0, y: 0, width: 200, height: 40 }),
  };

  const page = {
    url: () => st.url,
    isClosed: () => false,
    evaluate: async () => ({ w: 200, h: 40, disabled: false }),   // waitFieldStable 的探测原语
    $eval: async () => { throw new Error('no $eval in sim'); },
    waitForTimeout: async () => {},
    locator: () => locator,
    keyboard: { type: async () => {}, press: async () => {} },
  };

  observation.inspect = async () => {
    st.inspectCount++;
    return { ok: true, observation: obsFor(st.inspectCount - 1) };
  };
  browserManager.humanType = async (pg, selector, value) => {
    st.typed++;
    st.selectorSeen.push(selector);
    st.value = String(value);
    return { ok: true, value: String(value), retyped: false, length: String(value).length, firstAttempt: String(value) };
  };
  humanInput.sleep = async () => {};   // 消除 settleDelay 的真实等待

  st.page = page;
  return { st, page };
}

function restore() {
  observation.inspect = ORIG.inspect;
  browserManager.humanType = ORIG.humanType;
  humanInput.waitFieldStable = ORIG.waitFieldStable;
  humanInput.readBackValue = ORIG.readBackValue;
  humanInput.sleep = ORIG.sleep;
}

/**
 * 直接驱动**真实的 fill 分支实现**（tools.runTool）。
 *
 * 刻意不走 tools.execute：那一层是 Action 校验 / Policy / Lock / 上下文守卫 / Evidence /
 * 验证窗口的编排，与本套件被测的三件事正交；把它们一起拉进来只会让夹具变脆、让红项归因变难。
 * 但 fill 分支本体（含 has 稳定性守卫与 settle 回读）走的是同一份代码 —— 这就是「断言真正
 * 执行的那份」。
 */
function driveFill(st, host, value, target) {
  const taskId = 't_c150_' + host;
  const executionId = 'e_c150_' + host;
  const action = {
    type: 'fill',
    target: target || { selector: '#email' },
    value: value,
    risk: 'LOW',
    // fill 属 MUST_VERIFY 族：非 none 的验证（但 runTool 本身不消费它，仅为形态真实）
    verification: { type: 'element_present', expect: 'Email' },
  };
  return tools.runTool(action, { task: { id: taskId, profileId: null }, session: { page: st.page }, page: st.page },
    { taskId: taskId, executionId: executionId, stepId: 's_c150_' + host });
}

(async () => {
  console.log('\n=== B. 字段稳定性守卫的返回值必须被消费 ===');
  {
    // B1 不稳定：第一次稳定性判定返回「不稳定」⇒ 必须重新观察 + 重新接地。
    const { st, page } = makeWorld({ host: 'b1.example', obsIds: ['#q1', '#q2'] });
    humanInput.waitFieldStable = async () => {
      st.waitCall++;
      return st.waitCall === 1
        ? { stable: false, waitedMs: 1500, reason: 'not_visible' }
        : { stable: true, waitedMs: 140 };
    };
    const r = await driveFill(st, 'b1.example', 'hello', { selector: '#q1' });
    restore();
    ok(r.success === true, 'B1a 不稳定路径不把「等不到稳定」变成动作失败', r.error);
    // 观察次数 = 初始 1 + 重新观察 1 + 收尾 1 = 3
    ok(st.inspectCount === 3, 'B1b 不稳定 ⇒ 触发重新观察（观察次数 3 = 初始+重观察+收尾）', st.inspectCount);
    ok(st.selectorSeen.length === 1, 'B1c 实际输入一次', st.selectorSeen);
  }
  {
    // B2 稳定：不触发额外观察（正向对照 —— 防止「无条件重观察」式假绿）。
    const { st, page } = makeWorld({ host: 'b2.example' });
    humanInput.waitFieldStable = async () => ({ stable: true, waitedMs: 140 });
    const r = await driveFill(st, 'b2.example', 'hello');
    restore();
    ok(r.success === true, 'B2a 稳定路径成功', r.error);
    ok(st.inspectCount === 2, 'B2b 稳定 ⇒ 不额外重观察（恰 2 次：初始观察 + 收尾观察）', st.inspectCount);
  }
  {
    // B3 重接地真的换了 selector：无语义键 ⇒ 走 resolveSelector 的解析路径，
    //    第二次观察提供 #qB 时必须用它输入（证明「重新接地」不是空转）。
    const { st, page } = makeWorld({
      host: 'b3.example',
      obsIds: ['#qA', '#qB'],
      elAria: 'Search', elPlaceholder: 'Search', elName: 'q', elType: 'search',
    });
    humanInput.waitFieldStable = async () => {
      st.waitCall++;
      return st.waitCall === 1 ? { stable: false, waitedMs: 1500, reason: 'not_visible' } : { stable: true, waitedMs: 140 };
    };
    const r = await driveFill(st, 'b3.example', 'hello', { semantic: 'search' });
    restore();
    ok(r.success === true, 'B3a 语义接地路径成功', r.error);
    ok(st.selectorSeen.length === 1 && st.selectorSeen[0] === '#qB',
      'B3b 不稳定 ⇒ 用「重新观察后重新接地」的 selector 输入（#qB，不是过期的 #qA）', st.selectorSeen);
  }

  console.log('\n=== C. settle 之后必须回读（防「值在稳定期间丢失」的假成功） ===');
  {
    // C1 正向对照：值保持 ⇒ ok:true（防止「恒失败」式假绿）。
    const { st } = makeWorld({ host: 'c1.example' });
    const r = await driveFill(st, 'c1.example', 'user@example.com');
    restore();
    ok(r.success === true, 'C1a 值完整保持 ⇒ 成功', r.error);
    ok(st.typed === 1, 'C1b 正向路径不触发重填', st.typed);
  }
  {
    // C2 值在 settle 窗口丢失 ⇒ 重填一次成功 ⇒ ok:true，且输入发生了 2 次。
    const { st } = makeWorld({ host: 'c2.example', wipeOnReads: 1 });
    const r = await driveFill(st, 'c2.example', 'user@example.com');
    restore();
    ok(r.success === true, 'C2a 丢值但重填成功 ⇒ 成功', r.error);
    ok(st.typed === 2, 'C2b 丢值 ⇒ 恰好重填一次', st.typed);
  }
  {
    // C3 重填后仍丢 ⇒ 必须 fail-loud，绝不返回 ok:true（这就是用户遇到的「假成功」）。
    const { st } = makeWorld({ host: 'c3.example', wipeOnReads: 99 });
    const r = await driveFill(st, 'c3.example', 'user@example.com');
    restore();
    ok(r.success === false && r.error && r.error.code === 'FILL_VALUE_LOST_AFTER_SETTLE',
      'C3a 重填后仍丢失 ⇒ FILL_VALUE_LOST_AFTER_SETTLE', r.error);
    ok(st.typed === 2, 'C3b 最多重填一次（有界，不无限循环）', st.typed);
  }
  {
    // C4 值被截断（用户主诉「邮箱都输入不完整」）⇒ 同样必须 fail-loud。
    const { st } = makeWorld({ host: 'c4.example' });
    browserManager.humanType = async (pg, selector, value) => {
      st.typed++;
      st.selectorSeen.push(selector);
      st.value = String(value).slice(0, 6);   // 只进去了前 6 个字符
      return { ok: true, value: st.value, retyped: false, length: st.value.length };
    };
    const r = await driveFill(st, 'c4.example', 'user@example.com');
    restore();
    ok(r.success === false && r.error && r.error.code === 'FILL_VALUE_LOST_AFTER_SETTLE',
      'C4 值不完整 ⇒ fail-loud（不把「前 6 个字符」当成功）', r.error);
  }
  {
    // C5 边界：回读「读不到」（返回 null）不等于值丢了 —— 不得据此判失败。
    const { st } = makeWorld({ host: 'c5.example' });
    humanInput.readBackValue = async () => null;
    const r = await driveFill(st, 'c5.example', 'user@example.com');
    restore();
    ok(r.success === true, 'C5 回读不可用 ⇒ 不误判失败（读不到 ≠ 值丢了）', r.error);
  }
  {
    // C6 settle 期间值被**改写成另一个完整值**也必须 fail-loud（不是只有空值才叫丢）。
    const { st } = makeWorld({ host: 'c6.example' });
    browserManager.humanType = async (pg, selector, value) => {
      st.typed++;
      st.value = String(value);
      // 每次输入后，页面都会把值改写成别人的（模拟被下一步/自动填充覆写）
      st.mutateOnRead = 'someone-else@example.com';
      return { ok: true, value: st.value, retyped: false, length: st.value.length };
    };
    humanInput.readBackValue = async () => {
      if (st.mutateOnRead) { st.value = st.mutateOnRead; st.mutateOnRead = null; }
      return st.value;
    };
    const r = await driveFill(st, 'c6.example', 'user@example.com');
    restore();
    ok(r.success === false && r.error && r.error.code === 'FILL_VALUE_LOST_AFTER_SETTLE',
      'C6 值被改写成另一个完整值同样 fail-loud', r.error);
  }

  console.log('\n=== D. 纪律锁 ===');
  {
    const tsrc = fs.readFileSync(path.join(ROOT, 'server', 'agent', 'tools.js'), 'utf8');
    const esrc = fs.readFileSync(path.join(ROOT, 'server', 'agent', 'recovery', 'strategies', 'elementMissing.js'), 'utf8');
    ok(!/^[ \t]*await humanInput\.waitFieldStable\(/m.test(tsrc),
      'D1 稳定性判定的返回值不再被丢弃（裸 await 形态已不存在）');
    ok(/let _stable = await humanInput\.waitFieldStable/.test(tsrc), 'D2 返回值被赋值并消费');
    ok(/FILL_VALUE_LOST_AFTER_SETTLE/.test(tsrc), 'D3 settle 后丢值有独立错误码');
    ok(/humanInput\.readBackValue/.test(tsrc), 'D4 settle 后回读接线存在');
    ok(!/webflow|perimeterx|px-cloud|cloudflare|sonymaxweb/i.test(esrc),
      'D5 恢复词表不含站点名/供应商特判（纯通用 CTA 词汇）');
    ok(!/networkState|requiredEvidence|businessState/i.test(esrc),
      'D6 不触碰 verification 判据面（Phase 6 红线）');
  }

  restore();
  try { fs.rmSync(DATA_TMP, { recursive: true, force: true }); } catch (e) {}
  console.log('\nc150 real usability: ' + pass + ' passed / ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  restore();
  console.error('FATAL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
