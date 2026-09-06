'use strict';

// P1 JSON parse failure 加固（2026-09-01，Final100 rw.063/rw.091 归因后）。
//
// 归因结论（token 取证）：两任务 tokensCompletion 均=18432=9×2048 —— 3 次外层 planner
// attempt × 3 次内层 deepseek 重试，9 次规划调用全部打满 max_tokens:2048 上限被截断，
// JSON 半途而废 → 提取必败 → 同参数重试 → 确定性 9/9 失败。
//
// 本模块职责边界（P1 最小修复原则）：
//   只恢复「模型已表达完整、仅 JSON 外壳不规范」的输出：
//     - markdown code fence 安全剥离（含末尾未闭合围栏）
//     - 合法 JSON 前后的无关解释文本剥离
//     - 首个 { / [ 到末个 } / ] 的单一候选安全提取
//   绝不恢复「模型未表达完整」的输出：
//     - 截断 JSON → UNPARSEABLE（禁止替模型创造缺失的计划语义）
//     - 非法 JSON（trailing comma / 非法 escape）→ UNPARSEABLE
//     - 不猜字段 / 不补字段 / 不 canonicalize / 不降 schema 门槛
//
// 单一实现供 deepseek.plan 与 provider.structured 共用（此前两份同构逻辑存在漂移风险）。

function extractJsonCandidate(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, reason: 'EMPTY_OUTPUT' };

  // 1) markdown 围栏候选：完整围栏块优先；无完整围栏但存在开启围栏时取未闭合块
  const fenced = [];
  const fenceRe = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/gi;
  let m;
  while ((m = fenceRe.exec(t)) !== null) fenced.push(m[1].trim());
  if (!fenced.length) {
    const open = t.match(/```(?:json)?[ \t]*\r?\n?([\s\S]*)$/i);
    if (open) fenced.push(open[1].trim());
  }

  // 2) 依序尝试：围栏块 → 全文首 {/[ 到末 }/] 切片；任一候选解析成功即返回
  const candidates = fenced.concat([t]);
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const start = cand.search(/[{[]/);
    if (start < 0) continue;
    const end = Math.max(cand.lastIndexOf('}'), cand.lastIndexOf(']'));
    if (end <= start) continue;
    try {
      const json = JSON.parse(cand.slice(start, end + 1));
      const sliced = start > 0 || end < cand.length - 1;
      const recovered = i < fenced.length ? 'FENCE' : (sliced ? 'SLICE' : 'RAW');
      return { ok: true, json, recovered };
    } catch (e) { /* 该候选不可解析，尝试下一候选 */ }
  }
  return { ok: false, reason: 'UNPARSEABLE' };
}

module.exports = { extractJsonCandidate };
