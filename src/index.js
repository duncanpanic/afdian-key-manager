// 入口：路由分发 + 定时任务

import { json, now, getMeta, setMeta, utcDayStr } from './lib/util.js';
import {
  handleVerify,
  handleStatus,
  handleUnbind,
  handleClaim,
  handlePubkey,
  handleServerCheck,
  corsPreflight,
} from './routes/verify.js';
import { handleAfdianWebhook, tryDeliver } from './routes/webhook.js';
import { handleAdmin } from './routes/admin.js';
import { autoReconcile } from './lib/reconcile.js';
import { trackRequest, gate } from './lib/quota.js';

/**
 * 清理「自然过期满 30 天」的授权码（抽成独立函数便于测试）。
 *
 *   · 只清 status='active' 的自然过期码；revoked/banned 是人工封禁，保留可追溯
 *   · lifetime 永不删除
 *   · 删除前把码的尾号写回订单（archived_key），订单永久保留，客户来问时还能对上号
 *   · devices 没有外键，必须手动一起删，否则留孤儿行
 *   · 每轮最多 200 枚，避免一次性 batch 过大撞上 CPU/时长上限
 */
export async function cleanupExpiredLicenses(env, t = now()) {
  const cutoff = t - 30 * 86400;
  const EXPIRED = `status = 'active' AND duration_mode <> 'lifetime'
                    AND expires_at IS NOT NULL AND expires_at < ?`;
  const cap = `(SELECT id FROM licenses WHERE ${EXPIRED} ORDER BY expires_at LIMIT 200)`;

  const archived = await env.DB.prepare(
    `UPDATE orders
        SET archived_key = (
          SELECT '••••' || substr(replace(l.key, '-', ''), -4)
            FROM licenses l WHERE l.id = orders.license_id
        )
      WHERE license_id IN ${cap}`
  )
    .bind(cutoff)
    .run();

  const delDev = await env.DB.prepare(`DELETE FROM devices WHERE license_id IN ${cap}`).bind(cutoff).run();
  const delLic = await env.DB.prepare(`DELETE FROM licenses WHERE id IN ${cap}`).bind(cutoff).run();

  return {
    licenses: delLic.meta?.changes || 0,
    devices: delDev.meta?.changes || 0,
    orders: archived.meta?.changes || 0,
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') return corsPreflight();

    // ---- 免费额度熔断（webhook 永不拦截）----
    const level = await trackRequest(env, ctx);
    const g = gate(level, path);
    if (!g.allow) return json(g.body, g.status);

    // ---- 爱发电回调 ----
    if (path === '/webhook/afdian') {
      if (method !== 'POST') return json({ ec: 405, em: 'method not allowed' }, 405);
      return handleAfdianWebhook(request, env, ctx);
    }

    // ---- 公开 API ----
    if (path.startsWith('/api/v1/')) {
      const sub = path.slice(8);
      try {
        if (sub === 'verify' && method === 'POST') return await handleVerify(request, env);
        if (sub === 'status' && (method === 'POST' || method === 'GET')) return await handleStatus(request, env);
        if (sub === 'unbind' && method === 'POST') return await handleUnbind(request, env);
        if (sub === 'claim' && (method === 'POST' || method === 'GET')) return await handleClaim(request, env, ctx);
        if (sub === 'pubkey' && method === 'GET') return await handlePubkey(env);
        if (sub === 'server/check' && method === 'POST') return await handleServerCheck(request, env);
      } catch (e) {
        return json({ ok: false, code: 'SERVER_ERROR', message: String(e.message || e) }, 500);
      }
      return json({ ok: false, code: 'NOT_FOUND', message: '接口不存在' }, 404);
    }

    // ---- 管理后台 API ----
    if (path === '/admin/api' || path.startsWith('/admin/api/')) {
      return handleAdmin(request, env, ctx, url);
    }

    // ---- 静态资源（SPA） ----
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    // 1) 私信队列重试：网络抖动/限频导致的未送达，在这里自动补
    try {
      const rows = await env.DB.prepare(
        "SELECT * FROM msg_queue WHERE state = 'pending' AND attempts < 5 AND updated_at < ? ORDER BY id LIMIT 4"
      )
        .bind(now() - 60)
        .all();
      for (const r of rows.results || []) {
        await tryDeliver(env, r.id, r.recipient, r.content, r.ref);
      }
    } catch (e) {
      console.error('queue retry failed', e);
    }

    // 1b) 重试耗尽的死信必须落地。
    // 否则 attempts>=5 的行既不再重试（上面 attempts<5）、也不被清理（只删 sent/failed）、
    // 管理台统计也看不见（计数同样过滤 attempts<5）—— 买家永远收不到码却无人知晓。
    try {
      const dead = await env.DB.prepare(
        "UPDATE msg_queue SET state = 'failed', updated_at = ? WHERE state = 'pending' AND attempts >= 5"
      )
        .bind(now())
        .run();
      if (dead.meta?.changes) console.log(`queue: ${dead.meta.changes} dead letters marked failed`);
    } catch (e) {
      console.error('queue dead-letter sweep failed', e);
    }

    // 2) 与爱发电对账：webhook 完全没收到时靠这里补单
    //    常态只拉 1 页、命中即停，成本 = 1 次 API + 1 次 D1 读
    const r = await autoReconcile(env, ctx);
    if (!r.ok) console.error('reconcile failed:', r.error);
    else if (r.added) console.log(`reconcile: scanned=${r.scanned} added=${r.added}`);

    // 3) 每天清理一次历史数据，避免表无限增长拖慢查询
    try {
      const lastClean = Number((await getMeta(env, 'last_cleanup', '0')) || 0);
      if (now() - lastClean >= 86400) {
        await setMeta(env, 'last_cleanup', now());
        const t30 = now() - 30 * 86400;
        const t90 = now() - 90 * 86400;
        await env.DB.batch([
          env.DB.prepare("DELETE FROM msg_queue WHERE state IN ('sent','failed') AND updated_at < ?").bind(t30),
          env.DB.prepare('DELETE FROM audit_logs WHERE created_at < ?').bind(t90),
          env.DB.prepare('DELETE FROM req_counter WHERE day < ?').bind(utcDayStr(t30)),
          // 限流计数窗口很短（分钟级），7 天前的记录一定已无用
          env.DB.prepare('DELETE FROM rate_limits WHERE created_at < ?').bind(now() - 7 * 86400),
        ]);

        // 3b) 清理「自然过期满 30 天」的授权码
        try {
          const c = await cleanupExpiredLicenses(env);
          if (c.licenses) {
            console.log(
              `cleanup: 清理过期码 ${c.licenses} 枚（设备 ${c.devices} 台，归档订单 ${c.orders} 条）`
            );
          }
        } catch (e) {
          console.error('license cleanup failed', e);
        }
      }
    } catch (e) {
      console.error('cleanup failed', e);
    }
  },
};
