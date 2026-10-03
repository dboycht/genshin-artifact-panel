#!/usr/bin/env node
/**
 * server.mjs —— 本地服务（零依赖，仅用 Node 内置模块）
 *
 * 职责：
 *   ① 托管 public/ 下的全部静态文件（前端 + 静态数值表）
 *   ② GET  /api/enka?uid=xxxx       代理 Enka.Network 的 UID 接口
 *      为什么必须代理：Enka 的响应不带 Access-Control-Allow-Origin，浏览器直连会被 CORS 拦下
 *      （实测：GET 无该头，OPTIONS 返回 405）
 *   ③ GET  /api/gameimg/<文件名>     代理 Enka 的 UI 图床并落盘缓存（立绘 0.6~1.8 MB，必须缓存）
 *   ④ POST /api/render              把「面板图数据模型」渲染成 PNG（本机 Chrome + CDP）
 *   ⑤ GET  /api/card-model?id=xxx   给上面那个渲染页取数据用（一次性、60 秒过期）
 *
 * 安全边界：
 *   - 只绑定回环地址 127.0.0.1，不对外监听
 *   - 上游白名单只有 enka.network；uid 必须是纯数字；**不做任何批量/枚举**
 *     （Enka 明确禁止枚举 UID 刷库）
 *   - 图床代理的文件名走严格白名单，避免被当成任意 URL 代理
 *   - 服务端不保存任何玩家数据；用户数据一律存在浏览器本地
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToPng, findChrome } from '../tools/render.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');                 // 运行时缓存，已在 .gitignore
const IMG_CACHE_DIR = path.join(DATA_DIR, 'cache', 'img');
const PORT = Number(process.env.PORT || 0);               // 0 = 自动选空闲端口
const PREFERRED_PORT = Number(process.env.PREFERRED_PORT || 8788);
const HOST = '127.0.0.1';
const UA = 'genshin-artifact-panel/1.1 (local tool; +https://github.com/dboycht/genshin-artifact-panel)';
const UPSTREAM_UID = 'https://enka.network/api/uid/';
const UPSTREAM_IMG = 'https://enka.network/ui/';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8'
};

const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; }
  catch { return '0.0.0'; }   // 版本号单一来源 = package.json
})();

/* ---------- 内存缓存 ---------- */
const uidCache = new Map();       // uid -> { body, expires }
const uidInflight = new Map();
const cardModels = new Map();     // id -> { model, expires }  渲染页取数用

/* ---------- 小工具 ---------- */
function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length, 'Cache-Control': 'no-store'
  });
  res.end(body);
}
function text(res, code, s) {
  const body = Buffer.from(String(s), 'utf8');
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}
function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ---------- ① Enka UID 代理 ---------- */
async function fetchEnka(uid) {
  const hit = uidCache.get(uid);
  if (hit && hit.expires > Date.now()) return { ...hit, cached: true };
  if (uidInflight.has(uid)) return uidInflight.get(uid);

  const task = (async () => {
    let upstream;
    try {
      upstream = await fetch(UPSTREAM_UID + uid, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    } catch (e) {
      return { code: 502, body: { error: '连不上 Enka.Network', detail: String(e && e.message || e) + '。若本机走了代理/加速器，请确认它能访问 enka.network。' } };
    }
    const t = await upstream.text();
    let data = null;
    try { data = JSON.parse(t); } catch { /* 保留原始文本 */ }

    if (upstream.ok && data) {
      const ttl = Math.max(30, Math.min(600, Number(data.ttl) || 60));
      uidCache.set(uid, { body: data, expires: Date.now() + ttl * 1000 });
      return { code: 200, body: data, ttl };
    }
    const map = {
      400: 'UID 格式不正确',
      404: '查不到这个 UID（确认是国服/国际服的 9 位 UID，且账号存在）',
      424: 'Enka 后台正在维护，或游戏刚版本更新、数据尚未适配。稍后再试',
      429: '请求过于频繁，被 Enka 限流了。请等一会儿再试（不要连续刷新）',
      500: 'Enka 服务端内部错误',
      503: 'Enka 服务暂时不可用'
    };
    return { code: upstream.status, body: { error: map[upstream.status] || ('Enka 返回 HTTP ' + upstream.status), detail: t.slice(0, 400) } };
  })().finally(() => uidInflight.delete(uid));

  uidInflight.set(uid, task);
  return task;
}

/* ---------- ② 图床代理 + 落盘缓存 ---------- */
const IMG_NAME_RE = /^[A-Za-z0-9_]+\.(png|jpg|jpeg|webp)$/;

async function serveGameImage(res, name) {
  if (!IMG_NAME_RE.test(name)) { text(res, 400, '图片名不合法'); return; }
  const file = path.join(IMG_CACHE_DIR, name);

  // 命中磁盘缓存
  try {
    const st = fs.statSync(file);
    if (st.isFile() && st.size > 0) {
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(name).toLowerCase()] || 'image/png',
        'Content-Length': st.size,
        'Cache-Control': 'public, max-age=604800'
      });
      fs.createReadStream(file).pipe(res);
      return;
    }
  } catch { /* 未缓存 */ }

  let upstream;
  try {
    upstream = await fetch(UPSTREAM_IMG + name, { headers: { 'User-Agent': UA, Accept: 'image/*' } });
  } catch (e) {
    text(res, 502, '连不上图床：' + (e && e.message || e));
    return;
  }
  if (!upstream.ok) {
    text(res, upstream.status === 404 ? 404 : 502, '图床上没有这张图（HTTP ' + upstream.status + '）：' + name);
    return;
  }
  const buf = Buffer.from(await upstream.arrayBuffer());
  try {
    fs.mkdirSync(IMG_CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, buf);
  } catch { /* 缓存失败不影响本次返回 */ }

  res.writeHead(200, {
    'Content-Type': upstream.headers.get('content-type') || 'image/png',
    'Content-Length': buf.length,
    'Cache-Control': 'public, max-age=604800'
  });
  res.end(buf);
}

