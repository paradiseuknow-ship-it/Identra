'use strict';

// C197 守护：编辑器「基于 IP」预览的 inline 代理断点修复 + 代理热切换 UX 收口。
//
// 两个用户实测失败面（2026-11-01 用户报告）：
//   ①「生成新指纹」后显示 Asia/Shanghai / 36.67,117.00 / zh-CN（本机直连出口），
//     用户配置的（海外）代理 IP 未参与解析 —— 根因：refreshPreview 只传 proxyId，
//     proxyMode='inline'（直接填写代理）时 proxyInline 从未进 preview-fp 请求
//     ⇒ 后端 resolveProxy=null ⇒ 直连解析 ⇒ 预览与运行态不一致（C193 残留前端断点）。
//     同族：regenerateSeed 只发 {regenerateSeed:true}，用户刚改的新 IP 不落库、
//     服务端用库内旧（已过期）代理解析 ⇒ unresolved ⇒ 静默保留旧指纹。
//   ②「IP 过期后重新编辑设置网络，浏览器依然无法访问，必须全部关闭重开」——
//     C192 热切换机制正常（launch 对 running 实例按 proxySourceSig 自动 relaunch），
//     但保存后只弹提示「点一次启动」而列表 running 态**没有启动按钮** ⇒ 机制永远走不到。
//
// 修复（全前端接线，后端 preview-fp / launch / proxySignature 均已支持、零改动）：
//   a) refreshPreview 传 proxyInline（组装口径与 buildPayload 严格一致）+ inline 字段
//      变化 300ms 防抖重取预览；
//   b) regenerateFingerprint 非新建态 = {...buildPayload(form), regenerateSeed:true}
//      —— 以当前表单（含刚改的 IP）为基准换 seed 重解析；
//   c) applyProxyHotswap：restartRequired 时自动 api.launch 完成重建（save 与
//      regenerate 两路共用）；失败降级提示手动停止→启动；
//   d) 列表 running 态补「重启」按钮（onLaunch 幂等：未变代理=reuse 零副作用）。
//
// 守护策略：React 组件无 headless 运行基建 ⇒ 源断言（test_c70/c74/c112 先例）；
// 咬点回改见各断言注释。

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CLIENT = path.join(ROOT, 'client', 'src');
const peSrc = fs.readFileSync(path.join(CLIENT, 'components', 'ProfileEditor.jsx'), 'utf8');
const appSrc = fs.readFileSync(path.join(CLIENT, 'App.jsx'), 'utf8');
const apiSrc = fs.readFileSync(path.join(CLIENT, 'api.js'), 'utf8');

let passed = 0, failed = 0;
function chk(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS', name); }
  else { failed++; console.error('  FAIL', name, detail ? '- ' + detail : ''); process.exitCode = 1; }
}

console.log('A. Bug1 修复面（inline 预览断点）');

