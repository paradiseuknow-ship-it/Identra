'use strict';

// Secret Manager：凭据引用抽象（兼容 credentialRef 命名）。
// AI Context 只能看到 { id, type, available, site, masked* }。
// 明文只存于 vault.js（按 profileId 加密）。此处只是"引用注册表 + 脱敏视图"。
// 未来扩展 type: email_password / api_key / payment / oauth_token / cookie / license / ssh_key。

const store = require('./store');
const vault = require('../vault');

const SECRET_TYPES = ['email_password', 'api_key', 'payment', 'oauth_token', 'cookie', 'license', 'ssh_key', 'other'];

function createSecret({ profileId, type, site, label }) {
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
    available: rec.available,
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

function remove(ref) {
  store.remove('aiCredentials', ref);
}

module.exports = { createSecret, getByRef, resolve, listMasked, remove, maskedView, recordUsage, SECRET_TYPES };

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
