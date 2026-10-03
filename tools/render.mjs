/**
 * render.mjs —— 用本机已安装的 Chrome 把网页渲染成 PNG
 *
 * 【为什么这么做】
 *   出「练度面板图」需要一个能把 HTML 排版成图片的渲染器。常见做法是装 puppeteer，
 *   但它要额外下载一份 Chromium（上百 MB，本机网络还要走加速器）。
 *   本机已经装了 Chrome，且 Node 22+ **内置了 WebSocket**，
 *   所以可以直接用 CDP（Chrome DevTools Protocol）驱动它 —— **零 npm 依赖**。
 *
 * 【能力】
 *   - 整页高度自适应（不靠猜高度：先量 documentElement.scrollHeight 再截图）
 *   - 2 倍（或任意）像素密度，出图清晰
 *   - 等网页里的图片全部加载完再截（立绘是网络图，不等待就会截到空白）
 *
 * 用法：
 *   node tools/render.mjs --url <URL|文件路径> --out <输出.png> [--width 900] [--scale 2]
 *   node tools/render.mjs --html <HTML 文件> --out <输出.png>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/* ---------------- Chrome 定位 ---------------- */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

export function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

/* ---------------- 小工具 ---------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('CDP HTTP 超时')));
  });
}

/* ---------------- CDP 客户端（基于 Node 内置 WebSocket） ---------------- */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message + ' (' + msg.method + ')'));
        else resolve(msg.result);
      } else if (msg.method) {
        const hs = this.handlers.get(msg.method) || [];
        hs.forEach(h => h(msg.params, msg.sessionId));
      }
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 调用超时: ' + method)); }
      }, 60000);
    });
  }
  static async connect(wsUrl) {
    if (typeof WebSocket === 'undefined') {
      throw new Error('当前 Node 没有内置 WebSocket（需要 Node 22+）');
    }
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('无法连接 Chrome 的调试端口')), { once: true });
    });
    return new CDP(ws);
  }
}

/* ---------------- 主渲染函数 ---------------- */
/**
 * @param {object} o
 * @param {string} o.url       要渲染的 URL（也可传 file:// 或 http://127.0.0.1）
 * @param {string} o.outPath   输出 PNG 路径
 * @param {number} [o.width]   视口宽度（CSS 像素），默认 900
 * @param {number} [o.scale]   像素密度，默认 2（即 2 倍图）
 * @param {number} [o.timeout] 总超时毫秒，默认 45000
 * @param {string} [o.chromePath]
 * @returns {Promise<{outPath:string,width:number,height:number,scale:number}>}
 */
export async function renderToPng(o) {
  const chromePath = o.chromePath || findChrome();
  if (!chromePath) throw new Error('找不到 Chrome/Edge。可用环境变量 CHROME_PATH 指定。');
  const width = o.width || 900;
  const scale = o.scale || 2;
  const timeout = o.timeout || 45000;

  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-render-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--force-device-scale-factor=' + scale,
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    'about:blank'
  ];
  const child = spawn(chromePath, args, { stdio: 'ignore', windowsHide: true });

  let cdp = null;
  try {
    // 等调试端口起来
    const deadline = Date.now() + 20000;
    let ver = null;
    while (Date.now() < deadline) {
      try { ver = await httpGetJson('http://127.0.0.1:' + port + '/json/version'); break; }
      catch { await sleep(200); }
    }
    if (!ver) throw new Error('Chrome 调试端口未就绪（可能被杀软/策略拦截）');

    cdp = await CDP.connect(ver.webSocketDebuggerUrl);

    // 新建标签页并用 flatten 会话直接对它发命令
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

    // 初始视口刻意设小：scrollHeight 在「内容 < 视口」时会返回视口高度，
    // 先给小值才能量到真实内容高度（否则会截出一大片空白）。
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width, height: 300, deviceScaleFactor: scale, mobile: false }, sessionId);

    const loaded = new Promise(resolve => {
      cdp.on('Page.loadEventFired', (p, sid) => { if (sid === sessionId) resolve(); });
    });
    await cdp.send('Page.navigate', { url: o.url }, sessionId);
    await Promise.race([loaded, sleep(timeout)]);

    // 等字体与图片就绪（立绘是网络图，不等就会截到空白）
    const waitExpr = `(async () => {
      try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}
      const imgs = Array.from(document.images || []);
      await Promise.all(imgs.map(im => im.complete ? null : new Promise(r => {
        im.addEventListener('load', r, { once: true });
        im.addEventListener('error', r, { once: true });
        setTimeout(r, 8000);
      })));
      return imgs.length;
    })()`;
    let imgCount = 0;
    try {
      const r = await cdp.send('Runtime.evaluate',
        { expression: waitExpr, awaitPromise: true, returnByValue: true }, sessionId);
      imgCount = r && r.result ? r.result.value : 0;
    } catch { /* 等待失败不致命，继续截图 */ }

    // 量真实高度（整页自适应）：取 body 与 documentElement 的较大者，并复量一次防重排
    const measureExpr = `Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
      document.body ? Math.ceil(document.body.getBoundingClientRect().height) : 0
    )`;
    const measure = async () => {
      const r = await cdp.send('Runtime.evaluate', { expression: measureExpr, returnByValue: true }, sessionId);
      return Math.max(120, Math.ceil(r.result.value || 300));
    };
    let height = await measure();
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: scale, mobile: false }, sessionId);
    await sleep(200);
    const height2 = await measure();
    if (height2 !== height) {
      height = height2;
      await cdp.send('Emulation.setDeviceMetricsOverride',
        { width, height, deviceScaleFactor: scale, mobile: false }, sessionId);
      await sleep(200);
    }

    const shot = await cdp.send('Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: true, fromSurface: true }, sessionId);

    fs.mkdirSync(path.dirname(path.resolve(o.outPath)), { recursive: true });
    fs.writeFileSync(o.outPath, Buffer.from(shot.data, 'base64'));
    return { outPath: o.outPath, width, height, scale, images: imgCount };
  } finally {
    try { if (cdp) cdp.ws.close(); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
    await sleep(150);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ---------------- CLI ---------------- */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
  let url = get('url', null);
  const htmlFile = get('html', null);
  const out = get('out', 'panel.png');
  const width = Number(get('width', 900));
  const scale = Number(get('scale', 2));

  const chrome = findChrome();
  if (!chrome) { console.error('找不到 Chrome/Edge，可用 CHROME_PATH 指定'); process.exit(1); }
  console.log('Chrome: ' + chrome);

  if (htmlFile) url = pathToFileURL(path.resolve(htmlFile)).href;
  if (!url) { console.error('需要 --url 或 --html'); process.exit(2); }
  if (!/^[a-z]+:/i.test(url)) url = pathToFileURL(path.resolve(url)).href;

  const t0 = Date.now();
  try {
    const r = await renderToPng({ url, outPath: out, width, scale, chromePath: chrome });
    const kb = (fs.statSync(r.outPath).size / 1024).toFixed(1);
    console.log('已生成 ' + r.outPath);
    console.log('  视口 ' + r.width + '×' + r.height + ' CSS px，' + r.scale + ' 倍 → 实际 ' + (r.width * r.scale) + '×' + (r.height * r.scale) + ' px');
    console.log('  文件 ' + kb + ' KB，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's，网页图片 ' + r.images + ' 张');
  } catch (e) {
    console.error('渲染失败：' + e.message);
    process.exit(1);
  }
}
