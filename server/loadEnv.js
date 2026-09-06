'use strict';

// C15: 零依赖 .env 加载器（交付缺陷修复）。
// 背景：此前 .env 只是"文档性"存在 —— server 从不读取它，DEEPSEEK_API_KEY/
// FPB_MASTER_KEY 等必须手工注入进程环境。新环境按 .env.example 配好后启动
// 依然全部失效。本加载器让 `node server/index.js` 开箱即用。
//
// 语义：
// - 默认读项目根 .env；FPB_ENV_FILE 可显式指定（测试隔离通道）。
// - **不覆盖**已有进程环境变量：显式 env > .env（部署/测试注入优先级不变）。
// - 解析规则：忽略空行/# 注释；KEY=VALUE；值两端单/双引号剥除；行内 # 后缀不剥
//   （值内 # 合法，如 base64 可含 #？实际不含，保守不处理行内注释）。
// - 解析失败的单行跳过（不 fail-fast：.env 是便利层，坏行只 warn）。
// - 必须在所有读 env 的模块（settings/browserManager/vault…）之前 require 并调用。

const fs = require('fs');
const path = require('path');

function loadEnv(envFile) {
  const file = envFile
    ? path.resolve(envFile)
    : process.env.FPB_ENV_FILE
      ? path.resolve(process.env.FPB_ENV_FILE)
      : path.join(__dirname, '..', '.env');

  if (!fs.existsSync(file)) return { file, applied: 0 };
  let content = '';
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.warn('[env] .env 读取失败(已忽略):', e.message);
    return { file, applied: 0 };
  }

  let applied = 0;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue; // 无 = 或空 key：跳过
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    }
    if (key in process.env) continue; // 不覆盖显式注入
    process.env[key] = value;
    applied++;
  }
  return { file, applied };
}

module.exports = loadEnv;

// 被 require 即加载（index.js 顶层一行接入，且早于一切读 env 的模块）。
loadEnv();
