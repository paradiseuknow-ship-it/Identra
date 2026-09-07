'use strict';
// C52 守护测试：cronExpr dow=7 值级映射修复（A 类调度缺陷）。
//
// 缺陷回顾（修复前）：_parseField 在 lo/hi 级改写 dow 7（lo 7→0、hi 7→6），
// 单值 7 被展开成整周 0-6 —— "0 0 * * 7"（仅周日）每天触发；
// "0,7" / "7/1" 同样中招；"5-7" 标准语义应为 {0,5,6}，旧实现给 {5,6}。
//
// 修复：dow 域在【值级】映射 v===7 → 0；越界检查放宽 hi===7（dow 专用）。
//
// 运行环境：零浏览器 / 零网络 / 零文件写入（纯函数模块，tmp 天然隔离）。
// 纪律：断言直接 require 真实模块（真正会执行的那份东西），不 eval 源码。

const assert = require('assert');
const { parse, cronNext } = require('../agent/cronExpr.js');

let PASS = 0, FAIL = 0;
const t = (name, fn) => {
  try { fn(); PASS++; console.log('PASS ' + name); }
  catch (e) { FAIL++; console.log('FAIL ' + name + ' :: ' + e.message); }
};
const dows = (e) => [...parse(e).dows].sort((a, b) => a - b).join(',');
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

// 基准日：2026-09-07 周一 10:00:00（本地时区）
const MON = new Date(2026, 8, 7, 10, 0, 0, 0); // month 8 = 9 月

// ---- A 类缺陷实证组：dow 7 必须是值级映射，不得展开整周 ----
t('U1 dow=7 单值 → 仅 {0}（修复前是整周 0-6）', () => assert.strictEqual(dows('0 0 * * 7'), '0'));
t('U2 dow=0,7 列表 → 仅 {0}（修复前是整周）', () => assert.strictEqual(dows('0 0 * * 0,7'), '0'));
t('U3 dow=7/1 步进 → 仅 {0}（修复前是整周）', () => assert.strictEqual(dows('0 0 * * 7/1'), '0'));
t('U4 dow=5-7 范围 → {0,5,6} 标准语义（修复前是 {5,6}）', () => assert.strictEqual(dows('0 0 * * 5-7'), '0,5,6'));
t('U5 dow=0-7 全域 → 等价 *（size 7）', () => assert.strictEqual(parse('0 0 * * 0-7').dows.size, 7));
t('U6 dow=0 与 dow=7 解析结果一致', () => assert.strictEqual(dows('0 0 * * 7'), dows('0 0 * * 0')));

// ---- 触发行为组：cronNext 真实日历命中 ----
t('U7 cronNext dow=7：周一 10:00 → 下个周日 00:00（修复前每天命中）', () => {
  const n = new Date(cronNext('0 0 * * 7', MON));
  assert.strictEqual(n.getDay(), 0, '必须命中周日');
  assert.strictEqual(n.getHours() * 60 + n.getMinutes(), 0, '必须命中 00:00');
  assert.ok(n.getTime() > MON.getTime());
});
t('U8 cronNext dow=1：周一 10:00 → 下个周一 00:00（普通路径回归）', () => {
  const n = new Date(cronNext('0 0 * * 1', MON));
  assert.strictEqual(n.getDay(), 1);
  assert.strictEqual(n.getTime(), new Date(2026, 8, 14, 0, 0, 0, 0).getTime());
});
t('U9 cronNext 严格 > from（同分钟不再命中）', () => {
  const at = new Date(2026, 8, 7, 10, 0, 30, 0); // 恰在 10:00 触发秒后
  const n = new Date(cronNext('0 10 * * *', at));
  assert.strictEqual(n.getTime(), new Date(2026, 8, 8, 10, 0, 0, 0).getTime());
});

// ---- 非周域回归组：修复只动 dow，其余域零变化 ----
t('U10 分钟步进 */15 → 4 个值', () => assert.strictEqual(parse('*/15 0 1 1 *').minutes.size, 4));
t('U11 小时/日/月越界照旧拒绝', () => {
  assert.throws(() => parse('0 24 * * *'));
  assert.throws(() => parse('0 0 32 * *'));
  assert.throws(() => parse('0 0 * 13 *'));
});
t('U12 dow=8 仍拒绝（放宽只到 7）', () => assert.throws(() => parse('0 0 * * 8')));
t('U13 dow=7-0 逆序仍拒绝', () => assert.throws(() => parse('0 0 * * 7-0')));
t('U14 步进 0 仍拒绝', () => assert.throws(() => parse('*/0 0 * * *')));
t('U15 不可能日期（2 月 31 日）仍抛错不死循环', () => {
  assert.throws(() => cronNext('0 0 31 2 *', MON));
});
t('U16 @weekly 别名 → 周日 {0}', () => {
  const p = parse('@weekly');
  assert.strictEqual(p.dows.size, 1);
  assert.ok(p.dows.has(0));
});
t('U17 域结构五件套回归（minutes/hours/doms/months/dows）', () => {
  const p = parse('5,35 2 1 1 *');
  assert.strictEqual(dows('5,35 2 1 1 *'), '0,1,2,3,4,5,6'); // dow 为 * → 全集
  assert.strictEqual(p.dows.size, 7);
  assert.ok(p.minutes.has(5) && p.minutes.has(35) && p.minutes.size === 2);
  assert.ok(p.hours.has(2) && p.doms.has(1) && p.months.has(1));
});

// ---- 接线守护：scheduleTrigger 必须消费本模块（防未来旁路/复刻解析器） ----
const fs = require('fs');
const path = require('path');
t('U18 scheduleTrigger 仍经 cronNext 消费（单点解析器）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'scheduleTrigger.js'), 'utf8');
  assert.ok(/require\(['"]\.\/cronExpr['"]\)/.test(src), 'scheduleTrigger 必须 require ./cronExpr');
  assert.ok(/cronNext\(/.test(src), 'scheduleTrigger 必须调用 cronNext');
});
t('U19 cronExpr 修复代码在位（值级映射锚点）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'cronExpr.js'), 'utf8');
  assert.ok(/v === 7 \? 0 : v/.test(src), '必须保留值级 7→0 映射');
  assert.ok(!/if \(idx === 4 && hi === 7\) hi = 6;/.test(src), '旧 lo/hi 级改写必须已移除');
});

console.log('\nRESULT: PASS=' + PASS + ' FAIL=' + FAIL);
process.exit(FAIL ? 1 : 0);
