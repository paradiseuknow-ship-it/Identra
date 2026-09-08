#!/usr/bin/env node
// C67 —— endpoint×UI 全量对账守护（把 C22-C35 时代的「每批先跑全量路由 grep 差集」
// 复核教训固化为永久测试）：
//   方向 A（硬断言）：client 消费的每个端点必须在 server 存在 —— 防「server 改路由/删路由
//     导致前端静默 404」（这正是 C35 复核教训的根源形态）。
//   方向 B（硬断言）：browser human-* / evaluate / navigate / screenshot 必须被 client 消费
//     —— C67 前这组端点零 UI 消费（human-* 家族连 api.js 导出都没有，且 BrowserViewer
//     内联裸 fetch 不带 Bearer token，C49 多用户部署下 401）。
//   方向 C（信息性）：server 有 / client 未消费 —— 大部分是刻意的 legacy 别名/冗余端点
//     （/ai/queue、/ai/events、/observability/metrics 等，见 MEMORY），只报告数量不失败。
// 纯静态分析，零浏览器零网络零服务器。
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; failures.push(name + ': ' + detail); console.log('  FAIL ' + name + ' — ' + detail); }
}

// ---------- server 侧提取 ----------
// 挂载前缀：index.js 内联 router 挂 /api（路径原样）；agent/index.js 挂 /api/ai；
// identity.js 挂 /api/auth；agent/scheduleTrigger.js 挂 /api/ai/schedules。
const serverFiles = [
  { f: 'server/index.js', prefix: '' },
  { f: 'server/agent/index.js', prefix: '/ai' },
  { f: 'server/identity.js', prefix: '/auth' },
  { f: 'server/agent/scheduleTrigger.js', prefix: '/ai/schedules' },
];
const server = [];
for (const { f, prefix } of serverFiles) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const re = /\b\w*[Rr]outer\w*\.(get|post|put|delete|patch)\('([^']*)'/g;
  let m;
  while ((m = re.exec(src))) {
    let p = prefix + m[2];
    p = p.replace(/\/+/g, '/').replace(/\/+$/, '') || '/'; // 双斜杠 + 尾斜杠等价
    if (p === '*') continue; // SPA catch-all
    server.push({ m: m[1].toUpperCase(), p });
  }
}

// ---------- client 侧提取 ----------
const client = [];
function addClient(method, rawUrl) {
  let p = String(rawUrl).split('?')[0];           // 去 query
  p = p.replace(/^\/api/, '');                     // client 以 /api 为 BASE
  p = p.replace(/\/+/g, '/');
  // ':p' 必须出现在段首（前驱是 '/'）；否则是 query 拼接伪影（'...report' + '?site='+x）
  // → 从该处截断（query 不参与路由匹配）
  const bad = p.search(/([^/]):/);
  if (bad !== -1) p = p.slice(0, bad + 1);
  p = p.replace(/\/+$/, '') || '/';                // 尾斜杠等价（scheduleTrigger 路由路径 '/'）
  if (!p || p === '/') return;
  client.push({ m: method.toUpperCase(), p });
}

// api.js：req('METHOD', expr) —— 字符串拼接里非字面量段归一为 :p
{
  const src = fs.readFileSync(path.join(ROOT, 'client/src/api.js'), 'utf8');
  const re = /req\(\s*'(GET|POST|PUT|DELETE|PATCH)'\s*,\s*([^)]+?)[,)]/g;
  let m;
  while ((m = re.exec(src))) {
    const parts = m[2].trim().split('+').map((s) => s.trim());
    let url = '';
    for (const part of parts) {
      const lit = part.match(/^'(.*)'$/);
      url += lit ? lit[1] : ':p';
    }
    addClient(m[1], url);
  }
}

// 组件层：fetch(`...`) / EventSource(`...`) —— ${...} 归一为 :p；fetch 缺省 GET
{
  const dir = path.join(ROOT, 'client/src');
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const fp = path.join(d, name);
      const st = fs.statSync(fp);
      if (st.isDirectory()) { walk(fp); continue; }
      if (!/\.(jsx|js|mjs)$/.test(name) || fp.replace(/\\/g, '/').endsWith('client/src/api.js')) continue;
      const src = fs.readFileSync(fp, 'utf8');
      const re = /\b(fetch|EventSource)\(\s*`([^`]+)`/g;
      let m;
      while ((m = re.exec(src))) {
        const url = m[2].replace(/\$\{[^}]*\}/g, ':p');
        let method = 'GET';
        if (m[1] === 'fetch') {
          const tail = src.slice(m.index, m.index + 300);
          const mm = tail.match(/method:\s*'(\w+)'/);
          if (mm) method = mm[1];
        }
        addClient(method, url);
      }
    }
  };
  walk(dir);
}

// ---------- 匹配 ----------
const pat = (p) => p.replace(/:[^/]*/g, '[^/]+');
function hit(list, e) {
  // 双向匹配：server 模式 → client 路径（常规），client 模式 → server 路径
  // （client 动态段如 '/ai/execution/scheduler/' + action 对应 server 的 start/stop/... 静态路由）
  return list.some((x) => x.m === e.m
    && (new RegExp('^' + pat(x.p) + '$').test(e.p) || new RegExp('^' + pat(e.p) + '$').test(x.p)));
}
const uniq = (arr) => arr.filter((x, i) => !arr.some((y, j) => j < i && x.m === y.m && x.p === y.p));
const srvU = uniq(server);
const cliU = uniq(client);

console.log('server routes: ' + srvU.length + '   client endpoints: ' + cliU.length);

// 方向 A：client 调 / server 缺失 = 0
const missing = cliU.filter((c) => !hit(srvU, c));
chk('A.no-missing-client-endpoints', missing.length === 0,
  'client calls without server route: ' + JSON.stringify(missing));

// 方向 B：browser 操作族必须被 client 消费（C67 前零消费 + 裸 fetch 无 token）
const mustConsume = [
  'POST /browser/:p/navigate',
  'GET /browser/:p/screenshot',
  'POST /browser/:p/human-move',
  'POST /browser/:p/human-click',
  'POST /browser/:p/human-type',
  'POST /browser/:p/human-scroll',
  'POST /browser/:p/human-google-search',
  'POST /browser/:p/evaluate',
];
for (const spec of mustConsume) {
  const [m, p] = spec.split(' ');
  chk('B.consumes.' + p, hit(cliU, { m, p }), 'endpoint not consumed by any UI');
}

// 方向 C：信息性 —— server 有 / client 未消费
const notConsumed = srvU.filter((s) => !hit(cliU, s));
console.log('INFO server-not-consumed: ' + notConsumed.length + ' (legacy aliases / redundant endpoints, see MEMORY)');
if (process.argv.includes('-v')) notConsumed.forEach((x) => console.log('  ' + x.m.padEnd(7) + ' ' + x.p));

console.log('\n==== C67 RESULT: ' + pass + ' pass / ' + fail + ' fail ====');
if (failures.length) failures.forEach((f) => console.log('  FAILED: ' + f));
process.exit(fail ? 1 : 0);
