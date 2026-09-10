'use strict';

/**
 * C106 F20 守护测试（零浏览器层）：人类化输入的纯契约面。
 *
 * 覆盖：
 *   P1 typingProfile 节奏与预算（人类区间 / 长值自适应压缩 / 地板值）
 *   P2 valuesMatch 等价判定（严格 / 格式化宽松 / 敏感字段绝不宽松）
 *   P3 describeValue 凭据掩码（LLM 永不见明文）
 *   P4 waitFieldStable 稳定判定（未出现 / 抖动 / 稳定 / 禁用 / 无 page）
 *   P5 纪律锁：无站点名、无绕过动词、不触碰 verification 判据面
 *   P6 接入面：tools.js fill 分支必须真的消费 humanInput（防改模块不接线）
 */

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const humanInput = require(path.join(ROOT, 'server', 'agent', 'humanInput.js'));

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}

console.log('=== P1 typingProfile: 节奏与预算 ===');
{
  const p = humanInput.typingProfile('user@example.com', { field: 'email' });
  const avg = p.baseDelay + p.randomDelay / 2;
  ok(avg >= 80 && avg <= 260, 'P1.1 普通字段每字符均值落在人类区间 80–260ms', avg);
  ok(p.baseDelay >= humanInput.MIN_CHAR_DELAY_MS, 'P1.2 不低于人类节奏地板值', p.baseDelay);

  const s = humanInput.typingProfile('Secret123!', { field: 'password' });
  const avgS = s.baseDelay + s.randomDelay / 2;
  ok(avgS > avg, 'P1.3 凭据类字段比普通字段更慢（给前端实时校验留时间）', { avg, avgS });

  // 超长值必须降级：地板延迟 25ms × 4000 字符 = 100s，会击穿 withBrowserOp 的 25s 超时。
  const pl = humanInput.typingProfile('x'.repeat(4000), {});
  ok(pl.mode === 'fill', 'P1.4 超长值降级为整体赋值（人类长文本靠粘贴，逐字符会击穿超时）', pl);

  const atLimit = humanInput.typingProfile('x'.repeat(humanInput.MAX_TYPED_CHARS), {});
  ok(atLimit.mode === 'type', 'P1.4b 阈值内仍走逐字符输入（邮箱/密码等常规字段）', atLimit);
  const totalL = (atLimit.baseDelay + atLimit.randomDelay / 2) * humanInput.MAX_TYPED_CHARS;
  ok(totalL <= humanInput.TYPING_BUDGET_MS * 1.05, 'P1.4c 阈值内最长值仍在 12s 预算内（有压缩）', totalL);
  ok(atLimit.baseDelay >= humanInput.MIN_CHAR_DELAY_MS, 'P1.5 压缩后仍不低于地板值（不退化成瞬时填充）', atLimit.baseDelay);

  const empty = humanInput.typingProfile('', {});
  ok(empty.baseDelay >= humanInput.MIN_CHAR_DELAY_MS, 'P1.6 空值不产生除零/NaN', empty);
}

console.log('=== P2 valuesMatch: 等价判定 ===');
{
  ok(humanInput.valuesMatch('abc', 'abc', {}).equal === true, 'P2.1 严格相等');
  ok(humanInput.valuesMatch('abc', 'abd', {}).equal === false, 'P2.2 不同值判不等');

  const fmt2 = humanInput.valuesMatch('4111 1111', '41111111', { field: 'phone' });
  ok(fmt2.equal === true && fmt2.normalized === true, 'P2.3 非敏感字段允许前端格式化（去分隔符后相等视为成功）', fmt2);

  const pw = humanInput.valuesMatch('Sec ret', 'Secret', { field: 'password' });
  ok(pw.equal === false, 'P2.4 密码字段绝不宽松比较（空格是有效字符）', pw);
  const cvv = humanInput.valuesMatch('12 3', '123', { field: 'cvv' });
  ok(cvv.equal === false, 'P2.5 CVV 绝不宽松比较', cvv);
  const card = humanInput.valuesMatch('4111 1111', '41111111', { field: 'card' });
  ok(card.equal === false, 'P2.6 卡号字段绝不宽松比较', card);
}

