'use strict';

/**
 * 手动预检脚本：读取 data/profiles.json，对指定 profile 的 rola 出口
 * 检查 IP 类型(isp/hosting) 与 Google 可达性，命中脏 IP 给出换国家建议。
 *
 * 用法：
 *   node scripts/precheck.js <profileId>
 *   SOCKS5_HOP=127.0.0.1:10808 node scripts/precheck.js p_msz1kiv51u8g
 */

const fs = require('fs');
const path = require('path');
const { precheckProxy } = require('../server/proxyPrecheck');

const profileId = process.argv[2];
if (!profileId) {
  console.error('用法: node scripts/precheck.js <profileId>');
  process.exit(1);
}

const profilesPath = path.join(__dirname, '..', 'data', 'profiles.json');
let raw = '[]';
try { raw = fs.readFileSync(profilesPath, 'utf8'); } catch (e) {
  console.error('读取 profiles.json 失败:', e.message);
  process.exit(1);
}
const parsed = JSON.parse(raw);
const list = Array.isArray(parsed) ? parsed : (parsed.profiles || []);
const p = list.find((x) => x.id === profileId);
if (!p || !p.proxyInline || !p.proxyInline.server) {
  console.error('找不到 profile 或缺少代理配置:', profileId);
  process.exit(1);
}

const proxy = p.proxyInline;
const srv = String(proxy.server).replace(/^socks5:\/\//i, '');
const [host, port] = srv.split(':');
const upstream = { host, port: Number(port), username: proxy.username || '', password: proxy.password || '' };

const hopEnv = process.env.SOCKS5_HOP || '127.0.0.1:10808';
const [hh, hp] = hopEnv.split(':');
const hop = { host: hh, port: Number(hp) };

(async () => {
  console.log(`预检 profile ${profileId}`);
  console.log(`  上游 rola : ${host}:${port}  user=${upstream.username}`);
  console.log(`  中间跳 v2ray: ${hop.host}:${hop.port}`);
  console.log('  探测中...\n');
  const r = await precheckProxy(upstream, hop);
  console.log(JSON.stringify(r, null, 2));
  console.log('');
  if (r.type === 'hosting') console.log('⚠ 出口为机房/数据中心 IP，易被 Google 拉黑，建议更换 country-xx 或换干净住宅 IP。');
  if (r.google && !r.google.reachable) console.log('⚠ 无法到达 Google，错误: ' + (r.google.error || '?'));
  else if (r.google && r.google.blocked) console.log('⚠ 到达 Google 但被风控（验证码/异常流量）。');
  else if (r.ok) console.log('✅ 预检通过：住宅出口 + Google 可达。');
})().catch((e) => {
  console.error('预检失败:', e.message);
  process.exit(1);
});
