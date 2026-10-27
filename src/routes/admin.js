// 管理后台 API —— 全部挂在 /admin/api 下，由 Cloudflare Access 或口令会话保护

import { json, fail, readJson, now, uid, clientIp, getMeta, setMeta, todayStr, audit, rateLimitDb } from '../lib/util.js';
import { verifyAccessJwt } from '../lib/access.js';
import { signHS256, verifyHS256, getPublicKeyPem } from '../lib/jwt.js';
import { generateKey, normKey } from '../lib/keygen.js';
import { parseFeatures, effectiveStatus, fmtTime, renderMsg, DEFAULT_MSG_TEMPLATE, reissueLicense } from '../lib/license.js';
import { tryDeliver, issueAndQueue } from './webhook.js';
import { reconcileOrders } from '../lib/reconcile.js';
import { quotaStatus } from '../lib/quota.js';
import { PROFILES, rateConfig, blockedToday, resetLimitCache } from '../lib/ratelimit.js';
import { syncCreatorPlans, listSyncedPlans, sendMsg } from '../lib/afdian.js';

// ---------------- 鉴权 ----------------

/** 常量时间比较，避免按字节逐个猜密钥 */
function safeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/**
 * 管理会话令牌的签名密钥。
 *
 * 为什么不能直接用 ADMIN_PASSWORD：HMAC 的密钥就是口令本身，任何人拿到一枚有效 token
 * （localStorage、截图、日志、XSS）就能在自己机器上**离线**跑字典反推口令 ——
 * 不经过服务器，限流完全管不到，而且单张显卡每秒上亿次。
 *
 * 因此单独用一个 32 字节随机 Secret 签名：token 泄露也爆破不出口令。
 * 未配置时回退到口令，保证升级后不会立刻登不进去。
 */
function sessionKey(env) {
  return env.ADMIN_SESSION_SECRET || env.ADMIN_PASSWORD;
}

async function requireAdmin(request, env) {
  const mode = env.AUTH_MODE || 'both';

  // ⚠️ 无鉴权模式：管理台完全公开。
  // 只应在「域名不公开 / 后面要上 Cloudflare Access」的过渡阶段使用。
  // 只要 AUTH_MODE 还是 none，任何知道地址的人都能读取全部授权码、发新码、改配置。
  // 正式上线时把 AUTH_MODE 改成 access（或 both）即可切回强制鉴权。
  if (mode === 'none') return { actor: 'anonymous', insecure: true };

  if (mode !== 'password') {
    const accessJwt = request.headers.get('cf-access-jwt-assertion');
    if (accessJwt && env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD) {
      try {
        const p = await verifyAccessJwt(accessJwt, env);
        if (p) return { actor: p.email || 'access' };
      } catch {
        /* 落到口令校验 */
      }
    }
  }

  if (mode !== 'access') {
    const auth = request.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token && env.ADMIN_PASSWORD) {
      const p = await verifyHS256(sessionKey(env), token);
      if (p) return { actor: p.sub || 'admin' };
    }
  }

  // 备选鉴权：X-Admin-Key 头。给脚本 / 命令行用（自动化排查、cron 探活）。
  // 该密钥是独立 Secret，不与口令共用；未配置时这条路径直接关闭。
  // 注意：必须受 AUTH_MODE 约束 —— 设成 access 表示「强制走 SSO + MFA」，
  // 此时不能再让 api-key 绕过 Access 的设备姿态检查。
  if (mode !== 'access' && env.ADMIN_API_KEY) {
    const k = request.headers.get('x-admin-key') || '';
    if (k && safeEqual(k, env.ADMIN_API_KEY)) return { actor: 'api-key' };
  }

  return null;
}

const UNAUTH = () => json({ ok: false, code: 'UNAUTHORIZED', message: '未登录或登录已过期' }, 401);

/** 只取授权码尾 4 位用于审计追溯，避免明文落库 */
function maskKeyTail(key) {
  const k = String(key || '').replace(/-/g, '');
  return k ? '••••' + k.slice(-4) : '-';
}

// ---------------- 入口 ----------------

