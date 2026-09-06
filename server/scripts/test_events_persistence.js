'use strict';
// 取证扩容测试：FPB_EVENTS_DIR 按任务 JSONL 落盘（events.js persistPerTask）。
// 验证：门控开关 / 按 taskId 分文件 / 无 taskId 归 _global / 增量追加 / 主链路不受落盘失败影响。

const fs = require('fs');
const os = require('os');
const path = require('path');

const events = require('../agent/events');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, detail == null ? '' : JSON.stringify(detail)); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb_events_'));

// 未设置 FPB_EVENTS_DIR：不落盘（零默认行为）
const before = fs.readdirSync(tmp);
events.emit({ type: 'task.created', taskId: 't_none', payload: {} });
check('gated off: no files written', fs.readdirSync(tmp).length === before.length);

// 开启门控：按 taskId 分文件 + 增量追加
process.env.FPB_EVENTS_DIR = tmp;
const e1 = events.emit({ type: 'task.created', taskId: 'task_a', payload: { x: 1 } });
const e2 = events.emit({ type: 'task.started', taskId: 'task_a', payload: { y: 2 } });
const e3 = events.emit({ type: 'task.started', taskId: 'task_b', payload: {} });
const e4 = events.emit({ type: 'scheduler.started', payload: {} }); // 无 taskId

const files = fs.readdirSync(tmp).sort();
check('per-task files created', JSON.stringify(files) === JSON.stringify(['_global.jsonl', 'task_a.jsonl', 'task_b.jsonl']), files);

const a = fs.readFileSync(path.join(tmp, 'task_a.jsonl'), 'utf8').trim().split('\n');
check('task_a two lines append-only', a.length === 2 && JSON.parse(a[0]).type === 'task.created' && JSON.parse(a[1]).type === 'task.started');
check('task_a line format matches emitted event', JSON.parse(a[0]).eventId === e1.eventId && JSON.parse(a[0]).timestamp === e1.timestamp);

const g = fs.readFileSync(path.join(tmp, '_global.jsonl'), 'utf8').trim().split('\n');
check('no-taskId goes to _global', g.length === 1 && JSON.parse(g[0]).type === 'scheduler.started');

const b = fs.readFileSync(path.join(tmp, 'task_b.jsonl'), 'utf8').trim().split('\n');
check('task_b isolated', b.length === 1 && JSON.parse(b[0]).eventId === e3.eventId);

// 特殊字符 taskId 消毒（防路径注入）
events.emit({ type: 'task.created', taskId: 'we/ird ..id', payload: {} });
const files2 = fs.readdirSync(tmp);
check('taskId sanitized', files2.every((f) => !f.includes('/') && !f.includes('..')), files2);

// 主链路不受影响：emit 返回事件对象（SSE/存储链路照常）
check('emit returns normalized event', !!(e1 && e1.eventId && e1.timestamp && typeof e1.type === 'string'));

// 清理
delete process.env.FPB_EVENTS_DIR;
fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n== events persistence ==');
console.log('PASS=' + pass, 'FAIL=' + fail);
process.exit(fail ? 1 : 0);
