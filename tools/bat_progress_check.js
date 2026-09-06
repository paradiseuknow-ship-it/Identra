#!/usr/bin/env node
// bat 进度检查辅助：bat 里调用，jsonl >= 100 时退出码 0（触发 RUN COMPLETE），否则 1（触发续跑）。
const fs = require('fs');
let n = 0;
try {
  n = fs.readFileSync('.benchmark/phase12_tag_canonical240_run3b.jsonl', 'utf8')
    .trim().split('\n').filter(Boolean).length;
} catch (e) { /* 文件尚不存在 */ }
console.log('PROGRESS=' + n + '/100');
process.exit(n >= 100 ? 0 : 1);
