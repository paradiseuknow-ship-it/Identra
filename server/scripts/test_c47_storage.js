'use strict';
// C47 守护测试 —— 存储使用与清理治理（tmp 隔离 + 真实服务器契约）。
// 缺陷背景：data/profiles（Chromium 用户数据，GB 级）与 .benchmark（157MB+）无可见性无清理路径。
// 修复：systemStorage（collectStats 统计缓存 + 白名单 cleanup，dryRun 默认 true，防路径逃逸）。
// 覆盖：
//   P1 dirSize/collectStats：tmp 结构体积与文件数正确
//   P2 cleanup benchmarkLogs：dryRun 只列不删；实删时保留最近 keepRecent 个 log 与 *.md 报告
//   P3 防路径逃逸：insideRoot 拒绝项目根外路径
//   P4 未知 target 拒绝（400 语义）
//   P5 真实服务器契约：GET /api/system/storage 结构；cleanup 缺省 dryRun=true 不删任何东西
//   P6 前端接线契约：api.js 两方法 + SettingsPanel StorageView 挂载（无 window.confirm）

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

(async () => {
  const ss = require(path.join(ROOT, 'server', 'systemStorage.js'));

  // P1：tmp 结构统计
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c47-'));
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'x'.repeat(100));
    fs.mkdirSync(path.join(tmp, 'sub'));
    fs.writeFileSync(path.join(tmp, 'sub', 'b.bin'), 'y'.repeat(50));
    const st = await ss.dirSize(tmp);
    chk('P1 dirSize 递归统计（体积/文件数）', st.bytes === 150 && st.files === 2 && !st.truncated,
      'st=' + JSON.stringify(st));
  }

  // P2：benchmarkLogs 清理语义 —— 全部在 tmp 隔离目录验证（不消耗宿主 safe-delete 50/turn 配额；
  //     在真实 .benchmark 上实删会撞 SAFE_DELETE_BULK_CONFIRM_REQUIRED，回归环境已实证 FATAL）
  {
    const bench = fs.mkdtempSync(path.join(os.tmpdir(), 'c47-bench-'));
    // 布景：3 个新 log（保留）+ 2 个 30 天前旧 log（应删）+ 1 个旧 md 报告（永不删）
    const mk = (name, size, ageDays) => {
      const f = path.join(bench, name);
      fs.writeFileSync(f, 'x'.repeat(size));
      if (ageDays != null) {
        const t = new Date(Date.now() - ageDays * 24 * 3600 * 1000);
        fs.utimesSync(f, t, t);
      }
      return f;
    };
    mk('phase9_regression_new1.txt', 100);
    mk('run_new2.log', 100);
    mk('run_new3.log', 100);
    mk('run_old4.log', 2048, 30);
    mk('phase9_regression_old5.txt', 2048, 30);
    const md = mk('C47_REPORT.md', 100, 30); // 旧 md：规则上永不删

    // dryRun：列出候选但不删
    const r1 = await ss.cleanup({ targets: ['benchmarkLogs'], olderThanDays: 7, keepRecent: 3, dryRun: true, benchDir: bench });
    chk('P2a dryRun 列出 2 个旧 log 且不删除（freed 预估 4096）',
      r1.ok && r1.dryRun === true && r1.count === 2 && r1.freed === 4096
        && fs.existsSync(path.join(bench, 'run_old4.log')),
      'r1=' + JSON.stringify({ count: r1.count, freed: r1.freed }));

    // 实删：旧 log 删除；最近 3 个 log 与 *.md 保留
    const r2 = await ss.cleanup({ targets: ['benchmarkLogs'], olderThanDays: 7, keepRecent: 3, dryRun: false, benchDir: bench });
    chk('P2b 实删：旧 log 删除、最近 3 log 保留、*.md 永不删',
      r2.count === 2 && r2.freed === 4096
        && !fs.existsSync(path.join(bench, 'run_old4.log'))
        && !fs.existsSync(path.join(bench, 'phase9_regression_old5.txt'))
        && fs.existsSync(md)
        && fs.existsSync(path.join(bench, 'phase9_regression_new1.txt'))
        && fs.existsSync(path.join(bench, 'run_new2.log'))
        && fs.existsSync(path.join(bench, 'run_new3.log')),
      'r2=' + JSON.stringify({ count: r2.count, freed: r2.freed }));

    // browserProfiles：注入目录 + isRunning 排除运行中
    const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'c47-prof-'));
    fs.mkdirSync(path.join(prof, 'p_stopped')); fs.writeFileSync(path.join(prof, 'p_stopped', 'Cookies'), 'c'.repeat(500));
    fs.mkdirSync(path.join(prof, 'p_running')); fs.writeFileSync(path.join(prof, 'p_running', 'Cookies'), 'c'.repeat(500));
    const r3 = await ss.cleanup({
      targets: ['browserProfiles'], dryRun: false, profilesDir: prof,
      isRunning: (id) => id === 'p_running',
    });
    chk('P2d browserProfiles：未运行 profile 删除、运行中保留',
      r3.count === 1 && !fs.existsSync(path.join(prof, 'p_stopped')) && fs.existsSync(path.join(prof, 'p_running')),
      'r3=' + JSON.stringify({ count: r3.count }));
  }

  // P3：防逃逸
  chk('P3 insideRoot 拒绝项目根外路径',
    ss.insideRoot(path.join(ROOT, 'data', 'x')) === true
      && ss.insideRoot(path.join(os.tmpdir(), 'elsewhere')) === false
      && ss.insideRoot(ROOT + path.sep + '..' + path.sep + 'escape') === false,
    '逃逸判定错误');

  // P4：未知 target
  {
    const r = await ss.cleanup({ targets: ['notATarget'], dryRun: true });
    chk('P4 未知清理目标拒绝（400 语义）', r.ok === false && /未知清理目标/.test(r.error), 'r=' + JSON.stringify(r));
  }

  // P5：真实服务器契约
  try {
    const { spawn } = require('child_process');
    const PORT = 22750 + (process.pid % 50);
    const srvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c47-srv-'));
    const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      env: {
        ...process.env, PORT: String(PORT), AI_PROVIDER: 'mock',
        FPB_DATA_DIR: srvDir,
        FPB_VAULT_FILE: path.join(srvDir, 'vault.json'),
        FPB_SETTINGS_FILE: path.join(srvDir, 'runtime_settings.json'),
        FPB_MASTER_KEY: Buffer.alloc(32, 15).toString('base64'),
        DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', AI_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/api/browser/status`); if (r.ok) ready = true; } catch { /* not yet */ }
      if (!ready) await sleep(250);
    }
    if (!ready) throw new Error('server not ready');

    const sr = await fetch(`http://127.0.0.1:${PORT}/api/system/storage`);
    const sj = await sr.json();
    chk('P5a GET /system/storage 返回 4 类统计（benchmark/profiles/collections/dist）',
      sr.status === 200 && sj.ok && Array.isArray(sj.items) && sj.items.length === 4
        && sj.items.every((it) => typeof it.bytes === 'number' && typeof it.files === 'number'),
      'items=' + JSON.stringify(sj.items && sj.items.map((i) => i.key)));

    const cr = await fetch(`http://127.0.0.1:${PORT}/api/system/storage/cleanup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets: ['benchmarkLogs'] }),
    });
    const cj = await cr.json();
    chk('P5b cleanup 缺省 dryRun=true（不传 dryRun 不删任何东西）',
      cr.status === 200 && cj.ok && cj.dryRun === true,
      'dryRun=' + cj.dryRun);
    child.kill();
  } catch (e) {
    chk('P5 真实服务器契约', false, e.message);
  }

  // P6：前端接线契约
  {
    const api = read('client/src/api.js');
    const sp = read('client/src/components/SettingsPanel.jsx');
    // StorageView 函数体作用域内不得用原生 confirm（既有 restore 流程的原生 confirm 是 C48 候选，不在本批断言范围）
    const svMatch = sp.match(/function StorageView\({ notify }\) \{[\s\S]*?\n\}/);
    const svClean = svMatch ? !svMatch[0].includes('window.confirm') : false;
    const wired = api.includes("storageStats: () => req('GET', '/system/storage')")
      && api.includes("storageCleanup: (b) => req('POST', '/system/storage/cleanup', b)")
      && sp.includes('<StorageView notify={notify} />')
      && sp.includes('dryRun: true')
      && svClean;
    chk('P6 前端接线：api 两方法 + StorageView 挂载 + dry-run 预览 + 无原生 confirm',
      wired, 'wired=' + wired);
  }

  console.log('\nRESULT: pass=' + pass + ' fail=' + fail);
  if (fail > 0) { console.log('FAILURES:\n- ' + failures.join('\n- ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
