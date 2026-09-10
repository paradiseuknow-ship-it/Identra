'use strict';

// JsonStore：StoreInterface 的 JSON 文件实现。
// 同步原子写（临时文件 + rename），与项目既有 db/vault 风格一致；主集合与归档
// 文件统一走原子写（C60 前归档是裸 writeFileSync 直写）。读路径对瞬时文件锁
// （EPERM/EBUSY/EACCES）与写路径同规格退避重试，fs 失败绝不吞成 fallback
// （read-modify-write 链路会把整集合覆写成 fallback = 静默清空）。
// 单进程下足够；多 Worker 场景由上层（TaskManager 唯一写入口 + 状态限频）兜底。

const fs = require('fs');
const path = require('path');
const { StoreInterface } = require('./store.interface');

const FILES = {
  aiTasks: 'aiTasks.json',
  aiSteps: 'aiSteps.json',
  aiAttempts: 'aiAttempts.json',
  aiRepairs: 'aiRepairs.json',
  aiExecutions: 'aiExecutions.json',
  aiCheckpoints: 'aiCheckpoints.json',
  aiEvents: 'aiEvents.json',
  aiCredentials: 'aiCredentials.json',
  aiKnowledge: 'aiKnowledge.json',
  aiQueue: 'aiQueue.json',
  aiSessions: 'aiSessions.json',
  aiCredentialUsage: 'aiCredentialUsage.json',
  aiFailureSnapshots: 'aiFailureSnapshots.json',
  aiRepairAttempts: 'aiRepairAttempts.json',
  aiSiteMemory: 'aiSiteMemory.json',
  aiElementMemory: 'aiElementMemory.json',
  aiFlowMemory: 'aiFlowMemory.json',
  aiFailureKnowledge: 'aiFailureKnowledge.json',
  aiProfileScores: 'aiProfileScores.json',
  aiDecisionCache: 'aiDecisionCache.json',
  aiIntelligenceEvaluations: 'aiIntelligenceEvaluations.json',
  aiDispatchExecutions: 'aiDispatchExecutions.json',
  aiWorkers: 'aiWorkers.json',
  aiBrowserResources: 'aiBrowserResources.json',
  aiProfileBindings: 'aiProfileBindings.json',
  aiPlannerEvidence: 'aiPlannerEvidence.json',
  aiSchedules: 'aiSchedules.json', // CAP-M1：定时触发 / 批量执行计划
  // PHASE 17-C：Project Skill 域（设计依据 17-B §17.3 —— 走同一 Facade，不新建存储系统）
  aiSkill: 'aiSkill.json',                 // Skill 主记录（状态机 + 契约 + 统计 + 生命周期）
  aiSkillHistory: 'aiSkillHistory.json',   // 版本快照（append-only，供 rollback）
  aiSkillEvidence: 'aiSkillEvidence.json', // 证据链（**独立集合**：体量大，必须配水位）
  aiSkillRuns: 'aiSkillRuns.json',         // 重放记录（独立性判定的唯一数据源）
  deprecationHits: 'deprecationHits.json', // C44：遗留端点（RFC 8594）命中计数
};

const EVENT_MAX = 500;

// 存储治理（Phase 15 后续工程债，2026-09-04）：
// aiAttempts 曾膨胀到 42MB（14446 条，error 内嵌完整 observation 长尾 171KB），
// 每条 insert/update 都触发全量 read+structuredClone+write，run3 期间同步阻塞事件循环数小时。
// 这里按「条数水位 → 最老 1/3 归档到 data/archive/<name>/，主文件截尾」治理；
// 归档是 trimCollection 的「不丢数据」版本，历史证据可追溯（evidence-first）。
const AUTO_ARCHIVE_LIMITS = {
  aiAttempts: 6000,
  aiSteps: 6000,
  aiExecutions: 5000,
  aiCheckpoints: 5000,
  aiTasks: 4000,
  aiRepairAttempts: 4000,
  aiPlannerEvidence: 3000,
  // PHASE 17-C：Skill 域水位。aiSkill 主记录规模小（一个 capability/site 一条，10²–10³）**刻意不设限**；
  // 证据链与重放记录按每次重放一条增长（10⁴–10⁵ 量级），必须配水位 —— 否则重演 aiAttempts 42MB 事故。
  aiSkillEvidence: 3000,
  aiSkillRuns: 4000,
  aiSkillHistory: 2000,
};

