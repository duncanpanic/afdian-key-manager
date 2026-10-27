// 爱发电 Webhook 接单 + 自动发码 + 私信投递

import { json, now, getMeta, audit, clientIp, rateLimitDb } from '../lib/util.js';
import { verifyWebhook, sendMsg, isAfdianTestOrder, isPermanentMsgError } from '../lib/afdian.js';
import {
  createLicense,
  matchPlan,
  renderMsg,
  DEFAULT_MSG_TEMPLATE,
  fmtTime,
  findRenewableLicense,
  mergeFeatures,
  extendLicense,
} from '../lib/license.js';

const OK = () => json({ ec: 200, em: '' });

/**
 * POST /webhook/afdian
 * 幂等：out_trade_no 为主键，重复推送不会重复发码
 */
export async function handleAfdianWebhook(request, env, ctx) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ ec: 400, em: 'bad json' }, 400);

  const v = await verifyWebhook(env, body);
  if (!v.ok) {
    // 验签失败不逐条写库。这是公网未鉴权入口、且不在额度熔断的拦截范围内，
    // 任何人循环 POST 垃圾请求都能把 D1 每日写额度打穿（写额度耗尽后真实订单
    // 的 INSERT 全部失败 = 发码彻底停摆）。改成每 IP 每分钟最多记 1 条，
    // 既保留可观测性，又不让审计表成为攻击面。用 D1 计数确保跨 isolate 有效。
    const ip = clientIp(request);
    if (await rateLimitDb(env, 'whrej:' + (ip || 'unknown'), 1, 60)) {
      await audit(
        env,
        'afdian',
        'webhook_reject',
        body?.data?.order?.out_trade_no || '-',
        v.reason,
        ip,
      );
    }
    // 验签失败也回 200，避免爱发电无限重试；异常记录留在审计日志里
    return OK();
  }

  const order = body.data.order;
  if (Number(order.status) !== 2) return OK(); // 仅支付成功发码

  // 爱发电保存 webhook 时会推一笔官方测试样本，放它进来会生成收不到的废码 + 私信无限重试
  if (isAfdianTestOrder(order)) {
    await audit(
      env,
      'afdian',
      'webhook_skip_test',
      order.out_trade_no || '-',
      '爱发电官方测试样本订单，已忽略',
      '',
    );
    return OK();
  }

  await processOrder(env, order, ctx);
  return OK();
}

/** 统一的订单处理入口：Webhook 与对账补单共用 */
export async function processOrder(env, order, ctx) {
  const skuList = Array.isArray(order.sku_detail) ? order.sku_detail : [];
  const skuId = skuList[0]?.sku_id || null;
  // 捆绑包/多型号订单只会按第一个型号发码，记一条提示方便对账时人工确认
  const multiSkuWarn =
    skuList.length > 1 ? `多型号订单（${skuList.length} 个），仅按第一个型号发码` : null;

  const t0 = now();

  await env.DB.prepare(
    `INSERT INTO orders
     (out_trade_no, afdian_user_id, afdian_plan_id, afdian_sku_id, product_type, title, amount, month, status,
      remark, delivery_error, raw, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(out_trade_no) DO UPDATE SET raw = excluded.raw`
  )
    .bind(
      order.out_trade_no,
      order.user_id,
      order.plan_id || null,
      skuId,
      order.product_type ?? null,
      order.title || order.sku_detail?.[0]?.name || '',
      order.total_amount,
      order.month ?? 1,
      order.status,
      order.remark || '',
      multiSkuWarn,
      JSON.stringify(order),
      t0
    )
    .run();

  /* 幂等：原子抢占「处理权」。
     原来是「先查 license_id 是否为空 → 处理完再写 license_id」，属于事后检查：
       · 并发推送（webhook 与 cron 对账，或多个 isolate）会双双读到空 → 发两枚码
       · createLicense 成功但后续某步抛错 → 爱发电重推 → 再发一枚
     现在改成一条 UPDATE 原子占位，只有真正把 delivery 从非 processing 改成 processing
     的那一次（changes=1）才继续发码。超过 5 分钟的 processing 视为僵死，允许重新抢占。 */
  const claim = await env.DB.prepare(
    `UPDATE orders
        SET delivery = 'processing', processed_at = ?
      WHERE out_trade_no = ?
        AND license_id IS NULL
        AND (delivery IS NULL OR delivery <> 'processing' OR processed_at IS NULL OR processed_at < ?)`
  )
    .bind(t0, order.out_trade_no, t0 - 300)
    .run();

  if (!claim.meta?.changes) return null; // 已发过码 / 正在别处处理中

  const plan = await matchPlan(env, order.plan_id, skuId);
  if (!plan) {
    await env.DB.prepare(
      "UPDATE orders SET delivery = 'unmatched', processed_at = ? WHERE out_trade_no = ?"
    )
      .bind(now(), order.out_trade_no)
      .run();
    return null;
  }

  return issueAndQueue(env, order, plan, ctx);
}

