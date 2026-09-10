'use strict';
// C108 守护测试 —— provider.mock plan 契约修复（C79 登记的真实 A 类缺陷收口）。
//
// 缺陷：provider.mock planForTask 返回「规范化运行时 Step」（action 为对象、顶层 type:
// 'NAVIGATE'），而 planner.planObjective 对 provider.plan capability 的产出按「严格 Step
// 契约」消费（normalizeStrictToCanonical：顶层 action=动作字符串 + semantic/expectedResult）
// → 归一后全部步骤退化 ACT/空 action/空描述 → validatePlan 恒拒绝 → mock planObjective 恒失败：
//   - /chat mock 模式恒 400（session 创建后规划阶段失败）；
//   - runtime REPLAN 恒 fail-fast（恢复链「意外地快」是死路径副作用，不是性能）。
// 修复：planForTask 产出严格 Step + validatePlanStrict 自校验 fail-loud + 凭据契约对齐
// （有 ref → 身份字段 credentialRef；无 ref → 禁 credentialRef 且敏感字段动作不规划）。
//
// 覆盖（tmp 隔离 + 真实服务器 ×1（P7），Mode A 本地模式，零浏览器零外网）：
//   P1  无凭据：planForTask 产出过 validatePlanStrict；全计划零 credentialRef（空集反向守卫对齐）
//   P2  无凭据：planObjective(mock) ok:true + capability=plan + 步骤类型正确映射（NAVIGATE 打头）
//       + 入口地址保真（首个 NAVIGATE url === 用户 target，C102 链路对 mock 同样成立）
//   P3  有凭据：validatePlanStrict 过；email/password 两步均 credentialRef 且无 value 编造
//   P4  有凭据：planObjective(mock) ok:true，凭据步保留 credentialRef（引用不可用清单不误伤）
//   P5  漂移守卫：违反 strict 契约的步骤（缺 semantic/expectedResult）被 validatePlanStrict 拒绝
//       + provider.mock 源码消费 validatePlanStrict（fail-loud 自校验落盘）
//   P6  replan(mock) 端到端 ok:true，产出可执行剩余步骤（REPLAN 死路径激活实证）
//   P7  真实服务器 /chat × mock → 200 + taskId + 计划已挂载（生产入口全链，修复前恒 400）

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}

// tmp 隔离数据目录（必须先于 require server 模块）
const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fpb-c108-'));
process.env.FPB_DATA_DIR = DATA_DIR;
process.env.FPB_MASTER_KEY = Buffer.alloc(32, 12).toString('base64');

require('../agent/provider.mock'); // 注册 mock factory（注册副作用）
const { planForTask, mockFactory } = require('../agent/provider.mock');
const { validatePlanStrict } = require('../agent/schema/plan');
const planner = require('../agent/planner');
const { createProvider } = require('../agent/llm/provider');

const TARGET = 'http://127.0.0.1:9555/form';

