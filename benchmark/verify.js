'use strict';

// Phase 5.1 — 统一成功判据（三组 Runner 共用，保证同判分标准）
// verify: { type:'text'|'url'|'selector'|'state', value, timeoutMs }

async function verifyResult(task, page, opts = {}) {
  const v = task.verify || {};
  const timeout = v.timeoutMs || 8000;
  const base = opts.baseUrl || '';
  try {
    switch (v.type) {
      case 'url': {
        const suffix = v.value.startsWith('http') ? v.value : base + v.value;
        // 用正则"结尾包含"语义，容忍 query string（如 session 回跳带 ?n=2）
        const re = new RegExp(suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\?.*)?$');
        await page.waitForURL(re, { timeout });
        return true;
      }
      case 'selector': {
        await page.waitForSelector(v.value, { timeout, state: 'visible' });
        return true;
      }
      case 'text': {
        await page.waitForFunction(
          (val) => document.body && document.body.innerText.includes(val),
          v.value,
          { timeout }
        );
        return true;
      }
      case 'state': {
        // state 由页面 localStorage / data 属性表达（用 textContent 含隐藏节点）
        await page.waitForFunction(
          (val) => {
            try { return localStorage.getItem(val) === '1' || (document.body.textContent || '').includes(val); }
            catch { return (document.body.textContent || '').includes(val); }
          },
          v.value,
          { timeout }
        );
        return true;
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

module.exports = { verifyResult };
