'use strict';

/**
 * C106 F20：人类化输入（human-like input）。
 *
 * 背景（真实站点实证，非推测）：
 *   注册表单第一步填邮箱时，Agent 以约 60ms/字符（≈17 字符/秒）注入，人类打字是
 *   150–250ms/字符。过快的注入导致：
 *     ① 受控组件（React/Vue）在每次 input 事件后 re-render，若 re-render 重建了
 *        input 节点，焦点丢失 → 后续字符打到 body → 只进去了前几个字符；
 *     ② 页面随后再次刷新/切换步骤，Agent 却认为「邮箱已填好」，继续填下一项，
 *        于是把本该属于下一步的值写进了当前可见的那个字段里。
 *   而 fill 分支原本**从不回读校验**——填进去 3 个字符也照样返回 SUCCESS，
 *   于是错误一路静默传递到验证层，最终表现为「莫名其妙的失败」。
 *
 * 本模块只做 execution 层的输入节奏与结果校验：
 *   - 不触碰 verification 判据面（Phase 6 红线：验证成功逻辑）
 *   - 不触碰 success definition、任务池、benchmark 阈值
 *   - 不含任何站点名 / 域名 / 站点特判（F20 纪律锁，由守护测试断言）
 *
 * 三道修复：
 *   F20-a 节奏：按人类区间注入（~145ms/字符），并按值长自适应压缩以守住总时长上限
 *   F20-b 稳定：输入前等待字段在 DOM 上「稳定存在」，避开页面 re-render 窗口
 *   F20-c 校验：输入后回读 DOM 值，不等于期望值则有限补录，仍不等则 fail-loud
 */

// 单次输入的时间预算（毫秒）。超过则按比例压缩每字符延迟，
// 保证不会退化成瞬时填充，也不会击穿 withBrowserOp 的 25s 超时上限。
const TYPING_BUDGET_MS = 12000;
// 压缩后的地板值：再快就不是人类输入了（也失去了让前端框架跟上的意义）。
const MIN_CHAR_DELAY_MS = 25;
// 逐字符输入的长度上限。超过则整体赋值（长文本对应人类的「粘贴」行为，
// 也避免击穿 withBrowserOp 的 25s 超时）。
const MAX_TYPED_CHARS = 120;

// 人类打字节奏基准（毫秒/字符）。base + random(0..random) → 约 90–200ms/字符，
// 均值 ~145ms（≈7 字符/秒，对应人类偏快的打字速度）。
const BASE_DELAY_MS = 90;
const RANDOM_DELAY_MS = 110;

// 认证/凭据类字段再慢一点：这类字段最常触发前端实时校验（强度提示、可用性查询），
// 也是出错代价最高的字段。
const SENSITIVE_FIELD_RE = /(pass|pwd|secret|cvv|cvc|card|security|code|otp|token)/i;
const SENSITIVE_FACTOR = 1.25;

// 输入后让前端状态稳定的冷却区间（毫秒）。
const SETTLE_MIN_MS = 220;
const SETTLE_MAX_MS = 460;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
}

/**
 * 计算本次输入的逐字符延迟参数。
 *
 * 超过 MAX_TYPED_CHARS 的值不再逐字符输入 —— 人类打 4000 个字符的方式是粘贴，
 * 不是打字；逐字符在地板延迟下仍会到 100s，直接击穿 withBrowserOp 的 25s 超时。
 * 此类值降级为 mode='fill'（聚焦后整体赋值），由调用方分流。
 *
 * @param {string} value 待输入值（仅用其长度，不读内容）
 * @param {object} [opts] { field }
 * @returns {{baseDelay:number, randomDelay:number, budgetMs:number, mode:'type'|'fill'}}
 */
function typingProfile(value, opts) {
  const o = opts || {};
  const str = String(value == null ? '' : value);
  const len = str.length || 1;
  if (str.length > MAX_TYPED_CHARS) {
    return { baseDelay: 0, randomDelay: 0, budgetMs: TYPING_BUDGET_MS, mode: 'fill' };
  }
  let base = BASE_DELAY_MS;
  let rand = RANDOM_DELAY_MS;
  if (o.field && SENSITIVE_FIELD_RE.test(String(o.field))) {
    base = Math.round(base * SENSITIVE_FACTOR);
    rand = Math.round(rand * SENSITIVE_FACTOR);
  }
  const avg = base + rand / 2;
  const total = avg * len;
  if (total > TYPING_BUDGET_MS) {
    const scale = TYPING_BUDGET_MS / total;
    base = Math.max(MIN_CHAR_DELAY_MS, Math.round(base * scale));
    rand = Math.max(0, Math.round(rand * scale));
  }
  return { baseDelay: base, randomDelay: rand, budgetMs: TYPING_BUDGET_MS, mode: 'type' };
}

