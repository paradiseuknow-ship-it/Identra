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
// C115：I/O 原语统一到 fsSafe（fsSafe.js 头部注释预留的「后续如做统一，需单独批次
// 回归 jsonStore 全套件」——本批次即该批次）。此前本文件自持一份副本，与 fsSafe
// 逐字对齐；重复定义会各自漂移（C58 D2 教训）。替换为零语义变更：同款瞬时锁
// （EPERM/EBUSY/EACCES）5 次退避 + 耗尽 fail-loud + tmp/rename 原子写。
const { readFileSyncRetry, atomicWriteFileSync } = require('../../fsSafe');

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
  aiSkillRouting: 'aiSkillRouting.json',   // PHASE 17-D 路由决策影子记录（含 actual 回填，供决策质量比对）
  aiSkillExecutions: 'aiSkillExecutions.json', // PHASE 17-E Skill 接管执行记录（逐步证据 + handover + 终态，executionId 配对）
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
  // PHASE 17-D：路由影子记录。每个任务至多一条（含回填），随任务量增长 → 必须配水位。
  aiSkillRouting: 4000,
  // PHASE 17-E：Skill 接管执行记录。每个 (task, execution) 至多一条，但记录内嵌逐步证据，
  // 体积大于路由记录 → 取更紧的水位（2000）。不设水位会随任务量线性增长。
  aiSkillExecutions: 2000,
  // C115 补漏：以下两个集合早已注册 FILES 但从未给水位——「新集合必须同时注册两张表」
  // 这条纪律此前只靠人记，没有任何机制拦截（D5 的治理断言正是为此而加）。
  // 两者的量级都是「每任务一条」审计记录，与 aiSkillRouting 同阶 → 取 4000。
  aiIntelligenceEvaluations: 4000, // Phase 3.6：Runtime 在 Task SUCCESS/FAILED 时 collect() 一条
  aiDispatchExecutions: 4000,      // Phase 4.1：queueManager.submit() 每次派遣一条
};

// ── 存储治理登记（C115）──────────────────────────────────────────────────────
// FILES 里的每个键都必须落进下面三张表之一，由 storageGovernanceGaps() 强制校验。
// 目的：把「新增集合必须同时配水位」从「靠人记」变成「测试即失败」。
// 依据：aiAttempts 42MB 事故与 C115 D2（两个集合注册了 FILES 却漏水位，跑了很久没人发现）
// 都是同一成因——两张表之间没有任何一致性约束。
//   ① AUTO_ARCHIVE_LIMITS —— 历史审计型：超水位把最老 1/3 归档到 data/archive/（不丢数据）
//   ② BOUNDED_COLLECTIONS  —— 天然有界：按 id upsert / 环形缓冲 / 显式 trimCollection
//   ③ UNBOUNDED_ACCEPTED   —— 已知随业务量增长但**不适用归档治理**（登记边界，非默许）
const BOUNDED_COLLECTIONS = {
  aiEvents: 'EVENT_MAX=500 环形缓冲（appendEvent 内 splice 截尾）',
  aiKnowledge: 'trimCollection 2000（memory.js:20）',
  aiCredentialUsage: 'trimCollection 2000（secretManager.js:161）',
  aiFailureSnapshots: 'trimCollection 1000（failureSnapshot.js:36）',
  aiElementMemory: '按 (site × semantic) upsert 单条演进',
  aiSiteMemory: '按 site upsert',
  aiFlowMemory: '按 (site × goal) upsert（17-B：Project Skill 的前身）',
  aiFailureKnowledge: '按 failureId upsert',
  aiProfileScores: '按 profileId upsert',
  aiCredentials: '按 credentialId upsert',
  aiBrowserResources: '按 resourceId upsert（同 id 重建）',
  aiProfileBindings: '按 profileId × workerId upsert',
  aiWorkers: '按 workerId upsert（规模 = worker 数）',
  aiSchedules: '按 scheduleId upsert（CAP-M1 定时计划）',
  aiSkill: '**刻意不设水位**：一个 capability/site 一条，10²–10³ 量级（PHASE 17-C 设计）',
  aiRepairs: '死登记：无生产写入方（仅保留历史集合名）',
  aiDecisionCache: '死登记：decisionCache 当前为内存实现，未落盘',
  deprecationHits: '按端点路径 upsert 计数（C44）',
};

