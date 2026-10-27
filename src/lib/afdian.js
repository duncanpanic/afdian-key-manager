// 爱发电开放平台客户端 + Webhook 验签
// 文档：https://guide.afdian.com/creator/developer
// 签名规则：sign = md5(token + 'params' + params + 'ts' + ts + 'user_id' + user_id)

import { md5 } from './md5.js';
import { flexibleB64ToBytes, now } from './util.js';

// 官方新旧域名并存（afdian.com / ifdian.net），均可用。
// 留 env 覆盖口子：万一域名调整或被墙，改环境变量即可，不用改代码。
const API_BASE = 'https://afdian.com/api/open';

// 爱发电官方 webhook 验签公钥（可在 env 中覆盖）
const DEFAULT_PUBKEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwwdaCg1Bt+UKZKs0R54y
lYnuANma49IpgoOwNmk3a0rhg/PQuhUJ0EOZSowIC44l0K3+fqGns3Ygi4AfmEfS
4EKbdk1ahSxu7Zkp2rHMt+R9GarQFQkwSS/5x1dYiHNVMiR8oIXDgjmvxuNes2Cr
8fw9dEF0xNBKdkKgG2qAawcN1nZrdyaKWtPVT9m2Hl0ddOO9thZmVLFOb9NVzgYf
jEgI+KWX6aY19Ka/ghv/L4t1IXmz9pctablN5S0CRWpJW3Cn0k6zSXgjVdKm4uN7
jRlgSRaf/Ind46vMCm3N2sgwxu/g3bnooW+db0iLo13zzuvyn727Q3UDQ0MmZcEW
MQIDAQAB
-----END PUBLIC KEY-----`;

function pemToDer(pem) {
  const body = String(pem).replace(/\\n/g, '\n').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

let _webhookKey = null;
let _webhookPem = '';

async function getWebhookKey(env) {
  const pem = env.AFDIAN_WEBHOOK_PUBKEY || DEFAULT_PUBKEY;
  // 比对 PEM：万一平台换钥或 env 变更，缓存要能失效
  if (_webhookKey && _webhookPem === pem) return _webhookKey;
  _webhookKey = await crypto.subtle.importKey(
    'spki',
    pemToDer(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  _webhookPem = pem;
  return _webhookKey;
}

/**
 * 校验爱发电 webhook 签名
 * 签名串 = out_trade_no + user_id + plan_id + total_amount
 */
export async function verifyWebhook(env, body) {
  const order = body?.data?.order;
  if (!order) return { ok: false, reason: 'no_order' };

  // 实测（社区 SDK 的模型定义）：sign 挂在 order 对象上，即 data.order.sign。
  // 为兼容平台后续可能的位置调整，同时也认 body.sign / data.sign。
  const sign = order.sign || body.sign || body.data?.sign;

  if (!sign) {
    // 爱发电 2025-07 之前的 webhook 不带签名
    if (env.WEBHOOK_ALLOW_UNSIGNED === '1') return { ok: true, unsigned: true };
    return { ok: false, reason: 'no_sign' };
  }

  const signStr = `${order.out_trade_no}${order.user_id}${order.plan_id || ''}${order.total_amount}`;
  const key = await getWebhookKey(env);
  try {
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      flexibleB64ToBytes(sign),
      new TextEncoder().encode(signStr)
    );
    return ok ? { ok: true } : { ok: false, reason: 'bad_sign' };
  } catch (e) {
    return { ok: false, reason: 'verify_error:' + e.message };
  }
}

/**
 * 判断是不是爱发电官方的「测试 webhook」样本订单。
 *
 * 爱发电在保存 webhook 时会推送一笔**固定样本**，每个创作者收到的都是同一笔：
 *   plan_title = "测试webhook"
 *   user_id    = adf397fe8374811eaacee52540025c377   （平台测试买家，不是真人）
 *   plan_id    = a45353328af911eb973052540025c377   （平台测试方案）
 *   sku_id     = 2172ea4e3a2311edbcaa52540025c377 / ...c378 （平台测试型号）
 *
 * 它不属于任何真实交易。若不拦掉会连锁出三个问题：
 *   ① 生成一枚买家永远收不到的废码（爱发电不允许给测试号发私信）
 *   ② 私信队列反复重试，白烧额度，还让管理台一直显示「待发送」
 *   ③ 污染订单列表与对账统计，真实订单被淹没
 *
 * ⚠️ 注意：**不能**用 order.user_id 去判断归属。
 * 爱发电订单里的 user_id 是**买家**的 ID，不是创作者的 ID；创作者身份由 webhook 绑在哪个账号决定。
 * 拿它跟 AFDIAN_USER_ID（创作者自己的）比，会把**所有真实订单**都误杀。
 */
const AFDIAN_TEST_PLAN_ID = 'a45353328af911eb973052540025c377';
const AFDIAN_TEST_SKU_IDS = new Set([
  '2172ea4e3a2311edbcaa52540025c377',
  '2172ea4e3a2311edbcaa52540025c378',
]);

export function isAfdianTestOrder(order) {
  if (!order) return true;
  if (order.plan_title === '测试webhook') return true;
  if (order.plan_id && order.plan_id === AFDIAN_TEST_PLAN_ID) return true;
  const skus = Array.isArray(order.sku_detail) ? order.sku_detail : [];
  if (skus.length && skus.every((s) => AFDIAN_TEST_SKU_IDS.has(s.sku_id))) return true;
  return false;
}

/** 调用爱发电开放接口 */
async function afdianCall(env, endpoint, params = {}) {
  if (!env.AFDIAN_USER_ID || !env.AFDIAN_TOKEN) {
    return { ec: -1, em: 'AFDIAN_USER_ID / AFDIAN_TOKEN 未配置' };
  }
  const p = JSON.stringify(params);
  const ts = now();
  const kv = `params${p}ts${ts}user_id${env.AFDIAN_USER_ID}`;
  const sign = md5(env.AFDIAN_TOKEN + kv);

  try {
    const base = env.AFDIAN_API_BASE || API_BASE;
    const res = await fetch(`${base}/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: env.AFDIAN_USER_ID, params: p, ts, sign }),
    });
    return await res.json();
  } catch (e) {
    return { ec: -1, em: 'network: ' + e.message };
  }
}

