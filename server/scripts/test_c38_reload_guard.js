'use strict';
// C38 守护测试 —— TaskDetail 双通道（SSE+轮询）并发 reload 守卫（纯函数级，零浏览器零服务器）。
// 缺陷背景：SSE 每条事件触发完整 reload（6 请求）且与 2.5s 轮询并发飞行，
//   先发后至的旧响应覆盖新响应 → UI 状态回跳；事件密集时形成请求风暴。
// 修复：reloadGuard.mjs —— latest-wins 乱序守卫 + leading+trailing 节流。
// 覆盖：
//   P1 latest-wins：先发的慢调用被后发的快调用取代 → 慢调用 apply 不执行
//   P2 latest-wins：最新调用正常 apply 并返回结果
//   P3 错误吞没：被取代调用的 run 抛错不向外传播
//   P4 错误传播：最新调用抛错正常向外传播（UI 需要感知）
//   P5 throttle leading+trailing：窗口首调用立即执行，窗口内积压合并为 trailing 一次
//   P6 throttle cancel：cancel 后 trailing 不执行

const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

(async () => {
  const { createLatestGuard, createTrailingThrottle } = await import(
    'file://' + path.join(__dirname, '..', '..', 'client', 'src', 'lib', 'reloadGuard.mjs').replace(/\\/g, '/')
  );

  // P1+P2：latest-wins 乱序
  {
    const guard = createLatestGuard();
    const order = [];
    let appliedOld = false, appliedNew = false;
    const slow = guard(
      () => new Promise((res) => setTimeout(() => { order.push('slow'); res('OLD'); }, 60)),
      () => { appliedOld = true; }
    );
    await sleep(5);
    const fast = guard(
      () => new Promise((res) => setTimeout(() => { order.push('fast'); res('NEW'); }, 10)),
      (v) => { appliedNew = (v === 'NEW'); }
    );
    const fastVal = await fast;
    const slowVal = await slow;
    chk('P1 latest-wins：被取代的慢调用 apply 不执行（旧响应不落 state）',
      appliedOld === false && order[0] === 'fast', 'appliedOld=' + appliedOld + ' order=' + order.join(','));
    chk('P2 最新调用正常 apply 并透传结果', appliedNew === true && fastVal === 'NEW' && slowVal === 'OLD',
      'appliedNew=' + appliedNew + ' fast=' + fastVal + ' slow=' + slowVal);
  }

  // P3+P4：错误路径
  {
    const guard = createLatestGuard();
    let applied = false;
    const stale = guard(() => new Promise((res, rej) => setTimeout(() => rej(new Error('stale-boom')), 40)), () => { applied = true; });
    await sleep(5);
    let freshErr = null;
    const fresh = guard(() => Promise.reject(new Error('fresh-boom')), () => { applied = true; });
    try { await fresh; } catch (e) { freshErr = e; }
    let staleErr = null;
    try { await stale; } catch (e) { staleErr = e; }
    chk('P3 被取代调用的错误不传播且不 apply', staleErr === null && applied === false,
      'staleErr=' + staleErr + ' applied=' + applied);
    chk('P4 最新调用的错误正常传播', freshErr && freshErr.message === 'fresh-boom',
      String(freshErr));
  }

  // P5+P6：trailing throttle
  {
    const calls = [];
    const th = createTrailingThrottle((tag) => calls.push(tag), 50);
    th.call('leading');      // 立即执行
    th.call('merged-1');     // 窗口内积压
    th.call('merged-2');     // 覆盖积压参数
    chk('P5a leading 立即执行且窗口内暂不 trailing',
      calls.length === 1 && calls[0] === 'leading', JSON.stringify(calls));
    await sleep(90);
    chk('P5b 窗口结束 trailing 以最后参数执行一次',
      calls.length === 2 && calls[1] === 'merged-2', JSON.stringify(calls));
  }

  // R 组：静态守护（组件层防回归，C39 合并自并发会话 c37 套件）
  const fs = require('fs');
  const taskDetailSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'components', 'TaskDetail.jsx'), 'utf8');
  const aiPanelSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'components', 'AiPanel.jsx'), 'utf8');
  const libSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'lib', 'reloadGuard.mjs'), 'utf8');
  chk('R0 lib 语义核心：my === seq 判定存在', libSrc.includes('my === seq'), 'guard core missing');
  chk('R1a TaskDetail 引入 reloadGuard', taskDetailSrc.includes("from '../lib/reloadGuard.mjs'"), 'missing import');
  chk('R1b TaskDetail reload 走 latest-wins 守卫', /createLatestGuard\(\)/.test(taskDetailSrc) && /guard\(/.test(taskDetailSrc), 'missing guard usage');
  chk('R1c SSE 事件经节流触发（不再裸 reload）', /createTrailingThrottle\(reload/.test(taskDetailSrc) && /bump\.call\(\)/.test(taskDetailSrc), 'missing throttle usage');
  chk('R1d 卸载时 cancel 节流', /bump\.cancel\(\)/.test(taskDetailSrc), 'missing cancel in cleanup');
  chk('R2 AiPanel 切换任务丢弃旧飞行响应', /let active = true/.test(aiPanelSrc) && /if \(!active\) return;/.test(aiPanelSrc) && /active = false;/.test(aiPanelSrc), 'missing active guard');
  {
    const calls = [];
    const th = createTrailingThrottle((tag) => calls.push(tag), 50);
    th.call('a');
    th.call('b');
    th.cancel();
    await sleep(90);
    chk('P6 cancel 后 trailing 不执行（防卸载后 setState）', calls.length === 1, JSON.stringify(calls));
  }

  console.log('---');
  console.log('PASS=' + pass + ' FAIL=' + fail);
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})();
