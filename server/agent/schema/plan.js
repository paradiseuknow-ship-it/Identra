'use strict';

// Plan Schema：所有 LLM 生成的 Plan 必须经此校验，非法即拒绝。
// Plan 结构：
// {
//   goal: string,
//   steps: [{
//     id, type(NAVIGATE/OBSERVE/ACT/VERIFY/EXTRACT), description, expectedOutcome, risk,
//     action?: Action(可选，运行时二次校验)
//   }]
// }

const { validateAction, RISK_LEVELS, ACTION_TYPES, TYPE_RISK_FLOOR, VERIFICATION_TYPES } = require('./action');
const { looksLikeCss } = require('../selectorFallback');

// ============================================================================
// Fix A（2026-09-01）：element 证据 expect 的 CSS 形态语法守卫（evidence 生成约束）
// 背景（Final100 P2 taxonomy A3）：LLM 臆造非法选择器形态（rw.065 `id=regForm` 缺 #/
// 前缀）作为 element_present expect，执行期语义匹配必然落空 → VERIFY_FAILED。
// 守卫口径（只收紧、不放宽，不触碰验证语义）：
//   - 仅对「长得像 CSS」的 expect 生效（looksLikeCss 启发式，与 semanticResolver 同源）；
//     语义中文描述是合法路径（semanticResolver.resolve 语义匹配），完全不受限。
//   - CSS 形态必须是保守合法形状：tag/#id/.class/[attr='值']/伪类 + 组合器；
//     属性值内允许非 ASCII（[aria-label='商品列表'] 合法），括号外禁止非 ASCII 与
//     裸等号（id=regForm / class=foo 即被拒绝）。
//   - 支持 ' >> ' 跨 frame 前缀（与 tools.makeLocator 同一寻址方案），逐段校验。
const CSS_EVIDENCE_TYPES = ['element_present', 'element_absent'];

// ============================================================================
// Fix A2（2026-09-04，R8）：泛化容器标签证据守卫（与 Fix A 同族，只收紧不放宽）。
// 背景（R8 取证，.benchmark/r8_diag/ E3.1-DIAG 铁证，rw.026 三点 CANCELLED 主因）：
// LLM 生成 element_present expect="body" → semanticResolver BARE_TAGS 词表有意不含
// body（非业务元素）→ 语义解析必然 0 候选 → VERIFY_FAILED；VERIFY_RETRY 对该结构性
// 不可满足验证无解 → 烧尽 retry/repair 预算 → churn 至 deadline。
// 守卫口径：element 类证据 expect 为「裸泛化容器标签词」（trim+小写全词命中黑名单，
// 且非 CSS 形态）时拒绝 plan（生成期 fail-fast，执行前重规划）。仅拦裸词——
// "div.foo"/".list"/"#exportBtn" 等真 CSS 形态不受影响（走 Fix A 的 CSS 语法校验）。
// element_absent 同口径：泛化容器的「不存在」同样无业务区分度且解析必然歧义。
const GENERIC_CONTAINER_TAGS = new Set([
  'body', 'html', 'head', 'div', 'span', 'ul', 'ol', 'dl', 'table', 'tbody',
  'thead', 'section', 'main', 'header', 'footer', 'nav', 'article', 'aside', 'p',
]);

function genericContainerViolation(expect) {
  const t = String(expect || '').trim().toLowerCase();
  if (!t || looksLikeCss(t)) return null; // CSS 形态交给 Fix A 校验，此处只管裸词
  if (GENERIC_CONTAINER_TAGS.has(t)) {
    return `element 证据 expect "${expect}" 是泛化容器标签——语义解析词表不含该词（必然落空），`
      + '且「任何页面都存在」毫无业务区分度，不能构成动作成功的证据。请改写为：'
      + '动作完成后真实出现的业务元素（语义描述如「导出按钮」，或 CSS 选择器如 #exportBtn/.result-list），'
      + '或改用 action_success。';
  }
  return null;
}

function validateAttrClause(inner) {
  const t = inner.trim();
  if (!t) return false;
  return /^[A-Za-z_][\w-]*\s*(?:[~^|$*]?=)[\s\S]*$/.test(t) || /^[A-Za-z_][\w-]*$/.test(t);
}

