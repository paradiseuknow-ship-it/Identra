'use strict';
// C106 — 分步表单推进（staged form advance-then-recheck）。
//
// 根因（C105 第 4 轮真实站点实证 task_mtudmyy7rg926）：
//   真实注册流程大量是【分步表单】（邮箱 → 继续 → 密码 → …）。planner 假设单页表单，
//   一次性规划 email/password/submit → 执行到 fill password 时该字段【尚未挂载】
//   → ELEMENT_NOT_FOUND → 重试 + replan 全部只是在重放同一个不可能成功的动作
//   （实证同字段重试 12 次、耗掉 473s → FAILED）。
//
// 语义区分（本模块存在的唯一理由）：
//   ELEMENT_NOT_FOUND 把两种完全不同的情况混为一谈——
//     (a) 目标不存在（页面结构变了 / 目标错了）        → 该 replan
//     (b) 目标【尚未出现】（流程还没走到那一步）       → 该先推进流程再重查
//   (b) 在现有链路上无解：重试/replan/熔断都只是重放同一步。
//
// 设计契约（保守优先，绝不盲目点按钮）：
//   1. 只在【字段类动作】（fill/select/check/uncheck/upload）且目标带 field/semantic 时触发；
//      selector-only 目标不触发（无法判定「字段未出现」，且 selector 失败另有含义）。
//   2. 推进控件只能来自【保守前进词表】（Continue/Next/Submit/Sign up…），
//      且词表本身经 DANGEROUS_RE 过滤（绝不含 delete/pay/cancel/confirm 等副作用词）。
//   3. 解析走 tools.resolveSelector —— 与正常动作同一条接地链路，天然继承 C105 的
//      零证据拒点（F1）、合成 id 拒用（F10）、可操作性判定，不另起一套弱匹配。
//      prefer 谓词把「表单提交类控件」排在角色泛化的 role=button 之前
//      （C105 D-A 教训：role=button catch-all 同分会导致误点机器）。
//   4. 点击【一次】即止：只要点击成功就重新观察并据此收口（字段出现 → advanced；
//      仍未出现 → 立刻停止，绝不连点第二个前进词，避免连续推进造成业务副作用）。
//   5. 每 step 推进次数上限 MAX_ADVANCE_PER_STEP（由调用方记账，本模块只导出常量）。
//   6. 全部动作留痕（调用方发 agent.staged_form_advance 事件），便于取证。

const semanticResolver = require('./semanticResolver');

const FIELD_ACTION_TYPES = ['fill', 'select', 'check', 'uncheck', 'upload'];

// 保守前进词表：顺序即尝试顺序。只放「推进流程」语义，不放任何带业务副作用的词。
// ⚠️ 词表纪律：禁止加入【含字段名的复合词】（如 "Continue with email"）。
// 真实浏览器实证（C106 fixture C 场景）：复合词与输入框（placeholder=Email / name=email）
// 产生词法交集 → semanticResolver 把 email 输入框本身解析成「前进控件」并点击它。
// 词表只保留纯动作语义，结构层面再由 isAdvanceControl 兜底拦截非推进类元素。
const ADVANCE_TERMS = [
  'Continue',
  'Next',
  'Sign up',
  'Create account',
  'Get started',
  'Next step',
  'Proceed',
  'Submit',
];

// 副作用/破坏性词：双重保险（词表本身已不含，此处拦截任何未来新增词的误入）。
const DANGEROUS_RE = /(delete|remove|cancel|pay|purchase|checkout|order|confirm|reset|back|log\s*out|unsubscribe|close|dismiss|decline|ignore)/i;

// 合成 selector 拒用（与 C105 F10 同一契约）：observation 逻辑索引不是 DOM id。
const SYNTHETIC_ID_RE = /^#el-\d+$/;

const MAX_ADVANCE_PER_STEP = 2;

function isSyntheticSelector(sel) {
  return !!sel && SYNTHETIC_ID_RE.test(String(sel).trim());
}

function isDangerousTerm(term) {
  return DANGEROUS_RE.test(String(term || ''));
}

// 纯函数：该动作是否属于「可能因分步流程而目标尚未出现」的字段类动作。
function isFieldTargetAction(action) {
  const a = action || {};
  if (!FIELD_ACTION_TYPES.includes(a.type)) return false;
  const t = a.target || {};
  // selector-only 不算：没有语义键就无法判定「字段尚未出现」，应走既有 selector 失败路径。
  return !!(t.field || t.semantic);
}

// 纯函数：当前可尝试的前进词序列（已剔除危险词）。
function advanceTerms() {
  return ADVANCE_TERMS.filter((t) => !isDangerousTerm(t));
}

// 表单提交类优先（C105 D-A：避免 catch-all role=button 抢先）
function preferSubmitLike(el) {
  const e = el || {};
  if (String(e.type || '').toLowerCase() === 'submit') return true;
  if (String(e.tag || '').toLowerCase() === 'button') return true;
  return !!e.inForm;
}

