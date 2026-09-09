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

// Phase 9 P6（CJK 缩写扩展）：电商/表单高频行业缩写 → 全称。
// 背景（smoke5 rw.094 铁证）：语义「加购按钮」与「加入购物车」无连续子串关系
// （加_入_购_物_车），中文 bigram 重叠为 0；而任意带「按钮」后缀的元素（如搜索按钮，
// aria「搜索按钮」）凭 1/3 部分重叠分胜出 → 解析到错误元素。
// 缩写表只收通用行业缩写，不针对任何特定站点/fixture。
const CJK_ABBREVIATIONS = {
  '加购': '加入购物车',
};

// 语义变体：原语义 + 缩写展开变体。scoreSemantic / scoreNearbyText 对每个变体独立
// 评分取最优（变体数有界：每语义至多 |CJK_ABBREVIATIONS| 个展开）。
function semanticVariants(semantic) {
  const s = String(semantic || '');
  if (!s) return [s];
  const out = [s];
  for (const [abbr, full] of Object.entries(CJK_ABBREVIATIONS)) {
    if (s.indexOf(abbr) >= 0 && s.indexOf(full) < 0) out.push(s.split(abbr).join(full));
  }
  return out;
}

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
  if (['id', 'name', 'aria', 'placeholder', 'label', 'cls', 'field', 'testid'].includes(by)) return 'attribute';
  if (by === 'tag') return 'attribute'; // P1.2 bare-tag 属元素结构身份信号，与 id/name 同类
  if (['nearby_text', 'dom_relationship'].includes(by)) return 'text';
  if (['role', 'role-button'].includes(by)) return 'fallback';
  return 'fallback';
}

