'use strict';

// C163 守护：点击触发整页（跨域）导航后，观察**不得**降级为「无」。
//
// 实证（真实任务 task_mutakb11ukxiq，2026-10-04，profile=p_musiekhd9fs4）：
//   ① step_001 navigate sonymaxweb.com → SUCCESS；
//   ② step_002 click {semantic:'Spocket'}（判据 url_contains "spocket.co"）
//      —— 点击**实际成功**，页面已跳到 Spocket 官网（after_action 截图 397KB 实证，
//         spocket 导航栏 / 500K+ Entrepreneurs Love Spocket 齐全）；
//      —— 但跨域导航期间 page.evaluate 不可用 ⇒ after 观察为 undefined ⇒ url_contains
//         读不到 URL ⇒ 误判失败 ⇒ VIL 观察窗口 + reload 螺旋（12:01:35 起 3×
//         CONTEXT_NOT_READY + 13KB 纯白页截图）⇒ STEP_TIMEOUT 抢跑遗留 RUNNING 孤儿
//         （att_mutamaby9b9u，12:00:35→12:03:16 孤儿收口）⇒ 3× click 30s 超时
//         （text="500K+ Sellers Trust Spocket To"）⇒ 90s REPAIR_TIMEOUT ⇒ 任务 FAILED。
//
// 本守护钉住三件事：
//   ① 导航中「观察取不到」必须仍交付**实时真实 URL**（否则真成功被判失败）；
//   ② 该 URL 必须能被 url_contains 判为成功 —— 而 text_present 等**内容类**判据仍失败
//      （页面确实还没内容）⇒ Success Definition 未放宽；
//   ③ 上下文已关闭 / 拿不到 URL 时**原样抛出**，绝不用降级观察掩盖真实故障。

const os = require('os');
const path = require('path');

// C140 纪律：夹具一律隔离数据根，绝不写入 server/data。
process.env.FPB_DATA_DIR = path.join(os.tmpdir(), 'c163_nav_' + Date.now());

