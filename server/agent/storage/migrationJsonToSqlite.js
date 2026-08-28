'use strict';

// JSON → SQLite Migration 工具（Phase 4.5）。
// 读取 JsonStore 所有 FILES 集合，批量 upsert 到 SqliteStore。
// 可重复执行：upsert 按 (name,id) 主键幂等，不会产生重复数据。
// 不修改 Agent 层；仅作为一次性/可重跑的数据搬运。

const path = require('path');
const { JsonStore, FILES } = require('./jsonStore');
const { SqliteStore } = require('./sqliteStore');

function run(opts) {
  opts = opts || {};
  const jsonDir = opts.jsonDir || path.join(__dirname, '..', '..', 'data');
  const sqlitePath = opts.sqlitePath || path.join(jsonDir, 'agent.sqlite');

  const json = new JsonStore(jsonDir);
  const sqlite = new SqliteStore(sqlitePath);
  sqlite.open(sqlitePath);

  const names = Object.keys(FILES);
  let total = 0;
  const report = [];
  // 事务化写入整批
  sqlite.transaction(() => {
    for (const name of names) {
      const arr = json.read(name, []);
      let n = 0;
      for (const obj of arr) {
        if (!obj || obj.id == null) continue;
        sqlite.upsert(name, obj);
        n++;
      }
      total += n;
      report.push({ collection: name, count: n });
    }
  });
  sqlite.close();
  return { ok: true, total, collections: report, from: jsonDir, to: sqlitePath };
}

// CLI 入口：node migrationJsonToSqlite.js [--sqlite-path=...] [--json-dir=...]
if (require.main === module) {
  const argv = process.argv.slice(2);
  const getOpt = (k) => {
    const p = argv.find((a) => a.indexOf('--' + k + '=') === 0);
    return p ? p.split('=')[1] : undefined;
  };
  const r = run({ sqlitePath: getOpt('sqlite-path'), jsonDir: getOpt('json-dir') });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}

module.exports = { run };
