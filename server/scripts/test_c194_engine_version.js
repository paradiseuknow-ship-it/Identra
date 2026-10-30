'use strict';
// C194 守护：内核版本检测必须区分「已是最新 / 有更新 / 不知道」，且更新后版本缓存必须失效。
//
// 背景（2026-10-30 用户提问）：产品此前没有任何内核版本概念（硬编码本机 Chrome 路径），
// 既不知道相对官方稳定版是否落后，也没有更新入口。内核落后的真实代价是**指纹自相矛盾**：
// UA / Client Hints 被对齐到本机引擎版本，引擎旧 ⇒ 版本号本身成为可识别特征。
//
// 本守护重点咬住三类"看起来对其实危险"的实现：
//   ① 把「在线检测失败」当成「已是最新」（会让用户永远看不到更新提示）；
//   ② 版本缓存永久有效（更新内核后 UA 仍写旧版本 ⇒ 层间分裂，C30 老坑复现）；
//   ③ 触发更新后不失效缓存（UI 显示已更新、实际跑起来还是旧版本）。

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP_ROOT = path.join(os.tmpdir(), 'c194-guard-' + process.pid);
fs.mkdirSync(TMP_ROOT, { recursive: true });
process.env.FPB_DATA_DIR = TMP_ROOT;

const engineInfo = require('../engineInfo');

