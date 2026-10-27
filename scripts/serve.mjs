// 本地静态预览服务器（零依赖）
// 用途：不装 wrangler、不连后端，直接看界面。
//   node scripts/serve.mjs         → http://localhost:8899
//   http://localhost:8899/?demo=1  → 管理台（内置演示数据）
//   http://localhost:8899/         → 用户查询页

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT || 8899);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let path = decodeURIComponent(url.pathname);

  // 接口不在本服务器范围内，明确告知
  if (path.startsWith('/api/') || path.startsWith('/webhook/')) {
    res.writeHead(501, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        ok: false,
        code: 'NO_BACKEND',
        message: '这是纯静态预览服务器，没有后端。看界面请用 /?demo=1，真实接口请用 wrangler dev。',
      })
    );
    return;
  }

  if (path === '/') path = '/index.html';

  // 防目录穿越
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }

  try {
    const buf = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  } catch {
    // SPA 回退：找不到文件时返回 index.html
    try {
      const buf = await readFile(join(ROOT, 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      res.end(buf);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`预览地址： http://localhost:${PORT}`);
  console.log(`管理台：   http://localhost:${PORT}/?demo=1`);
});
