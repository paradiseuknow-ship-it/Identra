'use strict';
// C32 守护测试 —— 首次运行引导链路（bootstrap contract）。
// 目标：保证「拿到仓库 → 能起来 → 知道缺什么」这条链不被后续改动悄悄破坏。
//   P1 根 start.bat 存在 + ASCII-only（GBK 控制台会把非 ASCII 注释变成乱码，纪律项）
//   P2 start.bat 五步齐全（前置 node 检查 / 服务端依赖 / 客户端依赖 / 构建 / 起服务+开浏览器）
//   P3 start.bat 绝不内嵌真实凭据（不得出现 sk- 明文）
//   P4 pack_release 发布清单含 start.bat + .env.example（「解压双击即可用」不是纸面承诺）
//   P5 .env.example 具备引导所需键位说明（DEEPSEEK_API_KEY / FPB_MASTER_KEY）
//   P6 README 具备上手四件套（install:all / playwright install / start.bat / 就绪检查）

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; failures.push(name + ' :: ' + detail); console.log('FAIL ' + name + ' :: ' + detail); }
}
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

(async () => {
  const batPath = path.join(ROOT, 'start.bat');
  const bat = read(batPath);
  chk('P1a 仓库根存在 start.bat（一键启动）', !!bat, 'missing: ' + batPath);
  if (bat) {
    // ASCII-only 纪律：>0x7E 的字节在 GBK cmd 下会变成乱码/吞掉命令
    const buf = fs.readFileSync(batPath);
    const nonAscii = [];
    for (let i = 0; i < buf.length; i++) if (buf[i] > 0x7e) nonAscii.push(buf[i]);
    chk('P1b start.bat 纯 ASCII（GBK 控制台防乱码）',
      nonAscii.length === 0, 'non-ascii bytes=' + nonAscii.slice(0, 8).join(','));

    const need = [
      ['Node 前置检查', /where node/i],
      ['服务端依赖安装', /npm install/i],
      ['客户端依赖安装', /npm --prefix client install/i],
      ['前端构建', /npm run build/i],
      ['启动服务', /node server\\index\.js/i],
      ['自动打开浏览器', /127\.0\.0\.1:8787/i],
    ];
    const miss = need.filter(([, re]) => !re.test(bat)).map(([k]) => k);
    chk('P2 start.bat 六步齐全', miss.length === 0, 'missing=' + miss.join(' / '));

    chk('P3 start.bat 不含真实密钥明文', !/sk-[A-Za-z0-9]{8,}/.test(bat), 'found sk- literal in start.bat');
  }

  const packSrc = read(path.join(ROOT, 'server', 'scripts', 'pack_release.js')) || '';
  chk('P4a pack_release 清单含 start.bat', /['"]start\.bat['"]/.test(packSrc), 'missing start.bat in COPY_FILES');
  chk('P4b pack_release 清单含 .env.example', /['"]\.env\.example['"]/.test(packSrc), 'missing .env.example in COPY_FILES');

  const envEx = read(path.join(ROOT, '.env.example')) || '';
  chk('P5a .env.example 含 DEEPSEEK_API_KEY 引导项', /DEEPSEEK_API_KEY/.test(envEx), 'missing');
  chk('P5b .env.example 含 FPB_MASTER_KEY 引导项', /FPB_MASTER_KEY/.test(envEx), 'missing');
  chk('P5c .env.example 不含真实密钥值', !/DEEPSEEK_API_KEY=sk-[A-Za-z0-9]{8,}/.test(envEx), 'found populated key');
  chk('P5d 仓库无 .env 入库（真实凭据绝不落库）',
    !fs.existsSync(path.join(ROOT, '.env')) || /^\.env$/m.test(read(path.join(ROOT, '.gitignore')) || ''),
    '.env exists and not ignored');

  const readme = read(path.join(ROOT, 'README.md')) || '';
  const needDoc = [
    ['依赖整体安装', /npm run install:all/],
    ['Chromium 安装', /playwright install chromium/],
    ['一键启动脚本', /start\.bat/],
    ['系统就绪度自检', /就绪|readiness/i],
  ];
  const missDoc = needDoc.filter(([, re]) => !re.test(readme)).map(([k]) => k);
  chk('P6 README 上手四件套齐全', missDoc.length === 0, 'missing=' + missDoc.join(' / '));

  console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
  if (failures.length) { console.error('FAILED:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
