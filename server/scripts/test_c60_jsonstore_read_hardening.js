'use strict';
// C60 守护测试 —— jsonStore.js 读路径硬化 + 归档写完整性（tmp 隔离、零浏览器、零网络、纯模块）。
// 缺陷背景（老模块 jsonStore.js 首轮深扫——此前仅浅扫，两个数据完整性缺陷）：
//   D1 (A类/数据丢失) read() 把瞬时文件锁（EPERM/EBUSY/EACCES——正是 Phase 5.8 写路径
//      已重试加固的同一故障面：杀毒/索引器短暂锁文件）与「文件损坏」混为一谈：
//      readFileSync 抛错 → 静默返回 fallback []，而 insert/upsert/update/remove/
//      appendEvent 全是 read-modify-write → 一次瞬时锁后下一次写把整集合覆写成
//      fallback（老记录全部静默蒸发，仅剩新写的一条）。
//   D2 (B类/证据丢失) 归档文件裸 writeFileSync 直写（违背模块头「同步原子写」自述，
//      中断可留半截归档 JSON），且归档 JSON 损坏时 prev=[] 静默丢弃历史归档后覆写
//      ——归档是 evidence-first「不丢数据」承诺，损坏应侧车保全而非静默清空。
// 修复：
//   F1 readFileSyncRetry：瞬时锁 5 次退避重试；耗尽后抛出（fail-loud，绝不吞成 fallback）。
//      真正的 JSON 解析失败仍走 fallback（既有契约保持）。
//   F2 atomicWriteFileSync 抽取共用（主集合 + 归档统一原子写）；_archiveAppend 抽取
//      （auto-archive 与 archiveOldest 两份同构代码合一）；损坏归档 rename 侧车
//      .corrupt-<时间戳> 保全后再续写。
// 覆盖：
//   P0 基线回归：insert/upsert/find/update/remove/appendEvent/EVENT_MAX/clear 全语义
//   P1 D1 最强实证：读时瞬时 EBUSY（前 2 次抛错后放行）→ upsert 不清空老记录
//   P2 D1 fail-loud：持续 EBUSY → read() 抛出且 upsert 传播抛出、主文件原样未覆写
//   P3 契约保持：真损坏 JSON（非法内容）→ read 返回 fallback（不变）
//   P4 D2 损坏归档侧车保全：corrupt 归档 → .corrupt-<ts> 侧车存在 + 新归档含迁移记录
//   P5 auto-archive 回归：超水位 → 归档 1/3、主文件截尾（水位语义不变）
//   P6 archiveOldest 回归：archived/remaining/archiveFile 契约不变
//   P7 原子写卫生：正常操作后无 .tmp 残留

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

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

