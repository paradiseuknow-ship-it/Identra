'use strict';

// ============================================================================
// Credential Reseed —— 仅在你自己的运行环境执行。
//
// 纪律（来自用户指令）：
//   * 真实账号 / 密码 / 支付卡 绝不写进聊天窗口、绝不硬编码进代码。
//   * 凭据只从「运行环境变量」或「你控制的本地安全文件」读取。
//   * 绝不为了 Gate 临时造账号密码。
//   * FPB_MASTER_KEY 必须稳定（32 字节 base64），否则重启后已存凭据不可解密。
//
// 本脚本做的事：
//   1) 用稳定 FPB_MASTER_KEY 解锁 Vault（vault 自动读取该 env）
//   2) 把真实凭据加密落盘（vault.json，仅密文）
//   3) 在 secretManager 注册 credentialRef，并校验 resolved=true
//   4) 只打印脱敏视图 + credentialRef；绝不打印明文
//   5) 写出一个 gate_creds.json（仅含引用，无明文）供 gate 脚本自动读取
//
// 调用示例（真实凭据来自你的环境，不要贴给我/WorkBuddy）：
//   export FPB_MASTER_KEY="<稳定32字节base64>"
//   export GATE_PROFILE_ID="p_real_saas"
//   export GATE_EMAIL="you@example.com"
//   export GATE_PASSWORD="<真实密码>"
//   # 可选支付卡：
//   export GATE_CARD_NUMBER="4111111111111111"
//   export GATE_CARD_EXP_MONTH="12"
//   export GATE_CARD_EXP_YEAR="29"
//   export GATE_CARD_CVV="123"
//   export GATE_CARD_NAME="YOU"
//   node server/scripts/credential_reseed.js
//
// 或者把真实凭据放在一个 gitignore 的安全文件里：
//   export GATE_SECRETS_FILE="/secure/path/gate_secrets.json"  # { profileId, email, password, card:{...} }
//   node server/scripts/credential_reseed.js
// ============================================================================

const fs = require('fs');
const path = require('path');
const vault = require('./server/vault');
const sm = require('./server/agent/secretManager');

function loadFromSecretsFile() {
  const f = process.env.GATE_SECRETS_FILE;
  if (!f) return null;
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  const secrets = {};
  if (raw.email) secrets.email = raw.email;
  if (raw.password) secrets.password = raw.password;
  if (raw.card) secrets.card = raw.card;
  return { profileId: raw.profileId, secrets };
}

function loadFromEnv() {
  const profileId = process.env.GATE_PROFILE_ID;
  const secrets = {};
  if (process.env.GATE_EMAIL) secrets.email = process.env.GATE_EMAIL;
  if (process.env.GATE_PASSWORD) secrets.password = process.env.GATE_PASSWORD;
  if (process.env.GATE_CARD_NUMBER) {
    secrets.card = {
      number: process.env.GATE_CARD_NUMBER,
      expMonth: process.env.GATE_CARD_EXP_MONTH || '',
      expYear: process.env.GATE_CARD_EXP_YEAR || '',
      cvv: process.env.GATE_CARD_CVV || '',
      name: process.env.GATE_CARD_NAME || '',
    };
  }
  return { profileId, secrets };
}

function main() {
  if (!process.env.FPB_MASTER_KEY) {
    throw new Error('FPB_MASTER_KEY 未设置。请先在运行环境导出稳定主密钥（32 字节 base64）。');
  }

  const fromFile = loadFromSecretsFile();
  const fromEnv = loadFromEnv();
  const input = fromFile || (fromEnv.profileId || fromEnv.secrets.email || fromEnv.secrets.password || fromEnv.secrets.card ? fromEnv : null);
  if (!input) {
    throw new Error('未提供任何真实凭据。请通过 GATE_SECRETS_FILE 或 GATE_PROFILE_ID+GATE_EMAIL/GATE_PASSWORD/GATE_CARD_* 提供。不要为 Gate 临时造账号密码。');
  }

  const { profileId, secrets } = input;
  if (!profileId) throw new Error('缺少 profileId（GATE_PROFILE_ID 或 secrets 文件中的 profileId）。');
  if (!secrets.email && !secrets.password && !secrets.card) {
    throw new Error('凭据内容为空。请提供真实 email/password/card，不要留空。');
  }

  // 1) Vault 解锁 + 写入真实凭据（加密落盘）
  vault.setProfileSecrets(profileId, secrets);

  // 2) 注册引用（email_password / payment），并校验 resolved
  const refs = [];
  if (secrets.email || secrets.password) {
    const c = sm.createSecret({ profileId, type: 'email_password', site: process.env.GATE_SITE || 'gate' });
    refs.push(c.id);
  }
  if (secrets.card) {
    const c = sm.createSecret({ profileId, type: 'payment', site: process.env.GATE_SITE || 'gate' });
    refs.push(c.id);
  }

  // 3) 读取验证：resolved=true（仅脱敏视图）
  const resolved = refs.map((ref) => {
    const rec = sm.getByRef(ref);
    return { ref, type: rec.type, available: !!rec.available };
  });
  const allResolved = resolved.every((r) => r.available);
  if (!allResolved) {
    throw new Error('reseed 失败：部分凭据 unresolved（vault 无对应密文）。检查 FPB_MASTER_KEY 是否稳定且与写入时一致。');
  }

  const masked = vault.getMaskedSummary(profileId);

  // 4) 写出引用（不含任何明文）供 gate 脚本自动读取
  const outPath = path.join(__dirname, 'gate_creds.json');
  fs.writeFileSync(outPath, JSON.stringify({ profileId, refs, masked }, null, 2));

  console.log('=== Credential Reseed OK ===');
  console.log('profileId   :', profileId);
  console.log('resolved    :', allResolved, '(credentialRef -> resolved=true)');
  console.log('refs        :', refs.join(', '));
  console.log('masked      :', JSON.stringify(masked));
  console.log('wrote       :', outPath, '(仅含引用，无明文)');
  console.log('下一步      : 运行 node server/scripts/run_4task_gate.js');
}

try {
  main();
} catch (e) {
  console.error('[reseed] 失败:', e.message);
  process.exit(1);
}