export const queryOrders = (env, opts = {}) => afdianCall(env, 'query-order', opts);

/** 发送私信。爱发电限频 10/s、1000/h */
export function sendMsg(env, recipient, content) {
  return afdianCall(env, 'send-msg', { recipient, content });
}

/**
 * 判断私信失败是「永久性」还是「临时性」。
 *
 * 永久性失败再重试多少次都一样，只会白烧额度、还让管理台一直显示「待发送」：
 *   400001 需要赞助关系（对方没赞助过你）—— 真实场景下不会发生，但爱发电测试号会
 *   400003 参数错误
 *   400004 token 无效 —— 需要人工换 token
 * 临时性失败（限频 400006、网络抖动）值得重试。
 */
export function isPermanentMsgError(ec, em) {
  const e = Number(ec);
  if (e === 400001 || e === 400003 || e === 400004) return true;
  const s = String(em || '');
  if (s.includes('需要赞助') || s.includes('token 无效') || s.includes('参数')) return true;
  return false;
}

/* ---------------- 方案列表（非开放平台接口） ----------------
   爱发电网页前端用的 /api/creator/get-plans，只需要 user_id，不需要 token。
   好处：不用手工抄 32 位 plan_id（抄错的表现是「订单永远匹配不上」，很难查）。
   风险：不在开放平台文档内，字段可能随前端改版变化 —— 所以：
     1. 整条原始 JSON 存进 afdian_plans.raw，字段变了也能回头核对
     2. 解析失败只影响「导入」这一个功能，不影响发码主链路
     3. 界面上永远保留手工填 ID 的入口
*/

const WEB_BASE = 'https://afdian.com';

