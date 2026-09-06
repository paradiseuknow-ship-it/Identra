'use strict';

// 最小身份边界（STEP 0.5 §2.1）。
//
// 此前状态：所有 /api/* 与 /api/ai/* 完全匿名可用，且服务绑定 0.0.0.0。
//   任何人只要能访问端口，就能创建任务、读取凭据、下载快照、执行任意 JS。
//
// 设计原则 —— **「匿名」与「对外暴露」必须互斥，不可同时成立**：
//
//   模式 A（默认，单机/本地模式）
//     FPB_API_TOKEN 未设置 + 绑定 loopback
//     → loopback 来源放行（含 Vite dev proxy 转发），非 loopback 一律 401
//     → 这是本产品的主形态：用户在自己机器上使用，无需配置
//
//   模式 B（token 模式，共享/托管部署）
//     FPB_API_TOKEN 已设置
//     → 所有来源（含 loopback）都必须提供有效 token
//
//   ⛔ 禁止组合：FPB_API_TOKEN 未设置 + 绑定非 loopback（= 匿名生产 API）
//     由 assertStartupSecurity() 在启动时 fail-fast，不静默降级。

const crypto = require('crypto');

const TOKEN = (process.env.FPB_API_TOKEN || '').trim();
const TRUST_PROXY = process.env.FPB_TRUST_PROXY === '1';

// 免鉴权端点：只暴露"服务活着"，不得返回任何业务数据。
const PUBLIC_PATHS = new Set(['/api/ai/health']);

function isLoopback(ip) {
  const s = String(ip || '');
  if (!s) return false;
  if (s === '::1' || s === '::ffff:127.0.0.1' || s === '127.0.0.1') return true;
  if (/^127\./.test(s)) return true; // 127.0.0.0/8
  if (s === 'localhost') return true;
  return false;
}

// 客户端 IP。默认不信任 X-Forwarded-For（可被伪造从而绕过 loopback 判定），
// 仅在显式 FPB_TRUST_PROXY=1（部署在可信反代之后）时才取最左跳。
function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '';
}

function tokenMatches(provided) {
  if (!TOKEN || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

function extractToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  if (req.headers['x-fpb-token']) return String(req.headers['x-fpb-token']).trim();
  // SSE（EventSource）无法自定义请求头，允许通过 query 传递。
  if (req.query && req.query.token) return String(req.query.token).trim();
  return '';
}

function isPublicPath(req) {
  const p = (req.path || req.originalUrl || '').split('?')[0];
  if (PUBLIC_PATHS.has(p)) return true;
  // 挂载点下的相对路径（agent 路由通过 app.use('/api/ai', router) 挂载，req.path 为 '/health'）
  if (p === '/health' && (req.baseUrl || '') === '/api/ai') return true;
  return false;
}

function requireAuth(req, res, next) {
  if (isPublicPath(req)) return next();

  // CAP-O1：identityResolver（先于本中间件执行）已解析出用户身份
  // （session token / 模式A loopback local / 模式B 机器 token 映射）→ 视为已认证。
  if (req.identityUser) return next();

  if (TOKEN) {
    // 模式 B：任何来源都必须持有有效 token
    if (tokenMatches(extractToken(req))) return next();
    return res.status(401).json({
      ok: false,
      error: 'UNAUTHORIZED',
      message: '缺少或无效的 API token（Authorization: Bearer <token> / x-fpb-token / ?token=）',
    });
  }

  // 模式 A：仅本机放行
  const ip = clientIp(req);
  if (isLoopback(ip)) return next();

  return res.status(403).json({
    ok: false,
    error: 'FORBIDDEN',
    message: '服务处于本地模式，仅接受 loopback 请求。共享部署请设置 FPB_API_TOKEN 并显式配置 FPB_BIND。',
    clientIp: ip,
  });
}

// 启动期安全自检：把「匿名 + 对外暴露」的非法组合挡在启动之前。
// 返回问题列表（空数组 = 通过）。由调用方决定是否退出进程。
function assertStartupSecurity(opts) {
  const bind = String((opts && opts.bind) || '127.0.0.1');
  const problems = [];
  // 0.0.0.0 / :: 监听所有网卡，视为对外暴露；其余非 loopback 地址同样视为暴露。
  const isExposedBind = bind === '0.0.0.0' || bind === '::' || !isLoopback(bind);

  if (isExposedBind && !TOKEN) {
    problems.push(
      `服务绑定到非 loopback 地址 (${bind}) 但未设置 FPB_API_TOKEN —— 这将产生匿名可访问的生产 API。` +
        `请设置 FPB_API_TOKEN，或把 FPB_BIND 改回 127.0.0.1。`
    );
  }
  if (isExposedBind && (opts && opts.corsWildcard)) {
    problems.push(`绑定到 ${bind} 时不得使用 CORS 通配符 "*"。`);
  }
  return problems;
}

module.exports = {
  requireAuth,
  isLoopback,
  clientIp,
  assertStartupSecurity,
  PUBLIC_PATHS,
  // CAP-O1 身份层消费：机器 token 匹配与提取
  tokenMatches,
  extractToken,
  // 供测试与前端引导使用
  mode: TOKEN ? 'token' : 'local',
  hasToken: !!TOKEN,
};
