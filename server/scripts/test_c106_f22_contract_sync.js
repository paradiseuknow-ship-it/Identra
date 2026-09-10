'use strict';

/**
 * C106 F22 —— Planner 契约双路径同步守护（零浏览器）。
 *
 * 铁证：真实站点 E2E 第 7 轮（task_mtuvn2u9zfwk0）—— step_002 连续 25 次
 * ELEMENT_NOT_FOUND，semantic 恒为中文意译「落地页上的注册/开始使用入口按钮」。
 * 根因：planner.js（structured fallback）已要求 semantic 必须为站点原文 verbatim，
 * 而 deepseek.js（**真实 LLM 执行路径**）system prompt 仍明文要求「semantic 为中文语义描述」。
 * plannerContractText.js 头注已记录 P4/P5 踩过同一坑 —— 这是第三次，本测试永久封死第四次。
 */

const path = require('path');
const fs = require('fs');

let pass = 0;
let fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass += 1; console.log('PASS ' + name); } else {
    fail += 1;
    console.log('FAIL ' + name + (detail === undefined ? '' : ' | ' + JSON.stringify(detail)));
  }
}

const dir = path.join(__dirname, '..', 'agent');
const contract = fs.readFileSync(path.join(dir, 'plannerContractText.js'), 'utf8');
const planner = fs.readFileSync(path.join(dir, 'planner.js'), 'utf8');
const deepseek = fs.readFileSync(path.join(dir, 'llm', 'providers', 'deepseek.js'), 'utf8');

// 剥离注释后再做「是否硬编码」判定（注释里出现契约文本不算漂移源，但下文另有专门断言）
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ---------------- P1 单一事实源存在 ----------------
ok(/const SEMANTIC_LANG_CONTRACT\s*=/.test(contract), 'P1.1 共享契约 SEMANTIC_LANG_CONTRACT 已定义');
ok(/const CROSS_ORIGIN_CONTRACT\s*=/.test(contract), 'P1.2 共享契约 CROSS_ORIGIN_CONTRACT 已定义（F21 prompt 层）');
ok(/SEMANTIC_LANG_CONTRACT/.test(contract.split('module.exports')[1] || ''),
  'P1.3 SEMANTIC_LANG_CONTRACT 已导出');
ok(/CROSS_ORIGIN_CONTRACT/.test(contract.split('module.exports')[1] || ''),
  'P1.4 CROSS_ORIGIN_CONTRACT 已导出');
ok(/verbatim/.test(contract), 'P1.5 契约正文含 verbatim 要求（站点原文）');

// ---------------- P2 两条路径都必须引用 ----------------
{
  const pReq = /SEMANTIC_LANG_CONTRACT/.test(planner);
  const dReq = /SEMANTIC_LANG_CONTRACT/.test(deepseek);
  ok(pReq, 'P2.1 planner.js（structured fallback 路径）引用共享契约');
  ok(dReq, 'P2.2 deepseek.js（真实 LLM 执行路径）引用共享契约 ← 本轮核心修复');
}
{
  // 引用必须出现在 prompt 组装处，而非仅 require 解构
  const dSys = deepseek.slice(deepseek.indexOf('const system'), deepseek.indexOf('buildPrompt'));
  ok(/SEMANTIC_LANG_CONTRACT/.test(dSys),
    'P2.3 deepseek 的 system prompt 实际拼接了语义契约（不是只解构不用）');
  ok(/CROSS_ORIGIN_CONTRACT/.test(dSys),
    'P2.4 deepseek 的 system prompt 实际拼接了跨域契约');
}
{
  const pConst = planner.slice(planner.indexOf('const ACTION_CONSTRAINTS'), planner.indexOf('const PLANNER_INSTRUCTIONS'));
  ok(/SEMANTIC_LANG_CONTRACT/.test(pConst),
    'P2.5 planner 的 ACTION_CONSTRAINTS 引用共享契约（不再内联硬编码）');
}

