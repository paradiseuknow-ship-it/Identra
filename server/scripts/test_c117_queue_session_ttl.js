'use strict';
// C117 守护测试 —— 无界集合治理：queue 终态 TTL + session TTL（tmp 隔离、零浏览器、零 LLM、零网络）。
//
// 缺陷背景（C 类边界兑现，出自 C115 的 UNBOUNDED_ACCEPTED 登记）：
//   D1 (A/无界增长) aiQueue：markDone 只改 status、终态记录永久残留 → 随任务量无界
//      （每次写全量 read+write，与 aiAttempts 42MB 事故同源）。
//   D2 (A/无界增长) aiSessions：每次 createSession insert 一条、无 TTL → 随对话量无界。
//   D3 (B/治理缺原语) 两项长期无法治理不是「忘了配水位」，而是**既有归档原语不适用**：
//      archiveOldest 按「数组头部 + count」切分（data.slice(0, count)），对「主文件即工作集」
//      的集合会把仍在 PENDING 的任务移出主文件，而 dequeue() 只读主文件 ⇒ 任务静默不执行
//      ——比无界增长更糟。故正解 = 补一个**按谓词切分**的原语 archiveWhere。
//   D4 (B/归档不得改变可访问性) 会话是用户可回访的对象：归档若使 getSession 返回 null，
//      index.js:511 会**静默新建会话**（用户点开旧对话看到空白、无任何报错）。
//      ⇒ 会话必须「归档 + 访问时原位恢复」，否则治理本身变成行为破坏。
//
// 覆盖：
//   A 组 存储原语语义（8）：分拣/守恒/归档内容/无命中零写/谓词抛异常零变化/取回/损坏跳过/落盘一致
//   B 组 queue 只动终态（6）：PENDING·RUNNING 在任何 now 下永不归档 + 归档后 dequeue 不受影响
//   C 组 时间+数量双条件（6）：未超龄未超顶不裁 / 仅超顶裁最老 / 保留最新 N / 并集去重 / 缺时点不动
//   D 组 归档不丢数据（5）：合法 JSON、内容逐字、路径正确、追加式新建、总数守恒
//   E 组 故障注入（4）：prune 抛异常不阻断 enqueue + loud（非静默）
//   F 组 dequeue/enqueue 语义零破坏（6）：幂等入队、终态重入队回 PENDING、优先级、只取 PENDING
//   G 组 静态锚（7）：PENDING 过滤不可移除、终态白名单、写入前分拣、恢复兜底、接口默认、防真空
//   H 组 治理登记已迁移（6）：gaps 空、两项在 BOUNDED、不在 UNBOUNDED、并集==FILES、无重复、表保留
//   I 组 隔离零污染（3）：数据根在 tmp、真实 data 零变化、归档落在 tmp
// 纪律：断言「真正执行的那份东西」（真实 JsonStore/queue/sessionManager 行为 + stripComments
// 后的源码锚）；require 业务模块之前先隔离 FPB_DATA_DIR；收尾核验真实数据目录零污染。

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const REAL_DATA = path.join(ROOT, 'data');

// ── 隔离必须在 require 业务模块之前（C113 教训）──
const ISO = fs.mkdtempSync(path.join(os.tmpdir(), 'c117-'));
process.env.FPB_DATA_DIR = ISO;
process.env.FPB_VAULT_FILE = path.join(ISO, 'vault.json');
process.env.FPB_SETTINGS_FILE = path.join(ISO, 'runtime_settings.json');

const JSONSTORE = path.join(ROOT, 'server', 'agent', 'storage', 'jsonStore.js');
const IFACE = path.join(ROOT, 'server', 'agent', 'storage', 'store.interface.js');
const QUEUE_SRC = path.join(ROOT, 'server', 'agent', 'queue.js');
const SESSION_SRC = path.join(ROOT, 'server', 'agent', 'sessionManager.js');

const {
  JsonStore, FILES, AUTO_ARCHIVE_LIMITS, BOUNDED_COLLECTIONS, UNBOUNDED_ACCEPTED, storageGovernanceGaps,
} = require(JSONSTORE);
const { StoreInterface } = require(IFACE);
const { SqliteStore } = require(path.join(ROOT, 'server', 'agent', 'storage', 'sqliteStore.js'));
const store = require(path.join(ROOT, 'server', 'agent', 'store.js'));
const queue = require(QUEUE_SRC);
const sessions = require(SESSION_SRC);

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
function mkTmp(tag) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'c117-' + tag + '-')); tmpRoots.push(d); return d; }

