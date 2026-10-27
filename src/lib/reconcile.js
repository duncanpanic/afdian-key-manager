// 订单对账：与爱发电订单 API 比对，补齐 webhook 丢失的订单
// Cron 自动跑，管理台也可手动触发（用于「网络问题导致没发码」的补救）


import { queryOrders, isAfdianTestOrder } from './afdian.js';
import { processOrder } from '../routes/webhook.js';

const PAGE_SIZE = 50;

/**
 * 从第 1 页往前翻，直到「这一页的订单本地全都存在」或翻页上限。
 * 追平判断目前基于「本页该处理的订单是否都已存在」。
 * 注：`query-order` 其实**返回** create_time（见 docs/afdian-api-reference.md 第 494 行），
 * 只是 webhook 推送里可能没有。更稳的做法是改用 create_time 做时间游标，待后续优化。
 */
export async function reconcileOrders(env, ctx, { maxPages = 10, maxOrders = 40 } = {}) {
  let page = 1;
  let scanned = 0;
  let added = 0;
  let renewed = 0;
  let pages = 0;
  let truncated = false;
  let skipped = 0;

  outer: while (page <= maxPages) {
    const res = await queryOrders(env, { page });
    if (res.ec !== 200) {
      return { ok: false, error: res.em || 'query-order 调用失败', ec: res.ec, scanned, added, pages };
    }

    const list = res.data?.list || [];
    if (!list.length) break;
    pages++;
    scanned += list.length;

    // 一次查出本页哪些订单已在本地，避免逐条查库
    const nos = list.map((o) => o.out_trade_no).filter(Boolean);
    const ph = nos.map(() => '?').join(',');
    const existRows = await env.DB.prepare(
      `SELECT out_trade_no FROM orders WHERE out_trade_no IN (${ph})`
    )
      .bind(...nos)
      .all();
    const existSet = new Set((existRows.results || []).map((r) => r.out_trade_no));

    // 追平判断：只看「本页真正会落库的订单」是否有未处理的。
    // 原先比较「整页所有订单号」是否都已存在，但未支付订单（status≠2）和
    // 爱发电官方测试样本都会被跳过、不写 orders —— 只要页内有这样一条，
    // 等式永远不成立，于是每轮都会一路翻满 maxPages，白烧 API 与 D1 行读。
    const actionable = list.filter(
      (o) => o.out_trade_no && Number(o.status) === 2 && !isAfdianTestOrder(o),
    );
    if (actionable.length && actionable.every((o) => existSet.has(o.out_trade_no))) break;

    for (const o of list) {
      if (existSet.has(o.out_trade_no)) continue;
      if (Number(o.status) !== 2) continue; // 只处理支付成功的
      // 爱发电官方测试样本跳过，不能让它进发码流程
      if (isAfdianTestOrder(o)) {
        skipped++;
        continue;
      }

      // 单次最多补 40 单：每单要 6~8 次 D1 往返，再多容易撞上 Cron 的 CPU/时长上限
      if (added + renewed >= maxOrders) {
        truncated = true;
        break outer;
      }

      try {
        const lic = await processOrder(env, o, ctx);
        if (lic) {
          added++;
          if (lic.__renewed) renewed++;
        }
      } catch (e) {
        console.error('reconcile order failed', o.out_trade_no, e);
      }
    }

    const totalPage = Number(res.data?.total_page || 1);
    if (page >= totalPage) break;
    page++;
  }

  return { ok: true, scanned, added, renewed, pages, truncated, skipped };
}

/** Cron 调用：每 10 分钟一次，常态下只拉 1 页、命中即停，成本极低 */
export async function autoReconcile(env, ctx) {
  try {
    // ⚠️ 上限受 Worker 免费计划的「单次调用子请求数 = 50」硬约束。
    // D1 查询与 fetch 共用这 50 个额度。实测单笔补单要 ~13 次 D1 + 1 次 fetch，
    // 所以 40 单 = 520+ 子请求，会在第 51 个抛错 —— 且下面的 catch 会把它吞掉，
    // 管理台完全看不到异常，等于一单都没补。
    //
    // 按「队列 4 条 + 翻页 2 页」的余量倒推，补单上限取 2。
    // 积压多时会分多轮补完（幂等，不会重复发码），慢但不丢。
    return await reconcileOrders(env, ctx, { maxPages: 2, maxOrders: 2 });
  } catch (e) {
    console.error('reconcile failed', e);
    return { ok: false, error: String(e.message || e) };
  }
}

