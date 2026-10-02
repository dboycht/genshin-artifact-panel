#!/usr/bin/env node
/**
 * server.mjs —— 本地服务（零依赖，仅用 Node 内置模块）
 *
 * 职责：
 *   ① 托管 public/ 下的全部静态文件（前端 + 静态数值表）
 *   ② GET /api/enka?uid=xxxx  —— 代理 Enka.Network
 *      为什么必须代理：Enka 的响应不带 Access-Control-Allow-Origin，浏览器直连会被 CORS 拦下
 *      （实测：GET 无该头，OPTIONS 返回 405）
 *   ③ 按 Enka 的 ttl 做本地缓存，避免短时间内重复请求同一个 UID
 *
 * 安全边界：
 *   - 只绑定回环地址 127.0.0.1，不对外监听
 *   - 代理只允许访问 enka.network 这一个上游，uid 必须是纯数字，且**不做任何批量/枚举**
 *     （Enka 明确禁止枚举 UID 刷库）
 *   - 服务端不保存任何玩家数据；用户数据一律存在浏览器本地
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 0);      // 0 = 自动选空闲端口
const PREFERRED_PORT = Number(process.env.PREFERRED_PORT || 8788);
const HOST = '127.0.0.1';
const UA = 'genshin-artifact-panel/1.0 (local tool; +https://github.com/dboycht/genshin-artifact-panel)';
const UPSTREAM = 'https://enka.network/api/uid/';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8'
};

/* ---------- Enka 缓存：uid -> { body, expires } ---------- */
const cache = new Map();
const inflight = new Map();

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

async function fetchEnka(uid) {
  const now = Date.now();
  const hit = cache.get(uid);
  if (hit && hit.expires > now) return { ...hit, cached: true };
  if (inflight.has(uid)) return inflight.get(uid);

  const task = (async () => {
    let upstream;
    try {
      upstream = await fetch(UPSTREAM + uid, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    } catch (e) {
      return { code: 502, body: { error: '连不上 Enka.Network', detail: String(e && e.message || e) + '。若本机走了代理/加速器，请确认它能访问 enka.network。' } };
    }
    const text = await upstream.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* 保留原始文本 */ }

    if (upstream.ok && data) {
      const ttl = Math.max(30, Math.min(600, Number(data.ttl) || 60));
      cache.set(uid, { body: data, expires: Date.now() + ttl * 1000 });
      return { code: 200, body: data, ttl };
    }
    // 错误码按 Enka 文档语义转成人话
    const map = {
      400: 'UID 格式不正确',
      404: '查不到这个 UID（确认是国服/国际服的 9 位 UID，且账号存在）',
      424: 'Enka 后台正在维护，或游戏刚版本更新、数据尚未适配。稍后再试',
      429: '请求过于频繁，被 Enka 限流了。请等一会儿再试（不要连续刷新）',
      500: 'Enka 服务端内部错误',
      503: 'Enka 服务暂时不可用'
    };
    return {
      code: upstream.status,
      body: { error: map[upstream.status] || ('Enka 返回 HTTP ' + upstream.status), detail: text.slice(0, 400) }
    };
  })().finally(() => inflight.delete(uid));

  inflight.set(uid, task);
  return task;
}

/* ---------- 静态文件 ---------- */
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  // 防目录穿越
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 ' + rel);
      return;
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.json' ? 'no-cache' : 'no-cache'
    });
    fs.createReadStream(full).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + HOST);
  if (u.pathname === '/api/enka') {
    const uid = String(u.searchParams.get('uid') || '').trim();
    if (!/^\d{6,12}$/.test(uid)) { json(res, 400, { error: 'uid 参数必须是 6~12 位数字' }); return; }
    const r = await fetchEnka(uid);
    if (r.code === 200) json(res, 200, r.body);
    else json(res, r.code, r.body);
    return;
  }
  if (u.pathname === '/api/health') { json(res, 200, { ok: true, version: '1.0.1' }); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  serveStatic(req, res, u.pathname);
});

function openBrowser(url) {
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : (process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`);
  import('node:child_process').then(cp => {
    try { cp.exec(cmd, () => { }); } catch { /* 打不开就算了，控制台已打印地址 */ }
  });
}

function listen(port, isFallback) {
  server.once('error', err => {
    if (err.code === 'EADDRINUSE' && !isFallback) {
      console.log('端口 ' + port + ' 被占用，改用随机空闲端口…');
      listen(0, true);
    } else {
      console.error('启动失败：' + err.message);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    const actual = server.address().port;
    const url = 'http://' + HOST + ':' + actual + '/';
    console.log('');
    console.log('  原神圣遗物评分与练度面板 —— 已在本地启动');
    console.log('  界面地址：' + url);
    console.log('  数据来源：Enka.Network（UID 查询）/ GOOD / 莫娜占卜铺 / 手动录入');
    console.log('  按 Ctrl+C 退出（退出后界面即不可用，但已保存的数据仍在浏览器本地）');
    console.log('');
    if (!process.env.NO_OPEN) openBrowser(url);
  });
}

console.log('静态目录：' + PUBLIC_DIR);
if (!fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
  console.error('找不到 public/index.html，无法启动。');
  process.exit(1);
}
listen(PORT || PREFERRED_PORT, false);
