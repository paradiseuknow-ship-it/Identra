'use strict';

// DeepSeek Provider（OpenAI-compatible API）。
// API Key 只从环境变量读取（DEEPSEEK_API_KEY）。

const llm = require('../provider');
const { extractJsonCandidate } = require('../jsonExtract');
const { validatePlanStrict, PLAN_STRICT_INSTRUCTIONS } = require('../../schema/plan');
const secretManager = require('../../secretManager');
// P4/P5 契约同步：与 planner.js 共享单一事实源 —— deepseekPlan 是真实 LLM 执行路径，
// 此前其独立 system prompt 未携带 P4（语义放大禁令）/P5（等待观察证据契约），导致
// 最小修复轮的 planner 修复无法到达真实执行（B 类一致性缺陷，smoke 前必须闭合）。
const { P4_CONTRACT, P5_CONTRACT, P6_CONTRACT, R8_CONTRACT, R9_CONTRACT } = require('../../plannerContractText');

// P1 JSON parse failure 加固（Final100 rw.063/rw.091 归因）：
// 根因是 completion 截断（9 次规划调用全部打满 max_tokens:2048 → JSON 半途而废），
// 不是外壳不规范。规划调用输出上限上调至 8192（deepseek-chat 单次输出上限），
// 可用 DEEPSEEK_PLAN_MAX_TOKENS 覆盖。这是生成参数加固，不改 schema/验证/评分语义。
const PLAN_MAX_TOKENS = Math.max(2048, Math.min(Number(process.env.DEEPSEEK_PLAN_MAX_TOKENS || 8192), 8192));

