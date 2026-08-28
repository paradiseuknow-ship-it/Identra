'use strict';

// Phase 6.3 — Selector Robustness Fallback (E1)。
//
// 目标：让 verification 的 element_present 与 tool 的 resolveSelector 能正确解析「CSS 选择器形态」的
// target（如 `input[name='username'][value='admin']`），而非把整串当成语义文本去匹配（导致 0 命中 →
// 误报 VERIFY_FAILED）。不改动 verification 的「成功判定逻辑」（仍由 cands.length>0 决定），仅增强
// 匹配能力（selector robustness，属允许范围）。
//
// 关键：剥离**状态依赖型脆属性**（`[value=...]` / `[class*=...]` / `:nth-*` / 动态 data-* / 索引），
// 仅以稳定身份（tag + id / name / type / placeholder / role）做匹配，避免把「值变了」误判为「元素不存在」。

// 是否像 CSS 选择器（含属性选择符/组合子/伪类/类或 id 前缀）
function looksLikeCss(sel) {
  if (typeof sel !== 'string') return false;
  return /[\[\]=]/.test(sel) || /^[#.>]/.test(sel) || />>/.test(sel) || /::?[\w-]+\(/.test(sel) || /[#.][\w-]/.test(sel);
}

// 剥离脆属性，返回稳定核心选择器串（仅 tag + 稳定属性）
function normalizeSelector(sel) {
  let s = String(sel || '').trim();
  if (!s) return s;
  // 去掉 frame 前缀（iframe >> css=...）
  s = s.split('>>').map((p) => p.trim()).pop();
  // 去掉伪类/伪元素
  s = s.replace(/::?[\w-]+(\([^)]*\))?/g, '');
  // 去掉脆属性子句：[value=...] [value*=...] [class*=...] [class$=...] [class~=...] [data-...] [style...]
  s = s.replace(/\[[^\]]*(value|class\*|class\$|class~|data-|style)[^\]]*\]/gi, '');
  // 去掉索引伪类 :nth-child(n) :nth-of-type(n) :first-child :last-child :eq(n)
  s = s.replace(/:(nth-child|nth-of-type|first-child|last-child|eq|first|last|only-child)\b(\([^)]*\))?/gi, '');
  return s.trim();
}

// 解析归一化后的选择器为核心约束 { tag, attrs:{name:val,...} }
function parseCore(sel) {
  const core = normalizeSelector(sel);
  const out = { tag: null, attrs: {} };
  if (!core) return out;
  // tag
  const tagM = core.match(/^([a-zA-Z][\w-]*)/);
  if (tagM) out.tag = tagM[1].toLowerCase();
  // 属性 [name='x'] [type="y"] [id=z] [placeholder~=p] [role=r] [aria-label=l]
  const attrRe = /\[([\w-]+)\s*[~|^$*]?=\s*['"]?([^'"\]]+)['"]?\]/g;
  let m;
  while ((m = attrRe.exec(core))) {
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    if (['id', 'name', 'type', 'placeholder', 'role', 'aria-label', 'title'].includes(k)) out.attrs[k] = v.toLowerCase();
  }
  // 裸 #id / .class
  const idM = core.match(/#([\w-]+)/);
  if (idM && !out.attrs.id) out.attrs.id = idM[1].toLowerCase();
  const clsM = core.match(/\.([\w-]+)/);
  if (clsM && !out.attrs.class) out.attrs.class = clsM[1].toLowerCase();
  return out;
}

function norm(v) { return String(v == null ? '' : v).toLowerCase().replace(/[\s_\-:]+/g, ' ').trim(); }

// 单个元素对核心选择器的匹配评分
function matchCssSelector(sel, el) {
  const core = parseCore(sel);
  if (!core.tag && Object.keys(core.attrs).length === 0) return { score: 0, reason: '', matchedBy: null };

  // tag 不一致且指定了 tag → 不匹配
  if (core.tag && el.tag && norm(core.tag) !== norm(el.tag)) {
    return { score: 0, reason: 'tag 不符', matchedBy: null };
  }

  let best = 0, reason = '', by = null;
  const check = (cond, score, label, attr) => {
    if (cond && score > best) { best = score; reason = label; by = attr; }
  };
  if (core.attrs.id) check(norm(el.id) === core.attrs.id, 1.0, `id="${core.attrs.id}" 精确命中`, 'id');
  if (core.attrs.name) check(norm(el.name) === core.attrs.name, 0.98, `name="${core.attrs.name}" 精确命中`, 'name');
  if (core.attrs.type) check(norm(el.type) === core.attrs.type, 0.9, `type="${core.attrs.type}" 命中`, 'type');
  if (core.attrs.placeholder) {
    const p = norm(el.placeholder);
    check(p === core.attrs.placeholder || p.includes(core.attrs.placeholder), 0.85, `placeholder 命中 "${core.attrs.placeholder}"`, 'placeholder');
  }
  if (core.attrs.role) check(norm(el.role) === core.attrs.role, 0.85, `role="${core.attrs.role}" 命中`, 'role');
  if (core.attrs['aria-label']) {
    const a = norm(el.ariaLabel);
    check(a === core.attrs['aria-label'] || a.includes(core.attrs['aria-label']), 0.85, 'aria-label 命中', 'aria');
  }
  if (core.attrs.class) {
    const cls = norm(el.cls);
    const tokens = core.attrs.class.split(' ').filter(Boolean);
    if (tokens.every((t) => cls.includes(t))) check(0.8, 0.8, `class 包含 "${core.attrs.class}"`, 'cls');
  }

  return { score: best, reason, matchedBy: by ? 'attribute' : null };
}

module.exports = { looksLikeCss, normalizeSelector, parseCore, matchCssSelector };
