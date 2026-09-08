#!/usr/bin/env node
// C72 —— observation 缓存命中路径动态字段一致性守护（agent 子模块深扫第 3 批）：
//   D1 (B 类一致性)：inspect() 缓存命中路径刷新了 network/storage，但 challenge 检测与
//     networkState 只跑在新鲜路径 —— 被拦截页面 DOM 静止（403/429/503 后 DOM 不变极常见）
//     时后续观察全部缓存命中 → EXTERNAL_BLOCK/INTERACTIVE_CHALLENGE 永不触发 → 任务烧满
//     预算而不是升级人工。networkState 同理停留在缓存时刻（pending/idle 陈旧）。
//   修复：computeNetworkState/computeChallenge 提取为共享函数，新鲜/缓存两路径消费同一实现。
// 零浏览器：fake page（page.evaluate 返回固定 DOM 数据）+ 真实 networkObserver.snapshot
// （通过 page.__fpbNetwork 注入请求数据 —— 断言真正会执行的那份 snapshot 代码）+ 真实
// challengeDetector + 真实 obsCache。FPB_DATA_DIR tmp 隔离。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const here = __dirname;
let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + ': ' + detail); console.log('  FAIL ' + name + ' — ' + detail); }
}

function runInChild(fnName, script) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c72-data-'));
  const tmpJS = path.join(os.tmpdir(), 'c72-' + fnName + '-' + Date.now() + '.js');
  fs.writeFileSync(tmpJS, script, 'utf8');
  const r = spawnSync(process.execPath, [tmpJS], {
    env: Object.assign({}, process.env, { FPB_DATA_DIR: dataDir }),
    encoding: 'utf8',
    timeout: 60000,
  });
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(tmpJS, { force: true }); } catch (e) {}
  return r;
}

const BASE = here.replace(/\\/g, '/') + '/../agent';

// ---- P1/P2/P3: 缓存命中时 challenge 与 networkState 必须随刷新后的 network 重算 ----
{
  const script = `
'use strict';
const observation = require('${BASE}/observation');
const out = { ok: true, error: null };
(async () => {
try {
  const DATA = () => ({
    title: 'Site', textSummary: 'welcome to the dashboard', visibleText: 'welcome to the dashboard',
    roleText: '', elements: [], errors: [], loadingState: 'complete', domFingerprint: 'fp1',
    storage: { localStorage: {}, sessionStorage: {} },
  });
  const mkPage = (requests, pending) => ({
    evaluate: async () => DATA(),
    url: () => 'https://site/page',
    __fpbNetwork: { attachedAt: Date.now(), pending: pending || 0, requests: requests || [], console: [], pageErrors: [], pendingMap: new Map() },
    __pendingRequests: pending || 0,
  });

  // P1 新鲜路径基线：无网络失败 → 无 externalBlock，networkState=idle
  const page = mkPage([]);
  const r1 = await observation.inspect(page, { taskId: 'c72t' });
  if (!r1.ok || r1.cached) throw new Error('P1 应为新鲜观察');
  if (r1.observation.networkState !== 'idle') throw new Error('P1 networkState 应 idle: ' + r1.observation.networkState);
  if (r1.observation.challenge && r1.observation.challenge.externalBlock) throw new Error('P1 不应有 externalBlock');

  // P2 最小复现场景：首次观察发生在主文档 403 到达【前】（页面文本含 denied 关键词但无阻断
  // 状态码 → detectChallenge 三层防误报不误报）；403 到达后 DOM 静止不变 → 后续观察全部
  // 缓存命中 → 修复前 challenge 永远停留旧值（externalBlock 永不触发）。
  const pageB = mkPage([]);
  const DATA_B = () => ({
    title: 'Site', textSummary: 'error access denied', visibleText: 'error access denied',
    roleText: '', elements: [], errors: [], loadingState: 'complete', domFingerprint: 'fpB',
    storage: { localStorage: {}, sessionStorage: {} },
  });
  pageB.evaluate = async () => DATA_B();
  const b1 = await observation.inspect(pageB, { taskId: 'c72t-b' });
  if (!b1.ok || b1.cached) throw new Error('P2 首次应为新鲜观察');
  if (b1.observation.challenge && b1.observation.challenge.externalBlock) throw new Error('P2 首次（403 未到）不应有 externalBlock');
  pageB.__fpbNetwork.requests = [{ method: 'GET', url: 'https://site/page', resourceType: 'document', at: Date.now(), status: 403 }];
  const b2 = await observation.inspect(pageB, { taskId: 'c72t-b' });
  if (!b2.ok) throw new Error('P2 inspect 失败: ' + b2.error);
  if (!b2.cached) throw new Error('P2 应命中缓存（DOM 未变）——测的不是目标路径');
  if (!(b2.observation.challenge && b2.observation.challenge.externalBlock)) {
    throw new Error('缓存命中路径未重算 challenge（403 document 未触发 externalBlock）: ' + JSON.stringify(b2.observation.challenge));
  }

  // P3 缓存命中 + 网络进行中：networkState 必须刷新为 pending（旧实现停留 idle）
  pageB.__fpbNetwork.pending = 2;
  pageB.__pendingRequests = 2;
  const r3 = await observation.inspect(pageB, { taskId: 'c72t-b' });
  if (!r3.cached) throw new Error('P3 应命中缓存');
  if (r3.observation.networkState !== 'pending') throw new Error('缓存命中 networkState 未刷新: ' + r3.observation.networkState);

  out.p123 = 'fresh baseline ok; cache-hit challenge recomputed (403 -> externalBlock); networkState refreshed';
} catch (e) { out.ok = false; out.error = String((e && e.message) || e); }
})().then(() => console.log('CHILD_RESULT ' + JSON.stringify(out)));
`;
  const r = runInChild('p123', script);
  const m = (r.stdout || '').match(/CHILD_RESULT (.*)/);
  const j = m ? JSON.parse(m[1]) : { ok: false, error: 'no result, stderr: ' + (r.stderr || '').slice(0, 300) };
  chk('P123.cache-path-challenge-state-refresh', j.ok && !!j.p123, j.error || j.p123 || 'child failed');
}

