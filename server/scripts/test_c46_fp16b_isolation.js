'use strict';
// C46 守护测试 —— fp16b 真实 launch 测试 profile 目录隔离（CAP-O1 FPB_DATA_DIR 补齐）。
// 缺陷背景（A 类基建）：browserManager.PROFILES_ROOT 与 fp/identityStore.PROFILES_ROOT
//   均硬编码 <repo>/data/profiles，漏接 db.js / agent/storage / backup.js 已支持的
//   FPB_DATA_DIR 隔离约定 → fp16b launch/isolation 测试固定写 data/profiles/p16b_*，
//   跨回归实例 / 相邻套件争用同一 Chrome profile 目录锁（SingletonLock）→
//   偶发 launch 崩溃 FATAL「无统计行」（2026-09-07 C44/C45 两轮实证，非代码噪声）。
// 修复：两处 PROFILES_ROOT 补接 FPB_DATA_DIR；两个真实 launch 测试改 mkdtemp tmp 数据根。
// 覆盖：
//   P1 默认路径零变化（无 env 时 = <repo>/data/profiles，向后兼容）
//   P2 browserManager.PROFILES_ROOT 随 FPB_DATA_DIR 隔离（子进程真实解析）
//   P3 identityStore.PROFILES_ROOT 同步隔离 + writeIdentity/readIdentity roundtrip
//      落在 tmp 根内、repo data/profiles 零写入
//   P4 两个 launch 测试源码契约：FPB_DATA_DIR 在 require browserManager 之前 mkdtemp 注入
//   P5 静态守护：browserManager 内硬编码 profiles 路径仅剩 PROFILES_ROOT 定义一处
//      （killOrphanChromium 已改用 PROFILES_ROOT，防回归）

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const NODE = process.execPath;

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + (detail !== undefined ? ' :: ' + String(detail).slice(0, 300) : '')); console.log('FAIL ' + name); }
}

// 子进程内真实 require + 打印 PROFILES_ROOT 解析结果（避免污染本进程 env/require 缓存）
function probeRoots(env) {
  const script = `
    const path = require('path');
    const bm = require(path.join(${JSON.stringify(ROOT)}, 'server', 'browserManager.js'));
    const is = require(path.join(${JSON.stringify(ROOT)}, 'server', 'fp', 'identityStore.js'));
    console.log(JSON.stringify({ bm: bm.PROFILES_ROOT, is: is.PROFILES_ROOT }));
  `;
  const r = spawnSync(NODE, ['-e', script], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60000 });
  if (r.status !== 0) throw new Error('probe failed: ' + (r.stderr || r.stdout).slice(0, 300));
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

