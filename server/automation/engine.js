'use strict';

const browserManager = require('../browserManager');
const vault = require('../vault');

// 解析值模板：把 {{email}} / {{password}} / {{card.number}} 等替换为保险库解密值。
function resolveValue(raw, vars) {
  if (typeof raw !== 'string') return raw;
  return raw.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key) => {
    const v = key.split('.').reduce((o, k) => (o == null ? o : o[k]), vars);
    return v == null ? m : String(v);
  });
}

// 从保险库 + 传入变量构造变量表
function buildVars(profileId, extra) {
  const secrets = vault.getProfileSecrets(profileId) || {};
  return { ...secrets, ...(extra || {}) };
}

// 执行单个步骤，记录日志
async function runStep(page, step, vars, log) {
  const args = step.args || {};
  switch (step.action) {
    case 'goto':
      await page.goto(resolveValue(args.url, vars), { timeout: args.timeout || 30000, waitUntil: args.waitUntil || 'load' });
      log.push(`goto ${args.url}`);
      break;
    case 'wait':
      await page.waitForTimeout(args.ms || 1000);
      log.push(`wait ${args.ms || 1000}ms`);
      break;
    case 'waitForSelector':
      await page.waitForSelector(resolveValue(args.selectors || args.selector, vars), { timeout: args.timeout || 15000, state: args.state || 'visible' });
      log.push(`waitForSelector ${resolveValue(args.selectors || args.selector, vars)}`);
      break;
    case 'click':
      await page.click(resolveValue(args.selectors || args.selector, vars), { timeout: args.timeout || 15000 });
      log.push(`click ${resolveValue(args.selectors || args.selector, vars)}`);
      break;
    case 'fill':
      await page.fill(resolveValue(args.selectors || args.selector, vars), resolveValue(args.value, vars), { timeout: args.timeout || 15000 });
      log.push(`fill ${resolveValue(args.selectors || args.selector, vars)} (len=${String(resolveValue(args.value, vars)).length})`);
      break;
    case 'type':
      await page.type(resolveValue(args.selectors || args.selector, vars), resolveValue(args.value, vars), { delay: args.delay || 30 });
      log.push(`type ${resolveValue(args.selectors || args.selector, vars)}`);
      break;
    case 'selectOption':
      await page.selectOption(resolveValue(args.selectors || args.selector, vars), resolveValue(args.value, vars));
      log.push(`selectOption ${resolveValue(args.selectors || args.selector, vars)} = ${resolveValue(args.value, vars)}`);
      break;
    case 'check':
      await page.check(resolveValue(args.selectors || args.selector, vars));
      log.push(`check ${resolveValue(args.selectors || args.selector, vars)}`);
      break;
    case 'extract':
      // 提取文本，存入 result[args.name]
      {
        const sel = resolveValue(args.selectors || args.selector, vars);
        await page.waitForSelector(sel, { timeout: args.timeout || 15000 });
        const txt = await page.textContent(sel);
        vars['$' + (args.name || 'extract')] = txt.trim();
        log.push(`extract ${sel} -> ${(txt || '').slice(0, 80)}`);
      }
      break;
    case 'screenshot':
      await page.screenshot({ path: resolveValue(args.path, vars), fullPage: !!args.fullPage });
      log.push(`screenshot ${resolveValue(args.path, vars)}`);
      break;
    case 'eval':
      const res = await page.evaluate(resolveValue(args.code, vars));
      log.push(`eval -> ${JSON.stringify(res).slice(0, 120)}`);
      break;
    default:
      throw new Error('未知动作: ' + step.action);
  }
}

// 在指定 profile 的运行实例上执行工作流。若无运行实例则临时启动。
async function runWorkflow(profile, steps, opts = {}) {
  const log = [];
  let session = browserManager.getSession(profile.id);
  let owned = false;
  if (!session) {
    const { getProxies } = require('../db');
    session = await browserManager.launch(profile, getProxies());
    owned = true;
  }
  // ctx 同时承载保险库变量与提取结果，统一传给 runStep，避免引用错位。
  const ctx = buildVars(profile.id, opts.vars || {});

  try {
    // 复用现有 page，或用新 page（避免污染主页面）
    const page = opts.freshPage ? await session.context.newPage() : session.page;
    for (const step of steps) {
      await runStep(page, step, ctx, log);
    }
    // 收集以 $ 开头的提取结果
    const extracted = {};
    for (const k of Object.keys(ctx)) if (k.startsWith('$')) extracted[k.slice(1)] = ctx[k];
    return { success: true, log, extracted };
  } catch (e) {
    return { success: false, log, error: String(e.message || e).slice(0, 300) };
  } finally {
    if (owned) await browserManager.close(profile.id).catch(() => {});
  }
}

module.exports = { runWorkflow, resolveValue, buildVars };
