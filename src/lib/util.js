// 通用工具

export const now = () => Math.floor(Date.now() / 1000);
export const uid = (p = '') => p + crypto.randomUUID().replace(/-/g, '');

// 统一按北京时间（UTC+8）取日期。
// 若用 UTC，每日额度会在北京时间早上 8 点重置，用户会觉得莫名其妙。
// 60 秒内复用结果：这个函数在热路径（每个请求都会调），避免反复构造 Date。
let _dayCache = '';
let _dayCacheAt = 0;

export const todayStr = (t) => {
  const sec = t || now();
  if (!t && _dayCache && sec - _dayCacheAt < 60) return _dayCache;
  const d = new Date(sec * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
  if (!t) {
    _dayCache = d;
    _dayCacheAt = sec;
  }
  return d;
};

/**
 * UTC 日期的 YYYY-MM-DD。
 *
 * 专门给「额度熔断计数」用：Cloudflare 免费额度按 **UTC 0 点（北京 08:00）** 重置，
 * 而 todayStr 是按北京日期切的。用 todayStr 会导致北京 0:00–8:00 之间计数器已归零、
 * 云端额度却还没恢复 —— 熔断恰好在最需要它的时段失灵（白天反而偏保守）。
 *
 * 注意不要拿它替换「每日验证次数」的日界：那个应该跟用户感知的「今天」一致（北京日期）。
 */
export const utcDayStr = (t) => {
  const sec = t || now();
  return new Date(sec * 1000).toISOString().slice(0, 10);
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

export function fail(message, status = 400, code = 'BAD_REQUEST') {
  return json({ ok: false, code, message }, status);
}

export async function readJson(req) {
  try {
    const t = await req.text();
    return t ? JSON.parse(t) : {};
  } catch {
    return null;
  }
}

function b64urlEncode(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = (4 - (str.length % 4)) % 4;
  const s = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlEncodeString(str) {
  return b64urlEncode(new TextEncoder().encode(str));
}

export function b64urlDecodeString(str) {
  return new TextDecoder().decode(b64urlDecode(str));
}

// PEM -> ArrayBuffer(DER)
export function pemToDer(pem) {
  const body = String(pem)
    .replace(/\\n/g, '\n')
    .replace(/-----[^-]+-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// 标准 base64 或 base64url 都能解
export function flexibleB64ToBytes(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (s.length % 4)) % 4;
  const bin = atob(s + '='.repeat(pad));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 简易内存限流（per-isolate，够挡滥用；不写库，不碰 KV）
const rlMap = new Map();
export function rateLimit(key, limit, windowSec) {
  const t = now();
  const rec = rlMap.get(key);
  if (!rec || t - rec.start >= windowSec) {
    rlMap.set(key, { start: t, count: 1 });
    if (rlMap.size > 5000) rlMap.clear();
    return true;
  }
  rec.count++;
  return rec.count <= limit;
}

export function clientIp(req) {
  return req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || '';
}

/**
 * 基于 D1 的固定窗口限流 —— 跨 isolate 有效。
 *
 * 为什么不能用上面那个内存版：Workers 会为同一站点起多个 isolate 且频繁回收，
 * 内存 Map 天然不共享（实测同一 IP 连打 7 次登录全部绕过 5 次上限）。
 * 用它来防爆破、防刷额度等于没有防护。
 *
 * 超过上限后**只读不写**：否则攻击者反而能通过持续请求把 D1 写额度（10 万/天）烧穿，
 * 导致真实订单的 INSERT 失败 —— 那正是我们想防的事。
 */
export async function rateLimitDb(env, key, limit, windowSec) {
  const t = now();
  const bucket = Math.floor(t / windowSec);
  const id = key + ':' + bucket;

  try {
    const row = await env.DB.prepare('SELECT count FROM rate_limits WHERE id = ?').bind(id).first();
    if (Number(row?.count || 0) >= limit) return false; // 已超限：只读不写
    await env.DB.prepare(
      `INSERT INTO rate_limits (id, count, created_at) VALUES (?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET count = count + 1`
    )
      .bind(id, t)
      .run();
    return true;
  } catch {
    // 表缺失或 DB 抖动时不阻断业务：宁可限流暂时失效，也不要让登录/webhook 全挂
    return true;
  }
}

// 审计日志唯一写入口。改字段只需改这里一处。
export function audit(env, actor, action, target = '', detail = '', ip = '') {
  return env.DB.prepare(
    'INSERT INTO audit_logs (actor, action, target, detail, ip, created_at) VALUES (?,?,?,?,?,?)'
  )
    .bind(actor || '-', action, target || '', detail || '', ip || '', now())
    .run();
}

export async function getMeta(env, k, def = null) {
  const row = await env.DB.prepare('SELECT v FROM meta WHERE k = ?').bind(k).first();
  return row ? row.v : def;
}

export async function setMeta(env, k, v) {
  await env.DB.prepare(
    'INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'
  ).bind(k, String(v)).run();
}
