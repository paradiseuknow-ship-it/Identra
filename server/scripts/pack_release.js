'use strict';

// C18: portable 发布打包脚本。
// 产出：可分发目录（可选 zip）——目标机器只需 Node 18+，解压后双击 start.bat 即可
// 走完整开箱链（装依赖 → 构建 → 主密钥 → 起服务 → 控制台）。
//
// 安全红线（测试强制断言）：
//   - .env / data/ / vault / runtime_settings / .benchmark / .git / node_modules 绝不入包。
//   - FPB_MASTER_KEY 与任何真实凭据只存在于用户机器，绝不随包分发。
//
// 用法：
//   node server/scripts/pack_release.js                 # 输出 release/identra-v<ver>-win64/
//   node server/scripts/pack_release.js --zip           # 额外产出同名 .zip（Compress-Archive）
//   node server/scripts/pack_release.js --out <dir> --no-zip
//
// staged 首启依赖：start.bat 会 npm install；本包不含 node_modules（Playwright 浏览器
// 也由 start.bat 链路提示 npx playwright install chromium）。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

// 打包白名单（stage 根）：目录 → 递归拷贝（带排除），文件 → 单拷
const COPY_DIRS = [
  { src: 'server', excludes: ['__pycache__'] },
  { src: path.join('client', 'dist') },
];
const COPY_FILES = ['package.json', 'package-lock.json', 'start.bat', 'README.md', '.env.example'];
const EXCLUDE_TOP = new Set([
  'node_modules', 'data', '.git', '.benchmark', '.workbuddy', 'release',
  '.env', '.gitignore', 'client', 'test', 'docs',
]);
// server/ 内永不入包的子项（依赖/运行时数据不在这里，防御性排除）
const SERVER_EXCLUDE = new Set(['__tests__']);

function copyDir(srcAbs, dstAbs, excludes = []) {
  fs.mkdirSync(dstAbs, { recursive: true });
  for (const name of fs.readdirSync(srcAbs)) {
    if (excludes.includes(name) || SERVER_EXCLUDE.has(name)) continue;
    const s = path.join(srcAbs, name);
    const d = path.join(dstAbs, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyDir(s, d, excludes);
    else if (!name.endsWith('.log')) fs.copyFileSync(s, d);
  }
}

function pack(outRoot, { zip = false } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version || '0.0.0';
  const stageName = `identra-v${version}-win64`;
  const stage = path.join(outRoot, stageName);

  // 清空旧 stage
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  for (const d of COPY_DIRS) copyDir(path.join(ROOT, d.src), path.join(stage, d.src), d.excludes);
  for (const f of COPY_FILES) {
    const s = path.join(ROOT, f);
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(stage, f));
  }

  // 秘密排除硬断言（安全红线，pack 即 fail-fast）
  const secrets = ['.env', path.join('data', 'vault.json'), path.join('data', 'runtime_settings.json')];
  for (const rel of secrets) {
    if (fs.existsSync(path.join(stage, rel))) {
      throw new Error('安全红线：秘密文件进入发布包: ' + rel);
    }
  }
  if (fs.existsSync(path.join(stage, 'node_modules'))) {
    throw new Error('安全红线：node_modules 不应进入发布包');
  }

  // 完整性自检：关键文件必须存在
  const required = [
    path.join('server', 'index.js'),
    path.join('server', 'loadEnv.js'),
    path.join('client', 'dist', 'index.html'),
    'start.bat', 'package.json', '.env.example',
  ];
  for (const rel of required) {
    if (!fs.existsSync(path.join(stage, rel))) throw new Error('发布包缺关键文件: ' + rel);
  }

  let zipPath = null;
  if (zip) {
    const z = path.join(outRoot, stageName + '.zip');
    const r = spawnSync('powershell', [
      '-NoProfile', '-Command',
      `Compress-Archive -Path '${stage}\\*' -DestinationPath '${z}' -Force`,
    ], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('Compress-Archive 失败');
    zipPath = z;
  }

  const files = countFiles(stage);
  return { stage, zipPath, version, files };
}

function countFiles(dir) {
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) n += countFiles(p);
    else n++;
  }
  return n;
}

module.exports = { pack };

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const outRoot = get('--out') || path.join(ROOT, 'release');
  const doZip = args.includes('--zip');
  const r = pack(outRoot, { zip: doZip });
  console.log(`[pack] version=${r.version} files=${r.files}`);
  console.log(`[pack] stage: ${r.stage}`);
  if (r.zipPath) console.log(`[pack] zip:   ${r.zipPath}`);
  console.log('[pack] 目标机器：装 Node 18+ → 双击 start.bat（自动装依赖/构建/生成主密钥）→ 控制台 http://127.0.0.1:8787');
}
