'use strict';
// C115 守护测试 —— 存储 I/O 数据完整性硬化（tmp 隔离、零浏览器、零 LLM、零网络）。
//
// 缺陷背景（跨切面水平复审产出，2×A 类 + 3×B 类）：
//   D1 (A/数据永久丢失) jsonStore.read() 的 JSON.parse 失败分支直接吞 fallback，
//      坏的主集合文件**没有侧车保全** → 紧接着的 RMW（insert/upsert/update/remove/
//      appendEvent）把「空集合 + 新记录」覆写回去，损坏前的全量数据永久蒸发且无从取证。
//      同文件 _archiveAppend 早已有侧车保全（C60 D2 修的），主集合反而没有 = 不对称。
//      C60 只堵住了「瞬时锁导致的读失败」这一个入口，「文件内容损坏」是同一后果面的
//      另一个入口，此前无防护。
//   D2 (A/无界增长) aiIntelligenceEvaluations（Runtime 每个任务终态 collect() 一条）
//      与 aiDispatchExecutions（每次派遣一条）注册了 FILES 却从未给水位 → 随任务量
//      线性增长；每次写触发全量 read+structuredClone+write（aiAttempts 42MB 事故同款）。
//   D5 (B/治理缺失) FILES 与 AUTO_ARCHIVE_LIMITS 之间零一致性约束 → 新集合只改前者
//      即可静默无水位，D2 正是这样漏了这么久。
//   D3 (A/B/隔离失效) evidence.js（截图根）与 profileMetrics.js（profiles/proxies）
//      是完全不认 FPB_DATA_DIR 的两个模块 → 隔离测试把截图写进**真实** data 目录，
//      长期无界累积并污染真实证据链。
//   D4 (B/非原子写) backup.js 恢复写回用裸 fs.writeFileSync → 中断留半截 JSON，
//      与 D1 串成「备份恢复中断 → 该集合被下次 RMW 静默清空」的连锁。
//
// 覆盖：
//   A 组 D1 侧车保全（10）：契约保持 + 侧车存在/内容/原位清除 + RMW 全链路 + 去重序号
//   B 组 D2 水位（5）：两表登记 + 超限归档行为 + 归档内容 + 主文件截尾 + 不丢数据
//   C 组 D5 治理（5）：gaps 为空 + 双向一致性 + 无重复 + 机制有效性静态锚
//   D 组 D3 数据根（7）：非隔离等价 + 子进程隔离生效×2 + 硬编码残留静态锚×2 + 夹具跟随
//   E 组 D4 原子写（4）：静态锚×2 + 真实恢复无 .tmp 残留 + 内容正确
//   F 组 T24 隔离零污染（2）：真实 data 目录条目零变化 + 全程 tmp
// 纪律：断言「真正执行的那份东西」（真实 JsonStore/backup 模块行为 + stripComments 后
// 的源码锚）；require 业务模块之前先隔离 FPB_DATA_DIR；收尾核验真实数据目录零污染。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const REAL_DATA = path.join(ROOT, 'data');

// ── 隔离必须在 require 业务模块之前（C113 教训）──
const ISO = fs.mkdtempSync(path.join(os.tmpdir(), 'c115-'));
process.env.FPB_DATA_DIR = ISO;
process.env.FPB_VAULT_FILE = path.join(ISO, 'vault.json');
process.env.FPB_SETTINGS_FILE = path.join(ISO, 'runtime_settings.json');

const JSONSTORE = path.join(ROOT, 'server', 'agent', 'storage', 'jsonStore.js');
const BACKUP = path.join(ROOT, 'server', 'backup.js');
const EVIDENCE = path.join(ROOT, 'server', 'agent', 'evidence.js');
const METRICS = path.join(ROOT, 'server', 'agent', 'intelligence', 'profile', 'profileMetrics.js');
const C79 = path.join(ROOT, 'server', 'scripts', 'test_c79_workspace_guard_gaps.js');

const { JsonStore, FILES, AUTO_ARCHIVE_LIMITS, BOUNDED_COLLECTIONS, UNBOUNDED_ACCEPTED, storageGovernanceGaps } = require(JSONSTORE);
const backup = require(BACKUP);
const evidence = require(EVIDENCE);

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

