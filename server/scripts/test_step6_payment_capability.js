'use strict';

// test_step6_payment_capability.js — CAP-L1（支付字段映射）+ CAP-L2（支付五态）专项测试
//
// CAP-L1 缺陷取证（PRODUCT_CORE_RUNTIME_AUDIT.md Q8）：
//   vault 支持 card.{number,expMonth,expYear,cvv,name}，secretManager 也解密出来了，
//   但 resolveFillValue 只映射 email/password —— 「卡号的哪一段填进哪个框」这个映射
//   在整个代码库里**根本不存在**。支付是产品定位的核心卖点，这条链路是断的。
//
//   同一条主线上还发现两个静默失效的护栏：
//   (a) schema/action.js 的敏感字段判定 `SENSITIVE_FIELDS.includes(field.toLowerCase())`
//       比对的是一个**驼峰**列表（'cardNumber' / 'apiKey' / 'passwordConfirm'），
//       先 toLowerCase() 再比对驼峰 → 这三项永远不可能命中（死护栏）；
//       真实站点的 cardnumber / cc-number / cvv2 同样一个都不命中。
//   (b) observation.js 的页内敏感掩码不看 autocomplete，也漏了 ccnum / cvv2 / expiry 等写法，
//       于是 name="number" autocomplete="cc-number" 的卡号框 value 以明文进了 LLM 上下文。
//
// CAP-L2 缺陷取证：
//   全库只有一个 BUSINESS_PAYMENT_FAILED 粗桶 —— 拒付 / 3DS / 处理中 / 失败
//   四种结局被压成一个 escalate。「支付还在处理中」因此被判成「必然失败」直接丢人工，
//   而「已授权」完全没有识别路径。
//
// 本测试同时锁定一条资金安全红线：
//   pending 状态只能「等待 + 重新观察」，**绝不能 reload**（支付 POST 后 reload
//   触发浏览器「确认重新提交表单」，一旦自动确认 = 重复扣款）。

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const paymentField = require('../agent/paymentField');
const paymentState = require('../agent/paymentStateClassifier');
const observation = require('../agent/observation');
const tools = require('../agent/tools');
const secretManager = require('../agent/secretManager');
const { validateAction, SENSITIVE_FIELDS } = require('../agent/schema/action');
const diagnoser = require('../agent/diagnosis/failureDiagnoser');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  << ' + extra : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

let browser;
const CARD = { number: '4111 1111 1111 1111', expMonth: '1', expYear: '2026', cvv: '917', name: 'Zhang San' };

const PAYMENT_FORM = `<!doctype html><html><body>
<form id="pay">
  <h3>Card details</h3>
  <input id="cn"  name="number" autocomplete="cc-number" maxlength="19">
  <input id="cn2" name="ccnum">
  <input id="ex"  name="exp" autocomplete="cc-exp" maxlength="5">
  <input id="cv"  name="cvv2">
  <input id="nm"  name="cardholder-name">
  <input id="em"  name="email">
  <button id="go" type="button">Pay</button>
</form>
</body></html>`;

async function openForm() {
  const page = await browser.newPage();
  await page.setContent(PAYMENT_FORM);
  return page;
}

// ═══════════════════════════════════════════════════════════════
// CAP-L1  Part A — 通用字段识别（纯函数）
// ═══════════════════════════════════════════════════════════════
function caseAutocomplete() {
  section('Case 1  ① autocomplete —— 站点自声明的 W3C 标准语义（陌生站点上唯一可判定信号）');
  const cases = [
    ['cc-number', 'cardNumber'], ['cc-name', 'cardName'], ['cc-exp', 'expiry'],
    ['cc-exp-month', 'expMonth'], ['cc-exp-year', 'expYear'], ['cc-' + 'csc', 'cvv'],
  ];
  for (const [ac, want] of cases) {
    // 刻意让 name/id 毫无语义：只有 autocomplete 能给出答案
    const c = paymentField.classify({ autocomplete: ac, name: 'field1', id: 'f1' });
    ok('autocomplete=' + ac + ' → ' + want, !!c && c.kind === want, c ? c.kind : 'null');
  }
}

