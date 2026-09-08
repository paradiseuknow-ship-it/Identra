// C90 数据清理：重置任务/证据/记忆集合（identity/vault/credentials/settings/aiWorkers 保留）
const fs = require('fs');
const KEEP = /^(identity_|vault\.json$|runtime_settings\.json$|aiCredentials\.json$|aiWorkers\.json$)/;
let reset = 0;
const log = [];
for (const dir of ['data', 'server/data']) {
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || KEEP.test(f)) continue;
    const p = dir + '/' + f;
    let v;
    try { v = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { continue; }
    let empty;
    if (Array.isArray(v)) empty = [];
    else if (v && typeof v === 'object') empty = ('items' in v) ? { items: [] } : {};
    else continue;
    fs.writeFileSync(p, JSON.stringify(empty, null, 2));
    reset++;
    log.push(dir + '/' + f);
  }
}
console.log('reset files:', reset);
console.log(log.join('\n'));
