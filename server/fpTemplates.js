'use strict';

// CAP-A1：指纹模板库。
//
// 定位：把「一类环境」沉淀为可复用模板（os/browser/fingerprintOverride 基线），
// 单建与批量建号引用同一模板 → 同类账号指纹形态一致（农场语义的核心是「同形不同样」：
// 稳定字段由模板钉住，噪声字段由各 profile 独立 seed 派生）。
//
// 约束：
//   - fingerprintOverride 走**键白名单**归一化：未知键一律剥离（防垃圾数据进入生成器，
//     防利用 override 夹带任意结构）。
//   - 模板值做**格式校验**（IANA 时区 / locale 正则 / 屏幕与硬件数值边界）——脏模板会让
//     一批 profile 一起坏，入口必须挡住。
//   - workspace-scoped：归属盖章由路由层 identity.stamp 完成，本模块只管实体与校验。
//   - 禁止站点类型判定、禁止硬编码 selector（Generic AI Browser Operator 红线）。

const fs = require('fs');
const path = require('path');

// 数据目录：C59 起统一走 dataRoot（与 identity.js 同批；一次性 legacy 迁移见 dataRoot.js）
const { dataRoot, migrateLegacyFile } = require('./dataRoot');
const DATA_DIR = dataRoot();
migrateLegacyFile('fp_templates.json');
const TPL_FILE = path.join(DATA_DIR, 'fp_templates.json');

// fingerprintOverride 键白名单（与 server/fp/generate.js 实际消费的键集对齐）
const OVERRIDE_KEYS = [
  'userAgent', 'platform', 'vendor',
  'screen', 'timezone', 'timezoneOffset', 'timezoneMode',
  'language', 'languageMode', 'interfaceLanguage', 'interfaceLanguageMode',
  'fonts', 'webgl', 'webgpu', 'hardwareConcurrency', 'deviceMemory', 'deviceName', 'mac',
  'geolocation', 'webRtc', 'webRtcPublicIp', 'doNotTrack',
];

const LOCALE_RE = /^[a-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/;
const DEVICE_MEMORY_SET = new Set([1, 2, 4, 8]);
const BATCH_MAX = 50;

function isTzValid(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format();
    return true;
  } catch (e) {
    return false;
  }
}

// C61 I/O 硬化（老模块首轮深扫，与 C60 jsonStore 同族缺陷；消费 C62 共享原语 fsSafe.js）：
//   D1 (A类/数据丢失) saveTemplates 裸 writeFileSync 直写（中断留半截 JSON），且
//      getTemplates 把瞬时锁（EPERM/EBUSY/EACCES）与「文件损坏」混为一谈静默返回 []，
//      而 index.js 全部走 saveTemplates(getTemplates().concat(...)) 读改写 → 一次瞬时锁
//      或半截写入后，下一次任意模板操作把整个模板库覆写成 []（模板库静默清空）。
//   D2 (B类) 真损坏 JSON 时旧模板文件被静默丢弃后覆写——侧车保全而非蒸发。
const { readFileSyncRetry, atomicWriteFileSync } = require('./fsSafe');

