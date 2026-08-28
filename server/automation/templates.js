'use strict';

// 预设工作流模板。选择器由用户在 UI 中按目标站点配置；值用 {{...}} 占位，运行时由保险库解密注入。

// 注册模板：打开站点 -> 填邮箱/密码 -> 提交。selectors 需用户按站点填写。
function registrationTemplate(cfg) {
  cfg = cfg || {};
  const s = cfg.selectors || {};
  return [
    { action: 'goto', args: { url: cfg.url } },
    { action: 'waitForSelector', args: { selector: s.email || 'input[type=email]' } },
    { action: 'fill', args: { selector: s.email || 'input[type=email]', value: '{{email}}' } },
    ...(s.emailConfirm ? [{ action: 'fill', args: { selector: s.emailConfirm, value: '{{email}}' } }] : []),
    ...(s.username ? [{ action: 'fill', args: { selector: s.username, value: '{{username}}' } }] : []),
    { action: 'fill', args: { selector: s.password || 'input[type=password]', value: '{{password}}' } },
    ...(s.passwordConfirm ? [{ action: 'fill', args: { selector: s.passwordConfirm, value: '{{password}}' } }] : []),
    ...(s.submit ? [{ action: 'click', args: { selector: s.submit } }] : []),
    { action: 'wait', args: { ms: cfg.postWaitMs || 2000 } },
    ...(s.successMarker ? [{ action: 'extract', args: { selector: s.successMarker, name: 'result' } }] : []),
  ];
}

// 结账模板：填卡号/CVV/有效期/持卡人 -> 提交支付。
function checkoutTemplate(cfg) {
  cfg = cfg || {};
  const s = cfg.selectors || {};
  return [
    { action: 'goto', args: { url: cfg.url } },
    { action: 'waitForSelector', args: { selector: s.cardNumber || 'input[name=cardnumber]' } },
    { action: 'fill', args: { selector: s.cardNumber || 'input[name=cardnumber]', value: '{{card.number}}' } },
    ...(s.cardName ? [{ action: 'fill', args: { selector: s.cardName, value: '{{card.name}}' } }] : []),
    ...(s.expMonth ? [{ action: 'fill', args: { selector: s.expMonth, value: '{{card.expMonth}}' } }] : []),
    ...(s.expYear ? [{ action: 'fill', args: { selector: s.expYear, value: '{{card.expYear}}' } }] : []),
    ...(s.expiry ? [{ action: 'fill', args: { selector: s.expiry, value: '{{card.expMonth}}/{{card.expYear}}' } }] : []),
    { action: 'fill', args: { selector: s.cvv || 'input[name=cvc]', value: '{{card.cvv}}' } },
    ...(s.billingZip ? [{ action: 'fill', args: { selector: s.billingZip, value: '{{card.zip}}' } }] : []),
    ...(s.pay ? [{ action: 'click', args: { selector: s.pay } }] : []),
    { action: 'wait', args: { ms: cfg.postWaitMs || 3000 } },
    ...(s.successMarker ? [{ action: 'extract', args: { selector: s.successMarker, name: 'paymentResult' } }] : []),
  ];
}

module.exports = { registrationTemplate, checkoutTemplate };