function archiveDateString(d) {
  const t = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return '' + t.getFullYear() + p(t.getMonth() + 1) + p(t.getDate()) + '-' + p(t.getHours()) + p(t.getMinutes()) + p(t.getSeconds());
}

// 瞬时文件锁（EPERM/EBUSY/EACCES）统一重试判定：与写路径 Phase 5.8 同一故障面
// （杀毒软件 / 文件索引器短暂锁定目标文件），读路径此前完全没有这层防护。
function isTransientLockError(e) {
  const code = e && e.code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

// 同步休眠（替代 write 重试退避里的 busy-wait 空转烧 CPU）。
function syncSleep(ms) {
  try {
    const sab = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sab, 0, 0, ms);
  } catch (e) {
    // SharedArrayBuffer 不可用（极老环境）退回 busy-wait
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy-wait */ }
  }
}

// 原子写（临时文件 + rename）+ 瞬时锁有限退避重试。
// write() 与归档追加共用（C60 前归档是裸 writeFileSync 直写，违背「同步原子写」自述，
// 进程中断可留下半截归档 JSON）。
function atomicWriteFileSync(f, payload) {
  const tmp = f + '.tmp';
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.writeFileSync(tmp, payload, 'utf8');
      try { fs.renameSync(tmp, f); return; }
      catch (re) {
        // 某些情况下 .tmp 残留会阻碍下次 rename，先清理再重试
        if (attempt === 4) throw re;
        try { fs.unlinkSync(tmp); } catch (_) {}
        lastErr = re;
        if (!isTransientLockError(re)) throw re;
        syncSleep((attempt + 1) * 20);
      }
    } catch (e) {
      lastErr = e;
      if (!isTransientLockError(e)) throw e;
      syncSleep((attempt + 1) * 20);
    }
  }
  if (lastErr) throw lastErr;
}

// 读文件 + 瞬时锁有限退避重试（C60：读路径此前零防护）。
// 注意：瞬时锁重试耗尽后必须抛出——read() 的调用方（insert/upsert/update/remove/
// appendEvent）全是 read-modify-write，把读失败吞成 fallback 会把整集合覆写成
// fallback（真实数据丢失）。fs 读取失败 ≠ 文件损坏，两者语义必须分开。
function readFileSyncRetry(f) {
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try { return fs.readFileSync(f, 'utf8'); }
    catch (e) {
      lastErr = e;
      if (!isTransientLockError(e)) throw e;
      syncSleep((attempt + 1) * 20);
    }
  }
  throw lastErr;
}

class JsonStore extends StoreInterface {
  constructor(dataDir) {
    super();
    this.dir = dataDir;
  }

  _file(name) {
    if (!FILES[name]) throw new Error('未知 AI 集合: ' + name);
    return path.join(this.dir, FILES[name]);
  }

  _ensure() {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
  }

  // 读取并强制返回深拷贝：read() 本身已返回深拷贝（见下），直接转发即可。
  // 历史上这里对 read 的结果再做一次 structuredClone，是大集合（40MB）读路径双倍开销的来源之一。
  _readClone(name, fallback) {
    return this.read(name, fallback);
  }

