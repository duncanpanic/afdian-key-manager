// 公开 API：软件端验证 / 用户查询 / 自助解绑 / 凭订单取码

import { json, readJson, now, todayStr, uid, rateLimit, rateLimitDb, clientIp } from '../lib/util.js';
import { checkKeyFormat, normKey } from '../lib/keygen.js';
import {
  effectiveStatus,
  activateIfNeeded,
  buildLicenseToken,
  parseFeatures,
  renderMsg,
  DEFAULT_MSG_TEMPLATE,
  fmtTime,
} from '../lib/license.js';
import { getPublicKeyPem } from '../lib/jwt.js';
import { getLimits, noteBlocked, BAD_KEY_LIMIT } from '../lib/ratelimit.js';
import { tryDeliver } from './webhook.js';

// 默认不开放跨域。
// 桌面客户端不是浏览器、不受 CORS 限制；管理台和查询页与 API 同源，也不需要。
// 因此不返回任何 allow-origin 头，等于拒绝其他网页调用。确有需要再加白名单。
const PREFLIGHT_HEADERS = {
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization',
};

export function corsPreflight() {
  return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });
}

function out(body, status = 200, extra = {}) {
  return json(body, status, extra);
}

/** GET 与 POST 统一取参数，避免在路由层伪造 Request 对象 */
async function readParams(request) {
  if (request.method === 'GET') {
    return Object.fromEntries(new URL(request.url).searchParams);
  }
  return readJson(request);
}