function validateCssCompound(c) {
  if (!c) return false;
  // 抽出 [attr] 子句（允许属性值含任意字符），只对括号外内容做语法校验
  let out = '', depth = 0, buf = '', inStr = null;
  const attrs = [];
  for (const ch of c) {
    if (depth > 0) {
      if (inStr) {
        buf += ch;
        if (ch === inStr) inStr = null; // 引号闭合（append 后必须 continue，防重开）
        continue;
      }
      if (ch === "'" || ch === '"') { inStr = ch; buf += ch; continue; }
      if (ch === '[') { depth++; buf += ch; continue; }
      if (ch === ']') {
        depth--;
        if (depth === 0) { attrs.push(buf); buf = ''; continue; }
        buf += ch; continue;
      }
      buf += ch; continue;
    }
    if (ch === '[') { depth = 1; buf = ''; continue; }
    out += ch;
  }
  if (depth !== 0) return false; // 括号不平衡
  if (attrs.some((a) => !validateAttrClause(a))) return false;
  // 括号外：禁止非 ASCII、引号残留、裸等号（id=regForm / class=foo 即在此拒绝）
  if (/[^\x00-\x7F]/.test(out)) return false;
  if (/=|["'[]/.test(out)) return false;
  // 每个 simple selector：tag | * | #id | .class | 伪类(可带参)
  // 纯属性 compound（如 [aria-label='商品列表']）无 simple 部分，属合法 CSS
  const simples = out.split(/[\s>+~]+/).filter(Boolean);
  if (!simples.length && !attrs.length) return false;
  return simples.every((s) => /^(?:\*|[A-Za-z][\w-]*|#[A-Za-z_][\w-]*|\.[A-Za-z_][\w-]*|::?[A-Za-z][\w-]*(?:\([^()]*\))?)$/.test(s));
}

function isValidCssSelectorShape(sel) {
  const s = String(sel || '').trim();
  if (!s) return false;
  const parts = s.split('>>').map((p) => p.trim());
  if (parts.some((p) => !p)) return false;
  return parts.every(validateCssCompound);
}

// 收集一个 strict step 中全部 element 类证据 expect 并校验 CSS 形态；返回错误列表
function cssEvidenceViolations(s) {
  const specs = [];
  const v = s.verification;
  if (v && CSS_EVIDENCE_TYPES.includes(v.type) && typeof v.expect === 'string' && v.expect.trim()) {
    specs.push({ where: 'verification', expect: v.expect });
  }
  const bs = s.expectedBusinessState;
  const collect = (arr, label) => (Array.isArray(arr) ? arr : []).forEach((r, i) => {
    if (r && CSS_EVIDENCE_TYPES.includes(r.type) && typeof r.expect === 'string' && r.expect.trim()) {
      specs.push({ where: `${label}[${i}]`, expect: r.expect });
    }
  });
  if (bs) {
    collect(bs.requiredEvidence, 'requiredEvidence');
    collect(bs.forbiddenEvidence, 'forbiddenEvidence');
  }
  const errs = [];
  specs.forEach((sp) => {
    const gv = genericContainerViolation(sp.expect);
    if (gv) { errs.push(`${sp.where}: ${gv}`); return; }
    if (looksLikeCss(sp.expect) && !isValidCssSelectorShape(sp.expect)) {
      errs.push(`${sp.where}: element 证据 expect "${sp.expect}" 呈 CSS 选择器形态但语法非法`
        + '（如 id=regForm 缺 #/. 前缀、括号不平衡、括号外含非法字符）——请修正为合法选择器'
        + '（#id / .class / tag / [attr=\'值\']），或改用页面上真实存在的语义描述/文本证据');
    }
  });
  return errs;
}

// A1：navigate 冒充 fill 守卫（确定性窄口径）——
// Final100 P2 taxonomy A1（rw.099 铁证）：描述「在搜索框中输入商品关键词」但
// action=navigate，verification=element_present input#q（输入框存在即过，值从未输入）
// → 后续搜索验证恒假 → VERIFY_FAILED ×4。navigate 只打开页面、永远不会输入值。
// 判定 = 组合动词短语模式（避免「输入框正常展示」类名词短语误报），semantic 与
// expectedResult 逐 part 独立判定（一个 part 的导航词不遮蔽另一个 part 的 fill 语义）；
// part 内含导航宾语（网址/地址栏/URL/页面/访问/打开…）则该 part 保守放行——
// 「输入网址」「在地址栏输入网址并访问」等合法导航零误伤。
const NAV_FILL_PATTERNS = [
  /在[^，。；,.;\s]{0,12}(?:框|表单|字段|输入位)(?:中|内|里)?(?:输入|填写|填入|键入)/,
  /(?:输入|填写|填入|键入)[^，。；,.;\s]{0,12}(?:到|至|进)[^，。；,.;\s]{0,8}(?:框|表单|字段)/,
  /(?:填写|填入|键入)[^，。；,.;\s]{0,8}(?:表单|字段)/,
  /\bfill\w*\b[^.?!]{0,30}\b(?:input|field|textbox|search ?box|form)\b/i,
  /\b(?:enter|inputt|typ)\w*\b[^.?!]{0,30}\b(?:in|into)\b[^.?!]{0,30}\b(?:input|field|textbox|search ?box|form)\b/i,
];
const NAV_OBJ_RE = /(网址|地址栏|链接|页面|导航|访问|跳转|打开|url|https?:\/\/)/i;

function navigateFillViolations(s) {
  if (s.action !== 'navigate') return [];
  const parts = [s.semantic, s.expectedResult]
    .filter((x) => typeof x === 'string' && x.trim());
  const hit = parts.find((p) => !NAV_OBJ_RE.test(p) && NAV_FILL_PATTERNS.some((re) => re.test(p)));
  if (!hit) return [];
  return ['semantic/expectedResult 描述的是「向字段输入内容」（'
    + hit.trim().slice(0, 60)
    + '）但 action=navigate —— navigate 只打开页面、永远不会输入值，后续依赖该值的验证必然失败。'
    + '请拆分为 navigate（打开页面）+ fill（输入值，target 用 {field, semantic}）两步'];
}

// 与 schema/action.js 的 TARGET_KEYS 保持一致（action.js 未导出，此处本地定义单一真源）
const TARGET_KEYS = ['semantic', 'role', 'field', 'text', 'selector', 'index', 'url'];

const STEP_TYPES = ['NAVIGATE', 'OBSERVE', 'ACT', 'VERIFY', 'EXTRACT'];

const INSTRUCTIONS = `输出 JSON 格式的 Plan：
{
  "goal": "一句话目标",
  "steps": [
    {
      "id": "step_001",
      "type": "NAVIGATE|OBSERVE|ACT|VERIFY|EXTRACT",
      "description": "步骤说明",
      "expectedOutcome": "预期结果",
      "risk": "LOW|MEDIUM|HIGH|CRITICAL",
      "action": { "type": "...", "target": { "semantic|field|role|text": "..." }, "risk": "...", "verification": { "type": "...", "expect": "..." }, "expectedBusinessState": { "stateType": "LOGIN_SUCCESS|SEARCH_SUCCESS|FORM_SUBMIT_SUCCESS|FIELD_FILLED|SELECTED|CHECKED|NAVIGATED|CONFIRMATION|DOWNLOAD|GENERIC_STATE|CUSTOM", "expected": "业务结果描述", "requiredEvidence": [{"type":"text_present","expect":"..."}], "forbiddenEvidence": [{"type":"text_present","expect":"error"}], "evidenceLogic": "AND|OR" } }
    }
  ]
}`;

// 校验 Plan；返回 { ok, plan?, errors[] }
function validatePlan(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['Plan 必须是对象'], instructions: INSTRUCTIONS };
  }

  if (typeof raw.goal !== 'string' || !raw.goal.trim()) errors.push('goal 缺失或为空');
  if (!Array.isArray(raw.steps) || !raw.steps.length) {
    errors.push('steps 必须是非空数组');
    return { ok: false, errors, instructions: INSTRUCTIONS };
  }

  const steps = [];
  raw.steps.forEach((s, i) => {
    const e = [];
    const step = { id: null, type: 'ACT', description: '', expectedOutcome: '', risk: 'MEDIUM', action: null };
    if (!s || typeof s !== 'object') { errors.push(`steps[${i}] 不是对象`); return; }
    if (typeof s.id === 'string' && s.id.trim()) step.id = s.id; else e.push('id 缺失');
    if (STEP_TYPES.includes(s.type)) step.type = s.type; else e.push(`type 非法: ${String(s.type)}`);
    if (typeof s.description === 'string' && s.description.trim()) step.description = s.description; else e.push('description 缺失');
    if (typeof s.expectedOutcome === 'string') step.expectedOutcome = s.expectedOutcome;
    if (RISK_LEVELS.includes(s.risk)) step.risk = s.risk;
    else if (s.action && RISK_LEVELS.includes(s.action.risk)) step.risk = s.action.risk; // 从 action.risk 兜底
    else e.push(`risk 非法: ${String(s.risk)}`);
    if (s.action) {
      const ar = validateAction(s.action);
      if (ar.ok) step.action = ar.action;
      else e.push(`action 非法: ${ar.errors.join('; ')}`);
    }
    if (e.length) errors.push(`steps[${i}](${s.id || '?'}): ${e.join('; ')}`);
    steps.push(step);
  });

  if (errors.length) return { ok: false, errors, instructions: INSTRUCTIONS };

  return { ok: true, plan: { goal: raw.goal.trim(), steps } };
}

// ============================================================================
// Phase 2：Provider 严格输出 Schema（provider.plan 边界契约）
// LLM（DeepSeek/OpenAI）必须输出以下形状，经 validatePlanStrict 校验后才被接受：
// {
//   steps: [
//     {
//       action:        ACTION_TYPES 之一,
//       target:        字符串（url 或语义描述）或对象 {semantic|url|field|text|role|selector|index},
//       semantic:      自然语言步骤意图,
//       expectedResult: 执行成功后的可观测结果（用于验证）,
//       value?:        fill/press 需要,
//       credentialRef?: 敏感字段引用
//     }
//   ]
// }
// 该 Schema 是「LLM 输出契约」，与运行时消费的「规范化 Step」解耦：
// planner 收到严格 steps 后通过 normalizeStrictToCanonical 映射为运行时 Step。
const PLAN_STRICT_INSTRUCTIONS = `输出 JSON 格式的 Plan：
{
  "steps": [
    {
      "action": "navigate|click|fill|submit|login|extract|inspect|...",
      "target": { "field": "email|username|password|search|loginBtn|...", "semantic": "中文语义描述，如 企业邮箱 / 登录按钮" },
      "semantic": "这一步要做什么（自然语言）",
      "expectedResult": "执行成功后的可观测结果（用于验证）",
      "verification": { "type": "text_present|element_present|url_contains|url_pattern|storage|action_success|login_state|page_change", "expect": "预期出现的文本或 URL 片段（action_success 可不填 expect）" },
      "expectedBusinessState": { "stateType": "LOGIN_SUCCESS|SEARCH_SUCCESS|FORM_SUBMIT_SUCCESS|FIELD_FILLED|SELECTED|CHECKED|NAVIGATED|CONFIRMATION|DOWNLOAD|GENERIC_STATE|CUSTOM", "expected": "业务结果描述", "requiredEvidence": [{"type":"text_present|element_present|url_contains|url_pattern|storage|element_absent|login_state","expect":"...","pattern":"url_pattern 用","storageType":"localStorage|sessionStorage（storage 用）","key":"storage 用","equals":"storage 可选期望值"}], "forbiddenEvidence": [{"type":"text_present","expect":"error"}], "evidenceLogic": "AND|OR", "persistAfterReload": "可选 true：仅限应跨刷新持续的状态，开启后 reload 二次验证" },
      "value": "仅 fill/press 需要：填入的值（敏感字段必须用 credentialRef 代替；任务提供了凭据清单时，email/username/账号等身份字段也必须用 credentialRef 代替）",
      "credentialRef": "可选：敏感字段引用名（password/card/cvv 等必须用；凭据清单非空时 email/username 等身份字段也必须用）"
    }
  ]
}
约束：
- action 仅允许: ${ACTION_TYPES.join(', ')}
- target 必须是对象 {field, semantic}（field 用于精确匹配 name/id/placeholder/aria-label/label，semantic 为中文语义）。navigate 可用 {url}。
- navigate 用 url；click/fill/submit 用 {field, semantic} 双键。
- fill/press 必须提供 value 或 credentialRef；敏感字段（password/card/cvv/otp/token）必须用 credentialRef，禁止 value 字面量。
- 凭据字段契约：任务上下文提供了可用凭据清单时，身份类字段（email/邮箱/username/账号/登录名）必须用 credentialRef 引用清单中的原样 id，禁止编造 value —— 违反会被拒绝并要求重规划。仅当清单为空或全部不可用时才允许对非敏感字段用 value。凭据清单为空时，禁止在任何步骤输出 credentialRef 字段（执行期必然不可用并直送人工升级）—— 非敏感字段用 value，敏感字段动作不要规划。
- VERIFICATION 强制：每个 click / fill / submit 步骤都必须包含 verification（type 非空 none）或 expectedBusinessState 业务完成契约，二者至少其一；禁止仅用 action_success 作为完成证据。
- expectedBusinessState 验证「业务结果」而非「动作执行」：必须含 requiredEvidence（可多条，evidenceLogic=AND/OR）与 forbiddenEvidence（错误信号）。stateType 从固定集合选取。
- 登录证据契约：stateType=LOGIN_SUCCESS 的 requiredEvidence 禁止全部为 URL 类证据（url_contains/url_pattern 在 URL 不变的站点上恒假）——必须至少含一条 element_present/text_present 类「登录成功后才出现的内容」证据；URL 类证据只能与内容类证据以 OR 组合。违反会被拒绝并要求重规划。
- element 证据 expect 契约：element_present/element_absent 的 expect 只允许两种形态——① 合法 CSS 选择器（#id / .class / tag / [attr='值']；id=regForm 这类缺 #/. 前缀或括号不平衡的写法会被拒绝并要求重规划）；② 页面上真实存在的语义描述（如「登录按钮」「商品列表容器」，禁止臆造页面中不存在的元素名）。text_present 的 expect 必须是成功后页面真实会出现的文本，禁止臆造文案。
- navigate 只用于打开页面/跳转 URL：若某步要向输入框/表单字段输入内容（如「在搜索框中输入关键词」），禁止用 navigate（它永远不会输入值，会被 schema 拒绝并要求重规划）——必须拆为 navigate（打开页面）+ fill（输入值）两步；navigate 的描述应包含导航宾语（网址/页面/访问/打开）。
- expectedResult 必须描述成功后页面可观测状态，作为 verification / expectedBusinessState 依据。
- 不要臆造 objective 中不存在的步骤；纯导航任务只需 navigate→inspect`;

function validatePlanStrict(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['Plan 必须是对象'] };
  }
  if (!Array.isArray(raw.steps) || !raw.steps.length) {
    errors.push('steps 必须是非空数组');
    return { ok: false, errors };
  }
  const steps = [];
  raw.steps.forEach((s, i) => {
    const e = [];
    if (!s || typeof s !== 'object') { errors.push(`steps[${i}] 不是对象`); return; }
    if (typeof s.action !== 'string' || !ACTION_TYPES.includes(s.action)) {
      e.push(`action 非法: ${String(s.action)}`);
    }
    // target 必须存在：字符串（url/语义）或对象（含任一 TARGET_KEYS）
    let hasTarget = false;
    if (typeof s.target === 'string' && s.target.trim()) hasTarget = true;
    else if (s.target && typeof s.target === 'object' && TARGET_KEYS.some((k) => s.target[k] != null && s.target[k] !== '')) hasTarget = true;
    if (!hasTarget) e.push('target 缺失（字符串 url/语义 或 对象）');
    if (typeof s.semantic !== 'string' || !s.semantic.trim()) e.push('semantic 缺失');
    if (typeof s.expectedResult !== 'string' || !s.expectedResult.trim()) e.push('expectedResult 缺失');
    // Phase 7 Step 2-B：verification 校验（类型合法 + MUST_VERIFY 动作强制）
    const v = s.verification;
    if (v != null) {
      if (typeof v !== 'object' || !VERIFICATION_TYPES.includes(v.type)) {
        e.push('verification.type 非法: ' + (v && v.type));
      }
    }
    if (MUST_VERIFY.includes(s.action)) {
      if (!v || !v.type || v.type === 'none') {
        e.push(`${s.action} 必须提供有意义的 verification（text_present/element_present/url_contains/action_success 等，禁止 none）`);
      }
    }
    // Fix A：element 证据 expect 的 CSS 形态语法守卫（语义中文 expect 不受限）
    const cssErrs = cssEvidenceViolations(s);
    if (cssErrs.length) e.push(...cssErrs);
    // Fix A1：navigate 冒充 fill 守卫（确定性窄口径，语义含导航宾语时放行）
    const navFillErrs = navigateFillViolations(s);
    if (navFillErrs.length) e.push(...navFillErrs);
    if (e.length) errors.push(`steps[${i}]: ${e.join('; ')}`);
    else steps.push({
      action: s.action,
      target: s.target,
      semantic: s.semantic,
      expectedResult: s.expectedResult,
      // 透传 verification（禁止丢弃）—— 缺 verification 的 MUST_VERIFY 步骤已在上方被拒绝，
      // 此处若仍为 undefined 仅出现在绕过 validatePlanStrict 的非正常路径，交由下游 fail-loud。
      verification: s.verification || null,
      // Phase 11：透传 expectedBusinessState 业务完成契约（验证业务结果而非动作执行）
      expectedBusinessState: s.expectedBusinessState || null,
      value: s.value !== undefined ? s.value : null,
      credentialRef: s.credentialRef || null,
    });
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, plan: { goal: raw.goal || '任务', steps } };
}

// 严格 Step → 规范化运行时 Step（供 runtime/tools/verification 消费）
const STEP_TYPE_MAP = { navigate: 'NAVIGATE', inspect: 'OBSERVE', observe: 'OBSERVE', extract: 'EXTRACT', verify: 'VERIFY', check: 'VERIFY' };
const MUST_VERIFY = ['click', 'fill', 'select', 'check', 'submit', 'purchase', 'payment', 'login', 'logout', 'password_change', 'delete', 'update_account_settings'];

function normalizeTarget(t) {
  if (typeof t === 'string') {
    if (/^https?:\/\//i.test(t) || t.startsWith('/')) return { url: t };
    return { semantic: t };
  }
  if (t && typeof t === 'object') return t;
  return {};
}

function normalizeStrictToCanonical(strictPlan, goalText) {
  const steps = (strictPlan.steps || []).map((s, i) => {
    const type = s.action;
    const risk = TYPE_RISK_FLOOR[type] || 'MEDIUM';
    // Phase 7 Step 2-B：透传 LLM 提供的 verification（禁止静默补 none / 禁止自动补 action_success）。
    // 仅当未提供时回退 none；MUST_VERIFY 缺 verification 已在 validatePlanStrict 拒绝，
    // 正常路径下此处必能拿到非 none 的 verification。
    let verification;
    if (s.verification && s.verification.type && s.verification.type !== 'none') verification = s.verification;
    // 关键交互动作缺 verification 且无 expectedBusinessState：不静默补 none，
    // 置 null 交由 runtime.buildEffectiveVerification 从 action.type 推导业务完成契约（Phase 11 设计）。
    // 仅当非关键动作（navigate/scroll 等）才回退 none。
    else if (MUST_VERIFY.includes(type) && !s.expectedBusinessState) verification = null;
    else verification = { type: 'none' };
    return {
      id: `step_${String(i + 1).padStart(3, '0')}`,
      type: STEP_TYPE_MAP[type] || 'ACT',
      description: s.semantic || '',
      expectedOutcome: s.expectedResult || '',
      risk,
      action: {
        type,
        target: normalizeTarget(s.target),
        value: s.value !== undefined ? s.value : null,
        credentialRef: s.credentialRef || null,
        risk,
        verification,
        // Phase 11：透传业务完成契约（验证业务结果而非动作执行）
        expectedBusinessState: s.expectedBusinessState || null,
      },
    };
  });
  return { goal: goalText || strictPlan.goal || '任务', steps };
}

module.exports = {
  validatePlan, INSTRUCTIONS, STEP_TYPES,
  PLAN_STRICT_INSTRUCTIONS, validatePlanStrict, normalizeStrictToCanonical,
  // Fix A：element 证据 expect CSS 形态守卫（导出供针对性测试）
  isValidCssSelectorShape, cssEvidenceViolations,
  navigateFillViolations,
};
