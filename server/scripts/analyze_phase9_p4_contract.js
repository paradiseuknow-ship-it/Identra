'use strict';
// ============================================================================
// Phase 9 P4 — 契约失配分型（纯只读分析，不改任何代码 / 不改判定）
//
// 背景：20-task 回放证明「VIL 观察窗口已真正工作（217 次有效观察）却 0 次恢复」，
//       说明这些失败不是观察时机问题。VIL 决策里 STATE_UNKNOWN 占 204/214=95%，
//       其语义是「动作成功 + 页面稳定 + DOM 未变 + 目标未观察到」。
//
// 本脚本要回答的唯一问题：STATE_UNKNOWN 到底是
//   (a) CONTRACT_TEXT_MISMATCH —— 契约期望的文案在页面真实内容里根本不存在（提问错了），
//   (b) ACTION_NO_OP           —— 动作自报成功但页面 DOM 一字未变（动作没生效），
//   (c) OTHER                  —— 其他。
//
// 数据来源：.benchmark/phase9_gate4_replay_*.json（真实回放产物，attempt.raw + error）
//          + mock-site fixture 源码（真实页面内容）
// 红线：只读。不修改任何执行 / 验证 / 判定逻辑。
// ============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, '.benchmark');
const MOCK = path.join(ROOT, 'mock-site');

const file = process.argv[2]
  || (() => {
    const cands = fs.readdirSync(OUT_DIR).filter((f) => /^phase9_gate4_replay_\d+\.json$/.test(f));
    cands.sort();
    return path.join(OUT_DIR, cands[cands.length - 1]);
  })();

function tryParseRaw(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  // raw 在采集时被 slice(0, 900) 截断，需容错：逐级砍掉尾部再尝试
  for (let i = 0; i < 40 && s.length > 2; i++) {
    try { return JSON.parse(s); } catch (e) {}
    s = s.slice(0, -1);
    const lastComma = s.lastIndexOf(',');
    // 去掉最后一个不完整字段
    if (lastComma > 0 && s[lastComma - 1] !== '}') s = s.slice(0, lastComma) + '}';
  }
  return null;
}

// 从 VIL 错误报文里抽取未满足的契约条款（形如：required unmet: text_present="耳机" → ...）
function parseUnmet(msg) {
  const out = [];
  const re = /required unmet:\s*([^→\n]+?)\s*→/g;
  let m;
  // raw 是 JSON.stringify 后的字符串，内部引号被转义为 \" —— 需先还原再解析条款
  const unesc = (s) => String(s)
    .replace(/\\u003c/g, '<').replace(/\\u003e/g, '>')
    .replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, ' ');
  while ((m = re.exec(msg))) {
    let u = unesc(m[1]).trim();
    const q = u.match(/^([\w_]+)\s*=\s*(.+)$/);
    if (q) {
      let v = q[2].trim();
      if (v.length > 1 && v[0] === '"' && v[v.length - 1] === '"') v = v.slice(1, -1);
      u = q[1] + '=' + v;
    }
    out.push(u);
  }
  return out;
}