export async function handleAdmin(request, env, ctx, url) {
  const path = url.pathname.replace(/^\/admin\/api\/?/, '');
  const method = request.method.toUpperCase();

  // 登录接口不鉴权
  if (path === 'login' && method === 'POST') return login(request, env);
  if (path === 'authmode' && method === 'GET') {
    return json({
      ok: true,
      mode: env.AUTH_MODE || 'both',
      access: !!(env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD),
    });
  }

  const admin = await requireAdmin(request, env);
  if (!admin) return UNAUTH();

  try {
    if (path === 'me' && method === 'GET')
      return json({ ok: true, actor: admin.actor, mode: env.AUTH_MODE || 'both' });
    if (path === 'stats' && method === 'GET') return stats(env);
    if (path === 'quota' && method === 'GET') return json({ ok: true, ...(await quotaStatus(env)) });
    if (path === 'apps') return apps(request, env, method, ctx, admin);
    if (path.startsWith('apps/')) {
      const rest = path.slice(5);
      if (rest.endsWith('/rotate-key') && method === 'POST') {
        return rotateServerKey(env, rest.slice(0, -11), ctx, admin);
      }
      return appOne(request, env, method, rest, ctx, admin);
    }
    if (path === 'plans') return plans(request, env, method, ctx, admin);
    if (path.startsWith('plans/')) return planOne(request, env, method, path.slice(6), ctx, admin);

    if (path === 'licenses') return licenses(request, env, method, url, ctx, admin);
    if (path === 'licenses/batch' && method === 'POST') return batchCreate(request, env, ctx, admin);
    if (path === 'licenses/export') return exportCsv(env, url);
    if (path.startsWith('licenses/')) {
      const rest = path.slice(9);
      if (rest.endsWith('/devices') && method === 'GET') return listDevices(env, rest.slice(0, -8));
      if (rest.endsWith('/renew') && method === 'POST') return renew(request, env, rest.slice(0, -6), ctx, admin);
      if (rest.endsWith('/reissue') && method === 'POST') return reissue(env, rest.slice(0, -8), ctx, admin);
      return licenseOne(request, env, method, rest, ctx, admin);
    }

    if (path === 'devices/remove' && method === 'POST') return removeDevice(request, env, ctx, admin);
    if (path === 'batches' && method === 'GET') return listBatches(env);
    if (path.startsWith('batches/') && path.endsWith('/revoke') && method === 'POST')
      return revokeBatch(env, path.slice(8, -7), ctx, admin);

    if (path === 'orders' && method === 'GET') return listOrders(env, url);
    if (path === 'orders/sync' && method === 'POST') return syncOrders(env, ctx);
    if (path.startsWith('orders/')) {
      const rest = path.slice(7);
      if (rest.endsWith('/retry') && method === 'POST') return retryOrder(env, rest.slice(0, -6), ctx);
      if (rest.endsWith('/issue') && method === 'POST') return issueOrder(request, env, rest.slice(0, -6), ctx, admin);
    }

    if (path === 'settings') return settings(request, env, method, ctx, admin);
    if (path === 'afdian/test-msg' && method === 'POST')
      return testAfdianMsg(request, env, admin);
    if (path === 'pubkey' && method === 'GET') return pubkey(env);
    if (path === 'logs' && method === 'GET') return logs(env, url);

    // 爱发电方案同步：把创作者后台的方案列表拉下来，避免手工抄 plan_id
    if (path === 'afdian/sync' && method === 'POST') return afdianSync(request, env, ctx, admin);
    if (path === 'afdian/plans' && method === 'GET') return afdianPlanList(env);

    return fail('接口不存在: ' + path, 404, 'NOT_FOUND');
  } catch (e) {
    return json({ ok: false, code: 'SERVER_ERROR', message: String(e.message || e) }, 500);
  }
}

async function login(request, env) {
  const body = await readJson(request);
  if (!body || !body.password) return fail('请输入口令');

  if (!env.ADMIN_PASSWORD) return fail('未配置 ADMIN_PASSWORD，无法使用口令登录', 400, 'NO_PASSWORD');
  if (env.AUTH_MODE === 'access') return fail('当前为 Access 模式，不支持口令登录', 403, 'ACCESS_ONLY');

  const ip = clientIp(request);
  const rlKey = 'login:' + (ip || 'unknown');

  const ok = await timingSafeEqual(String(body.password), env.ADMIN_PASSWORD);
  if (!ok) {
    // 防爆破：只在**失败**时计数并落审计。
    // 放在成功分支之外很关键 —— 若先计数再校验，正常用户反复登录几次也会被锁。
    // 用 D1 计数而不是内存 Map：内存版在多 isolate 下形同虚设（实测连打 7 次全部绕过）。
    const allowed = await rateLimitDb(env, rlKey, 5, 300);
    if (allowed) await audit(env, '-', 'login_failed', '', '', ip);
    if (!allowed) return fail('尝试次数过多，请 5 分钟后再试', 429, 'RATE_LIMIT');
    return fail('口令错误', 401, 'BAD_PASSWORD');
  }

  // 登录成功：清掉该 IP 的失败计数，避免正常用户被自己早前的笔误连累
  try {
    await env.DB.prepare('DELETE FROM rate_limits WHERE id LIKE ?').bind(rlKey + ':%').run();
  } catch {
    /* 清不掉也不影响登录 */
  }

  const token = await signHS256(sessionKey(env), { sub: 'admin', iat: now(), exp: now() + 86400 });
  await audit(env, 'admin', 'login', '', '', ip);

  return json({ ok: true, token, actor: 'admin' });
}

async function timingSafeEqual(a, b) {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] || 0) ^ (eb[i] || 0);
  return diff === 0;
}

// ---------------- 概览 ----------------

async function stats(env) {
  const t = now();
  const q = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();

  const today = todayStr(t);
  const dayStart = Math.floor(new Date(today + 'T00:00:00+08:00').getTime() / 1000);

  // 并行执行：这些查询互不依赖，串行会白白叠加 D1 往返延迟
  const [lic, dev, ord, nw, queue, quota] = await Promise.all([
    q(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN duration_mode='lifetime' THEN 1 ELSE 0 END) AS lifetime,
        SUM(CASE WHEN status='banned' THEN 1 ELSE 0 END) AS banned,
        SUM(CASE WHEN status='active' AND duration_mode<>'lifetime' AND expires_at IS NOT NULL AND expires_at <= ? THEN 1 ELSE 0 END) AS expired,
        SUM(CASE WHEN activated_at IS NULL AND duration_mode='from_activation' THEN 1 ELSE 0 END) AS unactivated
       FROM licenses`,
      t
    ),
    q('SELECT COUNT(*) AS c FROM devices'),
    q(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN delivery='unmatched' THEN 1 ELSE 0 END) AS unmatched,
        SUM(CASE WHEN delivery='failed' THEN 1 ELSE 0 END) AS failed
       FROM orders`
    ),
    q('SELECT COUNT(*) AS c FROM licenses WHERE created_at >= ?', dayStart),
    q("SELECT COUNT(*) AS c FROM msg_queue WHERE state = 'pending' AND attempts < 5"),
    quotaStatus(env),
  ]);

  return json({
    ok: true,
    licenses: lic || {},
    devices: dev?.c || 0,
    orders: ord || {},
    today_new: nw?.c || 0,
    queue_pending: queue?.c || 0,
    quota,
    env: {
      auth_mode: env.AUTH_MODE || 'both',
      access_configured: !!(env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD),
      afdian_configured: !!(env.AFDIAN_USER_ID && env.AFDIAN_TOKEN),
    },
  });
}

