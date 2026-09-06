'use strict';

// 敏感数据脱敏原语（STEP 2 抽取）。
//
// 为什么独立成文件：STEP 2 的网络层要把「请求头 / 请求体 / 响应体 / console 日志」
// 放进观察结果，这些位置是明文泄露的高危区（Authorization 头、登录接口响应体、
// 前端 console 打印的 token）。网络层不能复用 observation.js 的局部 redact
// （那个函数被 test_security_baseline.js 以源码正则提取的方式直接断言，
//   改其定义会打断该测试），因此在此建立同一规则的规范实现。
//
// ⚠️ 同步纪律：本文件的规则必须与 server/agent/observation.js 内的 redact 保持一致。
//    注意：那边是**模板字符串里的页内脚本**，正则的反斜杠必须写成双份（\\s / \\b / \\d），
//    否则会被模板字面量当成转义序列吃掉（写 \s 变成字母 s、写 \b 变成退格符），
//    正则语法仍然合法但语义全变。改规则时两边都要改，且必须跑
//    test_step5_nearby_text.js 的 Case 8/11（端到端断言，不是源码比对）。
//
// 规则顺序敏感：k=v 规则（1）先于 Bearer/Basic 规则（2），靠规则 1 的负向前瞻
// (?!Bearer\b|Basic\b) 让位 —— 否则 "Authorization: Bearer eyJ..." 会被压成
// "Authorization=REDACTED"，Bearer 标记连同其后内容一起被吃掉，
// 诊断时看不出这是哪种凭据（这是一个已经发生过一次的真实缺陷）。

function redactSecrets(s) {
  return String(s == null ? '' : s)
    // 1) k=v 形态，含 JSON 引号形态（"password":"xxx" —— 接口请求体里最常见的形态）。
    //    负向前瞻：值以 Bearer/Basic 开头时跳过，让位给规则 2。
    //    否则 "Authorization: Bearer eyJ..." 会被压成 "Authorization=REDACTED"，
    //    Bearer 标记连同其后内容一起被吃掉，诊断时看不出这是哪种凭据。
    .replace(
      /(password|passwd|pwd|passcode|cookie|token|authorization|auth|session|sessionid|otp|secret|credential|private[_-]?key|api[_-]?key|access[_-]?key|card|cardnumber|cvv|cvc)\s*["']?\s*[=:]\s*(?!Bearer\b|Basic\b)["']?[^\s"',}]+/gi,
      '$1=REDACTED'
    )
    // 2) Bearer / Basic（顺序敏感：必须在规则 1 之后，由规则 1 的前瞻让位）
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9.\-_~+/=]+/gi, '$1 REDACTED')
    .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, 'CARD_REDACTED')
    .replace(/\b\d{4}[\s-]?\d{6}[\s-]?\d{5}\b/g, 'CARD_REDACTED')   // Amex
    .replace(/\b\d{3,4}\b(?=\s*cvv\b)/gi, 'CVV_REDACTED')
    // 6) CVV「词在前、数字在后」：规则 1 只覆盖 cvv=123（需要 =/: 分隔），
    //    规则 5 只覆盖 123 cvv（数字在前）。而页面真实文本里「CVV 123」同样常见，
    //    这两种顺序之外的形态此前完全漏网 —— 实测 "cvc 123" 原样进入观察结果，
    //    即明文 CVV 会进 LLM 上下文。放在最后执行，不影响前面规则的输出形态。
    .replace(/\b(cvv|cvc|cvn|security\s*code)\s*[:=]?\s*(\d{3,4})\b/gi, '$1 REDACTED');
}

// URL 查询串脱敏：保留结构（便于诊断），去掉值里的凭据类参数
const SENSITIVE_QUERY_KEYS = /(^|&|_)(token|access_token|refresh_token|id_token|auth|authorization|password|passwd|pwd|secret|api[_-]?key|apikey|session|sessionid|sig|signature|otp|code)(=|$)/i;

function redactUrl(u, maxLen) {
  let out = String(u == null ? '' : u);
  try {
    const i = out.indexOf('?');
    if (i >= 0) {
      const base = out.slice(0, i);
      const query = out.slice(i + 1);
      const cleaned = query.split('&').map((seg) => {
        const eq = seg.indexOf('=');
        const key = eq < 0 ? seg : seg.slice(0, eq);
        return SENSITIVE_QUERY_KEYS.test(key) ? key + '=REDACTED' : seg;
      }).join('&');
      out = base + '?' + cleaned;
    }
  } catch (e) { /* URL 畸形时保留原文，由后续统一脱敏兜底 */ }
  if (maxLen && out.length > maxLen) out = out.slice(0, maxLen) + '…';
  return redactSecrets(out);
}

// 截断 + 脱敏：用于请求体 / 响应体 / console 文本
function redactBody(body, maxLen) {
  if (body == null) return null;
  const s = typeof body === 'string' ? body : (() => { try { return JSON.stringify(body); } catch (e) { return String(body); } })();
  const cap = typeof maxLen === 'number' ? maxLen : 600;
  const truncated = s.length > cap ? s.slice(0, cap) + '…[truncated]' : s;
  return redactSecrets(truncated);
}

module.exports = { redactSecrets, redactUrl, redactBody, SENSITIVE_QUERY_KEYS };