const AGENT = path.join(__dirname, '..', 'agent');
const tools = require(path.join(AGENT, 'tools'));
const verification = require(path.join(AGENT, 'verification'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  << ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

const URL_BEFORE = 'https://sonymaxweb.com/';
const URL_AFTER = 'https://www.spocket.co/?ps_partner_key=Y29ydG5leXBlcnJ5NjQ0Nw&ps_xid=kRjasC2BPln0N7';
const META = { taskId: null };

function pageStub(url) {
  return { isClosed: () => false, url: () => url };
}
function throwingInspect(err) {
  return () => { throw err; };
}
function errWith(code) {
  const e = new Error('stub:' + code);
  e.code = code;
  return e;
}

// 旧行为（修复前）：直接取 inspect 结果，取不到就是「无观察」。
// 用它反向咬：同一组断言必须让旧行为变红，证明守护有分辨力（不是真空绿）。
async function legacyObserveAfterClick(page) {
  const r = await Promise.resolve().then(() => ({ ok: false, error: '页面不可观察: stub' }));
  return r && r.ok ? r.observation : undefined;
}

// 断言 ①+②：导航中观察取不到 ⇒ 仍交付实时 URL，且 url_contains 判成功、text_present 判失败。
async function assertNavKeepsRealUrl(label, observeFn) {
  const after = await observeFn(pageStub(URL_AFTER), META, { inspectFn: () => ({ ok: false, error: '页面不可观察: navigating' }) });
  const url = after && after.url;
  ok(label + ' :: 交付 after 观察（非 undefined）', !!after, after);
  ok(label + ' :: after.url 为实时真实 URL', url === URL_AFTER, url);

  const vUrl = verification.verify({ type: 'url_contains', expect: 'spocket.co' }, after, { url: URL_BEFORE });
  ok(label + ' :: url_contains spocket.co 判成功（跳转确已发生）', vUrl.success === true, vUrl);

  const vText = verification.verify({ type: 'text_present', expect: 'Spocket' }, after, { url: URL_BEFORE });
  ok(label + ' :: 内容类判据（text_present）仍失败 ⇒ 未放宽', vText.success === false, vText);
}

(async () => {
  section('P1 正常路径：观察可用 ⇒ 原样透传，不降级');
  {
    const good = { observationId: 'obs_x', url: URL_AFTER, title: 'Spocket', textSummary: 'Spocket', visibleText: 'Spocket', elements: [], contentLeaves: [], errors: [] };
    const after = await tools.observeAfterClick(pageStub(URL_AFTER), META, { inspectFn: () => ({ ok: true, observation: good }) });
    ok('P1.1 透传 inspect 的观察对象', after === good, after && after.observationId);
    ok('P1.2 未被打上 degraded 标记', !after.degraded, after && after.degraded);
  }

  section('P2 inspect 返回 ok:false（导航中 evaluate 抛错）⇒ 降级 + 实时 URL');
  {
    const after = await tools.observeAfterClick(pageStub(URL_AFTER), META, { inspectFn: () => ({ ok: false, error: '页面不可观察: Execution context was destroyed' }) });
    ok('P2.1 交付降级观察', !!after && after.degraded === true, after && after.degradedReason);
    ok('P2.2 url 为实时真实 URL', after && after.url === URL_AFTER, after && after.url);
    ok('P2.3 元素/文本为空（不伪造内容证据）', after && after.elements.length === 0 && after.textSummary === '', after && after.textSummary);
    ok('P2.4 字段形状与 inspect 输出对齐', after && typeof after.observationId === 'string' && typeof after.capturedAt === 'number' && after.elementState && typeof after.elementState.total === 'number');
  }

  section('P3 withBrowserOp 超时（BROWSER_TIMEOUT）⇒ 降级，不再让整步挂死');
  {
    const after = await tools.observeAfterClick(pageStub(URL_AFTER), META, { inspectFn: throwingInspect(errWith('BROWSER_TIMEOUT')) });
    ok('P3.1 交付降级观察', !!after && after.degraded === true, after && after.degradedReason);
    ok('P3.2 降级原因标注超时码', after && /nav_timeout:BROWSER_TIMEOUT/.test(after.degradedReason), after && after.degradedReason);
    ok('P3.3 url 为实时真实 URL', after && after.url === URL_AFTER, after && after.url);
  }

  section('P4 工具执行异常（TOOL_EXECUTION）⇒ 同样降级（真跳转已发生）');
  {
    const after = await tools.observeAfterClick(pageStub(URL_AFTER), META, { inspectFn: throwingInspect(errWith('TOOL_EXECUTION')) });
    ok('P4.1 交付降级观察', !!after && after.degraded === true, after && after.degradedReason);
  }

  section('P5 fail-loud：上下文已关闭 ⇒ 原样抛出（不得掩盖真实故障）');
  {
    let thrown = null;
    try { await tools.observeAfterClick(pageStub(URL_AFTER), META, { inspectFn: throwingInspect(errWith('BROWSER_CONTEXT_LOST')) }); }
    catch (e) { thrown = e; }
    ok('P5.1 BROWSER_CONTEXT_LOST 被 rethrow', !!thrown && thrown.code === 'BROWSER_CONTEXT_LOST', thrown && thrown.code);
  }

  section('P6 fail-loud：连页面 URL 都拿不到 ⇒ 不降级（返回 null / 保留错误）');
  {
    const after = await tools.observeAfterClick(pageStub(''), META, { inspectFn: () => ({ ok: false, error: '页面不可观察' }) });
    ok('P6.1 返回 null 而非伪造 URL', after === null, after);
    let thrown = null;
    try { await tools.observeAfterClick(pageStub(''), META, { inspectFn: throwingInspect(errWith('BROWSER_TIMEOUT')) }); }
    catch (e) { thrown = e; }
    ok('P6.2 超时且无 URL ⇒ 保留原错误', !!thrown && thrown.code === 'BROWSER_TIMEOUT', thrown && thrown.code);
  }

  section('P7 端到端咬合：真实任务复刻（before=sonymaxweb，after URL=spocket.co）');
  await assertNavKeepsRealUrl('P7 新实现', tools.observeAfterClick);

  section('P8 反向咬（revert）：旧行为在同组断言下必须变红');
  {
    const after = await legacyObserveAfterClick(pageStub(URL_AFTER));
    ok('P8.1 旧行为交付的 after 为 undefined（这正是失败根因）', after === undefined, after);
    const vUrl = verification.verify({ type: 'url_contains', expect: 'spocket.co' }, after, { url: URL_BEFORE });
    ok('P8.2 旧行为下 url_contains 判失败 ⇒ 真成功被判失败（守护有分辨力）', vUrl.success === false, vUrl);
  }

  section('P9 纯函数边界：degradedObservationFor 不夹带内容证据');
  {
    const d = tools.degradedObservationFor(URL_AFTER, { taskId: 't1' }, 'unit');
    ok('P9.1 url 原样保留', d.url === URL_AFTER);
    ok('P9.2 elements / contentLeaves 为空数组', Array.isArray(d.elements) && d.elements.length === 0 && Array.isArray(d.contentLeaves) && d.contentLeaves.length === 0);
    ok('P9.3 loadingState 标注 navigating', d.loadingState === 'navigating', d.loadingState);
    ok('P9.4 taskId 透传', d.taskId === 't1', d.taskId);
    ok('P9.5 观察能力缺失可复查（degraded/degradedReason 留痕）', d.degraded === true && d.degradedReason === 'unit', d.degradedReason);
  }

  console.log('\nOK=' + pass + ' BAD=' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log('FATAL ' + (e && e.stack || e));
  console.log('OK=' + pass + ' BAD=' + (fail + 1));
  process.exit(1);
});
