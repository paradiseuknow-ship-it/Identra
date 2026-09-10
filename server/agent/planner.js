'use strict';

// Planner：Objective → Plan（必须通过 schema/plan.js 校验，非法拒绝）。
//
// 5.9-E 修复（接口契约缺陷）：原实现无条件调用 provider.plan(ctx, task)，
// 但 deepseek/openai 等真实 provider 仅实现 chat（无 raw.plan），
// 导致 TypeError: raw.plan is not a function。
//
// 改为「能力检测 + 统一 Provider Contract」：
//   provider.plan      → 有（如 mock）  → 调用 plan，期望返回步骤数组
//   provider.plan      → 没有           → 降级用 provider.structured（如 deepseek/openai，底层走 chat）
//     provider.structured → 有           → 调用 structured，传入 Plan Schema，取 JSON 作为 Plan 草稿
//   都没有                          → 明确返回 PLANNER_PROVIDER_CAPABILITY_ERROR
// 这样以后换 OpenAI / DeepSeek / 其他 Provider，不会再出现隐式接口 TypeError。

const fs = require('fs');
const { validatePlan, INSTRUCTIONS, normalizeStrictToCanonical } = require('./schema/plan');
// C105 F4：replan 产出步骤的 selector 接地判定与 semanticResolver 同源
const semanticResolver = require('./semanticResolver');
// UPLOAD_ROOT：提示里要列出可上传文件，与 schema 的白名单必须同源（否则提示与校验会漂移）
const { ACTION_TYPES, VERIFICATION_TYPES, UPLOAD_ROOT } = require('./schema/action');
// 注意：plannerEvidence.js 导出名为 record（非 recordPlannerEvidence），此处用别名绑定，
// 否则解构得到 undefined → 调用抛 TypeError 被下方 catch 静默吞掉 → 证据永不落库（真实缺陷）。
const { record: recordPlannerEvidence } = require('./plannerEvidence');
// TARGET_KEYS 未在 action.js 导出，这里复用同一定义（与 schema/action.js 保持一致）
const TARGET_KEYS = ['semantic', 'role', 'field', 'text', 'selector', 'index', 'url'];
const stepManager = require('./stepManager');
// STEP 1：凭据在规划期可见性修复。
// 取证（phase68 100-task）：真实 LLM 路径的规划 prompt 中 credential 出现次数为 0
// （只有 mock 的 taskLike 命中），因此 Planner 只能靠猜 —— 实测产出 credentialRef:"cvv"
// 这类编造引用，执行期落到 CREDENTIAL_UNAVAILABLE → HUMAN_ESCALATION。
// 修复：把任务挂载的凭据以「脱敏视图」注入 prompt（ref + type + available + masked），
// 明文永不出 Vault。
const secretManager = require('./secretManager');

// 5.9-E 修复：把 Action 级别的关键约束合并进交给 LLM 的 instructions，
// 避免 DeepSeek 产出「target.semantic=占位符 / navigate 缺 url / fill 缺 value」等非法结构。
// 注意：这只是把【已有 schema 规则】文本化喂给模型，不改变校验逻辑本身（校验仍在 schema/plan·action）。
// Phase 7 Step 2-B：强化「每个交互动作必须可验证」与「target 双键定位」契约。
// P4/P5 单一事实源：与 deepseek.js（真实 LLM 执行路径）共享同一份契约文本，禁止双份漂移。
const {
  P4_CONTRACT,
  P5_CONTRACT,
  P6_CONTRACT,
  R8_CONTRACT,
  R9_CONTRACT,
  SEMANTIC_LANG_CONTRACT,
  CROSS_ORIGIN_CONTRACT,
  NATIVE_SIGNUP_CONTRACT,
} = require('./plannerContractText');