// ---------------- 软件 ----------------

async function apps(request, env, method, ctx, admin) {
  if (method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT a.*, (SELECT COUNT(*) FROM licenses l WHERE l.app_id = a.id) AS lic_count
       FROM apps a ORDER BY a.created_at DESC`
    ).all();
    return json({ ok: true, list: rows.results || [] });
  }
  if (method === 'POST') {
    const b = await readJson(request);
    if (!b?.name || !b?.slug || !b?.prefix) return fail('名称、标识、前缀必填');
    const slug = String(b.slug).toLowerCase().replace(/[^a-z0-9-_]/g, '');
    if (!slug) return fail('标识只能包含小写字母、数字、- 和 _');
    const prefix = String(b.prefix).toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (!prefix) return fail('前缀只能包含字母数字');

    const dup = await env.DB.prepare('SELECT id FROM apps WHERE slug = ?').bind(slug).first();
    if (dup) return fail('该标识已存在');

    const id = uid('app_');
    await env.DB.prepare(
      'INSERT INTO apps (id, name, slug, prefix, server_key, status, note, created_at) VALUES (?,?,?,?,?,?,?,?)'
    )
      .bind(id, b.name, slug, prefix, genServerKey(), 'active', b.note || '', now())
      .run();
    return json({ ok: true, id });
  }
  return fail('不支持的方法', 405);
}

/** 服务端调用凭证：只在服务端之间使用，客户端永远拿不到 */
function genServerKey() {
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  return 'sk_' + [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 重置服务端凭证（旧凭证立即失效） */
async function rotateServerKey(env, appId, ctx, admin) {
  const app = await env.DB.prepare('SELECT * FROM apps WHERE id = ?').bind(appId).first();
  if (!app) return fail('软件不存在', 404);
  const nk = genServerKey();
  await env.DB.prepare('UPDATE apps SET server_key = ? WHERE id = ?').bind(nk, appId).run();
  await audit(env, admin.actor, 'rotate_server_key', appId, app.name, '');
  return json({ ok: true, server_key: nk });
}

async function appOne(request, env, method, id, ctx, admin) {
  if (method === 'PATCH' || method === 'PUT') {
    const b = await readJson(request);
    const cur = await env.DB.prepare('SELECT * FROM apps WHERE id = ?').bind(id).first();
    if (!cur) return fail('软件不存在', 404);
    await env.DB.prepare('UPDATE apps SET name = ?, prefix = ?, status = ?, note = ? WHERE id = ?')
      .bind(
        b.name ?? cur.name,
        (b.prefix ?? cur.prefix).toUpperCase().replace(/[^0-9A-Z]/g, ''),
        b.status ?? cur.status,
        b.note ?? cur.note,
        id
      )
      .run();
    return json({ ok: true });
  }
  if (method === 'DELETE') {
    const c = await env.DB.prepare('SELECT COUNT(*) AS c FROM licenses WHERE app_id = ?').bind(id).first();
    if (c.c > 0)
      return fail(
        `该软件下还有 ${c.c} 个授权码，无法删除。如果只是想让它停止使用，改成「停用」即可（授权码会立即失效但记录保留）。`,
        400,
        'HAS_LICENSES'
      );
    await env.DB.prepare('DELETE FROM plans WHERE app_id = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM apps WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }
  return fail('不支持的方法', 405);
}

// ---------------- 套餐 ----------------

async function plans(request, env, method, ctx, admin) {
  if (method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT p.*, a.name AS app_name,
        (SELECT COUNT(*) FROM licenses l WHERE l.plan_id = p.id) AS lic_count
       FROM plans p LEFT JOIN apps a ON a.id = p.app_id ORDER BY p.created_at DESC`
    ).all();
    return json({ ok: true, list: rows.results || [] });
  }
  if (method === 'POST') {
    const b = await readJson(request);
    if (!b?.app_id || !b?.name) return fail('所属软件和套餐名称必填');
    const id = uid('plan_');
    const atype = b.afdian_type === 'sku' ? 'sku' : 'plan';
    await env.DB.prepare(
      `INSERT INTO plans (id, app_id, name, duration_mode, duration_days, max_devices, verify_limit, features,
        afdian_plan_id, afdian_sku_id, afdian_type, msg_template, status, note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
      .bind(
        id,
        b.app_id,
        b.name,
        b.duration_mode || 'from_activation',
        Number(b.duration_days ?? 30),
        Number(b.max_devices ?? 1),
        Number(b.verify_limit ?? 100),
        JSON.stringify(b.features || {}),
        atype === 'plan' ? b.afdian_plan_id || null : null,
        atype === 'sku' ? b.afdian_sku_id || null : null,
        atype,
        b.msg_template || null,
        b.status || 'active',
        b.note || '',
        now()
      )
      .run();
    return json({ ok: true, id });
  }
  return fail('不支持的方法', 405);
}

async function planOne(request, env, method, id, ctx, admin) {
  const cur = await env.DB.prepare('SELECT * FROM plans WHERE id = ?').bind(id).first();
  if (!cur) return fail('套餐不存在', 404);

  if (method === 'PATCH' || method === 'PUT') {
    const b = await readJson(request);
    const atype = (b.afdian_type ?? cur.afdian_type) === 'sku' ? 'sku' : 'plan';
    await env.DB.prepare(
      `UPDATE plans SET name=?, duration_mode=?, duration_days=?, max_devices=?, verify_limit=?, features=?,
        afdian_plan_id=?, afdian_sku_id=?, afdian_type=?, msg_template=?, status=?, note=? WHERE id=?`
    )
      .bind(
        b.name ?? cur.name,
        b.duration_mode ?? cur.duration_mode,
        Number(b.duration_days ?? cur.duration_days),
        Number(b.max_devices ?? cur.max_devices),
        Number(b.verify_limit ?? cur.verify_limit ?? 100),
        JSON.stringify(b.features ?? parseFeatures(cur.features)),
        atype === 'plan' ? (b.afdian_plan_id !== undefined ? b.afdian_plan_id || null : cur.afdian_plan_id) : null,
        atype === 'sku' ? (b.afdian_sku_id !== undefined ? b.afdian_sku_id || null : cur.afdian_sku_id) : null,
        atype,
        b.msg_template !== undefined ? b.msg_template || null : cur.msg_template,
        b.status ?? cur.status,
        b.note ?? cur.note,
        id
      )
      .run();
    return json({ ok: true });
  }
  if (method === 'DELETE') {
    const c = await env.DB.prepare('SELECT COUNT(*) AS c FROM licenses WHERE plan_id = ?').bind(id).first();
    if (c.c > 0) return fail('该套餐下还有 ' + c.c + ' 个授权码', 400, 'HAS_LICENSES');
    await env.DB.prepare('DELETE FROM plans WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }
  return fail('不支持的方法', 405);
}

// ---------------- 授权码 ----------------

function buildLicWhere(url) {
  const where = [];
  const args = [];
  const p = url.searchParams;

  if (p.get('app_id')) {
    where.push('l.app_id = ?');
    args.push(p.get('app_id'));
  }
  if (p.get('plan_id')) {
    where.push('l.plan_id = ?');
    args.push(p.get('plan_id'));
  }
  if (p.get('batch_id')) {
    where.push('l.batch_id = ?');
    args.push(p.get('batch_id'));
  }
  const st = p.get('status');
  const t = now();
  if (st === 'banned') where.push("l.status = 'banned'");
  else if (st === 'revoked') where.push("l.status = 'revoked'");
  else if (st === 'active') {
    where.push(
      "l.status = 'active' AND (l.duration_mode = 'lifetime' OR l.expires_at IS NULL OR l.expires_at > ?)"
    );
    args.push(t);
  } else if (st === 'expired') {
    where.push(
      "l.status = 'active' AND l.duration_mode <> 'lifetime' AND l.expires_at IS NOT NULL AND l.expires_at <= ?"
    );
    args.push(t);
  } else if (st === 'unactivated') {
    where.push("l.activated_at IS NULL AND l.duration_mode = 'from_activation'");
  }

  if (p.get('q')) {
    where.push('(l.key LIKE ? OR l.note LIKE ? OR l.buyer_name LIKE ? OR l.afdian_order_no LIKE ?)');
    const q = '%' + p.get('q') + '%';
    args.push(q, q, q, q);
  }
  return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}

async function licenses(request, env, method, url, ctx, admin) {
  if (method === 'GET') {
    const { clause, args } = buildLicWhere(url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const size = Math.min(200, Math.max(1, parseInt(url.searchParams.get('size') || '50', 10)));

    const total = await env.DB.prepare(`SELECT COUNT(*) AS c FROM licenses l ${clause}`)
      .bind(...args)
      .first();

    const rows = await env.DB.prepare(
      `SELECT l.*, a.name AS app_name, a.slug AS app_slug, p.name AS plan_name,
        (SELECT COUNT(*) FROM devices d WHERE d.license_id = l.id) AS device_count
       FROM licenses l
       LEFT JOIN apps a ON a.id = l.app_id
       LEFT JOIN plans p ON p.id = l.plan_id
       ${clause}
       ORDER BY l.created_at DESC LIMIT ? OFFSET ?`
    )
      .bind(...args, size, (page - 1) * size)
      .all();

    const list = (rows.results || []).map((r) => ({
      ...r,
      features: parseFeatures(r.features),
      eff_status: effectiveStatus(r),
      expires_text: fmtTime(r.expires_at),
    }));
    return json({ ok: true, list, total: total.c, page, size });
  }

  if (method === 'POST') {
    const b = await readJson(request);
    if (!b?.app_id) return fail('请选择软件');
    const app = await env.DB.prepare('SELECT * FROM apps WHERE id = ?').bind(b.app_id).first();
    if (!app) return fail('软件不存在', 404);

    // 选了套餐就以套餐为模板：不填的项一律继承，避免「选了套餐却拿不到功能位」
    let plan = null;
    if (b.plan_id) {
      plan = await env.DB.prepare('SELECT * FROM plans WHERE id = ?').bind(b.plan_id).first();
      if (!plan) return fail('套餐不存在', 404);
    }

    const mode = b.duration_mode || plan?.duration_mode || 'from_activation';
    const days = mode === 'lifetime' ? null : Number(b.duration_days ?? plan?.duration_days ?? 30);
    const maxDev = Number(b.max_devices ?? plan?.max_devices ?? 1);
    const verifyLimit = Number(b.verify_limit ?? plan?.verify_limit ?? 100);
    const features = JSON.stringify(b.features ?? (plan ? parseFeatures(plan.features) : {}));

    const id = uid('lic_');
    let expiresAt = null;
    if (mode === 'fixed' && b.fixed_expires_at) expiresAt = Number(b.fixed_expires_at);
    if (mode === 'fixed' && !expiresAt) return fail('固定到期模式必须指定到期时间');

    let key = '';
    for (let i = 0; i < 4; i++) {
      key = generateKey(b.prefix || app.prefix, 20);
      try {
        await env.DB.prepare(
          `INSERT INTO licenses (id, key, key_norm, app_id, plan_id, duration_mode, duration_days, expires_at,
            max_devices, verify_limit, features, status, source, note, created_by, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
          .bind(
            id,
            key,
            normKey(key),
            b.app_id,
            b.plan_id || null,
            mode,
            days,
            expiresAt,
            maxDev,
            verifyLimit,
            features,
            'active',
            'manual',
            b.note || null,
            admin.actor,
            now()
          )
          .run();
        break;
      } catch (e) {
        if (!String(e.message || e).includes('UNIQUE')) throw e;
      }
    }
    return json({ ok: true, id, key });
  }
  return fail('不支持的方法', 405);
}