/**
 * 发码主逻辑：
 *   1. 先找同一买家在同一软件下的旧 key → 有就累加时长（不生成新 key）
 *   2. 没有才生成新 key
 *   3. 两种情况都把授权码写进私信队列，由 waitUntil / cron 投递
 */
export async function issueAndQueue(env, order, plan, ctx, opts = {}) {
  const t = now();
  const app = await env.DB.prepare('SELECT * FROM apps WHERE id = ?').bind(plan.app_id).first();
  if (!app) {
    await env.DB.prepare(
      "UPDATE orders SET delivery = 'failed', delivery_error = ?, processed_at = ? WHERE out_trade_no = ?"
    )
      .bind('套餐绑定的软件已删除', t, order.out_trade_no)
      .run();
    return null;
  }

  let lic;
  let issueType = 'new';
  let renewedDays = 0;

  // 购买月数：爱发电订单的 month 字段。买 3 个月就该给 3 个月的时长，
  // 旧代码直接用 plan.duration_days，买多月会被吞掉。
  const months = Math.max(1, Number(order.month) || 1);
  const grantDays = (plan.duration_days || 30) * months;

  // 续期判定：只有「同套餐 + 仍有效 + 剩余 >= 30 分钟」才在原卡上加时长；
  // 其余情况（无同套餐码 / 已过期 / 快到期 / forceNew）一律发新卡。
  let existing = opts.forceNew
    ? null
    : await findRenewableLicense(env, plan.app_id, order.user_id, plan.id, t);

  // 买家已持有该套餐的永久授权：按业务规则「买几次发几次」——
  // 永久卡不续期（续了没变化），直接再发一张新卡。
  if (existing && existing.__lifetime) existing = null;

  if (existing) {
    issueType = 'renew';
    renewedDays = grantDays;
    const ext = await extendLicense(env, existing, renewedDays);
    if (!ext.extended) {
      await env.DB.prepare(
        "UPDATE orders SET delivery = 'failed', delivery_error = ?, processed_at = ? WHERE out_trade_no = ?"
      )
        .bind('续期失败：' + (ext.reason || '未知原因'), t, order.out_trade_no)
        .run();
      return null;
    }
    lic = {
      ...existing,
      duration_days: ext.duration_days ?? existing.duration_days,
      expires_at: ext.expires_at ?? existing.expires_at,
    };

    // 续期时同步套餐权益：取 max 防缩水（已绑 3 台的客户不能因为套餐改成 1 台就超限）
    await env.DB.prepare(
      'UPDATE licenses SET max_devices = ?, verify_limit = ?, features = ? WHERE id = ?'
    )
      .bind(
        Math.max(existing.max_devices || 1, plan.max_devices || 1),
        Math.max(existing.verify_limit || 0, plan.verify_limit || 0),
        JSON.stringify(mergeFeatures(existing.features, plan.features)),
        existing.id,
      )
      .run();
  } else {
    lic = await createLicense(env, {
      app_id: plan.app_id,
      plan_id: plan.id,
      prefix: app.prefix,
      duration_mode: plan.duration_mode,
      duration_days: grantDays,
      max_devices: plan.max_devices,
      verify_limit: plan.verify_limit,
      features: JSON.parse(plan.features || '{}'),
      source: 'afdian',
      afdian_order_no: order.out_trade_no,
      buyer_id: order.user_id,
      note: order.remark || null,
      created_by: 'afdian',
    });
  }

  // 码一到手就立刻回写 license_id，不要拖到函数末尾。
  // 否则「码已创建、后续步骤抛错」的窗口里，爱发电重推会再发一枚（买家收到两枚有效码）。
  // 换发会继承 afdian_order_no，所以不能靠唯一索引兜底，只能靠这里提前落标记。
  await env.DB.prepare(
    'UPDATE orders SET plan_id = ?, license_id = ?, issue_type = ?, processed_at = ? WHERE out_trade_no = ?'
  )
    .bind(plan.id, lic.id, issueType, now(), order.out_trade_no)
    .run();

  const globalTpl = (await getMeta(env, 'msg_template', '')) || DEFAULT_MSG_TEMPLATE;
  const tpl = plan.msg_template || globalTpl;

  const expText =
    plan.duration_mode === 'lifetime'
      ? '永久有效'
      : lic.expires_at
        ? fmtTime(lic.expires_at)
        : `${plan.duration_days} 天（首次激活起算）`;

  let content = renderMsg(tpl, {
    key: lic.key,
    plan: plan.name,
    app: app.name,
    expires: expText,
    order: order.out_trade_no,
    amount: order.total_amount,
  });

  if (issueType === 'renew') {
    content =
      `【续期成功 +${renewedDays} 天】\n你的授权码保持不变，无需重新激活。\n\n` + content.replace(/^感谢你的支持！\n+/, '');
  }

  let queueId;
  try {
    const q = await env.DB.prepare(
      'INSERT INTO msg_queue (recipient, content, ref, state, attempts, created_at, updated_at) VALUES (?,?,?,?,0,?,?)'
    )
      .bind(order.user_id, content, order.out_trade_no, 'pending', t, t)
      .run();
    queueId = q.meta?.last_row_id;
  } catch (e) {
    // 码已创建（license_id 已回写），只是私信没入队。
    // 标成 failed 让它在管理台可见，可手工重发；不能静默停在 processing。
    await env.DB.prepare(
      "UPDATE orders SET delivery = 'failed', delivery_error = ? WHERE out_trade_no = ?"
    )
      .bind('私信入队失败：' + String(e.message || e).slice(0, 150), order.out_trade_no)
      .run();
    throw e;
  }

  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(tryDeliver(env, queueId, order.user_id, content, order.out_trade_no));
  }

  // 私信已入队 → 立刻把订单从 processing 推进到 pending。
  // 否则这段状态只能靠 tryDeliver 回调改写：一旦 ctx 缺失或 Worker 被回收，
  // 订单会永久停在 processing，管理台看不出「已发码但私信待投递」。
  // pending 也更语义化：msg_queue 里那条会由 cron 继续重试。
  await env.DB.prepare(
    "UPDATE orders SET delivery = 'pending' WHERE out_trade_no = ? AND delivery = 'processing'"
  )
    .bind(order.out_trade_no)
    .run();

  lic.__renewed = issueType === 'renew';
  return lic;
}

