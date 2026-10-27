// 本地联调服务器（不依赖 wrangler / workerd）
//
// 用途：
//   1. 在 Windows 上 workerd 起不来时的替代方案
//   2. 顺便验证「迁移到自建机」的可行路径（见 docs/MIGRATION.md）
//
// 用法：
//   node scripts/dev-local.mjs
//   → http://localhost:8787
//
// 与线上的一致性：
//   - 直接复用 src/index.js 的 fetch 入口，业务代码零改动
//   - 数据库用真实 SQLite（node:sqlite），跑的是同一份 schema.sql
//   - 唯一差异：ASSETS 用本地文件读取代替 Workers Static Assets

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const DB_PATH = join(ROOT, 'data', 'dev.db');
const PORT = Number(process.env.PORT || 8787);

// ---------- 读 .dev.vars ----------
// 注意：Windows 下文件常是 CRLF，用正则匹配行尾容易失败，这里按首个 = 切分并去空白
function loadVars() {
  const p = join(ROOT, '.dev.vars');
  const out = {};
  if (!existsSync(p)) return out;
  for (const raw of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1);
    out[k] = v.replace(/\\n/g, '\n');
  }
  return out;
}

// ---------- D1 兼容层 ----------
function openD1(path) {
  const db = new DatabaseSync(path);
  const prepare = (sql) => {
    const stmt = db.prepare(sql);
    const wrap = (args) => ({
      run: async () => {
        const r = stmt.run(...args);
        return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
      },
      first: async () => stmt.get(...args) ?? null,
      all: async () => ({ results: stmt.all(...args) }),
    });
    return {
      bind: (...a) => wrap(a),
      run: () => wrap([]).run(),
      first: () => wrap([]).first(),
      all: () => wrap([]).all(),
    };
  };
  return {
    prepare,
    batch: async (list) => {
      const out = [];
      db.exec('BEGIN');
      try {
        for (const s of list) out.push(await s.run());
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return out;
    },
    _raw: db,
  };
}

// ---------- 静态资源（替代 env.ASSETS） ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const ASSETS = {
  async fetch(request) {
    const url = new URL(request.url);
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = normalize(join(PUBLIC, p));
    if (!file.startsWith(PUBLIC)) return new Response('forbidden', { status: 403 });
    try {
      const buf = await readFile(file);
      return new Response(buf, { headers: { 'content-type': MIME[extname(file)] || 'application/octet-stream' } });
    } catch {
      // SPA 回退
      const html = await readFile(join(PUBLIC, 'index.html'));
      return new Response(html, { headers: { 'content-type': MIME['.html'] } });
    }
  },
};

// ---------- 启动 ----------
mkdirSync(join(ROOT, 'data'), { recursive: true });

const db = openD1(DB_PATH);
db._raw.exec(readFileSync(join(ROOT, 'schema.sql'), 'utf8')); // 幂等：全是 IF NOT EXISTS

const env = { ...loadVars(), DB: db, ASSETS };
const app = (await import('../src/index.js')).default;

function makeCtx() {
  const pending = [];
  return {
    waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})),
    passThroughOnException: () => {},
    drain: () => Promise.all(pending),
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const isGet = ['GET', 'HEAD'].includes(req.method);

    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      // Cloudflare 会注入 cf-connecting-ip，本地没有，补一个，
      // 否则限流拿不到 IP，所有人共用同一个桶（本地调试会被互相影响）
      headers: { 'cf-connecting-ip': req.socket.remoteAddress || '127.0.0.1', ...req.headers },
      body: isGet ? undefined : body,
    });

    const ctx = makeCtx();
    const response = await app.fetch(request, env, ctx);
    await ctx.drain();

    // 用 getSetCookie 保留多值 cookie；其余头原样透传
    const headers = {};
    response.headers.forEach((v, k) => {
      if (k !== 'set-cookie') headers[k] = v;
    });
    const sc = response.headers.getSetCookie?.() || [];
    if (sc.length) headers['set-cookie'] = sc;

    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error('request failed:', e);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, code: 'DEV_SERVER_ERROR', message: String(e.message || e) }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n本地联调服务已启动`);
  console.log(`  管理台  http://localhost:${PORT}/admin`);
  console.log(`  用户页  http://localhost:${PORT}/`);
  console.log(`  数据库  ${DB_PATH}`);
  console.log(`  口令    ${env.ADMIN_PASSWORD || '(未设置)'}\n`);
});
