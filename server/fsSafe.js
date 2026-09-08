'use strict';

// C62：身份层硬化 IO 原语（从 C60 jsonStore 修复中沉淀的共享最小实现）。
// 语义与 server/agent/storage/jsonStore.js 内同款函数逐字对齐：
//   - 瞬时文件锁（EPERM/EBUSY/EACCES，杀毒软件 / 文件索引器短暂锁定）重试 5 次退避；
//   - 耗尽后 fail-loud 抛出（绝不吞成 fallback[]，否则 read-modify-write 链下一次写
//     会把整个集合覆写成 fallback = 永久静默清空，C60 D1 同款 A 类）；
//   - 写路径统一 tmp+rename 原子写（崩溃/锁中断不再留下半截 JSON）。
// 边界：jsonStore.js 内部副本暂不切换到本模块（避免触碰 C60 已稳定面），语义保持
// 双处对齐；后续如做统一，需单独批次回归 jsonStore 全套件。

const fs = require('fs');

function isTransientLockError(e) {
  const code = e && e.code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

function syncSleep(ms) {
  try {
    const sab = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sab, 0, 0, ms);
  } catch (e) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy-wait */ }
  }
}

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
  throw lastErr;
}

module.exports = { isTransientLockError, syncSleep, readFileSyncRetry, atomicWriteFileSync };