/** 发送一条私信，成功则标记已发 */
export async function tryDeliver(env, queueId, recipient, content, ref) {
  const r = await sendMsg(env, recipient, content);
  const t = now();

  if (r && r.ec === 200) {
    const stmts = [
      env.DB.prepare("UPDATE msg_queue SET state = 'sent', updated_at = ? WHERE id = ?").bind(t, queueId),
    ];
    // 不覆盖 manual 状态：手工发过的单，重发后仍应显示为「手工」，方便对账
    if (ref) {
      stmts.push(
        env.DB.prepare(
          "UPDATE orders SET delivery = 'sent' WHERE out_trade_no = ? AND delivery IN ('pending','failed')"
        ).bind(ref)
      );
    }
    await env.DB.batch(stmts);
    return true;
  }

  const err = String(r?.em || 'unknown').slice(0, 200);
  const stmts = [];
  if (isPermanentMsgError(r?.ec, r?.em)) {
    // 永久性失败（如对方没赞助过你、token 失效）：重试也没用，直接落地，不占重试额度
    stmts.push(
      env.DB.prepare(
        "UPDATE msg_queue SET state = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?"
      ).bind(`[永久失败] ${err}`, t, queueId)
    );
    if (ref) {
      stmts.push(
        env.DB.prepare(
          "UPDATE orders SET delivery = 'failed', delivery_error = ? WHERE out_trade_no = ? AND delivery IN ('pending','failed')"
        ).bind(`[永久失败] ${err}`, ref)
      );
    }
    await env.DB.batch(stmts);
    return false;
  }

  stmts.push(
    env.DB.prepare(
      "UPDATE msg_queue SET state = 'pending', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?"
    ).bind(err, t, queueId)
  );
  if (ref) {
    stmts.push(
      env.DB.prepare(
        "UPDATE orders SET delivery = 'failed', delivery_error = ? WHERE out_trade_no = ? AND delivery IN ('pending','failed')"
      ).bind(err, ref)
    );
  }
  await env.DB.batch(stmts);
  return false;
}