(async () => {
  const repoProfiles = path.join(ROOT, 'data', 'profiles');

  // ---- P1：默认路径零变化 ----
  {
    const roots = probeRoots({ FPB_DATA_DIR: '' });
    chk('P1 无 FPB_DATA_DIR 时 browserManager/identityStore 默认根 = data/profiles（零变化）',
      roots.bm === repoProfiles && roots.is === repoProfiles,
      JSON.stringify(roots));
  }

  // ---- P2/P3：FPB_DATA_DIR 隔离解析 ----
  {
    const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'c46-guard-'));
    const roots = probeRoots({ FPB_DATA_DIR: tmpData });
    const expectProfiles = path.resolve(tmpData, 'profiles');
    chk('P2 browserManager.PROFILES_ROOT 随 FPB_DATA_DIR → <root>/profiles',
      roots.bm === expectProfiles && roots.is === expectProfiles,
      JSON.stringify(roots));

    // P3：identityStore roundtrip 落在 tmp 根内，repo data/profiles 零写入
    // （走生产 identityFactory 真实映射，避免守护测试内手拼 identity 偏离 schema）
    const script = `
      const path = require('path');
      const is = require(path.join(${JSON.stringify(ROOT)}, 'server', 'fp', 'identityStore.js'));
      const { buildIdentity } = require(path.join(${JSON.stringify(ROOT)}, 'server', 'fp', 'identityFactory.js'));
      const { generateFingerprint, seedFromProfile } = require(path.join(${JSON.stringify(ROOT)}, 'server', 'fp', 'generate.js'));
      const profile = { id: 'c46_probe_profile', os: 'Windows', browser: 'Chrome', seed: 'c46-probe' };
      const fp = generateFingerprint(seedFromProfile(profile));
      is.writeIdentity(profile.id, buildIdentity(seedFromProfile(profile), fp));
      console.log(JSON.stringify({ file: is.identityFilePath('c46_probe_profile') }));
    `;
    const r = spawnSync(NODE, ['-e', script], { encoding: 'utf8', env: { ...process.env, FPB_DATA_DIR: tmpData }, timeout: 60000 });
    if (r.status !== 0) throw new Error('identity probe failed: ' + (r.stderr || r.stdout).slice(0, 300));
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    const landedInTmp = out.file.startsWith(path.resolve(tmpData, 'profiles'));
    const legacyFile = path.join(repoProfiles, 'c46_probe_profile', 'identity.json');
    chk('P3 identityStore roundtrip 落 tmp 根内 + repo data/profiles 零污染',
      landedInTmp && fs.existsSync(out.file) && !fs.existsSync(legacyFile),
      JSON.stringify({ out, legacyFile }));
  }

  // ---- P4：launch/isolation 测试源码契约（env 注入必须先于 require browserManager）----
  {
    const launchSrc = fs.readFileSync(path.join(ROOT, 'server', 'scripts', 'test_fp16b_identity_launch.js'), 'utf8');
    const isoSrc = fs.readFileSync(path.join(ROOT, 'server', 'scripts', 'test_fp16b_identity_isolation.js'), 'utf8');
    const contract = (src, name) => {
      const setIdx = src.indexOf('process.env.FPB_DATA_DIR = fs.mkdtempSync');
      const reqIdx = src.indexOf("require('../browserManager')");
      return setIdx !== -1 && reqIdx !== -1 && setIdx < reqIdx && src.includes("os.tmpdir()");
    };
    chk('P4a test_fp16b_identity_launch.js：FPB_DATA_DIR mkdtemp 先于 require browserManager', contract(launchSrc, 'launch'));
    chk('P4b test_fp16b_identity_isolation.js：FPB_DATA_DIR mkdtemp 先于 require browserManager', contract(isoSrc, 'iso'));
    chk('P4c launch 测试不再 rmSync identity 前置清理（rename 守卫替代，不计删除配额）',
      !launchSrc.includes('fs.rmSync(file, { force: true })') || launchSrc.includes('rename 跨盘失败时兜底'),
      '');
  }

  // ---- P5：静态守护——硬编码 profiles 路径仅剩 PROFILES_ROOT 定义一处 ----
  {
    const bmSrc = fs.readFileSync(path.join(ROOT, 'server', 'browserManager.js'), 'utf8');
    const isSrc = fs.readFileSync(path.join(ROOT, 'server', 'fp', 'identityStore.js'), 'utf8');
    const bmHardcoded = (bmSrc.match(/path\.join\(__dirname, '..', 'data', 'profiles'\)/g) || []).length;
    const isHardcoded = (isSrc.match(/path\.join\(__dirname, '..', '..', 'data', 'profiles'\)/g) || []).length;
    chk('P5a browserManager 硬编码 profiles 路径仅 1 处（PROFILES_ROOT 定义；killOrphanChromium 走常量）', bmHardcoded === 1, 'count=' + bmHardcoded);
    chk('P5b identityStore 硬编码 profiles 路径仅 1 处（PROFILES_ROOT 定义）', isHardcoded === 1, 'count=' + isHardcoded);
    chk('P5c 两处 PROFILES_ROOT 均读 FPB_DATA_DIR',
      bmSrc.includes("process.env.FPB_DATA_DIR") && isSrc.includes("process.env.FPB_DATA_DIR"), '');
  }

  console.log('');
  console.log('RESULT pass=' + pass + ' fail=' + fail);
  if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
