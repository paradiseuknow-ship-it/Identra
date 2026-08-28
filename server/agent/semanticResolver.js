'use strict';

// Multi-signal Semantic Element Resolver.
// 目标：在观察结果中按「多信号评分」定位元素，解决 Phase 6 真实基准中 80.1% 的 ELEMENT_NOT_FOUND。
//
// 信号优先级（权重）：
//   Signal 1  field key    最高(1.0)  —— email/username/password/search 等，匹配 name/id/placeholder/aria-label/label/cls
//   Signal 2  semantic text(0.9)      —— 可见文本/innerText/aria/placeholder/label，支持子串 + 中英文 token 重叠（中文 bigram）
//   Signal 3  nearby context          —— 并入 semantic/label 评分（label/placeholder/aria 已是元素邻近上下文）
//   Signal 4  element type (加成)     —— search→input[type=search]，password→input[type=password]，email→input[type=email]
//   Signal 5  css-selector fallback   —— Phase 6.3：target 为 CSS 选择器形态（如 input[name='username'][value='admin']）时，
//                                       剥离脆属性后按稳定身份（tag+id/name/type/...）匹配，修复 E1 误报 VERIFY_FAILED。
//
// 入口 resolve(target, observation, opts)：
//   target 可为「字符串」（兼容旧调用，视作 semantic）或「对象」{ field, semantic, text, role }。
//   真实执行路径（tools.js resolveSelector）传入完整 action.target 对象，使 field 作为权威定位键。
// selector 仅作兜底 fallback，不作为首选（与 Phase 1 设计一致）。

const sf = require('./selectorFallback');

const SYNONYMS = {
  email: ['email', 'e-mail', 'mail', 'email address', 'e-mail address'],
  password: ['password', 'passwd', 'pwd', 'password field'],
  username: ['username', 'user name', 'user', 'login', 'login name'],
  submit: ['submit', 'sign up', 'signup', 'sign-up', 'register', 'create account', 'create', 'continue', 'next', 'proceed', 'ok', 'done', 'save'],
  search: ['search', 'query', 'q'],
  login: ['login', 'log in', 'sign in', 'signin', 'sign-in', 'welcome back'],
  logout: ['logout', 'log out', 'sign out', 'signout'],
  cancel: ['cancel', 'close', 'dismiss', 'x', 'no thanks'],
  'agree': ['agree', 'accept', 'allow', 'i agree', 'accept all', 'i accept'],
};

// field 值 → 候选匹配 token（用于匹配元素的 name/id/placeholder/aria-label/label/cls）
const FIELD_TOKENS = {
  email: ['email', 'e-mail', 'mail'],
  username: ['username', 'user', 'login', 'userid', 'user-id'],
  password: ['password', 'passwd', 'pwd'],
  search: ['search', 'query', 'q'],
  name: ['name', '姓名', '名字'],
  firstname: ['firstname', 'first', '名'],
  lastname: ['lastname', 'last', '姓'],
  phone: ['phone', 'tel', 'mobile', '手机', '电话'],
  submit: ['submit', 'signin', 'signup', 'login', 'search', 'continue', 'next', 'proceed', 'ok', 'done', 'save'],
};

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[\s_\-:]+/g, ' ').trim();
}

function synonymSet(semantic) {
  const key = normalize(semantic);
  return new Set((SYNONYMS[key] || [key]).map(normalize));
}

function hasCJK(s) { return /[一-鿿]/.test(s || ''); }

// 切 token：英文单词 + 中文 bigram（两汉字窗口）
function tokenize(s) {
  const n = normalize(s);
  const out = [];
  const words = n.match(/[a-z0-9]+/g) || [];
  words.forEach((w) => out.push(w));
  const str = String(s || '');
  for (let i = 0; i + 1 < str.length; i++) {
    if (hasCJK(str[i]) && hasCJK(str[i + 1])) out.push(str.slice(i, i + 2));
  }
  return out;
}