const ACTION_CONSTRAINTS = [
  '每个 step 必须含 action 对象。',
  `action.type 仅允许: ${ACTION_TYPES.join(', ')}。`,
  `action.target 至少提供以下之一: ${TARGET_KEYS.join(', ')}。`,
  'NAVIGATE 动作必须用 action.target.url（字符串，可为相对路径如 "/"），不要用 semantic 占位。',
  'OBSERVE/INSPECT 用 action.target.role="page" 或语义描述。',
  // C105 F9（真实站点实证 task_mtucbulim7n6a）：旧契约要求 semantic 用「中文语义描述」，
  // 而 C104b 又要求逐字引用页面原文——两条约束自相矛盾。首步规划时页面尚未打开（无观察清单），
  // 模型只能遵循本条 → 产出「Get started 按钮」「注册邮箱输入框」等中文意译语义；
  // 经 F1 零证据拒点后与英文/法文页面零词法交集 → 解析零候选 + element_present 验证恒失败
  // （实证：4 次 VERIFY_FAILED 同签名 → 熔断升级）。真实信号是页面原文，不是翻译。
  'target 定位应使用「双键」：field（如 email/username/password/search，用于精确匹配 name/id/placeholder/aria-label/label）+ semantic。两者都提供时定位最稳。',
  // C106 F22：文本上移到 plannerContractText.SEMANTIC_LANG_CONTRACT —— 本条此前只存在于本文件，
  // 真实 LLM 路径（deepseek.js）仍明文要求「中文语义描述」，两处矛盾（第 7 轮 25 次
  // ELEMENT_NOT_FOUND 铁证）。共享常量后两条路径同源，禁止再各自硬编码。
  SEMANTIC_LANG_CONTRACT,
  // C106 F21：跨域边界（第三方授权域禁止填凭据），同源同步。
  CROSS_ORIGIN_CONTRACT,
  // C106 F23：注册类任务必须走站点自身分步表单，不得把第三方 OAuth 授权当注册手段。
  NATIVE_SIGNUP_CONTRACT,
  '【首步导航契约】任务提供了入口地址（targetUrl）时，计划第一步必须是 navigate 打开该地址，之后才允许对页面元素做 click/fill。禁止把 navigate 排到后续步骤而在未打开页面时就操作元素。',
  // C105 F11（真实站点实证 task_mtucm6q7dbnin）：模型把 CTA 文案（"Start for free"）与编造的
  // DOM id（"continue-nav"）写进 field；field 会被拿去做 name/id/placeholder/aria-label 精确
  // 匹配，臆造值必然匹配不到（实证：humanClick element not found: #continue-nav 连续 10+ 次）。
  '【field 契约（硬性）】field 只能是两类值：① 通用字段语义键（email/username/password/search/card/cvv/expiry/zip/city/address/phone 等）；② 观察清单中元素的真实 name/id/placeholder 原文。**禁止把按钮/链接文案当 field（如 "Start for free"、"Get started"），也禁止编造 DOM id（如 "continue-nav"、"signup-submit"）** —— 臆造 field 必然匹配不到元素并触发「未找到」。不确定时宁可省略 field，只给 semantic。',
  // 同上实证：navigate 到联盟入口后，url_contains "webflow.com" 在动作前就成立（入口域名本身），
  // 被 P2 无效证据守卫拒绝 4 次，真实到达的导航被判失败。契约层必须避免这类无区分度证据。
  '【navigate 证据契约】navigate 步骤的 url_contains/url_pattern 的 expect **不得是入口地址已有的域名或路径片段**（如入口是 https://try.webflow.com/xxx 时禁止用 "webflow.com" 作成功证据——它在动作前就成立，会被判为无效证据）。打开落地页类步骤应改用落地页真实存在的元素/文案做证据（element_present/text_present，用站点语言原文），或用目标页特有路径片段。',
  `fill/press 必须提供 action.value（普通字段）或 action.credentialRef（敏感字段），二者至少其一。`,
  'fill/press 敏感字段（password/card/cvv/otp/token 等）必须用 credentialRef 引用，禁止 value 字面量（安全约束，不可违反）。',
  'P1 凭据字段契约：当任务上下文提供了可用凭据清单时，身份类字段（email/邮箱/username/账号/登录名）同样必须用 action.credentialRef 引用凭据清单中的原样 id，禁止自行编造 value（清单里的凭据就是该站点正确用户名，编造必然登录失败并触发人工升级）。仅当凭据清单为空或全部不可用时，才允许对非敏感字段使用 value。凭据清单为空时，禁止在任何步骤输出 credentialRef 字段（执行期必然 CREDENTIAL_UNAVAILABLE 并直送人工升级）——非敏感字段一律用 value，敏感字段动作不要规划。',
  'P3 登录证据契约：stateType=LOGIN_SUCCESS 的 requiredEvidence 禁止全部为 URL 类证据（url_contains/url_pattern）。登录是否成功只能由「登录成功后才出现的内容」证明（element_present/text_present，如看板标题/用户名/退出按钮/仪表盘文本）；URL 类证据只能与内容类证据以 OR 组合作为补充。单凭 url_contains "dashboard" 判登录成功在 URL 不变的单页应用上恒假，会被拒绝并要求重规划。',
  `action.verification.type 仅允许: ${VERIFICATION_TYPES.join(', ')}。`,
  'VERIFICATION 强制：每个 click / fill / submit 步骤都必须提供有意义的 verification（type 非空 none）。这是硬性要求，缺少将被拒绝。',
  'verification 优先使用可观测判定：text_present（页面出现某文本）/ element_present（某元素出现）/ url_contains（URL 变化；expect 必须是动作执行前 URL 中不存在的片段 —— 若入口 URL 已包含该片段，验证将被判为无效证据而失败，如登录页为 /saas/login.html 时不得用 "saas" 作成功证据，应改用 text_present/element_present/storage）/ url_pattern（URL 正则匹配，形如 {"type":"url_pattern","pattern":"/dashboard$"}，同理 pattern 不得在动作前已匹配）/ storage（Web Storage 键存在或等值，形如 {"type":"storage","storageType":"localStorage","key":"authenticated","equals":"true"}，敏感键由观察层自动脱敏）；无可观测量时用 action_success。',
  'url_contains/url_pattern 只用于「确信动作成功后浏览器会跳转到新 URL」的场景。若无法从页面/任务上下文确认会发生 URL 跳转（典型：单页应用登录成功后在原页面原地展开面板/看板，URL 完全不变），必须改用 element_present 或 text_present（登录成功后才出现的元素/文本，如看板标题、用户名、退出按钮），禁止凭猜测写 url_contains "dashboard" 类证据 —— URL 不变的站点上该证据恒假，会把真实成功误判为失败。',
  // C105 F9：同上语言契约同步到证据面——中文 expect（"注册入口按钮"）在英文页零匹配会被判
  // required unmet，把真实到达的成功导航误判为失败（实证同上）。
  'P2 element 证据 expect 契约：element_present/element_absent 的 expect 只允许两种形态——① 合法 CSS 选择器（#id / .class / tag / [attr=\'值\']；id=regForm 这类缺 #/. 前缀、括号不平衡的写法会被 schema 拒绝并要求重规划）；② 站点语言下页面真实存在的语义描述（英文站写 "Sign up form"/"Dashboard"，禁止中文意译如「注册入口按钮」，也禁止臆造页面中不存在的元素名，如从未出现过的 id=regForm/productSpecs）。text_present 的 expect 必须是成功后页面真实会出现的文本（同样用站点语言原文），禁止臆造文案。',
  'navigate 冒充 fill 禁令：navigate 只打开页面、永远不会输入值。凡需要向输入框/表单字段输入内容（如「在搜索框中输入关键词」）的步骤禁止用 navigate（会被 schema 拒绝并要求重规划）——必须拆为 navigate（打开页面）+ fill（输入值，target 用 {field, semantic}）两步；navigate 步骤的 semantic/expectedResult 应包含导航宾语（网址/页面/访问/打开）。',
  P4_CONTRACT,
  P5_CONTRACT,
  P6_CONTRACT,
  R8_CONTRACT,
  R9_CONTRACT,
  '每个 step 的 expectedOutcome 必须描述「执行成功后页面应出现的可观测状态」，作为 verification 的依据。',
  'submit/login/purchase 等高风险动作同样必须提供有意义的 verification.type。',
  '不要臆造任务 objective 中不存在的 fill/click 步骤；纯导航任务只需 NAVIGATE→OBSERVE→VERIFY。',
  // Phase 11 — ExpectedBusinessState 业务完成契约（核心）
  '【强制】每个交互动作（login / search / fill / submit / select / check / click 提交类）必须输出 expectedBusinessState 业务完成契约，验证「业务结果」而不是「动作执行」。',
  'expectedBusinessState.stateType 必须从固定集合选取：LOGIN_SUCCESS / SEARCH_SUCCESS / FORM_SUBMIT_SUCCESS / FIELD_FILLED / SELECTED / CHECKED / NAVIGATED / CONFIRMATION / DOWNLOAD / GENERIC_STATE / CUSTOM。',
  'expectedBusinessState 必须含 requiredEvidence（至少一条，可用 text_present/element_present/url_contains/element_absent/login_state/url_pattern/storage，多条用 evidenceLogic=AND/OR 组合）与 forbiddenEvidence（绝不出现的错误信号）。',
  '若业务状态应跨页面刷新持续（登录态、服务端落库标志），可在 expectedBusinessState 显式声明 persistAfterReload:true（可选 reloadTimeoutMs 毫秒数）：验证器在首次验证成功后 reload 页面，用全新观察做二次合约验证，任一次失败即整体失败；默认不开启，非持久状态禁止声明。',
  '禁止把 action_success 当作业务完成证据；action_success 只允许用于非关键/纯观测动作。',
  'verification 与 expectedBusinessState 都必须能从 objective 推导，禁止凭空臆造预期结果。',
  // STEP 7：只把六个动作登记进 ACTION_TYPES 是不够的 —— 上面那行 "action.type 仅允许: ..."
  // 会把名字列出来，但模型不知道每个动作的参数长什么样，照样产出非法结构。
  '【悬浮菜单】需要先悬浮才展开的菜单，用 action.type=hover 指向菜单入口，再 click 展开出来的项。hover 不需要 verification。',
  '【拖拽】action.type=drag：target 指向被拖的元素，value 是放置目标（CSS 选择器或语义描述，如 "回收站"）。缺少 value 会被拒绝。',
  '【多标签】openTab 用 target.url；switchTab / closeTab 用 target.index（0 起）或 target.url 片段。',
  '【文件上传】action.type=upload：target 指向 type=file 的输入框，target.url 必须是下面「可上传文件」列出的文件名之一（相对路径，不允许绝对路径与 ../）。',
  '【文件下载】action.type=download：target 指向触发下载的元素（导出/下载按钮）。',
  '【原生对话框】action.type=dialog：target.intent 取 accept（确认）或 dismiss（取消）。不确定语义时一律用 dismiss。',
].join('\n');

