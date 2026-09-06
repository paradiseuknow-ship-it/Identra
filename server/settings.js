'use strict';

// C14: 运行时设置中心（Settings）。
// 目标：API key / LLM 配置不再依赖手工编辑 .env —— UI 可保存、可清除、可连通测试、可对账。
//
// 语义边界：
// - apiKey 仅以密文落盘（复用 vault.encrypt，AES-256-GCM / FPB_MASTER_KEY），GET 永不回明文。
// - 生效机制 = applyToEnv()：把设置写入 process.env（deepseek.js/provider.js 在调用时读
//   process.env，天然兼容，零侵入 LLM 层）。保存即生效，无需重启。
// - 覆盖语义：settings 中「已设置」的字段覆盖 .env；「未设置/清除」则让位给 .env。
//   清除时只回收本模块自己写入的 env 值，绝不误删进程原有的 .env 注入值。
// - 测试隔离：FPB_SETTINGS_FILE 把落盘指到 os.tmpdir，生产默认路径不变。

const fs = require('fs');
const path = require('path');
const vault = require('./vault');

const SETTINGS_FILE = process.env.FPB_SETTINGS_FILE
  ? path.resolve(process.env.FPB_SETTINGS_FILE)
  : path.join(__dirname, '..', 'data', 'runtime_settings.json');

// 受管字段白名单：env 名 → settings 内的字段
const MANAGED_FIELDS = [
  { env: 'AI_PROVIDER', field: 'provider', secret: false },
  { env: 'DEEPSEEK_API_KEY', field: 'apiKey', secret: true },
  { env: 'DEEPSEEK_BASE_URL', field: 'baseUrl', secret: false },
  { env: 'DEEPSEEK_MODEL', field: 'model', secret: false },
];

// 只读对账清单（UI 展示当前进程实际值/是否设置，不可写）
const READONLY_ENV_FIELDS = [
  'FPB_TASK_DEADLINE',
  'FPB_REPAIR_TIMEOUT_MS',
  'DEEPSEEK_PLAN_MAX_TOKENS',
  'FPB_API_TOKEN',
  'FPB_MASTER_KEY',
  'FPB_POOL_FILE',
  'FPB_SCENARIO_DIR',
];

function readAll() {
  if (!fs.existsSync(SETTINGS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {};
  } catch (e) {
    return {};
  }
}

function writeAll(obj) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  const data = JSON.stringify(obj, null, 2);
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      const tmp = SETTINGS_FILE + '.tmp';
      fs.writeFileSync(tmp, data, 'utf8');
      fs.renameSync(tmp, SETTINGS_FILE);
      return;
    } catch (e) {
      lastErr = e;
      if (e.code === 'EPERM' || e.code === 'EBUSY') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80 * (i + 1)); continue; }
      throw e;
    }
  }
  throw lastErr;
}

// 本模块写入过的 env 值（用于清除时只回收自己的覆盖，不碰 .env 注入）
const appliedByUs = new Set();

function applyToEnv() {
  const all = readAll();
  const llm = all.llm || {};
  for (const mf of MANAGED_FIELDS) {
    const key = 'llm.' + mf.field;
    let val = null;
    if (Object.prototype.hasOwnProperty.call(llm, mf.field) && llm[mf.field] != null && llm[mf.field] !== '') {
      val = mf.secret ? safeDecrypt(llm[mf.field]) : String(llm[mf.field]);
    }
    if (val != null && val !== '') {
      process.env[mf.env] = val;
      appliedByUs.add(mf.env);
    } else if (appliedByUs.has(mf.env)) {
      // 仅回收本模块写入的覆盖
      delete process.env[mf.env];
      appliedByUs.delete(mf.env);
    }
  }
}

function safeDecrypt(b64) {
  try {
    return vault.decrypt(b64);
  } catch (e) {
    return null; // 解密失败 = 视同未设置（fail-soft；与 vault 展示面语义一致）
  }
}

// 脱敏视图（绝不回明文）
function getMasked() {
  const all = readAll();
  const llm = all.llm || {};
  const out = { llm: {}, env: getEnvAudit(), updatedAt: all.updatedAt || null };
  for (const mf of MANAGED_FIELDS) {
    let set = false;
    let masked = null;
    if (Object.prototype.hasOwnProperty.call(llm, mf.field) && llm[mf.field] != null && llm[mf.field] !== '') {
      set = true;
      if (mf.secret) {
        const plain = safeDecrypt(llm[mf.field]);
        masked = plain ? maskSecret(plain) : null;
      } else {
        masked = String(llm[mf.field]);
      }
    }
    out.llm[mf.field] = { set, masked, secret: mf.secret, env: mf.env };
  }
  return out;
}