async function licenseOne(request, env, method, id, ctx, admin) {
  // 分两步查：OR 条件在 SQLite 里可能退化成扫描，主键查询更快
  let lic = await env.DB.prepare('SELECT * FROM licenses WHERE id = ?').bind(id).first();
  if (!lic) {
    lic = await env.DB.prepare('SELECT * FROM licenses WHERE key_norm = ?').bind(normKey(id)).first();
  }
  if (!lic) return fail('授权码不存在', 404);

  if (method === 'GET') {
    const devs = await env.DB.prepare('SELECT * FROM devices WHERE license_id = ?').bind(lic.id).all();
    return json({ ok: true, license: { ...lic, features: parseFeatures(lic.features) }, devices: devs.results || [] });
  }

  if (method === 'PATCH' || method === 'PUT') {
    const b = await readJson(request);
    await env.DB.prepare(
      `UPDATE licenses SET status=?, max_devices=?, features=?, note=?, duration_days=?, expires_at=? WHERE id=?`
    )
      .bind(
        b.status ?? lic.status,
        Number(b.max_devices ?? lic.max_devices),
        JSON.stringify(b.features ?? parseFeatures(lic.features)),
        b.note !== undefined ? b.note : lic.note,
        b.duration_days !== undefined ? Number(b.duration_days) : lic.duration_days,
        b.expires_at !== undefined ? b.expires_at : lic.expires_at,
        lic.id
      )
      .run();
    return json({ ok: true });
  }

  if (method === 'DELETE') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM devices WHERE license_id = ?').bind(lic.id),
      env.DB.prepare('DELETE FROM licenses WHERE id = ?').bind(lic.id),
    ]);
    return json({ ok: true });
  }
  return fail('不支持的方法', 405);
}