const PLANNER_INSTRUCTIONS = `${INSTRUCTIONS}\n\nAction 约束：\n${ACTION_CONSTRAINTS}`;

// upload 只允许从 UPLOAD_ROOT 取文件，但模型看不到磁盘。
// 每次规划时把暂存目录里的文件名列进提示，否则模型只能瞎猜文件名 ——
// 猜错只会拿到一句 schema 拒绝，而拒绝信息里并不会告诉它有哪些文件可用，
// 于是同一轮里反复重试、反复失败（Phase 8 的 planner 重试修复正是为这类噪声做的）。
function uploadHint() {
  try {
    fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
    const files = fs.readdirSync(UPLOAD_ROOT, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .slice(0, 20);
    return files.length
      ? `可上传文件（upload 的 target.url 只能从这里选）：${files.join(', ')}`
      : '可上传文件：当前暂存目录为空，无法上传任何文件，不要规划 upload 步骤。';
  } catch (e) {
    return '可上传文件：暂存目录不可读，不要规划 upload 步骤。';
  }
}

function plannerInstructions() {
  return `${PLANNER_INSTRUCTIONS}\n${uploadHint()}`;
}

// 5.9-E 修复：明确的能力缺失错误码，便于 Benchmark / 调用方区分「provider 契约缺陷」与「规划失败」。
const PLANNER_PROVIDER_CAPABILITY_ERROR = 'PLANNER_PROVIDER_CAPABILITY_ERROR';

// 将 ContextBuilder 产出的结构化上下文（objective/observation/steps/checkpoint/errorHistory/verification）
// 序列化为紧凑文本块，注入 LLM prompt，使 Planner 拥有完整决策上下文。
function contextBlock(ctx) {
  if (!ctx || !ctx.context) return '';
  const c = ctx.context;
  const lines = [];
  if (c.task && c.task.objective) lines.push('任务目标：' + c.task.objective);
  if (c.page && c.page.url) {
    lines.push('当前页面：' + c.page.url + (c.page.title ? '（' + c.page.title + '）' : ''));
    // Phase 9 P4（断裂点 3/3）：此前本函数只输出 url/title，page 的 textSummary 与 elements
    // 从未进入 prompt —— 即使 runtime 传了 observation，Planner 也依然看不到页面内容。
    // 修复：把真实可见文本与元素清单注入 prompt，并显式约束「契约必须取自清单，禁止臆造」。
    if (c.page.textSummary) lines.push('页面可见文本：' + c.page.textSummary);
    if (Array.isArray(c.page.elements) && c.page.elements.length) {
      lines.push('页面元素清单（写 verification.expect 与 expectedBusinessState.requiredEvidence 时，'
        + '必须从中选取真实存在的 id / name / text / ariaLabel，禁止臆造页面上不存在的标识；'
        + 'C104b：click/fill 等 target.semantic 同样必须逐字使用清单中元素的真实 text/ariaLabel/placeholder'
        + '（保留页面原语言，不做翻译或改写，例如按钮原文是 Commencer 就写 Commencer），'
        + '禁止发明清单中不存在的按钮/输入框标签——臆造标签会让语义定位必然失败）：'
        + JSON.stringify(c.page.elements));
    }
  }
  if (Array.isArray(c.steps) && c.steps.length) {
    lines.push('已有步骤（含状态，不要重复已成功的步骤）：' + JSON.stringify(
      c.steps.map((s) => ({ id: s.id, type: s.type, status: s.status, desc: s.description }))
    ));
  }
  if (c.checkpoint) lines.push('检查点（断点续跑起点）：' + JSON.stringify(c.checkpoint));
  if (Array.isArray(c.errorHistory) && c.errorHistory.length) {
    lines.push('历史错误（避免重蹈覆辙）：' + JSON.stringify(c.errorHistory));
  }
  if (c.verification) lines.push('当前验证状态：' + JSON.stringify(c.verification));
  // CAP-K2：Router 失败经验进 prompt（与 deepseek.buildContextSection 同步——两个序列化点都要改）
  if (c.routerHints && Array.isArray(c.routerHints.warnings) && c.routerHints.warnings.length) {
    lines.push('Router 经验提示（来自历史失败/站点记忆，规划时主动规避，禁止据此臆造契约）：'
      + c.routerHints.warnings.join('；'));
  }
  if (!lines.length) return '';
  return '\n\n任务上下文（Task Context，由 ContextBuilder 提供）：\n' + lines.join('\n');
}

// 凭据上下文块（脱敏）。返回 '' 表示无凭据可声明。
// 只输出：id / type / site / label / available / maskedEmail / maskedCard —— 无任何明文字段。
function credentialBlock(credentialRefs) {
  const refs = Array.isArray(credentialRefs) ? credentialRefs.filter(Boolean) : [];
  if (!refs.length) {
    // P1 空集反向守卫的 prompt 层同步：空清单不再是「静默无提示」，
    // 显式禁止 credentialRef，避免模型照抄输出示例中的 credentialRef 字段。
    return '\n\n可用凭据：本任务未提供任何凭据清单 —— 禁止在任何步骤输出 credentialRef 字段'
      + '（执行期凭据必然不可用并直送人工升级）。非敏感字段用 value 填写；若任务必须使用敏感字段，'
      + '不要规划该动作，改为导航+观察并在计划中说明需要人工提供凭据。';
  }
  const lines = [];
  for (const ref of refs) {
    let view = null;
    try {
      const rec = secretManager.getByRef(ref);
      view = secretManager.maskedView(rec) || { id: ref, available: false };
    } catch (e) {
      view = { id: ref, available: false };
    }
    lines.push(
      `- credentialRef="${view.id}" type=${view.type || 'unknown'} available=${view.available === true}`
      + (view.maskedEmail ? ` maskedEmail=${view.maskedEmail}` : '')
      + (view.maskedCard ? ` maskedCard=${view.maskedCard}` : '')
      + (view.label ? ` label=${view.label}` : '')
    );
  }
  return '\n\n可用凭据（Vault 凭据引用，明文不可见）：\n' + lines.join('\n')
    + '\n规则：敏感字段（password/card/cvv/otp/token/邮箱密码）必须填写上面的 credentialRef 原样字符串；'
    + '身份类字段（email/邮箱/username/账号/登录名）同样必须填写 credentialRef 原样字符串 —— 凭据中的用户名就是该站点的正确登录身份，禁止用 value 编造任何用户名/邮箱（编造必然登录失败并触发人工升级）；'
    + '禁止填写 value 明文；禁止编造不在上表中的 credentialRef（编造会导致执行期 CREDENTIAL_UNAVAILABLE）。'
    + '上表为空或 available=false 时，不要在计划里使用任何敏感字段动作，改为安排"导航到登录页 + 观察"并交由人工提供凭据。';
}

// P1 凭据字段契约守卫（确定性，不依赖 LLM 自觉）。
// 背景（2026-08-31 run6/run7 事件链实证）：planner 对 email 等身份字段编造 literal value
// （如 admin@cloudsaas.com），而场景真值在凭据库中（ops@cloudsaas.io）—— 登录真失败 → 升级。
// 规则：任务挂载了可用凭据时，fill 的身份类字段（email/username/账号等）必须用 credentialRef，
// 禁止 literal value。返回违规步骤描述数组，空数组 = 通过。
// 边界：凭据清单为空或全部不可用 → 不约束（不误伤无凭据的普通任务，如搜索框填词）。
const IDENTITY_FIELD_RE = /(e-?mail|mail|user[ _-]?name|account|acct|login[ _-]?name|账号|邮箱|登录名)/i;
function credentialContractViolations(steps, credentialRefs) {
  const refs = Array.isArray(credentialRefs) ? credentialRefs.filter(Boolean) : [];
  if (!refs.length) {
    // P1 空集反向守卫（2026-08-31 最终 100-task 归因驱动）：任务未提供任何凭据清单时，
    // 任何步骤带 action.credentialRef 都会在执行期 fail-closed（tools.js credentialUnavailableError
    // → CREDENTIAL_UNAVAILABLE → 直送 HUMAN_ESCALATION，不进 repair）。最终 run 中 19 个 CREDIBLE
    // 升级全部源于此 —— prompt 输出示例 step_002 无条件含 credentialRef（行为模板污染），
    // 无凭据任务照抄示例。规则：credentialRefs.length === 0 ⇒ 禁止任何步骤生成 credentialRef
    // （不分动作类型，机械出口守卫，不依赖 prompt 自觉）。
    const bad = [];
    for (const s of (Array.isArray(steps) ? steps : [])) {
      const a = s && s.action;
      if (a && a.credentialRef) {
        bad.push(`${s.id || '?'}(action.credentialRef="${a.credentialRef}" 但任务未提供任何凭据清单 `
          + '—— 执行期凭据必然不可用并将直送人工升级；非敏感字段请改用 value，敏感字段动作不要规划'
          + '（改为导航+观察并交由人工提供凭据）)');
      }
    }
    return bad;
  }
  const hasAvailable = refs.some((r) => {
    try { const rec = secretManager.getByRef(r); return !!(rec && rec.available); } catch (e) { return false; }
  });
  if (!hasAvailable) return [];
  const bad = [];
  for (const s of (Array.isArray(steps) ? steps : [])) {
    const a = s && s.action;
    if (!a || a.type !== 'fill') continue;
    const field = String((a.target && a.target.field) || '');
    if (!field || !IDENTITY_FIELD_RE.test(field)) continue;
    const hasLiteral = a.value !== undefined && a.value !== null && String(a.value) !== '';
    if (hasLiteral && !a.credentialRef) {
      bad.push(`${s.id || '?'}(field=${field}, value 已编造, 应改用 credentialRef)`);
    }
  }
  return bad;
}

// LOGIN_SUCCESS 仅 URL 证据守卫（2026-08-31，run10 实证驱动）。
// 背景：planner 习惯性为登录 click 生成 requiredEvidence=[{type:'url_contains',expect:'dashboard'}]
// 作为唯一证据。prompt 引导不足以约束（run10 复跑仍出现）。URL 不变的站点（SPA 登录成功
// 原地展开面板）上该证据恒假 → 真实成功被判 VERIFY_FAILED → repair 循环 → 超时/升级。
// 与推导合约（verification/contract.js login = 6 条 text 类 OR）的设计意图一致：
// 登录成功必须有「内容类」证据（登录后才出现的元素/文本），URL 类证据只能作补充（OR 多信号），
// 不得是唯一证据类。机械出口守卫（P1 同款模式）：validatePlan 通过后检查，违规回灌重试。
// 只拦「全部为 URL 类」；OR 混合信号放行（OR 下恒假子句无害）。
const URL_EVIDENCE_TYPES = new Set(['url_contains', 'url_pattern']);
function urlOnlyEvidenceViolations(steps) {
  const bad = [];
  for (const s of (Array.isArray(steps) ? steps : [])) {
    const ebs = s && s.action && s.action.expectedBusinessState;
    if (!ebs || ebs.stateType !== 'LOGIN_SUCCESS') continue;
    const req = Array.isArray(ebs.requiredEvidence) ? ebs.requiredEvidence.filter(Boolean) : [];
    if (!req.length) continue;
    const allUrl = req.every((e) => URL_EVIDENCE_TYPES.has(String(e && e.type)));
    if (allUrl) {
      bad.push(`${s.id || '?'}(stateType=LOGIN_SUCCESS 的 requiredEvidence 全部为 URL 类证据 `
        + req.map((e) => e.type + '="' + (e.expect || e.pattern || '') + '"').join(', ')
        + ' —— URL 不变的站点上恒假，至少补充一条 element_present/text_present 类登录后内容证据)');
    }
  }
  return bad;
}

// 敏感字段门错误标记（schema/action.js 敏感字段检查的唯一报错文案，勿改一处漏一处）。
// C72：定义从文件尾部上移到 planObjective 之前 —— 原位置在使用点之后（const TDZ 仅因
// 函数调用发生在模块初始化后才未爆雷），消除未来重构触发 ReferenceError 的隐患。
const SENSITIVE_GATE_RE = /是敏感字段，必须用 credentialRef/;

// C102：入口地址保真 —— 用户提供的 target（联盟链接/推广链接等带归因参数的深链接）是
// 业务归因入口，LLM 规划时常按语义「规范化」为域名根（try.webflow.com/xxx → webflow.com），
// 或在消息含多个 URL 时选中错误的那个，导致联盟归因丢失（实录：task_mttpxi1bc61hf）。
// 确定性强制：计划中首个 NAVIGATE 的 action.target.url 必须等于用户 target，不做语义判断、
// 不回灌重试（LLM 已被给过目标 URL，再给一次同样会漂移）——直接改写并落事件标记。
function enforceEntryUrl(plan, target) {
  if (!target || !plan || !Array.isArray(plan.steps)) return plan;
  const idx = plan.steps.findIndex((s) => s && s.type === 'NAVIGATE');
  if (idx < 0) return plan;
  const step = plan.steps[idx];
  const cur = step.action && step.action.target && step.action.target.url;
  if (cur === target) return plan;
  step.action = {
    ...(step.action || {}),
    type: (step.action && step.action.type) || 'navigate',
    target: { ...((step.action && step.action.target) || {}), url: target },
  };
  plan.entryUrlEnforced = true;
  return plan;
}

// C103：302 型入口的 URL 字符串验证恒假 —— 联盟/推广深链接（如 try.webflow.com/t0wz830c5n4y）
// 服务端 302 落地后 URL 必然变成目标域（webflow.com/?utm_...），LLM 给入口 NAVIGATE 写的
// url_contains「入口 URL 片段」验证在 302 场景下永不满足（实录 task_mttralr4v11m7：重试 4 次
// 耗尽升级人工）。这不是验证阈值问题而是验证语义错误：入口步的完成契约 = 「导航执行成功」，
// goto 本身加载失败即报错；落地页业务验证由后续 OBSERVE/ACT 的元素/文案证据承担。
// 确定性修正：入口为深链接（路径型）且入口步验证是「入口 URL 字符串类」→ 置 none 并落标记。
function relaxEntryUrlVerification(plan, target) {
  if (!target || !plan || !Array.isArray(plan.steps)) return plan;
  let deepLink = false;
  try { deepLink = new URL(target).pathname !== '/' && new URL(target).pathname.length > 1; } catch (e) { return plan; }
  if (!deepLink) return plan;
  const idx = plan.steps.findIndex((s) => s && s.type === 'NAVIGATE');
  if (idx < 0) return plan;
  const step = plan.steps[idx];
  const v = step.action && step.action.verification;
  if (!v || (v.type !== 'url_contains' && v.type !== 'url_pattern')) return plan;
  const expect = String(v.expect || v.pattern || '');
  let host = '', path = '';
  try { host = new URL(target).hostname; path = new URL(target).pathname; } catch (e) { return plan; }
  // 仅当验证期望指向「入口 URL 本身」（host 或深路径片段）才放宽；指向落地业务特征的不动
  if (expect.includes(host) || (path && expect.includes(path))) {
    step.action.verification = { type: 'none' };
    plan.entryVerifyAdjusted = true;
  }
  return plan;
}

async function planObjective({ objective, target, constraints, credentialRefs, executionMode, provider, ctx }) {
  const taskLike = {
    objective: objective || '',
    targetUrl: target || '',
    constraints: constraints || [],
    secretRefs: credentialRefs || [],
    executionMode: executionMode || 'ASSIST',
  };
  const goalText = objective || '执行任务';
  const CB = contextBlock(ctx); // 来自 ContextBuilder 的结构化上下文

  // ---- 能力检测：plan → structured 降级 ----
  // 注意：统一门面（provider.js wrap）对【所有】provider 都挂了 plan/structured 方法，
  // 但真实能力在底层 raw。deepseek/openai 的 raw 只有 chat，门面 plan 内部调 raw.plan
  // 会抛「raw.plan is not a function」。因此这里以真实可调用性为准：
  //   1) 先试 provider.plan；若抛 raw.plan/raw.chat 类「方法缺失」错误 → 视为能力缺失，降级 structured。
  //   2) 否则 structured 分支兜底。
  // 这样以后换 Provider 不会再现隐式 TypeError。
  const CAPABILITY_RE = /raw\.(plan|chat|structured) is not a function/i;
  // Phase 8 — 规划韧性修复：JSON 解析失败 / Schema 校验失败原本会让整任务崩溃（return ok:false）。
  // 现改为「最多 MAX_PLANNER_ATTEMPTS 次重试」，并把上一次拒绝原因回灌给模型重新生成。
  // 不改动 schema 规则、不弱化 password 等安全拦截、不动成功/验证逻辑、非 planner 重写（仅加重试环）。
  const MAX_PLANNER_ATTEMPTS = 3;

  // 契约缺陷（既无 plan 也无 structured 能力）一次性判定，避免无谓重试
  if (typeof provider.plan !== 'function' && typeof provider.structured !== 'function') {
    return {
      ok: false,
      error: `${PLANNER_PROVIDER_CAPABILITY_ERROR}: provider(${provider && provider.kind}) 既无 plan 也无 structured 能力`,
      code: PLANNER_PROVIDER_CAPABILITY_ERROR,
    };
  }

  // 构建 structured 调用参数；attempt>1 时把上一次拒绝原因回灌，给模型修正机会
  const buildStructuredOpts = (errorFeedback) => ({
    system: '你是严格遵循 JSON Schema 的浏览器任务规划器。只输出 JSON，不要任何解释或 Markdown 代码块之外的文字。每个 click/fill/submit 步骤都必须带 verification。'
      + (errorFeedback ? '\n\n上一次规划被拒绝，请修正以下问题后重新输出：\n' + errorFeedback : ''),
    prompt:
      `目标：${goalText}\n` +
      (target ? `入口地址（相对路径，base 为站点根）：${target}\n` : '') +
      (constraints && constraints.length ? `约束：${constraints.join('; ')}\n` : '') +
      credentialBlock(credentialRefs) +
      `请按下列 Plan Schema 与 Action 约束输出 JSON：\n${plannerInstructions()}\n\n` +
      (CB || '') +
      `输出格式示例：{ "goal": "...", "steps": [ ` +
      `{ "id":"step_001","type":"NAVIGATE","description":"打开页面","expectedOutcome":"页面加载","risk":"LOW","action":{ "type":"navigate","target":{ "url":"${target || '/'}" },"risk":"LOW" } },` +
      // C105 F9：示例此前用中文意译 semantic/expect，模型照抄（真实站点实证）→ 改为站点语言原文示例
      `{ "id":"step_002","type":"ACT","description":"填写邮箱","expectedOutcome":"邮箱输入框已填入凭据中的用户名","risk":"MEDIUM","action":{ "type":"fill","target":{ "field":"email","semantic":"Work email" },"credentialRef":"cred_xxx","risk":"MEDIUM","verification":{ "type":"text_present","expect":"Welcome" } } },` +
      `（上例 step_002 的 credentialRef 字段仅在任务提供了凭据清单时才允许存在：cred_xxx 必须替换为「可用凭据」清单中的原样 id，凭据清单非空时 email/username 等身份字段禁止用 value 编造；凭据清单为空时禁止在任何步骤输出 credentialRef 字段 —— step_002 应改用 value 填写或整体省略该字段，违反任一规则都将被拒绝并要求重规划）` +
      // expect 保持小写 dashboard：既是英文原文（符合站点语言契约），也与
      // test_state_reset_evidence_guard C2 的字面守护一致（示例必须从 url_contains 改为 element_present）
      `{ "id":"step_003","type":"ACT","description":"点击登录","expectedOutcome":"登录成功后页面出现登录后内容（看板/用户名等）","risk":"MEDIUM","action":{ "type":"click","target":{ "field":"loginBtn","semantic":"Sign in" },"risk":"MEDIUM","verification":{ "type":"element_present","expect":"dashboard" } } } ] }`,
    schema: { instructions: plannerInstructions(), validate: validatePlan },
    maxRetries: 3,
    label: 'plan',
  });

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_PLANNER_ATTEMPTS; attempt++) {
    let rawSteps = undefined;
    let usedCapability = null;
    let planCapabilityFailed = false;

    if (typeof provider.plan === 'function') {
      try {
        rawSteps = await provider.plan(ctx, taskLike);
        usedCapability = 'plan';
      } catch (e) {
        if (CAPABILITY_RE.test(String(e.message || e))) {
          // 门面 plan 底层无 raw.plan —— 这是能力缺失，不是规划失败，降级 structured
          planCapabilityFailed = true;
        } else {
          // 瞬态失败（如 LLM 返回 JSON 解析失败）：记录后进入重试，不立即让整任务崩溃
          lastError = `规划失败(plan): ${String(e.message || e).slice(0, 200)}`;
        }
      }
    }

    if (rawSteps === undefined && (planCapabilityFailed || typeof provider.plan !== 'function') && typeof provider.structured === 'function') {
      try {
        const draft = await provider.structured(ctx, buildStructuredOpts(attempt > 1 ? lastError : ''));
        if (process.env.PLANNER_DEBUG) {
          console.error('[planner][debug] structured draft=', JSON.stringify(draft).slice(0, 1500));
        }
        if (draft && Array.isArray(draft.steps)) {
          rawSteps = draft.steps;
        } else if (draft && draft.plan && Array.isArray(draft.plan.steps)) {
          rawSteps = draft.plan.steps;
        } else if (draft && Array.isArray(draft)) {
          rawSteps = draft;
        } else {
          // structured 未返回可识别结构，做一次显式校验兜底
          const vr0 = validatePlan(draft || {});
          if (vr0.ok) rawSteps = vr0.plan.steps;
          else lastError = `Plan 生成结果无法解析: ${(vr0.errors || []).slice(0, 3).join('; ')}`;
        }
        usedCapability = 'structured';
      } catch (e) {
        lastError = `规划失败(structured): ${String(e.message || e).slice(0, 200)}`;
      }
    }

    if (!Array.isArray(rawSteps)) {
      // 生成未产出步骤数组：若还有重试额度则继续，否则收口为失败
      if (attempt < MAX_PLANNER_ATTEMPTS) continue;
      return { ok: false, error: lastError || 'Provider 未返回步骤数组' };
    }

    // 真实 provider.plan 路径产出「严格 Step」，需归一化为运行时规范化 Step；
    // structured 降级路径已直接产出规范化 Step（其 prompt 使用 canonical Plan Schema）。
    const canonical = usedCapability === 'plan'
      ? normalizeStrictToCanonical({ steps: rawSteps }, goalText)
      : { goal: goalText, steps: rawSteps };

    // ---- 校验（运行时 Step Schema 终态门）----
    const vr = validatePlan(canonical);
    if (vr.ok) {
      // P1 凭据字段契约守卫：schema 门通过后再查身份字段编造，违规回灌重试
      const ccv = credentialContractViolations(vr.plan.steps, credentialRefs);
      if (ccv.length) {
        // 错误消息按违规方向区分：有凭据清单 → 身份字段必须用 credentialRef；
        // 无凭据清单（空集反向守卫）→ 禁止生成任何 credentialRef。
        const hasRefs = Array.isArray(credentialRefs) && credentialRefs.filter(Boolean).length > 0;
        lastError = '凭据字段契约违规：'
          + (hasRefs
            ? '任务已挂载可用凭据，身份类字段（email/username/账号）必须用 action.credentialRef 引用凭据清单中的原样 id，禁止编造 value'
            : '任务未提供任何凭据清单，禁止在任何步骤生成 action.credentialRef（执行期凭据必然不可用并直送人工升级）')
          + '。违规步骤: '
          + ccv.join('; ')
          + '。请按上述规则修正后重新输出完整计划。';
        try {
          recordPlannerEvidence({
            taskId: ctx && ctx.taskId,
            executionId: ctx && ctx.executionId,
            provider: provider && (provider.kind || provider.name),
            model: provider && provider.model,
            objective: goalText,
            context: ctx && ctx.context ? JSON.stringify(ctx.context) : '',
            stepCount: canonical.steps.length,
            schemaOk: false,
            schemaErrors: ['credential_contract_violation: ' + ccv.join('; ')].slice(0, 5),
            capability: usedCapability,
          });
        } catch (e) {}
        if (attempt < MAX_PLANNER_ATTEMPTS) continue;
        return { ok: false, error: lastError };
      }
      // LOGIN_SUCCESS 仅 URL 证据守卫：与 ccv 同款回灌重试模式
      const uov = urlOnlyEvidenceViolations(vr.plan.steps);
      if (uov.length) {
        lastError = '登录证据契约违规：LOGIN_SUCCESS 的 requiredEvidence 不得全部为 URL 类证据（url_contains/url_pattern 在 URL 不变的站点上恒假，会把真实成功误判为失败）。违规步骤: '
          + uov.join('; ')
          + '。请至少补充一条 element_present 或 text_present 类「登录成功后才出现的内容」证据（如看板标题/用户名/退出按钮），URL 类证据只能与内容类证据以 OR 组合使用，重新输出完整计划。';
        try {
          recordPlannerEvidence({
            taskId: ctx && ctx.taskId,
            executionId: ctx && ctx.executionId,
            provider: provider && (provider.kind || provider.name),
            model: provider && provider.model,
            objective: goalText,
            context: ctx && ctx.context ? JSON.stringify(ctx.context) : '',
            stepCount: canonical.steps.length,
            schemaOk: false,
            schemaErrors: ['login_evidence_contract_violation: ' + uov.join('; ')].slice(0, 5),
            capability: usedCapability,
          });
        } catch (e) {}
        if (attempt < MAX_PLANNER_ATTEMPTS) continue;
        return { ok: false, error: lastError };
      }
      try {
        recordPlannerEvidence({
          taskId: ctx && ctx.taskId,
          executionId: ctx && ctx.executionId,
          provider: provider && (provider.kind || provider.name),
          model: provider && provider.model,
          objective: goalText,
          context: ctx && ctx.context ? JSON.stringify(ctx.context) : '',
          stepCount: vr.plan.steps.length,
          schemaOk: true,
          schemaErrors: [],
          capability: usedCapability,
        });
      } catch (e) {}
      // C102/C103：入口地址保真 + 302 型入口验证语义修正（成功路径统一收口）
      enforceEntryUrl(vr.plan, target);
      relaxEntryUrlVerification(vr.plan, target);
      return { ok: true, plan: vr.plan, capability: usedCapability };
    }

    // 真实规划失败：记录审计证据；把拒绝原因回灌，给模型一次修正机会（最多重试 MAX_PLANNER_ATTEMPTS 次）
    try {
      recordPlannerEvidence({
        taskId: ctx && ctx.taskId,
        executionId: ctx && ctx.executionId,
        provider: provider && (provider.kind || provider.name),
        model: provider && provider.model,
        objective: goalText,
        context: ctx && ctx.context ? JSON.stringify(ctx.context) : '',
        stepCount: canonical.steps.length,
        schemaOk: false,
        schemaErrors: (vr.errors || []).slice(0, 5),
        capability: usedCapability,
      });
    } catch (e) {}
    lastError = `Plan Schema 校验失败: ${(vr.errors || []).slice(0, 3).join('; ')}`;
    // B 类缺口修复（2026-08-31 中途归因 #1）：凭据清单为空时，含敏感字段字面量的计划被
    // schema/action.js 敏感字段门确定性拒绝，且登录页上下文使模型理性地反复写出 password
    // ——重试只会重复同一结局（实证：33-task 归因中 7/7 任务 3 次尝试逐字相同）。
    // 当【全部】阻断错误均为「敏感字段必须 credentialRef」且凭据清单为空 → 规划确定性
    // 不可满足，立即收口为 needsCredentials，由 runtime 升级 HUMAN_ESCALATION(kind=credential)。
    // 不放宽 schema、不改任务池：升级是「需凭据」的正确业务语义（CREDIBLE）。
    const _errs = (vr.errors || []).map(String);
    const _hasRefs = Array.isArray(credentialRefs) && credentialRefs.filter(Boolean).length > 0;
    if (!_hasRefs && _errs.length && _errs.every((s) => SENSITIVE_GATE_RE.test(s))) {
      lastError = '任务页面需要认证但凭据清单为空：password 等敏感字段必须用 credentialRef 注入，'
        + '而空清单禁止引用任何凭据 —— 规划确定性不可满足，需用户提供站点凭据后重试';
      try {
        recordPlannerEvidence({
          taskId: ctx && ctx.taskId,
          executionId: ctx && ctx.executionId,
          provider: provider && (provider.kind || provider.name),
          model: provider && provider.model,
          objective: goalText,
          context: ctx && ctx.context ? JSON.stringify(ctx.context) : '',
          stepCount: canonical.steps.length,
          schemaOk: false,
          schemaErrors: ['needs_credentials_unsatisfiable: ' + _errs.slice(0, 3).join('; ')].slice(0, 5),
          capability: usedCapability,
        });
      } catch (e) {}
      return { ok: false, error: lastError, needsCredentials: true };
    }
    if (attempt < MAX_PLANNER_ATTEMPTS) continue;
    return { ok: false, error: lastError };
  }

  return { ok: false, error: lastError || '规划失败（已重试耗尽）' };
}