// 组间复位：清空队列/会话主集合 + 移除归档目录（各自组从确定初态出发）
function resetCollection(name) {
  store.write(name, []);
  try { fs.rmSync(path.join(ISO, 'archive', name), { recursive: true, force: true }); } catch (e) { /* 归档可能不存在 */ }
}
function archiveFiles(name) {
  const d = path.join(ISO, 'archive', name);
  try { return fs.readdirSync(d).filter((n) => n.slice(-5) === '.json').sort(); }
  catch (e) { return []; }
}
// 读回归档目录里所有记录（跨文件拼接）——用于「总数守恒」这类不丢数据断言
function readAllArchived(name) {
  let out = [];
  for (const f of archiveFiles(name)) {
    const arr = JSON.parse(fs.readFileSync(path.join(ISO, 'archive', name, f), 'utf8'));
    if (Array.isArray(arr)) out = out.concat(arr);
  }
  return out;
}
const DAY = 24 * 60 * 60 * 1000;

// 真实 data 目录条目快照（I 组用；只取顶层，避免递归大目录）
function realDataEntries() {
  try { return fs.readdirSync(REAL_DATA).sort().join(','); } catch (e) { return '(absent)'; }
}
const realBefore = realDataEntries();

const QUEUE_STRIPPED = stripComments(fs.readFileSync(QUEUE_SRC, 'utf8'));
const JSONSTORE_STRIPPED = stripComments(fs.readFileSync(JSONSTORE, 'utf8'));
const SESSION_STRIPPED = stripComments(fs.readFileSync(SESSION_SRC, 'utf8'));
const QUEUE_RAW = fs.readFileSync(QUEUE_SRC, 'utf8');

