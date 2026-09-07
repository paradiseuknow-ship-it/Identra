'use strict';
// C21：零依赖 5 字段 cron 表达式解析 + 下次触发时间计算（服务调度实体 aiSchedules 的 cron 模式）。
//
// 支持语法（标准 5 字段：分 时 日 月 周）：
//   *           任意值
//   */n         步进（域内从起点每 n）
//   a-b         范围
//   a-b/n       范围步进
//   a,b,c       列表（各项可为 * / 范围 / 步进）
//   @hourly / @daily / @midnight / @weekly / @monthly  别名
//   dow: 0-6（0=周日），7 视为 0（兼容惯例）
//
// cronNext(expr, from)：严格返回 > from 的下一次匹配（毫秒）。分钟级迭代，
// 上限 366 天（527,040 分钟）——不存在匹配（如 '0 0 31 2 *' 二月 31 日）时抛错而非死循环。
//
// 纪律：纯函数、无 IO、无全局态；消费方 scheduleTrigger（cron 优先于 intervalMs）。

const MIN = 0, MINUTE_CAP = 366 * 24 * 60; // 最长向前看一年

const ALIASES = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
};

const RANGES = [
  { min: 0, max: 59 },  // minute
  { min: 0, max: 23 },  // hour
  { min: 1, max: 31 },  // dom
  { min: 1, max: 12 },  // month
  { min: 0, max: 6 },   // dow
];

function _parseField(raw, idx) {
  const { min, max } = RANGES[idx];
  const set = new Set();
  for (const part of String(raw).split(',')) {
    if (!part) throw new Error('cron 域为空');
    let body = part;
    let step = 1;
    const slash = body.indexOf('/');
    if (slash >= 0) {
      step = Number(body.slice(slash + 1));
      if (!Number.isInteger(step) || step < 1) throw new Error('cron 步进非法: ' + part);
      body = body.slice(0, slash);
    }
    let lo = min, hi = max;
    if (body !== '*' && body !== '') {
      const dash = body.indexOf('-');
      if (dash >= 0) {
        lo = Number(body.slice(0, dash));
        hi = Number(body.slice(dash + 1));
      } else {
        lo = Number(body);
        hi = (slash >= 0 && body === '*' && step > 1) ? max : lo; // '*/n' 从域起点步进
        if (slash >= 0 && body === '*') { lo = min; hi = max; }
        else if (slash < 0) hi = lo;
      }
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error('cron 域值非法: ' + part);
    // C52 缺陷修复：dow 允许 7（=0 周日，惯例兼容），但必须在【值级】映射——
    // 旧实现在 lo/hi 级改写（lo 7→0、hi 7→6），把单值 7 展开成整周 0-6，
    // "0 0 * * 7"（仅周日）变成每天触发（A 类调度缺陷）。5-7 标准语义 {5,6,0} 同步修正。
    const hiCap = (idx === 4 && hi === 7) ? 7 : max;
    if (lo < min || hi > hiCap || lo > hi) throw new Error('cron 域越界: ' + part + '（域 ' + min + '-' + max + (idx === 4 ? '，周域另支持 7=周日' : '') + '）');
    for (let v = lo; v <= hi; v += step) set.add(idx === 4 && v === 7 ? 0 : v);
  }
  if (!set.size) throw new Error('cron 域为空: ' + raw);
  return set;
}

// 解析并返回 { minutes, hours, doms, months, dows }（Set 集合）；非法抛 Error（含中文可行动信息）
function parse(expr) {
  const e = String(expr || '').trim().toLowerCase();
  if (!e) throw new Error('cron 表达式为空');
  const expanded = ALIASES[e] || e;
  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) throw new Error('cron 必须 5 个域（分 时 日 月 周）: ' + expr);
  return {
    minutes: _parseField(parts[0], 0),
    hours: _parseField(parts[1], 1),
    doms: _parseField(parts[2], 2),
    months: _parseField(parts[3], 3),
    dows: _parseField(parts[4], 4),
  };
}

// DOM/DOW 标准cron 语义：两者均为受限（都非 *）时取并集；否则取交集
function _matchesDay(p, d) {
  const domStar = p.doms.size === 31;
  const dowStar = p.dows.size === 7;
  if (domStar && dowStar) return true;
  const domOk = p.doms.has(d.getDate());
  const dowOk = p.dows.has(d.getDay());
  if (domStar) return dowOk;
  if (dowStar) return domOk;
  return domOk || dowOk;
}

function _nextMinuteMatch(p, from) {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  for (let i = 0; i < MINUTE_CAP; i++) {
    d.setMinutes(d.getMinutes() + 1);
    if (!p.months.has(d.getMonth() + 1)) {
      // 快进：本月不匹配 → 跳到下月 1 号 00:00
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!p.hours.has(d.getHours())) continue;
    if (!p.minutes.has(d.getMinutes())) continue;
    if (!_matchesDay(p, d)) continue;
    return d.getTime();
  }
  throw new Error('cron 无匹配时刻（检查日/月组合是否存在，如 2 月 31 日）: ' + '(parsed)');
}

// 严格 > from 的下一次触发；expr 非法或无匹配时抛 Error
function cronNext(expr, from) {
  const p = parse(expr);
  return _nextMinuteMatch(p, from instanceof Date ? from : new Date(from));
}

module.exports = { parse, cronNext };