console.log('=== P3 describeValue: 凭据掩码 ===');
{
  const d1 = humanInput.describeValue('Secret123!', 'password');
  ok(d1.sensitive === true && d1.preview === '***', 'P3.1 密码摘要不含明文', d1);
  const d2 = humanInput.describeValue('4111111111111111', 'cardNumber');
  ok(d2.sensitive === true && d2.preview === '***', 'P3.2 卡号摘要不含明文', d2);
  const d3 = humanInput.describeValue('user@example.com', 'email');
  ok(d3.sensitive === false, 'P3.3 非敏感字段保留可读摘要（便于排障）', d3);
  ok(humanInput.describeValue('', 'email').length === 0, 'P3.4 空值长度 0');
}

(async () => {
  console.log('=== P4 waitFieldStable: 稳定判定 ===');
  const mk = (fn) => ({ locator: () => ({}), evaluate: fn });

  const r1 = await humanInput.waitFieldStable(mk(async () => ({ w: 200, h: 40, disabled: false })), '#x', { timeoutMs: 600, intervalMs: 20 });
  ok(r1.stable === true, 'P4.1 两次采样一致 → 稳定', r1);

  const r2 = await humanInput.waitFieldStable(mk(async () => null), '#x', { timeoutMs: 200, intervalMs: 20 });
  ok(r2.stable === false && r2.reason === 'not_visible', 'P4.2 元素不存在 → not_visible（非 crash）', r2);

  let n = 0;
  const r3 = await humanInput.waitFieldStable(mk(async () => { n++; return { w: 100 + (n % 2) * 50, h: 40, disabled: false }; }), '#x', { timeoutMs: 200, intervalMs: 20 });
  ok(r3.stable === false && r3.reason === 'not_settled', 'P4.3 持续抖动 → 超时返回 not_settled（不死循环）', r3);

  const r4 = await humanInput.waitFieldStable(mk(async () => ({ w: 200, h: 40, disabled: true })), '#x', { timeoutMs: 200, intervalMs: 20 });
  ok(r4.stable === false, 'P4.4 禁用字段判不稳定（避免往 disabled 框里输入）', r4);

  const r5 = await humanInput.waitFieldStable(null, '#x', {});
  ok(r5.stable === false && r5.reason === 'no_page', 'P4.5 无 page 安全返回', r5);

  console.log('=== P5 纪律锁 ===');
  const src = fs.readFileSync(path.join(ROOT, 'server', 'agent', 'humanInput.js'), 'utf8');
  ok(!/webflow|perimeterx|px-cloud|cloudflare/i.test(src), 'P5.1 不含站点名/供应商特判');
  ok(!/\bbypass\b|\bsolve\b|spoof/i.test(src), 'P5.2 不含绕过/破解类动词');
  ok(!/networkState|requiredEvidence|businessState|isReady/i.test(src), 'P5.3 不触碰 verification 判据面（Phase 6 红线）');

  const bsrc = fs.readFileSync(path.join(ROOT, 'server', 'browserManager.js'), 'utf8');
  ok(/focusGuard/.test(bsrc), 'P5.4 humanType 具备焦点/回读守卫开关');

  console.log('=== P6 接入面（防改模块不接线）===');
  const tsrc = fs.readFileSync(path.join(ROOT, 'server', 'agent', 'tools.js'), 'utf8');
  ok(/require\('\.\/humanInput'\)/.test(tsrc), 'P6.1 tools.js 已引入 humanInput');
  ok(/humanInput\.typingProfile/.test(tsrc), 'P6.2 fill 使用人类节奏参数');
  ok(/humanInput\.waitFieldStable/.test(tsrc), 'P6.3 fill 输入前等待字段稳定');
  ok(/FILL_VALUE_MISMATCH/.test(tsrc), 'P6.4 fill 回读不一致时 fail-loud');
  ok(!/baseDelay: 30, randomDelay: 60/.test(tsrc), 'P6.5 旧的 60ms/字符 快注入已移除');

  console.log('\n结果: ' + pass + ' passed / ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e && e.message); process.exit(1); });