// ---------------- P3 矛盾表述必须消失（只断言可执行面，注释中的缺陷取证允许保留） ----------------
{
  // 注意：断言对象是**真正会被送给 LLM 的字符串**，不是源码全文——注释里引用历史缺陷
  // 表述属于合法取证（本文件 P1/P2 注释即如此），误扫会逼人删证据，属反向激励。
  const dCode = stripComments(deepseek);
  const pCode = stripComments(planner);
  const cCode = stripComments(contract);
  ok(!/semantic\s*为\s*中文语义描述/.test(dCode),
    'P3.1 deepseek 可执行面不得再要求「semantic 为中文语义描述」（与本轮铁证直接矛盾的元凶）');
  ok(!/semantic\s*为\s*中文语义描述/.test(pCode),
    'P3.2 planner 可执行面不得残留该矛盾表述');
  ok(!/semantic\s*为\s*中文语义描述/.test(cCode),
    'P3.3 共享契约可执行面不得残留该矛盾表述');
  // 运行时真值：deepseek 组装出的 system 字符串里不得含该表述
  const dSys = deepseek.slice(deepseek.indexOf('const system'), deepseek.indexOf('buildPrompt'));
  ok(!/中文语义描述/.test(dSys), 'P3.4 deepseek system 拼接区无「中文语义描述」残留');
}

// ---------------- P4 禁止第四处硬编码（防复发） ----------------
{
  // 除了共享契约文件，任何 agent 模块的可执行代码里都不得再出现该契约的完整表述
  const marker = 'semantic 必须是目标站点页面上';
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (f.endsWith('.js')) files.push(p);
    }
  })(dir);
  const offenders = files
    .filter((p) => path.basename(p) !== 'plannerContractText.js')
    .filter((p) => stripComments(fs.readFileSync(p, 'utf8')).indexOf(marker) >= 0)
    .map((p) => path.relative(dir, p));
  ok(offenders.length === 0, 'P4.1 契约正文只在共享文件定义一次（防第三次/第四次漂移）', offenders);
}

// ---------------- P5 契约文本实质一致（两路径同源） ----------------
{
  const mod = require('../agent/plannerContractText');
  ok(typeof mod.SEMANTIC_LANG_CONTRACT === 'string' && mod.SEMANTIC_LANG_CONTRACT.length > 50,
    'P5.1 SEMANTIC_LANG_CONTRACT 可 require 且非空');
  ok(typeof mod.CROSS_ORIGIN_CONTRACT === 'string' && mod.CROSS_ORIGIN_CONTRACT.length > 50,
    'P5.2 CROSS_ORIGIN_CONTRACT 可 require 且非空');
  ok(/原文文本/.test(mod.SEMANTIC_LANG_CONTRACT) && /禁止写/.test(mod.SEMANTIC_LANG_CONTRACT),
    'P5.3 语义契约含「原文文本」要求与禁止示例');
  ok(/禁止在该第三方域上生成\s*fill|第三方域/.test(mod.CROSS_ORIGIN_CONTRACT),
    'P5.4 跨域契约明确禁止第三方域 fill');
  ok(!/webflow|github\.com/i.test(mod.CROSS_ORIGIN_CONTRACT),
    'P5.5 跨域契约零站点名（通用规则）');
}

// ---------------- P7 F23 原生表单优先契约（用户现场指认的根因层） ----------------
{
  const mod = require('../agent/plannerContractText');
  ok(typeof mod.NATIVE_SIGNUP_CONTRACT === 'string' && mod.NATIVE_SIGNUP_CONTRACT.length > 80,
    'P7.1 NATIVE_SIGNUP_CONTRACT 已定义并可 require');
  ok(/注册|sign up/i.test(mod.NATIVE_SIGNUP_CONTRACT)
    && /第三方/.test(mod.NATIVE_SIGNUP_CONTRACT)
    && /禁止/.test(mod.NATIVE_SIGNUP_CONTRACT),
    'P7.2 契约明确：注册类任务禁止把第三方授权当注册手段');
  ok(/填邮箱|分步|下一步/.test(mod.NATIVE_SIGNUP_CONTRACT),
    'P7.3 契约给出正路：按页面分步形态推进（填邮箱 → 下一步 → 填密码）');
  ok(!/webflow|github|google/i.test(mod.NATIVE_SIGNUP_CONTRACT),
    'P7.4 契约零站点名（通用规则，不针对任何具体站点）');
  // 两路径同步（F23 与 F21/F22 同样必须同源，否则又是一次「只修一半」）
  const pConst = planner.slice(planner.indexOf('const ACTION_CONSTRAINTS'), planner.indexOf('const PLANNER_INSTRUCTIONS'));
  const dSys = deepseek.slice(deepseek.indexOf('const system'), deepseek.indexOf('buildPrompt'));
  ok(/NATIVE_SIGNUP_CONTRACT/.test(pConst), 'P7.5 planner 路径引用 F23 契约');
  ok(/NATIVE_SIGNUP_CONTRACT/.test(dSys), 'P7.6 deepseek 真实 LLM 路径引用 F23 契约');
}

console.log('\nRESULT pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