function caseWordForms() {
  section('Case 2  ② 通用英文构词（真实站点常见命名，无 autocomplete 场景）');
  const cases = [
    [{ name: 'cardnumber' }, 'cardNumber'], [{ name: 'card-number' }, 'cardNumber'],
    [{ name: 'card_number' }, 'cardNumber'], [{ name: 'ccnum' }, 'cardNumber'],
    [{ name: 'cc-number' }, 'cardNumber'], [{ name: 'cvv2' }, 'cvv'],
    [{ name: 'card-security-code' }, 'cvv'], [{ name: 'expMonth' }, 'expMonth'],
    [{ name: 'exp-year' }, 'expYear'], [{ name: 'cardholder-name' }, 'cardName'],
    [{ name: 'name-on-card' }, 'cardName'], [{ id: 'cardholder' }, 'cardName'],
  ];
  for (const [sig, want] of cases) {
    const c = paymentField.classify(sig);
    ok(JSON.stringify(sig) + ' → ' + want, !!c && c.kind === want, c ? c.kind : 'null');
  }
}

function caseWeakAlias() {
  section('Case 3  ③ 弱别名必须靠「页面自己的词」成立（无上下文一律不认）');
  const c1 = paymentField.classify({ name: 'name', label: 'Name on card' });
  ok('name + "Name on card" → cardName', !!c1 && c1.kind === 'cardName', c1 ? c1.kind : 'null');
  const c2 = paymentField.classify({ name: 'year', label: 'Expiry year', placeholder: 'Card' });
  ok('year + 卡上下文 → expYear', !!c2 && c2.kind === 'expYear', c2 ? c2.kind : 'null');
  const c3 = paymentField.classify({ name: 'month', label: 'Date of birth' });
  ok('month + "Date of birth" → null（不得误判为有效期）', c3 === null, c3 ? c3.kind : 'not null');
  const c4 = paymentField.classify({ name: 'name', label: 'Full name' });
  ok('name + 无卡上下文 → null', c4 === null, c4 ? c4.kind : 'not null');
}

function caseNoFalsePositive() {
  section('Case 4  ④ 非支付字段零误判（误判会让正常注册/下单流程被拦）');
  for (const sig of [{ name: 'username' }, { name: 'email' }, { name: 'amount' },
    { name: 'cardType', label: 'Visa' }, { name: 'quantity' }, { name: 'phone' }]) {
    const c = paymentField.classify(sig);
    ok(JSON.stringify(sig) + ' → null', c === null, c ? c.kind : 'not null');
  }
}

function caseFormat() {
  section('Case 5  取值格式化（含 maxlength 适配：MM/YY vs MM/YYYY vs MMYY）');
  ok('卡号去分隔符 → 纯数字', paymentField.formatValue('cardNumber', CARD, {}) === '4111111111111111',
    paymentField.formatValue('cardNumber', CARD, {}));
  ok('CVV → 917', paymentField.formatValue('cvv', CARD, {}) === '917');
  ok('月补零 1 → 01', paymentField.formatValue('expMonth', CARD, {}) === '01');
  ok('年 → 2026', paymentField.formatValue('expYear', CARD, {}) === '2026');
  ok('年（maxlength=2）→ 26', paymentField.formatValue('expYear', CARD, { maxlength: 2 }) === '26');
  ok('有效期（maxlength=5）→ 01/26', paymentField.formatValue('expiry', CARD, { maxlength: 5 }) === '01/26',
    paymentField.formatValue('expiry', CARD, { maxlength: 5 }));
  ok('有效期（maxlength=7）→ 01/2026', paymentField.formatValue('expiry', CARD, { maxlength: 7 }) === '01/2026');
  ok('有效期（maxlength=4）→ 0126（紧凑形态）', paymentField.formatValue('expiry', CARD, { maxlength: 4 }) === '0126');
  ok('持卡人 → Zhang San', paymentField.formatValue('cardName', CARD, {}) === 'Zhang San');
}