// 瞬时锁重试；ENOENT 返回 null（模板库不存在=空库）；耗尽/非瞬时 fs 错误抛出（fail-loud，绝不吞成 []）。
function readTplRaw() {
  try {
    return readFileSyncRetry(TPL_FILE);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function preserveCorruptSidecar(file) {
  try { fs.renameSync(file, file + '.corrupt-' + Date.now()); } catch (e) { /* 侧车尽力而为 */ }
}

function getTemplates() {
  const raw = readTplRaw();
  if (raw == null) return [];
  try {
    const l = JSON.parse(raw);
    return Array.isArray(l) ? l : [];
  } catch (e) {
    preserveCorruptSidecar(TPL_FILE);
    return [];
  }
}
function saveTemplates(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // C61：共享原子写（tmp+rename+瞬时锁重试，fsSafe.js C60 语义对齐）
  atomicWriteFileSync(TPL_FILE, JSON.stringify(list, null, 2));
}

// 白名单归一化：只保留已知键；screen/geolocation 递归收紧
function normalizeOverride(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of OVERRIDE_KEYS) {
    if (raw[k] === undefined) continue;
    if ((k === 'screen' || k === 'geolocation') && (typeof raw[k] !== 'object' || Array.isArray(raw[k]))) continue;
    out[k] = raw[k];
  }
  if (out.screen) {
    const s = out.screen;
    out.screen = {
      width: Number(s.width) || undefined,
      height: Number(s.height) || undefined,
      pixelRatio: Number(s.pixelRatio) || undefined,
    };
  }
  return out;
}

// 校验失败 throw {status:400}；通过返回归一化后的 override
function validateTemplateInput(input) {
  const name = String((input && input.name) || '').trim();
  if (name.length < 1 || name.length > 60) throw err400('模板名必填（1-60 字符）');
  // null = 不约束（createTemplate 归一化产物；updateTemplate 合并 tpl 旧值时会带回 null，
  // C13 修复：null 与 undefined 同为「未约束」语义，否则未约束模板的编辑永远 400）
  if (input.os !== undefined && input.os !== null && typeof input.os !== 'string') throw err400('os 必须是字符串');
  if (input.browser !== undefined && input.browser !== null && typeof input.browser !== 'string') throw err400('browser 必须是字符串');
  const o = normalizeOverride(input.fingerprintOverride);
  if (o.timezone !== undefined && !isTzValid(o.timezone)) throw err400('timezone 不是有效 IANA 时区: ' + o.timezone);
  if (o.timezoneOffset !== undefined && !Number.isInteger(o.timezoneOffset)) throw err400('timezoneOffset 必须是整数分钟');
  if (o.timezoneMode !== undefined && !['random', 'fixed', 'ip'].includes(o.timezoneMode)) throw err400('timezoneMode 只允许 random|fixed|ip');
  if (o.language !== undefined && !LOCALE_RE.test(String(o.language))) throw err400('language 不是合法 locale: ' + o.language);
  if (o.languageMode !== undefined && !['random', 'fixed', 'ip'].includes(o.languageMode)) throw err400('languageMode 只允许 random|fixed|ip');
  if (o.screen) {
    const s = o.screen;
    if ((s.width && (s.width < 320 || s.width > 16384)) || (s.height && (s.height < 320 || s.height > 16384))) {
      throw err400('screen 尺寸超出合理范围（320-16384）');
    }
    if (s.pixelRatio && (s.pixelRatio < 1 || s.pixelRatio > 10)) throw err400('pixelRatio 超出合理范围（1-10）');
  }
  if (o.hardwareConcurrency !== undefined && (!Number.isInteger(o.hardwareConcurrency) || o.hardwareConcurrency < 1 || o.hardwareConcurrency > 64)) {
    throw err400('hardwareConcurrency 必须是 1-64 的整数');
  }
  if (o.deviceMemory !== undefined && !DEVICE_MEMORY_SET.has(o.deviceMemory)) throw err400('deviceMemory 只允许 1/2/4/8');
  return o;
}

function err400(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

function createTemplate(input) {
  const override = validateTemplateInput(input);
  const now = Date.now();
  const tpl = {
    id: 'ft_' + now.toString(36) + Math.random().toString(36).slice(2, 8),
    name: String(input.name).trim().slice(0, 60),
    description: String(input.description || '').slice(0, 300),
    os: input.os || null,          // null = 不约束（生成器按池随机）
    browser: input.browser || null,
    fingerprintOverride: override,
    notes: String(input.notes || '').slice(0, 500),
    createdAt: now, updatedAt: now,
  };
  return tpl;
}

function updateTemplate(tpl, input) {
  const merged = {
    name: input.name !== undefined ? input.name : tpl.name,
    os: input.os !== undefined ? input.os : tpl.os,
    browser: input.browser !== undefined ? input.browser : tpl.browser,
    fingerprintOverride: input.fingerprintOverride !== undefined
      ? input.fingerprintOverride
      : tpl.fingerprintOverride,
  };
  const override = validateTemplateInput(merged);
  tpl.name = String(merged.name).trim().slice(0, 60);
  tpl.os = merged.os || null;
  tpl.browser = merged.browser || null;
  tpl.fingerprintOverride = override;
  if (input.description !== undefined) tpl.description = String(input.description).slice(0, 300);
  if (input.notes !== undefined) tpl.notes = String(input.notes).slice(0, 500);
  tpl.updatedAt = Date.now();
  return tpl;
}

// 模板 → profile 构造输入的合并语义：**显式 input 覆盖模板，模板覆盖全局默认**
function mergeTemplateIntoInput(input, tpl) {
  const t = tpl || null;
  return {
    ...input,
    os: input.os || (t && t.os) || undefined,
    browser: input.browser || (t && t.browser) || undefined,
    fingerprintOverride: { ...((t && t.fingerprintOverride) || {}), ...(input.fingerprintOverride || {}) },
    templateId: t ? t.id : (input.templateId || undefined),
  };
}

module.exports = {
  getTemplates, saveTemplates, createTemplate, updateTemplate,
  normalizeOverride, validateTemplateInput, mergeTemplateIntoInput,
  OVERRIDE_KEYS, BATCH_MAX, isTzValid, TPL_FILE, err400,
};
