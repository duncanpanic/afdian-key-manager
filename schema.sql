-- ============================================================
-- 爱发电 Key 管理系统 - D1 数据库结构
-- 执行：wrangler d1 execute afdian_keys --remote --file=./schema.sql
-- ============================================================

-- 软件 / 产品线
CREATE TABLE IF NOT EXISTS apps (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,          -- API 侧标识，如 v6-pro
  prefix      TEXT NOT NULL,                 -- key 前缀，如 APP01
  server_key  TEXT,                          -- 服务端调用凭证（客户端永远拿不到）
  status      TEXT NOT NULL DEFAULT 'active',-- active | disabled
  note        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apps_skey ON apps (server_key);

-- 套餐（模板：生成 key 时的默认值，可逐张覆盖）
CREATE TABLE IF NOT EXISTS plans (
  id               TEXT PRIMARY KEY,
  app_id           TEXT NOT NULL,
  name             TEXT NOT NULL,
  duration_mode    TEXT NOT NULL DEFAULT 'from_activation', -- fixed | from_activation | lifetime
  duration_days    INTEGER NOT NULL DEFAULT 30,
  max_devices      INTEGER NOT NULL DEFAULT 1,
  verify_limit     INTEGER NOT NULL DEFAULT 100, -- 每 key 每日验证次数上限，0 = 不限
  features         TEXT NOT NULL DEFAULT '{}',
  afdian_plan_id   TEXT,                      -- 爱发电方案 ID（订阅型）
  afdian_sku_id    TEXT,                      -- 爱发电 SKU ID（售卖型）
  afdian_type      TEXT NOT NULL DEFAULT 'plan', -- plan=订阅方案 | sku=售卖商品
  msg_template     TEXT,                      -- 私信文案，为空则用全局模板
  status           TEXT NOT NULL DEFAULT 'active',
  note             TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_afdian ON plans (afdian_plan_id, afdian_sku_id);
CREATE INDEX IF NOT EXISTS idx_plans_app    ON plans (app_id);

-- Key 本体
CREATE TABLE IF NOT EXISTS licenses (
  id                  TEXT PRIMARY KEY,
  key                 TEXT NOT NULL UNIQUE,   -- 展示格式（带分隔符）
  key_norm            TEXT NOT NULL UNIQUE,   -- 归一化（无分隔符），查询与唯一约束用它
  app_id              TEXT NOT NULL,
  plan_id             TEXT,
  batch_id            TEXT,
  duration_mode       TEXT NOT NULL DEFAULT 'from_activation',
  duration_days       INTEGER,
  activated_at        INTEGER,                -- 首次激活时间（from_activation 起算点）
  expires_at          INTEGER,                -- 绝对到期时间；lifetime 为 NULL
  max_devices         INTEGER NOT NULL DEFAULT 1,
  verify_limit        INTEGER NOT NULL DEFAULT 100, -- 每 key 每日验证上限，0=不限
  verify_count        INTEGER NOT NULL DEFAULT 0,  -- 当日已验证次数
  verify_day          TEXT,                        -- 对应日期 YYYY-MM-DD
  features            TEXT NOT NULL DEFAULT '{}',
  status              TEXT NOT NULL DEFAULT 'active', -- active | banned | revoked
  source              TEXT NOT NULL DEFAULT 'manual', -- manual | afdian
  afdian_order_no     TEXT,
  buyer_id            TEXT,                   -- 爱发电 user_id
  buyer_name          TEXT,
  note                TEXT,
  created_by          TEXT,
  last_self_unbind_at INTEGER,                -- 自助解绑冷却判断
  created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lic_app     ON licenses (app_id, status);
CREATE INDEX IF NOT EXISTS idx_lic_plan    ON licenses (plan_id);
CREATE INDEX IF NOT EXISTS idx_lic_order   ON licenses (afdian_order_no);
CREATE INDEX IF NOT EXISTS idx_lic_batch   ON licenses (batch_id);
CREATE INDEX IF NOT EXISTS idx_lic_buyer   ON licenses (buyer_id);

-- 绑定设备
CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,
  license_id    TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  label         TEXT,
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  last_seen_day TEXT NOT NULL,               -- YYYY-MM-DD，跨天才写库，省 D1 写入额度
  last_ip       TEXT,                        -- 最近一次验证的来源 IP
  recent_ips    TEXT,                        -- JSON 数组，该设备用过的不同 IP（最多 5 个），超出即拒绝
  UNIQUE (license_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_dev_lic ON devices (license_id);

-- 爱发电订单
CREATE TABLE IF NOT EXISTS orders (
  out_trade_no     TEXT PRIMARY KEY,
  afdian_user_id   TEXT,
  afdian_user_name TEXT,
  plan_id          TEXT,                     -- 匹配到的本地套餐
  afdian_plan_id   TEXT,
  afdian_sku_id    TEXT,
  product_type     INTEGER,                  -- 0=赞助(订阅) 1=商品 2=捆绑 3=自选 4=售票
  title            TEXT,
  amount           TEXT,
  month            INTEGER,
  status           INTEGER,
  remark           TEXT,
  license_id       TEXT,
  archived_key     TEXT,                     -- 授权码被清理后留下的尾号掩码（如 ••••1234），供对账追溯
  issue_type       TEXT,                     -- new（新发） | renew（续期到已有 key）
  delivery         TEXT DEFAULT 'pending',   -- pending | sent | manual | unmatched | failed
  delivery_error   TEXT,
  raw              TEXT,
  created_at       INTEGER,
  processed_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ord_delivery ON orders (delivery);
CREATE INDEX IF NOT EXISTS idx_ord_user     ON orders (afdian_user_id);

-- 生成批次
CREATE TABLE IF NOT EXISTS batches (
  id         TEXT PRIMARY KEY,
  app_id     TEXT,
  plan_id    TEXT,
  prefix     TEXT,
  count      INTEGER,
  note       TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

-- 私信发送队列（爱发电限频 1000/h，失败在这里重试）
CREATE TABLE IF NOT EXISTS msg_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient  TEXT NOT NULL,
  content    TEXT NOT NULL,
  ref        TEXT,                            -- 关联订单号，回写 orders.delivery 用
  state      TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mq_state ON msg_queue (state, id);

-- 审计日志
CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  ip         TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs (created_at);

-- 全局配置 / 内部状态
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- 跨 isolate 的限流计数（内存 Map 在多 isolate 下不共享，防不住爆破与刷写）
-- id 形如 "login:1.2.3.4:3432812"（key + 固定窗口编号），窗口滚动即自然重置
CREATE TABLE IF NOT EXISTS rate_limits (
  id          TEXT PRIMARY KEY,
  count       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rl_created ON rate_limits (created_at);

-- 爱发电方案/商品快照
-- 用途：从爱发电一键拉取自己上架的所有方案，避免手工抄 32 位 plan_id 抄错。
-- 数据源是爱发电网页前端的接口 /api/creator/get-plans（非开放平台），
-- 字段可能随前端改版变化，所以整条原始 JSON 也存一份备查。
CREATE TABLE IF NOT EXISTS afdian_plans (
  plan_id       TEXT PRIMARY KEY,
  name          TEXT,
  product_type  INTEGER,                  -- 0 = 赞助/订阅，1 = 商品/售卖
  price         TEXT,
  status        INTEGER,                  -- 1 = 上架中
  pay_month     INTEGER,                  -- 订阅周期（月）
  sku_json      TEXT,                     -- 商品型的型号列表（若接口返回）
  raw           TEXT,                     -- 原始 JSON，字段变了也能回头查
  synced_at     INTEGER NOT NULL,
  linked_plan   TEXT                      -- 已关联的本地套餐 id（为空表示还没建）
);

-- 每日请求计数（用于免费额度熔断）
CREATE TABLE IF NOT EXISTS req_counter (
  day   TEXT PRIMARY KEY,                      -- YYYY-MM-DD（北京时间）
  count INTEGER NOT NULL DEFAULT 0
);

-- ============ 2026-10-27 性能审计补充索引 ============
-- 依据：去掉这些索引时，以下查询会全表扫（数据量涨到万级后直接吃满 D1 行读额度）

-- claim / 重发私信按 ref 查队列（公开接口，可被外部触发）
-- 原来每次全表扫 30 天全部队列行
CREATE INDEX IF NOT EXISTS idx_mq_ref ON msg_queue (ref, id DESC);

-- 授权码列表 / 概览「今日新增」都按 created_at 排序或过滤
CREATE INDEX IF NOT EXISTS idx_lic_created ON licenses (created_at DESC);

-- 订单列表按 created_at 排序；每日归档 UPDATE 按 license_id 定位
CREATE INDEX IF NOT EXISTS idx_ord_created ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ord_license ON orders (license_id);

-- 每日清理：WHERE expires_at < ? —— 无索引时每天全扫 licenses
CREATE INDEX IF NOT EXISTS idx_lic_expires ON licenses (expires_at);

-- 续期查找：app_id + buyer_id + plan_id
CREATE INDEX IF NOT EXISTS idx_lic_renew ON licenses (buyer_id, plan_id, app_id, created_at DESC);
