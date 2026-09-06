'use strict';
// test_step1_task_contract.js — STEP 1 输入契约修复专项测试
//
// 修复的两处「结构性断链」（来自 STEP 0 运行时取证）：
//
// 缺陷 A：constraints 被创建路径静默丢弃
//   server/agent/index.js:418 与 runtime.js:159 都在传/读 task.constraints，
//   但 taskManager.createTask 从不写这个字段（全仓 grep 0 处写入）。
//   后果：Planner 的 prompt 里渲染「约束：」一栏，却永远拿不到任何约束 —— 约束形同虚设。
//
// 缺陷 B：规划期看不到凭据，只能靠编造
//   真实 LLM 路径（provider 无 raw.plan → 降级 structured → buildStructuredOpts）
//   的 prompt 中 credential 相关出现次数为 0（只有 mock 的 taskLike 命中）。
//   后果：Planner 只能凭空写 credentialRef —— 实测产出 credentialRef:"cvv"，
//   执行期落到 CREDENTIAL_UNAVAILABLE → HUMAN_ESCALATION。
//
// 修复方向：把任务挂载的凭据以「脱敏视图」注入规划 prompt。
// 红线：LLM 只能看到 credentialRef + type + available + masked，
//       永远看不到明文密码 / 完整卡号 / CVV。

const fs = require('fs');
const path = require('path');
const planner = require('../agent/planner');
const taskManager = require('../agent/taskManager');
const secretManager = require('../agent/secretManager');
const vault = require('../vault');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  << ' + extra : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

// 捕获 structured 调用参数的假 provider（模拟真实 LLM：无 raw.plan，只有 chat/structured）
function makeCapturingProvider() {
  const captured = [];
  return {
    captured,
    kind: 'fake-structured-only',
    async structured(ctx, opts) {
      captured.push(opts);
      return { steps: [] }; // 空计划 → 校验失败；本测试只关心 prompt，不关心计划结果
    },
  };
}