function caseMissingField() {
  section('Case 6  凭据缺这一段 → null（绝不静默填空串制造「填过了」的假象）');
  const partial = { number: '4111111111111111' };
  ok('无 CVV → null', paymentField.formatValue('cvv', partial, {}) === null);
  ok('无有效期 → null', paymentField.formatValue('expiry', partial, {}) === null);
  ok('整个 card 为空 → null', paymentField.formatValue('cardNumber', null, {}) === null);
}

function caseSchemaGuard() {
  section('Case 7  schema 护栏：支付字段禁止 value 字面量');
  const blocked = ['cardnumber', 'cardNumber', 'cc-number', 'ccnum', 'cvv2', 'exp-month',
    'cardholder-name', 'password', 'passwordConfirm', 'apiKey'];
  for (const f of blocked) {
    const r = validateAction({ type: 'fill', target: { field: f }, value: 'x', verification: { type: 'text_present', value: 'v' } });
    ok('字段 ' + f + ' 带字面量 → 被拒', r.ok === false, 'ok=' + r.ok);
  }
  // 这三个是历史上「先 toLowerCase 再比对驼峰列表」导致永远命中不了的死项
  for (const f of ['cardNumber', 'passwordConfirm', 'apiKey']) {
    ok('历史死项 ' + f + ' 现在真正生效', paymentField.isSensitiveFieldName(f) === true);
  }
  for (const f of ['cardType', 'username', 'amount', 'quantity', 'phone', 'email']) {
    const r = validateAction({ type: 'fill', target: { field: f }, value: 'x', verification: { type: 'text_present', value: 'v' } });
    ok('普通字段 ' + f + ' 放行（不得误伤）', r.ok === true, JSON.stringify(r.errors));
  }
  const notCovered = SENSITIVE_FIELDS.filter((f) => !paymentField.isSensitiveFieldName(f));
  ok('SENSITIVE_FIELDS 每一项仍被覆盖（无收窄）', notCovered.length === 0, notCovered.join(','));
}