/* ---------- ③ 出图 ---------- */
async function handleRender(req, res) {
  let raw;
  try { raw = await readBody(req, 4 * 1024 * 1024); }
  catch (e) { json(res, 413, { error: e.message }); return; }

  let payload;
  try { payload = JSON.parse(raw); }
  catch { json(res, 400, { error: '请求体不是合法 JSON' }); return; }
  if (!payload || typeof payload !== 'object' || !payload.model) { json(res, 400, { error: '缺少 model 字段' }); return; }

  const id = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  cardModels.set(id, { model: payload.model, expires: Date.now() + 60000 });
  // 清理过期项
  const now = Date.now();
  for (const [k, v] of cardModels) if (v.expires < now) cardModels.delete(k);

  const base = 'http://' + HOST + ':' + server.address().port;
  const url = base + '/card.html?id=' + encodeURIComponent(id);
  const outPath = path.join(DATA_DIR, 'cache', 'render', id + '.png');

  try {
    const r = await renderToPng({
      url,
      outPath,
      width: Number(payload.width) || 900,
      scale: Number(payload.scale) || 2,
      timeout: 60000
    });
    const buf = fs.readFileSync(r.outPath);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': buf.length,
      'X-Card-Size': r.width + 'x' + r.height,
      'Cache-Control': 'no-store'
    });
    res.end(buf);
    // 用完即删，避免 data/ 里越堆越多
    try { fs.rmSync(outPath, { force: true }); } catch { /* ignore */ }
  } catch (e) {
    json(res, 500, { error: '渲染失败：' + e.message });
  } finally {
    cardModels.delete(id);
  }
}

/* ---------- 静态文件 ---------- */
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) { text(res, 403, 'Forbidden'); return; }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { text(res, 404, '404 ' + rel); return; }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(full).pipe(res);
  });
}

/* ---------- 路由 ---------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + HOST);

  if (u.pathname === '/api/health') {
    json(res, 200, { ok: true, version: VERSION, chrome: !!findChrome() });
    return;
  }

  if (u.pathname === '/api/enka') {
    const uid = String(u.searchParams.get('uid') || '').trim();
    if (!/^\d{6,12}$/.test(uid)) { json(res, 400, { error: 'uid 参数必须是 6~12 位数字' }); return; }
    const r = await fetchEnka(uid);
    json(res, r.code === 200 ? 200 : r.code, r.body);
    return;
  }

  if (u.pathname.startsWith('/api/gameimg/')) {
    await serveGameImage(res, decodeURIComponent(u.pathname.slice('/api/gameimg/'.length)));
    return;
  }

  if (u.pathname === '/api/card-model') {
    const id = String(u.searchParams.get('id') || '');
    const hit = cardModels.get(id);
    if (!hit || hit.expires < Date.now()) { json(res, 404, { error: '数据已过期，请重新出图' }); return; }
    json(res, 200, hit.model);
    return;
  }

  if (u.pathname === '/api/render' && req.method === 'POST') {
    await handleRender(req, res);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  serveStatic(req, res, u.pathname);
});

/* ---------- 启动 ---------- */
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
    console.log('  原神圣遗物评分与练度面板 v' + VERSION + ' —— 已在本地启动');
    console.log('  界面地址：' + url);
    console.log('  数据来源：Enka.Network（UID 查询）/ GOOD / 莫娜占卜铺 / 手动录入');
    const chrome = findChrome();
    console.log('  出图引擎：' + (chrome ? '本机 Chrome ✓' : '⚠️ 未找到 Chrome/Edge，面板图导出将不可用'));
    console.log('  缓存目录：' + DATA_DIR + '（立绘等图片缓存，可随时删除）');
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