function maskSecret(v) {
  if (!v) return null;
  return v.length <= 8 ? '****' : v.slice(0, 3) + '****' + v.slice(-4);
}

// env 对账：.env/进程注入值 vs settings 覆盖 → 实际生效值
function getEnvAudit() {
  const all = readAll();
  const llm = all.llm || {};
  const rows = [];
  for (const mf of MANAGED_FIELDS) {
    const fromSettings = Object.prototype.hasOwnProperty.call(llm, mf.field) && llm[mf.field] != null && llm[mf.field] !== '';
    const envSet = process.env[mf.env] != null && process.env[mf.env] !== '';
    const effective = envSet ? process.env[mf.env] : '';
    rows.push({
      env: mf.env,
      fromSettings,
      fromEnv: envSet && !fromSettings,
      overriddenBySettings: fromSettings && appliedByUs.has(mf.env),
      effectiveMasked: mf.secret ? (effective ? maskSecret(effective) : null) : effective || null,
      writable: true,
    });
  }
  for (const name of READONLY_ENV_FIELDS) {
    const v = process.env[name];
    rows.push({
      env: name,
      fromSettings: false,
      fromEnv: !!(v != null && v !== ''),
      overriddenBySettings: false,
      effectiveMasked: /TOKEN|KEY/.test(name) ? (v ? '****' : null) : v || null,
      writable: false,
    });
  }
  return rows;
}

// 更新设置。patch 形如 { apiKey: 'sk-...' | null, model: '...', baseUrl: '...', provider: '...' }
// - 字段 = undefined → 不动
// - 字段 = null / '' → 清除（让位 .env）
// - apiKey: null 清除密文；apiKey 字符串非空则加密落盘
function updateSettings(patch) {
  if (!patch || typeof patch !== 'object') throw new Error('invalid settings patch');
  const all = readAll();
  const llm = { ...(all.llm || {}) };

  for (const mf of MANAGED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, mf.field)) continue;
    const v = patch[mf.field];
    if (v === undefined) continue;
    if (v === null || v === '') {
      delete llm[mf.field];
    } else if (mf.secret) {
      if (typeof v !== 'string') throw new Error(mf.field + ' 必须是字符串');
      llm[mf.field] = vault.encrypt(v); // 主密钥缺失时 fail-closed 抛错（凭据语义）
    } else {
      if (typeof v !== 'string') throw new Error(mf.field + ' 必须是字符串');
      llm[mf.field] = v.trim();
    }
  }
  // 白名单外字段一律拒绝写入（防任意 JSON 注入落盘）
  const allowed = new Set(MANAGED_FIELDS.map((m) => m.field));
  for (const k of Object.keys(patch)) {
    if (!allowed.has(k)) throw new Error('未知设置字段: ' + k);
  }

  all.llm = llm;
  all.updatedAt = new Date().toISOString();
  writeAll(all);
  applyToEnv();
  return getMasked();
}

// LLM 连通测试：用当前生效配置（或显式传入 baseUrl/model）发一次 1-token 请求。
// 返回 { ok, latencyMs, model, error }。绝不回传 key，也绝不让异常冒泡成 500。
async function testLlm(override = {}) {
  const all = readAll();
  const llm = all.llm || {};
  const get = (field, envName) => {
    if (override[field] != null && override[field] !== '') return override[field];
    if (llm[field] != null && llm[field] !== '') return field === 'apiKey' ? safeDecrypt(llm[field]) : llm[field];
    return process.env[envName] || '';
  };
  const baseUrl = String(get('baseUrl', 'DEEPSEEK_BASE_URL') || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = get('model', 'DEEPSEEK_MODEL') || 'deepseek-chat';
  const apiKey = get('apiKey', 'DEEPSEEK_API_KEY');

  if (!apiKey) return { ok: false, error: 'NO_API_KEY', message: '未配置 API key（settings 与环境变量均为空）', model, baseUrl };

  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(process.env.FPB_SETTINGS_TEST_TIMEOUT_MS || 10000));
    const resp = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const latencyMs = Date.now() - start;
    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => '');
      return { ok: false, status: resp.status, latencyMs, model, baseUrl, error: 'HTTP_' + resp.status, message: bodyText.slice(0, 200) };
    }
    return { ok: true, latencyMs, model, baseUrl };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - start, model, baseUrl, error: e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR', message: String(e.message || e).slice(0, 200) };
  }
}

module.exports = { getMasked, updateSettings, applyToEnv, testLlm, getEnvAudit, SETTINGS_FILE, MANAGED_FIELDS };