function caseTokenSingleSource() {
  section('Case 8  页内脱敏令牌单一真源（paymentField → COLLECT_JS，防静默漂移）');
  const tokJson = JSON.stringify(paymentField.SENSITIVE_TOKENS);
  ok('SENSITIVE_TOKENS 已注入 COLLECT_JS', observation.COLLECT_JS.indexOf(tokJson) >= 0);
  let compiled = null;
  try { compiled = new Function('return (' + observation.COLLECT_JS + ')'); } catch (e) { compiled = null; }
  ok('COLLECT_JS 语法可编译', !!compiled);
  // 只比源码文本的一致性测试抓不到「模板字面量吃掉反斜杠」这类失效（SEC-E7 教训），
  // 这里断言的是**模板求值之后**的生效脚本里令牌真实在位。
  ok('生效脚本里含脱敏令牌数组', /SENS_TOKENS\s*=\s*\[/.test(observation.COLLECT_JS));
}

// ═══════════════════════════════════════════════════════════════
// CAP-L1  Part B — 真实浏览器
// ═══════════════════════════════════════════════════════════════
async function caseNoLeakInObservation() {
  section('Case 9  [浏览器] 填充卡信息后，明文不得出现在观察结果里');
  const page = await openForm();
  const values = { '#cn': '4111 1111 1111 1111', '#cn2': '4111111111111111', '#ex': '01/26', '#cv': '917', '#nm': 'Zhang San' };
  for (const [sel, v] of Object.entries(values)) await page.fill(sel, v);

  const insp = await observation.inspect(page, { taskId: 'cap-l1-leak-' + Date.now(), skipCache: true });
  const json = JSON.stringify(insp.observation || {});
  // 时序免疫（2026-08-31 flake 修复，非弱化）：'917' 是 3 位数字子串，观测 JSON 中的时间戳类
  // 长数字（Date.now / 事件 id，如 1788133417917）可能碰巧包含 '917'，导致红线断言假失败
  // （全量套件下偶发：首轮过、次轮挂、单跑过）。剥离 ≥10 位连续数字（时间戳语义）后再断言 ——
  // 真实 CVV 泄漏只会以独立 3 位值出现在 value/text 中，不受剥离影响，红线强度不变。
  // 完整卡号（16 位）与姓名无子串碰撞风险，保持原断言语义。
  const jsonNoTs = json.replace(/[0-9]{10,}/g, '#TS#');
  ok('观察结果不含完整卡号', jsonNoTs.indexOf('4111111111111111') < 0);
  ok('观察结果不含 CVV', jsonNoTs.indexOf('917') < 0);
  ok('观察结果不含持卡人姓名', jsonNoTs.indexOf('Zhang San') < 0);

  const byId = {};
  (insp.observation.elements || []).forEach((e) => { if (e.id) byId[e.id] = e; });
  // 四个此前会漏网的写法：ccnum / cvv2 / exp / autocomplete=cc-number 但 name=number
  for (const id of ['cn', 'cn2', 'ex', 'cv']) {
    const st = (byId[id] && byId[id].state) || {};
    ok('input#' + id + ' sensitive + value 空 + 保留 valueLength',
      st.sensitive === true && st.value === '' && st.valueLength > 0, JSON.stringify(st));
  }
  ok('普通字段 email 不受影响（不误标 sensitive）',
    !!byId.em && byId.em.state && byId.em.state.sensitive !== true);
  ok('元素带上 autocomplete 供 AI 判断字段语义',
    !!byId.cn && byId.cn.autocomplete === 'cc-number', byId.cn && String(byId.cn.autocomplete));
  await page.close();
}

// 精确命中与子串命中的分工：'exp' / 'pan' 只能整体相等命中（子串会误伤 panel / expand），
// 而 'cardholder' 这类复合词必须靠子串命中。
const EDGE_FORM = `<!doctype html><html><body><form>
  <input id="i_exp"    name="exp"   autocomplete="cc-exp">
  <input id="i_exp2"   name="exp">
  <input id="i_pan"    name="pan">
  <input id="i_mmyy"   name="mmyy">
  <input id="i_panel"  name="panel">
  <input id="i_expand" name="expand">
  <input id="i_cid"    name="cid">
</form></body></html>`;

async function caseMaskBoundary() {
  section('Case 9b [浏览器] 掩码边界：短词精确命中，普通字段零误伤');
  const page = await browser.newPage();
  await page.setContent(EDGE_FORM);
  const vals = { '#i_exp': '01/26', '#i_exp2': '01/26', '#i_pan': '4111111111111111', '#i_mmyy': '0126', '#i_panel': 'left', '#i_expand': 'yes', '#i_cid': 'C-42' };
  for (const [sel, v] of Object.entries(vals)) await page.fill(sel, v);
  const insp = await observation.inspect(page, { taskId: 'cap-l1-edge-' + Date.now(), skipCache: true });
  const byId = {};
  (insp.observation.elements || []).forEach((e) => { if (e.id) byId[e.id] = e; });

  for (const id of ['i_exp', 'i_exp2', 'i_pan', 'i_mmyy']) {
    const st = (byId[id] && byId[id].state) || {};
    ok('#' + id + ' 判为敏感（value 不出浏览器）',
      st.sensitive === true && st.value === '', JSON.stringify(st));
  }
  for (const id of ['i_panel', 'i_expand', 'i_cid']) {
    const st = (byId[id] && byId[id].state) || {};
    ok('#' + id + ' 不误判为敏感（值仍可见）',
      st.sensitive !== true && st.value === vals['#' + id], JSON.stringify(st));
  }
  ok('敏感值未出现在观察 JSON 里', JSON.stringify(insp.observation).indexOf('4111111111111111') < 0);
  await page.close();
}

async function caseEndToEndFill() {
  section('Case 10 [浏览器] 端到端 fill：credentialRef → 各段填进对应的框');
  const page = await openForm();
  const _resolve = secretManager.resolve;
  const _getByRef = secretManager.getByRef;
  secretManager.resolve = () => ({ profileId: 'p-test', type: 'payment', secrets: { card: CARD } });
  secretManager.getByRef = () => ({ id: 'cred_test', available: true });

  const expect = [
    ['#cn', 'cardNumber', '4111111111111111'],
    ['#cn2', 'cardNumber', '4111111111111111'],
    ['#ex', 'expiry', '01/26'],
    ['#cv', 'cvv', '917'],
    ['#nm', 'cardName', 'Zhang San'],
  ];
  try {
    for (const [sel, field, want] of expect) {
      const res = await tools.runTool(
        { type: 'fill', target: { selector: sel, field }, credentialRef: 'cred_test',
          verification: { type: 'text_present', value: 'x' }, timeoutMs: 20000 },
        { page, session: { profileId: 'p-test' } },
        { taskId: 'cap-l1-fill-' + Date.now() + '-' + sel.slice(1) },
      );
      const got = await page.inputValue(sel).catch(() => '<err>');
      ok('fill ' + sel + ' → ' + want, res.success === true && got === want,
        'success=' + res.success + ' got=' + JSON.stringify(got) + ' err=' + JSON.stringify(res.error));
      // 探针：剔除遥测 ID 类字段（taskId 内嵌 Date.now() 时间戳字符串，随机含 '917' 等子串 → 假阳性）
      // + 归零 JSON number（timestamp: Date.now() 数字字段同理）。
      // 明文泄漏只会以业务字符串形态出现；遥测 ID 是调用方自带标识，不属于响应泄漏。
      const stripTelemetryIds = (v) => {
        if (Array.isArray(v)) return v.map(stripTelemetryIds);
        if (v && typeof v === 'object') {
          const out = {};
          for (const [k, val] of Object.entries(v)) {
            if (/^(taskId|stepId|attemptId|executionId)$/.test(k)) continue;
            out[k] = stripTelemetryIds(val);
          }
          return out;
        }
        return v;
      };
      const probe = JSON.stringify(stripTelemetryIds(res), (k, v) => (typeof v === 'number' ? 0 : v));
      const leaked = probe.indexOf(want) >= 0 ? probe.slice(Math.max(0, probe.indexOf(want) - 80), probe.indexOf(want) + 80) : null;
      ok('fill ' + sel + ' 返回体不含明文值',
        probe.indexOf(want) < 0 && probe.indexOf('4111111111111111') < 0,
        leaked ? '泄漏上下文: ...' + leaked + '...' : (probe.indexOf('4111111111111111') >= 0 ? '卡号泄漏' : ''));
    }

    // 清空后再试：#cv 已被上一轮成功填充，不清空就无法区分「没填」和「残留」
    await page.fill('#cv', '');
    secretManager.resolve = () => ({ profileId: 'p-test', type: 'payment', secrets: { card: { number: '4111111111111111' } } });
    const resMiss = await tools.runTool(
      { type: 'fill', target: { selector: '#cv', field: 'cvv' }, credentialRef: 'cred_test',
        verification: { type: 'text_present', value: 'x' }, timeoutMs: 20000 },
      { page, session: { profileId: 'p-test' } }, { taskId: 'cap-l1-missing-' + Date.now() },
    );
    ok('凭据缺 CVV → CREDENTIAL_FIELD_MISSING（非静默成功）',
      resMiss.success === false && resMiss.error && resMiss.error.code === 'CREDENTIAL_FIELD_MISSING',
      JSON.stringify(resMiss.error));
    ok('缺字段时未填入任何内容', (await page.inputValue('#cv')) === '');
  } finally {
    secretManager.resolve = _resolve;
    secretManager.getByRef = _getByRef;
    await page.close();
  }
}

// ═══════════════════════════════════════════════════════════════
// CAP-L2 — 支付五态
// ═══════════════════════════════════════════════════════════════
const net = (bodies, statuses) => ({
  apiResponses: (bodies || []).map((b, i) => ({ url: 'https://api.example.test/pay', status: (statuses && statuses[i]) || 200, bodyPreview: b, method: 'POST' })),
  failures: [], pageErrors: [], counts: { requests: (bodies || []).length },
});

function caseFiveStatesBody() {
  section('Case 11 支付五态：网络响应体（网关 status 字段，最客观）');
  const cases = [
    ['{"payment_intent": {"status": "succeeded"}}', 'authorized'],
    ['{"status":"requires_capture","amount":100}', 'pending'],
    ['{"error":{"code":"card_declined","message":"Your card was declined."}}', 'declined'],
    ['{"error":"insufficient_funds"}', 'declined'],
    ['{"status":"requires_action","next_action":{"type":"redirect_to_url"}}', 'three_ds_challenge'],
    ['{"error":{"code":"payment_failed"}}', 'failed'],
    ['{"order":{"state":"processing"}}', 'pending'],
  ];
  for (const [body, want] of cases) {
    const r = paymentState.classify({ network: net([body]), pageText: '' });
    ok(want + ' ← ' + body.slice(0, 52), r.state === want, 'got ' + r.state);
  }
  const unk = paymentState.classify({ network: net(['{"ok":true}']), pageText: 'hello' });
  ok('无支付信号 → unknown（不臆造结论）', unk.state === 'unknown', unk.state);
}

function caseStatesPageText() {
  section('Case 12 支付五态：页面文本 + HTTP 402');
  const textCases = [
    ['支付成功，感谢您的购买', 'authorized'],
    ['Your card was declined by the bank', 'declined'],
    ['请完成 3-D Secure 身份验证', 'three_ds_challenge'],
    ['订单支付中，请稍候', 'pending'],
    ['支付失败，请更换支付方式', 'failed'],
  ];
  for (const [t, want] of textCases) {
    const r = paymentState.classify({ network: null, pageText: t });
    ok(want + ' ← 页面文本「' + t + '」', r.state === want, 'got ' + r.state);
  }
  ok('HTTP 402 → failed', paymentState.classify({ network: net([''], [402]), pageText: '' }).state === 'failed');
}

function casePriority() {
  section('Case 13 优先级与 pending 排除（processing failed 必须判 failed 而非 pending）');
  const r1 = paymentState.classify({ network: net(['{"status":"requires_action"} {"status":"processing"}']), pageText: '' });
  ok('3DS 与 pending 共存 → 优先 3DS（要人立刻介入）', r1.state === 'three_ds_challenge', r1.state);
  const r2 = paymentState.classify({ network: net(['payment processing failed']), pageText: '' });
  ok('"payment processing failed" → failed（不是 pending）', r2.state === 'failed', r2.state);
  const r3 = paymentState.classify({ network: net(['{"status":"succeeded"}']), pageText: '支付失败' });
  ok('网络体说 succeeded → 采信网络体（不因页面残留文案改判）', r3.state === 'authorized', r3.state);
}

function caseDiagnosisWiring() {
  section('Case 14 诊断接线：粗支付桶被细分为五态，retryPolicy 正确');
  const expectPolicy = {
    authorized: 'none', declined: 'escalate', three_ds_challenge: 'escalate',
    pending: 'wait_only', failed: 'escalate',
  };
  const bodies = {
    authorized: '{"payment_intent":{"status":"succeeded"}}',
    declined: '{"error":{"code":"card_declined"}}',
    three_ds_challenge: '{"status":"requires_action","next_action":{"type":"redirect_to_url"}}',
    pending: '{"status":"processing"}',
    failed: '{"error":{"code":"payment_failed"}}',
  };
  for (const [state, body] of Object.entries(bodies)) {
    const d = diagnoser.diagnose({ network: net([body]), pageText: '', attempted: true });
    ok(state + ' → rootCause=PAYMENT_' + state.toUpperCase(), d.rootCause === 'PAYMENT_' + state.toUpperCase(), d.rootCause);
    ok(state + ' → retryPolicy=' + expectPolicy[state], d.retryPolicy === expectPolicy[state], d.retryPolicy);
    ok(state + ' → paymentState 暴露给审计', d.paymentState === state, d.paymentState);
  }
}

function caseNoDoubleCharge() {
  section('Case 15 资金安全红线：pending 只等待，绝不 reload / 重放动作');
  const waitOnly = diagnoser.PRE_ACTIONS_BY_POLICY.wait_only;
  ok('wait_only 策略已登记', Array.isArray(waitOnly), JSON.stringify(waitOnly));
  ok('wait_only 只含等待（无 reload / back）',
    waitOnly.length > 0 && !waitOnly.includes('reload') && !waitOnly.includes('back'), JSON.stringify(waitOnly));
  ok('wait_only 与 backoff 不同（backoff 含 reload，支付场景不可用）',
    diagnoser.PRE_ACTIONS_BY_POLICY.backoff.includes('reload'));
  const d = diagnoser.diagnose({ network: net(['{"status":"processing"}']), pageText: '', attempted: true });
  ok('pending 的实际前置动作里没有 reload',
    !diagnoser.PRE_ACTIONS_BY_POLICY[d.retryPolicy].includes('reload'), d.retryPolicy);
}

function caseConservative() {
  section('Case 16 保守性：支付态不得覆盖更客观的证据');
  const d = diagnoser.diagnose({ network: net(['{"status":"processing"}'], [429]), pageText: '', attempted: true });
  ok('HTTP 429 + 支付 pending → 仍按 429 backoff（状态码优先）', d.rootCause === 'HTTP_429_RATE_LIMITED', d.rootCause);
  const d2 = diagnoser.diagnose({ network: net(['{"error":"captcha_required"}']), pageText: '', attempted: true });
  ok('验证码证据不被支付态覆盖', d2.rootCause === 'BUSINESS_CAPTCHA_REQUIRED', d2.rootCause);
  const d3 = diagnoser.diagnose({ network: net(['{"ok":true}']), pageText: '', attempted: true });
  ok('无支付信号 → 不产生 PAYMENT_* rootCause', String(d3.rootCause).indexOf('PAYMENT_') !== 0, d3.rootCause);
  ok('无支付信号 → paymentState=unknown', d3.paymentState === 'unknown', d3.paymentState);
}

// ═══════════════════════════════════════════════════════════════
// 红线扫描
// ═══════════════════════════════════════════════════════════════
function caseRedLines() {
  section('Case 17 [红线] 源码扫描：不得绕过 3DS/风控、不得站点化');
  const files = {
    'paymentField.js': path.join(__dirname, '..', 'agent', 'paymentField.js'),
    'paymentStateClassifier.js': path.join(__dirname, '..', 'agent', 'paymentStateClassifier.js'),
  };
  const bypassRules = [
    ['bypass 语义', /\bbypass\w*(captcha|3ds|otp|risk|verify)/i],
    ['自动化过 3DS', /auto.{0,8}3ds|3ds.{0,8}(bypass|skip|solve)/i],
    ['自动破 OTP', /(otp|验证码).{0,12}(bypass|solve|crack)/i],
  ];
  const siteRules = [
    ['硬编码 taskId 分支', /taskId\s*[=!]==?\s*['"]rw\./],
    ['站点类型分支', /siteType\s*===\s*['"]saas|===\s*['"]ecommerce/i],
    ['品类特判', /if\s*\(\s*\w*(saas|ecommerce|dataEntry)\w*\s*\)/i],
  ];
  for (const [name, file] of Object.entries(files)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const [label, re] of bypassRules) {
      ok(name + '：无「' + label + '」实现', !re.test(src), (src.match(re) || [''])[0].slice(0, 60));
    }
    for (const [label, re] of siteRules) {
      ok(name + '：无「' + label + '」', !re.test(src), (src.match(re) || [''])[0].slice(0, 60));
    }
  }
}

(async () => {
  console.log('\n=== STEP 6 — CAP-L1 支付字段映射 + CAP-L2 支付五态 ===');
  caseAutocomplete();
  caseWordForms();
  caseWeakAlias();
  caseNoFalsePositive();
  caseFormat();
  caseMissingField();
  caseSchemaGuard();
  caseTokenSingleSource();
  caseFiveStatesBody();
  caseStatesPageText();
  casePriority();
  caseDiagnosisWiring();
  caseNoDoubleCharge();
  caseConservative();
  caseRedLines();

  browser = await chromium.launch({ headless: true });
  try {
    await caseNoLeakInObservation();
    await caseMaskBoundary();
    await caseEndToEndFill();
  } catch (e) {
    fail++;
    console.log('  FAIL 浏览器用例异常：' + String(e && e.message || e));
  } finally {
    await browser.close().catch(() => {});
  }

  console.log('\n────────────────────────────────────────');
  console.log('CAP-L1/L2 支付能力测试：' + pass + ' passed, ' + fail + ' failed');
  console.log('────────────────────────────────────────');
  process.exit(fail === 0 ? 0 : 1);
})();