async function renew(request, env, id, ctx, admin) {
  const b = await readJson(request);
  const days = Number(b?.days || 0);
  if (!days || days === 0) return fail('请填写续期天数（负数表示缩减）');

  const lic = await env.DB.prepare('SELECT * FROM licenses WHERE id = ?').bind(id).first();
  if (!lic) return fail('授权码不存在', 404);
  if (lic.duration_mode === 'lifetime') return fail('永久授权无需续期', 400, 'LIFETIME');

  let newDays = lic.duration_days || 0;
  let newExp = lic.expires_at;

  if (!lic.expires_at) {
    // 尚未激活 / 固定到期但未设置：直接加天数
    newDays = newDays + days;
    if (newDays <= 0) return fail('续期后天数不能小于等于 0');
  } else {
    // 已激活或已过期：在绝对时间上累加（过期后购买也能从今天续）
    const base = Math.max(lic.expires_at, now());
    newExp = base + days * 86400;
  }

  await env.DB.prepare('UPDATE licenses SET duration_days = ?, expires_at = ? WHERE id = ?')
    .bind(newDays, newExp, lic.id)
    .run();

  await audit(env, admin.actor, 'renew', lic.id, `${days > 0 ? '+' : ''}${days} 天`, '');

  return json({ ok: true, duration_days: newDays, expires_at: newExp });
}

/** 换发：旧 key 吊销 → 新建一枚继承全部权益（设备绑定不继承） */
async function reissue(env, licenseId, ctx, admin) {
  const lic = await env.DB.prepare('SELECT * FROM licenses WHERE id = ?').bind(licenseId).first();
  if (!lic) return fail('授权码不存在', 404);
  if (lic.status === 'revoked') return fail('该授权码已被吊销，无需重复换发', 400, 'ALREADY_REVOKED');

  const app = await env.DB.prepare('SELECT * FROM apps WHERE id = ?').bind(lic.app_id).first();
  if (!app) return fail('软件不存在', 404);

  const r = await reissueLicense(env, lic, app.prefix, admin.actor);

  // 审计里只留掩码：audit_logs 保留 90 天且 /admin/api/logs 会原样返回，
  // 存完整 key 等于把在售授权码留了一份长周期副本（配合 DB 导出即全部泄露）。
  await audit(
    env,
    admin.actor,
    'reissue',
    lic.id,
    `旧 ${maskKeyTail(lic.key)} → 新 ${maskKeyTail(r.key)}`,
    '',
  );

  return json({ ok: true, id: r.id, key: r.key, old_key: lic.key });
}