/** 只显示尾 4 位，避免截屏/肩窥泄露完整授权码 */
function maskKey(key) {
  // 先去掉分隔符再取尾 4 位，否则会把末尾的「-」算进去（显示成 9P-9）
  const raw = String(key || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return '••••-••••-••••-' + raw.slice(-4);
}

/**
 * POST /api/v1/server/check —— 服务端校验（供你自己的业务服务器调用）
 *
 * 与 /verify 的区别：
 *   /verify       客户端用，返回签名令牌
 *   /server/check 服务端用，只回答「能不能用」，不签发任何凭证
 *
 * 鉴权用 apps.server_key，客户端永远拿不到这个值。
 * 业务服务器建议本地缓存结果 5 分钟，避免每次业务请求都回源。
 */
export async function handleServerCheck(request, env) {
  const ip = clientIp(request);
  const R = await getLimits(env);
  if (!rateLimit('srv:' + ip, R.srv, 60)) {
    noteBlocked(env);
    return out({ ok: false, code: 'RATE_LIMIT', message: '请求过于频繁（服务端请本地缓存 5 分钟）' }, 429);
  }

  const auth = request.headers.get('authorization') || '';
  const provided = (
    auth.startsWith('Bearer ') ? auth.slice(7) : request.headers.get('x-server-key') || ''
  ).trim();

  if (!provided) {
    return out({ ok: false, code: 'UNAUTHORIZED', message: '缺少服务端凭证' }, 401);
  }

  const app = await env.DB.prepare(
    "SELECT * FROM apps WHERE server_key = ? AND status = 'active'"
  )
    .bind(provided)
    .first();

  if (!app) {
    return out({ ok: false, code: 'UNAUTHORIZED', message: '服务端凭证无效' }, 401);
  }

  const body = await readParams(request);
  if (!body) return out({ ok: false, code: 'BAD_REQUEST', message: 'JSON 解析失败' }, 400);

  const rawKey = String(body.key || '').trim();
  if (!checkKeyFormat(rawKey).valid) {
    return out({ ok: false, code: 'INVALID_KEY', message: '授权码格式不正确' });
  }

  const lic = await env.DB.prepare('SELECT * FROM licenses WHERE key_norm = ?')
    .bind(normKey(rawKey))
    .first();

  if (!lic) return out({ ok: false, code: 'NOT_FOUND', message: '授权码不存在' });
  if (lic.app_id !== app.id) {
    return out({ ok: false, code: 'APP_MISMATCH', message: '该授权码不属于本软件' });
  }

  const st = effectiveStatus(lic);
  if (st !== 'active') {
    const msg =
      st === 'expired' ? '授权码已过期' : st === 'banned' ? '授权码已被封禁' : '授权码已被吊销';
    return out({ ok: false, code: st.toUpperCase(), message: msg, expires_at: lic.expires_at });
  }

  return out({
    ok: true,
    code: 'OK',
    license: {
      id: lic.id,
      app_id: lic.app_id,
      plan_id: lic.plan_id,
      duration_mode: lic.duration_mode,
      activated_at: lic.activated_at,
      expires_at: lic.expires_at,
      max_devices: lic.max_devices,
      features: parseFeatures(lic.features),
    },
  });
}

/** GET /api/v1/pubkey —— 供客户端内置验签公钥 */
export async function handlePubkey(env) {
  try {
    const pem = await getPublicKeyPem(env);
    // 公钥永远不变（除非换密钥对），允许 CDN 缓存一天，客户端不再每次打 Worker
    return out({ ok: true, alg: 'RS256', public_key: pem }, 200, {
      'cache-control': 'public, max-age=86400',
    });
  } catch (e) {
    return out({ ok: false, code: 'SERVER_ERROR', message: e.message }, 500);
  }
}

/**
 * POST /api/v1/verify
 * { key, app?, fingerprint, label?, version? }
 * 成功返回签名令牌，客户端本地缓存离线校验；令牌到期前无需再次请求。
 */
export async function handleVerify(request, env) {
  const body = await readJson(request);
  if (!body) return out({ ok: false, code: 'BAD_REQUEST', message: 'JSON 解析失败' }, 400);

  const ip = clientIp(request);
  const R = await getLimits(env);
  if (!rateLimit('verify:' + ip, R.verify, 60)) {
    noteBlocked(env);
    return out({ ok: false, code: 'RATE_LIMIT', message: '请求过于频繁' }, 429);
  }

  const rawKey = String(body.key || '').trim();
  if (!rawKey) return out({ ok: false, code: 'BAD_REQUEST', message: '缺少 key' });

  // 无效 key 单独计一道更严的闸：正常人一分钟不可能输错 20 次，
  // 而扫描器刷不存在的 key 会在这里被挡住，不会每个都打一次数据库。
  // 这一道不随「限流档位」变化 —— 放宽它等于把接口白送给扫描器。
  const badKeyGate = () => {
    const pass = rateLimit('bad:' + ip, BAD_KEY_LIMIT, 60);
    if (!pass) noteBlocked(env);
    return pass;
  };

  if (!checkKeyFormat(rawKey).valid) {
    if (!badKeyGate()) return out({ ok: false, code: 'RATE_LIMIT', message: '尝试次数过多，请 1 分钟后再试' }, 429);
    return out({ ok: false, code: 'INVALID_KEY', message: '授权码格式不正确，请检查是否输错' });
  }

  const key = normKey(rawKey);
  const fingerprint = String(body.fingerprint || '').trim().slice(0, 200);
  if (!fingerprint) {
    return out({ ok: false, code: 'BAD_REQUEST', message: '缺少设备指纹 fingerprint' });
  }

  const lic = await env.DB.prepare(
    `SELECT l.*, a.slug AS app_slug, a.status AS app_status, a.name AS app_name
       FROM licenses l LEFT JOIN apps a ON a.id = l.app_id
      WHERE l.key_norm = ?`
  )
    .bind(key)
    .first();

  if (!lic) {
    if (!badKeyGate()) return out({ ok: false, code: 'RATE_LIMIT', message: '尝试次数过多，请 1 分钟后再试' }, 429);
    return out({ ok: false, code: 'NOT_FOUND', message: '授权码不存在' });
  }

  if (body.app && lic.app_slug && String(body.app).trim().toLowerCase() !== lic.app_slug) {
    return out({ ok: false, code: 'APP_MISMATCH', message: '该授权码不适用于本软件' });
  }
  // 软件记录缺失（软删除/迁移异常）也视为不可用，避免出现「无主的 key 永远有效」
  if (!lic.app_slug || lic.app_status === 'disabled') {
    return out({ ok: false, code: 'APP_DISABLED', message: '该软件已停用' });
  }

  const st = effectiveStatus(lic);
  if (st === 'banned') return out({ ok: false, code: 'BANNED', message: '授权码已被封禁' });
  if (st === 'revoked') return out({ ok: false, code: 'REVOKED', message: '授权码已被吊销' });
  if (st === 'expired') {
    return out({
      ok: false,
      code: 'EXPIRED',
      message: '授权码已过期',
      expires_at: lic.expires_at,
    });
  }

  const t = now();
  const day = todayStr(t);

  // ---- 设备绑定：先查，超限直接返回，避免白白消耗一次验证计数 ----
  const maxDev = lic.max_devices || 1;
  const devices =
    (await env.DB.prepare(
      'SELECT id, fingerprint, last_seen_day, last_ip, recent_ips, first_seen FROM devices WHERE license_id = ?'
    )
      .bind(lic.id)
      .all()).results || [];

  const bound = devices.find((d) => d.fingerprint === fingerprint);

  // 已绑定设备：检测 IP 漂移。
  // 把指纹写死共享给多台机器时，虽然指纹不变，但各机器的出口 IP 会不断变化。
  // 允许最多 5 个不同 IP（家里/公司/移动网络属正常），第 6 个直接拒绝。
  const MAX_IPS = 5;
  let ips = [];
  if (bound) {
    try {
      ips = JSON.parse(bound.recent_ips || '[]') || [];
      if (!Array.isArray(ips)) ips = [];
    } catch {
      ips = [];
    }
    if (ip && !ips.includes(ip) && ips.length >= MAX_IPS) {
      return out({
        ok: false,
        code: 'DEVICE_IP_LIMIT',
        message: `该设备已在 ${MAX_IPS} 个不同网络下使用，超过上限。若确为本人更换网络，请在查询页解绑后重新激活。`,
        max_ips: MAX_IPS,
      });
    }
  }

  if (!bound && devices.length >= maxDev) {
    return out({
      ok: false,
      code: 'DEVICE_LIMIT',
      message: `已达设备数上限（${lic.max_devices} 台），请先在查询页解绑旧设备`,
      max_devices: lic.max_devices,
      bound_count: devices.length,
    });
  }

  // 新设备日限：24 小时内最多新增「该套餐允许的设备数」台。
  // 防止用随机指纹一次性占满槽位（占了又不用，真正的主人被锁在外面）。
  //
  // 用 D1 计数而不是统计 devices 表的 first_seen：解绑会删行，
  // 表里统计不到「今天曾经加过几台」，那样「解绑→重绑」就能无限绕过。
  if (!bound) {
    const allowed = await rateLimitDb(env, 'devadd:' + lic.id, maxDev, 86400);
    if (!allowed) {
      return out({
        ok: false,
        code: 'DEVICE_ADD_LIMIT',
        message: `该授权码 24 小时内新增设备已达上限（${maxDev} 台）。请稍后再试，或先解绑不用的设备。`,
        max_devices: maxDev,
      });
    }
  }

  // ---- 每日验证次数（原子判断+扣减，一次写入零读取）----
  if ((lic.verify_limit || 0) > 0) {
    const r = await env.DB.prepare(
      `UPDATE licenses
          SET verify_count = CASE WHEN verify_day = ? THEN verify_count + 1 ELSE 1 END,
              verify_day = ?
        WHERE id = ?
          AND (verify_day IS NULL OR verify_day <> ? OR verify_count < ?)`
    )
      .bind(day, day, lic.id, day, lic.verify_limit)
      .run();

    if (!r.meta || r.meta.changes === 0) {
      return out({
        ok: false,
        code: 'VERIFY_LIMIT',
        message: '今日验证次数已达上限，请明天再试；若频繁重启软件请联系作者',
      });
    }
  }

  // ---- 设备写入 + 首激活计时：合并成一次 batch，少一次 D1 往返 ----
  const stmts = [];

  if (bound) {
    // 平时跨天才写库省额度；但 IP 变化必须立刻记（安全相关，不能等）
    let newIps = ips;
    if (ip && !ips.includes(ip)) newIps = [...ips, ip];
    const ipChanged = !!ip && ip !== bound.last_ip;

    if (bound.last_seen_day !== day || ipChanged) {
      stmts.push(
        env.DB.prepare(
          'UPDATE devices SET last_seen = ?, last_seen_day = ?, last_ip = ?, recent_ips = ? WHERE id = ?'
        ).bind(t, day, ip || bound.last_ip || null, JSON.stringify(newIps), bound.id)
      );
    }
  } else {
    stmts.push(
      // OR IGNORE：首次验证时客户端重试会造成并发双插，
      // 唯一约束 (license_id, fingerprint) 会抛出 500，加 IGNORE 后幂等
      env.DB.prepare(
        `INSERT OR IGNORE INTO devices
           (id, license_id, fingerprint, label, first_seen, last_seen, last_seen_day, last_ip, recent_ips)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).bind(
        uid('dev_'),
        lic.id,
        fingerprint,
        String(body.label || '').slice(0, 60),
        t,
        t,
        day,
        ip || null,
        JSON.stringify(ip ? [ip] : [])
      )
    );
  }

  let use = lic;
  const act = activateIfNeeded(lic, t);
  if (act.activated) {
    use = act.lic;
    stmts.push(
      env.DB.prepare('UPDATE licenses SET activated_at = ?, expires_at = ? WHERE id = ?').bind(
        use.activated_at,
        use.expires_at,
        use.id
      )
    );
  }

  if (stmts.length) await env.DB.batch(stmts);

  const app = { slug: lic.app_slug, name: lic.app_name };
  const { token, exp } = await buildLicenseToken(env, use, app, fingerprint);

  return out({
    ok: true,
    code: 'OK',
    token,
    exp,
    license: {
      id: use.id,
      app: lic.app_slug,
      plan_id: use.plan_id,
      duration_mode: use.duration_mode,
      activated_at: use.activated_at,
      expires_at: use.expires_at,
      max_devices: use.max_devices,
      features: parseFeatures(use.features),
    },
  });
}

/** POST /api/v1/status —— 用户查询剩余时长 / 绑定设备 */
export async function handleStatus(request, env) {
  const body = await readParams(request);
  if (!body) return out({ ok: false, code: 'BAD_REQUEST', message: 'JSON 解析失败' }, 400);

  const ip = clientIp(request);
  const R = await getLimits(env);
  if (!rateLimit('status:' + ip, R.status, 60)) {
    noteBlocked(env);
    return out({ ok: false, code: 'RATE_LIMIT', message: '查询过于频繁，请稍后再试' }, 429);
  }

  const rawKey = String(body.key || '').trim();
  if (!checkKeyFormat(rawKey).valid) {
    return out({ ok: false, code: 'INVALID_KEY', message: '授权码格式不正确' });
  }
  const key = normKey(rawKey);

  const lic = await env.DB.prepare(
    `SELECT l.*, a.name AS app_name, a.slug AS app_slug, a.status AS app_status
       FROM licenses l LEFT JOIN apps a ON a.id = l.app_id WHERE l.key_norm = ?`
  )
    .bind(key)
    .first();

  if (!lic) return out({ ok: false, code: 'NOT_FOUND', message: '授权码不存在' });

  const st = effectiveStatus(lic);
  const devices = (
    await env.DB.prepare(
      'SELECT id, label, first_seen, last_seen FROM devices WHERE license_id = ? ORDER BY first_seen'
    )
      .bind(lic.id)
      .all()
  ).results || [];

  return out({
    ok: true,
    key: maskKey(lic.key),
    status: lic.app_status === 'disabled' ? 'app_disabled' : st,
    app: lic.app_name,
    app_slug: lic.app_slug,
    duration_mode: lic.duration_mode,
    activated_at: lic.activated_at,
    expires_at: lic.expires_at,
    max_devices: lic.max_devices,
    features: parseFeatures(lic.features),
    unbind_cooldown: parseInt(env.SELF_UNBIND_COOLDOWN_DAYS || '30', 10),
    devices: devices.map((d, i) => ({
      slot: i + 1,
      label: d.label || '未命名设备',
      first_seen: d.first_seen,
      last_seen: d.last_seen,
    })),
    can_self_unbind: checkUnbindCooldown(env, lic).ok,
  });
}

function checkUnbindCooldown(env, lic) {
  const days = parseInt(env.SELF_UNBIND_COOLDOWN_DAYS || '30', 10);
  if (!lic.last_self_unbind_at) return { ok: true };
  const next = lic.last_self_unbind_at + days * 86400;
  if (now() >= next) return { ok: true };
  return {
    ok: false,
    next_at: next,
    message: `自助解绑每 ${days} 天只能使用一次，下次可用时间：${new Date(next * 1000).toLocaleString('zh-CN')}`,
  };
}

/** POST /api/v1/unbind —— 自助解绑（解绑全部设备，重新绑定） */
export async function handleUnbind(request, env) {
  const body = await readParams(request);
  if (!body) return out({ ok: false, code: 'BAD_REQUEST', message: 'JSON 解析失败' }, 400);

  const ip = clientIp(request);
  const R = await getLimits(env);
  if (!rateLimit('unbind:' + ip, R.unbind, 3600)) {
    noteBlocked(env);
    return out({ ok: false, code: 'RATE_LIMIT', message: '操作过于频繁' }, 429);
  }

  const rawKey = String(body.key || '').trim();
  if (!checkKeyFormat(rawKey).valid) {
    return out({ ok: false, code: 'INVALID_KEY', message: '授权码格式不正确' });
  }
  const key = normKey(rawKey);

  const lic = await env.DB.prepare('SELECT * FROM licenses WHERE key_norm = ?').bind(key).first();
  if (!lic) return out({ ok: false, code: 'NOT_FOUND', message: '授权码不存在' });

  const st = effectiveStatus(lic);
  if (st !== 'active') {
    return out({ ok: false, code: st.toUpperCase(), message: '授权码当前状态不可解绑' });
  }

  const cd = checkUnbindCooldown(env, lic);
  if (!cd.ok) return out({ ok: false, code: 'COOLDOWN', message: cd.message, next_at: cd.next_at });

  await env.DB.batch([
    env.DB.prepare('DELETE FROM devices WHERE license_id = ?').bind(lic.id),
    env.DB.prepare('UPDATE licenses SET last_self_unbind_at = ? WHERE id = ?').bind(now(), lic.id),
    env.DB.prepare(
      'INSERT INTO audit_logs (actor, action, target, detail, ip, created_at) VALUES (?,?,?,?,?,?)'
    ).bind('user:' + lic.key.slice(-6), 'self_unbind', lic.id, '自助解绑全部设备', ip, now()),
  ]);

  return out({ ok: true, message: '已解绑全部设备，可在新设备上重新激活' });
}

/** POST /api/v1/claim —— 凭爱发电订单号取回授权码（私信丢了的兜底） */
export async function handleClaim(request, env, ctx) {
  const body = await readParams(request);
  if (!body) return out({ ok: false, code: 'BAD_REQUEST', message: 'JSON 解析失败' }, 400);

  const ip = clientIp(request);
  const R = await getLimits(env);
  if (!rateLimit('claim:' + ip, R.claim, 600)) {
    noteBlocked(env);
    return out({ ok: false, code: 'RATE_LIMIT', message: '查询过于频繁' }, 429);
  }

  const no = String(body.out_trade_no || body.order || '').trim();
  if (!/^\d{6,40}$/.test(no)) {
    return out({ ok: false, code: 'BAD_REQUEST', message: '订单号格式不正确' });
  }

  const row = await env.DB.prepare(
    `SELECT o.out_trade_no, o.afdian_user_id, o.license_id,
            l.key, l.buyer_id, l.expires_at, l.duration_mode,
            a.name AS app_name, p.name AS plan_name
       FROM orders o
       LEFT JOIN licenses l ON l.id = o.license_id
       LEFT JOIN apps a ON a.id = l.app_id
       LEFT JOIN plans p ON p.id = o.plan_id
      WHERE o.out_trade_no = ?`
  )
    .bind(no)
    .first();

  if (!row) {
    return out({
      ok: false,
      code: 'NOT_FOUND',
      message: '未找到该订单，请确认订单号；若刚付款请等一两分钟再试',
    });
  }
  if (!row.key) {
    return out({ ok: false, code: 'PENDING', message: '订单已收到，授权码正在生成，请稍后再试' });
  }

  const recipient = row.afdian_user_id || row.buyer_id;
  if (!recipient) {
    return out({ ok: false, code: 'NO_RECIPIENT', message: '该订单缺少接收账号，请联系作者' });
  }

  // 防骚扰：同一订单 30 分钟内只允许触发一次重发
  const t = now();
  const recent = await env.DB.prepare(
    'SELECT id FROM msg_queue WHERE ref = ? AND created_at > ? LIMIT 1'
  )
    .bind(no, t - 1800)
    .first();
  if (recent) {
    return out({ ok: true, message: '授权码刚刚已发送到你的爱发电私信，请查收' });
  }

  const expText =
    row.duration_mode === 'lifetime'
      ? '永久有效'
      : row.expires_at
        ? fmtTime(row.expires_at)
        : '首次激活后开始计时';

  const content =
    '（重新发送）\n\n' +
    renderMsg(DEFAULT_MSG_TEMPLATE, {
      key: row.key,
      plan: row.plan_name || '',
      app: row.app_name || '',
      expires: expText,
      order: no,
      amount: '',
    });

  const q = await env.DB.prepare(
    'INSERT INTO msg_queue (recipient, content, ref, state, attempts, created_at, updated_at) VALUES (?,?,?,?,0,?,?)'
  )
    .bind(recipient, content, no, 'pending', t, t)
    .run();

  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(tryDeliver(env, q.meta?.last_row_id, recipient, content, no));
  }

  return out({ ok: true, message: '授权码已发送到你的爱发电私信，请查收' });
}
