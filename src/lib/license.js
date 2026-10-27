// 许可证核心逻辑：签发、状态计算、令牌构造

import { now, uid, bytesToHex } from './util.js';
import { generateKey, normKey } from './keygen.js';
import { signRS256 } from './jwt.js';

export function parseFeatures(s) {
  if (!s) return {};
  if (typeof s === 'object') return s;
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/** 许可证的实际状态（到期是算出来的，不靠定时任务翻状态） */
export function effectiveStatus(lic, t = now()) {
  if (!lic) return 'not_found';
  // 状态白名单：只有 active 才继续判到期。
  // 之前只认 banned/revoked，导致 status='disabled'、拼写错误或 NULL 都会掉进最后的
  // `return 'active'`，把停用的码当有效用。
  if (lic.status && lic.status !== 'active') return lic.status;
  if (lic.duration_mode === 'lifetime') return 'active';
  if (lic.expires_at && lic.expires_at <= t) return 'expired';
  return 'active';
}

/** 创建一枚许可证 */
export async function createLicense(env, d) {
  const createdAt = now();
  const prefix = (d.prefix || '').toUpperCase();

  let expiresAt = null;
  if (d.duration_mode === 'lifetime') {
    expiresAt = null;
  } else if (d.duration_mode === 'fixed') {
    expiresAt = d.fixed_expires_at || null;
  } else {
    // from_activation：生成时不计时，首次激活才起算
    expiresAt = null;
  }

  const id = uid('lic_');
  let key = '';
  let lastErr = null;

  for (let attempt = 0; attempt < 4; attempt++) {
    key = generateKey(prefix, 20);
    try {
      await env.DB.prepare(
        `INSERT INTO licenses
         (id, key, key_norm, app_id, plan_id, batch_id, duration_mode, duration_days, activated_at, expires_at,
          max_devices, verify_limit, features, status, source, afdian_order_no, buyer_id, buyer_name, note, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
        .bind(
          id,
          key,
          normKey(key),
          d.app_id,
          d.plan_id || null,
          d.batch_id || null,
          d.duration_mode || 'from_activation',
          d.duration_mode === 'lifetime' ? null : d.duration_days ?? 30,
          null,
          expiresAt,
          d.max_devices ?? 1,
          d.verify_limit ?? 100,
          JSON.stringify(d.features || {}),
          'active',
          d.source || 'manual',
          d.afdian_order_no || null,
          d.buyer_id || null,
          d.buyer_name || null,
          d.note || null,
          d.created_by || 'system',
          createdAt
        )
        .run();
      return { id, key, expires_at: expiresAt };
    } catch (e) {
      lastErr = e;
      // 只有 key 唯一约束冲突才值得换一个 key 重试；其他错误（含参数/类型）立即失败
      if (!String(e.message || e).includes('UNIQUE')) break;
    }
  }
  throw lastErr || new Error('生成 key 失败');
}

/** 首次激活时起算有效期 */
export function activateIfNeeded(lic, t = now()) {
  if (lic.activated_at) return { activated: false, lic };
  const next = { ...lic, activated_at: t };
  if (lic.duration_mode === 'from_activation') {
    next.expires_at = t + (lic.duration_days || 30) * 86400;
  }
  if (lic.duration_mode === 'fixed' && !lic.expires_at) {
    next.expires_at = t + (lic.duration_days || 30) * 86400;
  }
  return { activated: true, lic: next };
}

/** 构造客户端许可证令牌（RS256） */
export async function buildLicenseToken(env, lic, app, fingerprint) {
  const t = now();
  // TTL 必须兜底：`TOKEN_TTL_HOURS="0"` 在 `x || '24'` 里是真值，会算出 exp=iat 让令牌立即过期；
  // `"abc"` 会得到 NaN，JSON 序列化后 exp 变成 null，等于签出一枚永不过期的令牌。
  const ttlHours = (() => {
    const n = Number(env.TOKEN_TTL_HOURS);
    if (!Number.isFinite(n) || n <= 0) return 24;
    return Math.min(n, 24 * 365);
  })();
  const ttl = ttlHours * 3600;
  let exp = t + ttl;
  if (lic.expires_at && lic.expires_at < exp) exp = lic.expires_at;

  const fpHash = fingerprint
    ? bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fingerprint))).slice(0, 16)
    : null;

  // 字段名用可读的全称而不是 f/md/pl 这类缩写。
  // 令牌大几十字节对性能毫无影响，但客户端对接时少一层猜谜。
  const payload = {
    ver: 1,
    iss: 'afdian-key',
    sub: lic.id,
    app: app ? app.slug : null,
    plan: lic.plan_id,
    features: parseFeatures(lic.features),
    max_devices: lic.max_devices,
    fingerprint: fpHash,
    duration_mode: lic.duration_mode,
    iat: t,
    exp,
  };

  return { token: await signRS256(env, payload), exp, payload };
}

/**
 * 订单里的 plan_id / sku_id 是否在「已同步的爱发电方案快照」中。
 *
 * 白名单制：只要同步过一次快照，就只认快照里的 ID。
 * 这样任何乱填的 ID（比如抄了爱发电官方测试样本的 plan_id/sku_id）都匹配不到套餐，
 * 也就不会凭空发出一枚码。
 * 还没同步过快照时不做限制，避免漏发真实订单。
 */
async function planIdInSnapshot(env, planId, skuId) {
  if (!env.DB) return true;
  let count = 0;
  try {
    const c = await env.DB.prepare('SELECT COUNT(*) AS c FROM afdian_plans').first();
    count = Number(c?.c || 0);
  } catch {
    return true; // 表还不存在 → 不限制
  }
  if (!count) return true; // 从没同步过 → 不限制

  if (planId) {
    const row = await env.DB.prepare('SELECT sku_json FROM afdian_plans WHERE plan_id = ?')
      .bind(planId)
      .first();
    if (row) {
      if (!skuId) return true;
      // sku_json 为空说明同步时爱发电没返回型号列表（接口字段各家版本不一，
      // pickSkus 会返回 null）。这种情况无法判断型号真伪 —— 必须放行，
      // 否则该 plan 下所有带 sku 的合法订单都会被判死、永久不发码。
      // 真正的准入保证来自 plans 表映射：没有本地套餐就发不出码。
      if (!row.sku_json) return true;
      let skus = [];
      try {
        skus = JSON.parse(row.sku_json) || [];
      } catch {
        return true;
      }
      if (!Array.isArray(skus) || !skus.length) return true;
      return skus.some((s) => s.sku_id === skuId);
    }
  }
  if (skuId) {
    const rows = await env.DB.prepare('SELECT sku_json FROM afdian_plans WHERE sku_json IS NOT NULL').all();
    for (const r of rows.results || []) {
      const skus = JSON.parse(r.sku_json || '[]');
      if (skus.some((s) => s.sku_id === skuId)) return true;
    }
  }
  return false;
}

/** 按爱发电 plan_id / sku_id 找本地套餐
 *  afdian_type 用于区分订阅方案与售卖商品，避免同一个套餐被两种渠道误匹配 */
export async function matchPlan(env, afdianPlanId, skuId) {
  if (!(await planIdInSnapshot(env, afdianPlanId, skuId))) return null;
  if (skuId) {
    const bySku = await env.DB.prepare(
      `SELECT * FROM plans
        WHERE afdian_sku_id = ? AND status = 'active'
          AND (afdian_type = 'sku' OR afdian_type IS NULL)
        LIMIT 1`
    )
      .bind(skuId)
      .first();
    if (bySku) return bySku;
  }
  if (afdianPlanId) {
    const byPlan = await env.DB.prepare(
      `SELECT * FROM plans
        WHERE afdian_plan_id = ? AND status = 'active'
          AND (afdian_type = 'plan' OR afdian_type IS NULL)
        LIMIT 1`
    )
      .bind(afdianPlanId)
      .first();
    if (byPlan) return byPlan;
  }
  return null;
}

/** 私信文案渲染 */
export function renderMsg(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) =>
    vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m
  );
}

export const DEFAULT_MSG_TEMPLATE =
  '感谢你的支持！\n\n你的授权码：{key}\n套餐：{plan}\n有效期：{expires}\n\n在软件中输入授权码即可激活。如遇问题请直接回复本消息。';


/** 过期前这段时间内不允许续期（避免临界状态下时间计算歧义），改发新卡 */
export const RENEW_MIN_REMAIN_SEC = 30 * 60; // 30 分钟

/**
 * 找「可以续期」的授权码 —— 严格按「同套餐」匹配。
 *
 * 只认 plan_id：买家买过两个不同套餐时，按「最近创建的一枚」兜底会续错卡
 * （把月卡的续费加到年卡上），所以这里不做任何跨套餐兜底，找不到就发新卡。
 *
 * 返回：
 *   null                      → 没有可续期的码，调用方发新卡
 *   { ...lic, __lifetime:true } → 买家已持有该套餐的永久授权，调用方应拒绝重复发码
 *   { ...lic }                → 可续期
 */
export async function findRenewableLicense(env, appId, buyerId, planId, t = now()) {
  if (!buyerId || !planId) return null;

  const lic = await env.DB.prepare(
    `SELECT * FROM licenses
      WHERE app_id = ? AND buyer_id = ? AND plan_id = ? AND status = 'active'
      ORDER BY created_at DESC LIMIT 1`
  )
    .bind(appId, buyerId, planId)
    .first();
  if (!lic) return null;

  // 永久码不需要也不能再续（续了没有任何变化），交给上层拒绝并转人工
  if (lic.duration_mode === 'lifetime') return { ...lic, __lifetime: true };

  // 未激活的码（from_activation 尚未首次验证）没有到期时间，直接累加天数，不受 30 分钟约束
  if (!lic.expires_at) return lic;

  // 已过期 → 不能续期，发新卡
  if (lic.expires_at <= t) return null;

  // 剩余不足 30 分钟 → 按业务规则不允许续期，发新卡
  if (lic.expires_at - t < RENEW_MIN_REMAIN_SEC) return null;

  return lic;
}

/** 合并功能位：以新套餐为准，但保留旧套餐里独有的键（避免续费后丢功能） */
export function mergeFeatures(oldF, newF) {
  const parse = (v) => {
    if (!v) return {};
    if (typeof v === 'object') return v;
    try {
      return JSON.parse(v) || {};
    } catch {
      return {};
    }
  };
  return { ...parse(oldF), ...parse(newF) };
}

/** 在已有 key 上累加时长；未激活的只加天数，已过期的从今天起算 */
export async function extendLicense(env, lic, days) {
  if (lic.duration_mode === 'lifetime') {
    return { expires_at: null, duration_days: null, extended: false, reason: '永久授权无需续期' };
  }
  let newDays = lic.duration_days || 0;
  let newExp = lic.expires_at;

  if (!lic.expires_at) {
    // 尚未激活（from_activation）或未设定固定到期
    newDays += days;
  } else {
    newExp = Math.max(lic.expires_at, now()) + days * 86400;
    newDays += days;
  }

  await env.DB.prepare('UPDATE licenses SET duration_days = ?, expires_at = ? WHERE id = ?')
    .bind(newDays, newExp, lic.id)
    .run();

  return { expires_at: newExp, duration_days: newDays, extended: true };
}

// 手算北京时间，不依赖运行时的时区数据库（Workers 上 toLocaleString 的 ICU 支持不稳定）
export function fmtTime(t) {
  if (!t) return '永久';
  const d = new Date(t * 1000 + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(
    d.getUTCMinutes()
  )}`;
}

/**
 * 换发：旧 key 置为 revoked，新建一枚继承全部「权益」属性。
 *
 * 继承：软件、套餐、期限模式、剩余时长、激活时间、功能位、设备上限、验证上限、买家信息
 * 不继承：设备绑定（换发通常因泄露，原设备不可信）
 *
 * 关键点：expires_at 与 activated_at 原样搬运，所以「剩余时长」不会因为换发而变长或变短。
 */
export async function reissueLicense(env, lic, prefix, createdBy = 'admin') {
  const createdAt = now();
  const newId = uid('lic_');
  let key = '';
  let lastErr = null;

  const tail = String(lic.key || '').slice(-6);
  const newNote = (lic.note ? lic.note + ' | ' : '') + `换发自 ${tail}`;

  for (let attempt = 0; attempt < 4; attempt++) {
    key = generateKey(prefix || '', 20);
    try {
      await env.DB.prepare(
        `INSERT INTO licenses (id, key, key_norm, app_id, plan_id, duration_mode, duration_days,
          activated_at, expires_at, max_devices, verify_limit, features, status, source,
          afdian_order_no, buyer_id, buyer_name, note, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
        .bind(
          newId,
          key,
          normKey(key),
          lic.app_id,
          lic.plan_id || null,
          lic.duration_mode,
          lic.duration_days,
          lic.activated_at,
          lic.expires_at,
          lic.max_devices,
          lic.verify_limit,
          lic.features,
          'active',
          lic.source,
          lic.afdian_order_no,
          lic.buyer_id,
          lic.buyer_name,
          newNote,
          createdBy,
          createdAt
        )
        .run();
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (!String(e.message || e).includes('UNIQUE')) break;
    }
  }
  if (lastErr) throw lastErr;

  // 旧 key：吊销 + 记录去向。保留记录而不是删除，方便日后查历史
  await env.DB.prepare("UPDATE licenses SET status = 'revoked', note = ? WHERE id = ?")
    .bind((lic.note ? lic.note + ' | ' : '') + `已换发为 ${key}`, lic.id)
    .run();

  return { id: newId, key };
}