async function batchCreate(request, env, ctx, admin) {
  const b = await readJson(request);
  if (!b?.app_id) return fail('请选择软件');
  const count = Math.min(200, Math.max(1, Number(b.count || 1))); // 单次上限 200，避免 Worker CPU 超时
  const app = await env.DB.prepare('SELECT * FROM apps WHERE id = ?').bind(b.app_id).first();
  if (!app) return fail('软件不存在', 404);

  let plan = null;
  if (b.plan_id) {
    plan = await env.DB.prepare('SELECT * FROM plans WHERE id = ?').bind(b.plan_id).first();
  }

  const mode = b.duration_mode || plan?.duration_mode || 'from_activation';
  const days = mode === 'lifetime' ? null : Number(b.duration_days ?? plan?.duration_days ?? 30);
  const maxDev = Number(b.max_devices ?? plan?.max_devices ?? 1);
  const verifyLimit = Number(b.verify_limit ?? plan?.verify_limit ?? 100);
  const features = JSON.stringify(b.features ?? (plan ? parseFeatures(plan.features) : {}));
  const prefix = (b.prefix || app.prefix).toUpperCase();
  const batchId = uid('bat_');
  const t = now();

  let expiresAt = null;
  if (mode === 'fixed') {
    if (!b.fixed_expires_at) return fail('固定到期模式必须指定到期时间');
    expiresAt = Number(b.fixed_expires_at);
  }

  const keys = [];
  const stmts = [];
  for (let i = 0; i < count; i++) {
    const key = generateKey(prefix, 20);
    keys.push(key);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO licenses (id, key, key_norm, app_id, plan_id, batch_id, duration_mode, duration_days,
          expires_at, max_devices, verify_limit, features, status, source, note, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        uid('lic_'),
        key,
        normKey(key),
        b.app_id,
        b.plan_id || null,
        batchId,
        mode,
        days,
        expiresAt,
        maxDev,
        verifyLimit,
        features,
        'active',
        'manual',
        b.note || null,
        admin.actor,
        t
      )
    );
  }

  // 分批写入：单次事务太大时 D1 会整体失败，分成每 50 条一批更稳
  try {
    for (let i = 0; i < stmts.length; i += 50) {
      await env.DB.batch(stmts.slice(i, i + 50));
    }
  } catch (e) {
    return json({ ok: false, code: 'BATCH_FAILED', message: '批量写入失败：' + e.message }, 500);
  }

  await env.DB.prepare(
    'INSERT INTO batches (id, app_id, plan_id, prefix, count, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)'
  )
    .bind(batchId, b.app_id, b.plan_id || null, prefix, count, b.note || '', admin.actor, t)
    .run();

  return json({ ok: true, batch_id: batchId, keys, count });
}

async function exportCsv(env, url) {
  const { clause, args } = buildLicWhere(url);
  const rows = await env.DB.prepare(
    `SELECT l.key, a.name AS app_name, p.name AS plan_name, l.duration_mode, l.duration_days,
      l.expires_at, l.status, l.max_devices, l.activated_at, l.note, l.created_at
     FROM licenses l LEFT JOIN apps a ON a.id = l.app_id LEFT JOIN plans p ON p.id = l.plan_id
     ${clause} ORDER BY l.created_at DESC LIMIT 1000`
  )
    .bind(...args)
    .all();

  const head = ['授权码', '软件', '套餐', '期限模式', '天数', '到期时间', '状态', '设备上限', '激活时间', '备注', '创建时间'];
  const modeMap = { from_activation: '首激活起算', fixed: '固定到期', lifetime: '永久' };

  // CSV 单元格统一加引号转义，并对公式前缀做中和。
  // 买家备注（licenses.note）是外部可控的：填成 `=cmd|'/c calc'!A0` 后，
  // 管理员用 Excel 打开导出文件就会触发公式/DDE 执行。
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };

  const lines = [head.map(cell).join(',')];
  for (const r of rows.results || []) {
    lines.push(
      [
        r.key,
        r.app_name || '',
        r.plan_name || '',
        modeMap[r.duration_mode] || r.duration_mode,
        r.duration_days ?? '',
        r.expires_at ? fmtTime(r.expires_at) : '永久',
        r.status,
        r.max_devices,
        r.activated_at ? fmtTime(r.activated_at) : '未激活',
        r.note || '',
        fmtTime(r.created_at),
      ]
        .map(cell)
        .join(',')
    );
  }

  await audit(env, 'admin', 'export_csv', '', `导出 ${(rows.results || []).length} 行`, '');

  return new Response('\uFEFF' + lines.join('\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="licenses_${todayStr()}.csv"`,
    },
  });
}

async function listDevices(env, licenseId) {
  const rows = await env.DB.prepare(
    'SELECT * FROM devices WHERE license_id = ? ORDER BY first_seen'
  )
    .bind(licenseId)
    .all();
  return json({ ok: true, list: rows.results || [] });
}

async function removeDevice(request, env, ctx, admin) {
  const b = await readJson(request);
  if (!b?.device_id) return fail('缺少 device_id');
  await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(b.device_id).run();
  await audit(env, admin.actor, 'remove_device', b.device_id, '', '');
  return json({ ok: true });
}

async function listBatches(env) {
  const rows = await env.DB.prepare(
    `SELECT b.*, a.name AS app_name, p.name AS plan_name FROM batches b
     LEFT JOIN apps a ON a.id = b.app_id LEFT JOIN plans p ON p.id = b.plan_id
     ORDER BY b.created_at DESC LIMIT 100`
  ).all();
  return json({ ok: true, list: rows.results || [] });
}

async function revokeBatch(env, batchId, ctx, admin) {
  const r = await env.DB.prepare(
    "UPDATE licenses SET status = 'revoked' WHERE batch_id = ? AND status = 'active'"
  )
    .bind(batchId)
    .run();
  await audit(env, admin.actor, 'revoke_batch', batchId, '吊销批次', '');
  return json({ ok: true, revoked: r.meta?.changes || 0 });
}

// ---------------- 订单 ----------------