// 结构过滤：前进控件必须是「可推进流程的控件」，绝不可以是输入框/文本域/下拉。
// 为什么必须有这一层（真实浏览器实证，C106 fixture 场景 C）：
//   页面只有 <input id="email" placeholder="Email">，却把「Continue with email」类措辞
//   解析到输入框并点击 —— 语义词法交集无法区分「按钮文案」与「字段标签」，
//   只有元素结构能判定。语义评分负责排序，结构过滤负责合法性，二者不可互相替代。
//   允许：button / a / input[type=submit|button|image] / [role=button|link]
//   拒绝：input[type=text|email|password|tel|number|checkbox|radio|...]、textarea、select、reset
function isAdvanceControl(el) {
  const e = el || {};
  const tag = String(e.tag || '').toLowerCase();
  const type = String(e.type || '').toLowerCase();
  const role = String(e.role || '').toLowerCase();
  if (tag === 'button') return true;
  if (tag === 'a') return true;
  if (tag === 'input') return type === 'submit' || type === 'button' || type === 'image';
  if (role === 'button' || role === 'link') return true;
  return false;
}

// 推进一次：命中前进控件 → 点击 → 重新观察 → 目标字段是否已可解析。
// 依赖全部注入（零浏览器守护可测）。
async function tryAdvance(deps) {
  const { task, step, action, tools, observation, browserManager, resolver } = deps || {};
  if (!tools || !observation || !browserManager) return { advanced: false, reason: 'missing_deps' };
  const RR = resolver || semanticResolver;

  const page = await browserManager.getPage(task && task.profileId);
  if (!page) return { advanced: false, reason: 'no_page' };

  const first = await observation.inspect(page, { taskId: task && task.id, skipCache: true });
  const obs = first && first.observation;
  if (!obs) return { advanced: false, reason: 'no_observation' };

  for (const term of advanceTerms()) {
    // 解析走 semanticResolver（与正常动作同一条语义评分链路，继承 C105 的接地/拒点强化），
    // 再用结构过滤剔除输入框等非推进类元素，最后按「表单提交类优先」稳定排序。
    let sel = null;
    try {
      const cands = (RR.resolve({ semantic: term }, obs) || [])
        .filter((c) => c && c.selector && !isSyntheticSelector(c.selector) && isAdvanceControl(c.el));
      if (cands.length) {
        const ranked = cands.slice().sort((a, b) => (preferSubmitLike(b.el) ? 1 : 0) - (preferSubmitLike(a.el) ? 1 : 0));
        sel = { selector: ranked[0].selector, pattern: null, semantic: term };
      }
    } catch (e) {
      sel = null;
    }
    if (!sel || !sel.selector || isSyntheticSelector(sel.selector)) continue;

    const clickAction = {
      type: 'click',
      target: { semantic: term, selector: sel.selector },
      risk: 'LOW',
      verification: { type: 'none' },
      timeoutMs: 15000,
      // 标记：本动作由推进逻辑合成，非 planner 产出（取证/审计可区分）
      synthetic: true,
      syntheticReason: 'C106 staged form advance',
    };
    let res = null;
    try {
      res = await tools.execute({
        action: clickAction,
        taskId: task && task.id,
        executionId: task && task.currentExecutionId,
        stepId: step && step.id,
        attemptId: null,
      });
    } catch (e) {
      res = null;
    }
    if (!res || !res.success) continue; // 该词点击失败 → 换下一个词（未产生页面推进）

    // 点击成功 → 重新观察 → 目标字段是否已出现（决定成败，且必然停止推进）
    const after = await observation.inspect(page, { taskId: task && task.id, skipCache: true });
    const afterObs = after && after.observation;
    let nowSel = null;
    try {
      nowSel = await tools.resolveSelector(action, afterObs, {}, page);
    } catch (e) {
      nowSel = null;
    }
    if (nowSel && nowSel.selector && !isSyntheticSelector(nowSel.selector)) {
      return { advanced: true, term, selector: sel.selector, observation: afterObs };
    }
    // 推进了但字段仍未出现 —— 立即停止，绝不连点第二个前进词。
    return {
      advanced: false,
      clicked: { term, selector: sel.selector },
      reason: 'field_still_absent',
      observation: afterObs,
    };
  }
  return { advanced: false, reason: 'no_advance_control', observation: obs };
}

module.exports = {
  FIELD_ACTION_TYPES,
  ADVANCE_TERMS,
  MAX_ADVANCE_PER_STEP,
  isFieldTargetAction,
  isDangerousTerm,
  isSyntheticSelector,
  advanceTerms,
  preferSubmitLike,
  isAdvanceControl,
  tryAdvance,
};