// ---------------------------------------------------------------- P1–P6：in-process 契约链
(async () => {
  try {
    const prov = createProvider('mock');
    chk('P0 provider 门面解析 mock', prov && prov.kind === 'mock', String(prov && prov.kind));

    // P1 无凭据：strict 契约 + 空集反向守卫对齐
    const stepsNoRef = planForTask({ targetUrl: TARGET, secretRefs: [] });
    const vr1 = validatePlanStrict({ steps: stepsNoRef });
    chk('P1a 无凭据 planForTask 过 validatePlanStrict', vr1.ok, vr1.ok ? '' : (vr1.errors || []).slice(0, 3).join('; '));
    const credLeak = (vr1.ok ? vr1.plan.steps : []).filter((s) => s.credentialRef);
    chk('P1b 无凭据计划零 credentialRef（空集反向守卫对齐）', vr1.ok && credLeak.length === 0, 'credSteps=' + credLeak.length);
    const sensNoRef = vr1.ok ? vr1.plan.steps.filter((s) => /password/i.test(String(s.target && s.target.field || ''))) : [];
    chk('P1c 无凭据不规划敏感字段动作', sensNoRef.length === 0, 'sensSteps=' + sensNoRef.length);

    // P2 无凭据：planObjective 全链（门面 → normalizeStrictToCanonical → validatePlan → 守卫）
    const r2 = await planner.planObjective({
      objective: '注册演示账号', target: TARGET, credentialRefs: [], provider: prov,
      ctx: { taskId: 'task_c108_p2' },
    });
    chk('P2a planObjective(mock) ok:true（修复前恒失败）', r2.ok === true, r2.ok ? '' : String(r2.error).slice(0, 160));
    chk('P2b capability=plan（走 strict 归一链）', r2.ok && r2.capability === 'plan', String(r2.capability));
    const types2 = r2.ok ? r2.plan.steps.map((s) => s.type) : [];
    chk('P2c 步骤类型正确映射且 NAVIGATE 打头', types2[0] === 'NAVIGATE' && types2.includes('OBSERVE') && types2.includes('ACT'),
      types2.join(','));
    const nav2 = r2.ok ? r2.plan.steps.find((s) => s.type === 'NAVIGATE') : null;
    chk('P2d 入口地址保真（C102 链路对 mock 同样成立）', nav2 && nav2.action && nav2.action.target && nav2.action.target.url === TARGET,
      String(nav2 && nav2.action && nav2.action.target && nav2.action.target.url));
    const emptyDesc = r2.ok ? r2.plan.steps.filter((s) => !s.description) : ['plan-failed'];
    chk('P2e 全部步骤 description 非空（修复前恒空）', emptyDesc.length === 0, 'emptyDesc=' + emptyDesc.length);

    // P3 有凭据：credentialRef 对齐（email/password 身份字段一律引用）
    const stepsRef = planForTask({ targetUrl: TARGET, secretRefs: ['cred_c108_x'] });
    const vr3 = validatePlanStrict({ steps: stepsRef });
    chk('P3a 有凭据 planForTask 过 validatePlanStrict', vr3.ok, vr3.ok ? '' : (vr3.errors || []).slice(0, 3).join('; '));
    const idSteps = vr3.ok ? vr3.plan.steps.filter((s) => /email|password/i.test(String(s.target && s.target.field || ''))) : [];
    chk('P3b email+password 两步均 credentialRef', idSteps.length === 2 && idSteps.every((s) => s.credentialRef === 'cred_c108_x'),
      JSON.stringify(idSteps.map((s) => ({ f: s.target.field, ref: s.credentialRef, v: s.value }))));
    chk('P3c 身份字段零 value 编造', idSteps.every((s) => s.value === undefined || s.value === null),
      JSON.stringify(idSteps.map((s) => s.value)));

    // P4 有凭据：planObjective 保留凭据引用（引用不可用清单不误伤：getByRef 抛错 → 无可用 → 不约束）
    const r4 = await planner.planObjective({
      objective: '注册演示账号', target: TARGET, credentialRefs: ['cred_c108_unavailable'], provider: prov,
      ctx: { taskId: 'task_c108_p4' },
    });
    const credSteps4 = r4.ok ? r4.plan.steps.filter((s) => s.action && s.action.credentialRef) : [];
    chk('P4 planObjective 保留 credentialRef（不误伤不可用清单）', r4.ok && credSteps4.length === 2,
      r4.ok ? 'credSteps=' + credSteps4.length : String(r4.error).slice(0, 160));

    // P5 漂移守卫：strict 违约被拒 + 源码自校验锚点
    const drifted = planForTask({ targetUrl: TARGET, secretRefs: [] }).map((s, i) => (i === 1 ? { action: s.action, target: s.target } : s));
    const vr5 = validatePlanStrict({ steps: drifted });
    chk('P5a 缺 semantic/expectedResult 的步骤被 strict 校验拒绝', vr5.ok === false, vr5.ok ? '意外通过' : (vr5.errors || []).slice(0, 2).join('; '));
    const mockSrc = fs.readFileSync(path.join(ROOT, 'server', 'agent', 'provider.mock.js'), 'utf8');
    chk('P5b provider.mock 消费 validatePlanStrict 自校验（fail-loud 落盘）',
      mockSrc.includes("require('./schema/plan')") && mockSrc.includes('validatePlanStrict({ steps })'), 'anchor missing');

    // P6 replan(mock) 端到端（修复前恒 {ok:false} → 恒 fail-fast）
    const task6 = { id: 'task_c108_rp', objective: '注册演示账号', targetUrl: TARGET };
    const rp = await planner.replan(task6, { url: TARGET, elements: [] }, [], prov);
    chk('P6a replan(mock) ok:true（REPLAN 死路径激活）', rp && rp.ok === true, rp ? String(rp.error).slice(0, 160) : 'null');
    chk('P6b replan 产出非空可执行剩余步骤', rp && Array.isArray(rp.steps) && rp.steps.length >= 4,
      rp && rp.steps ? 'steps=' + rp.steps.length : 'null');
  } catch (e) {
    chk('P1-P6 in-process 链', false, String(e && e.stack || e).slice(0, 400));
  }

  // ---------------------------------------------------------------- P7：真实服务器 /chat 全链
  const PORT = 22890 + (process.pid % 50);
  function req(method, p, body) {
    return new Promise((resolve) => {
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const r = http.request('http://127.0.0.1:' + PORT + p, { method, timeout: 20000, headers }, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => resolve({ code: res.statusCode, body: d }));
      });
      r.on('error', (e) => resolve({ code: 0, body: String(e) }));
      r.on('timeout', () => { r.destroy(); resolve({ code: 0, body: 'TIMEOUT' }); });
      if (body !== undefined) r.write(JSON.stringify(body));
      r.end();
    });
  }
  const j = (r) => { try { return JSON.parse(r.body); } catch (e) { return null; } };

  let child = null;
  try {
    child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      env: {
        ...process.env,
        PORT: String(PORT),
        AI_PROVIDER: 'mock',
        FPB_DATA_DIR: DATA_DIR,
        FPB_VAULT_FILE: path.join(DATA_DIR, 'vault.json'),
        FPB_SETTINGS_FILE: path.join(DATA_DIR, 'runtime_settings.json'),
        DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', AI_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const logs = [];
    child.stdout.on('data', (c) => logs.push(String(c)));
    child.stderr.on('data', (c) => logs.push(String(c)));
    let ready = false;
    for (let i = 0; i < 40; i++) {
      const r = await req('GET', '/api/auth/me');
      if (r.code === 200 || r.code === 401) { ready = true; break; }
      await new Promise((s) => setTimeout(s, 300));
    }
    chk('P7a 服务器启动（tmp 隔离）', ready, logs.join('').slice(-300));

    const chat = await req('POST', '/api/ai/chat', { message: '请打开 ' + TARGET + ' 完成注册（C108 契约取证）' });
    const cj = j(chat);
    chk('P7b /chat mock → 200（修复前恒 400）', chat.code === 200, 'code=' + chat.code + ' ' + chat.body.slice(0, 160));
    chk('P7c 返回 taskId + 计划步骤', !!(cj && cj.taskId) && cj.plan && Array.isArray(cj.plan.steps) && cj.plan.steps.length >= 4,
      chat.body.slice(0, 200));
    if (cj && cj.taskId) {
      const gt = await req('GET', '/api/ai/tasks/' + cj.taskId);
      const tj = j(gt);
      chk('P7d 任务真实落库且计划已挂载', gt.code === 200 && tj && tj.id === cj.taskId && String(tj.status || '') !== '',
        gt.code + ' ' + gt.body.slice(0, 160));
    }
  } catch (e) {
    chk('P7 服务器链', false, String(e && e.stack || e).slice(0, 400));
  } finally {
    if (child) { try { child.kill(); } catch (e) {} }
  }

  console.log('\n==== C108 RESULT: ' + pass + ' pass / ' + fail + ' fail ====');
  if (failures.length) failures.forEach((f) => console.log('  FAILED: ' + f));
  process.exit(fail ? 1 : 0);
})();