(async () => {
  const createdTaskIds = [];
  const createdSecretIds = [];

  try {
    // ───────────────────────────────────────────────────────
    section('Case A  constraints 必须随任务落库并透传到运行时读取路径');
    {
      const constraints = ['不得使用优惠券', '必须使用 profile-p1 的住宅代理', '单笔金额不得超过 100 元'];
      const t = taskManager.createTask({
        name: 'step1-constraints',
        objective: '在示例商城完成一次下单',
        targetUrl: 'https://shop.example.com',
        constraints,
      });
      createdTaskIds.push(t.id);

      ok('A.1 createTask 返回的 task 带 constraints', Array.isArray(t.constraints) && t.constraints.length === 3,
        JSON.stringify(t.constraints));
      const persisted = taskManager.getTask(t.id);
      ok('A.2 从 store 读回的 task 仍带 constraints（真正落库，非内存字段）',
        Array.isArray(persisted.constraints) && persisted.constraints.join('|') === constraints.join('|'),
        JSON.stringify(persisted.constraints));
      ok('A.3 未传 constraints 时为空数组（不是 undefined）',
        Array.isArray(taskManager.createTask({ name: 'no-constraints' }).constraints));

      // 运行时读取路径用的是 task.constraints || []，这里确认读得到值
      const runtimeSeen = persisted.constraints || [];
      ok('A.4 runtime.resolvePlan 读取路径 (task.constraints||[]) 非空', runtimeSeen.length === 3,
        JSON.stringify(runtimeSeen));
    }

    // ───────────────────────────────────────────────────────
    section('Case B  constraints 必须进入 Planner prompt');
    {
      const provider = makeCapturingProvider();
      await planner.planObjective({
        objective: '完成一次下单', target: 'https://shop.example.com',
        constraints: ['不得使用优惠券', '单笔不超过 100 元'],
        credentialRefs: [], provider, ctx: {},
      });
      const prompt = (provider.captured[0] || {}).prompt || '';
      ok('B.1 prompt 含约束行', prompt.indexOf('约束：不得使用优惠券') >= 0, prompt.slice(0, 200));
      ok('B.2 prompt 含全部约束', prompt.indexOf('单笔不超过 100 元') >= 0);
      // 注意：prompt 里另有静态的「Action 约束：」指令头，因此只断言「行首的 约束：」，
      // 避免把指令头误判成任务约束。
      const p2 = makeCapturingProvider();
      await planner.planObjective({ objective: 'x', target: '/', constraints: [], credentialRefs: [], provider: p2, ctx: {} });
      const promptNoConstraints = (p2.captured[0] || {}).prompt || '';
      ok('B.3 无任务约束时不渲染空的约束行', !/^约束：/m.test(promptNoConstraints),
        (promptNoConstraints.split('\n').filter((l) => /^约束：/.test(l)).join('') || '(未渲染)'));
    }

    // ───────────────────────────────────────────────────────
    section('Case C  凭据以脱敏形式进入 Planner prompt（明文永不出 Vault）');
    {
      const profileId = 'profile_step1_test';
      // 写入真实明文凭据（仅本进程内的临时 vault 条目，随后清理）
      vault.setProfileSecrets(profileId, {
        email: 'buyer@example.com',
        password: 'SuperSecretPwd123',
        card: { number: '4111111111111111', expMonth: '12', expYear: '2030', cvv: '123', name: 'Buyer' },
      });
      const rec = secretManager.createSecret({
        profileId, type: 'email_password', site: 'shop.example.com', label: '示例商城账号',
      });
      createdSecretIds.push(rec.id);

      const provider = makeCapturingProvider();
      await planner.planObjective({
        objective: '登录并下单', target: 'https://shop.example.com',
        constraints: [], credentialRefs: [rec.id], provider, ctx: {},
      });
      const prompt = (provider.captured[0] || {}).prompt || '';

      ok('C.1 prompt 出现可用凭据段', prompt.indexOf('可用凭据（Vault 凭据引用，明文不可见）') >= 0,
        prompt.slice(0, 300));
      ok('C.2 prompt 含 credentialRef 原样字符串（Planner 才知道该填什么）',
        prompt.indexOf('credentialRef="' + rec.id + '"') >= 0);
      ok('C.3 prompt 含 type 与 available', /type=email_password/.test(prompt) && /available=true/.test(prompt),
        prompt.split('\n').filter((l) => l.indexOf('credentialRef=') >= 0).join(''));
      ok('C.4 prompt 含脱敏邮箱（b***@example.com 形态）', /maskedEmail=b\*\*\*@example\.com/.test(prompt),
        (prompt.match(/maskedEmail=[^\s]*/) || ['(无)'])[0]);
      ok('C.5 prompt 含脱敏卡号（末四位）', /maskedCard=\*\*\*\*1111/.test(prompt),
        (prompt.match(/maskedCard=[^\s]*/) || ['(无)'])[0]);

      // 红线：明文泄露检查
      ok('C.6 [红线] prompt 不含明文密码', prompt.indexOf('SuperSecretPwd123') === -1);
      ok('C.7 [红线] prompt 不含完整卡号', prompt.indexOf('4111111111111111') === -1);
      ok('C.8 [红线] prompt 不含 CVV 值 123 的裸字段', !/(cvv|cvc)\s*[=:]\s*123/i.test(prompt));
      ok('C.9 [红线] prompt 不含完整邮箱', prompt.indexOf('buyer@example.com') === -1);
      ok('C.10 prompt 明确禁止编造 credentialRef',
        prompt.indexOf('禁止编造不在上表中的 credentialRef') >= 0);

      // 凭据不可用时的引导
      const p2 = makeCapturingProvider();
      await planner.planObjective({
        objective: '登录并下单', target: 'https://shop.example.com',
        constraints: [], credentialRefs: ['cred_不存在的引用'], provider: p2, ctx: {},
      });
      const prompt2 = (p2.captured[0] || {}).prompt || '';
      ok('C.11 未注册引用被标记为 available=false', /available=false/.test(prompt2),
        (prompt2.match(/credentialRef="[^"]*" type=[^\s]* available=\w+/) || ['(无)'])[0]);
    }

    // ───────────────────────────────────────────────────────
    section('Case D  源码红线：凭证相关实现不得把明文送进 prompt');
    {
      const src = fs.readFileSync(path.join(__dirname, '..', 'agent', 'planner.js'), 'utf8');
      ok('D.1 planner 引用 secretManager（脱敏视图来源）', /require\('\.\/secretManager'\)/.test(src));
      ok('D.2 planner 只使用 maskedView 而非 resolve（resolve 会解密明文）',
        /secretManager\.maskedView/.test(src) && !/secretManager\.resolve/.test(src));
      const taskSrc = fs.readFileSync(path.join(__dirname, '..', 'agent', 'taskManager.js'), 'utf8');
      ok('D.3 taskManager 显式持久化 constraints',
        /constraints:\s*Array\.isArray\(input\.constraints\)/.test(taskSrc));
    }
  } catch (e) {
    fail++;
    console.log('  FAIL 测试异常 << ' + (e && e.stack ? e.stack : e));
  } finally {
    for (const id of createdSecretIds) { try { secretManager.remove(id); } catch (e) {} }
    for (const id of createdTaskIds) { try { taskManager.deleteTask(id); } catch (e) {} }
    try { vault.deleteProfileSecrets('profile_step1_test'); } catch (e) {}
  }

  console.log('\n────────────────────────────');
  console.log(`PASS=${pass}  FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
