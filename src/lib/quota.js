// 免费额度熔断
//
// 核心约束：无法从 Cloudflare 实时读取「今日已用请求数」，只能自己数。
// 但每次请求都写库会把 D1 写入额度（10 万/天）烧光，所以用「内存累加 + 每 500 次落库」。
// 精度损失可接受——我们只需要知道「大概到 70% / 92% / 97% 了」，不需要精确到个位。

import { now, utcDayStr } from './util.js';

const DAILY_LIMIT = 100000; // Workers 免费计划：10 万请求/天（账号级）
const FLUSH_EVERY = 500; // 每累计 500 次落库一次
const CACHE_TTL = 60; // 分级结果缓存 60 秒，避免每个请求都读库

const T1 = 0.7; // 70%：管理台开始限流
const T2 = 0.92; // 92%：公开 API 降级
const T3 = 0.97; // 97%：只保留 webhook

// 提为模块级常量：这些路径每请求都要比对，避免反复创建数组
const MUST_PASS = [
  '/admin/api/stats',
  '/admin/api/quota',
  '/admin/api/me',
  '/admin/api/authmode',
  '/admin/api/login',
];

// 允许时复用同一个对象，避免每个请求都分配
const ALLOW = Object.freeze({ allow: true });

// isolate 级内存状态
let mem = { day: '', count: 0, level: 0, at: 0, used: 0 };

export const LEVEL = {
  NORMAL: 0, // 全部放行
  TIGHT: 1, // 管理台限流
  CRITICAL: 2, // 公开 API 拒绝
  FLOOR: 3, // 仅 webhook
};

async function flush(env, ctx, day, n) {
  const p = env.DB.prepare(
    `INSERT INTO req_counter (day, count) VALUES (?, ?)
     ON CONFLICT(day) DO UPDATE SET count = count + excluded.count`
  )
    .bind(day, n)
    .run();
  if (ctx && ctx.waitUntil) ctx.waitUntil(p.catch(() => {}));
  else await p.catch(() => {});
}

/** 每个请求调用一次；返回当前额度等级 */
export async function trackRequest(env, ctx) {
  const day = utcDayStr();

  if (mem.day !== day) {
    mem = { day, count: 0, level: 0, at: 0, used: 0 };
  }

  mem.count++;
  if (mem.count >= FLUSH_EVERY) {
    const n = mem.count;
    mem.count = 0;
    flush(env, ctx, day, n);
  }

  const t = now();
  if (t - mem.at < CACHE_TTL && mem.at !== 0) return mem.level;

  try {
    const row = await env.DB.prepare('SELECT count FROM req_counter WHERE day = ?').bind(day).first();
    mem.used = (row?.count || 0) + mem.count;
  } catch {
    mem.used = mem.count;
  }
  mem.at = t;
  mem.level = levelOf(mem.used);
  return mem.level;
}

/** 读取当前用量（供管理台展示），不使用缓存，尽量准 */
export async function quotaStatus(env) {
  const day = utcDayStr();
  const row = await env.DB.prepare('SELECT count FROM req_counter WHERE day = ?').bind(day).first();
  const used = (row?.count || 0) + (mem.day === day ? mem.count : 0);
  return {
    day,
    used,
    limit: DAILY_LIMIT,
    percent: Math.min(100, Math.round((used / DAILY_LIMIT) * 1000) / 10),
    level: levelOf(used),
  };
}

function levelOf(used) {
  const r = used / DAILY_LIMIT;
  if (r >= T3) return LEVEL.FLOOR;
  if (r >= T2) return LEVEL.CRITICAL;
  if (r >= T1) return LEVEL.TIGHT;
  return LEVEL.NORMAL;
}

/**
 * 根据等级决定是否放行。
 * 优先级铁律：webhook 永不拦（丢单是收入损失），管理台最先牺牲。
 */
export function gate(level, path) {
  if (path.startsWith('/webhook/')) return ALLOW;

  if (path.startsWith('/admin/api')) {
    // 管理台在这些等级下仍允许查看状态，否则你没法知道发生了什么
    if (MUST_PASS.includes(path)) return ALLOW;
    if (level >= LEVEL.TIGHT) {
      return {
        allow: false,
        status: 503,
        body: { ok: false, code: 'QUOTA_TIGHT', message: '今日请求额度紧张，管理台已限流，北京时间 8 点（UTC 0 点）恢复' },
      };
    }
    return ALLOW;
  }

  if (path.startsWith('/api/')) {
    if (level >= LEVEL.CRITICAL) {
      return {
        allow: false,
        status: 503,
        body: {
          ok: false,
          code: 'SERVICE_BUSY',
          message: '激活服务当前繁忙，请稍后重试',
        },
      };
    }
  }

  return ALLOW;
}