(async () => {
  try {
    // ═══════════ A 组：存储原语语义（archiveWhere / findInArchive）═══════════
    {
      const dir = mkTmp('a');
      const st = new JsonStore(dir);
      const seed = [
        { id: 'a1', status: 'PENDING', v: '留' },
        { id: 'a2', status: 'DONE', v: '走' },
        { id: 'a3', status: 'PENDING', v: '留' },
        { id: 'a4', status: 'FAILED', v: '走' },
      ];
      st.write('aiQueue', seed);
      const r = st.archiveWhere('aiQueue', (x) => x.status !== 'PENDING');

      chk('A1 分拣正确：谓词命中进归档、未命中留主文件',
        r.archived === 2 && r.remaining.length === 2
        && r.remaining.every((x) => x.status === 'PENDING'), JSON.stringify(r.remaining.map((x) => x.id)));
      chk('A2 守恒：archived + remaining.length === 原长度（无记录被吞）',
        r.archived + r.remaining.length === seed.length,
        r.archived + '+' + r.remaining.length + ' vs ' + seed.length);

      const af = path.join(dir, 'archive', 'aiQueue');
      const files = fs.readdirSync(af).filter((n) => n.slice(-5) === '.json');
      const moved = JSON.parse(fs.readFileSync(path.join(af, files[0]), 'utf8'));
      chk('A3 归档内容 = 被归档记录（合法 JSON 数组、逐字可读）',
        files.length === 1 && Array.isArray(moved) && moved.length === 2
        && moved.map((x) => x.id).join(',') === 'a2,a4'
        && moved[0].v === '走', JSON.stringify(moved));
      chk('A8 返回的 remaining 已落盘（read 回读一致）',
        st.read('aiQueue', []).map((x) => x.id).join(',') === r.remaining.map((x) => x.id).join(','),
        JSON.stringify(st.read('aiQueue', []).map((x) => x.id)));

      // A4 无命中 ⇒ 零写入（连归档目录都不该被创建）
      const dir4 = mkTmp('a4');
      const st4 = new JsonStore(dir4);
      st4.write('aiQueue', [{ id: 'p1', status: 'PENDING' }]);
      const r4 = st4.archiveWhere('aiQueue', (x) => x.status !== 'PENDING');
      chk('A4 谓词无命中 ⇒ archived=0 且不创建归档目录（零写路径）',
        r4.archived === 0 && !fs.existsSync(path.join(dir4, 'archive', 'aiQueue')),
        'archived=' + r4.archived + ' exists=' + fs.existsSync(path.join(dir4, 'archive', 'aiQueue')));

      // A5 谓词抛异常 ⇒ 主文件与归档都零变化（分拣在写入之前）
      const dir5 = mkTmp('a5');
      const st5 = new JsonStore(dir5);
      st5.write('aiQueue', [{ id: 'x1', status: 'DONE' }, { id: 'x2', status: 'PENDING' }]);
      const before5 = fs.readFileSync(path.join(dir5, 'aiQueue.json'), 'utf8');
      let threw = false;
      try { st5.archiveWhere('aiQueue', () => { throw new Error('pred boom'); }); }
      catch (e) { threw = true; }
      chk('A5 谓词抛异常 ⇒ 异常上抛且主文件/归档零变化（fail-safe，不留半截状态）',
        threw === true
        && fs.readFileSync(path.join(dir5, 'aiQueue.json'), 'utf8') === before5
        && !fs.existsSync(path.join(dir5, 'archive', 'aiQueue'))
        && st5.read('aiQueue', []).length === 2, 'threw=' + threw);

      // A6/A7 归档取回
      const dir6 = mkTmp('a6');
      const st6 = new JsonStore(dir6);
      st6.write('aiQueue', [{ id: 'k1', status: 'DONE' }, { id: 'k2', status: 'PENDING' }]);
      st6.archiveWhere('aiQueue', (x) => x.status !== 'PENDING');
      chk('A6 findInArchive 命中已归档记录、未归档返回 null',
        (st6.findInArchive('aiQueue', 'k1') || {}).id === 'k1'
        && st6.findInArchive('aiQueue', 'k2') === null
        && st6.findInArchive('aiQueue', 'nope') === null, '');
      // 损坏一个归档文件 + 另一个完好 ⇒ 仍能取到完好文件里的记录（单文件坏不中止）。
      // 文件名取 9999... 使其字典序排在真实文件**之后**，逆序扫描时先命中它 ⇒ 真正走到
      // 「解析失败 → continue」分支（放 1999... 会被排在最后，扫描永远先命中好文件 = 假绿）。
      const af6 = path.join(dir6, 'archive', 'aiQueue');
      const corruptF = path.join(af6, '99990101-000000.json');
      fs.writeFileSync(corruptF, '{corrupt!!', 'utf8');
      chk('A7 findInArchive 跳过损坏归档文件、仍能取到其他文件里的记录',
        (st6.findInArchive('aiQueue', 'k1') || {}).id === 'k1', '');
      chk('A7b 取回过程只读：损坏归档文件仍原样在位（history 是证据，不得被清理或改名）',
        fs.existsSync(corruptF) && fs.readFileSync(corruptF, 'utf8') === '{corrupt!!', '');

      // A7c 归档全坏 ⇒ 返回 null 而非抛出（garbage in ≠ crash）
      const dir7 = mkTmp('a7');
      const st7 = new JsonStore(dir7);
      fs.mkdirSync(path.join(dir7, 'archive', 'aiQueue'), { recursive: true });
      fs.writeFileSync(path.join(dir7, 'archive', 'aiQueue', '20260101-000000.json'), '{broken', 'utf8');
      let threw7 = null, res7 = 'unset';
      try { res7 = st7.findInArchive('aiQueue', 'anything'); } catch (e) { threw7 = e; }
      chk('A7c 归档文件全部损坏时 findInArchive 返回 null 且不抛（garbage in ≠ crash）',
        threw7 === null && res7 === null, threw7 ? String(threw7.message) : String(res7));
    }

    // ═══════════ B 组：queue 只动终态（PENDING·RUNNING 永不归档）═══════════
    {
      resetCollection('aiQueue');
      const LONG_LONG_AGO = Date.now() - 999 * DAY; // 远超任何保留窗口
      store.write('aiQueue', [
        { id: 'q_pending', taskId: 'q_pending', status: 'PENDING', createdAt: LONG_LONG_AGO, priority: 50 },
        { id: 'q_running', taskId: 'q_running', status: 'RUNNING', createdAt: LONG_LONG_AGO, priority: 50 },
        { id: 'q_done', taskId: 'q_done', status: 'DONE', createdAt: LONG_LONG_AGO, priority: 50 },
        { id: 'q_failed', taskId: 'q_failed', status: 'FAILED', createdAt: LONG_LONG_AGO, priority: 50 },
        { id: 'q_cancelled', taskId: 'q_cancelled', status: 'CANCELLED', createdAt: LONG_LONG_AGO, priority: 50 },
      ]);
      const pr = queue.pruneTerminal();
      const ids = queue.list().map((x) => x.id).sort().join(',');

      chk('B1+B2 PENDING 与 RUNNING 即使「999 天前」也永不归档',
        ids === 'q_pending,q_running', ids);
      chk('B3 DONE 超龄被归档', pr.archived >= 1 && ids.indexOf('q_done') < 0, ids);
      chk('B4 FAILED / CANCELLED 同样按终态处理',
        ids.indexOf('q_failed') < 0 && ids.indexOf('q_cancelled') < 0, ids);
      chk('B5 归档条数 = 3 个终态项（不多不少）', pr.archived === 3, 'archived=' + pr.archived);
      chk('B6 归档后 dequeue 仍能取到 PENDING（控制路径零影响）',
        (queue.dequeue() || {}).id === 'q_pending', JSON.stringify(queue.list().map((x) => x.id + ':' + x.status)));
    }

    // ═══════════ C 组：时间 + 数量双条件 ═══════════
    {
      resetCollection('aiQueue');
      const T = 1_700_000_000_000;

      // C1 未超龄 且 未超封顶 ⇒ 一条都不裁
      store.write('aiQueue', [
        { id: 'n1', status: 'DONE', createdAt: T },
        { id: 'n2', status: 'DONE', createdAt: T - 1000 },
      ]);
      const c1 = queue.pruneTerminal({ now: T, retentionMs: 7 * DAY, maxTerminal: 500 });
      chk('C1 未超龄且未超封顶 ⇒ archived=0（不动）',
        c1.archived === 0 && queue.list().length === 2, JSON.stringify(c1.archived));

      // C2/C3 仅超封顶（年龄全新）⇒ 归档最老的那些，保留最新 N 条
      resetCollection('aiQueue');
      const rows = [];
      for (let i = 0; i < 5; i++) rows.push({ id: 'c' + i, status: 'DONE', createdAt: T + i * 1000 });
      store.write('aiQueue', rows);
      const c2 = queue.pruneTerminal({ now: T, retentionMs: 7 * DAY, maxTerminal: 2 });
      chk('C2 仅超封顶（年龄全新）⇒ 按封顶归档最老的',
        c2.archived === 3, 'archived=' + c2.archived);
      chk('C3 封顶保留的是最新的 maxTerminal 条（按 createdAt 降序）',
        queue.list().map((x) => x.id).join(',') === 'c3,c4', queue.list().map((x) => x.id).join(','));
      chk('C3b 被归档的恰是最老的 3 条', readAllArchived('aiQueue').map((x) => x.id).join(',') === 'c0,c1,c2',
        readAllArchived('aiQueue').map((x) => x.id).join(','));

      // C4 双条件同时命中 ⇒ 取并集且不重复归档。
      // 构造要让两个集合**真重叠**，否则「去重」是没被验证的：|expired|=3、|overflow|=4，
      // 其中 3 条同时在两边 ⇒ 朴素相加会得 7，正确答案是并集 4。若实现忘了 Set 去重
      // （或按两次 slice 各归档一次），archived/归档条数就不再是 4。
      resetCollection('aiQueue');
      store.write('aiQueue', [
        { id: 'u_old1', status: 'DONE', createdAt: T - 30 * DAY },  // expired ∧ overflow
        { id: 'u_old2', status: 'DONE', createdAt: T - 30 * DAY },  // expired ∧ overflow
        { id: 'u_old3', status: 'DONE', createdAt: T - 30 * DAY },  // expired ∧ overflow
        { id: 'u_new1', status: 'DONE', createdAt: T },             // 仅 overflow
        { id: 'u_new2', status: 'DONE', createdAt: T + 1 },
        { id: 'u_new3', status: 'DONE', createdAt: T + 2 },
      ]);
      const c4 = queue.pruneTerminal({ now: T, retentionMs: 7 * DAY, maxTerminal: 2 });
      const arch4 = readAllArchived('aiQueue').map((x) => x.id);
      chk('C4 双条件取并集且无重复归档（|expired|=3 ∪ |overflow|=4 ⇒ 4，而非 7）',
        c4.archived === 4 && arch4.length === 4 && new Set(arch4).size === 4,
        'archived=' + c4.archived + ' archLen=' + arch4.length + ' arch=' + JSON.stringify(arch4));
      chk('C4b 归档集合 = expired ∪ overflow，主文件 = 补集（无交集、无遗漏）',
        arch4.slice().sort().join(',') === 'u_new1,u_old1,u_old2,u_old3'
        && queue.list().map((x) => x.id).join(',') === 'u_new2,u_new3',
        'arch=' + JSON.stringify(arch4.slice().sort()) + ' main=' + JSON.stringify(queue.list().map((x) => x.id)));

      // C5 活跃时点缺失的终态记录 ⇒ 不动（判断不了的不该被静默扫走）
      resetCollection('aiQueue');
      store.write('aiQueue', [
        { id: 'no_ts', status: 'DONE' },
        { id: 'bad_ts', status: 'DONE', createdAt: 'not-a-number' },
      ]);
      const c5 = queue.pruneTerminal({ now: T, retentionMs: 7 * DAY, maxTerminal: 500 });
      chk('C5 createdAt 缺失/非法的终态记录不被超龄规则扫走（判断不了的不动）',
        c5.archived === 0 && queue.list().length === 2, 'archived=' + c5.archived);
    }

    // ═══════════ D 组：归档不丢数据 ═══════════
    {
      resetCollection('aiQueue');
      const T = 1_700_000_000_000;
      const rows = [];
      for (let i = 0; i < 6; i++) {
        rows.push({
          id: 'd' + i, taskId: 'd' + i, priority: 10 + i,
          createdAt: T - (10 + i) * DAY, deadline: null, profileId: 'p' + i, status: 'DONE',
        });
      }
      store.write('aiQueue', rows);
      const d = queue.pruneTerminal({ now: T, retentionMs: 7 * DAY, maxTerminal: 500 });
      chk('D1 归档条数 = 归档文件内记录数（合法 JSON 数组）',
        d.archived === 6 && readAllArchived('aiQueue').length === 6, 'archived=' + d.archived);
      const arch = readAllArchived('aiQueue');
      const src = rows.find((x) => x.id === 'd3');
      const got = arch.find((x) => x.id === 'd3');
      chk('D2 归档记录内容逐字保持（字段零丢失/零变形）',
        !!got && JSON.stringify(got) === JSON.stringify(src), JSON.stringify(got));
      chk('D3 归档落在 data/archive/aiQueue/<时间戳>.json（唯一历史追溯入口）',
        archiveFiles('aiQueue').length === 1
        && /^\d{8}-\d{6}\.json$/.test(archiveFiles('aiQueue')[0]), JSON.stringify(archiveFiles('aiQueue')));

      // D4 二次归档新建时间戳文件（追加式，不覆盖既有历史）
      store.write('aiQueue', [{ id: 'd9', status: 'FAILED', createdAt: T - 20 * DAY }]);
      queue.pruneTerminal({ now: T, retentionMs: 7 * DAY, maxTerminal: 500 });
      chk('D4 二次归档新建文件、不覆盖既有归档（追加式演进）',
        archiveFiles('aiQueue').length >= 1
        && readAllArchived('aiQueue').some((x) => x.id === 'd3')
        && readAllArchived('aiQueue').some((x) => x.id === 'd9'),
        JSON.stringify(archiveFiles('aiQueue')));
      chk('D5 总数守恒：主文件 + 归档 == 初始条数（归档不丢数据）',
        queue.list().length + readAllArchived('aiQueue').length === 7,
        queue.list().length + '+' + readAllArchived('aiQueue').length);
    }

    // ═══════════ E 组：故障注入（prune 抛异常不阻断 enqueue 且 loud）═══════════
    {
      resetCollection('aiQueue');
      store.write('aiQueue', [
        { id: 'e_old', taskId: 'e_old', status: 'DONE', createdAt: Date.now() - 30 * DAY, priority: 50 },
      ]);
      const origArchiveWhere = store.archiveWhere;
      const warns = [];
      const origWarn = console.warn;
      let enq = null;
      let enqThrew = null;
      try {
        store.archiveWhere = () => { throw new Error('injected archive failure'); };
        console.warn = (...a) => { warns.push(a.map(String).join(' ')); };
        try { enq = queue.enqueue({ taskId: 'e_new', priority: 70 }); }
        catch (e) { enqThrew = e; }
      } finally {
        store.archiveWhere = origArchiveWhere;
        console.warn = origWarn;
      }

      chk('E1 archiveWhere 抛异常时 enqueue 不抛（裁剪失败绝不阻断控制路径）',
        enqThrew === null, enqThrew ? String(enqThrew.message) : '');
      chk('E2 enqueue 仍成功返回且新项状态 = PENDING',
        !!enq && enq.id === 'e_new' && enq.status === 'PENDING', JSON.stringify(enq));
      let back = null;
      try { back = JSON.parse(fs.readFileSync(path.join(ISO, 'aiQueue.json'), 'utf8')); } catch (e) { back = null; }
      chk('E3 队列主文件仍可读且新项已落盘（最坏情况是重复留档，不是丢失）',
        Array.isArray(back) && back.some((x) => x.id === 'e_new'), JSON.stringify(back && back.map((x) => x.id)));
      chk('E4 失败必须 loud（console.warn 被调用，非静默）',
        warns.length >= 1 && warns.join('|').indexOf('[queue]') >= 0, JSON.stringify(warns));
    }

    // ═══════════ F 组：dequeue / enqueue 语义零破坏 ═══════════
    {
      resetCollection('aiQueue');
      const a = queue.enqueue({ taskId: 'f1', priority: 10 });
      const b = queue.enqueue({ taskId: 'f1', priority: 20 });
      chk('F1 同 taskId 重复入队不重复插入（幂等），且优先级更新',
        queue.list().length === 1 && b.priority === 20 && a.id === b.id,
        queue.list().length + ' prio=' + b.priority);

      queue.markDone('f1', 'DONE');
      const c = queue.enqueue({ taskId: 'f1', priority: 30 });
      chk('F2 终态 task 重新入队 ⇒ 状态回到 PENDING',
        c.status === 'PENDING' && queue.list().filter((x) => x.id === 'f1').length === 1,
        c.status + ' n=' + queue.list().length);

      resetCollection('aiQueue');
      queue.enqueue({ taskId: 'low', priority: 1 });
      queue.enqueue({ taskId: 'high', priority: 99 });
      chk('F3 enqueue 触发 prune 后新入队项不受影响（高优先级先出队）',
        (queue.dequeue() || {}).id === 'high', JSON.stringify(queue.list().map((x) => x.id + ':' + x.status)));

      const T = Date.now();
      queue.markDone('low', 'DONE');
      const pr = queue.pruneTerminal({ now: T + 30 * DAY, retentionMs: 7 * DAY, maxTerminal: 500 });
      chk('F4 归档终态项后，dequeue 不返回终态项（只取 PENDING）',
        pr.archived >= 1 && (queue.dequeue() || null) === null,
        'archived=' + pr.archived + ' q=' + JSON.stringify(queue.list().map((x) => x.id + ':' + x.status)));

      let mdThrew = null;
      try { queue.markDone('low', 'CANCELLED'); } catch (e) { mdThrew = e; }
      chk('F5 对已归档项调用 markDone 不抛（no-op；dispatch 记录才是终态事实源）',
        mdThrew === null, mdThrew ? String(mdThrew.message) : '');

      queue.enqueue({ taskId: 'f_last', priority: 5 });
      const dn = queue.dequeue();
      chk('F6 归档后在既有 RUNNING 项之间仍能正常出队（dequeue 标记 RUNNING 并落盘）',
        !!dn && dn.id === 'f_last' && dn.status === 'RUNNING'
        && queue.list().some((x) => x.id === dn.id && x.status === 'RUNNING'),
        JSON.stringify(dn && { id: dn.id, status: dn.status }));
    }

    // ═══════════ G 组：静态锚（不可移除的关键不变量）═══════════
    {
      chk('G1 dequeue 的 PENDING 过滤仍在（剥离注释后扫真代码）',
        /queue\.filter\(\(x\) => x\.status === 'PENDING'\)/.test(QUEUE_STRIPPED), 'anchor missing');

      const body = QUEUE_STRIPPED.slice(
        QUEUE_STRIPPED.indexOf('function pruneTerminal'),
        QUEUE_STRIPPED.indexOf('\nfunction dequeue'));
      chk('G2 pruneTerminal 只从终态白名单取候选（终态过滤不可移除）',
        /const terminals = all\.filter\(/.test(body)
        && /QUEUE_TERMINAL_STATES\.indexOf\(x\.status\) >= 0/.test(body), 'anchor missing');
      chk('G3 pruneTerminal 不含按位置切分 all 的写法（否则会移走 PENDING）',
        !/all\.slice\(0,/.test(body), 'position-based slicing present');

      const aw = JSONSTORE_STRIPPED.slice(JSONSTORE_STRIPPED.indexOf('archiveWhere(name, pred)'));
      const awBody = aw.slice(0, aw.indexOf('\n  findInArchive'));
      chk('G4 archiveWhere 在写入之前完成分拣（谓词抛异常 ⇒ 零写入的 fail-safe 结构）',
        awBody.indexOf('for (const x of arr)') >= 0
        && awBody.indexOf('_archiveAppend(name, moving)') > awBody.indexOf('for (const x of arr)')
        && awBody.indexOf('this.write(name, remaining)') > awBody.indexOf('_archiveAppend(name, moving)'),
        'order anchor missing');

      chk('G5 getSession 具备归档兜底 + 原位恢复（归档不改变可访问性）',
        /store\.findInArchive\('aiSessions', id\)/.test(SESSION_STRIPPED)
        && /store\.insert\('aiSessions', revived\)/.test(SESSION_STRIPPED), 'anchor missing');

      // 接口默认必须对「页式存储」成立：有数据也不归档（页式存储体积不随条数线性膨胀）。
      // 用只实现 read 的最小后端验证默认实现真的能跑（裸 StoreInterface.read 是 not implemented，
      // 故不能直接实例化基类——那不是在测默认实现，是在测抽象方法）。
      class PageStore extends StoreInterface {
        read() { return [{ id: 'x1' }, { id: 'x2' }]; }
      }
      const pg = new PageStore();
      const noopAw = pg.archiveWhere('aiTasks', () => true);
      chk('G6 接口默认 no-op：页式存储有数据也不归档，且 findInArchive 返回 null（自动降级不崩）',
        noopAw.archived === 0 && noopAw.remaining.length === 2
        && pg.findInArchive('aiSessions', 'x') === null, JSON.stringify(noopAw));
      chk('G6b 真实 SqliteStore 继承同一 no-op 默认（未覆盖 ⇒ 驱动切换时不崩、行为可预期）',
        SqliteStore.prototype.archiveWhere === StoreInterface.prototype.archiveWhere
        && SqliteStore.prototype.findInArchive === StoreInterface.prototype.findInArchive,
        'overridden=' + (SqliteStore.prototype.archiveWhere !== StoreInterface.prototype.archiveWhere));

      chk('G7 静态锚防空断言：剥离有效（注释里的 C117 已消失）且真代码仍在',
        QUEUE_STRIPPED.indexOf('C117') < 0
        && QUEUE_STRIPPED.indexOf("require('./store')") >= 0
        && QUEUE_RAW.indexOf('C117') >= 0
        && QUEUE_STRIPPED.split(/\r?\n/).length > 40,
        'stripped_len=' + QUEUE_STRIPPED.length);
    }

    // ═══════════ H 组：治理登记已迁移 ═══════════
    {
      const gaps = storageGovernanceGaps();
      chk('H1 治理校验为空：每个 FILES 键都已分类', gaps.length === 0, JSON.stringify(gaps));
      chk('H2 aiQueue / aiSessions 已迁入 BOUNDED_COLLECTIONS（登记文本说明谓词归档）',
        !!BOUNDED_COLLECTIONS.aiQueue && !!BOUNDED_COLLECTIONS.aiSessions
        && BOUNDED_COLLECTIONS.aiQueue.indexOf('PENDING') >= 0,
        String(BOUNDED_COLLECTIONS.aiQueue).slice(0, 80));
      chk('H3 两项已从 UNBOUNDED_ACCEPTED 移出（不得双重登记）',
        !UNBOUNDED_ACCEPTED.aiQueue && !UNBOUNDED_ACCEPTED.aiSessions,
        JSON.stringify(Object.keys(UNBOUNDED_ACCEPTED)));
      const listed = Object.keys(AUTO_ARCHIVE_LIMITS)
        .concat(Object.keys(BOUNDED_COLLECTIONS))
        .concat(Object.keys(UNBOUNDED_ACCEPTED));
      chk('H4 三表并集 == FILES 键集（无遗漏、无多余，本批次为 34）',
        new Set(listed).size === Object.keys(FILES).length
        && Object.keys(FILES).every((k) => listed.indexOf(k) >= 0),
        'union=' + new Set(listed).size + ' files=' + Object.keys(FILES).length);
      chk('H5 三表无重复登记（一个集合只归一类）',
        new Set(listed).size === listed.length, listed.length + ' vs ' + new Set(listed).size);
      chk('H6 UNBOUNDED_ACCEPTED 表本身保留（可空，但不得删表/不得塞进别处）',
        UNBOUNDED_ACCEPTED !== null && typeof UNBOUNDED_ACCEPTED === 'object'
        && Object.keys(UNBOUNDED_ACCEPTED).length === 0, JSON.stringify(UNBOUNDED_ACCEPTED));
    }

    // ═══════════ I 组：隔离零污染 ═══════════
    {
      chk('I1 本测试进程的数据根被隔离到 tmp（未指向真实 data）',
        norm(process.env.FPB_DATA_DIR).indexOf(norm(os.tmpdir())) === 0, norm(process.env.FPB_DATA_DIR));
      chk('I2 真实 data 目录顶层条目零变化（隔离零污染）',
        realDataEntries() === realBefore, 'before=' + realBefore.slice(0, 120) + ' after=' + realDataEntries().slice(0, 120));
      chk('I3 归档产物全部落在隔离目录内（未写到仓库）',
        norm(path.join(ISO, 'archive')).indexOf(norm(os.tmpdir())) === 0
        && !fs.existsSync(path.join(REAL_DATA, 'archive', 'aiQueue')), norm(path.join(ISO, 'archive')));
    }

    // ═══════════ J 组：会话 TTL + 归档不改变可访问性 ═══════════
    {
      resetCollection('aiSessions');
      const T = 1_700_000_000_000;

      // J1 未超龄 ⇒ 不裁
      store.write('aiSessions', [
        { id: 's_new', userMessages: [], tasks: [], updatedAt: T, createdAt: T },
      ]);
      const j1 = sessions.pruneSessions({ now: T, retentionMs: 30 * DAY, maxSessions: 200 });
      chk('J1 未超龄且未超封顶 ⇒ 会话一条都不归档',
        j1.archived === 0 && sessions.listSessions().length === 1, 'archived=' + j1.archived);

      // J2 超龄 ⇒ 归档
      resetCollection('aiSessions');
      store.write('aiSessions', [
        { id: 's_old', userMessages: [], tasks: [], updatedAt: T - 60 * DAY, createdAt: T - 60 * DAY },
        { id: 's_keep', userMessages: [], tasks: [], updatedAt: T, createdAt: T },
      ]);
      const j2 = sessions.pruneSessions({ now: T, retentionMs: 30 * DAY, maxSessions: 200 });
      chk('J2 updatedAt 超龄（60d > 30d）的会话被归档，新的留下',
        j2.archived === 1 && sessions.listSessions().map((s) => s.id).join(',') === 's_keep',
        'archived=' + j2.archived + ' left=' + JSON.stringify(sessions.listSessions().map((s) => s.id)));
      chk('J7 归档后 listSessions 不再含被归档项（列表语义 = 主集合）',
        !sessions.listSessions().some((s) => s.id === 's_old')
        && readAllArchived('aiSessions').some((s) => s.id === 's_old'), '');

      // J4/J5 归档不改变可访问性：getSession 原位恢复 + 后续写入走既有路径
      chk('J4a 直接查主集合已找不到被归档会话（确认归档真的发生了）',
        store.find('aiSessions', 's_old') === null, '');
      const revived = sessions.getSession('s_old');
      chk('J4b getSession 从归档原位恢复（否则 index.js:511 会静默新建会话）',
        !!revived && revived.id === 's_old' && store.find('aiSessions', 's_old') !== null,
        JSON.stringify(revived && revived.id));
      const appended = sessions.addMessage('s_old', 'ai', 'pong');
      chk('J5 恢复后 addMessage 走既有路径成功（恢复的是同一条会话，非新建）',
        !!appended && appended.id === 's_old' && appended.userMessages.length === 1
        && appended.userMessages[0].content === 'pong', JSON.stringify(appended && appended.userMessages));
      chk('J5b 未归档过的未知 id 仍返回 null（恢复兜底不会伪造会话）',
        sessions.getSession('s_never_existed') === null, '');

      // J6 超封顶：保留活跃时点最新的 N 条（用固定 updatedAt 保证确定性）
      resetCollection('aiSessions');
      const fake = [];
      for (let i = 0; i < 5; i++) {
        fake.push({ id: 'sc' + i, userMessages: [], tasks: [], updatedAt: T + i * 1000, createdAt: T });
      }
      store.write('aiSessions', fake);
      const j6 = sessions.pruneSessions({ now: T, retentionMs: 9999 * DAY, maxSessions: 2 });
      chk('J6 仅超封顶（年龄全新）⇒ 保留 updatedAt 最新的 maxSessions 条',
        j6.archived === 3 && sessions.listSessions().map((s) => s.id).join(',') === 'sc4,sc3',
        'archived=' + j6.archived + ' left=' + JSON.stringify(sessions.listSessions().map((s) => s.id)));

      // J3 createSession 是唯一增长点 ⇒ 自然写点触发裁剪（无需外部调度）
      resetCollection('aiSessions');
      store.write('aiSessions', [
        { id: 's_expired', userMessages: [], tasks: [], updatedAt: Date.now() - 60 * DAY, createdAt: Date.now() - 60 * DAY },
      ]);
      const fresh = sessions.createSession({ userMessage: 'hi' });
      chk('J3 createSession 顺带触发裁剪（超龄会话在被创建的同一写点归档）',
        !!fresh && store.find('aiSessions', 's_expired') === null
        && store.find('aiSessions', fresh.id) !== null, 'archived_old=' + (store.find('aiSessions', 's_expired') === null));

      // J8 裁剪失败必须 loud 且不阻断 createSession
      resetCollection('aiSessions');
      store.write('aiSessions', [
        { id: 's_expired2', userMessages: [], tasks: [], updatedAt: Date.now() - 60 * DAY, createdAt: Date.now() - 60 * DAY },
      ]);
      const origAw2 = store.archiveWhere;
      const warns2 = [];
      const origWarn2 = console.warn;
      let made = null, threw2 = null;
      try {
        store.archiveWhere = () => { throw new Error('injected session archive failure'); };
        console.warn = (...a) => { warns2.push(a.map(String).join(' ')); };
        try { made = sessions.createSession({ userMessage: 'still works' }); }
        catch (e) { threw2 = e; }
      } finally {
        store.archiveWhere = origAw2;
        console.warn = origWarn2;
      }
      chk('J8 会话裁剪失败不阻断 createSession（新建照常成功）',
        threw2 === null && !!made && !!made.id, threw2 ? String(threw2.message) : '');
      chk('J8b 会话裁剪失败必须 loud（console.warn 打 [sessions]）',
        warns2.length >= 1 && warns2.join('|').indexOf('[sessions]') >= 0, JSON.stringify(warns2));
    }
  } catch (e) {
    fail++;
    failures.push('FATAL ' + (e && e.stack ? e.stack : String(e)));
    console.log('FATAL ' + (e && e.stack ? e.stack : String(e)));
  } finally {
    for (const d of tmpRoots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* tmp 清理尽力而为 */ } }
  }

  console.log('\n===== C117 RESULT: ' + pass + ' passed, ' + fail + ' failed =====');
  if (fail > 0) { failures.forEach((f) => console.log('  FAILED: ' + f)); process.exit(1); }
})();