// C105 F4：replan 产出步骤的程序性接地净化 —— replan 上下文里的页面观察是新鲜的，但
// provider 仍可能产出过期/幻觉 selector（C105 实锤：replan 计划携带 #continue-nav，而
// 该元素在导航后页面已不存在 → 执行期死循环）。对每个携带显式 selector 且同时拥有语义键
// （semantic/field/text）的 target：selector 未在 replan 时的 fresh observation 中接地 →
// 剥离 selector、保留语义键，交执行期新鲜解析（tools.resolveSelector F2 守卫同源判定）。
// selector-only target 不动（无回退键，保持既有 CSS fallback 行为）；不做整计划拒绝——
// 后续步骤可能作用于尚未导航到的页面，按「当前页」一刀切会误杀合法多页计划（边界登记）。
function groundReplannedSteps(steps, observation) {
  if (!Array.isArray(steps)) return 0;
  let stripped = 0;
  for (const s of steps) {
    const t = s && s.action && s.action.target;
    if (!t || !t.selector) continue;
    if (!t.semantic && !t.field && !t.text) continue;
    if (semanticResolver.selectorGrounded(t.selector, observation)) continue;
    const keep = {};
    for (const k of ['semantic', 'field', 'text', 'role']) { if (t[k]) keep[k] = t[k]; }
    if (!Object.keys(keep).length) continue;
    s.action.target = keep;
    s.action.reason = (s.action.reason ? s.action.reason + ' ' : '') + 'C105 F4: replan selector 未在当前页面观察中接地，已剥离交语义新鲜解析';
    stripped += 1;
  }
  return stripped;
}