(async () => {
  const { JsonStore, FILES, EVENT_MAX, AUTO_ARCHIVE_LIMITS, archiveDateString } = require(path.join(ROOT, 'server', 'agent', 'storage', 'jsonStore.js'));
  const tmpRoots = [];
  const mkTmp = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'c60-' + tag + '-')); tmpRoots.push(d); return d; };
  const realReadFileSync = fs.readFileSync;

  try {
    // ---------- P0 基线回归 ----------
    {
      const dir = mkTmp('p0');
      const st = new JsonStore(dir);
      chk('P0.read-missing-fallback', JSON.stringify(st.read('aiTasks', [])) === '[]', 'missing file should return fallback');
      chk('P0.unknown-collection-rejects', (() => { try { st.read('nope'); return false; } catch (e) { return /未知 AI 集合/.test(e.message); } })(), 'unknown name must reject');
      st.insert('aiTasks', { id: 't1', v: 1 });
      st.insert('aiTasks', { id: 't2', v: 2 });
      chk('P0.insert', st.find('aiTasks', 't1') && st.find('aiTasks', 't1').v === 1, 'insert+find');
      st.upsert('aiTasks', { id: 't1', v: 11 });
      chk('P0.upsert', st.find('aiTasks', 't1').v === 11 && st.find('aiTasks', 't2').v === 2, 'upsert updates in place');
      st.update('aiTasks', 't2', { v: 22, extra: 'x' });
      const t2 = st.find('aiTasks', 't2');
      chk('P0.update-patch', t2.v === 22 && t2.extra === 'x' && t2.id === 't2', 'update merges patch');
      chk('P0.update-missing-null', st.update('aiTasks', 'nope', { v: 0 }) === null, 'update missing id returns null');
      st.remove('aiTasks', 't1');
      chk('P0.remove', st.find('aiTasks', 't1') === null && st.find('aiTasks', 't2') !== null, 'remove deletes only target');
      for (let i = 0; i < EVENT_MAX + 20; i++) st.appendEvent({ eventId: 'e' + i });
      const evs = st.read('aiEvents', []);
      chk('P0.event-max', evs.length === EVENT_MAX && evs[0].eventId === 'e20' && evs[EVENT_MAX - 1].eventId === 'e' + (EVENT_MAX + 19), 'EVENT_MAX trim keeps newest');
      chk('P0.deep-clone', (() => { const a = st.read('aiTasks'); a[0].v = 999; return st.find('aiTasks', 't2').v === 22; })(), 'read returns deep clone');
      st.clear('aiTasks');
      chk('P0.clear-single', st.read('aiTasks', []).length === 0, 'clear single collection');
      st.insert('aiTasks', { id: 'z', v: 1 });
      st.clear();
      chk('P0.clear-all', FILES && Object.keys(FILES).every((n) => Array.isArray(st.read(n, [])) && st.read(n, []).length === 0), 'clear all collections');
    }

    // ---------- P1 D1 最强实证：瞬时读锁 → 不清空 ----------
    {
      const dir = mkTmp('p1');
      const st = new JsonStore(dir);
      st.insert('aiAttempts', { id: 'a1', note: 'old-1' });
      st.insert('aiAttempts', { id: 'a2', note: 'old-2' });
      let calls = 0;
      fs.readFileSync = function (p, ...rest) {
        if (String(p).endsWith('aiAttempts.json') && calls < 2) { calls++; const e = new Error('EBUSY: resource busy'); e.code = 'EBUSY'; throw e; }
        return realReadFileSync.call(fs, p, ...rest);
      };
      try {
        st.upsert('aiAttempts', { id: 'a3', note: 'new-3' }); // 修复后：重试两次后成功
        const after = st.read('aiAttempts', []);
        const ids = after.map((x) => x.id).sort();
        chk('P1.transient-lock-no-wipe', JSON.stringify(ids) === JSON.stringify(['a1', 'a2', 'a3']), 'transient lock must NOT wipe collection (got: ' + JSON.stringify(ids) + ')');
        chk('P1.retried', calls === 2, 'should retry exactly 2 transient failures');
      } finally { fs.readFileSync = realReadFileSync; }
    }

    // ---------- P2 D1 fail-loud：持续读锁 → 抛出且不覆写 ----------
    {
      const dir = mkTmp('p2');
      const st = new JsonStore(dir);
      st.insert('aiSteps', { id: 's1', note: 'old' });
      const mainFile = path.join(dir, 'aiSteps.json');
      fs.readFileSync = function (p, ...rest) {
        if (String(p).endsWith('aiSteps.json')) { const e = new Error('EBUSY: resource busy'); e.code = 'EBUSY'; throw e; }
        return realReadFileSync.call(fs, p, ...rest);
      };
      try {
        let threw = null;
        try { st.upsert('aiSteps', { id: 's2', note: 'new' }); } catch (e) { threw = e; }
        chk('P2.read-throws', threw && threw.code === 'EBUSY', 'persistent lock must throw (fail-loud), not return fallback');
      } finally { fs.readFileSync = realReadFileSync; }
      const onDisk = readJson(mainFile);
      chk('P2.disk-untouched', onDisk.length === 1 && onDisk[0].id === 's1', 'failed upsert must NOT overwrite collection with fallback');
      chk('P2.data-recoverable', st.find('aiSteps', 's1') && st.find('aiSteps', 's1').note === 'old', 'after unlock, old data intact');
    }

    // ---------- P3 契约保持：真损坏 JSON → fallback ----------
    {
      const dir = mkTmp('p3');
      const st = new JsonStore(dir);
      fs.writeFileSync(path.join(dir, 'aiQueue.json'), '{corrupt!!', 'utf8');
      const r = st.read('aiQueue', ['sentinel']);
      chk('P3.corrupt-json-fallback', JSON.stringify(r) === JSON.stringify(['sentinel']), 'real corruption still returns fallback');
      // readFileSyncRetry 不吞非瞬时 fs 错误（如 ENOENT 之外的权限错误也 throw——这里验证 ENOENT 场景不在此路径：文件存在才读）
      fs.writeFileSync(path.join(dir, 'aiQueue.json'), '[{"id":"q1"}]', 'utf8');
      chk('P3.recover-after-corrupt', st.read('aiQueue', [])[0].id === 'q1', 'recovers once file is valid');
    }

    // ---------- P4 D2 损坏归档侧车保全 ----------
    {
      const dir = mkTmp('p4');
      const st = new JsonStore(dir);
      st.insert('aiAttempts', { id: 'm1' });
      st.insert('aiAttempts', { id: 'm2' });
      const adir = path.join(dir, 'archive', 'aiAttempts');
      // 同秒内计算时间戳并落 corrupt 归档（越秒重试，概率极低）
      let ok = false;
      for (let attempt = 0; attempt < 5 && !ok; attempt++) {
        const ds = archiveDateString();
        const af = path.join(adir, ds + '.json');
        fs.mkdirSync(adir, { recursive: true });
        fs.writeFileSync(af, '{{{corrupt-archive', 'utf8');
        const res = st.archiveOldest('aiAttempts', 1);
        if (res.archiveFile === af) {
          ok = true;
          const sidecars = fs.readdirSync(adir).filter((n) => n.startsWith(ds + '.json.corrupt-'));
          chk('P4.corrupt-sidecar-preserved', sidecars.length === 1 && fs.readFileSync(path.join(adir, sidecars[0]), 'utf8') === '{{{corrupt-archive', 'corrupt archive must be sidecar-preserved, not silently discarded');
          const newArchive = readJson(af);
          chk('P4.archive-rebuilt', Array.isArray(newArchive) && newArchive.length === 1 && newArchive[0].id === 'm1', 'archive append continues after sidecar');
        } else {
          // 越秒：清理重试
          fs.rmSync(adir, { recursive: true, force: true });
        }
      }
      chk('P4.timestamp-match', ok, 'archive path matched within retries');
    }

    // ---------- P5 auto-archive 水位回归 ----------
    {
      const dir = mkTmp('p5');
      const st = new JsonStore(dir);
      const limit = AUTO_ARCHIVE_LIMITS.aiRepairAttempts; // 4000
      const big = [];
      for (let i = 0; i < limit + 10; i++) big.push({ id: 'r' + i });
      st.write('aiRepairAttempts', big);
      const expectArchive = Math.floor(limit / 3);
      const main = st.read('aiRepairAttempts', []);
      chk('P5.main-trimmed', main.length === limit + 10 - expectArchive && main[0].id === 'r' + expectArchive, 'main file trimmed by 1/3 limit, oldest moved out');
      const adir = path.join(dir, 'archive', 'aiRepairAttempts');
      const files = fs.readdirSync(adir).filter((n) => n.endsWith('.json'));
      chk('P5.archive-file-created', files.length === 1, 'one archive file created');
      const archived = readJson(path.join(adir, files[0]));
      chk('P5.archive-count', archived.length === expectArchive && archived[0].id === 'r0' && archived[expectArchive - 1].id === 'r' + (expectArchive - 1), 'archive holds oldest 1/3 in order');
    }

    // ---------- P6 archiveOldest 契约回归 ----------
    {
      const dir = mkTmp('p6');
      const st = new JsonStore(dir);
      for (let i = 0; i < 10; i++) st.insert('aiWorkers', { id: 'w' + i });
      const res = st.archiveOldest('aiWorkers', 4);
      chk('P6.archived-count', res.archived === 4, 'archived returns count');
      chk('P6.remaining', res.remaining.length === 6 && res.remaining[0].id === 'w4', 'remaining drops oldest');
      const archived = readJson(res.archiveFile);
      chk('P6.archive-content', archived.length === 4 && archived[0].id === 'w0' && archived[3].id === 'w3', 'archive file holds moved records');
      chk('P6.main-persisted', st.read('aiWorkers', []).length === 6, 'main collection persisted');
      const res2 = st.archiveOldest('aiWorkers', 100);
      chk('P6.over-count-safe', res2.archived === 0 && res2.remaining.length === 6, 'count >= length archives nothing');
    }

    // ---------- P7 原子写卫生：无 .tmp 残留 ----------
    {
      const dir = mkTmp('p7');
      const st = new JsonStore(dir);
      st.insert('aiTasks', { id: 'x1' });
      st.upsert('aiTasks', { id: 'x1', v: 2 });
      st.write('aiRepairAttempts', new Array(AUTO_ARCHIVE_LIMITS.aiRepairAttempts + 5).fill(0).map((_, i) => ({ id: 'z' + i })));
      st.archiveOldest('aiTasks', 0);
      const leftovers = [];
      const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); const s = fs.statSync(p); if (s.isDirectory()) walk(p); else if (n.endsWith('.tmp')) leftovers.push(p); } };
      walk(dir);
      chk('P7.no-tmp-leftover', leftovers.length === 0, 'no .tmp residue after normal ops (got: ' + leftovers.join(',') + ')');
    }
  } finally {
    fs.readFileSync = realReadFileSync;
    for (const d of tmpRoots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* tmp 清理尽力而为 */ } }
  }

  console.log('\n===== C60 RESULT: ' + pass + ' passed, ' + fail + ' failed =====');
  if (fail > 0) { failures.forEach((f) => console.log('  FAILED: ' + f)); process.exit(1); }
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