const tmpRoots = [ISO];
function mkTmp(tag) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'c115-' + tag + '-')); tmpRoots.push(d); return d; }

// 真实 data 目录条目快照（F 组用；只取顶层，避免递归大目录）
function realDataEntries() {
  try { return fs.readdirSync(REAL_DATA).sort().join(','); } catch (e) { return '(absent)'; }
}
const realBefore = realDataEntries();

(async () => {
  try {
    // ═══════════ A 组：D1 主集合损坏 → 侧车保全（修复前 A2/A3/A4 必红）═══════════
    {
      const dir = mkTmp('a');
      const st = new JsonStore(dir);
      st.write('aiTasks', [{ id: 't1', v: '重要数据1' }, { id: 't2', v: '重要数据2' }]);
      const f = path.join(dir, 'aiTasks.json');
      const CORRUPT = '[{"id":"t1"},{"id":"t2"';
      fs.writeFileSync(f, CORRUPT, 'utf8');

      const r = st.read('aiTasks', []);
      chk('A1 损坏仍返回 fallback（返回契约保持，与 test_c60 P3 同款）',
        Array.isArray(r) && r.length === 0, JSON.stringify(r));

      const sidecars = fs.readdirSync(dir).filter((n) => n.indexOf('aiTasks.json.corrupt-') === 0);
      chk('A2 损坏文件被侧车保全（修复前：无侧车 → 红）', sidecars.length === 1, 'sidecars=' + JSON.stringify(sidecars));
      chk('A3 侧车内容 = 损坏原文逐字（可人工取证/恢复）',
        sidecars.length === 1 && fs.readFileSync(path.join(dir, sidecars[0]), 'utf8') === CORRUPT, '');
      chk('A4 原位已清空（rename 而非 copy，避免下次重复解析失败）', !fs.existsSync(f), '');

      // RMW 全链路：这正是「修复前必然静默清空」的那条路径
      st.upsert('aiTasks', { id: 't3' });
      const now = st.read('aiTasks', []);
      chk('A5 RMW 后主文件仅含新记录（= 未修复时数据丢失的确定性表现）',
        now.length === 1 && now[0].id === 't3', JSON.stringify(now));
      chk('A6 但损坏前内容仍可从侧车取回（修复的真实价值）',
        sidecars.length === 1 && fs.readFileSync(path.join(dir, sidecars[0]), 'utf8').indexOf('t1') >= 0, '');

      const sc1 = fs.readdirSync(dir).filter((n) => n.indexOf('aiTasks.json.corrupt-') === 0).length;
      st.read('aiTasks', []);
      const sc2 = fs.readdirSync(dir).filter((n) => n.indexOf('aiTasks.json.corrupt-') === 0).length;
      chk('A7 二次读不重复产生侧车（文件已移走 → 走「不存在」干净路径）', sc2 === sc1, sc1 + '→' + sc2);
    }

    // A8 正常路径零行为变化：不产生任何侧车
    {
      const dir = mkTmp('a8');
      const st = new JsonStore(dir);
      st.insert('aiTasks', { id: 'x1' });
      st.upsert('aiTasks', { id: 'x1', v: 2 });
      st.read('aiTasks', []);
      st.remove('aiTasks', 'x1');
      st.appendEvent({ eventId: 'e1' });
      const sc = fs.readdirSync(dir).filter((n) => n.indexOf('.corrupt-') >= 0);
      chk('A8 正常读写不产生侧车（零行为变化）', sc.length === 0, JSON.stringify(sc));
    }

    // A9 同秒内二次损坏不覆盖既有侧车（追加序号）
    {
      const dir = mkTmp('a9');
      const st = new JsonStore(dir);
      const f = path.join(dir, 'aiSteps.json');
      fs.writeFileSync(f, 'bad-first', 'utf8');
      st.read('aiSteps', []);
      fs.writeFileSync(f, 'bad-second', 'utf8');
      st.read('aiSteps', []);
      const sc = fs.readdirSync(dir).filter((n) => n.indexOf('aiSteps.json.corrupt-') === 0);
      const bodies = sc.map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).sort().join('|');
      chk('A9 两次损坏各留一份侧车且互不覆盖（同秒追加序号）',
        sc.length === 2 && bodies === 'bad-first|bad-second', 'n=' + sc.length + ' bodies=' + bodies);
    }

    // A10 fallback 参数被尊重（自定义值）
    {
      const dir = mkTmp('a10');
      const st = new JsonStore(dir);
      fs.writeFileSync(path.join(dir, 'aiQueue.json'), '{broken', 'utf8');
      const r = st.read('aiQueue', ['sentinel']);
      chk('A10 损坏时返回调用方给定的 fallback（非强制空数组）',
        JSON.stringify(r) === JSON.stringify(['sentinel']), JSON.stringify(r));
    }

    // ═══════════ B 组：D2 水位补齐（修复前 B1/B1b 必红）═══════════
    {
      chk('B1 aiIntelligenceEvaluations 已登记水位',
        AUTO_ARCHIVE_LIMITS.aiIntelligenceEvaluations === 4000, String(AUTO_ARCHIVE_LIMITS.aiIntelligenceEvaluations));
      chk('B1b aiDispatchExecutions 已登记水位',
        AUTO_ARCHIVE_LIMITS.aiDispatchExecutions === 4000, String(AUTO_ARCHIVE_LIMITS.aiDispatchExecutions));

      const dir = mkTmp('b');
      const st = new JsonStore(dir);
      const L = AUTO_ARCHIVE_LIMITS.aiDispatchExecutions;
      const big = [];
      for (let i = 0; i < L + 5; i++) big.push({ id: 'd' + i });
      st.write('aiDispatchExecutions', big);
      const expect = Math.floor(L / 3);
      const main = st.read('aiDispatchExecutions', []);
      chk('B2 超水位自动归档最老 1/3、主文件截尾',
        main.length === L + 5 - expect && main[0].id === 'd' + expect,
        'len=' + main.length + ' first=' + (main[0] && main[0].id));

      const adir = path.join(dir, 'archive', 'aiDispatchExecutions');
      const afs = fs.existsSync(adir) ? fs.readdirSync(adir).filter((n) => n.endsWith('.json')) : [];
      const arch = afs.length === 1 ? JSON.parse(fs.readFileSync(path.join(adir, afs[0]), 'utf8')) : [];
      chk('B3 归档文件含最老记录（归档是「不丢数据」版本）',
        arch.length === expect && arch[0].id === 'd0' && arch[expect - 1].id === 'd' + (expect - 1),
        'n=' + arch.length);

      chk('B4 归档 + 主文件 = 原全量（逐条不丢）',
        arch.length + main.length === L + 5, arch.length + '+' + main.length);
    }

    // ═══════════ C 组：D5 治理断言 ═══════════
    {
      const names = Object.keys(FILES);
      const listed = []
        .concat(Object.keys(AUTO_ARCHIVE_LIMITS))
        .concat(Object.keys(BOUNDED_COLLECTIONS))
        .concat(Object.keys(UNBOUNDED_ACCEPTED));

      const gaps = storageGovernanceGaps();
      chk('C1 治理校验为空：每个 FILES 键都已分类', gaps.length === 0, JSON.stringify(gaps));

      chk('C2 三表无重复登记（一个集合只归一类）',
        new Set(listed).size === listed.length, listed.length + ' vs ' + new Set(listed).size);

      chk('C3 三表并集 == FILES 键集（无遗漏、无多余）',
        names.every((n) => listed.indexOf(n) >= 0) && listed.length === names.length,
        'files=' + names.length + ' listed=' + listed.length);

      chk('C4 没有任何登记的键是幽灵集合（反向一致性）',
        listed.every((n) => names.indexOf(n) >= 0),
        JSON.stringify(listed.filter((n) => names.indexOf(n) < 0)));

      // C5 机制有效性：断言 gaps() 真遍历 FILES 并逐个查三表 —— 防「恒返回 []」式假绿
      const jsrc = stripComments(fs.readFileSync(JSONSTORE, 'utf8'));
      const fnBody = (jsrc.match(/function storageGovernanceGaps\(\)[\s\S]{0,420}?\n\}/) || [''])[0];
      chk('C5 治理校验实现真遍历 FILES 且逐张表查询（非恒空实现）',
        /Object\.keys\(FILES\)/.test(fnBody) &&
        /AUTO_ARCHIVE_LIMITS\[name\]/.test(fnBody) &&
        /BOUNDED_COLLECTIONS\[name\]/.test(fnBody) &&
        /UNBOUNDED_ACCEPTED\[name\]/.test(fnBody) &&
        /gaps\.push\(name\)/.test(fnBody),
        fnBody ? 'fn found' : 'fn NOT found');
    }

    // ═══════════ D 组：D3 数据根跟随（修复前 D2/D3/D4/D5 必红）═══════════
    {
      const evCode = 'const e=require(' + JSON.stringify(EVIDENCE) + ');'
        + 'console.log("SNAP=" + e.SNAP_DIR);';

      // D1 非隔离模式：子进程**删除** FPB_DATA_DIR → 必须回落 <repo>/data（与修复前逐字一致）。
      // 本进程自身已被隔离，故此项必须用子进程验证，否则断言到的是隔离值（假绿/假红）。
      const envNoIso = Object.assign({}, process.env);
      delete envNoIso.FPB_DATA_DIR;
      const evNoIso = spawnSync(process.execPath, ['-e', evCode], { env: envNoIso, encoding: 'utf8', timeout: 60000 });
      const noIsoOut = norm(String(evNoIso.stdout || ''));
      chk('D1 非隔离模式 SNAP_DIR = <repo>/data/evidence/snapshots（行为零变化）',
        noIsoOut.indexOf(norm(path.join(ROOT, 'data', 'evidence', 'snapshots'))) >= 0,
        noIsoOut.trim().slice(0, 200));

      // D2 隔离模式：evidence 的模块级常量必须跟随 FPB_DATA_DIR（修复前恒为真实目录 → 红）
      const evRun = spawnSync(process.execPath, ['-e', evCode], {
        env: Object.assign({}, process.env, { FPB_DATA_DIR: ISO }), encoding: 'utf8', timeout: 60000,
      });
      const evOut = norm(String(evRun.stdout || '')); // 子进程输出是 Windows 反斜杠，必须归一后比较
      chk('D2 隔离模式：evidence.SNAP_DIR 跟随 FPB_DATA_DIR（修复前恒为真实目录）',
        evOut.indexOf(norm(ISO) + '/evidence/snapshots') >= 0,
        evOut.trim().slice(0, 200) + ' | stderr=' + String(evRun.stderr || '').slice(0, 120));

      // 子进程 2：profileMetrics.collectLive 必须读隔离目录的 profiles.json。
      // 探针 profile 只存在于隔离目录 → 若返回非 null 即证明未读真实目录（强证明）。
      const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c115-probe-'));
      tmpRoots.push(probeDir);
      fs.writeFileSync(path.join(probeDir, 'profiles.json'),
        JSON.stringify([{ id: 'c115-probe', name: 'probe', fingerprint: { language: 'en-US' } }]), 'utf8');
      const mCode = 'const m=require(' + JSON.stringify(METRICS) + ');'
        + 'm.collectLive("c115-probe").then(function(r){console.log("LIVE="+(r?"FOUND":"NULL"));})'
        + '.catch(function(e){console.log("LIVE=ERR:"+String(e&&e.message).slice(0,60));});';
      const mRun = spawnSync(process.execPath, ['-e', mCode], {
        env: Object.assign({}, process.env, { FPB_DATA_DIR: probeDir }), encoding: 'utf8', timeout: 90000,
      });
      const mOut = String(mRun.stdout || '');
      chk('D3 隔离模式：profileMetrics.collectLive 读隔离目录的 profiles.json',
        mOut.indexOf('LIVE=FOUND') >= 0,
        mOut.trim().slice(0, 160) + ' | stderr=' + String(mRun.stderr || '').slice(0, 120));

      // 静态锚：硬编码路径必须已清除（stripComments 后扫真代码）
      const evSrc = stripComments(fs.readFileSync(EVIDENCE, 'utf8'));
      const mSrc = stripComments(fs.readFileSync(METRICS, 'utf8'));
      chk('D4 evidence.js 已无硬编码数据根，改走 dataRoot()',
        !/path\.join\(__dirname,\s*'\.\.',\s*'\.\.',\s*'data'/.test(evSrc) &&
        /require\('\.\.\/dataRoot'\)/.test(evSrc) && /dataRoot\(\)/.test(evSrc),
        '');
      chk('D5 profileMetrics.js 已无硬编码数据根，改走 dataRoot()',
        !/'\.\.',\s*'\.\.',\s*'\.\.',\s*'\.\.',\s*'data'/.test(mSrc) &&
        /require\('\.\.\/\.\.\/\.\.\/dataRoot'\)/.test(mSrc) && /dataRoot\(\)/.test(mSrc),
        '');

      // 夹具跟随：test_c79 的快照根必须由隔离 dataDir 推导（防回退到真实目录）
      const c79Src = stripComments(fs.readFileSync(C79, 'utf8'));
      chk('D6 test_c79 快照根随隔离 dataDir 推导（夹具跟随实现，非放宽断言）',
        /SNAP_DIR = path\.join\(dataDir, 'evidence', 'snapshots'\)/.test(c79Src) &&
        !/const SNAP_DIR = path\.join\(ROOT, 'data', 'evidence', 'snapshots'\)/.test(c79Src),
        '');

      chk('D7 SNAP_DIR 结构 = <root>/evidence/snapshots（dataRoot 驱动，随进程数据根变化）',
        /\/evidence\/snapshots$/.test(norm(evidence.SNAP_DIR)), norm(evidence.SNAP_DIR));
    }

    // ═══════════ E 组：D4 备份恢复原子写（修复前 E1/E2 必红）═══════════
    {
      const bsrc = stripComments(fs.readFileSync(BACKUP, 'utf8'));
      chk('E1 backup 恢复写回使用共享原子写原语',
        /atomicWriteFileSync\(target/.test(bsrc) && /require\('\.\/fsSafe'\)/.test(bsrc), '');
      chk('E2 backup 不再用裸 fs.writeFileSync 写回主数据（修复前必红）',
        !/fs\.writeFileSync\(target/.test(bsrc), '');

      const dir = mkTmp('e');
      const savedIso = process.env.FPB_DATA_DIR;
      process.env.FPB_DATA_DIR = dir;
      let restoredOk = false, tmpLeft = 0, contentOk = false;
      try {
        const snap = {
          format: 'identra-backup', version: 1, createdAt: Date.now(),
          files: { 'aiTasks.json': [{ id: 'r1' }, { id: 'r2' }] },
        };
        const res = backup.restoreSnapshot(snap);
        restoredOk = Array.isArray(res.restored) && res.restored.indexOf('aiTasks.json') >= 0;
        tmpLeft = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length;
        const back = JSON.parse(fs.readFileSync(path.join(dir, 'aiTasks.json'), 'utf8'));
        contentOk = Array.isArray(back) && back.length === 2 && back[0].id === 'r1';
      } finally { process.env.FPB_DATA_DIR = savedIso; }

      chk('E3 真实恢复调用成功（模块行为，非仅静态）', restoredOk, '');
      chk('E4 恢复落盘内容正确且无 .tmp 残留（原子写卫生）', contentOk && tmpLeft === 0,
        'contentOk=' + contentOk + ' tmpLeft=' + tmpLeft);
    }

    // ═══════════ F 组：T24 隔离零污染 ═══════════
    {
      chk('F1 本测试进程的数据根被隔离到 tmp（未指向真实 data）',
        norm(process.env.FPB_DATA_DIR).indexOf(norm(os.tmpdir())) === 0, norm(process.env.FPB_DATA_DIR));
      chk('F2 真实 data 目录顶层条目零变化（隔离零污染）',
        realDataEntries() === realBefore, 'before=' + realBefore.slice(0, 120) + ' after=' + realDataEntries().slice(0, 120));
    }
  } catch (e) {
    fail++;
    failures.push('FATAL ' + (e && e.stack ? e.stack : String(e)));
    console.log('FATAL ' + (e && e.stack ? e.stack : String(e)));
  } finally {
    for (const d of tmpRoots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* tmp 清理尽力而为 */ } }
  }

  console.log('\n===== C115 RESULT: ' + pass + ' passed, ' + fail + ' failed =====');
  if (fail > 0) { failures.forEach((f) => console.log('  FAILED: ' + f)); process.exit(1); }
})();