// Signal 1：field key 匹配元素的 testid/name/id/placeholder/aria-label/label/cls。
// 权重分层（Phase 10.4）：field > aria/name > placeholder > label/cls；
// C105 M2：data-testid 是站点自声明的「测试权威身份」（W3C 无关但业界事实标准），
// 稳定性高于 id（id 常被构建工具哈希化），置于 TIER 顶层。
// 同时记录 matchedBy，便于诊断"命中了哪个信号"。
function scoreField(field, el) {
  if (!field) return { score: 0, reason: '', matchedBy: null };
  const f = normalize(field);
  const cands = [f, ...(FIELD_TOKENS[f] || [])].filter(Boolean);
  const ef = [
    { v: el.testId, by: 'testid' },
    { v: el.id, by: 'id' },
    { v: el.name, by: 'name' },
    { v: el.ariaLabel, by: 'aria' },
    { v: el.placeholder, by: 'placeholder' },
    { v: el.label, by: 'label' },
    { v: el.cls, by: 'cls' },
  ].map((x) => ({ v: x.v ? normalize(x.v) : '', by: x.by }));
  const TIER = { testid: 1.0, id: 1.0, name: 0.98, aria: 0.96, placeholder: 0.9, label: 0.85, cls: 0.8 };
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

// Signal 2：semantic 文本匹配（子串 + 中英文 token 重叠；中文走 bigram 模糊）。
// P6：先做 CJK 缩写展开（semanticVariants），对每个变体独立评分取最优。
function scoreSemantic(semantic, el) {
  let best = { score: 0, reason: '', matchedBy: null };
  for (const variant of semanticVariants(semantic)) {
    const r = scoreSemanticOnce(variant, el);
    if (r.score > best.score) best = r;
  }
  return best;
}

function scoreSemanticOnce(semantic, el) {
  if (!semantic) return { score: 0, reason: '', matchedBy: null };
  const text = el.text ? String(el.text) : '';
  // C105 M2：testid 是站点自声明的测试权威身份，进语义匹配池（命中归 'semantic'）
  const pool = [text, el.testId, el.placeholder, el.ariaLabel, el.label, el.innerText, el.roleText]
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
// P6：与 scoreSemantic 同样先做 CJK 缩写展开，取变体最优。
function scoreNearbyText(semantic, el) {
  let best = { score: 0, reason: '', matchedBy: null };
  for (const variant of semanticVariants(semantic)) {
    const r = scoreNearbyTextOnce(variant, el);
    if (r.score > best.score) best = r;
  }
  return best;
}

function scoreNearbyTextOnce(semantic, el) {
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

// ── 元素类别：可操作性（修复 CAP-E5-LABEL-RANKING）──────────────────────────
// 候选池里混着两类元素（见 observation.js 中 Phase 9 P1 的说明）：
//   控件 control —— input/textarea/select/button/a/summary 以及显式交互 role：
//                   动作可以真正作用在它们身上（fill / click / select）。
//   描述性容器 descriptive —— form/label/h1~h3/img。当初把它们补齐进候选池，
//                   是**为了候选发现与 element_present 验证**（例如 <form id="regForm">
//                   在页面上真实存在却一个候选都进不了），**不是为了当动作目标**：
//                   fill 一个 <label> 不会产生任何效果，后续 fill 无响应。
// 因此：当两类元素命中同一个语义时，控件必须胜出。
// 这是一条 DOM 结构规则（什么标签可被操作），与站点/品类/语言完全无关。
const CONTROL_TAGS = new Set(['input', 'textarea', 'select', 'button', 'a', 'summary']);
const CONTROL_ROLES = new Set(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'option', 'switch', 'searchbox', 'menuitem', 'tab', 'slider', 'spinbutton']);
const DESCRIPTIVE_TAGS = new Set(['form', 'label', 'h1', 'h2', 'h3', 'img']);

// P1.2 bare-tag matching signal（Phase 13，v2 baseline rw.068 铁证）：
// expect 为合法裸 HTML tag 名（如 "h2"）且候选池中存在该 tag 元素时，resolver 必须能命中。
// 此前五信号无 tag 名匹配信号 → resolve("h2") 对池内真实 h2 返回 0 候选 → VERIFY_FAILED。
// 词表 = CONTROL_TAGS ∪ DESCRIPTIVE_TAGS（observation contract 实际可能入池的标签全集），
// 显式 HTML tag vocabulary，禁止任何长度/字符串猜测 heuristic。
// 不满足词表（如「商品列表容器」）或池中无该 tag（如页面无 form）时仍返回 0 候选——零放宽。
const BARE_TAGS = new Set([...CONTROL_TAGS, ...DESCRIPTIVE_TAGS]);

// target 是否为合法裸 tag 名：全词命中词表 + 非 CSS 选择器形态（CSS 形态优先走 Signal 5 fallback）。
// normalize 已 toLowerCase → 天然大小写不敏感（"H2" ≡ "h2"）。返回归一小写 tag 或 null。
function bareTagHint(target) {
  const pick = (v) => {
    if (typeof v !== 'string') return null;
    if (sf.looksLikeCss(v)) return null;
    const n = normalize(v);
    return (n && BARE_TAGS.has(n)) ? n : null;
  };
  if (typeof target === 'string') return pick(target);
  if (target && typeof target === 'object') return pick(target.field) || pick(target.semantic || target.text);
  return null;
}

// bare-tag 命中：仅当元素 tag 与 tagHint 严格相等（结构身份精确匹配，非包含/前缀）。
// 分数 0.85（与 field TIER aria 层同级）：低于 field 精确命中(1.0)，高于语义 token 重叠(0.85 封顶但需重叠证据)——
// tag 名是显式结构指令，命中即高置信，但多个同 tag 元素同分时按 DOM 顺序取第一个（与 CSS "h2" 语义一致）。
function scoreBareTag(tagHint, el) {
  if (!tagHint) return { score: 0, reason: '', matchedBy: null };
  const t = String((el && el.tag) || '').toLowerCase();
  if (t && t === tagHint) return { score: 0.85, reason: 'bare-tag 命中「' + tagHint + '」', matchedBy: 'tag' };
  return { score: 0, reason: '', matchedBy: null };
}

function elementClass(el) {
  const tag = String((el && el.tag) || '').toLowerCase();
  const role = String((el && el.role) || '').toLowerCase();
  if (CONTROL_TAGS.has(tag) || CONTROL_ROLES.has(role)) return 'control';
  if (DESCRIPTIVE_TAGS.has(tag)) return 'descriptive';
  return 'passive';
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
  const tagHint = bareTagHint(target); // P1.2 bare-tag 信号（仅词表内裸 tag，CSS 形态除外）
  const out = [];
  elems.forEach((el, i) => {
    const fs = scoreField(field, el);
    const ss = scoreSemantic(semantic, el);
    const ns = scoreNearbyText(semantic, el);
    // Phase 6.3：CSS 选择器形态的 target 按属性匹配（剥离脆属性后）
    const cs = cssSel ? sf.matchCssSelector(cssSel, el) : { score: 0, reason: '', matchedBy: null };
    // P1.2：裸 tag 名精确匹配元素 tag（词表外/无同 tag 元素时恒为 0）
    const ts = scoreBareTag(tagHint, el);
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
      { s: ts.score, r: ts.reason, by: ts.matchedBy || 'tag' },
    ];
    let score = 0, reason = '', matchedBy = null;
    cands.forEach((c) => { if (c.s > score) { score = c.s; reason = c.r; matchedBy = c.by; } });

    // 纯图标/无文本按钮兜底：动作语义 + role=button 进入候选，交给 verification 把关（不伪造高置信度）
    // C105 F1（误点机器根因修复）：兜底候选必须与元素**自身身份信号**（text/aria/id/cls/placeholder/label）
    // 存在词法关联（token 相交），零关联直接出局。旧实现对页面上**所有** button 一律给 0.4 同分，
    // DOM 顺序决胜 → 语义「continue/submit」命中第一个按钮（法语站实锤：Plateforme 菜单被点开，
    // 真实 CTA a#continue-nav "Commencez gratuitement" 一直在列表 index 40）。
    if (score <= 0) {
      const sem = semantic || roleHint || '';
      if (el.role === 'button' && sem && /submit|continue|next|proceed|sign|login|search|agree|accept|cancel|登录|搜索|提交|继续|确认/i.test(sem)) {
        const semTokens = tokenize(sem);
        const identity = [el.text, el.ariaLabel, el.id, el.testId, el.cls, el.placeholder, el.label, el.innerText, el.roleText]
          .map((x) => (x ? String(x) : '')).join(' ');
        const idTokens = new Set(tokenize(identity));
        const lexical = semTokens.some((tk) => idTokens.has(tk));
        if (lexical) { score = 0.4; reason = 'role=button + 动作语义兜底（词法关联成立，需 verification 确认）'; matchedBy = 'role-button'; }
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
  // ── 可操作性优先排序（CAP-E5-LABEL-RANKING）──
  // 修复前：`<label for="uname">用户名</label><input id="uname" name="username">`
  // 中 target={"semantic":"用户名"} 时，label 与 input 都得 0.92 分，
  // 排序退化为「DOM 顺序」→ label（在前）胜出 → 后续 fill 打在不可输入的 label 上。
  // 真实登录/注册表单中 label[for] 极常见，这是 ELEMENT_NOT_FOUND 的重要来源。
  out.forEach((c) => { c.elementClass = elementClass(c.el); });

  // (1) 标签冗余降权：若某 <label> 的文本正是另一个候选控件的 label 字段
  //     （即 observation 的 labelFor() 通过 label[for] / 包裹关系解析出的关联），
  //     那么该 label 只是那个控件的**文字注解**，控件严格更可操作。
  //     降权而非剔除：它仍需留在候选池里供 element_present 等结构性验证使用。
  const labelledControls = new Set();
  out.forEach((c) => {
    if (c.elementClass === 'control' && c.el && c.el.label) labelledControls.add(normalize(c.el.label));
  });
  out.forEach((c) => {
    if (c.elementClass !== 'descriptive') return;
    if (String((c.el && c.el.tag) || '').toLowerCase() !== 'label') return;
    const own = normalize((c.el && c.el.text) || '');
    if (own && labelledControls.has(own)) {
      c.score = Math.round(c.score * 0.8 * 100) / 100;
      c.reason += ' | label 是某控件的文字注解，已降权（控件优先）';
    }
  });

  // (2) 描述性元素封顶：候选池里存在「评分可信的控件」时，描述性元素必须让位。
  //     背景（CAP-E6 收尾）：`<h3>用户名</h3><input name="username">` 里
  //     h3 靠自身文字直击 semantic 得 0.92，input 只能靠邻近文本得 0.82 ——
  //     纯按分数排 h3 胜出，而 fill 一个 <h3> 不会产生任何业务效果。
  //     语义上：描述性元素的文字命中没有回答「它是目标」，只回答了「目标在它附近」。
  //     因此**只在确实存在可信控件候选（分数高于封顶线）时才封顶**：
  //     页面上没有任何控件命中时（例如找 <form>、或页面上只有一个纯展示 label），
  //     描述性元素就是唯一合理答案，必须保持原分（这是刻意保留的出口，不是漏网）。
  const DESCRIPTIVE_CEILING = 0.75;
  let controlBest = 0;
  out.forEach((c) => { if (c.elementClass === 'control' && c.score > controlBest) controlBest = c.score; });
  if (controlBest > DESCRIPTIVE_CEILING) {
    out.forEach((c) => {
      if (c.elementClass !== 'descriptive' || c.score <= DESCRIPTIVE_CEILING) return;
      c.score = DESCRIPTIVE_CEILING;
      c.reason += ' | 描述性元素封顶 ' + DESCRIPTIVE_CEILING + '（存在评分更高的可操作控件）';
    });
  }

  // (3) 同分时控件优先：descriptive 元素（form/label/h1~h3/img）本就不是动作目标，
  //     只是候选发现与 element_present 的载体，同分下必须让位给真正的控件。
  const CLASS_RANK = { control: 0, passive: 1, descriptive: 2 };
  out.sort((a, b) => (b.score - a.score)
    || (CLASS_RANK[a.elementClass] - CLASS_RANK[b.elementClass])
    || (a.index - b.index));
  return out.slice(0, (opts && opts.limit) || 8);
}

// 简易 CSS 选择器转义
function escapeCss(s) {
  if (!s) return s;
  return String(s).replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g, (c) => '\\' + c);
}

// 由元素生成可用的 CSS 选择器（Playwright 兼容）
// C105 M2：testid 是构建工具哈希化 id 之外的稳定权威身份，优先级最高；
// a[href] 是无文本锚点的结构身份兜底（相对路径截断，避免把 token query 写进 selector）。
function selectorFor(el, index) {
  if (el.testId) return '[data-testid="' + String(el.testId).replace(/"/g, '\\"') + '"]';
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
  if (el.tag === 'a') {
    if (el.text) return 'a:has-text("' + String(el.text).slice(0, 30).replace(/"/g, '\\"') + '")';
    // href 存的是 pathname（observation 侧剥 query/hash，防 token 泄漏），用 *= 子串形态匹配
    if (el.href) return 'a[href*="' + String(el.href).replace(/"/g, '\\"') + '"]';
  }
  if (el.tag === 'textarea') return 'textarea';
  if (el.tag === 'select') return 'select';
  return '#' + escapeCss(el.id || 'el-' + index);
}

// ── C105 F2/F4 共享原语：selector 接地判定 ────────────────────────────────
// 判定一个显式 selector 是否能在当前 observation 的元素身份中找到对应元素
// （与 selectorFor 同源：id / name / text / 复合属性 CSS 形态）。
// 背景（C105 D-B 死循环）：页面导航后复用过期 selector（#continue-nav）→ humanClick 找不到
// → reload ×3 → 同错 20+ 次 → HUMAN_ESCALATION。任何「携带语义键的 target」其 selector
// 必须能在新鲜观察中接地，否则弃用、交语义新鲜解析。
// 宽松边界：observation 缺失/无元素时不否定（无反证，保持既有行为）；selector-only target
// （无 semantic/field/text 可回退）由调用方决定不弃用，保持 Phase 6.3 CSS fallback 行为。
function selectorGrounded(selector, observation) {
  const sel = String(selector || '');
  if (!sel) return true;
  const elems = (observation && observation.elements) || [];
  if (!Array.isArray(elems) || !elems.length) return true;
  const idOnly = sel.match(/^#([A-Za-z0-9_-]+)$/);
  const nameOnly = sel.match(/^[a-z][a-z0-9-]*\[name=["']?([^\]"']+)["']?\]$/i);
  const textOnly = sel.match(/^(?:text=|a:has-text\()\s*["'](.+)["']\s*\)?$/);
  // C105 M2：testid / href 形态快路（selectorFor 同源；href 为 *= 子串形态）
  const testIdOnly = sel.match(/^\[data-testid=["']([^\]"']+)["']\]$/);
  const hrefOnly = sel.match(/^a\[href\*?=["']([^\]"']+)["']\]$/);
  for (const el of elems) {
    if (testIdOnly) { if (el.testId === testIdOnly[1]) return true; continue; }
    if (hrefOnly) { if (el.tag === 'a' && el.href && String(el.href).indexOf(hrefOnly[1]) >= 0) return true; continue; }
    if (idOnly) { if (el.id === idOnly[1]) return true; continue; }
    if (nameOnly) { if (el.name === nameOnly[1]) return true; continue; }
    if (textOnly) {
      const t = String(el.text || '').trim();
      // selectorFor 生成 text="前 30 字符" → 捕获串应是元素 text 的前缀
      if (t && (t === textOnly[1] || t.indexOf(textOnly[1]) === 0)) return true;
      continue;
    }
    // 通用形态：selectorFor 同源生成比对 + 复合属性 CSS 粗接地
    try { if (selectorFor(el, 0) === sel) return true; } catch (e) {}
    if (el.id && '#' + escapeCss(el.id) === sel) return true;
    if (cssGroundedInObs(sel, el)) return true;
  }
  return false;
}

// 复合属性 CSS 粗接地：提取 tag / #id / [attr=value] 逐项与元素身份比对（全部命中才算接地）。
// 只认静态身份属性（name/id/placeholder/type/aria-label），不解析伪类/结构关系（宽松向：
// 无法判定的属性跳过 —— 本原语只负责「否决确定过期的 selector」，不负责证明完美匹配）。
function cssGroundedInObs(sel, el) {
  if (!/^[a-z#.\[]/i.test(sel)) return false;
  const tagM = sel.match(/^([a-z][a-z0-9-]*)/i);
  if (tagM && el.tag && el.tag.toLowerCase() !== tagM[1].toLowerCase()) return false;
  const idM = sel.match(/#([A-Za-z0-9_-]+)/);
  if (idM && el.id !== idM[1]) return false;
  if (!/\[/.test(sel)) return tagM ? true : false; // 纯 tag selector 已由 tagM 判定
  const attrRe = /\[([a-zA-Z-]+)(?:=["']?([^\]"']*)["']?)?\]/g;
  // C105 M2：data-testid / href 进静态身份属性面（复合 CSS 粗接地）
  const byAttr = { name: el.name, id: el.id, placeholder: el.placeholder, type: el.type, 'aria-label': el.ariaLabel, 'data-testid': el.testId, href: el.href };
  let m; let saw = false;
  while ((m = attrRe.exec(sel))) {
    saw = true;
    const v = byAttr[m[1].toLowerCase()];
    if (m[2] !== undefined && v !== m[2]) return false;
  }
  return saw;
}

module.exports = { resolve, normalize, synonymSet, semanticVariants, selectorFor, escapeCss, SYNONYMS, CJK_ABBREVIATIONS, scoreNearbyText, scoreSemantic, scoreField, BARE_TAGS, bareTagHint, scoreBareTag, selectorGrounded };