// A1 previewFp 请求必须带 proxyInline（咬 1：去掉即红）
chk('A1 previewFp 传 proxyInline', /api\.previewFp\(\{[\s\S]{0,400}?proxyInline:\s*inlineProxyForPreview\(\)/.test(peSrc));

// A2 inline 组装口径与 buildPayload 严格一致：proxyMode==='inline' && host && port，
//    server = host:port，type 默认 socks5（咬 1 的另一种回改：组装条件不一致）
chk('A2a inline 组装含 proxyMode 守卫', /inlineProxyForPreview[\s\S]{0,300}form\.proxyMode !== 'inline'/.test(peSrc));
chk('A2b inline 组装含 host/port 前置', /inlineProxyForPreview[\s\S]{0,300}pi\?\.[\s\S]{0,60}pi\?\./.test(peSrc) || /pi\?\.host/.test(peSrc.slice(peSrc.indexOf('inlineProxyForPreview'), peSrc.indexOf('inlineProxyForPreview') + 500)));
chk('A2c server 形态 host:port', /server: `\$\{pi\.host\}:\$\{pi\.port\}`/.test(peSrc));

// A3 regenerate 非新建态以当前表单为基准（咬 2：回改裸 regenerateSeed 即���）
chk('A3 regenerate 合并 buildPayload + regenerateSeed', /api\.updateProfile\(profile\.id, \{ \.\.\.buildPayload\(form\), regenerateSeed: true \}\)/.test(peSrc));

// A4 inline 字段变化触发预览重取（防抖 300ms，咬：去掉依赖/防抖即回归「填完 IP 概要不动」）
chk('A4 inline 变化防抖重取预览', /useEffect\(\(\) => \{\s*const t = setTimeout\(\(\) => \{ refreshPreview\(\); \}, 300\);[\s\S]{0,120}?return \(\) => clearTimeout\(t\);[\s\S]{0,120}?\}, \[form\.proxyInline\]\)/.test(peSrc));

console.log('B. Bug2 修复面（热切换 UX 收口）');

// B1 applyProxyHotswap 存在且 restartRequired 才动（幂等守卫）
chk('B1 applyProxyHotswap 定义 + restartRequired 守卫', /const applyProxyHotswap = async \(saved\) => \{[\s\S]{0,200}saved\.restartRequired/.test(peSrc));

// B2 热切换动作 = 自动 api.launch（咬 3：回改成纯提示即红）
chk('B2 hotswap 自动调 api.launch', /applyProxyHotswap[\s\S]{0,600}api\.launch\(saved\.id\)/.test(peSrc));

// B3 save 与 regenerate 两路都走 hotswap
chk('B3a save() 调 applyProxyHotswap', /if \(saved && saved\.restartRequired\) \{\s*await applyProxyHotswap\(saved\);/.test(peSrc));
chk('B3b regenerate 调 applyProxyHotswap', /await applyProxyHotswap\(updated\);/.test(peSrc));

// B4 launch 失败降级提示（不静默吞错 —— 自动动作失败必须可见）
chk('B4 hotswap 失败降级提示', /applyProxyHotswap[\s\S]{0,800}自动重启失败/.test(peSrc));

// B5 列表 running 态补「重启」按钮（咬 4：去掉即红）
chk('B5 App running 组含重启按钮(onLaunch)', appSrc.includes("onClick={() => onLaunch(p.id)}") && appSrc.includes('>重启</button>') &&
  // 重启按钮必须在 running 分支内（p.running ? 分支先于 else 的启动按钮）
  appSrc.indexOf('实时画面') < appSrc.indexOf('>重启</button>') && appSrc.indexOf('>重启</button>') < appSrc.indexOf('>停止</button>'),
  '重启按钮须位于 running 按钮组');

// B6 旧提示文案退役：不应再出现「点一次『启动』」的把动作甩回用户的提示
chk('B6 旧"点一次启动"提示已退役', !peSrc.includes('点一次「启动」'));

console.log('C. 后端支撑面（既有能力核对，零改动验证）');

// C1 preview-fp 后端本就支持 proxyInline（前端断点的对端证据）
const idxSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
chk('C1 preview-fp 收 proxyInline', /preview-fp[\s\S]{0,600}proxyInline: req\.body\.proxyInline/.test(idxSrc));

// C2 launch 路由对 running 实例 relaunch（C192 机制）+ proxySwitched 回传 —— B2 的后端依赖
chk('C2 launch 路由回传 proxySwitched', /res\.json\(\{ ok: true, running: true, proxySwitched \}\)/.test(idxSrc));

// C3 updateProfile 支持额外字段合并（regenerateSeed 与代理字段同一 payload）
chk('C3 api.updateProfile 存在（本批复用，不新增 API）', /updateProfile:/.test(apiSrc));

console.log(`\nC197 preview/hotswap wiring: PASS ${passed} / FAIL ${failed}`);
process.exit(failed ? 1 : 0);