// ---- P4: 新鲜路径 403 document 仍检出（共享实现不回归原语义）----
{
  const script = `
'use strict';
const observation = require('${BASE}/observation');
const out = { ok: true, error: null };
(async () => {
try {
  const page = {
    evaluate: async () => ({ title: 'Denied', textSummary: 'access denied', visibleText: 'access denied', roleText: '', elements: [], errors: [], loadingState: 'complete', domFingerprint: 'fp2', storage: { localStorage: {}, sessionStorage: {} } }),
    url: () => 'https://site/denied',
    __fpbNetwork: { attachedAt: Date.now(), pending: 0, requests: [{ method: 'GET', url: 'https://site/denied', resourceType: 'document', at: Date.now(), status: 403 }], console: [], pageErrors: [], pendingMap: new Map() },
    __pendingRequests: 0,
  };
  const r = await observation.inspect(page, { taskId: 'c72t2' });
  if (!r.ok) throw new Error('inspect 失败: ' + r.error);
  if (!(r.observation.challenge && r.observation.challenge.externalBlock)) {
    throw new Error('新鲜路径 403 document 应检出 externalBlock: ' + JSON.stringify(r.observation.challenge));
  }
  out.p4 = 'fresh-path 403 detection intact';
} catch (e) { out.ok = false; out.error = String((e && e.message) || e); }
})().then(() => console.log('CHILD_RESULT ' + JSON.stringify(out)));
`;
  const r = runInChild('p4', script);
  const m = (r.stdout || '').match(/CHILD_RESULT (.*)/);
  const j = m ? JSON.parse(m[1]) : { ok: false, error: 'no result, stderr: ' + (r.stderr || '').slice(0, 300) };
  chk('P4.fresh-path-403-intact', j.ok && !!j.p4, j.error || j.p4 || 'child failed');
}

console.log('RESULT pass=' + pass + ' fail=' + fail);
if (fail) { failures.forEach((f) => console.log('  FAILED: ' + f)); process.exit(1); }
