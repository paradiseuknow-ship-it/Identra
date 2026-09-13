'use strict';
// C116 守护测试 —— 备份/恢复的双数据根覆盖（tmp 隔离、零浏览器、零 LLM、零网络）。
//
// 缺陷背景（D1，A 类 · AI store 零备份覆盖）：
//   设计上数据根有两个（.gitignore:22-23 明文）：
//     db 根  <repo>/data         —— db.js(profiles/proxies/tasks) + identity/audit/
//                                   fpTemplates + vault/settings + backup
//     AI 根  <repo>/server/data  —— agent 层 JsonStore 的 FILES 集合（ai* 全家）+ archive/
//   而 backup.js 只解析 db 根 ⇒「导出」拿到的是 db 根里那些 **空桩**（`[]`），真实 AI 集合
//   一个都没进快照；「恢复」又把空集合写回，全程报成功。实测两侧差距：
//     AI 根 28 个集合 / 8,785,767 字节（aiExecutions 1.7MB / aiAttempts 1.4MB / aiTasks 1.4MB…）
//     db 根 同名 24 个文件 / 合计 484 字节（全是 `[]`）
//   最坏后果：换机/重装后恢复 → agent 全量记忆、证据链、执行记录、Skill 库静默蒸发，
//   而备份文件看起来完好（原注释还声称「含 ai* 全家」= 假陈述）。
//
// 覆盖：
//   A 组 aiStoreRoot 语义（5）：默认=<repo>/server/data（子进程删 env 实测）+ 随隔离 +
//                              绝对化 + legacyDataRoot 不随 env（迁移源必须留原地）
//   B 组 注册表不相交（4）：AI 集合名 ⇄ db 自有名无交集 + rootOf 裁定 + size 一致
//   C 组 D1 快照取真数据（8）：修复前 C1/C5 必红
//   D 组 恢复写回原位 + 防呆覆盖两根（6）
//   E 组 ★★ v1 兼容不得毁数据（3）：v1 回 db 根，AI 根真数据逐字不变
//   F 组 拒绝路径不落盘（2）
//   G 组 静态锚（7）：8 个模块无第二份根解析实现 + backup 双 require + 机制有效性
//   H 组 T24 隔离零污染（3）：**两个**真实数据根顶层条目零变化
//
// ★ 为什么必须注入 opts.roots：隔离模式下 dataRoot() === aiStoreRoot()（都等于
//   FPB_DATA_DIR）⇒ 双根塌缩成一个，**基于隔离的测试从结构上无法暴露本缺陷** ——
//   这正是 D1 长期未被发现的原因。故测试显式注入两个不同的 tmp 根还原非隔离语义。
// 纪律：断言「真正执行的那份东西」（真实 backup 模块行为 + stripComments 后的源码锚）；
// require 业务模块之前先隔离 FPB_DATA_DIR；收尾核验两个真实数据根零污染。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const REAL_DB_ROOT = path.join(ROOT, 'data');
const REAL_AI_ROOT = path.join(ROOT, 'server', 'data');

// ── 隔离必须在 require 业务模块之前（C113 教训）──
const ISO = fs.mkdtempSync(path.join(os.tmpdir(), 'c116-'));
process.env.FPB_DATA_DIR = ISO;
process.env.FPB_VAULT_FILE = path.join(ISO, 'vault.json');
process.env.FPB_SETTINGS_FILE = path.join(ISO, 'runtime_settings.json');

const DATAROOT = path.join(ROOT, 'server', 'dataRoot.js');
const BACKUP = path.join(ROOT, 'server', 'backup.js');

const { dataRoot, aiStoreRoot, legacyDataRoot } = require(DATAROOT);
const { FILES } = require(path.join(ROOT, 'server', 'agent', 'storage', 'jsonStore.js'));
const backup = require(BACKUP);

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}