// P1 凭据字段契约：严格 plan 路径此前完全看不到凭据清单（task.secretRefs 被丢弃），
// LLM 想用 credentialRef 也无 id 可抄 —— 只能编造 ref（CREDENTIAL_UNAVAILABLE）或编造 value
// （身份字段编造 = 必然登录失败）。与 planner.js structured 路径的 credentialBlock 对齐：
// 注入脱敏凭据清单（ref + type + available + masked*），明文永不出 Vault。
function credentialSection(secretRefs) {
  const refs = Array.isArray(secretRefs) ? secretRefs.filter(Boolean) : [];
  if (!refs.length) {
    // P1 空集反向守卫的 prompt 层同步（与 planner.js credentialBlock 对齐）：
    // 空清单时显式禁止 credentialRef，而非静默无提示。
    return '\n可用凭据：本任务未提供任何凭据清单 —— 禁止在任何步骤输出 credentialRef 字段'
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
    + '\n规则：敏感字段（password/card/cvv/otp/token）必须填写上面的 credentialRef 原样字符串；'
    + '身份类字段（email/邮箱/username/账号/登录名）同样必须填写 credentialRef 原样字符串 —— 凭据中的用户名就是该站点的正确登录身份，禁止用 value 编造任何用户名/邮箱；'
    + '禁止填写 value 明文；禁止编造不在上表中的 credentialRef（编造会导致执行期 CREDENTIAL_UNAVAILABLE）。'
    + '上表为空或 available=false 时，不要输出任何敏感字段动作，改用导航+观察并交由人工提供凭据。';
}

// DeepSeek 真实 LLM 规划入口：复用现有 chat 能力与「严格 Plan Schema」校验，
// 使 provider.js 的 plan() → raw.plan(task, ctx) 形成真实可用闭环。
//
// 输入（Phase 2）：
//   task  : { objective, targetUrl, constraints, ... }
//   ctx   : { context: ContextBuilder 输出（objective / observation summary / previous steps / checkpoint / error history / verification state） }
//
// 统一 Contract（P0-1，沿用）：
//   成功 → { ok: true, plan: { steps: [严格 Step] } }
//   失败 → { ok: false, error: '校验未通过: ...' }
// 严格 Step 形状见 schema/plan.js 的 PLAN_STRICT_INSTRUCTIONS（action/target/semantic/expectedResult）。
// provider.js 的 plan() wrap 层据此归一化为 steps 数组（成功）或抛出明确 PLAN_FAIL（失败）。
async function deepseekPlan(chatFn, task, ctx) {
  const goalText = (task && (task.objective || task.goal)) || '执行任务';
  const target = (task && task.targetUrl) || '';
  const constraints = (task && (task.constraints || [])) || [];

  // 从 ContextBuilder 输出构造上下文块（objective/observation summary/previous steps/verification state）
  const ctxSection = buildContextSection(ctx);

  // 仅作为 schema 强制（validatePlanStrict + action.js MUST_VERIFY）的 LLM 层强化；
  // 真正的拒绝发生在 schema 校验，prompt 只是把已有契约文本化喂给模型。
  const system = '你是严格遵循 JSON Schema 的浏览器自动化任务规划器。只输出 JSON，不要任何解释或 Markdown 代码块之外的文字。'
    + 'target 必须用双键对象 {field, semantic}：field 用于精确匹配元素的 name/id/placeholder/aria-label/label（如 email/username/password/search），semantic 为中文语义描述；两者都提供时定位最稳。'
    + '每个 click / fill / submit 步骤都必须包含 verification（type 为 text_present/element_present/url_contains/url_pattern/storage/action_success 等，禁止 none），否则 Plan 将被 schema 拒绝。'
    + 'element_present/element_absent 的 expect 只允许：合法 CSS 选择器（#id / .class / tag / [attr=\'值\']；id=regForm 类缺前缀写法会被 schema 拒绝）或页面上真实存在的语义描述；text_present 的 expect 必须是成功后页面真实会出现的文本，禁止臆造元素名或文案。'
    + 'navigate 只用于打开页面，永远不会输入值：向输入框/表单字段输入内容的步骤（如「在搜索框中输入关键词」）必须用 fill 并拆为 navigate + fill 两步，禁止用 navigate 冒充输入（会被 schema 拒绝）；navigate 描述应含导航宾语（网址/页面/访问/打开）。'
    + '\n' + P4_CONTRACT + '\n' + P5_CONTRACT + '\n' + P6_CONTRACT + '\n' + R8_CONTRACT + '\n' + R9_CONTRACT;
  const buildPrompt = (fixHint) =>
    `目标：${goalText}\n` +
    (target ? `入口地址（相对路径，base 为站点根）：${target}\n` : '') +
    (constraints.length ? `约束：${constraints.join('; ')}\n` : '') +
    credentialSection(task && task.secretRefs) +
    ctxSection +
    `\n请按下列 Plan Schema 输出 JSON：\n${PLAN_STRICT_INSTRUCTIONS}\n\n` +
    (fixHint ? `上一次输出不符合要求：${fixHint}\n请修正并只输出合法 JSON。` : '');

  let lastHint = '';
  let sawTruncation = false;
  // 可选 planner 原始输出取证（FPB_CAPTURE_PLAN_DIR 设置时启用；纯增量，不参与判定/重试/解析）。
  // 用途：smoke 的 evidence chain（planner output → canonical plan → ...）审计，不落盘明文凭据
  //（prompt 中凭据本就是 masked/脱敏视图，明文永不出 Vault）。
  const captureDir = process.env.FPB_CAPTURE_PLAN_DIR || '';
  let captureSeq = 0;
  const capturePlanIO = (messages, resp, content) => {
    if (!captureDir) return;
    try {
      require('fs').mkdirSync(captureDir, { recursive: true });
      const rec = {
        ts: new Date().toISOString(),
        seq: ++captureSeq,
        taskId: (task && (task.id || task.taskId)) || null,
        objective: String((task && (task.objective || task.goal)) || '').slice(0, 120),
        finishReason: (resp && resp.finishReason) || null,
        userPrompt: String((messages && messages[1] && messages[1].content) || ''),
        rawOutput: String(content || ''),
      };
      require('fs').writeFileSync(
        require('path').join(captureDir, 'plan_' + Date.now().toString(36) + '_' + captureSeq + '.json'),
        JSON.stringify(rec, null, 1), 'utf8'
      );
    } catch (e) { /* 取证失败不影响规划主流程 */ }
  };
  for (let attempt = 0; attempt <= 2; attempt++) {
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: buildPrompt(lastHint) },
    ];
    const resp = await chatFn(messages, { temperature: 0.1, maxTokens: PLAN_MAX_TOKENS });
    const content = (resp && resp.content) || '';
    capturePlanIO(messages, resp, content);
    // P1：单一可审计提取（围栏剥离/前后文本剥离/首尾安全提取）。
    // 截断（finish_reason=length）不可被 parser 恢复 —— 只能提示模型精简后重试，
    // 且最终错误必须携带「截断」标识，不得伪装成 'JSON 解析失败'（可审计性）。
    const ex = extractJsonCandidate(content);
    if (!ex.ok) {
      if (resp && resp.finishReason === 'length') {
        sawTruncation = true;
        lastHint = '输出因 max_tokens 上限被截断：请大幅精简每个步骤的描述与验证字段，确保在输出上限内给出完整闭合的 JSON';
      } else if (ex.reason === 'EMPTY_OUTPUT') {
        lastHint = '输出为空';
      } else {
        lastHint = 'JSON 解析失败';
      }
      continue;
    }
    const json = ex.json;

    // 严格 Schema 校验（provider 边界契约）
    const vr = validatePlanStrict(json);
    if (vr.ok) return { ok: true, plan: { steps: vr.plan.steps } };
    lastHint = (vr.errors || []).join('; ');
  }
  // 校验最终未通过：明确失败 contract，由 provider wrap 层转抛 PLAN_FAIL。
  // 截断型失败单独标注（可审计），与其余 'JSON 解析失败' 区分开。
  return { ok: false, error: lastHint || 'Plan 校验未通过', truncated: sawTruncation };
}