/** 拉取创作者的全部方案/商品（不落库） */
export async function fetchCreatorPlans(env) {
  const uid = env.AFDIAN_USER_ID;
  if (!uid) return { ok: false, error: 'AFDIAN_USER_ID 未配置' };

  const base = env.AFDIAN_WEB_BASE || WEB_BASE;
  const url = `${base}/api/creator/get-plans?user_id=${encodeURIComponent(uid)}`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(url, {
      headers: {
        accept: 'application/json, text/plain, */*',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const j = await res.json();
    if (j.ec !== 200) return { ok: false, error: j.em || ('接口返回 ec=' + j.ec) };
    return { ok: true, list: j.data?.list || [] };
  } catch (e) {
    return { ok: false, error: '请求失败：' + (e.name === 'AbortError' ? '超时 10 秒' : e.message) };
  }
}

/** 从接口返回里尽量抠出型号列表（商品型才有，字段各家版本不一） */
function pickSkus(p) {
  const arr = Array.isArray(p.skus) ? p.skus : Array.isArray(p.sku_detail) ? p.sku_detail : null;
  if (!arr) return null;
  return arr.map((s) => ({
    sku_id: s.sku_id || s.skuId || null,
    name: s.sku_name || s.name || s.title || '',
    price: s.price ?? null,
    stock: s.stock ?? null,
  }));
}

/** 拉取创作者全部售卖型商品（与赞助方案是不同接口，必须单独拉） */
export async function fetchCreatorProducts(env) {
  const uid = env.AFDIAN_USER_ID;
  if (!uid) return { ok: false, error: 'AFDIAN_USER_ID 未配置' };
  const base = env.AFDIAN_WEB_BASE || WEB_BASE;
  const url = `${base}/api/creator/get-products?user_id=${encodeURIComponent(uid)}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(url, {
      headers: {
        accept: 'application/json, text/plain, */*',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const j = await res.json();
    if (j.ec !== 200) return { ok: false, error: j.em || ('接口返回 ec=' + j.ec) };
    return { ok: true, list: j.data?.list || [] };
  } catch (e) {
    return { ok: false, error: '请求失败：' + (e.name === 'AbortError' ? '超时 10 秒' : e.message) };
  }
}

// 把两个接口返回的项统一成 afdian_plans 行。source 用于兜底 product_type。
function normalizePlan(p, source) {
  const skus = pickSkus(p);
  return {
    plan_id: p.plan_id,
    name: p.name || p.title || '',
    product_type: Number(p.product_type ?? (source === 'product' ? 1 : 0)),
    price: String(p.price ?? ''),
    status: Number(p.status ?? 0),
    pay_month: p.pay_month ? Number(p.pay_month) : null,
    sku_json: skus ? JSON.stringify(skus) : null,
    raw: JSON.stringify(p),
  };
}

/** 拉取方案 + 商品，合并写入本地快照（upsert，不删已有行） */
export async function syncCreatorPlans(env) {
  const rows = [];
  const warnings = [];

  const plans = await fetchCreatorPlans(env);
  if (plans.ok) plans.list.forEach((p) => rows.push(normalizePlan(p, 'plan')));
  else warnings.push('赞助/订阅方案同步失败：' + plans.error);

  const products = await fetchCreatorProducts(env);
  if (products.ok) products.list.forEach((p) => rows.push(normalizePlan(p, 'product')));
  else warnings.push('售卖型商品同步失败：' + products.error);

  const t = now();
  const stmts = [];
  for (const row of rows) {
    if (!row.plan_id) continue;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO afdian_plans (plan_id,name,product_type,price,status,pay_month,sku_json,raw,synced_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(plan_id) DO UPDATE SET
           name=excluded.name, product_type=excluded.product_type, price=excluded.price,
           status=excluded.status, pay_month=excluded.pay_month,
           sku_json=excluded.sku_json, raw=excluded.raw, synced_at=excluded.synced_at`
      ).bind(
        row.plan_id, row.name, row.product_type, row.price, row.status,
        row.pay_month, row.sku_json, row.raw, t
      )
    );
  }

  if (stmts.length) await env.DB.batch(stmts);
  return { ok: true, list: rows, count: rows.length, warn: warnings.join('；') };
}

/** 读本地快照，附带「是否已建成本地套餐」 */
export async function listSyncedPlans(env) {
  const rows = await env.DB.prepare(
    `SELECT a.*, p.id AS local_plan_id, p.name AS local_plan_name
       FROM afdian_plans a
       LEFT JOIN plans p ON p.afdian_plan_id = a.plan_id
      ORDER BY (p.id IS NULL) DESC, a.status DESC, a.synced_at DESC`
  ).all();
  return (rows.results || []).map((r) => ({
    ...r,
    skus: r.sku_json ? JSON.parse(r.sku_json) : [],
  }));
}