// 注释剥离：静态断言一律扫「真代码」，否则注释里出现的词会造成 17-D S1/S2 式假阳性
function stripComments(s) {
  return String(s)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, '$1'))
    .join('\n');
}
const norm = (p) => String(p).replace(/\\/g, '/');
const readText = (p) => fs.readFileSync(p, 'utf8');

const tmpRoots = [ISO];
function mkTmp(tag) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'c116-' + tag + '-')); tmpRoots.push(d); return d; }
function writeJson(p, v) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v)); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function exists(p) { try { fs.statSync(p); return true; } catch (e) { return false; } }
function subdirs(p) { try { return fs.readdirSync(p).filter((n) => { try { return fs.statSync(path.join(p, n)).isDirectory(); } catch (e) { return false; } }); } catch (e) { return []; } }

// 真实数据根顶层条目快照（H 组用；只取顶层，避免递归大目录）
function topEntries(p) { try { return fs.readdirSync(p).sort().join(','); } catch (e) { return '(absent)'; } }
const dbBefore = topEntries(REAL_DB_ROOT);
const aiBefore = topEntries(REAL_AI_ROOT);

// 子进程执行（可控制 env；用于「非隔离」语义断言）
function child(code, envOverride) {
  const env = { ...process.env };
  delete env.FPB_DATA_DIR;
  Object.assign(env, envOverride || {});
  const r = spawnSync(process.execPath, ['-e', code], { cwd: ROOT, encoding: 'utf8', env });
  return { out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), status: r.status };
}
const DATAROOT_FWD = norm(DATAROOT);

const savedVaultFile = process.env.FPB_VAULT_FILE;

