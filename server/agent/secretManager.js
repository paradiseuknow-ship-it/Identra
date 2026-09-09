'use strict';

// Secret Manager：凭据引用抽象（兼容 credentialRef 命名）。
// AI Context 只能看到 { id, type, available, site, masked* }。
// 明文只存于 vault.js（按 profileId 加密）。此处只是"引用注册表 + 脱敏视图"。
// 未来扩展 type: email_password / api_key / payment / oauth_token / cookie / license / ssh_key。

const store = require('./store');
const vault = require('../vault');

const SECRET_TYPES = ['email_password', 'api_key', 'payment', 'oauth_token', 'cookie', 'license', 'ssh_key', 'other'];

function createSecret({ profileId, type, site, label, workspaceId, createdBy }) {
  if (!SECRET_TYPES.includes(type)) type = 'other';
  const id = 'cred_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const rec = {
    id,
    type,
    profileId,
    site: site || null,
    label: label || null,
    available: false,      // 经校验 vault 有对应凭据后置 true
    createdAt: Date.now(),
    // STEP 22 (I1)：归属盖章 —— workspaceId/createdBy 由服务端身份层传入（agent/index.js 路由），
    // 调用方 body 中的 workspaceId 一律忽略，绝不落库。
    workspaceId: workspaceId || null,
    createdBy: createdBy || null,
  };
  store.insert('aiCredentials', rec);
  refreshAvailability(rec);
  return store.find('aiCredentials', id);
}

function refreshAvailability(rec) {
  try {
    const s = vault.getProfileSecrets(rec.profileId);
    if (rec.type === 'email_password') rec.available = !!(s && (s.email || s.password));
    else if (rec.type === 'payment') rec.available = !!(s && s.card && s.card.number);
    else rec.available = !!s;
  } catch (e) {
    rec.available = false;
  }
  store.upsert('aiCredentials', rec);
}

// AI 可见的脱敏视图（绝不含明文）
// C35 缺陷修复（A 类）：available 此前只在 createSecret/getByRef 时 refreshAvailability，
// 「先注册引用、后补录明文」的时序下列表与 Planner prompt 永远显示 available=false，
// 误导用户 + 模型在 prompt 层看到凭据不可用而放弃规划。此处改为每次从 vault 只读现算
//（不写库；写语义仍归 refreshAvailability，由 getByRef/createSecret 驱动）。
function computeAvailable(rec) {
  try {
    const s = vault.getProfileSecrets(rec.profileId);
    if (rec.type === 'email_password') return !!(s && (s.email || s.password));
    if (rec.type === 'payment') return !!(s && s.card && s.card.number);
    return !!s;
  } catch (e) {
    return false;
  }
}

function maskedView(rec) {
  if (!rec) return null;
  let maskedEmail = null;
  let maskedCard = null;
  try {
    const s = vault.getProfileSecrets(rec.profileId);
    if (s && s.email) maskedEmail = s.email.replace(/^(.).*(@.*)$/, '$1***$2');
    if (s && s.card && s.card.number) maskedCard = '****' + String(s.card.number).slice(-4);
  } catch (e) {}
  return {
    id: rec.id,
    type: rec.type,
    site: rec.site,
    label: rec.label,
    available: computeAvailable(rec),
    workspaceId: rec.workspaceId || null,
    maskedEmail,
    maskedCard,
  };
}

function getByRef(ref) {
  const rec = store.find('aiCredentials', ref);
  if (!rec) return null;
  refreshAvailability(rec);
  return rec;
}

// 供执行层解析：返回 { profileId, type, secrets? } —— secrets 由调用方即时解密，不落日志
function resolve(ref) {
  const rec = getByRef(ref);
  if (!rec || !rec.available) return null;
  let secrets = null;
  try { secrets = vault.getProfileSecrets(rec.profileId); } catch (e) { secrets = null; }
  if (!secrets) return null;
  return { profileId: rec.profileId, type: rec.type, secrets };
}

function listMasked() {
  return store.read('aiCredentials', []).map((r) => maskedView(r));
}

// STEP 22 (I1)：原始记录（含归属字段），供路由层做 workspace 过滤后再脱敏输出
function listRecords() {
  return store.read('aiCredentials', []);
}

function remove(ref) {
  store.remove('aiCredentials', ref);
}

// C99：vault→credentialRef 自动接线（B 类 wiring gap）。
// 此前 ProfileEditor 保存 vault 凭据后没有任何路径注册 cred_ 引用 —— planner 的
// 可用凭据清单恒为空 → 敏感字段门确定性拒绝 → needsCredentials 恒成立，
// 「用户已配置凭据」的产品承诺在规划链路上断裂（e2e 实证：12:59/13:07/13:28 三次
// 同型失败）。此处在任务创建前按 profileId 幂等补注册：email/password → email_password，
// card.number → payment。引用不含明文，available 仍由 vault 现算（computeAvailable）。
function ensureProfileRefs(profileId, site, stamp) {
  if (!profileId) return [];
  const refs = [];
  try {
    const s = vault.getProfileSecrets(profileId);
    if (!s) return [];
    const want = [];
    if (s.email || s.password) want.push('email_password');
    if (s.card && s.card.number) want.push('payment');
    for (const type of want) {
      const existing = store.read('aiCredentials', []).find((r) => r.profileId === profileId && r.type === type);
      const rec = existing || createSecret({
        profileId,
        type,
        site: site || null,
        label: type === 'payment' ? '环境支付凭据（自动注册）' : '环境登录凭据（自动注册）',
        workspaceId: stamp && stamp.workspaceId,
        createdBy: stamp && stamp.createdBy,
      });
      refs.push(rec.id);
    }
  } catch (e) {
    return []; // vault 锁定/IO 失败 → 回退为无自动引用（不阻断规划，门禁语义不变）
  }
  return refs;
}

module.exports = { createSecret, getByRef, resolve, listMasked, listRecords, remove, ensureProfileRefs, maskedView, recordUsage, SECRET_TYPES };

// Credential 使用记录（不存值，只存引用/字段/结果）—— 供购买流程追溯"哪个账号用了哪个凭据"
function recordUsage({ taskId, credentialId, site, fields, result, error }) {
  const rec = {
    id: 'cu_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    taskId: taskId || null,
    credentialId: credentialId || null,
    site: site || null,
    fields: Array.isArray(fields) ? fields : [],
    result: result || 'UNKNOWN', // SUCCESS / FAILED
    error: error ? String(error).slice(0, 200) : null,
    timestamp: Date.now(),
  };
  store.insert('aiCredentialUsage', rec);
  store.trimCollection('aiCredentialUsage', 2000);
  return rec;
}
