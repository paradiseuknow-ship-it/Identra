'use strict';

// Planner 契约文本单一事实源（P4/P5）。
// 背景：P4/P5 修复轮曾只写入 planner.js 的 ACTION_CONSTRAINTS（structured fallback 路径），
// 而 DeepSeek 真实执行路径（provider.plan → deepseekPlan）使用独立 system prompt，
// 未携带这两条约束 —— 修复未到达真实 LLM 请求（B 类一致性缺陷）。
// 本模块让 planner.js 与 deepseek.js 引用同一份文本，禁止两处硬编码漂移。
// 语义出处：最小修复轮（rw.094 铁证驱动 P4 / rw.083 探针驱动 P5）。

const P4_CONTRACT = 'P4 语义放大禁令：子目标必须与 objective 同粒度。「查看/确认 X 数量/状态/文本」类观察目标必须通过观察页面现有元素（如计数条文本/状态文本）完成，禁止放大为「打开 X 页面」「进入 X 管理」等上下文元素清单中不存在的页面实体——放大后的子目标在页面上不可满足，只会进入无效修复循环直至人工升级。';

const P5_CONTRACT = 'P5 等待/观察证据契约：等待异步渲染类步骤的验证证据必须指向「渲染后必然出现的内容」（如目标容器/输入框本身出现），禁止臆造「加载完成」「内容已就绪」等页面从未承诺出现的文案作为 text_present 证据；不确定渲染产物时，等待步骤用 action_success 或验证页面稳定存在的骨架元素（页头/表单容器）。';

// P6 出处：P5.1 取证（.benchmark/P5_1_PLANNER_CONTRACT_FABRICATION.md）——7/100 任务
// （rw.044/046/053/054/079/085/096）失败于 planner 运行期为「动作后才出现的未来状态」
// 臆测 DOM/CSS class/文案（.product-item、「价格」、「商品列表容器」、form），AND 逻辑
// 把本来可满足的证据毒杀。池/fixture 无责，坏子句 100% 产自 step.verification / ebs。
const P6_CONTRACT = 'P6 未来状态证据锚定契约（事实锚定，语义合理≠DOM 事实）：为 SEARCH_SUCCESS/CLICK_SUCCESS 等「动作执行后才可能出现的状态」写 verification / expectedBusinessState.requiredEvidence 时，每个证据子句必须有事实锚点，三选一——① action_success（仅限 search/click/submit 类动作完成后没有可靠渲染事实时使用）；② 当前页面已存在且动作后仍应存续的稳定元素（如搜索框/页头/表单容器，从上下文元素清单取真实存在的 id/class/text）；③ 任务/observation 明确提供的具体专有名词或型号（如 objective 中的商品名「戴尔 U2723QE」「机械键盘」——这是字面事实）。fill 步骤例外：fill 的完成证据必须锚定被填写的输入框元素本身（如 element_present 搜索输入框，FIELD_FILLED 契约），action_success 不能作为 fill 的唯一完成证据。三类目词是业务语义不是 DOM 事实，禁止据此生成证据：「容器/列表/结果」类词（商品列表容器、商品价格元素、搜索结果）不得转成 element_present——observation/元素清单没提供的选择器一律视为不存在；「价格」类词不得转成 text_present——语义上有价格≠页面有字面「价格」，页面可能只显示 ¥1599，可用 text_present "¥" 代替；「购物车」不得自行扩展成「已加入购物车」等从未确认的文案；禁止臆测 CSS 类名（.product-item/.product-list/ul.products）；禁止自行发明任务与 observation 中都未出现的商品名/型号当作 text_present 证据（搜什么由 objective 或上下文事实决定）。宁缺毋滥：无法证明真实存在的证据子句不要添加；禁止为凑完整性经 AND 追加猜测条件——一条可靠证据优于多条猜测证据，A AND 臆造B 会毒杀本来可成功的任务。';

// R8 出处：R8 取证（.benchmark/r8_diag/ E3.1-DIAG 铁证，rw.026 三点 CANCELLED 主因）——
// LLM 生成 element_present expect="body"（泛化容器标签）→ semanticResolver BARE_TAGS 词表
// 有意不含 body（非业务元素）→ 语义解析必然 0 候选 → VERIFY_FAILED；VERIFY_RETRY
// （wait+inspect+重验）对结构性不可满足验证无解 → 烧尽 retry/repair 预算 → churn 至 deadline。
const R8_CONTRACT = 'R8 泛化容器证据禁令：element_present/element_absent 的 expect 禁止使用泛化容器标签名（body/html/head/div/span/ul/ol/table/section/main/header/footer/nav/p 等纯标签词）——这类目标要么语义解析必然落空（解析词表只含 input/button/h2/form 等业务标签），要么「任何页面都存在」而毫无业务区分度，不能构成动作成功的证据。element_present 的 expect 必须锚定动作完成后真实出现的业务元素：业务语义描述（如「导出按钮」「搜索结果列表」）或页面上真实存在的 CSS 选择器（#exportBtn/.result-list，语法合法）。泛化容器的存在不证明业务成功——与其写 element_present "body"，不如写 action_success 或页面真实的业务元素。';

// R9 出处：run4 + 双单任务诊断（.benchmark/run4_diag/、run4_diag2/，E3.1-DIAG +
// agent.repairing 事件 + 截图铁证，rw.026 四轮 3×CANCELLED）——rw.026 首次 text_present
// 确认验证失败后，replan 产出的两份后续计划均为单步 inspect-only（LLM 信任已记录的
// click SUCCESS，只「再确认」不重新执行因果动作），证据永不出现 → 烧尽预算至 deadline。
const R9_CONTRACT = 'R9 重规划因果动作契约：为「确认类」步骤（CONFIRMATION/DOWNLOAD 等业务结果确认，requiredEvidence 含 text_present）重规划时，若该确认证据文本在历史尝试中从未真实出现在页面上，禁止生成只含 inspect/观察的纯确认计划——证据不出现的根因是产生它的业务动作（点击/提交/导出等）没有真正生效，唯一出路是重新执行该因果动作。重规划计划必须：① 重新执行因果动作（保留原 target 完整对象：field/semantic/credentialRef）；② 其后紧跟确认观察步骤。仅当页面观察中已经能看到确认证据、只是验证尚未通过时，才允许纯确认计划。';

module.exports = { P4_CONTRACT, P5_CONTRACT, P6_CONTRACT, R8_CONTRACT, R9_CONTRACT };