async function listOrders(env, url) {
  const p = url.searchParams;
  const where = [];
  const args = [];
  if (p.get('delivery')) {
    where.push('o.delivery = ?');
    args.push(p.get('delivery'));
  }
  if (p.get('q')) {
    where.push('(o.out_trade_no LIKE ? OR o.afdian_user_id LIKE ? OR o.remark LIKE ?)');
    const q = '%' + p.get('q') + '%';
    args.push(q, q, q);
  }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const page = Math.max(1, parseInt(p.get('page') || '1', 10));
  const size = 50;

  const total = await env.DB.prepare(`SELECT COUNT(*) AS c FROM orders o ${clause}`).bind(...args).first();
  const rows = await env.DB.prepare(
    // 显式列：不要 o.*。orders.raw 存着整条爱发电 JSON（含 344 字节 RSA 签名），
    // 50 行就是约 60 KB 的无用读写，前端从不使用它。需要看原文请单独开详情。
    `SELECT o.out_trade_no, o.afdian_user_id, o.afdian_plan_id, o.afdian_sku_id,
            o.product_type, o.title, o.amount, o.month, o.status,
            o.license_id, o.archived_key, o.issue_type, o.delivery, o.delivery_error,
            o.created_at, o.processed_at,
            l.key, l.status AS lic_status, l.expires_at, l.max_devices AS lic_max_devices,
            a.name AS app_name, p.name AS plan_name,
            (SELECT COUNT(*) FROM devices d WHERE d.license_id = o.license_id) AS device_count,
            (SELECT group_concat(substr(d.fingerprint, 1, 12), ', ')
               FROM devices d WHERE d.license_id = o.license_id) AS device_brief
     FROM orders o LEFT JOIN licenses l ON l.id = o.license_id
     LEFT JOIN apps a ON a.id = l.app_id LEFT JOIN plans p ON p.id = o.plan_id
     ${clause} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(...args, size, (page - 1) * size)
    .all();

  return json({ ok: true, list: rows.results || [], total: total.c, page });
}

/** 手动触发与爱发电对账（网络问题导致没收到 webhook 时的补救入口） */
async function syncOrders(env, ctx) {
  const r = await reconcileOrders(env, ctx, { maxPages: 10 });
  if (!r.ok) return json({ ok: false, code: 'SYNC_FAILED', message: r.error }, 500);
  await audit(env, 'admin', 'sync_orders', '', `扫描 ${r.scanned} 单，补发 ${r.added} 单`, '');
  return json({ ok: true, scanned: r.scanned, added: r.added, renewed: r.renewed, pages: r.pages });
}

/**
 * 重发私信（强制）。
 * 无论队列是 pending 还是已 sent，只要订单有授权码就重新发一条。
 * 场景：买家说没收到 / 私信被误删 / 网络抖动丢了。
 */
async function retryOrder(env, outTradeNo, ctx) {
  const o = await env.DB.prepare('SELECT * FROM orders WHERE out_trade_no = ?').bind(outTradeNo).first();
  if (!o) return fail('订单不存在', 404);
  if (!o.license_id) return fail('该订单还没有授权码，请先「手动发码」', 400, 'NO_LICENSE');

  // 1) 队列里还有待发的 → 直接重试那一条
  const pending = await env.DB.prepare(
    "SELECT * FROM msg_queue WHERE ref = ? AND state = 'pending' ORDER BY id DESC LIMIT 1"
  )
    .bind(outTradeNo)
    .first();

  if (pending) {
    const ok = await tryDeliver(env, pending.id, pending.recipient, pending.content, outTradeNo);
    return json({ ok: true, sent: ok, mode: 'retry' });
  }

  // 2) 已发过但买家没收到 → 重新入队并发一条
  const lic = await env.DB.prepare(
    `SELECT l.*, a.name AS app_name, p.name AS plan_name
       FROM licenses l
       LEFT JOIN apps a ON a.id = l.app_id
       LEFT JOIN plans p ON p.id = l.plan_id
      WHERE l.id = ?`
  )
    .bind(o.license_id)
    .first();
  if (!lic) return fail('授权码记录不存在', 404);

  const recipient = o.afdian_user_id || lic.buyer_id;
  if (!recipient) return fail('该订单缺少接收账号 user_id', 400, 'NO_RECIPIENT');

  const expText =
    lic.duration_mode === 'lifetime'
      ? '永久有效'
      : lic.expires_at
        ? fmtTime(lic.expires_at)
        : '首次激活后开始计时';

  const content =
    '（重新发送）\n\n' +
    renderMsg(DEFAULT_MSG_TEMPLATE, {
      key: lic.key,
      plan: lic.plan_name || '',
      app: lic.app_name || '',
      expires: expText,
      order: outTradeNo,
      amount: o.amount || '',
    });

  const t = now();
  const q = await env.DB.prepare(
    'INSERT INTO msg_queue (recipient, content, ref, state, attempts, created_at, updated_at) VALUES (?,?,?,?,0,?,?)'
  )
    .bind(recipient, content, outTradeNo, 'pending', t, t)
    .run();

  const ok = await tryDeliver(env, q.meta?.last_row_id, recipient, content, outTradeNo);
  return json({ ok: true, sent: ok, mode: 'resend' });
}

async function issueOrder(request, env, outTradeNo, ctx, admin) {
  const b = await readJson(request);
  if (!b?.plan_id) return fail('请选择套餐');

  const o = await env.DB.prepare('SELECT * FROM orders WHERE out_trade_no = ?').bind(outTradeNo).first();
  if (!o) return fail('订单不存在', 404);
  if (o.license_id) return fail('该订单已发码', 400, 'ALREADY_ISSUED');

  const plan = await env.DB.prepare('SELECT * FROM plans WHERE id = ?').bind(b.plan_id).first();
  if (!plan) return fail('套餐不存在', 404);

  const orderObj = {
    out_trade_no: o.out_trade_no,
    user_id: o.afdian_user_id,
    total_amount: o.amount,
    remark: o.remark,
  };
  const lic = await issueAndQueue(env, orderObj, plan, ctx, { forceNew: !!b.force_new });
  if (!lic) return fail('发码失败');

  await env.DB.prepare(
    "UPDATE orders SET delivery = 'manual', delivery_error = NULL WHERE out_trade_no = ?"
  )
    .bind(outTradeNo)
    .run();

  return json({ ok: true, key: lic.key, renewed: !!lic.__renewed });
}

// ---------------- 设置 / 公钥 / 日志 ----------------

async function settings(request, env, method, ctx, admin) {
  if (method === 'GET') {
    // 5 个独立读并发，别串行 —— 串行时每个 D1 往返 10~30ms，这里能省 40~100ms 墙钟
    const [rate, site_name, msg_template, claim_hint, today_blocked] = await Promise.all([
      rateConfig(env),
      getMeta(env, 'site_name', env.SITE_NAME || 'Key 管理台'),
      getMeta(env, 'msg_template', ''),
      getMeta(env, 'claim_hint', ''),
      blockedToday(env),
    ]);
    return json({
      ok: true,
      site_name,
      msg_template,
      claim_hint,
      rate: { ...rate, today_blocked },
      env: {
        auth_mode: env.AUTH_MODE || 'both',
        access_configured: !!(env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD),
        afdian_configured: !!(env.AFDIAN_USER_ID && env.AFDIAN_TOKEN),
        token_ttl_hours: env.TOKEN_TTL_HOURS || '24',
        unbind_cooldown: env.SELF_UNBIND_COOLDOWN_DAYS || '30',
        allow_unsigned: env.WEBHOOK_ALLOW_UNSIGNED === '1',
      },
    });
  }
  if (method === 'POST') {
    const b = await readJson(request);
    if (b.site_name !== undefined) await setMeta(env, 'site_name', b.site_name);
    if (b.msg_template !== undefined) await setMeta(env, 'msg_template', b.msg_template);
    if (b.claim_hint !== undefined) await setMeta(env, 'claim_hint', b.claim_hint);
    if (b.rate_profile !== undefined) {
      if (!PROFILES[b.rate_profile]) return fail('无效的限流档位');
      await setMeta(env, 'rate_profile', b.rate_profile);
      resetLimitCache(); // 立即生效，不用等 60 秒缓存过期
      await audit(env, admin.actor, 'set_rate_profile', '', b.rate_profile);
    }
    return json({ ok: true });
  }
  return fail('不支持的方法', 405);
}

async function pubkey(env) {
  try {
    return json({ ok: true, alg: 'RS256', public_key: await getPublicKeyPem(env) });
  } catch (e) {
    return fail('尚未配置 LICENSE_PRIVATE_KEY：' + e.message, 400, 'NO_KEY');
  }
}

async function logs(env, url) {
  const size = Math.min(200, Number(url.searchParams.get('size') || 100));
  const rows = await env.DB.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').bind(size).all();
  return json({ ok: true, list: rows.results || [] });
}

/**
 * 发送一条测试私信 —— 用来验证爱发电 token 与私信通道是否正常。
 *
 * 默认收件人是自己的爱发电 user_id（发给自己，爱发电允许）。
 * 传 user_id 可发给别的账号；爱发电规则：双方必须有赞助关系，否则发不出去。
 *
 * 返回爱发电的原始响应：ec=200 表示投递成功。
 * 常见失败：ec=400004（token 无效）、ec=400006（与对方无赞助关系）
 */
async function testAfdianMsg(request, env, admin) {
  // 这个接口能用你的创作者身份给任意 user_id 发私信，必须收口：
  // 限频 + 内容长度上限，避免被当成群发器（滥用会导致账号被平台风控）。
  if (!(await rateLimitDb(env, 'testmsg:' + admin.actor, 3, 60))) {
    return fail('测试私信太频繁，请 1 分钟后再试', 429, 'RATE_LIMIT');
  }

  const b = (await readJson(request)) || {};
  const recipient = String(b.user_id || env.AFDIAN_USER_ID || '').trim().slice(0, 64);
  if (!recipient) return fail('未配置 AFDIAN_USER_ID，请手动填写收件人 user_id');

  const content = String(
    b.content || '【测试消息】这是一条来自 Key 管理台的测试私信，收到即说明私信通道正常。',
  ).slice(0, 500);

  const r = await sendMsg(env, recipient, content);
  await audit(
    env,
    admin.actor,
    'afdian_test_msg',
    recipient,
    `ec=${r?.ec ?? '?'} ${r?.em || ''}`,
    '',
  );

  return json({
    ok: r?.ec === 200,
    ec: r?.ec ?? null,
    em: r?.em || '',
    recipient,
    content,
  });
}

// ---------------- 爱发电方案同步 ----------------
// 把创作者后台的方案列表拉下来存本地快照，避免手工抄 32 位 plan_id 抄错。
// 数据源是爱发电网页前端接口（只需 user_id，不需 token）。

// POST /admin/api/afdian/sync —— 拉取并写入本地快照
async function afdianSync(request, env, ctx, admin) {
  if (!env.AFDIAN_USER_ID) {
    return fail('AFDIAN_USER_ID 未配置，无法同步', 400, 'NO_UID');
  }
  const r = await syncCreatorPlans(env);
  if (!r.ok) {
    return json({ ok: false, code: 'AFDIAN_ERR', message: r.error }, 502);
  }
  await audit(env, admin.actor, 'afdian_sync', '', `同步 ${r.count} 个方案`, clientIp(request));
  return json({ ok: true, count: r.count, list: r.list });
}

// GET /admin/api/afdian/plans —— 读本地快照（含是否已建本地套餐）
async function afdianPlanList(env) {
  const list = await listSyncedPlans(env);
  return json({ ok: true, list });
}