// 重规划（REPLAN）：当 Plan 本身过期（DOM 结构变化 / 真实动作失败，且常规重定位与重试已耗尽）时，
// 基于【当前浏览器观察】与【已完成步骤】让 provider 重新生成「剩余步骤」。
// 防御：
//   - 任何异常/能力缺失 → 返回 { ok:false }，由调用方降级为 escalate/fail（不静默通过，不无限循环）。
//   - 不改动校验逻辑；新生成的 Plan 仍经 validatePlan 校验，非法即拒绝。
//   - 返回的 steps 是「完整剩余计划」，调用方负责替换原 plan 中从当前位置起的部分。
async function replan(task, observation, remainingSteps, provider) {
  try {
    if (!provider || typeof provider.plan !== 'function' && typeof provider.structured !== 'function') {
      return { ok: false, error: 'replan: 无可用 provider 能力' };
    }
    // 已完成步骤作为上下文，避免重规划时重复已成功的动作
    const completed = stepManager.listSteps(task.id)
      .filter((s) => s.status === 'SUCCESS')
      .map((s) => ({ id: s.id, type: s.type, status: s.status, description: s.description }));
    const ctx = {
      taskId: task.id,
      executionId: task.currentExecutionId,
      context: {
        task: { objective: task.objective },
        page: observation || null,
        steps: completed,
        checkpoint: null,
        errorHistory: [],
        verification: null,
      },
    };
    const resumeObjective = (task.objective || '执行任务') +
      `（从当前页面状态续跑：已完成 ${completed.length} 步，请仅规划尚未完成的剩余步骤）`;
    const pr = await planObjective({
      objective: resumeObjective,
      target: task.targetUrl,
      constraints: task.constraints || [],
      credentialRefs: task.secretRefs || [],
      executionMode: task.executionMode,
      provider,
      ctx,
    });
    if (!pr.ok) return { ok: false, error: pr.error };
    // C105 F4：程序性接地净化（新鲜观察驱动）
    const strippedSelectors = groundReplannedSteps(pr.plan.steps, observation);
    return { ok: true, steps: pr.plan.steps, strippedSelectors };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}

module.exports = {
  planObjective, replan, PLANNER_PROVIDER_CAPABILITY_ERROR,
  // C105 F4：导出供测试断言（replan 产出接地净化）
  groundReplannedSteps,
  // 导出供测试断言：提示里的动作参数契约、以及「可上传文件」与 schema 白名单是否同源
  PLANNER_INSTRUCTIONS, ACTION_CONSTRAINTS, uploadHint, plannerInstructions,
  // CAP-K2：导出供测试断言（第一序列化点；第二点在 deepseek.buildContextSection）
  contextBlock,
  // P1 凭据字段契约：导出供针对性回归测试
  credentialContractViolations,
  // P1 空集反向守卫：导出供针对性回归测试（空清单 prompt 禁令断言）
  credentialBlock,
  // LOGIN_SUCCESS 仅 URL 证据守卫：导出供针对性回归测试
  urlOnlyEvidenceViolations,
};