  read(name, fallback = []) {
    const f = this._file(name);
    this._ensure();
    if (!fs.existsSync(f)) return Array.isArray(fallback) ? fallback.slice() : fallback;
    // C60：fs 读取失败（瞬时锁重试耗尽 / 权限等）直接抛出，绝不当成「文件不存在」
    // 吞成 fallback——read-modify-write 链路（insert/upsert/update/remove/appendEvent）
    // 会把 fallback 覆写回主文件，造成整集合静默清空（真实数据丢失）。
    // 只有真正的 JSON 解析失败（文件损坏）才走 fallback，维持既有契约。
    const raw = readFileSyncRetry(f);
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return Array.isArray(fallback) ? fallback.slice() : fallback; }
    // 返回深拷贝，避免调用方改动污染后续读取
    try { return structuredClone(parsed); } catch (e) { return JSON.parse(JSON.stringify(parsed)); }
  }

  write(name, data) {
    const f = this._file(name);
    this._ensure();
    // 自动归档（存储治理）：数组集合超过水位线时，把本次数据最老的 1/3 先移入归档文件，
    // 再落主文件（write 调用方持有的 data 就是全量数组，直接分拣，零额外读 IO）。
    // 直接操作归档文件（不经 this.write 主集合），_archiving 防御未来递归扩展。
    if (!this._archiving && Array.isArray(data) && AUTO_ARCHIVE_LIMITS[name] && data.length > AUTO_ARCHIVE_LIMITS[name]) {
      this._archiving = true;
      try {
        const count = Math.floor(AUTO_ARCHIVE_LIMITS[name] / 3);
        const moving = data.slice(0, count);
        data = data.slice(count);
        this._archiveAppend(name, moving);
      } finally {
        this._archiving = false;
      }
    }
    atomicWriteFileSync(f, JSON.stringify(data, null, 2));
  }

  // 归档追加（C60 抽取共用）：auto-archive 与 archiveOldest 原本是两份同构代码
  // （C58 D2 教训：重复定义会各自漂移），统一为：损坏归档侧车保全 + 原子写。
  _archiveAppend(name, moving) {
    const adir = path.join(this.dir, 'archive', name);
    fs.mkdirSync(adir, { recursive: true });
    const f = path.join(adir, archiveDateString() + '.json');
    let prev = [];
    if (fs.existsSync(f)) {
      try {
        const p = JSON.parse(readFileSyncRetry(f));
        if (Array.isArray(p)) prev = p;
      } catch (e) {
        // C60：归档历史是 evidence-first 的「不丢数据」承诺，损坏时绝不静默清空
        // 覆写——先把损坏文件侧车保全（.corrupt-<时间戳>），再从空数组续写。
        try { fs.renameSync(f, f + '.corrupt-' + archiveDateString()); } catch (_) {}
        prev = [];
      }
    }
    prev.push(...moving);
    atomicWriteFileSync(f, JSON.stringify(prev, null, 2));
    return f;
  }

  // 归档最老 count 条（数组头部）到 data/archive/<name>/<时间戳>.json，返回 { archived, remaining }。
  // 归档文件按 JSON 数组存储，重复归档依次新建时间戳文件（不合并，追加式演进）。
  archiveOldest(name, count) {
    const arr = this.read(name, []);
    if (!Array.isArray(arr) || arr.length === 0 || count <= 0 || arr.length <= count) {
      return { archived: 0, remaining: arr };
    }
    const moving = arr.slice(0, count);
    const remaining = arr.slice(count);
    const f = this._archiveAppend(name, moving);
    this.write(name, remaining);
    return { archived: moving.length, remaining, archiveFile: f };
  }

  find(name, id) {
    return this._readClone(name, []).find((x) => x && x.id === id) || null;
  }

  findWhere(name, pred) {
    return this._readClone(name, []).filter((x) => x && pred(x));
  }

  insert(name, obj) {
    const arr = this.read(name, []);
    arr.push(obj);
    this.write(name, arr);
    return obj;
  }

  upsert(name, obj) {
    const arr = this.read(name, []);
    const i = arr.findIndex((x) => x && x.id === obj.id);
    if (i >= 0) arr[i] = obj;
    else arr.push(obj);
    this.write(name, arr);
    return obj;
  }

  remove(name, id) {
    this.write(name, this.read(name, []).filter((x) => x && x.id !== id));
  }

  delete(name, id) { return this.remove(name, id); }

  // 清空集合（name 缺省则全部）。测试/重置用。
  clear(name) {
    if (name) { this.write(name, []); return true; }
    for (const n of Object.keys(FILES)) this.write(n, []);
    return true;
  }

  update(name, id, patch) {
    const arr = this.read(name, []);
    const i = arr.findIndex((x) => x && x.id === id);
    if (i < 0) return null;
    arr[i] = Object.assign({}, arr[i], patch);
    this.write(name, arr);
    return this._readClone(name, [])[i] || arr[i];
  }

  transaction(fn) {
    // JSON 单进程同步，无真正事务；回调内操作即时落盘，异常不回滚（保持与原语义一致）。
    return fn(this);
  }

  trimCollection(name, keep) {
    const arr = this.read(name, []);
    if (arr.length > keep) this.write(name, arr.slice(arr.length - keep));
  }

  appendEvent(evt) {
    const arr = this.read('aiEvents', []);
    arr.push(evt);
    if (arr.length > EVENT_MAX) arr.splice(0, arr.length - EVENT_MAX);
    this.write('aiEvents', arr);
    return evt;
  }

  eventsSince(lastEventId) {
    const arr = this.read('aiEvents', []);
    const idx = arr.findIndex((x) => x.eventId === lastEventId);
    return idx >= 0 ? arr.slice(idx + 1) : arr;
  }
}

module.exports = { JsonStore, FILES, EVENT_MAX, AUTO_ARCHIVE_LIMITS, archiveDateString };
