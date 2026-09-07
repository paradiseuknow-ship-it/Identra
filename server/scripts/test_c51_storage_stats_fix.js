'use strict';
// C51 守护测试 —— 存储统计与清理参数硬化（tmp 隔离、零浏览器、零网络、零删除真实文件）。
// 缺陷背景（三处真实缺陷，均 C47 落地代码的后续缺陷扫描发现）：
//   D1 B 类双重计数：collectStats 的 collections 项统计整个 data 目录（含 data/profiles），
//      与 profiles 项重复计数；label「业务数据集合（data 其余）」与实现口径不符 → 仪表盘体积失真。
//   D2 keepRecent 负数语义反转：slice(0, 负数) 使 kept 保留其余、candidates 取到最旧 N 条
//      当清理对象（路由层 Number()||default 只挡 NaN 挡不住负数）→ 库级钳制，非法值回落保守默认（7/3）。
//   D3 existsSync 双重调用：collectStats 每目录调两次 existsSync，存在 TOCTOU 竞态窗口 → 合并为一次。
// 覆盖：
//   P1 dirSize excludeTop：第一层整棵剪枝正确，深层同名目录不受影响
//   P2 collectStats dirs 注入：collections 排除 profiles（无双重计数），无内部字段泄漏
//   P3 cleanup keepRecent 负数钳制：与 keepRecent=0 语义一致（cutoff 内全进 candidates）
//   P4 cleanup olderThanDays 非法值回落默认 7（负数/NaN）
//   P5 缓存行为保留（force=false 命中缓存；resetCacheForTests 生效）

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