// 将 ContextBuilder 的结构化上下文序列化为 prompt 上下文块。
function buildContextSection(ctx) {
  const c = ctx && ctx.context;
  if (!c) return '';
  const lines = [];
  if (c.task && c.task.objective) lines.push('任务目标：' + c.task.objective);
  if (c.page && c.page.url) {
    lines.push('当前页面：' + c.page.url + (c.page.title ? '（' + c.page.title + '）' : ''));
    // Phase 9 P4（断裂点 3/3，与 planner.contextBlock 同步修复）：
    // 此前本函数只输出 url/title，Planner 看不到页面真实文本与元素，只能臆造契约。
    // 修复：注入真实可见文本与元素清单，并约束契约必须取自清单。
    if (c.page.textSummary) lines.push('页面可见文本：' + c.page.textSummary);
    if (Array.isArray(c.page.elements) && c.page.elements.length) {
      lines.push('页面元素清单（写 expectedResult / verification 时，必须从中选取真实存在的 '
        + 'id / name / text / ariaLabel，禁止臆造页面上不存在的标识）：' + JSON.stringify(c.page.elements));
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
  // CAP-K2：Router 失败经验进 prompt（与 planner.contextBlock 同步——两个序列化点都要改）
  if (c.routerHints && Array.isArray(c.routerHints.warnings) && c.routerHints.warnings.length) {
    lines.push('Router 经验提示（来自历史失败/站点记忆，规划时主动规避，禁止据此臆造契约）：'
      + c.routerHints.warnings.join('；'));
  }
  return lines.length ? '\n\n任务上下文（ContextBuilder）：\n' + lines.join('\n') : '';
}

function deepseekFactory(config = {}) {
  const baseURL = config.baseURL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  const apiKey = config.apiKey || process.env.DEEPSEEK_API_KEY || '';
  const model = config.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const timeoutMs = config.timeoutMs || 60000;

  return {
    name: 'deepseek',
    model,
    async chat(messages, opts = {}) {
      if (!apiKey) throw new Error('未配置 DEEPSEEK_API_KEY');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs || timeoutMs);
      try {
        const res = await fetch(baseURL.replace(/\/$/, '') + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
          body: JSON.stringify({
            model,
            messages,
            temperature: opts.temperature !== undefined ? opts.temperature : 0.2,
            max_tokens: opts.maxTokens || 2048,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = (await res.text()).slice(0, 200);
          throw new Error('LLM HTTP ' + res.status + ': ' + body);
        }
        const data = await res.json();
        return {
          content: (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '',
          usage: data.usage || {},
          finishReason: (data.choices && data.choices[0] && data.choices[0].finish_reason) || null,
        };
      } finally {
        clearTimeout(timer);
      }
    },
    // 真实 LLM 规划入口：provider.js 的 plan() → raw.plan(task, ctx) 闭环
    async plan(task, ctx) {
      return deepseekPlan(this.chat.bind(this), task, ctx);
    },
  };
}

llm.register('deepseek', deepseekFactory);
module.exports = { deepseekFactory, deepseekPlan, buildContextSection, credentialSection };