function pageSourceFor(url) {
  try {
    const u = new URL(url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const f = path.join(MOCK, rel);
    if (!f.startsWith(MOCK) || !fs.existsSync(f)) return null;
    return { rel, text: fs.readFileSync(f, 'utf8') };
  } catch (e) { return null; }
}

// 去掉 HTML 标签后的可见文案（粗粒度，够用于「文案是否存在」判定）
function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classify(evType, unmet, src, actionType) {
  if (!unmet.length) return { cls: 'OTHER', note: '无 required unmet 报文' };
  const reasons = [];
  let textMismatch = 0;
  let selectorMismatch = 0;
  let other = 0;
  for (const u of unmet) {
    const mText = u.match(/^text_present\s*=\s*"?([^"]+?)"?$/);
    const mSel = u.match(/^(element_present|element_absent|element_state)\s*=\s*"?([^"]+?)"?$/);
    if (mText) {
      const want = mText[1];
      if (src && !src.text.includes(want)) { textMismatch++; reasons.push('文案「' + want + '」不在 ' + src.rel + ' 源码中'); }
      else other++;
    } else if (mSel) {
      const sel = mSel[2];
      if (src && !new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean).join('|')).test(src.text)) {
        selectorMismatch++; reasons.push('选择器「' + sel + '」不匹配 ' + src.rel);
      } else other++;
    } else {
      other++;
    }
  }
  if (textMismatch && !selectorMismatch) return { cls: 'CONTRACT_TEXT_MISMATCH', note: reasons.join('；') };
  if (selectorMismatch && !textMismatch) return { cls: 'CONTRACT_SELECTOR_MISMATCH', note: reasons.join('；') };
  if (textMismatch && selectorMismatch) return { cls: 'CONTRACT_MIXED_MISMATCH', note: reasons.join('；') };
  if (evType === 'DOM_CHANGED') {
    return { cls: 'DOM_CHANGED_UNMET', note: 'DOM 已变化但契约未满足：' + unmet.join(' | ') };
  }
  return { cls: 'OTHER', note: unmet.join(' | ') };
}

(async () => {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const arr = d.results || [];
  console.log('===== Phase 9 P4 — 契约失配分型（只读）=====');
  console.log('数据源:', path.basename(file));
  console.log('任务数:', arr.length);
  console.log('');

  const byClass = {};
  const samples = {};
  const perTask = [];
  let totalFailedAttempts = 0;

  for (const r of arr) {
    const t = { rw: r.rw, label: r.label, status: r.status, url: r.targetUrl, fails: [] };
    for (const a of (r.attempts || [])) {
      if (a.status === 'SUCCESS') continue;
      totalFailedAttempts++;
      // raw 被 slice(0,900) 截断，error 对象常被切断；故直接在 raw 文本上做正则抽取。
      const rawText = String(a.raw || '');
      const msg = rawText;
      const ftype = (msg.match(/"failureType"\s*:\s*"([A-Z_]+)"/) || [])[1] || 'UNKNOWN';
      const unmet = parseUnmet(msg);
      const src = pageSourceFor(r.targetUrl || '');
      const actType = (rawText.match(/"action"\s*:\s*\{[^}]*"type"\s*:\s*"(\w+)"/) || [])[1]
        || (rawText.match(/"type"\s*:\s*"(\w+)"/) || [])[1] || '?';
      const { cls, note } = classify(ftype, unmet, src, actType);
      byClass[cls] = (byClass[cls] || 0) + 1;
      if (!samples[cls]) samples[cls] = [];
      if (samples[cls].length < 4) samples[cls].push({ rw: r.rw, act: actType, ftype, unmet, note });
      t.fails.push({ act: actType, ftype, cls, unmet, note });
    }
    perTask.push(t);
  }

  console.log('失败 attempt 总数:', totalFailedAttempts);
  console.log('');
  console.log('── 分型汇总 ──');
  for (const [k, v] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) {
    console.log('  ' + String(v).padStart(4) + '  ' + k + '  (' + (v / totalFailedAttempts * 100).toFixed(1) + '%)');
  }
  console.log('');
  for (const [k, list] of Object.entries(samples)) {
    console.log('── 样本 [' + k + '] ──');
    for (const s of list) {
      console.log('  ' + s.rw + '  act=' + s.act + '  vil=' + s.ftype);
      console.log('    unmet: ' + (s.unmet.join(' | ') || '(无)'));
      console.log('    note : ' + s.note);
    }
    console.log('');
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: path.basename(file),
    taskCount: arr.length,
    failedAttempts: totalFailedAttempts,
    byClass,
    samples,
    perTask,
  };
  const outFile = path.join(OUT_DIR, 'phase9_p4_contract_attribution.json');
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log('已写出:', outFile);
})();
