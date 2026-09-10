'use strict';

// Flow Schema：状态机式流程记忆的结构与校验。
// 核心约束：禁止保存固定 selector / 坐标 / xpath。
// 流程只描述「目标 → 状态序列（每个状态由 Element Memory + Semantic Resolver + Verification 完成）」，
// 页面变化不会毁掉流程 —— 这是与「固定点击脚本」的本质区别。

// 禁止的字段（任何一层出现即拒绝落库）
const FORBIDDEN_KEYS = ['selector', 'selectors', 'xpath', 'coordinates', 'coords', 'coordinate', 'pixel', 'offsetX', 'offsetY'];
const FORBIDDEN_VALUE_HINTS = ['xpath=', 'css=', 'document.querySelector'];

function normalizeGoal(goal) {
  return String(goal || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function validateFlow(flow) {
  const errors = [];
  if (!flow || !flow.goal) errors.push('缺少 goal');
  const states = flow && flow.states;
  if (!Array.isArray(states) || !states.length) { errors.push('缺少 states'); return { ok: false, errors }; }
  const blob = JSON.stringify(states).toLowerCase();
  for (const k of FORBIDDEN_KEYS) {
    if (blob.includes('"' + k + '"')) errors.push('state 禁止包含字段 ' + k);
  }
  for (const h of FORBIDDEN_VALUE_HINTS) {
    // 2026-09-10（PHASE 17-C 顺带取证）：blob 已 toLowerCase，而提示串 'document.querySelector'
    // 含大写 S → 该条**恒不命中**（死护栏，与 SEC7 同因）。此处改为双向小写。
    // 影响面已取证：server/data/aiFlowMemory.json 对三种禁用形态零命中 → 本修正为**纯收紧**，
    // 不改变任何已落库记录的判定结果。
    if (blob.includes(h.toLowerCase())) errors.push('state 禁止包含 ' + h);
  }
  // 状态必须有 id 与 name，且 next 必须可达（DONE 终结）
  const ids = new Set();
  for (const s of states) {
    if (!s.id) errors.push('state 缺少 id');
    if (!s.name) errors.push('state 缺少 name');
    ids.add(s.id);
  }
  for (const s of states) {
    if (s.next && s.next !== 'DONE' && !ids.has(s.next)) errors.push('state.next 指向不存在的状态: ' + s.next);
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { validateFlow, normalizeGoal, FORBIDDEN_KEYS };
