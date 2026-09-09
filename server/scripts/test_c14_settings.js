'use strict';
// C14 守护测试 —— 运行时设置中心（server/settings.js）
// 断言语义（对齐项目纪律：断言真正会执行的那份东西——createProvider 真实解析、
// testLlm 走真实 HTTP stub 调用链，不 eval 源码）：
//  1. apiKey 落盘为密文（文件内搜不到明文）且 masked 绝不回明文；
//  2. applyToEnv 保存即生效（process.env.DEEPSEEK_API_KEY 被覆盖 → provider 解析为 deepseek）；
//  3. 清除语义：清除后仅回收本模块写入的 env 值，进程原有 .env 注入值不被误删；
//  4. testLlm 双路径：stub 200 → ok:true；401 → ok:false + HTTP_401（无网络依赖）；
//  5. 白名单外字段拒绝写入（防任意 JSON 注入落盘）。
// 运行：node server/scripts/test_c14_settings.js

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pass = [];
const fail = [];
async function t(name, fn) {
  try { await fn(); pass.push(name); console.log('  PASS', name); }
  catch (e) { fail.push(name); console.error('  FAIL', name, '->', e.message); }
}

// 测试隔离：settings 与 vault 均落 os.tmpdir；主密钥用固定 32 字节保证可解密回读。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c14-'));
process.env.FPB_SETTINGS_FILE = path.join(tmpDir, 'runtime_settings.json');
process.env.FPB_VAULT_FILE = path.join(tmpDir, 'vault.json');
process.env.FPB_MASTER_KEY = Buffer.from('c'.repeat(32), 'utf8').toString('base64'); // 恰好 32 字节
delete process.env.DEEPSEEK_API_KEY;

const settings = require('../settings');
const vault = require('../vault');
const provider = require('../agent/llm/provider.js');

const KEY = 'sk-c14testkey1234567890abcdef';

(async () => {
  await t('A1 保存 apiKey → 落盘文件不含明文，masked 只回 last4', async () => {
    const masked = settings.updateSettings({ apiKey: KEY });
    assert.strictEqual(masked.llm.apiKey.set, true);
    assert.ok(masked.llm.apiKey.masked.includes('cdef'), 'masked 应含 last4: ' + masked.llm.apiKey.masked);
    assert.ok(!masked.llm.apiKey.masked.includes(KEY), 'masked 绝不等于明文');
    const raw = fs.readFileSync(settings.SETTINGS_FILE, 'utf8');
    assert.ok(!raw.includes(KEY), '落盘文件不得含明文 key');
    assert.ok(raw.includes('"apiKey"'), '落盘文件应含 apiKey 密文字段');
  });

  await t('A2 applyToEnv 保存即生效：env 被覆盖，provider 真实解析为 deepseek', async () => {
    assert.strictEqual(process.env.DEEPSEEK_API_KEY, KEY, 'env 应被 settings 覆盖');
    require('../agent/llm/providers/deepseek.js'); // 与生产加载路径一致：触发 register('deepseek', ...)
    const p = provider.createProvider('auto');
    assert.strictEqual(p.kind, 'deepseek', 'resolveKind 应命中 deepseek，实际: ' + p.kind);
  });

  await t('A3 清除语义：清除后回收本模块写入的 env；原有 .env 注入不被误删', async () => {
    settings.updateSettings({ apiKey: null });
    assert.strictEqual(process.env.DEEPSEEK_API_KEY, undefined, '本模块写入的值应被回收');
    // 模拟 .env 注入的原生值（非本模块写入）→ settings 为空时不得删除
    process.env.DEEPSEEK_API_KEY = 'sk-from-env-file';
    settings.applyToEnv();
    assert.strictEqual(process.env.DEEPSEEK_API_KEY, 'sk-from-env-file', 'settings 为空时不得回收进程原有值');
    delete process.env.DEEPSEEK_API_KEY;
  });

  await t('A4 testLlm stub 200 → ok:true（真实 HTTP 链路，携带 Bearer key + 1-token 探测）', async () => {
    const received = {};
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.auth = req.headers.authorization || '';
        received.body = body;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { total_tokens: 1 } }));
      });
    });
    await require('./lib_safe_port').listenSafe(server, '127.0.0.1');
    const port = server.address().port;
    try {
      settings.updateSettings({ baseUrl: `http://127.0.0.1:${port}`, model: 'stub-model', apiKey: KEY });
      const r = await settings.testLlm({});
      assert.strictEqual(r.ok, true, '应 ok: ' + JSON.stringify(r));
      assert.strictEqual(r.model, 'stub-model');
      assert.strictEqual(received.auth, 'Bearer ' + KEY, '应携带 Bearer key');
      assert.ok(received.body.includes('"max_tokens":1'), '应是最小 1-token 探测请求');
      assert.ok(!JSON.stringify(r).includes(KEY), 'testLlm 结果绝不回传 key');
    } finally {
      server.close();
      settings.updateSettings({ baseUrl: null, model: null, apiKey: null });
    }
  });

  await t('A5 testLlm 401 → ok:false + HTTP_401，异常不冒泡成 500', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Authentication Fails' }));
    });
    await require('./lib_safe_port').listenSafe(server, '127.0.0.1');
    const port = server.address().port;
    try {
      settings.updateSettings({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-wrong' });
      const r = await settings.testLlm({});
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.error, 'HTTP_401');
    } finally {
      server.close();
      settings.updateSettings({ baseUrl: null, apiKey: null });
    }
  });

  await t('A6 白名单外字段拒绝写入（防任意 JSON 注入落盘）', async () => {
    assert.throws(() => settings.updateSettings({ evil: '<script>' }), /未知设置字段/);
    const raw = fs.readFileSync(settings.SETTINGS_FILE, 'utf8');
    assert.ok(!raw.includes('evil'), '注入字段不得落盘');
  });

  await t('A7 vault 主密钥真实可用（测试自身健康检查）', async () => {
    const enc = vault.encrypt('hello-c14');
    assert.strictEqual(vault.decrypt(enc), 'hello-c14');
  });

  console.log(`\nRESULT: PASS=${pass.length} FAIL=${fail.length}`);
  if (fail.length) { console.error('FAILED:', fail.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
