// 限流档位配置
//
// 为什么做成档位而不是自由填数字：
//   1. 用户不知道「120 次/分钟」是宽松还是严格，给数字等于让他猜
//   2. 填小了立刻误伤所有用户，而且他不会马上知道
//   所以只提供三档，并在界面上直接列出每档的具体数值。
//
// 唯一的常量：坏 key 限流（bad key）不随档位变化。
// 它挡的是扫描器，正常人一分钟不会输错 20 次，放宽只会让刷接口更便宜。

import { getMeta, setMeta, todayStr } from './util.js';

export const PROFILES = {
  loose: {
    label: '宽松',
    desc: '用户多、或者用户在共享网络（公司/校园/移动网络）下时选这档',
    verify: 300, // /api/v1/verify 每 IP 每分钟
    status: 60, // /api/v1/status
    claim: 40, // /api/v1/claim 每 IP 每 10 分钟
    unbind: 20, // /api/v1/unbind 每 IP 每小时
    srv: 600, // /api/v1/server/check 每 IP 每分钟
  },
  normal: {
    label: '标准',
    desc: '默认档位，绝大多数情况用这个',
    verify: 120,
    status: 30,
    claim: 20,
    unbind: 10,
    srv: 300,
  },
  strict: {
    label: '严格',
    desc: '被刷过、或者用户量很少想收紧时选',
    verify: 60,
    status: 15,
    claim: 10,
    unbind: 5,
    srv: 150,
  },
};

// 固定不随档位变化的一项
export const BAD_KEY_LIMIT = 20;

export const DEFAULT_PROFILE = 'normal';

const CACHE_TTL = 60; // 配置缓存 60 秒 —— 改完最多 1 分钟生效，不必重启

let cache = { at: 0, profile: DEFAULT_PROFILE, limits: PROFILES[DEFAULT_PROFILE] };

/** 让缓存立即失效（管理台保存后调用） */
export function resetLimitCache() {
  cache = { at: 0, profile: DEFAULT_PROFILE, limits: PROFILES[DEFAULT_PROFILE] };
}

export function limitsOf(profile) {
  return PROFILES[profile] || PROFILES[DEFAULT_PROFILE];
}

/**
 * 取当前限流参数。
 * 命中内存缓存时零数据库读；冷启动时读一次 meta。
 */
export async function getLimits(env) {
  const t = Math.floor(Date.now() / 1000);
  if (cache.at && t - cache.at < CACHE_TTL) return cache.limits;

  let profile = DEFAULT_PROFILE;
  try {
    const v = await getMeta(env, 'rate_profile', DEFAULT_PROFILE);
    if (PROFILES[v]) profile = v;
  } catch {
    // 读不到就用默认，限流不能因为配置读失败就失效
  }

  cache = { at: t, profile, limits: PROFILES[profile] };
  return cache.limits;
}

/** 管理台展示用：当前档位 + 全部档位参数 */
export async function rateConfig(env) {
  const profile = await getMeta(env, 'rate_profile', DEFAULT_PROFILE).catch(() => DEFAULT_PROFILE);
  const cur = PROFILES[profile] ? profile : DEFAULT_PROFILE;
  return {
    profile: cur,
    presets: Object.entries(PROFILES).map(([id, p]) => ({ id, ...p })),
    bad_key_limit: BAD_KEY_LIMIT,
  };
}

// ---- 被限流拦截次数统计 ----
// 和额度计数同思路：内存累加、每 10 次落库一次，避免「统计本身把写额度吃掉」。

const FLUSH_EVERY = 10;
let mem = { day: '', n: 0 };

/** 每次拦截调用一次；不 await，失败也不影响主流程 */
export function noteBlocked(env, ctx) {
  const day = todayStr();
  if (mem.day !== day) mem = { day, n: 0 };
  mem.n++;

  if (mem.n % FLUSH_EVERY !== 0) return;

  const p = env.DB.prepare(
    `INSERT INTO meta (k, v) VALUES (?, '1')
     ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT)`
  )
    .bind('rl_blocked:' + day)
    .run()
    .catch(() => {});

  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
}

/** 今日被拦截次数（含尚未落库的内存部分） */
export async function blockedToday(env) {
  const day = todayStr();
  try {
    const row = await env.DB.prepare('SELECT v FROM meta WHERE k = ?').bind('rl_blocked:' + day).first();
    const stored = parseInt(row?.v || '0', 10) || 0;
    const pending = mem.day === day ? mem.n % FLUSH_EVERY : 0;
    return stored + pending;
  } catch {
    return mem.day === day ? mem.n : 0;
  }
}