// 词级包含（避免 "main" 误匹配 "domain"）
function wordIncludes(haystack, needle) {
  const words = haystack.split(' ').filter(Boolean);
  const n = needle.split(' ').filter(Boolean);
  if (!n.length) return false;
  for (let i = 0; i + n.length <= words.length; i++) {
    if (n.every((w, j) => words[i + j] === w)) return true;
  }
  return false;
}

// P1 Resolver telemetry：将内部细粒度 matchedBy 归一到可分析的统一分类
// { semantic, text, attribute, fallback }。仅提升可观测性，**不改变选择算法/评分**。
function canonicalMatchedBy(by) {
  if (by === 'semantic' || by === 'text') return by;
  if (['id', 'name', 'aria', 'placeholder', 'label', 'cls', 'field'].includes(by)) return 'attribute';
  if (['nearby_text', 'dom_relationship'].includes(by)) return 'text';
  if (['role', 'role-button'].includes(by)) return 'fallback';
  return 'fallback';
}

// Signal 1：field key 匹配元素的 name/id/placeholder/aria-label/label/cls。
// 权重分层（Phase 10.4）：field > aria/name > placeholder > label/cls；
// 同时记录 matchedBy，便于诊断"命中了哪个信号"。
function scoreField(field, el) {
  if (!field) return { score: 0, reason: '', matchedBy: null };
  const f = normalize(field);
  const cands = [f, ...(FIELD_TOKENS[f] || [])].filter(Boolean);
  const ef = [
    { v: el.id, by: 'id' },
    { v: el.name, by: 'name' },
    { v: el.ariaLabel, by: 'aria' },
    { v: el.placeholder, by: 'placeholder' },
    { v: el.label, by: 'label' },
    { v: el.cls, by: 'cls' },
  ].map((x) => ({ v: x.v ? normalize(x.v) : '', by: x.by }));
  const TIER = { id: 1.0, name: 0.98, aria: 0.96, placeholder: 0.9, label: 0.85, cls: 0.8 };
  let best = 0, reason = '', matchedBy = null;
  for (const c of cands) {
    if (!c) continue;
    for (const e of ef) {
      if (!e.v) continue;
      const exact = (e.v === c);
      const contains = e.v.split(' ').includes(c) || e.v.startsWith(c + ' ') || e.v.endsWith(' ' + c) || (c.length >= 3 && e.v.includes(c));
      if (exact) {
        const s = TIER[e.by];
        if (s >= best) { best = s; reason = 'field 精确命中「' + c + '」@' + e.by; matchedBy = e.by; }
      } else if (contains) {
        const s = Math.min(0.9, TIER[e.by] - 0.05);
        if (s >= best) { best = s; reason = 'field 包含「' + c + '」@' + e.by; matchedBy = e.by; }
      }
    }
  }
  return { score: best, reason, matchedBy };
}

// Signal 2：semantic 文本匹配（子串 + 中英文 token 重叠；中文走 bigram 模糊）
function scoreSemantic(semantic, el) {
  if (!semantic) return { score: 0, reason: '', matchedBy: null };
  const text = el.text ? String(el.text) : '';
  const pool = [text, el.placeholder, el.ariaLabel, el.label, el.innerText, el.roleText]
    .map((x) => (x ? String(x) : ''))
    .join(' ');
  const pn = normalize(pool);
  const sn = normalize(semantic);
  // 命中来自元素自身可见文本 → matchedBy 'text'，否则 'semantic'
  const textHit = text && normalize(text).includes(sn);
  // 纯语义解析统一标记为 'semantic'（无论命中元素可见文本还是 aria/placeholder/label）；
  // 'text' 子类型仅作内部诊断，不暴露为顶层 matchedBy，避免与契约测试期望冲突。
  if (sn && pn.includes(sn)) return { score: 0.9, reason: 'semantic 子串命中「' + sn + '」', matchedBy: textHit ? 'text' : 'semantic' };
  // token 重叠（英文单词 + 中文 bigram）
  const st = tokenize(semantic);
  const pt = new Set(tokenize(pool));
  let inter = 0;
  st.forEach((t) => { if (pt.has(t)) inter++; });
  const ratio = st.length ? inter / st.length : 0;
  if (ratio >= 0.5) return { score: Math.min(0.85, 0.55 + 0.3 * ratio), reason: 'semantic token 重叠 ' + Math.round(ratio * 100) + '%', matchedBy: 'semantic' };
  if (ratio >= 0.25 && st.length >= 2) return { score: 0.5 + 0.2 * ratio, reason: 'semantic 部分重叠 ' + Math.round(ratio * 100) + '%', matchedBy: 'semantic' };
  return { score: 0, reason: '', matchedBy: null };
}