let pass = 0; let fail = 0;
const fails = [];
function ok(name, cond, extra) { if (cond) pass++; else { fail++; fails.push(name + (extra ? ' :: ' + extra : '')); console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); } }
function eq(name, a, b) { ok(name, a === b, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }
function has(name, s, sub) { ok(name, typeof s === 'string' && s.includes(sub), 'missing=' + sub + ' got=' + String(s).slice(0, 120)); }

let calls = null;
function stub(over) {
  const o = over || {};
  calls = { fetch: 0, invalidate: 0, update: 0, curVer: 0 };
  engineInfo.__setDepsForTest({
    getCurrentVersion: () => { calls.curVer++; return o.current === undefined ? '156.0.8078.73' : o.current; },
    chromePath: () => 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    invalidateVersionCache: () => { calls.invalidate++; },
    fetchJson: async (url) => {
      calls.fetch++;
      const plan = o.fetchPlan ? o.fetchPlan(url, calls.fetch) : { ok: true, version: o.latest === undefined ? '156.0.8078.80' : o.latest };
      if (!plan.ok) throw new Error(plan.error || 'boom');
      if (url.includes('last-known-good')) return { channels: { Stable: { version: plan.version } } };
      return [{ version: plan.version }];
    },
    runUpdate: async () => { calls.update++; return o.updateResult || { ok: true, error: null, via: 'GoogleUpdate.exe' }; },
  });
}

// 状态文件与 deps 分开重置：多处用例的语义正是「上一步落盘、这一步读缓存」，
// 混在一起会变成测试自己制造的假失败。
function wipeState() {
  try { fs.rmSync(path.join(TMP_ROOT, 'engine-status.json'), { force: true }); } catch (e) {}
}

(async () => {
  console.log('=== C194 内核版本检测守护 ===');

  // ---------------- A 版本比较 ----------------
  console.log('\n--- A compareVersions 分级 ---');
  let c = engineInfo.compareVersions('156.0.8078.73', '156.0.8078.73');
  eq('A1 完全一致 ⇒ up-to-date', c.level, 'up-to-date');
  eq('A1b 完全一致 ⇒ outdated=false（不是 null）', c.outdated, false);

  c = engineInfo.compareVersions('156.0.8078.73', '156.0.8078.80');
  eq('A2 仅修订号差 ⇒ patch', c.level, 'patch');
  eq('A2b patch 差值准确', c.behind.patch, 7);

  c = engineInfo.compareVersions('156.0.8078.73', '156.0.8090.10');
  eq('A3 构建号差 ⇒ build', c.level, 'build');
  ok('A3b build 级 outdated=true', c.outdated === true);

  c = engineInfo.compareVersions('152.0.7977.65', '156.0.8078.80');
  eq('A4 大版本差 ⇒ major', c.level, 'major');
  eq('A4b major 落后数准确', c.behind.major, 4);

  c = engineInfo.compareVersions(null, '156.0.8078.80');
  eq('A5 当前版本读不到 ⇒ unknown', c.level, 'unknown');
  eq('A5b unknown 时 outdated=null（绝不冒充"已最新"）', c.outdated, null);

  c = engineInfo.compareVersions('156.0.8078.73', null);
  eq('A6 最新版本拿不到 ⇒ unknown', c.level, 'unknown');

  eq('A7 parseVer 解析四段', JSON.stringify(engineInfo.parseVer('156.0.8078.73')), JSON.stringify([156, 0, 8078, 73]));
  eq('A8 parseVer 非法输入 ⇒ null', engineInfo.parseVer('abc'), null);

  // ---------------- B 在线检测 ----------------
  console.log('\n--- B checkNow / getStatus ---');
  wipeState();
  stub();
  let s = await engineInfo.checkNow();
  eq('B1 检测成功 ⇒ latest 来自官方源', s.latest, '156.0.8078.80');
  eq('B1b 记录数据源名', s.source, 'chrome-for-testing');
  ok('B1c checkedAt 已写入', typeof s.checkedAt === 'number' && s.checkedAt > 0);
  eq('B1d 成功时无 error', s.error, null);
  eq('B1e 当前内核与官方差 ⇒ outdated=true', s.outdated, true);
  ok('B1f 状态已落盘', fs.existsSync(path.join(TMP_ROOT, 'engine-status.json')));

  stub();
  s = await engineInfo.getStatus({});
  eq('B2 TTL 内 ⇒ 命中磁盘缓存，不再联网', calls.fetch, 0);
  eq('B2b 缓存也返回完整状态', s.latest, '156.0.8078.80');

  stub();
  s = await engineInfo.getStatus({ force: true });
  ok('B3 force=true ⇒ 强制联网', calls.fetch >= 1, 'fetch=' + calls.fetch);

  // 第一个源失败 → 回退第二个源
  stub({ fetchPlan: (url) => (url.includes('last-known-good') ? { ok: false, error: 'dns fail' } : { ok: true, version: '156.0.8078.80' }) });
  s = await engineInfo.checkNow();
  eq('B4 主源失败 ⇒ 回退备用源成功', s.source, 'chromiumdash');
  eq('B4b 回退后仍有 latest', s.latest, '156.0.8078.80');
  eq('B4c 回退成功不算错误', s.error, null);

  // 全部源失败：绝不能把"不知道"当成"已最新"
  wipeState();
  stub({ fetchPlan: () => ({ ok: false, error: 'offline' }) });
  s = await engineInfo.checkNow();
  has('B5 全部源失败 ⇒ error 可见', s.error, 'offline');
  eq('B5b 失败不得伪造 checkedAt（保持未检测态）', s.checkedAt, null);
  eq('B5c 失败时 latest 保持未知（不得写成当前版本冒充已最新）', s.latest, null);
  eq('B5d 结果为 unknown 而不是 up-to-date', s.level, 'unknown');

  // 有历史成功值 → 失败时保留旧 latest，但 error 必须暴露"这是旧结果"
  wipeState();
  stub();
  await engineInfo.checkNow();
  stub({ fetchPlan: () => ({ ok: false, error: 'offline-2' }), current: '156.0.8078.73' });
  s = await engineInfo.checkNow();
  eq('B6 历史 latest 保留', s.latest, '156.0.8078.80');
  has('B6b 同时暴露本次失败原因（旧结果≠最新结论）', s.error, 'offline-2');

  // ---------------- C 触发更新 ----------------
  console.log('\n--- C triggerUpdate ---');
  wipeState();
  stub();
  await engineInfo.checkNow();
  let rec = await engineInfo.triggerUpdate();
  eq('C1 更新器成功 ⇒ ok=true', rec.ok, true);
  ok('C1b 成功后必须失效版本缓存（否则 UA 仍写旧版本）', calls.invalidate === 1, 'invalidate=' + calls.invalidate);

  wipeState();
  stub({ updateResult: { ok: false, error: '未找到 Google Update', via: null } });
  rec = await engineInfo.triggerUpdate();
  eq('C2 更新器失败 ⇒ ok=false', rec.ok, false);
  has('C2b 失败原因回传', rec.error, '未找到 Google Update');
  ok('C2c 失败不失效缓存（未发生版本变化）', calls.invalidate === 0, 'invalidate=' + calls.invalidate);

  // C2 已把 update 记录写进状态；这里不得再清文件（清掉就成了测试自己制造的假失败）
  stub();
  s = await engineInfo.getStatus({});
  ok('C3 状态里能读到上次更新尝试记录', !!(s.update && typeof s.update === 'object'), JSON.stringify(s.update));

  engineInfo.__resetDepsForTest();

  // ---------------- D 接线 ----------------
  console.log('\n--- D 接线 ---');
  const idxSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  ok('D1 提供内核状态读取路由', idxSrc.includes("router.get('/system/engine'"), 'missing');
  ok('D2 提供强制检测路由', idxSrc.includes("router.post('/system/engine/check'"), 'missing');
  ok('D3 提供触发更新路由 + 权限闸', /router\.post\('\/system\/engine\/update'[\s\S]{0,400}profile:manage/.test(idxSrc), 'missing');
  ok('D4 启动时启用定期检测', idxSrc.includes('engineInfo.startScheduler()'), 'missing');
  const bmSrc = fs.readFileSync(path.join(__dirname, '..', 'browserManager.js'), 'utf8');
  // 这条必须锚「短路条件本身带文件指纹」，只锚变量名会被"永久缓存 + 声明了 stamp 却不用"绕过
  ok('D5 版本缓存随 chrome.exe mtime 失效（C194 修 C184 的一半）',
    /if \(_chromeVerCache && _chromeVerStamp === stamp\) return _chromeVerCache;/.test(bmSrc)
    && /statSync\(SYSTEM_CHROME\)\.mtimeMs/.test(bmSrc), 'missing');
  ok('D6 暴露缓存失效入口', bmSrc.includes('cleanupOrphanedChromium, startZombieKiller') && bmSrc.includes('invalidateChromeVersionCache'), 'missing');
  const setSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'components', 'SettingsPanel.jsx'), 'utf8');
  ok('D7 设置页展示内核版本区块', setSrc.includes('浏览器内核') && setSrc.includes('EngineView'), 'missing');
  ok('D8 前端能触发检查与更新', setSrc.includes('api.checkEngine') && setSrc.includes('api.updateEngine'), 'missing');

  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 2 }); } catch (e) {}

  console.log('\n=== 结果: PASS=' + pass + ' FAIL=' + fail + ' ===');
  if (fail) { console.log('失败项:\n  ' + fails.join('\n  ')); process.exitCode = 1; }
})();
