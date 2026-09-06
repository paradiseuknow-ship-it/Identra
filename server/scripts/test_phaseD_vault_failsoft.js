'use strict';
// Phase D 交付健壮性测试 —— vault fail-soft 摘要
// 缺陷背景：GET /api/profiles 在任一 profile vault 解密失败（FPB_MASTER_KEY 缺失/更换/
// 数据损坏）时整端点 500 —— 新环境首次启动必踩的可用性阻断。
// 修复语义：getMaskedSummary（只读展示面）fail-soft 返回 locked 摘要；
//           getProfileSecrets（执行/自动化消费面）保持 fail-closed 抛错。
// 运行方式：本测试通过子进程 + FPB_VAULT_FILE(os.tmpdir) + 两个不同主密钥模拟密钥更换。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const pass = [];
const fail = [];
function t(name, fn) {
  try { fn(); pass.push(name); console.log('  PASS', name); }
  catch (e) { fail.push(name); console.error('  FAIL', name, '->', e.message); }
}

const tmpVault = path.join(os.tmpdir(), `fpb-vault-failsoft-${process.pid}.json`);
const CHILD_SCRIPT = `
const vault = require('${path.join(__dirname, '..', 'vault.js').replace(/\\/g, '\\\\')}');
const profileId = process.argv[1];
const mode = process.argv[2];
if (mode === 'seed') {
  vault.setProfileSecrets(profileId, { email: 'a@b.com', password: 'secret123', card: { number: '4111111111111111', cvv: '123', expMonth: '12', expYear: '2030', name: 'TEST' } });
  console.log(JSON.stringify({ ok: true }));
} else if (mode === 'summary') {
  let summary = null, secretErr = null;
  try { summary = vault.getMaskedSummary(profileId); } catch (e) { secretErr = e.message; }
  let secretThrew = false;
  try { vault.getProfileSecrets(profileId); } catch (e) { secretThrew = true; }
  console.log(JSON.stringify({ summary, secretThrew }));
}
`;

function runChild(envKey, mode, profileId) {
  const out = execFileSync(process.execPath, ['-e', CHILD_SCRIPT, '--', profileId, mode], {
    env: { ...process.env, FPB_MASTER_KEY: envKey, FPB_VAULT_FILE: tmpVault },
    encoding: 'utf8',
  });
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  return JSON.parse(line);
}

try {
  const KEY_A = Buffer.from('A'.repeat(32)).toString('base64');
  const KEY_B = Buffer.from('B'.repeat(32)).toString('base64');

  // seed：用密钥 A 写入凭据
  runChild(KEY_A, 'seed', 't_failsoft');

  // 1) 密钥匹配：摘要正常、无 locked
  const okState = runChild(KEY_A, 'summary', 't_failsoft');
  t('密钥匹配：摘要正常（emailMasked/numberMasked）', () => {
    assert.strictEqual(okState.summary.locked, undefined);
    assert.ok(okState.summary.emailMasked && okState.summary.emailMasked.includes('****'));
    assert.ok(okState.summary.card && okState.summary.card.numberMasked.startsWith('****'));
    assert.strictEqual(okState.secretThrew, false);
  });

  // 2) 密钥更换（解密失败）：摘要 fail-soft 返回 locked，不抛错
  const mismatch = runChild(KEY_B, 'summary', 't_failsoft');
  t('密钥更换：getMaskedSummary fail-soft 返回 locked:true（不抛错）', () => {
    assert.strictEqual(mismatch.summary && mismatch.summary.locked, true);
    assert.strictEqual(mismatch.summary.vaultError, 'DECRYPT_FAILED');
    assert.strictEqual(mismatch.summary.hasEmail, false);
    assert.strictEqual(mismatch.summary.card, null);
  });

  // 3) 执行面保持 fail-closed：getProfileSecrets 仍抛错（自动化不消费坏数据）
  t('密钥更换：getProfileSecrets 保持 fail-closed（抛错）', () => {
    assert.strictEqual(mismatch.secretThrew, true);
  });

  // 4) 不存在的 profile：摘要返回 null（语义不变）
  const missing = runChild(KEY_B, 'summary', 't_not_exist');
  t('不存在 profile：getMaskedSummary 返回 null（语义不变）', () => {
    assert.strictEqual(missing.summary, null);
  });
} finally {
  try { fs.unlinkSync(tmpVault); } catch (e) {}
}

console.log(`\\nRESULT pass=${pass.length} fail=${fail.length}`);
process.exit(fail.length ? 1 : 0);