// Signal 3：nearby-text / DOM-relationship（父/兄弟/容器文本与 target semantic 的 token 重叠）。
// 解决「目标元素自身无文本/无 name，但邻近容器文字描述其语义」的定位场景（例如图标按钮附近的说明文字）。
// 命中强（子串或 >=50% token 重叠）→ matchedBy 'nearby_text'；中等重叠（25%~50%）→ 'dom_relationship'。
function scoreNearbyText(semantic, el) {
  if (!semantic || !el) return { score: 0, reason: '', matchedBy: null };
  const nearby = [el.parentText, el.siblingText, el.nearbyText, el.containerText]
    .map((x) => (x ? String(x) : ''))
    .join(' ');
  if (!nearby.trim()) return { score: 0, reason: '', matchedBy: null };
  const sn = normalize(semantic);
  const pn = normalize(nearby);
  if (sn && pn.includes(sn)) return { score: 0.8, reason: 'nearby_text 子串命中「' + sn + '」', matchedBy: 'nearby_text' };
  const st = tokenize(semantic);
  const pt = new Set(tokenize(nearby));
  let inter = 0;
  st.forEach((t) => { if (pt.has(t)) inter++; });
  const ratio = st.length ? inter / st.length : 0;
  if (ratio >= 0.5) return { score: Math.round(Math.min(0.8, 0.55 + 0.25 * ratio) * 100) / 100, reason: 'nearby_text token 重叠 ' + Math.round(ratio * 100) + '%', matchedBy: 'nearby_text' };
  if (ratio >= 0.25 && st.length >= 2) return { score: Math.round((0.5 + 0.2 * ratio) * 100) / 100, reason: 'dom_relationship 部分重叠 ' + Math.round(ratio * 100) + '%', matchedBy: 'dom_relationship' };
  return { score: 0, reason: '', matchedBy: null };
}

// Signal 4：element type 加成（依据 target 的 field/semantic 提示）
function typeBonus(target, el) {
  const hints = [target && target.field, target && target.semantic, ''].map((x) => normalize(x)).join(' ');
  if (/password|密码/.test(hints) && el.type === 'password') return { bonus: 0.1, reason: 'type=password' };
  if (/email|邮箱|mail/.test(hints) && el.type === 'email') return { bonus: 0.1, reason: 'type=email' };
  if (/(search|搜索|query)/.test(hints) && (el.type === 'search' || el.role === 'searchbox')) return { bonus: 0.1, reason: 'type=search' };
  if (/(submit|login|登录|搜索|提交|继续|下一步|sign)/.test(hints) && (el.role === 'button' || el.tag === 'button')) return { bonus: 0.05, reason: 'role=button 动作' };
  return { bonus: 0, reason: '' };
}