// 登记边界（C 类，非本批次修复）：如实记录「已知无界 + 为何不能简单套用归档」。
// 归档语义会把最老 1/3 记录**移出主文件**，对「主文件即工作集」的集合是行为破坏。
const UNBOUNDED_ACCEPTED = {
  aiQueue: '终态只改 status、记录永久残留（queue.js markDone）→ 随任务量无界。'
    + '**不可用归档治理**：dequeue 只读主文件，归档会把尚在 PENDING 的任务移出队列 = '
    + '任务静默不执行（比无界增长更糟）。正解 = queue 层终态清理/TTL，属独立批次。',
  aiSessions: '每次新建会话 insert 一条、无 TTL（sessionManager.js:24）→ 随对话量无界。'
    + '正解 = 会话 TTL / 按工作区清理，需先确定保留策略，属独立批次。',
};

// 治理校验：返回未登记的集合名（空数组 = 合规）。测试与启动自检共用。
function storageGovernanceGaps() {
  const gaps = [];
  for (const name of Object.keys(FILES)) {
    if (AUTO_ARCHIVE_LIMITS[name]) continue;
    if (BOUNDED_COLLECTIONS[name]) continue;
    if (UNBOUNDED_ACCEPTED[name]) continue;
    gaps.push(name);
  }
  return gaps;
}

function archiveDateString(d) {
  const t = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return '' + t.getFullYear() + p(t.getMonth() + 1) + p(t.getDate()) + '-' + p(t.getHours()) + p(t.getMinutes()) + p(t.getSeconds());
}

// 损坏文件侧车保全（C115）：把损坏文件 rename 成 <file>.corrupt-<时间戳> 再返回，
// 绝不覆盖既有侧车（同名追加序号）。修复前此处不对称——归档文件损坏有侧车保全
// （_archiveAppend），主集合损坏却直接吞成 fallback → 下一次 RMW 把坏文件覆写成
// 「空集合 + 新记录」，原始数据永久蒸发且无从取证（与 C60 修掉的瞬时锁吞 fallback
// 是同一后果面，只是触发源从「锁」换成「真损坏」）。返回值契约不变（read 仍返回
// fallback，test_c60 P3 守护）；rename 后文件不存在，下次 read 走「文件不存在 →
// fallback」的干净路径，不会重复触发解析失败。
function preserveCorruptSidecar(f) {
  const base = f + '.corrupt-' + archiveDateString();
  let target = base;
  for (let i = 1; i < 20 && fs.existsSync(target); i++) target = base + '-' + i;
  try { fs.renameSync(f, target); return target; }
  catch (e) { return null; }
}

// 瞬时锁退避重试读 / tmp+rename 原子写统一由 server/fsSafe.js 提供（C115 去重）。
// 语义要点保留在此：瞬时锁重试耗尽后必须抛出——read() 的调用方（insert/upsert/
// update/remove/appendEvent）全是 read-modify-write，把 fs 读失败吞成 fallback 会把
// 整集合覆写成 fallback（真实数据丢失）。fs 读取失败 ≠ 文件损坏，两者语义必须分开。

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
    try { parsed = JSON.parse(raw); }
    catch (e) {
      // C115：真损坏走 fallback 的返回契约不变，但坏文件必须先侧车保全——否则紧接着的
      // RMW（insert/upsert/update/remove/appendEvent）会把「空集合 + 新记录」覆写回去，
      // 损坏前的全量数据永久蒸发且无从取证。C60 只堵住了「锁导致的读失败」这一个入口，
      // 「文件内容损坏」是同一后果面的另一个入口，此前无防护。
      preserveCorruptSidecar(f);
      return Array.isArray(fallback) ? fallback.slice() : fallback;
    }
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
        // C115：改用共用 preserveCorruptSidecar（原为此处内联 rename；主集合新增侧车后
        // 若不统一就变成第二份同义实现 → C58 D2「重复定义会各自漂移」）。
        preserveCorruptSidecar(f);
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

module.exports = {
  JsonStore, FILES, EVENT_MAX, AUTO_ARCHIVE_LIMITS, archiveDateString,
  // C115 存储治理登记：前两张为分类依据（人读），storageGovernanceGaps() 为校验入口
  // （守护测试断言为空数组；新增集合若三张表都没登记即测试红）。
  BOUNDED_COLLECTIONS, UNBOUNDED_ACCEPTED, storageGovernanceGaps,
};