(async () => {
  try {
    // ═══════════ A 组：aiStoreRoot() 语义 ═══════════
    {
      const a1 = child("const m=require('" + DATAROOT_FWD + "');process.stdout.write(m.aiStoreRoot()+'|'+m.legacyDataRoot());");
      const [ai, legacy] = a1.out.split('|');
      chk('A1 aiStoreRoot 默认解析到 <repo>/server/data（子进程删 env 实测）',
        norm(ai) === norm(REAL_AI_ROOT), norm(ai) + ' err=' + a1.err.slice(0, 140));
      chk('A2 legacyDataRoot 默认同样是 <repo>/server/data（迁移源）',
        norm(legacy) === norm(REAL_AI_ROOT), norm(legacy));

      const iso = mkTmp('a-iso');
      const a3 = child("const m=require('" + DATAROOT_FWD + "');process.stdout.write(m.aiStoreRoot()+'|'+m.legacyDataRoot());",
        { FPB_DATA_DIR: iso });
      const [ai3, legacy3] = a3.out.split('|');
      chk('A3 FPB_DATA_DIR 设置时 aiStoreRoot 随隔离（AI 根不再是真实目录）',
        norm(ai3) === norm(iso), norm(ai3));
      chk('A4 ★ 隔离下 legacyDataRoot 仍指向真实 server/data（迁移源不随隔离漂移，'
        + '否则隔离测试会把真实数据复制进 tmp）',
        norm(legacy3) === norm(REAL_AI_ROOT), norm(legacy3));

      const a5 = child("const m=require('" + DATAROOT_FWD + "');process.stdout.write(m.aiStoreRoot());",
        { FPB_DATA_DIR: 'sub/dir-probe' });
      chk('A5 FPB_DATA_DIR 为相对路径时解析为绝对路径',
        path.isAbsolute(a5.out) && norm(a5.out).endsWith('/sub/dir-probe'), a5.out);
    }

    // ═══════════ B 组：注册表不相交（路由唯一性的前提）═══════════
    {
      const fileNames = new Set(Object.values(FILES));
      const dbOwned = ['profiles.json', 'proxies.json', 'tasks.json',
        'identity_users.json', 'identity_workspaces.json', 'identity_memberships.json',
        'identity_sessions.json', 'identity_apikeys.json', 'identity_audit.json',
        'vault.json', 'runtime_settings.json'];
      const overlap = dbOwned.filter((n) => fileNames.has(n));

      chk('B1 AI_STORE_NAMES 与 FILES 值集合一致（size 相等）',
        backup.AI_STORE_NAMES.size === fileNames.size && backup.AI_STORE_NAMES.size === Object.keys(FILES).length,
        backup.AI_STORE_NAMES.size + ' vs files=' + fileNames.size + ' keys=' + Object.keys(FILES).length);
      chk('B2 ★ db 根自有集合名与 AI 集合名零交集（否则「按名路由」不再唯一）',
        overlap.length === 0, overlap.join(','));
      chk('B3 rootOf：AI 集合裁定到 ai 根', backup.rootOf('aiTasks.json') === 'ai' && backup.rootOf('aiSkill.json') === 'ai', '');
      chk('B4 rootOf：db 根自有名裁定到 db 根',
        backup.rootOf('profiles.json') === 'db' && backup.rootOf('identity_users.json') === 'db' && backup.rootOf('vault.json') === 'db', '');
    }

    // ═══════════ C 组：★ D1 —— 快照必须取真数据而非空桩（修复前 C1/C5 必红）═══════════
    const REAL_ROWS = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];
    {
      delete process.env.FPB_VAULT_FILE; // 该组只关心两根的集合，不掺 vault 特例
      const dbRoot = mkTmp('c-db');
      const aiRoot = mkTmp('c-ai');
      // db 根：AI 集合名全是空桩（复刻真实现场），另有 db 根自有的真数据
      writeJson(path.join(dbRoot, 'aiExecutions.json'), []);
      writeJson(path.join(dbRoot, 'aiTasks.json'), []);
      writeJson(path.join(dbRoot, 'aiWorkers.json'), [{ id: 'db-side' }]);
      writeJson(path.join(dbRoot, 'profiles.json'), [{ id: 'p1' }]);
      // AI 根：真数据（含只存在于 AI 根的集合）
      writeJson(path.join(aiRoot, 'aiExecutions.json'), REAL_ROWS);
      writeJson(path.join(aiRoot, 'aiTasks.json'), REAL_ROWS);
      writeJson(path.join(aiRoot, 'aiPlannerEvidence.json'), [{ id: 'pe1' }]);
      writeJson(path.join(aiRoot, 'aiWorkers.json'), [{ id: 'ai-side' }]);

      const snap = backup.collectSnapshot({ roots: { db: dbRoot, ai: aiRoot } });

      chk('C1 ★★ AI 集合取到 AI 根真数据而非 db 根空桩（修复前必红：旧实现只扫 db 根 → 0 条）',
        Array.isArray(snap.files['aiExecutions.json']) && snap.files['aiExecutions.json'].length === REAL_ROWS.length,
        JSON.stringify(snap.files['aiExecutions.json']).slice(0, 120));
      chk('C2 fileRoots 把该文件标记为 ai 根',
        snap.fileRoots['aiExecutions.json'] === 'ai', String(snap.fileRoots['aiExecutions.json']));
      chk('C3 db 根自有集合仍取自 db 根（未被 AI 根劫持）',
        snap.files['profiles.json'] && snap.files['profiles.json'][0].id === 'p1', JSON.stringify(snap.files['profiles.json']));
      chk('C4 fileRoots 把 db 根自有集合标记为 db 根',
        snap.fileRoots['profiles.json'] === 'db', String(snap.fileRoots['profiles.json']));
      chk('C5 ★★ 只存在于 AI 根的集合也进快照（修复前必红：旧实现里完全缺失）',
        snap.files['aiPlannerEvidence.json'] && snap.files['aiPlannerEvidence.json'].length === 1,
        String(snap.files['aiPlannerEvidence.json']));
      chk('C6 同名文件按注册表裁定：aiWorkers 取 AI 根侧而非 db 根侧',
        snap.files['aiWorkers.json'] && snap.files['aiWorkers.json'][0].id === 'ai-side'
          && snap.fileRoots['aiWorkers.json'] === 'ai',
        JSON.stringify(snap.files['aiWorkers.json']));
      chk('C7 v2 元数据齐备（version=2 + fileRoots + roots 诊断字段）',
        snap.version === backup.BACKUP_VERSION && backup.BACKUP_VERSION === 2
          && snap.fileRoots && typeof snap.fileRoots === 'object'
          && snap.roots && norm(snap.roots.db) === norm(dbRoot) && norm(snap.roots.ai) === norm(aiRoot),
        'v=' + snap.version + ' roots=' + JSON.stringify(snap.roots && Object.keys(snap.roots)));
      chk('C8 空桩不遮蔽真数据（快照条数 == AI 根条数，且 != db 根空桩条数）',
        snap.files['aiTasks.json'].length === REAL_ROWS.length && snap.files['aiTasks.json'].length !== 0,
        String(snap.files['aiTasks.json'].length));
    }

    // ═══════════ D 组：恢复写回原位 + 防呆覆盖两个根 ═══════════
    {
      const dbRoot = mkTmp('d-db');
      const aiRoot = mkTmp('d-ai');
      writeJson(path.join(dbRoot, 'aiTasks.json'), []);              // 恢复前：db 根空桩
      writeJson(path.join(dbRoot, 'profiles.json'), [{ id: 'old-p' }]); // 恢复前：db 根旧值
      writeJson(path.join(aiRoot, 'aiTasks.json'), [{ id: 'old-ai' }]); // 恢复前：AI 根旧值

      const snap = {
        format: backup.BACKUP_FORMAT, version: 2, createdAt: Date.now(),
        files: { 'aiTasks.json': [{ id: 'new-ai' }], 'profiles.json': [{ id: 'new-p' }] },
        fileRoots: { 'aiTasks.json': 'ai', 'profiles.json': 'db' },
      };
      const r = backup.restoreSnapshot(snap, { roots: { db: dbRoot, ai: aiRoot } });

      chk('D1 AI 集合写回 AI 根（不是 db 根）',
        readJson(path.join(aiRoot, 'aiTasks.json'))[0].id === 'new-ai'
          && readJson(path.join(dbRoot, 'aiTasks.json')).length === 0,
        'ai=' + JSON.stringify(readJson(path.join(aiRoot, 'aiTasks.json'))) + ' db=' + JSON.stringify(readJson(path.join(dbRoot, 'aiTasks.json'))));
      chk('D2 db 根自有集合写回 db 根', readJson(path.join(dbRoot, 'profiles.json'))[0].id === 'new-p', '');
      chk('D3 ★ db 根生成防呆快照且含恢复前旧值',
        !!r.preRestoreDir && readJson(path.join(r.preRestoreDir, 'profiles.json'))[0].id === 'old-p',
        String(r.preRestoreDir));
      chk('D4 ★★ AI 根也生成防呆快照且含恢复前旧值（修复前无任何回滚点）',
        !!r.preRestoreDirs && !!r.preRestoreDirs.ai
          && readJson(path.join(r.preRestoreDirs.ai, 'aiTasks.json'))[0].id === 'old-ai',
        JSON.stringify(r.preRestoreDirs));
      chk('D5 preRestoreDirs 同时给出 db 与 ai 两个回滚目录',
        !!r.preRestoreDirs.db && !!r.preRestoreDirs.ai
          && norm(r.preRestoreDirs.db) !== norm(r.preRestoreDirs.ai),
        JSON.stringify(r.preRestoreDirs));
      // 只含 db 根文件的 v2 快照：不得去碰 AI 根（不做无谓的整根复制/覆写）
      const dbRoot2 = mkTmp('d-db2');
      const aiRoot2 = mkTmp('d-ai2');
      writeJson(path.join(aiRoot2, 'aiTasks.json'), [{ id: 'untouched' }]);
      const r2 = backup.restoreSnapshot({
        format: backup.BACKUP_FORMAT, version: 2, createdAt: Date.now(),
        files: { 'profiles.json': [{ id: 'x' }] }, fileRoots: { 'profiles.json': 'db' },
      }, { roots: { db: dbRoot2, ai: aiRoot2 } });
      chk('D6 只写 db 根的 v2 恢复不触碰 AI 根（无 ai 回滚目录、AI 根内容不变）',
        !subdirs(path.join(aiRoot2, 'backups')).length
          && readJson(path.join(aiRoot2, 'aiTasks.json'))[0].id === 'untouched'
          && r2.preRestoreDirs && !r2.preRestoreDirs.ai,
        JSON.stringify({ backups: subdirs(path.join(aiRoot2, 'backups')), pre: r2.preRestoreDirs }));
    }

    // ═══════════ E 组：★★ v1 兼容不得毁数据 ═══════════
    {
      const dbRoot = mkTmp('e-db');
      const aiRoot = mkTmp('e-ai');
      writeJson(path.join(dbRoot, 'aiExecutions.json'), [{ id: 'old-db-stub' }]);
      writeJson(path.join(aiRoot, 'aiExecutions.json'), REAL_ROWS); // AI 根真数据（1.7MB 的缩影）

      // v1 备份的语义：内容一律来自 db 根（旧实现只扫该根）。名字虽是 AI 集合，
      // 但绝不能被按名路由回 AI 根 —— 否则用空集合覆盖真数据。
      const v1 = {
        format: backup.BACKUP_FORMAT, version: 1, createdAt: Date.now(),
        files: { 'aiExecutions.json': [] }, // 旧版导出的正是这个空桩
      };
      const r = backup.restoreSnapshot(v1, { roots: { db: dbRoot, ai: aiRoot } });

      chk('E1 v1 备份按旧语义写回 db 根（不报错、restored 含该名）',
        Array.isArray(r.restored) && r.restored.indexOf('aiExecutions.json') >= 0
          && readJson(path.join(dbRoot, 'aiExecutions.json')).length === 0,
        JSON.stringify(r.restored));
      chk('E2 ★★ v1 备份绝不覆写 AI 根真数据（修复前若按注册表路由 → 真数据被 [] 覆盖）',
        readJson(path.join(aiRoot, 'aiExecutions.json')).length === REAL_ROWS.length,
        JSON.stringify(readJson(path.join(aiRoot, 'aiExecutions.json'))).slice(0, 120));
      chk('E3 v1 恢复不产生 AI 根回滚目录（未触碰该根）',
        r.preRestoreDirs && !r.preRestoreDirs.ai, JSON.stringify(r.preRestoreDirs));
    }

    // ═══════════ F 组：拒绝路径不落盘（沿用既有契约）═══════════
    {
      const dbRoot = mkTmp('f-db');
      const aiRoot = mkTmp('f-ai');
      let threw = 0;
      try { backup.restoreSnapshot({ format: 'other', version: 1, files: {} }, { roots: { db: dbRoot, ai: aiRoot } }); } catch (e) { threw++; }
      try { backup.restoreSnapshot({ format: backup.BACKUP_FORMAT, version: 99, files: {} }, { roots: { db: dbRoot, ai: aiRoot } }); } catch (e) { threw++; }
      try { backup.restoreSnapshot({ format: backup.BACKUP_FORMAT, version: 2 }, { roots: { db: dbRoot, ai: aiRoot } }); } catch (e) { threw++; }
      try {
        backup.restoreSnapshot({ format: backup.BACKUP_FORMAT, version: 2, files: { '../evil.json': {} } }, { roots: { db: dbRoot, ai: aiRoot } });
      } catch (e) { threw++; }
      chk('F1 四类坏快照全拒（坏 format / 坏 version / 缺 files / 路径穿越名）', threw === 4, String(threw));
      chk('F2 拒绝路径不在任一数据根落盘（无 backups/）',
        !exists(path.join(dbRoot, 'backups')) && !exists(path.join(aiRoot, 'backups')), '');
    }

    // ═══════════ G 组：静态锚（stripComments 后扫真代码）═══════════
    {
      const consumers = [
        'server/agent/storage/index.js',
        'server/agent/stepManager.js',
        'server/scripts/archiveAiStore.js',
        'server/agent/storage/migrationJsonToSqlite.js',
        'server/db.js',
        'server/browserManager.js',
        'server/fp/identityStore.js',
        'server/backup.js',
      ];
      const withInline = [];
      const noRequire = [];
      for (const rel of consumers) {
        const src = stripComments(readText(path.join(ROOT, rel)));
        if (/process\.env\.FPB_DATA_DIR/.test(src)) withInline.push(rel);
        if (!/require\([^)]*dataRoot/.test(src)) noRequire.push(rel);
      }
      chk('G1 ★ 8 个数据根消费模块均无第二份内联解析（无 process.env.FPB_DATA_DIR）',
        withInline.length === 0, withInline.join(','));
      chk('G2 ★ 8 个模块全部通过 require 消费 dataRoot 单一事实源',
        noRequire.length === 0, noRequire.join(','));

      const bsrc = stripComments(readText(BACKUP));
      chk('G3 backup.js 同时消费 dataRoot 与 aiStoreRoot（双根覆盖的前提）',
        /require\('\.\/dataRoot'\)/.test(bsrc) && /\baiStoreRoot\b/.test(bsrc), '');
      chk('G4 ★ 机制有效性：collectSnapshot 真的遍历两个根（不是恒取单根）',
        /ROOT_AI/.test(bsrc) && /ROOT_DB/.test(bsrc) && /available\[/.test(bsrc),
        'ROOT_AI=' + /ROOT_AI/.test(bsrc) + ' available=' + /available\[/.test(bsrc));
      chk('G5 ★ 机制有效性：restoreSnapshot 按 fileRoots 路由（存在按根取目录的分派）',
        /targetRootOf/.test(bsrc) && /targetRootOf\(name\)/.test(bsrc), '');
      chk('G6 v1 兼容分支存在且显式回落 db 根（不得按注册表路由 v1）',
        /isV2/.test(bsrc) && /return ROOT_DB;/.test(bsrc), '');
      chk('G7 dataRoot.js 导出 aiStoreRoot（具名事实源）',
        /module\.exports\s*=\s*\{[^}]*aiStoreRoot/.test(stripComments(readText(DATAROOT))), '');
    }

    // ═══════════ H 组：T24 隔离零污染 ═══════════
    {
      chk('H1 本测试进程的两个数据根均被隔离（未指向真实目录）',
        norm(dataRoot()) === norm(ISO) && norm(aiStoreRoot()) === norm(ISO),
        norm(dataRoot()) + ' / ' + norm(aiStoreRoot()));
      chk('H2 ★ 真实 db 根顶层条目零变化', topEntries(REAL_DB_ROOT) === dbBefore,
        'before=' + dbBefore.slice(0, 120) + ' after=' + topEntries(REAL_DB_ROOT).slice(0, 120));
      chk('H3 ★ 真实 AI 根顶层条目零变化', topEntries(REAL_AI_ROOT) === aiBefore,
        'before=' + aiBefore.slice(0, 120) + ' after=' + topEntries(REAL_AI_ROOT).slice(0, 120));
    }
  } catch (e) {
    fail++;
    failures.push('FATAL ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)));
    console.log('FATAL ' + (e && e.stack ? e.stack : e));
  } finally {
    if (savedVaultFile === undefined) delete process.env.FPB_VAULT_FILE; else process.env.FPB_VAULT_FILE = savedVaultFile;
    // 清理 tmp 根（best-effort；安全网：仅删 os.tmpdir 下的本次前缀目录）
    for (const d of tmpRoots) {
      try { if (norm(d).indexOf(norm(os.tmpdir())) === 0) fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  }

  console.log('\n===== C116 RESULT: ' + pass + ' passed, ' + fail + ' failed =====');
  if (failures.length) { console.error('FAILED: ' + failures.join(' | ')); process.exit(1); }
})();
