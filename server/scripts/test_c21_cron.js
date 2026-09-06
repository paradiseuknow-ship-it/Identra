'use strict';
// C21 守护测试 —— 调度 cron 表达式模式（server/agent/cronExpr.js + scheduleTrigger 接入）。
// 缺陷背景：调度此前仅支持 intervalMs 固定间隔——「每天 9 点」类需求无法表达，且固定间隔
// 从当下重算会漂移。C21 增加可选 cron 字段（5 字段标准语法 + @别名），cron 优先于 intervalMs。
// 覆盖两层：
//   U1-U7 单元：cronNext 语义（同日命中 / 次日 / 步进 / 周几 / @别名 / 严格大于 / 不可能日期拒绝）
//   H1-H5 HTTP：cron 创建 200+nextRunAt 符合语义 / 非法 cron 400 / 两者皆缺 400 / PUT 变更 cron /
//              详情回读 cron 字段（零浏览器，AI_PROVIDER=mock）

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cronNext } = require(path.join(__dirname, '..', 'agent', 'cronExpr'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}

function req(method, p, body, base) {
  return new Promise((resolve) => {
    const r = http.request((base || BASE) + p, { method, timeout: 15000, headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ code: res.statusCode, body: d }));
    });
    r.on('error', (e) => resolve({ code: 0, body: String(e) }));
    r.on('timeout', () => { r.destroy(); resolve({ code: 0, body: 'TIMEOUT' }); });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

// ---- 单元层 ----
function at(y, mo, d, h, mi) { return new Date(y, mo - 1, d, h, mi, 0, 0); }

// U1 每天 9 点：08:00 → 同日 09:00
chk('U1 每天9点 同日命中', cronNext('0 9 * * *', at(2026, 9, 7, 8, 0)) === at(2026, 9, 7, 9, 0).getTime(),
  String(cronNext('0 9 * * *', at(2026, 9, 7, 8, 0))));
// U2 每天 9 点：10:30 → 次日 09:00
chk('U2 每天9点 次日', cronNext('0 9 * * *', at(2026, 9, 7, 10, 30)) === at(2026, 9, 8, 9, 0).getTime(),
  String(cronNext('0 9 * * *', at(2026, 9, 7, 10, 30))));
// U3 步进：10:07 → 10:15
chk('U3 */15 步进', cronNext('*/15 * * * *', at(2026, 9, 7, 10, 7)) === at(2026, 9, 7, 10, 15).getTime(),
  String(cronNext('*/15 * * * *', at(2026, 9, 7, 10, 7))));
// U4 周一 9 点：周三 → 下周一（2026-09-09 是周三，下一个周一 = 09-14）
chk('U4 周几语义', cronNext('0 9 * * 1', at(2026, 9, 9, 12, 0)) === at(2026, 9, 14, 9, 0).getTime(),
  String(cronNext('0 9 * * 1', at(2026, 9, 9, 12, 0))));
// U5 @daily 别名 → 次日 00:00
chk('U5 @daily 别名', cronNext('@daily', at(2026, 9, 7, 5, 0)) === at(2026, 9, 8, 0, 0).getTime(),
  String(cronNext('@daily', at(2026, 9, 7, 5, 0))));
// U6 严格大于：恰好在 09:00:00 → 次日 09:00（不重复触发当刻）
chk('U6 严格大于 from', cronNext('0 9 * * *', at(2026, 9, 7, 9, 0)) === at(2026, 9, 8, 9, 0).getTime(),
  String(cronNext('0 9 * * *', at(2026, 9, 7, 9, 0))));
// U7 不可能日期：2 月 31 日 → 抛错（不死循环）
let threw = false;
try { cronNext('0 0 31 2 *', at(2026, 9, 7, 8, 0)); } catch (e) { threw = true; }
chk('U7 不可能日期抛错', threw, '未抛错');

// ---- HTTP 层 ----
const { execPath } = process;
const PORT = 21950 + (process.pid % 50);
const BASE = 'http://127.0.0.1:' + PORT;
const ROOT = path.join(__dirname, '..', '..');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c21-'));
  const child = spawn(execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      AI_PROVIDER: 'mock',
      FPB_DATA_DIR: dataDir,
      FPB_VAULT_FILE: path.join(dataDir, 'vault.json'),
      FPB_SETTINGS_FILE: path.join(dataDir, 'runtime_settings.json'),
      FPB_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      DEEPSEEK_API_KEY: '',
      OPENAI_API_KEY: '',
      AI_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (c) => logs.push(String(c)));
  child.stderr.on('data', (c) => logs.push(String(c)));

  try {
    let ready = false;
    for (let i = 0; i < 40; i++) {
      const r = await req('GET', '/api/settings');
      if (r.code === 200) { ready = true; break; }
      await new Promise((s) => setTimeout(s, 300));
    }
    if (!ready) { chk('H0 服务器启动', false, logs.join('').slice(-400)); throw new Error('server not ready'); }
    chk('H0 服务器启动', true, '');

    // H1 cron 创建（不带 intervalMs）→ 200 + cron 字段落库 + nextRunAt 在 15 分钟内
    const create = await req('POST', '/api/ai/schedules', {
      name: 'C21 cron 守护', objective: '打开首页确认可达',
      targetUrl: 'http://127.0.0.1:9/no-such-site', profileIds: [],
      cron: '*/15 * * * *', autoStart: false,
    });
    const sched = (JSON.parse(create.body) || {}).schedule;
    chk('H1 cron 创建 200 + nextRunAt<=15min', create.code === 200 && sched && sched.cron === '*/15 * * * *' &&
      sched.nextRunAt > Date.now() && sched.nextRunAt <= Date.now() + 15 * 60000 + 65000,
      create.body.slice(0, 250));

    // H2 非法 cron → 400
    const badCron = await req('POST', '/api/ai/schedules', {
      name: 'bad', objective: 'x', cron: '0 0 31 2 *', autoStart: false,
    });
    chk('H2 不可能日期 cron → 400', badCron.code === 400, badCron.code + ' ' + badCron.body.slice(0, 150));
    const badSyntax = await req('POST', '/api/ai/schedules', {
      name: 'bad2', objective: 'x', cron: '61 * * * * *', autoStart: false,
    });
    chk('H2b 域数错误 cron → 400', badSyntax.code === 400, badSyntax.code + ' ' + badSyntax.body.slice(0, 150));

    // H3 两者皆缺 → 400
    const neither = await req('POST', '/api/ai/schedules', { name: 'n', objective: 'x', autoStart: false });
    chk('H3 intervalMs 与 cron 皆缺 → 400', neither.code === 400, neither.code + ' ' + neither.body.slice(0, 150));

    // H4 PUT 变更 cron → 200 + cron/nextRunAt 更新（改为每天 9 点 → nextRunAt 在未来 24h 内）
    const upd = await req('PUT', '/api/ai/schedules/' + sched.id, { cron: '0 9 * * *' });
    const us = (JSON.parse(upd.body) || {}).schedule;
    chk('H4 PUT 变更 cron + nextRunAt 重算', upd.code === 200 && us && us.cron === '0 9 * * *' &&
      us.nextRunAt > Date.now() && us.nextRunAt <= Date.now() + 24 * 3600 * 1000 + 65000,
      upd.body.slice(0, 250));

    // H5 详情回读
    const one = await req('GET', '/api/ai/schedules/' + sched.id);
    const oj = (JSON.parse(one.body) || {}).schedule || {};
    chk('H5 详情回读 cron 字段', one.code === 200 && oj.cron === '0 9 * * *', one.body.slice(0, 200));
  } finally {
    child.kill();
  }

  console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
  if (failures.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