(async () => {
  const ss = require(path.join(ROOT, 'server', 'systemStorage.js'));

  // P1：dirSize excludeTop —— 第一层剪枝 + 深层不受影响
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c50-'));
    fs.writeFileSync(path.join(tmp, 'biz.json'), 'x'.repeat(100));
    fs.mkdirSync(path.join(tmp, 'profiles'));            // 第一层：应被剪掉
    fs.writeFileSync(path.join(tmp, 'profiles', 'p.bin'), 'y'.repeat(2048));
    fs.mkdirSync(path.join(tmp, 'sub'));
    fs.mkdirSync(path.join(tmp, 'sub', 'profiles'));     // 深层同名：不剪
    fs.writeFileSync(path.join(tmp, 'sub', 'profiles', 'nested.txt'), 'z'.repeat(30));
    const full = await ss.dirSize(tmp);
    const ex = await ss.dirSize(tmp, { excludeTop: ['profiles'] });
    chk('P1a 无排除时全量统计', full.bytes === 100 + 2048 + 30 && full.files === 3, 'full=' + JSON.stringify(full));
    chk('P1b excludeTop 剪掉第一层 profiles（深层保留）',
      ex.bytes === 100 + 30 && ex.files === 2 && !ex.truncated, 'ex=' + JSON.stringify(ex));
  }

  // P2：collectStats dirs 注入 —— collections 无双重计数 + 无内部字段泄漏
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'c50-stat-'));
    const dData = path.join(base, 'data');
    const dProfiles = path.join(dData, 'profiles');
    const dBench = path.join(base, '.benchmark');
    const dDist = path.join(base, 'dist');
    fs.mkdirSync(dProfiles, { recursive: true });
    fs.mkdirSync(dBench, { recursive: true });
    fs.mkdirSync(dDist, { recursive: true });
    fs.writeFileSync(path.join(dData, 'aiTasks.json'), 'a'.repeat(400));
    fs.writeFileSync(path.join(dProfiles, 'chr.bin'), 'b'.repeat(1000));
    fs.writeFileSync(path.join(dBench, 'run.log'), 'c'.repeat(200));
    fs.writeFileSync(path.join(dDist, 'index.html'), 'd'.repeat(50));
    const items = await ss.collectStats({
      force: true,
      dirs: { benchmark: dBench, profiles: dProfiles, collections: dData, dist: dDist },
    });
    const by = Object.fromEntries(items.map((i) => [i.key, i]));
    chk('P2a 4 类统计齐全且 exists=true',
      items.length === 4 && ['benchmark', 'profiles', 'collections', 'dist'].every((k) => by[k] && by[k].exists === true),
      'keys=' + items.map((i) => i.key + ':' + i.exists).join(','));
    chk('P2b profiles 统计 = profiles 目录本身',
      by.profiles.bytes === 1000 && by.profiles.files === 1, 'profiles=' + JSON.stringify(by.profiles));
    chk('P2c collections 排除 profiles（D1 双重计数修复）',
      by.collections.bytes === 400 && by.collections.files === 1, 'collections=' + JSON.stringify(by.collections));
    chk('P2d 无双重计数：collections.bytes + profiles.bytes === data 全量',
      by.collections.bytes + by.profiles.bytes === 1400, 'sum=' + (by.collections.bytes + by.profiles.bytes));
    chk('P2e 内部字段不泄漏（excludeTop 不出现在响应）',
      items.every((i) => !('excludeTop' in i)), 'leak=' + JSON.stringify(items.filter((i) => 'excludeTop' in i).map((i) => i.key)));
    // P2f：缓存命中（同参数二次调用返回缓存引用；随后清理防止污染其它用例）
    const again = await ss.collectStats({
      force: false,
      dirs: { benchmark: dBench, profiles: dProfiles, collections: dData, dist: dDist },
    });
    chk('P2f force=false 命中缓存', again === items, 'again!==items');
    ss.resetCacheForTests();
  }

  // P3：keepRecent 负数钳制（D2 语义反转修复）—— 全 tmp 隔离，不消耗宿主删除配额。
  // 语义：非法值回落保守默认 3（保留更多）；修复点 = 不再出现 slice(-N) 反转（最旧 N 条被当清理对象）。
  {
    const bench = fs.mkdtempSync(path.join(os.tmpdir(), 'c50-bench-'));
    const mk = (name, size, ageDays) => {
      const f = path.join(bench, name);
      fs.writeFileSync(f, 'x'.repeat(size));
      if (ageDays != null) {
        const t = new Date(Date.now() - ageDays * 24 * 3600 * 1000);
        fs.utimesSync(f, t, t);
      }
      return f;
    };
    // 三个旧 log 使用互异年龄（30/31/32 天）消除 mtime 同毫秒平局——
    // 平局时稳定排序保持 readdir 字母序，kept 的第 3 席会按字母序落在 old2（已实证的布景陷阱）
    mk('run_old1.log', 100, 30);
    mk('run_old2.log', 200, 31);
    mk('run_old3.log', 300, 32);
    mk('run_new1.log', 400);
    mk('run_new2.log', 500);
    const pNeg = await ss.cleanup({
      targets: ['benchmarkLogs'], keepRecent: -1, dryRun: true, benchDir: bench,
    });
    // 修复后语义：keepRecent=-1 → 回落默认 3 → kept=3 个最新（new2/new1/old1），
    // candidates 仅剩满足 cutoff 的 old2/old3（旧行为若未钳制会反转取 slice(-1)）
    const okNeg = pNeg.ok && pNeg.freed === 500 && pNeg.count === 2
      && pNeg.plan.every((p) => /old\d/.test(p.file));
    chk('P3a keepRecent=-1 回落默认 3：fresh/old1 保留、仅 old2/old3 进 candidates（无反转）',
      okNeg, 'r=' + JSON.stringify({ freed: pNeg.freed, count: pNeg.count, files: (pNeg.plan || []).map((p) => p.file) }));
    const pZero = await ss.cleanup({
      targets: ['benchmarkLogs'], keepRecent: 0, dryRun: true, benchDir: bench,
    });
    // keepRecent=0 是合法值：无「最近保留」，全部按 cutoff 判定 → 3 个旧 log 全进 candidates
    chk('P3b keepRecent=0：3 个旧 log 全进 candidates（区别于 -1 回落 3）',
      pZero.ok && pZero.freed === 600 && pZero.count === 3, 'zero=' + JSON.stringify({ freed: pZero.freed, count: pZero.count }));
    // 新鲜 log（400/500B）永不被误删——candidates 体积必须全部小于新鲜文件
    chk('P3c 新鲜 log 不进 candidates',
      pNeg.plan.concat(pZero.plan).every((p) => p.size < 400), 'plans=' + JSON.stringify([pNeg.plan.map((p) => p.file), pZero.plan.map((p) => p.file)]));
  }

  // P4：olderThanDays 非法值回落默认 7（需 6 文件布景使 clamp 可判别：
  // kept 保护 3 个最新，candidates 尾部含 3 天/9 天/10 天——若 -5 未钳制，cut=未来 → 3 天文件会被误选）
  {
    const bench = fs.mkdtempSync(path.join(os.tmpdir(), 'c50-otd-'));
    const mk = (name, size, ageDays) => {
      const f = path.join(bench, name);
      fs.writeFileSync(f, 'x'.repeat(size));
      if (ageDays != null) {
        const t = new Date(Date.now() - ageDays * 24 * 3600 * 1000);
        fs.utimesSync(f, t, t);
      }
      return f;
    };
    mk('run_a.log', 100, 0);   // kept
    mk('run_b.log', 100, 0);   // kept
    mk('run_c.log', 100, 0);   // kept
    mk('run_d3d.log', 300, 3);   // candidates 尾部：3 天（钳制后不应入选）
    mk('run_e9d.log', 900, 9);   // 钳制后入选
    mk('run_f10d.log', 1000, 10); // 钳制后入选
    const pNeg = await ss.cleanup({
      targets: ['benchmarkLogs'], olderThanDays: -5, keepRecent: 3, dryRun: true, benchDir: bench,
    });
    chk('P4a olderThanDays=-5 回落默认 7：仅 9d/10d 入选、3d 不入选',
      pNeg.ok && pNeg.freed === 1900 && pNeg.count === 2
        && pNeg.plan.every((p) => /e9d|f10d/.test(p.file)),
      'r=' + JSON.stringify({ freed: pNeg.freed, count: pNeg.count, files: (pNeg.plan || []).map((p) => p.file) }));
    const pNaN = await ss.cleanup({
      targets: ['benchmarkLogs'], olderThanDays: NaN, keepRecent: 3, dryRun: true, benchDir: bench,
    });
    chk('P4b olderThanDays=NaN 回落默认 7', pNaN.ok && pNaN.freed === 1900 && pNaN.count === 2, 'freed=' + pNaN.freed);
    // 全新文件 + 默认 7 → 无候选（不删任何东西）
    const bench2 = fs.mkdtempSync(path.join(os.tmpdir(), 'c50-otd2-'));
    fs.writeFileSync(path.join(bench2, 'run.log'), 'x'.repeat(10));
    const pFresh = await ss.cleanup({ targets: ['benchmarkLogs'], dryRun: true, benchDir: bench2 });
    chk('P4c 全新鲜目录：无可清理项', pFresh.ok && pFresh.count === 0 && pFresh.freed === 0, 'r=' + JSON.stringify({ count: pFresh.count, freed: pFresh.freed }));
  }

  // P5：缓存隔离（resetCacheForTests 后不返回前次注入结果；四类全 tmp 注入避免扫真实大目录）
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'c50-cache-'));
    const dData = path.join(base, 'data');
    fs.mkdirSync(dData, { recursive: true });
    fs.writeFileSync(path.join(dData, 'x.json'), 'x'.repeat(10));
    const mkEmpty = (p) => { fs.mkdirSync(p, { recursive: true }); return p; };
    const dirs = { benchmark: mkEmpty(path.join(base, 'b')), profiles: mkEmpty(path.join(base, 'p')), collections: dData, dist: mkEmpty(path.join(base, 'd')) };
    const a = await ss.collectStats({ force: true, dirs });
    ss.resetCacheForTests();
    const b = await ss.collectStats({ force: true, dirs });
    chk('P5 reset 后重新统计（不命中旧缓存）', a !== b && b[2].bytes === 10, 'b2=' + JSON.stringify(b[2]));
    ss.resetCacheForTests();
  }

  console.log('----');
  console.log('PASS=' + pass + ' FAIL=' + fail);
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