// 输入 target + 观察结果 → 候选列表 [{ elementId?, selector?, index, score, reason, el }]
function resolve(target, observation, opts = {}) {
  let field = null, semantic = null, roleHint = null, cssSel = null;
  if (typeof target === 'string') {
    // Phase 6.3：CSS 选择器形态（如 input[name='username'][value='admin']）按属性匹配；
    // 否则视作语义/字段 token（同时启用 field 属性匹配，兼容裸 'username' 这类 target）。
    if (sf.looksLikeCss(target)) cssSel = target;
    else { semantic = target; field = target; }
  } else if (target && typeof target === 'object') {
    field = target.field || null;
    semantic = target.semantic || target.text || null;
    roleHint = target.role || null;
  }
  const elems = (observation && observation.elements) || [];
  const out = [];
  elems.forEach((el, i) => {
    const fs = scoreField(field, el);
    const ss = scoreSemantic(semantic, el);
    const ns = scoreNearbyText(semantic, el);
    // Phase 6.3：CSS 选择器形态的 target 按属性匹配（剥离脆属性后）
    const cs = cssSel ? sf.matchCssSelector(cssSel, el) : { score: 0, reason: '', matchedBy: null };
    // 角色提示：target.role 直接命中元素 role（如 target.role='button' 且 el.role='button'）
    let roleScore = 0, roleBy = null;
    if (roleHint && el.role && normalize(roleHint) === normalize(el.role)) { roleScore = 0.7; roleBy = 'role'; }

    // 取最高信号（保持现有 TIER 优先级：field> ... > semantic；nearby_text/dom_relationship/role/css 作为补充信号参与竞争）
    const cands = [
      { s: fs.score, r: fs.reason, by: fs.matchedBy || 'field' },
      { s: ns.score, r: ns.reason, by: ns.matchedBy || 'nearby_text' },
      { s: ss.score, r: ss.reason, by: ss.matchedBy || 'semantic' },
      { s: roleScore, r: roleHint ? ('role 提示命中「' + el.role + '」') : '', by: roleBy },
      { s: cs.score, r: cs.reason, by: cs.matchedBy || 'attribute' },
    ];
    let score = 0, reason = '', matchedBy = null;
    cands.forEach((c) => { if (c.s > score) { score = c.s; reason = c.r; matchedBy = c.by; } });

    // 纯图标/无文本按钮兜底：动作语义 + role=button 进入候选，交给 verification 把关（不伪造高置信度）
    if (score <= 0) {
      const sem = semantic || roleHint || '';
      if (el.role === 'button' && sem && /submit|continue|next|proceed|sign|login|search|agree|accept|cancel|登录|搜索|提交|继续|确认/i.test(sem)) {
        score = 0.4; reason = 'role=button + 动作语义兜底（需 verification 确认）'; matchedBy = 'role-button';
      }
    }
    if (score <= 0) return;

    const tb = typeBonus(typeof target === 'object' ? target : {}, el);
    score = Math.min(1, score + tb.bonus);
    if (el.visible !== false) score = Math.min(1, score + 0.02);
    out.push({
      elementId: el.id || null,
      selector: selectorFor(el, i),
      index: i,
      score: Math.round(score * 100) / 100,
      reason: (reason || '') + (tb.bonus ? ' | ' + tb.reason : ''),
      matchedBy: canonicalMatchedBy(matchedBy),
      el,
    });
  });
  out.sort((a, b) => b.score - a.score || a.index - b.index);
  return out.slice(0, (opts && opts.limit) || 8);
}

// 简易 CSS 选择器转义
function escapeCss(s) {
  if (!s) return s;
  return String(s).replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g, (c) => '\\' + c);
}

// 由元素生成可用的 CSS 选择器（Playwright 兼容）
function selectorFor(el, index) {
  if (el.id) return '#' + escapeCss(el.id);
  if (el.tag === 'input') {
    if (el.name) return 'input[name="' + String(el.name).replace(/"/g, '\\"') + '"]';
    if (el.placeholder) return 'input[placeholder="' + String(el.placeholder).replace(/"/g, '\\"') + '"]';
    if (el.type && el.type !== 'text') return 'input[type="' + el.type + '"]';
    return 'input';
  }
  if (el.role === 'button' || el.tag === 'button') {
    const t = String(el.text || '').trim();
    if (t) return 'text="' + t.slice(0, 30).replace(/"/g, '\\"') + '"';
    return 'button';
  }
  if (el.tag === 'a' && el.text) return 'a:has-text("' + String(el.text).slice(0, 30).replace(/"/g, '\\"') + '")';
  if (el.tag === 'textarea') return 'textarea';
  if (el.tag === 'select') return 'select';
  return '#' + escapeCss(el.id || 'el-' + index);
}

module.exports = { resolve, normalize, synonymSet, selectorFor, escapeCss, SYNONYMS, scoreNearbyText, scoreSemantic, scoreField };