/**
 * 值等价判定（用于回读校验）。
 *
 * 严格相等为首选；不等时做一次「宽松比较」：站点前端常对卡号/电话做格式化
 * （插入空格或连字符），此时去分隔符后相等应视为成功。
 * 但密码/凭据类字段**绝不参与宽松比较**——它们的空格是有效字符，
 * 宽松放行会让错误的值被当作正确值（fail-loud 优先于看起来成功）。
 *
 * @returns {{equal:boolean, normalized:boolean}}
 */
function valuesMatch(actual, expected, opts) {
  const o = opts || {};
  const a = String(actual == null ? '' : actual);
  const e = String(expected == null ? '' : expected);
  if (a === e) return { equal: true, normalized: false };
  if (o.field && SENSITIVE_FIELD_RE.test(String(o.field))) return { equal: false, normalized: false };
  const strip = (s) => s.replace(/[\s\-()]/g, '');
  if (strip(a) === strip(e)) return { equal: true, normalized: true };
  return { equal: false, normalized: false };
}

/** 输入后的稳定冷却（让受控组件的 onChange/校验跑完再进入下一步）。 */
function settleDelay() {
  return Math.round(SETTLE_MIN_MS + Math.random() * (SETTLE_MAX_MS - SETTLE_MIN_MS));
}

/**
 * F20-b：等待字段在 DOM 上稳定存在，避开页面 re-render / 步骤切换窗口。
 *
 * 判据刻意保持在 execution 层（只看元素是否 attached+可见+尺寸稳定），
 * **不读取也不修改验证层的就绪判定**（Phase 6 红线：验证成功逻辑不可动）。
 *
 * @returns {Promise<{stable:boolean, waitedMs:number, reason?:string}>}
 */
async function waitFieldStable(page, selector, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs == null ? 1500 : o.timeoutMs;
  const intervalMs = o.intervalMs == null ? 140 : o.intervalMs;
  const deadline = Date.now() + timeoutMs;
  if (!page || typeof page.locator !== 'function') return { stable: false, waitedMs: 0, reason: 'no_page' };

  let prev = null;
  let waited = 0;
  for (;;) {
    let snap = null;
    try {
      snap = await page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), disabled: !!el.disabled };
      }, selector).catch(() => null);
    } catch (e) {
      snap = null;
    }
    if (!snap || snap.w <= 0 || snap.h <= 0 || snap.disabled) {
      prev = null;
    } else if (prev && prev.w === snap.w && prev.h === snap.h && prev.disabled === snap.disabled) {
      return { stable: true, waitedMs: waited };
    } else {
      prev = snap;
    }
    if (Date.now() >= deadline) {
      return { stable: false, waitedMs: waited, reason: prev ? 'not_settled' : 'not_visible' };
    }
    await sleep(intervalMs);
    waited += intervalMs;
  }
}

/**
 * 回读字段当前值。多元素匹配时取第一个可见实例（与 humanClick 的选择语义一致）。
 * @returns {Promise<string|null>} 读不到返回 null（区分「空字符串」与「读失败」）
 */
async function readBackValue(page, selector) {
  if (!page || typeof page.locator !== 'function') return null;
  try {
    const v = await page.locator(selector).first().inputValue({ timeout: 2000 });
    return v == null ? null : String(v);
  } catch (e) {
    return null;
  }
}

/** 用于日志/错误的安全摘要：绝不回显凭据明文（LLM 永不见明文凭据）。 */
function describeValue(value, field) {
  const s = String(value == null ? '' : value);
  const sensitive = !!field && SENSITIVE_FIELD_RE.test(String(field));
  if (!s) return { length: 0, preview: '', sensitive };
  if (sensitive) return { length: s.length, preview: '***', sensitive };
  return { length: s.length, preview: s.length <= 24 ? s : s.slice(0, 12) + '…' + s.slice(-4), sensitive };
}

module.exports = {
  TYPING_BUDGET_MS,
  MIN_CHAR_DELAY_MS,
  MAX_TYPED_CHARS,
  BASE_DELAY_MS,
  RANDOM_DELAY_MS,
  SENSITIVE_FIELD_RE,
  typingProfile,
  valuesMatch,
  settleDelay,
  waitFieldStable,
  readBackValue,
  describeValue,
  sleep,
};
