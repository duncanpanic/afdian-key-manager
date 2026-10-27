// 端到端测试：用 node:sqlite 模拟 D1，跑真实 SQL 与真实业务函数
// 运行：node tests/run.mjs
//
// 覆盖：Key 生成/校验、发码、首激活、续费、换发、服务端校验、额度熔断、对账翻页

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const failures = [];

function t(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}  ${extra}`);
  }
}

// ---------------- D1 兼容层 ----------------

function makeEnv(sqlOverride) {
  const db = new DatabaseSync(':memory:');
  db.exec(sqlOverride || readFileSync(join(ROOT, 'schema.sql'), 'utf8'));

  const prepare = (sql) => {
    const stmt = db.prepare(sql);
    const wrap = (args) => ({
      run: async () => {
        const r = stmt.run(...args);
        return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
      },
      first: async () => stmt.get(...args) ?? null,
      all: async () => ({ results: stmt.all(...args) }),
    });
    return {
      bind: (...a) => wrap(a),
      run: () => wrap([]).run(),
      first: () => wrap([]).first(),
      all: () => wrap([]).all(),
    };
  };

  return {
    DB: {
      prepare,
      batch: async (list) => {
        for (const s of list) await s.run();
        return [];
      },
    },
    AFDIAN_USER_ID: 'uid_test',
    AFDIAN_TOKEN: 'tok_test',
    SELF_UNBIND_COOLDOWN_DAYS: '30',
    LICENSE_PRIVATE_KEY: '',
  };
}

const waitCtx = () => {
  const q = [];
  return { waitUntil: (p) => q.push(Promise.resolve(p).catch(() => {})), drain: () => Promise.all(q) };
};

// ---------------- 1. Key 生成与校验 ----------------

console.log('\n[1] Key 生成与校验');
{
  const { generateKey, checkKeyFormat, normKey, formatKey } = await import('../src/lib/keygen.js');

  const k = generateKey('APP01', 20);
  t('格式为 前缀+5组4位+校验位', /^APP01(-[0-9A-Z]{4}){5}-[0-9A-Z]$/.test(k), k);
  t('自带校验位可通过', checkKeyFormat(k).valid);
  t('小写与空格容错', checkKeyFormat(' ' + k.toLowerCase() + ' ').valid);

  const raw = k.replace(/-/g, '');
  const i = raw.length - 3;
  const tampered = raw.slice(0, i) + (raw[i] === 'A' ? 'B' : 'A') + raw.slice(i + 1);
  t('篡改一位可检出', checkKeyFormat(tampered).valid === false);

  const set = new Set();
  for (let n = 0; n < 5000; n++) set.add(generateKey('T', 20));
  t('5000 次生成无重复', set.size === 5000);

  t('normKey 去掉分隔符', normKey(k) === k.replace(/-/g, ''));

  for (const p of ['A', 'AB', 'ABCDE', 'ABCDEFGH']) {
    t(`前缀长度 ${p} 仍可校验`, checkKeyFormat(formatKey(p, 'ABCDEFGHJKMNPQRSTVWX')).valid);
  }
}

// ---------------- 2. 发码 / 激活 / 续费 ----------------

console.log('\n[2] 发码、首激活、续费');
{
  const env = makeEnv();
  const { createLicense, effectiveStatus, activateIfNeeded, extendLicense } = await import(
    '../src/lib/license.js'
  );

  await env.DB.prepare(
    "INSERT INTO apps (id,name,slug,prefix,status,created_at) VALUES ('app1','测试','test','TEST','active',0)"
  ).run();

  const lic = await createLicense(env, {
    app_id: 'app1',
    prefix: 'TEST',
    duration_mode: 'from_activation',
    duration_days: 30,
    max_devices: 2,
    features: { pro: true },
    source: 'afdian',
    afdian_order_no: 'ORD1',
    buyer_id: 'BUYER_A',
  });
  const row = await env.DB.prepare('SELECT * FROM licenses WHERE id=?').bind(lic.id).first();

  t('key_norm 与 key 一致（去分隔符）', row.key_norm === row.key.replace(/-/g, ''));
  t('verify_limit 默认 100', row.verify_limit === 100, String(row.verify_limit));
  t('未激活时 expires_at 为空', row.expires_at === null);
  t('新 key 状态 active', effectiveStatus(row) === 'active');

  const act = activateIfNeeded(row);
  const days = Math.round((act.lic.expires_at - act.lic.activated_at) / 86400);
  t('首激活按 30 天计时', days === 30, `${days} 天`);

  await env.DB.prepare('UPDATE licenses SET activated_at=?, expires_at=? WHERE id=?')
    .bind(act.lic.activated_at, act.lic.expires_at, row.id)
    .run();

  const b1 = (await env.DB.prepare('SELECT expires_at FROM licenses WHERE id=?').bind(row.id).first()).expires_at;
  await extendLicense(env, act.lic, 30);
  const b2 = (await env.DB.prepare('SELECT expires_at FROM licenses WHERE id=?').bind(row.id).first()).expires_at;
  t('续期精确 +30 天', Math.round((b2 - b1) / 86400) === 30);

  const t0 = Math.floor(Date.now() / 1000);
  t('过期判定', effectiveStatus({ ...row, duration_mode: 'fixed', expires_at: t0 - 10 }) === 'expired');
  t('永久授权不过期', effectiveStatus({ ...row, duration_mode: 'lifetime', expires_at: null }) === 'active');
  t('封禁优先于过期', effectiveStatus({ ...row, status: 'banned' }) === 'banned');
}

// ---------------- 3. 换发 ----------------

console.log('\n[3] 换发（reissue）');
{
  const env = makeEnv();
  const { createLicense, reissueLicense } = await import('../src/lib/license.js');

  await env.DB.prepare(
    "INSERT INTO apps (id,name,slug,prefix,status,created_at) VALUES ('app1','测试','test','TEST','active',0)"
  ).run();

  const lic = await createLicense(env, {
    app_id: 'app1',
    prefix: 'TEST',
    duration_mode: 'fixed',
    duration_days: 30,
    max_devices: 3,
    verify_limit: 50,
    features: { pro: true, export: false },
    note: '原备注',
    buyer_id: 'BUYER_X',
  });

  // 给旧 key 绑一台设备
  await env.DB.prepare(
    'INSERT INTO devices (id,license_id,fingerprint,label,first_seen,last_seen,last_seen_day) VALUES (?,?,?,?,?,?,?)'
  )
    .bind('dev1', lic.id, 'fp_old', '旧电脑', 1, 1, '2026-10-01')
    .run();

  const old = await env.DB.prepare('SELECT * FROM licenses WHERE id=?').bind(lic.id).first();
  const r = await reissueLicense(env, old, 'TEST', 'tester');
  const nu = await env.DB.prepare('SELECT * FROM licenses WHERE id=?').bind(r.id).first();
  const oldAfter = await env.DB.prepare('SELECT * FROM licenses WHERE id=?').bind(lic.id).first();
  const devs = await env.DB.prepare('SELECT * FROM devices WHERE license_id=?').bind(r.id).all();

  t('返回新 key 且与原 key 不同', r.key !== old.key);
  t('新 key 格式合法', /^TEST(-[0-9A-Z]{4}){5}-[0-9A-Z]$/.test(r.key), r.key);
  t('旧 key 已吊销', oldAfter.status === 'revoked');
  t('旧 key 备注记录换发去向', String(oldAfter.note).includes('已换发为'));
  t('新 key 状态 active', nu.status === 'active');
  t('继承到期时间', nu.expires_at === old.expires_at, `${nu.expires_at}`);
  t('继承激活时间', nu.activated_at === old.activated_at);
  t('继承设备上限', nu.max_devices === 3);
  t('继承验证上限', nu.verify_limit === 50);
  t('继承功能位', nu.features === old.features);
  t('继承买家 ID', nu.buyer_id === 'BUYER_X');
  t('新 key 无绑定设备', (devs.results || []).length === 0);
  t('旧 key 设备仍在（存档）', (await env.DB.prepare('SELECT COUNT(*) c FROM devices WHERE license_id=?').bind(lic.id).first()).c === 1);
}

// ---------------- 4. 服务端校验 ----------------

console.log('\n[4] 服务端校验 /api/v1/server/check');
{
  const env = makeEnv();
  const { createLicense } = await import('../src/lib/license.js');
  const { handleServerCheck } = await import('../src/routes/verify.js');

  await env.DB.prepare(
    "INSERT INTO apps (id,name,slug,prefix,server_key,status,created_at) VALUES ('app1','测试','test','TEST','sk_ok','active',0)"
  ).run();
  await env.DB.prepare(
    "INSERT INTO apps (id,name,slug,prefix,server_key,status,created_at) VALUES ('app2','别的','other','OTHR','sk_other','active',0)"
  ).run();

  const lic = await createLicense(env, {
    app_id: 'app1',
    prefix: 'TEST',
    duration_mode: 'lifetime',
  });

  const call = async (key, sk) => {
    const req = new Request('https://x/api/v1/server/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(sk ? { authorization: 'Bearer ' + sk } : {}) },
      body: JSON.stringify({ key }),
    });
    return (await handleServerCheck(req, env)).json();
  };

  t('无凭证 → 401', (await call(lic.key, null)).code === 'UNAUTHORIZED');
  t('错误凭证 → 401', (await call(lic.key, 'sk_bad')).code === 'UNAUTHORIZED');
  t('正确凭证 + 正确 key → OK', (await call(lic.key, 'sk_ok')).code === 'OK');

  const other = await call(lic.key, 'sk_other');
  t('key 属于别的软件 → APP_MISMATCH', other.code === 'APP_MISMATCH');

  const bad = await call('TEST-AAAA-BBBB-CCCC-DDDD-EEEE-F', 'sk_ok');
  t('格式错误的 key → INVALID_KEY', bad.code === 'INVALID_KEY');

  await env.DB.prepare("UPDATE licenses SET status='banned' WHERE id=?").bind(lic.id).run();
  t('封禁后 → BANNED', (await call(lic.key, 'sk_ok')).code === 'BANNED');

  await env.DB.prepare("UPDATE licenses SET status='active', duration_mode='fixed', expires_at=1 WHERE id=?")
    .bind(lic.id)
    .run();
  t('过期后 → EXPIRED', (await call(lic.key, 'sk_ok')).code === 'EXPIRED');
}

// ---------------- 5. 额度熔断 ----------------

console.log('\n[5] 额度熔断');
{
  const { gate, trackRequest, quotaStatus, LEVEL } = await import('../src/lib/quota.js');

  t('正常等级：webhook 放行', gate(LEVEL.NORMAL, '/webhook/afdian').allow);
  t('满额：webhook 仍放行', gate(LEVEL.FLOOR, '/webhook/afdian').allow);
  t('满额：verify 拒绝', gate(LEVEL.FLOOR, '/api/v1/verify').allow === false);
  t('满额：verify 返回 SERVICE_BUSY', gate(LEVEL.FLOOR, '/api/v1/verify').body.code === 'SERVICE_BUSY');
  t('紧张：管理台列表拒绝', gate(LEVEL.TIGHT, '/admin/api/licenses').allow === false);
  t('紧张：stats 仍放行', gate(LEVEL.TIGHT, '/admin/api/stats').allow);
  t('紧张：验证接口仍放行', gate(LEVEL.TIGHT, '/api/v1/verify').allow);
  t('危急：验证接口拒绝', gate(LEVEL.CRITICAL, '/api/v1/verify').allow === false);

  const env = makeEnv();
  const ctx = waitCtx();
  for (let i = 0; i < 600; i++) await trackRequest(env, ctx);
  await ctx.drain();
  const row = await env.DB.prepare('SELECT count FROM req_counter').first();
  t('累计 600 次后已落库 500', row && row.count === 500, `count=${row?.count}`);

  const st = await quotaStatus(env);
  t('quotaStatus 统计包含内存余量', st.used >= 500 && st.used <= 600, `used=${st.used}`);
  t('百分比计算正确', st.percent >= 0 && st.percent <= 100);
}

// ---------------- 6. 对账翻页 ----------------

console.log('\n[6] 对账翻页与幂等');
{
  const env = makeEnv();
  const { reconcileOrders } = await import('../src/lib/reconcile.js');

  await env.DB.prepare(
    "INSERT INTO apps (id,name,slug,prefix,status,created_at) VALUES ('app1','测试','test','TEST','active',0)"
  ).run();
  await env.DB.prepare(
    `INSERT INTO plans (id,app_id,name,duration_mode,duration_days,max_devices,verify_limit,features,
      afdian_plan_id,status,created_at) VALUES ('plan1','app1','月卡','from_activation',30,1,100,'{}','AFD_P1','active',0)`
  ).run();

  const PAGE1 = [
    { out_trade_no: 'A1', user_id: 'U1', plan_id: 'AFD_P1', total_amount: '10', status: 2, month: 1 },
    { out_trade_no: 'A2', user_id: 'U2', plan_id: 'AFD_P1', total_amount: '10', status: 2, month: 1 },
  ];
  const PAGE2 = [{ out_trade_no: 'A3', user_id: 'U3', plan_id: 'AFD_P1', total_amount: '10', status: 2, month: 1 }];

  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    const page = JSON.parse(JSON.parse(init.body).params).page;
    const list = page === 1 ? PAGE1 : page === 2 ? PAGE2 : [];
    return new Response(JSON.stringify({ ec: 200, em: '', data: { list, total_page: 5, total_count: 3 } }), {
      headers: { 'content-type': 'application/json' },
    });
  };

  const r1 = await reconcileOrders(env, null, { maxPages: 5 });
  t('首次拉取补发 3 单', r1.ok && r1.added === 3, `added=${r1.added} pages=${r1.pages}`);
  t('翻到第 2 页才停（第 2 页有新增）', r1.pages === 2, `pages=${r1.pages}`);

  const c1 = (await env.DB.prepare('SELECT COUNT(*) c FROM orders').first()).c;
  t('订单表写入 3 条', c1 === 3, String(c1));

  const callsBefore = calls;
  const r2 = await reconcileOrders(env, null, { maxPages: 5 });
  t('再次对账不重复发码', r2.added === 0, `added=${r2.added}`);
  t('整页已存在即停止，只请求 1 页', calls - callsBefore === 1, `多请求 ${calls - callsBefore} 次`);

  const c2 = (await env.DB.prepare('SELECT COUNT(*) c FROM licenses').first()).c;
  t('授权码总数仍为 3', c2 === 3, String(c2));
}

// ---------------- 7. 本轮修复项 ----------------

console.log('\n[7] 修复项回归');
{
  const env = makeEnv();
  const { processOrder, issueAndQueue } = await import('../src/routes/webhook.js');
  const { handlePubkey } = await import('../src/routes/verify.js');
  const { generateKeyPairSync } = await import('node:crypto');

  await env.DB.prepare(
    "INSERT INTO apps (id,name,slug,prefix,server_key,status,created_at) VALUES ('app1','测试','test','TEST','sk_1','active',0)"
  ).run();
  await env.DB.prepare(
    `INSERT INTO plans (id,app_id,name,duration_mode,duration_days,max_devices,verify_limit,features,
      afdian_plan_id,status,created_at) VALUES ('plan1','app1','月卡','from_activation',30,1,100,'{}','AFD','active',0)`
  ).run();

  // 7.1 同一买家两次下单 → 第二次续期到同一 key
  const o1 = { out_trade_no: 'X1', user_id: 'U1', plan_id: 'AFD', total_amount: '10', status: 2, month: 1 };
  const l1 = await processOrder(env, o1, null);
  const o2 = { out_trade_no: 'X2', user_id: 'U1', plan_id: 'AFD', total_amount: '10', status: 2, month: 1 };
  const l2 = await processOrder(env, o2, null);

  t('同买家第二次下单复用同一 key', l1.key === l2.key, l1.key);
  t('第二单标记为续费', l2.__renewed === true);
  const ord2 = await env.DB.prepare("SELECT issue_type FROM orders WHERE out_trade_no='X2'").first();
  t('订单记录 issue_type=renew', ord2.issue_type === 'renew');

  // 7.2 forceNew 强制新发
  await env.DB.prepare(
    "INSERT INTO orders (out_trade_no, afdian_user_id, status, created_at) VALUES ('X3','U1',2,0)"
  ).run();
  const plan = await env.DB.prepare("SELECT * FROM plans WHERE id='plan1'").first();
  const l3 = await issueAndQueue(env, { out_trade_no: 'X3', user_id: 'U1', total_amount: '10' }, plan, null, {
    forceNew: true,
  });
  t('forceNew 生成新 key', l3.key !== l1.key, l3.key);
  t('forceNew 后旧 key 仍有效', (await env.DB.prepare('SELECT status FROM licenses WHERE id=?').bind(l1.id).first()).status === 'active');

  // 7.3 pubkey 带长缓存头
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  env.LICENSE_PRIVATE_KEY = privateKey;
  const pkRes = await handlePubkey(env);
  const cc = pkRes.headers.get('cache-control') || '';
  t('pubkey 带 max-age 缓存', cc.includes('max-age=86400'), cc);
  t('pubkey 已不再 no-store', !cc.includes('no-store'));

  // 7.4 重发不覆盖 manual 状态
  const { tryDeliver } = await import('../src/routes/webhook.js');
  await env.DB.prepare(
    "INSERT INTO orders (out_trade_no, afdian_user_id, status, delivery, license_id, created_at) VALUES ('M1','U1',2,'manual',?,0)"
  )
    .bind(l1.id)
    .run();
  const mq = await env.DB.prepare(
    "INSERT INTO msg_queue (recipient,content,ref,state,attempts,created_at,updated_at) VALUES ('U1','hi','M1','pending',0,0,0)"
  ).run();
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ec: 200, em: '' }), { headers: { 'content-type': 'application/json' } });
  await tryDeliver(env, mq.meta.last_row_id, 'U1', 'hi', 'M1');
  globalThis.fetch = origFetch;
  const m1 = await env.DB.prepare("SELECT delivery FROM orders WHERE out_trade_no='M1'").first();
  t('重发后 manual 状态不被覆盖', m1.delivery === 'manual', m1.delivery);
}

// ---------------- 8. 赞助 / 商品 两种售卖形态 ----------------

console.log('\n[8] 赞助与商品的匹配隔离');
{
  const env = makeEnv();
  const { processOrder } = await import('../src/routes/webhook.js');

  await env.DB.prepare(
    "INSERT INTO apps (id,name,slug,prefix,server_key,status,created_at) VALUES ('app1','测试','test','TEST','sk','active',0)"
  ).run();

  // 订阅方案
  await env.DB.prepare(
    `INSERT INTO plans (id,app_id,name,duration_mode,duration_days,max_devices,verify_limit,features,
      afdian_plan_id,afdian_sku_id,afdian_type,status,created_at)
     VALUES ('p_sub','app1','订阅月卡','from_activation',30,1,100,'{}','AFD_SUB',NULL,'plan','active',0)`
  ).run();

  // 售卖型商品
  await env.DB.prepare(
    `INSERT INTO plans (id,app_id,name,duration_mode,duration_days,max_devices,verify_limit,features,
      afdian_plan_id,afdian_sku_id,afdian_type,status,created_at)
     VALUES ('p_goods','app1','商品永久版','lifetime',30,2,100,'{}',NULL,'SKU_GOODS','sku','active',0)`
  ).run();

  // 8.1 纯订阅订单（无 sku_detail）
  await processOrder(
    env,
    { out_trade_no: 'S1', user_id: 'U1', plan_id: 'AFD_SUB', total_amount: '9.9', status: 2, month: 1, product_type: 0 },
    null
  );
  const o1 = await env.DB.prepare("SELECT * FROM orders WHERE out_trade_no='S1'").first();
  t('订阅订单匹配到订阅套餐', o1.plan_id === 'p_sub', String(o1.plan_id));
  t('订单记录 product_type=0', o1.product_type === 0);

  // 8.2 商品订单（带 sku_id）
  await processOrder(
    env,
    {
      out_trade_no: 'S2',
      user_id: 'U2',
      plan_id: '',
      total_amount: '199',
      status: 2,
      product_type: 1,
      sku_detail: [{ sku_id: 'SKU_GOODS', count: 1, name: '永久版' }],
    },
    null
  );
  const o2 = await env.DB.prepare("SELECT * FROM orders WHERE out_trade_no='S2'").first();
  t('商品订单匹配到商品套餐', o2.plan_id === 'p_goods', String(o2.plan_id));
  t('商品订单记录 product_type=1', o2.product_type === 1);

  // 8.3 订阅套餐不会被 sku 误匹配（p_sub 的 afdian_sku_id 为 NULL）
  const wrong = await env.DB.prepare('SELECT * FROM plans WHERE afdian_sku_id = ?').bind('AFD_SUB').first();
  t('订阅 ID 不会跨类型命中商品套餐', wrong === null);

  // 8.4 多型号订单留警告
  await processOrder(
    env,
    {
      out_trade_no: 'S3',
      user_id: 'U3',
      plan_id: '',
      total_amount: '299',
      status: 2,
      product_type: 2,
      sku_detail: [
        { sku_id: 'SKU_GOODS', count: 1, name: 'A' },
        { sku_id: 'SKU_OTHER', count: 1, name: 'B' },
      ],
    },
    null
  );
  const o3 = await env.DB.prepare("SELECT * FROM orders WHERE out_trade_no='S3'").first();
  t('多型号订单记录警告', String(o3.delivery_error || '').includes('多型号'), o3.delivery_error || '');
  t('多型号仍按第一个型号发码', o3.plan_id === 'p_goods', String(o3.plan_id));
}

// ---------------- 9. 验证接口主流程（重构后回归） ----------------

console.log('\n[9] /api/v1/verify 主流程');
{
  const env = makeEnv();
  const { createLicense } = await import('../src/lib/license.js');
  const { handleVerify } = await import('../src/routes/verify.js');
  const { generateKeyPairSync } = await import('node:crypto');

  // 签发令牌需要私钥
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  env.LICENSE_PRIVATE_KEY = privateKey;

  await env.DB.prepare(
    "INSERT INTO apps (id,name,slug,prefix,server_key,status,created_at) VALUES ('app1','测试','test','TEST','sk','active',0)"
  ).run();

  const call = async (key, fp, app) => {
    const req = new Request('https://x/api/v1/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, fingerprint: fp, app }),
    });
    return (await handleVerify(req, env)).json();
  };

  // 9.1 首次验证：激活 + 绑设备 + 发令牌
  const lic = await createLicense(env, {
    app_id: 'app1',
    prefix: 'TEST',
    duration_mode: 'from_activation',
    duration_days: 30,
    max_devices: 1,
    verify_limit: 2,
    features: { pro: true },
  });

  const r1 = await call(lic.key, 'fpA', 'test');
  t('首次验证成功', r1.ok === true && r1.code === 'OK');
  t('返回令牌', typeof r1.token === 'string' && r1.token.split('.').length === 3);
  t('激活时间已写入', !!r1.license.activated_at);
  const d = Math.round((r1.license.expires_at - r1.license.activated_at) / 86400);
  t('到期时间 = 激活 + 30 天', d === 30, `${d} 天`);

  const dev = await env.DB.prepare('SELECT COUNT(*) c FROM devices WHERE license_id=?').bind(lic.id).first();
  t('首次验证自动绑 1 台设备', dev.c === 1);

  // 9.2 同设备第二次：不重复绑
  const r2 = await call(lic.key, 'fpA', 'test');
  t('同设备再次验证成功', r2.ok === true);
  const dev2 = await env.DB.prepare('SELECT COUNT(*) c FROM devices WHERE license_id=?').bind(lic.id).first();
  t('不会重复绑定同一设备', dev2.c === 1);

  // 9.3 设备超限（且不消耗验证次数）
  const before = await env.DB.prepare('SELECT verify_count FROM licenses WHERE id=?').bind(lic.id).first();
  const r3 = await call(lic.key, 'fpB', 'test');
  t('第二台设备被拒', r3.code === 'DEVICE_LIMIT', r3.code);
  const after = await env.DB.prepare('SELECT verify_count FROM licenses WHERE id=?').bind(lic.id).first();
  t('设备超限不消耗验证次数', after.verify_count === before.verify_count, `${before.verify_count}→${after.verify_count}`);

  // 9.4 第三次同设备：已达 verify_limit=2
  const r4 = await call(lic.key, 'fpA', 'test');
  t('超过每日验证上限被拒', r4.code === 'VERIFY_LIMIT', r4.code);

  // 9.5 错误场景
  t('不存在的 key', (await call('TEST-AAAA-BBBB-CCCC-DDDD-EEEE-F', 'fpA')).code === 'INVALID_KEY');
  t('软件不匹配', (await call(lic.key, 'fpA', 'other-app')).code === 'APP_MISMATCH');

  await env.DB.prepare("UPDATE licenses SET status='banned' WHERE id=?").bind(lic.id).run();
  t('封禁后拒绝', (await call(lic.key, 'fpA')).code === 'BANNED');

  await env.DB.prepare("UPDATE licenses SET status='active', duration_mode='fixed', expires_at=1 WHERE id=?")
    .bind(lic.id)
    .run();
  t('过期后拒绝', (await call(lic.key, 'fpA')).code === 'EXPIRED');
}

// ---------------- 10. Webhook 验签（对齐爱发电真实推送） ----------------

console.log('\n[10] Webhook 验签');
{
  const { verifyWebhook } = await import('../src/lib/afdian.js');
  const { generateKeyPairSync, sign } = await import('node:crypto');

  // 模拟爱发电平台的密钥对
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const env = { AFDIAN_WEBHOOK_PUBKEY: publicKey };

  const mkOrder = (over = {}) => ({
    out_trade_no: '202610261038455397541020050',
    user_id: 'adf397fe837481eaacee52540025c377',
    plan_id: 'a45353328af911eb973052540025c377',
    total_amount: '29.90',
    status: 2,
    product_type: 0,
    ...over,
  });

  const signOrder = (o) => {
    const str = `${o.out_trade_no}${o.user_id}${o.plan_id}${o.total_amount}`;
    return sign('RSA-SHA256', Buffer.from(str), privateKey).toString('base64');
  };

  // 10.1 sign 在 data.order.sign（这才是爱发电的真实位置）
  const o1 = mkOrder();
  o1.sign = signOrder(o1);
  const r1 = await verifyWebhook(env, { ec: 200, em: 'ok', data: { type: 'order', order: o1 } });
  t('sign 在 data.order 里能验过', r1.ok === true, JSON.stringify(r1));

  // 10.2 兼容 sign 在顶层
  const o2 = mkOrder({ out_trade_no: 'ORDER2' });
  const body2 = { ec: 200, data: { type: 'order', order: o2 }, sign: signOrder(o2) };
  t('sign 在顶层也能验过（兼容）', (await verifyWebhook(env, body2)).ok === true);

  // 10.3 篡改金额必须失败
  const o3 = mkOrder({ out_trade_no: 'ORDER3' });
  o3.sign = signOrder(o3);
  o3.total_amount = '0.01';
  const r3 = await verifyWebhook(env, { ec: 200, data: { type: 'order', order: o3 } });
  t('篡改金额验签失败', r3.ok === false && r3.reason === 'bad_sign', r3.reason);

  // 10.4 换密钥对后验签失败（防伪造）
  const other = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const o4 = mkOrder({ out_trade_no: 'ORDER4' });
  o4.sign = sign(
    'RSA-SHA256',
    Buffer.from(`${o4.out_trade_no}${o4.user_id}${o4.plan_id}${o4.total_amount}`),
    other.privateKey
  ).toString('base64');
  t('伪造签名验签失败', (await verifyWebhook(env, { ec: 200, data: { type: 'order', order: o4 } })).ok === false);

  // 10.5 无 sign 的旧版推送
  const o5 = mkOrder({ out_trade_no: 'ORDER5' });
  t('无签名默认拒绝', (await verifyWebhook(env, { ec: 200, data: { type: 'order', order: o5 } })).reason === 'no_sign');
  const env2 = { ...env, WEBHOOK_ALLOW_UNSIGNED: '1' };
  t('开启开关后放行无签名', (await verifyWebhook(env2, { ec: 200, data: { type: 'order', order: o5 } })).unsigned === true);

  // 10.6 plan_id 为空（自选方案）时拼接不能出 NaN
  const o6 = mkOrder({ out_trade_no: 'ORDER6', plan_id: '' });
  o6.sign = sign('RSA-SHA256', Buffer.from(`${o6.out_trade_no}${o6.user_id}${o6.total_amount}`), privateKey).toString('base64');
  t('plan_id 为空时可验签', (await verifyWebhook(env, { ec: 200, data: { type: 'order', order: o6 } })).ok === true);
}

// ---------------- 11. 软件隔离 / 停用 / 坏 key 限流 ----------------

console.log('\n[11] 软件隔离与防护');
{
  const env = makeEnv();
  const { createLicense } = await import('../src/lib/license.js');
  const { handleVerify, handleStatus } = await import('../src/routes/verify.js');
  const { generateKeyPairSync } = await import('node:crypto');

  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  env.LICENSE_PRIVATE_KEY = privateKey;

  await env.DB.prepare(
    "INSERT INTO apps (id,name,slug,prefix,server_key,status,created_at) VALUES ('a1','软件甲','alpha','ALP','sk1','active',0)"
  ).run();
  await env.DB.prepare(
    "INSERT INTO apps (id,name,slug,prefix,server_key,status,created_at) VALUES ('a2','软件乙','beta','BET','sk2','active',0)"
  ).run();

  const lic = await createLicense(env, {
    app_id: 'a1',
    prefix: 'ALP',
    duration_mode: 'lifetime',
    max_devices: 2,
    features: {},
  });

  const call = async (key, fp, app, ip = '10.0.0.9') => {
    const req = new Request('https://x/api/v1/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify({ key, fingerprint: fp, app }),
    });
    return (await handleVerify(req, env)).json();
  };

  t('软件标识大小写不敏感', (await call(lic.key, 'fp1', 'ALPHA')).ok === true);
  t('跨软件使用被拒', (await call(lic.key, 'fp1', 'beta')).code === 'APP_MISMATCH');
  t('不传 app 时放行（向后兼容）', (await call(lic.key, 'fp1')).ok === true);

  // 设备唯一约束：重复插入不应报 500（OR IGNORE 幂等）
  const dupTry = await env.DB.prepare(
    'INSERT OR IGNORE INTO devices (id,license_id,fingerprint,label,first_seen,last_seen,last_seen_day) VALUES (?,?,?,?,?,?,?)'
  )
    .bind('dev_dup', lic.id, 'fp1', '', 0, 0, '2026-01-01')
    .run();
  t('重复设备被静默忽略', dupTry.meta.changes === 0);
  const dupCount = await env.DB.prepare('SELECT COUNT(*) c FROM devices WHERE license_id=? AND fingerprint=?')
    .bind(lic.id, 'fp1')
    .first();
  t('设备不会重复计入名额', dupCount.c === 1, `${dupCount.c} 条`);

  // 软件停用
  await env.DB.prepare("UPDATE apps SET status='disabled' WHERE id='a1'").run();
  t('软件停用后拒绝验证', (await call(lic.key, 'fp1', 'alpha')).code === 'APP_DISABLED');

  const sr = await (
    await handleStatus(
      new Request('https://x/api/v1/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.10' },
        body: JSON.stringify({ key: lic.key }),
      }),
      env
    )
  ).json();
  t('查询页能看出软件已停用', sr.ok === true && sr.status === 'app_disabled', sr.status);

  await env.DB.prepare("UPDATE apps SET status='active' WHERE id='a1'").run();

  // 坏 key 限流：同 IP 连刷不存在的 key
  let last = null;
  let blockedAt = 0;
  for (let i = 0; i < 25; i++) {
    last = await call('ALP-2222-3333-4444-5555-6666-7', 'fpX', null, '10.9.9.9');
    if (last.code === 'RATE_LIMIT') {
      blockedAt = i + 1;
      break;
    }
  }
  t('连续刷不存在的 key 会被限流', blockedAt > 0 && blockedAt <= 21, `第 ${blockedAt} 次被挡`);
  t('正常用户输错几次不受影响', blockedAt > 5, `阈值 ${blockedAt}`);
}

// ---------------- 12. 限流档位 ----------------

console.log('\n[12] 限流档位');
{
  const env = makeEnv();
  const { getLimits, rateConfig, noteBlocked, blockedToday, resetLimitCache, PROFILES, BAD_KEY_LIMIT } =
    await import('../src/lib/ratelimit.js');

  const setProfile = async (v) => {
    await env.DB.prepare(
      "INSERT INTO meta (k, v) VALUES ('rate_profile', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"
    )
      .bind(v)
      .run();
    resetLimitCache();
  };

  resetLimitCache();
  const d = await getLimits(env);
  t('未配置时默认标准档', d.verify === 120, `verify=${d.verify}`);

  await setProfile('strict');
  const s = await getLimits(env);
  t('切到严格档生效', s.verify === 60 && s.status === 15, `verify=${s.verify}`);

  await setProfile('loose');
  const l = await getLimits(env);
  t('切到宽松档生效', l.verify === 300, `verify=${l.verify}`);

  await setProfile('乱写的值');
  resetLimitCache();
  const fb = await getLimits(env);
  t('非法档位回退标准档', fb.verify === 120, `verify=${fb.verify}`);

  // 缓存：60 秒内不再读库（把 meta 改成别的值，缓存未失效时应仍返回旧值）
  await setProfile('strict');
  await getLimits(env); // 充缓存
  await env.DB.prepare("UPDATE meta SET v = 'loose' WHERE k = 'rate_profile'").run(); // 直接改库，绕过 reset
  const cached = await getLimits(env);
  t('60 秒内命中缓存不读库', cached.verify === 60, `verify=${cached.verify}`);
  resetLimitCache();

  const cfg = await rateConfig(env);
  t('返回三档且含完整参数', cfg.presets.length === 3 && cfg.presets.every((p) => p.verify > 0));
  t('坏 key 限流固定 20', cfg.bad_key_limit === BAD_KEY_LIMIT && BAD_KEY_LIMIT === 20);
  t('三档参数递增（宽松 > 标准 > 严格）',
    PROFILES.loose.verify > PROFILES.normal.verify && PROFILES.normal.verify > PROFILES.strict.verify);

  // 拦截计数
  noteBlocked(env);
  noteBlocked(env);
  const c = await blockedToday(env);
  t('拦截次数可累计（含未落库部分）', c >= 2, `${c} 次`);
}

// ---------------- 13. 令牌 payload 字段契约 ----------------

console.log('\n[13] 令牌字段与掩码');
{
  const env = makeEnv();
  const { buildLicenseToken } = await import('../src/lib/license.js');
  const { generateKeyPairSync } = await import('node:crypto');

  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  env.LICENSE_PRIVATE_KEY = privateKey;

  const lic = {
    id: 'lic_test',
    plan_id: 'plan_x',
    features: '{"pro":true,"export":false}',
    max_devices: 3,
    duration_mode: 'from_activation',
    expires_at: null,
  };
  const signed = await buildLicenseToken(env, lic, { slug: 'demo' }, 'fp-abc');
  const payload = JSON.parse(Buffer.from(signed.token.split('.')[1], 'base64url').toString());

  // 用可读字段名，不再用 f / md / pl 这种缩写
  t('令牌含 features 字段', payload.features && payload.features.pro === true, JSON.stringify(payload.features));
  t('令牌含 max_devices 字段', payload.max_devices === 3, String(payload.max_devices));
  t('令牌含 app / plan / duration_mode', payload.app === 'demo' && payload.plan === 'plan_x' && payload.duration_mode === 'from_activation');
  t('不再使用压缩字段名', !('f' in payload) && !('md' in payload) && !('pl' in payload));

  // 掩码：尾 4 位不能带分隔符
  const { handleStatus } = await import('../src/routes/verify.js');
  await env.DB.prepare(
    "INSERT INTO apps (id,name,slug,prefix,server_key,status,created_at) VALUES ('a9','掩码测试','mask','MASK','sk9','active',0)"
  ).run();
  const { createLicense } = await import('../src/lib/license.js');
  const real = await createLicense(env, { app_id: 'a9', prefix: 'MASK', duration_mode: 'lifetime', features: {} });

  const st = await (
    await handleStatus(
      new Request('https://x/api/v1/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.3.3.3' },
        body: JSON.stringify({ key: real.key }),
      }),
      env
    )
  ).json();

  const tail = st.key.split('-').pop();
  t('掩码尾段不含分隔符', /^[0-9A-Z]{4}$/.test(tail), `尾段 "${tail}"`);
  t('掩码确实隐藏了中间部分', st.key.startsWith('••••'), st.key);
}

// ---------------- 14. 前端 API 调用静态检查 ----------------
// 背景：modalPlan(p) 曾同时承担「编辑已有套餐（带 id）」和「从爱发电预填新建（无 id）」
// 两种语义，判断编辑态时用了 `p ?`（只判对象存在），导致 PATCH 到 plans/undefined → 404。
// 这里做通用静态扫描：凡是拼 URL 用了 `X.id`，就不允许再用 `X` 的真值去区分增删改。

{
  const appJs = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');

  // 粗略切出所有 function 体（按大括号配对）
  const bodies = [];
  const fnRe = /(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = fnRe.exec(appJs))) {
    let depth = 0;
    let i = appJs.indexOf('{', m.index);
    const start = i;
    for (; i < appJs.length; i++) {
      if (appJs[i] === '{') depth++;
      else if (appJs[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    bodies.push({ name: m[1], code: appJs.slice(start, i + 1) });
  }

  // 找出所有 `API.call('res/' + X.id` 形式 —— 即用某个变量的 id 拼 URL
  const risky = [];
  for (const { name, code } of bodies) {
    const urlVars = new Set();
    const urlRe = /API\.call\(\s*['"`](\w+)\/['"`]\s*\+\s*([A-Za-z_$][\w$]*)\.id\b/g;
    let u;
    while ((u = urlRe.exec(code))) urlVars.add(u[2]);
    if (!urlVars.size) continue;

    // 收集函数内的变量赋值，用于溯源「条件变量最终等价于谁」
    const assigns = new Map();
    const asgRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
    let a2;
    while ((a2 = asgRe.exec(code))) assigns.set(a2[1], a2[2].trim());

    // 把条件变量回溯到「根源变量」：
    //   C = X            → 等价于 X
    //   C = X && Y       → 真值等价于 X
    //   C = X || Y       → 真值等价于 X（X 为假时才取 Y）
    //   C = X ? a : b    → 真值等价于 X
    //   C = !!(X)        → 等价于 X
    //   C = !!(X && X.id) → 不等价（它已经要求 id 存在，是安全写法）
    const rootOf = (name, depth = 0) => {
      if (depth > 5) return name;
      const expr = assigns.get(name);
      if (!expr) return name;
      let mm = expr.match(/^!!\s*\(\s*([A-Za-z_$][\w$]*)\s*\)$/);
      if (mm) return rootOf(mm[1], depth + 1);
      mm = expr.match(/^([A-Za-z_$][\w$]*)\s*&&/);
      if (mm) return rootOf(mm[1], depth + 1);
      mm = expr.match(/^([A-Za-z_$][\w$]*)\s*\|\|/);
      if (mm) return rootOf(mm[1], depth + 1);
      mm = expr.match(/^([A-Za-z_$][\w$]*)\s*\?/);
      if (mm) return rootOf(mm[1], depth + 1);
      mm = expr.match(/^([A-Za-z_$][\w$]*)$/);
      if (mm) return rootOf(mm[1], depth + 1);
      return name;
    };

    // 找出所有分支条件变量（`if (C)` 与 `C ?`；`C?.` 可选链要排除）
    const condVars = new Set();
    const ifRe = /\bif\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
    let c;
    while ((c = ifRe.exec(code))) condVars.add(c[1]);
    const ternRe = /\b([A-Za-z_$][\w$]*)\s*\?(?!\.)/g;
    while ((c = ternRe.exec(code))) condVars.add(c[1]);

    // 危险：条件变量溯源后与 URL 的 id 来源是同一个变量
    // （旧 bug：`p ? PATCH plans/p.id : POST plans`，preset 无 id 时拼出 plans/undefined）
    for (const v of urlVars) {
      for (const cv of condVars) {
        if (rootOf(cv) === v) {
          risky.push(`${name}(): 条件 ${cv}(→${rootOf(cv)}) 与 URL 变量 ${v} 相同，可能缺 id`);
        }
      }
    }
  }

  t('前端无「同一变量既判分支又拼 URL.id」的调用点', risky.length === 0, risky.join(' | '));
  t(
    'modalPlan 的编辑态判断基于 p.id 而非对象存在',
    /const\s+editing\s*=\s*!!\(\s*p\s*&&\s*p\.id\s*\)/.test(appJs),
  );
  t(
    'modalApp 的编辑态判断基于 a.id 而非对象存在',
    /const\s+editing\s*=\s*!!\(\s*a\s*&&\s*a\.id\s*\)/.test(appJs),
  );
}

// ---------------- 15. 爱发电下拉选择 → 映射正确性 ----------------
// 前端把「同步快照」展开成下拉选项，选中后自动决定 afdian_type / plan_id / sku_id。
// 这里把 app.js 里的两个纯函数抠出来跑，用真实快照数据验证映射不串。
// 映射错了订单就永远匹配不上，属于最贵的 bug，必须测。

{
  const src = readFileSync(join(ROOT, 'public', 'app.js'), 'utf8');

  // 从 app.js 里抠出指定函数源码
  const grab = (name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) throw new Error('app.js 里找不到函数 ' + name);
    let depth = 0;
    let j = src.indexOf('{', i);
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    return src.slice(i, j + 1);
  };

  // 真实数据（取自线上 afdian_plans 快照）
  const stateMock = {
    plans: [
      {
        id: 'plan_65003ded53c44ecaa3aabf6d9e41242f',
        name: '测试卡',
        afdian_type: 'plan',
        afdian_plan_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01',
        afdian_sku_id: null,
      },
    ],
    afdianPlans: [
      { plan_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa02', name: '示例方案', product_type: 0, price: '5.00', skus: [] },
      { plan_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01', name: '示例商品 A', product_type: 1, price: '10.00', skus: [] },
      { plan_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa03', name: '示例商品 B', product_type: 1, price: '30.00', skus: [] },
    ],
  };

  const factory = new Function(
    'state',
    `${grab('afdianPickOptions')}\n${grab('currentPickValue')}\nreturn { afdianPickOptions, currentPickValue };`,
  );
  const { afdianPickOptions, currentPickValue } = factory(stateMock);
  const opts = afdianPickOptions();

  t('下拉选项数量 = 快照条目数（无型号商品不额外拆分）', opts.length === 3, `实际 ${opts.length}`);

  const byPlan = (pid) => opts.find((o) => o.value === 'plan|' + pid);

  // 无型号商品：订单里没有 sku_id，只能靠 plan_id 匹配 —— 必须落在 'plan' 类型
  const wood = byPlan('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01');
  t('无型号商品被归到 plan 类型（否则订单匹配不上）', !!wood && wood.value.startsWith('plan|'), wood && wood.value);
  t('无型号商品的 plan_id 原样带出', wood && wood.value === 'plan|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01');

  // 订阅方案同理
  const test = byPlan('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa02');
  t('订阅方案归到 plan 类型', !!test && test.value.startsWith('plan|'));

  // 选项标签带上名称与价格，方便肉眼辨认
  t('选项标签含方案名', (wood && wood.label.includes('示例商品 A')) || false, wood && wood.label);
  t('选项标签含价格', (wood && wood.label.includes('10.00')) || false, wood && wood.label);

  // 已被套餐占用的方案要标出来，避免重复建
  t('已关联的方案在选项里标注', (wood && wood.linked) === '测试卡', wood && wood.linked);
  t('未关联的方案 linked 为空', (test && test.linked) === null, test && test.linked);

  // 编辑已有套餐时能反查回原选项
  t(
    '编辑时反查到原下拉选项',
    currentPickValue(stateMock.plans[0]) === 'plan|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01',
    currentPickValue(stateMock.plans[0]),
  );
  t('新建时默认不关联', currentPickValue(null) === '__none__');

  // 商品从爱发电删除后，快照里找不到 → 落到手工填写，且不丢原值
  const orphan = { afdian_type: 'plan', afdian_plan_id: 'deadbeef0000000000000000000000', afdian_sku_id: null };
  t('快照里找不到时落到手工填写', currentPickValue(orphan) === '__manual__', currentPickValue(orphan));

  // 有型号商品：拆成每条型号，且归到 sku 类型
  const stateSku = {
    plans: [],
    afdianPlans: [
      {
        plan_id: 'PL1',
        name: '多口味',
        product_type: 1,
        price: '20.00',
        skus: [
          { sku_id: 'SKU_A', name: '原味', price: '20.00' },
          { sku_id: 'SKU_B', name: '辣味', price: '22.00' },
        ],
      },
    ],
  };
  const skuOpts = factory(stateSku).afdianPickOptions();
  t('有型号商品按型号拆成多条', skuOpts.length === 2, `实际 ${skuOpts.length}`);
  t('有型号商品归到 sku 类型', skuOpts.every((o) => o.value.startsWith('sku|')), skuOpts[0] && skuOpts[0].value);
  t(
    'sku 选项同时带上 plan_id 与 sku_id',
    skuOpts[0] && skuOpts[0].value === 'sku|PL1|SKU_A',
    skuOpts[0] && skuOpts[0].value,
  );
}

// ---------------- 16. 爱发电官方测试样本订单拦截 ----------------
// 爱发电保存 webhook 时会推一笔固定样本（buyer = 平台测试号 plan_title="测试webhook"）。
// 它曾触发过一次真实发码，生成买家永远收不到的废码，且私信队列一直重试。
//
// ⚠️ 曾经的教训：一开始误用 `order.user_id === AFDIAN_USER_ID` 来判断归属，
// 但爱发电订单里的 user_id 是**买家**的 ID，不是创作者的 —— 那样会把所有真实订单都误杀。
// 正确判据是「是不是爱发电那笔固定测试样本」。

{
  const { isAfdianTestOrder } = await import('../src/lib/afdian.js');

  const TEST_PLAN = 'a45353328af911eb973052540025c377';
  const TEST_SKU = '2172ea4e3a2311edbcaa52540025c377';

  // 线上实际收到的那笔样本（来自 orders.raw）
  const realSample = {
    out_trade_no: '202106232138371083454010626',
    user_id: 'adf397fe8374811eaacee52540025c377',
    user_private_id: '345357fe8374811eaacee52540025c377',
    plan_id: TEST_PLAN,
    plan_title: '测试webhook',
    total_amount: '5.00',
    status: 2,
    product_type: 1,
    sku_detail: [
      { sku_id: TEST_SKU, count: 2, name: 'sku1' },
      { sku_id: '2172ea4e3a2311edbcaa52540025c378', count: 3, name: 'sku2' },
    ],
  };

  t('官方测试样本被识别', isAfdianTestOrder(realSample) === true);
  t('plan_title 为「测试webhook」即判为样本', isAfdianTestOrder({ plan_title: '测试webhook' }) === true);
  t('plan_id 命中官方测试方案即判为样本', isAfdianTestOrder({ plan_id: TEST_PLAN }) === true);
  t('sku_id 命中官方测试型号即判为样本', isAfdianTestOrder({ sku_detail: [{ sku_id: TEST_SKU }] }) === true);

  // 真实订单不能被误杀
  const realOrder = {
    out_trade_no: '20250101123456789',
    user_id: 'adf397fe8374811eaacee52540025c377', // 买家 ID，恰好与测试号相同也不该误判
    plan_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa02',
    plan_title: '月度赞助',
    total_amount: '5.00',
    status: 2,
    product_type: 0,
    sku_detail: [],
  };
  t('真实订单不被误判为样本', isAfdianTestOrder(realOrder) === false);
  t('空订单按样本处理（宁可不发）', isAfdianTestOrder(null) === true);
  t('普通订单不被误判', isAfdianTestOrder({ plan_id: 'abc', sku_detail: [] }) === false);
}

// ---------------- 17. 套餐匹配白名单 ----------------
// 同步过快照后，只认快照里的 plan_id / sku_id。
// 这样乱填的 ID（包括抄了爱发电官方测试样本）匹配不到套餐，也就发不出码。

{
  const env = makeEnv();
  const { matchPlan } = await import('../src/lib/license.js');

  // 建一个软件与套餐
  const appId = 'app_wl';
  await env.DB.prepare(
    "INSERT INTO apps (id,name,slug,prefix,status,server_key,created_at) VALUES (?,?,?,?,?,?,0)"
  )
    .bind(appId, '白名单测试', 'wl-test', 'WL', 'active', 'sk_wl')
    .run();
  const planId = 'plan_wl';
  await env.DB.prepare(
    `INSERT INTO plans (id,app_id,name,duration_mode,duration_days,max_devices,verify_limit,features,
       afdian_plan_id,afdian_sku_id,afdian_type,status,created_at)
     VALUES (?,?,?,'from_activation',30,1,100,'{}',?,NULL,'plan','active',0)`
  )
    .bind(planId, appId, '白名单套餐', 'REAL_PLAN_ID')
    .run();

  // 快照为空 → 不限制，老行为（真实订单不能被漏发）
  t('快照为空时正常匹配（不漏发真实订单）', (await matchPlan(env, 'REAL_PLAN_ID', null)) !== null);

  // 写入快照（带型号列表）
  await env.DB.prepare(
    'INSERT INTO afdian_plans (plan_id,name,product_type,price,status,sku_json,synced_at) VALUES (?,?,?,?,?,?,0)'
  )
    .bind('REAL_PLAN_ID', '真实方案', 0, '5.00', 1, JSON.stringify([{ sku_id: 'REAL_SKU' }]))
    .run();

  t('快照内的 plan_id 能匹配', (await matchPlan(env, 'REAL_PLAN_ID', null)) !== null);
  t(
    '快照外的 plan_id 匹配不到（乱填的 ID 不会发码）',
    (await matchPlan(env, 'a45353328af911eb973052540025c377', null)) === null,
  );
  t(
    '快照外的 sku_id 匹配不到',
    (await matchPlan(env, 'REAL_PLAN_ID', '2172ea4e3a2311edbcaa52540025c377')) === null,
  );
  t('快照内的 sku_id 能匹配', (await matchPlan(env, 'REAL_PLAN_ID', 'REAL_SKU')) !== null);

  // sku_json 为 NULL（同步时爱发电没返回型号列表）→ 无法判断，必须放行
  // 否则该 plan 下所有带 sku 的合法订单都会被判死、永久不发码
  await env.DB.prepare(
    'INSERT INTO afdian_plans (plan_id,name,product_type,price,status,sku_json,synced_at) VALUES (?,?,?,?,?,NULL,0)'
  )
    .bind('NO_SKU_JSON', '型号未知的方案', 1, '9.00', 1)
    .run();
  // 该套餐确实映射了 WHATEVER_SKU，但快照没记下型号列表
  await env.DB.prepare(
    `INSERT INTO plans (id,app_id,name,duration_mode,duration_days,max_devices,verify_limit,features,
       afdian_plan_id,afdian_sku_id,afdian_type,status,created_at)
     VALUES (?,?,?,'from_activation',30,1,100,'{}',NULL,?,'sku','active',0)`
  )
    .bind('plan_nosku', appId, '型号未知套餐', 'WHATEVER_SKU')
    .run();
  t(
    'sku_json 为 NULL 时放行（不误杀合法订单）',
    (await matchPlan(env, 'NO_SKU_JSON', 'WHATEVER_SKU')) !== null,
  );
}

// ---------------- 18. Webhook 端到端：测试样本被拦、真实订单照常 ----------------
// 上面测的是纯函数，这里走完整链路：构造请求 → 验签 → 处理 → 查库。
// 关键对照：**同一个 plan_id**，只有带爱发电官方标记的那笔该被拦。

{
  const { handleAfdianWebhook } = await import('../src/routes/webhook.js');
  const { generateKeyPairSync, sign } = await import('node:crypto');

  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const env = makeEnv();
  env.AFDIAN_WEBHOOK_PUBKEY = publicKey;

  const TEST_PLAN = 'a45353328af911eb973052540025c377';
  const TEST_SKU = '2172ea4e3a2311edbcaa52540025c377';

  const mkOrder = (over = {}) => {
    const o = {
      out_trade_no: 'ORD_X',
      user_id: 'adf397fe8374811eaacee52540025c377',
      user_private_id: '345357fe8374811eaacee52540025c377',
      plan_id: TEST_PLAN,
      total_amount: '5.00',
      status: 2,
      product_type: 1,
      sku_detail: [],
      ...over,
    };
    o.sign = sign(
      'RSA-SHA256',
      Buffer.from(`${o.out_trade_no}${o.user_id}${o.plan_id}${o.total_amount}`),
      privateKey,
    ).toString('base64');
    return o;
  };

  const push = (order) =>
    handleAfdianWebhook(
      new Request('https://x/webhook/afdian', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ec: 200, em: 'ok', data: { type: 'order', order } }),
      }),
      env,
      { waitUntil: () => {} },
    );

  const countOrders = async () => {
    const r = await env.DB.prepare('SELECT COUNT(*) AS c FROM orders').first();
    return Number(r?.c || 0);
  };
  const countLicenses = async () => {
    const r = await env.DB.prepare('SELECT COUNT(*) AS c FROM licenses').first();
    return Number(r?.c || 0);
  };

  const before = await countOrders();
  const licBefore = await countLicenses();

  // ① 爱发电官方测试样本：带 plan_title 与官方 sku
  await push(
    mkOrder({
      out_trade_no: 'TEST_SAMPLE_1',
      plan_title: '测试webhook',
      sku_detail: [
        { sku_id: TEST_SKU, count: 2, name: 'sku1' },
        { sku_id: '2172ea4e3a2311edbcaa52540025c378', count: 3, name: 'sku2' },
      ],
    }),
  );
  t('官方测试样本不入订单表', (await countOrders()) === before);
  t('官方测试样本不生成授权码', (await countLicenses()) === licBefore);

  const auditRow = await env.DB.prepare(
    "SELECT detail FROM audit_logs WHERE action = 'webhook_skip_test' ORDER BY id DESC LIMIT 1",
  ).first();
  t('官方测试样本留下审计记录', !!auditRow, auditRow && auditRow.detail);

  // ② 真实订单：用**用户自己的** plan_id，必须照常处理（不能误杀）
  //    注意不能用官方测试 plan_id —— 那个 ID 只可能出现在平台测试单里，
  //    按它拦是对的（真实购买不会买平台的测试方案）。
  await push(
    mkOrder({
      out_trade_no: 'REAL_ORDER_1',
      plan_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa02',
      plan_title: '月度赞助',
      product_type: 0,
    }),
  );
  t('用户真实 plan_id 的订单未被误杀（入了订单表）', (await countOrders()) === before + 1);

  const ord = await env.DB.prepare(
    'SELECT out_trade_no, delivery FROM orders WHERE out_trade_no = ?',
  )
    .bind('REAL_ORDER_1')
    .first();
  t('真实订单被正常处理（标记为未匹配套餐）', !!ord, ord && ord.delivery);

  // ③ 真实订单重复推送 → 幂等，不重复入库
  await push(
    mkOrder({
      out_trade_no: 'REAL_ORDER_1',
      plan_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa02',
      plan_title: '月度赞助',
      product_type: 0,
    }),
  );
  t('重复推送幂等（不重复入库）', (await countOrders()) === before + 1);
}

// ---------------- 19. 私信永久性失败不再重试 ----------------
// 之前所有失败都按「临时失败」处理，无脑重试 5 次。
// 像「对方没赞助过你」这种永久失败，重试再多次也一样，只是白烧额度、
// 还让管理台一直显示「待发送」。

{
  const { isPermanentMsgError } = await import('../src/lib/afdian.js');

  t('ec=400001（无赞助关系）判为永久失败', isPermanentMsgError(400001, '需要赞助对方或被对方赞助才可以发送私信') === true);
  t('ec=400003（参数错误）判为永久失败', isPermanentMsgError(400003, '参数错误') === true);
  t('ec=400004（token 无效）判为永久失败', isPermanentMsgError(400004, 'token 无效') === true);
  t('ec=400006（限频）判为临时失败', isPermanentMsgError(400006, '请求过于频繁') === false);
  t('网络错误判为临时失败', isPermanentMsgError(-1, 'network: fetch failed') === false);
  t('ec=200 不算失败', isPermanentMsgError(200, 'ok') === false);
}

// ---------------- 20. 2026-10-27 自我审计修复回归 ----------------
// 本轮审计确认并修复的问题，逐条锁住。

console.log('\n[20] 审计修复回归（状态/令牌/幂等/对账）');
{
  const nowSec = () => Math.floor(Date.now() / 1000);
  const { effectiveStatus, buildLicenseToken } = await import('../src/lib/license.js');
  const { generateKeyPairSync } = await import('node:crypto');

  // ---- 20.1 状态白名单 ----
  const base = { duration_mode: 'from_activation', expires_at: nowSec() + 86400 };
  t('status=active → active', effectiveStatus({ ...base, status: 'active' }) === 'active');
  t('status=banned → banned', effectiveStatus({ ...base, status: 'banned' }) === 'banned');
  t('status=revoked → revoked', effectiveStatus({ ...base, status: 'revoked' }) === 'revoked');
  // 修复前：非 banned/revoked 一律掉进最后的 return 'active'，停用码被当有效
  t(
    'status=disabled 不再被当成有效',
    effectiveStatus({ ...base, status: 'disabled' }) === 'disabled',
    effectiveStatus({ ...base, status: 'disabled' }),
  );
  t(
    '未知状态不被当成有效',
    effectiveStatus({ ...base, status: 'suspended' }) === 'suspended',
    effectiveStatus({ ...base, status: 'suspended' }),
  );
  t(
    '过期码仍判 expired',
    effectiveStatus({ duration_mode: 'from_activation', status: 'active', expires_at: nowSec() - 10 }) === 'expired',
  );
  t(
    'lifetime 码无到期时间仍 active',
    effectiveStatus({ duration_mode: 'lifetime', status: 'active', expires_at: null }) === 'active',
  );

  // ---- 20.2 TOKEN_TTL_HOURS 边界 ----
  const env = makeEnv();
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  env.LICENSE_PRIVATE_KEY = privateKey;

  const licLifetime = {
    id: 'lic_ttl',
    plan_id: 'plan_x',
    features: '{}',
    max_devices: 1,
    duration_mode: 'lifetime',
    expires_at: null,
  };

  for (const [label, val] of [
    ['"0"', '0'],
    ['"abc"', 'abc'],
    ['"-5"', '-5'],
    ['空值', ''],
  ]) {
    env.TOKEN_TTL_HOURS = val;
    const { payload } = await buildLicenseToken(env, licLifetime, { slug: 'demo' }, null);
    const ok = Number.isFinite(payload.exp) && payload.exp > payload.iat;
    t(`TOKEN_TTL_HOURS=${label} 仍签出有效 exp`, ok, `exp=${payload.exp} iat=${payload.iat}`);
  }

  env.TOKEN_TTL_HOURS = '6';
  const six = await buildLicenseToken(env, licLifetime, { slug: 'demo' }, null);
  t(
    'TOKEN_TTL_HOURS=6 生效（差值 6 小时）',
    six.payload.exp - six.payload.iat === 6 * 3600,
    String(six.payload.exp - six.payload.iat),
  );
}

// ---- 20.3 processOrder 幂等：同一订单处理两次只发一枚码 ----
{
  const { processOrder } = await import('../src/routes/webhook.js');
  const env = makeEnv();

  await env.DB.prepare(
    "INSERT INTO apps (id,name,slug,prefix,server_key,status,created_at) VALUES ('a_idem','幂等','idem','IDEM','sk_idem','active',0)"
  ).run();
  await env.DB.prepare(
    `INSERT INTO plans (id,app_id,name,duration_mode,duration_days,max_devices,verify_limit,features,
       afdian_plan_id,status,created_at)
     VALUES ('plan_idem','a_idem','幂等套餐','from_activation',30,1,100,'{}','IDEM_PLAN','active',0)`
  ).run();
  // matchPlan 的白名单：快照为空时不限制；这里写入一条让 plan 命中
  await env.DB.prepare(
    'INSERT INTO afdian_plans (plan_id,name,product_type,price,status,sku_json,synced_at) VALUES (?,?,?,?,?,NULL,0)'
  )
    .bind('IDEM_PLAN', '幂等方案', 0, '10.00', 1)
    .run();

  const order = {
    out_trade_no: 'IDEM_ORDER_1',
    user_id: 'buyer_1',
    plan_id: 'IDEM_PLAN',
    total_amount: '10.00',
    status: 2,
    month: 1,
    product_type: 0,
    sku_detail: [],
  };

  await processOrder(env, order, null);
  const after1 = (await env.DB.prepare('SELECT COUNT(*) c FROM licenses').first()).c;

  // 重复推送（并发重放 / 爱发电重试）
  await processOrder(env, order, null);
  await processOrder(env, order, null);
  const after3 = (await env.DB.prepare('SELECT COUNT(*) c FROM licenses').first()).c;

  t('首次处理生成 1 枚码', after1 === 1, String(after1));
  t('重复处理 2 次仍只有 1 枚码（幂等）', after3 === 1, String(after3));

  const q = (await env.DB.prepare("SELECT COUNT(*) c FROM msg_queue WHERE ref = 'IDEM_ORDER_1'").first()).c;
  t('私信队列也不重复入队', q === 1, String(q));

  const od = await env.DB.prepare(
    "SELECT license_id, delivery FROM orders WHERE out_trade_no = 'IDEM_ORDER_1'"
  ).first();
  t('订单已回写 license_id', !!od?.license_id);
  t('订单状态不是卡在 processing', od?.delivery !== 'processing', od?.delivery);
}

// ---- 20.4 对账追平：页内含未支付订单时仍能正确停止 ----
{
  const { reconcileOrders } = await import('../src/lib/reconcile.js');
  const env = makeEnv();

  await env.DB.prepare(
    "INSERT INTO apps (id,name,slug,prefix,status,created_at) VALUES ('a_rc2','对账','rc2','RC2','active',0)"
  ).run();
  await env.DB.prepare(
    `INSERT INTO plans (id,app_id,name,duration_mode,duration_days,max_devices,verify_limit,features,
       afdian_plan_id,status,created_at)
     VALUES ('plan_rc2','a_rc2','对账套餐','from_activation',30,1,100,'{}','RC2_PLAN','active',0)`
  ).run();

  // 第 1 页：2 笔已支付 + 1 笔未支付。未支付订单永远不会落库，
  // 修复前会让「整页都已存在」这个等式永远不成立，每轮都白翻 maxPages 页。
  const PAGE = [
    { out_trade_no: 'RC2_A', user_id: 'b1', plan_id: 'RC2_PLAN', total_amount: '10', status: 2, month: 1 },
    { out_trade_no: 'RC2_B', user_id: 'b2', plan_id: 'RC2_PLAN', total_amount: '10', status: 2, month: 1 },
    { out_trade_no: 'RC2_UNPAID', user_id: 'b3', plan_id: 'RC2_PLAN', total_amount: '10', status: 1, month: 1 },
  ];

  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({ ec: 200, em: '', data: { list: PAGE, total_page: 9, total_count: 3 } }),
      { headers: { 'content-type': 'application/json' } },
    );
  };

  const r1 = await reconcileOrders(env, null, { maxPages: 6 });
  t('第一轮补发 2 笔已支付订单', r1.added === 2, `added=${r1.added}`);

  const before = calls;
  const r2 = await reconcileOrders(env, null, { maxPages: 6 });
  t('第二轮不重复发码', r2.added === 0, `added=${r2.added}`);
  t(
    '页内有未支付订单时仍只请求 1 页（不再白翻）',
    calls - before === 1,
    `多请求 ${calls - before} 次`,
  );
  t('本轮无新增时 pages 不应大于 1', r2.pages <= 1, `pages=${r2.pages}`);
}

// ---------------- 21. D1 限流（跨 isolate 有效） ----------------
// 内存 Map 版在多 isolate 下不共享，实测同一 IP 连打 7 次登录全部绕过 5 次上限。
// 这里验证 D1 版真的能挡住。

console.log('\n[21] D1 限流');
{
  const { rateLimitDb } = await import('../src/lib/util.js');
  const env = makeEnv();

  const results = [];
  for (let i = 0; i < 7; i++) results.push(await rateLimitDb(env, 'login:1.2.3.4', 5, 300));

  t('前 5 次放行', results.slice(0, 5).every((x) => x === true), results.join(','));
  t('第 6 次起拒绝', results[5] === false && results[6] === false, results.join(','));

  t('不同 key 互不影响', (await rateLimitDb(env, 'login:5.6.7.8', 5, 300)) === true);
  t('不同业务互不影响', (await rateLimitDb(env, 'whrej:1.2.3.4', 5, 300)) === true);

  // 窗口滚动（不同 window 值 → 不同 bucket）后应重置
  t('新窗口重新计数', (await rateLimitDb(env, 'login:1.2.3.4', 5, 1)) === true);

  // DB 不可用时不能阻断业务（宁可限流失效也不要让登录全挂）
  const brokenEnv = { DB: { prepare: () => { throw new Error('db down'); } } };
  t('DB 异常时放行（不阻断业务）', (await rateLimitDb(brokenEnv, 'login:x', 1, 60)) === true);
}

// ---------------- 22. 续期规则（同套餐 + 剩余 >= 30 分钟） ----------------

console.log('\n[22] 续期规则');
{
  const nowSec = () => Math.floor(Date.now() / 1000);
  const { findRenewableLicense, createLicense } = await import('../src/lib/license.js');
  const env = makeEnv();
  const TS = nowSec();

  await env.DB.prepare(
    "INSERT INTO apps (id,name,slug,prefix,server_key,status,created_at) VALUES ('a_r','续期','r','R','sk_r','active',0)"
  ).run();

  const mk = async (args = {}) =>
    createLicense(env, {
      app_id: 'a_r',
      plan_id: 'plan_A',
      prefix: 'R',
      duration_mode: 'from_activation',
      duration_days: 30,
      max_devices: 1,
      features: {},
      source: 'afdian',
      buyer_id: 'B1',
      afdian_order_no: 'O1',
      ...args,
    });

  const lic1 = await mk();

  // 剩余 60 分钟 → 可续
  await env.DB.prepare('UPDATE licenses SET activated_at = ?, expires_at = ? WHERE id = ?')
    .bind(TS - 86400, TS + 3600, lic1.id)
    .run();
  t(
    '剩余 60 分钟可续期',
    (await findRenewableLicense(env, 'a_r', 'B1', 'plan_A', TS))?.id === lic1.id,
  );

  // 剩余 20 分钟 → 业务规则不允许续期
  await env.DB.prepare('UPDATE licenses SET expires_at = ? WHERE id = ?').bind(TS + 1200, lic1.id).run();
  t(
    '剩余 20 分钟不允许续期（改发新卡）',
    (await findRenewableLicense(env, 'a_r', 'B1', 'plan_A', TS)) === null,
  );

  // 已过期 → 不可续
  await env.DB.prepare('UPDATE licenses SET expires_at = ? WHERE id = ?').bind(TS - 60, lic1.id).run();
  t('已过期的码不允许续期', (await findRenewableLicense(env, 'a_r', 'B1', 'plan_A', TS)) === null);

  // 不同套餐不复用（严格按 plan_id 匹配，不做跨套餐兜底）
  await env.DB.prepare('UPDATE licenses SET expires_at = ? WHERE id = ?').bind(TS + 86400, lic1.id).run();
  t(
    '不同套餐不会复用旧码',
    (await findRenewableLicense(env, 'a_r', 'B1', 'plan_B', TS)) === null,
  );

  // 未激活的码（无到期时间）可直接续，不受 30 分钟约束
  await env.DB.prepare('UPDATE licenses SET activated_at = NULL, expires_at = NULL WHERE id = ?')
    .bind(lic1.id)
    .run();
  t(
    '未激活的码可直接续期（累加天数）',
    (await findRenewableLicense(env, 'a_r', 'B1', 'plan_A', TS))?.id === lic1.id,
  );

  // 永久码 → 打标记（上层据此发新卡）
  await env.DB.prepare("UPDATE licenses SET duration_mode = 'lifetime', expires_at = NULL WHERE id = ?")
    .bind(lic1.id)
    .run();
  const lt = await findRenewableLicense(env, 'a_r', 'B1', 'plan_A', TS);
  t('永久码被标记 __lifetime', lt?.__lifetime === true);
}

// ---------------- 23. 发码分流：续期 / 新卡 / 永久卡买几次发几次 ----------------

console.log('\n[23] 发码分流');
{
  const { processOrder } = await import('../src/routes/webhook.js');
  const env = makeEnv();

  await env.DB.prepare(
    "INSERT INTO apps (id,name,slug,prefix,server_key,status,created_at) VALUES ('a_d','分流','d','D','sk_d','active',0)"
  ).run();
  for (const [id, name, pid, mode, days] of [
    ['plan_m', '月卡', 'AFD_M', 'from_activation', 30],
    ['plan_y', '年卡', 'AFD_Y', 'from_activation', 365],
    ['plan_l', '永久版', 'AFD_L', 'lifetime', 0],
  ]) {
    await env.DB.prepare(
      `INSERT INTO plans (id,app_id,name,duration_mode,duration_days,max_devices,verify_limit,features,
         afdian_plan_id,status,created_at)
       VALUES (?,?,?,?,?,2,100,'{"pro":true}',?,'active',0)`
    )
      .bind(id, 'a_d', name, mode, days, pid)
      .run();
  }

  const mkOrder = (no, planId) => ({
    out_trade_no: no,
    user_id: 'BUYER_D',
    plan_id: planId,
    total_amount: '10.00',
    status: 2,
    month: 1,
    product_type: 0,
    sku_detail: [],
  });
  const countLic = async () => (await env.DB.prepare('SELECT COUNT(*) c FROM licenses').first()).c;
  const getOrder = async (no) =>
    env.DB.prepare('SELECT issue_type, delivery, license_id FROM orders WHERE out_trade_no = ?').bind(no).first();

  // 1) 第一单：新卡
  await processOrder(env, mkOrder('D1', 'AFD_M'), null);
  t('首单发新卡', (await countLic()) === 1, String(await countLic()));
  t('首单标记为 new', (await getOrder('D1'))?.issue_type === 'new');

  // 2) 同套餐再买：码未激活（无到期时间）→ 续期，不新增码
  await processOrder(env, mkOrder('D2', 'AFD_M'), null);
  t('同套餐再买走续期，不新增码', (await countLic()) === 1, String(await countLic()));
  t('第二单标记为 renew', (await getOrder('D2'))?.issue_type === 'renew');

  const m = await env.DB.prepare("SELECT duration_days FROM licenses WHERE plan_id = 'plan_m'").first();
  t('续期累加了天数（30→60）', Number(m.duration_days) === 60, String(m.duration_days));

  // 3) 不同套餐 → 新卡
  await processOrder(env, mkOrder('D3', 'AFD_Y'), null);
  t('不同套餐发新卡', (await countLic()) === 2, String(await countLic()));

  // 4) 永久卡：买几次发几次
  await processOrder(env, mkOrder('D4', 'AFD_L'), null);
  const l1 = await countLic();
  await processOrder(env, mkOrder('D5', 'AFD_L'), null);
  const l2 = await countLic();
  t('永久卡第一单发卡', l1 === 3, String(l1));
  t('同套餐永久卡再买 → 再发一张新卡（买几次发几次）', l2 === 4, String(l2));
  t('两张永久卡都是 new', (await getOrder('D4'))?.issue_type === 'new' && (await getOrder('D5'))?.issue_type === 'new');
}

// ---------------- 24. 过期卡清理与 key 尾号归档 ----------------

console.log('\n[24] 过期卡清理');
{
  const nowSec = () => Math.floor(Date.now() / 1000);
  const { cleanupExpiredLicenses } = await import('../src/index.js');
  const { createLicense } = await import('../src/lib/license.js');
  const env = makeEnv();
  const TS = nowSec();

  await env.DB.prepare(
    "INSERT INTO apps (id,name,slug,prefix,server_key,status,created_at) VALUES ('a_c','清理','c','C','sk_c','active',0)"
  ).run();

  const mk = (over) =>
    createLicense(env, {
      app_id: 'a_c',
      plan_id: 'plan_c',
      prefix: 'C',
      duration_mode: 'from_activation',
      duration_days: 30,
      max_devices: 1,
      features: {},
      source: 'afdian',
      ...over,
    });

  // 过期 40 天 → 应删
  const old = await mk({ buyer_id: 'B_OLD', afdian_order_no: 'C_OLD' });
  await env.DB.prepare('UPDATE licenses SET expires_at = ? WHERE id = ?').bind(TS - 40 * 86400, old.id).run();
  await env.DB.prepare(
    "INSERT INTO orders (out_trade_no, license_id, status, created_at) VALUES ('C_OLD', ?, 2, 0)"
  ).bind(old.id).run();
  await env.DB.prepare(
    "INSERT INTO devices (id,license_id,fingerprint,first_seen,last_seen,last_seen_day) VALUES ('d1',?,'fp1',0,0,'2026-01-01')"
  ).bind(old.id).run();

  // 过期 10 天 → 保留（未满 30 天）
  const recent = await mk({ buyer_id: 'B_NEW', afdian_order_no: 'C_NEW' });
  await env.DB.prepare('UPDATE licenses SET expires_at = ? WHERE id = ?').bind(TS - 10 * 86400, recent.id).run();

  // revoked 的即使过期很久也保留（人工封禁，要可追溯）
  const rev = await mk({ buyer_id: 'B_REV', afdian_order_no: 'C_REV' });
  await env.DB.prepare("UPDATE licenses SET expires_at = ?, status = 'revoked' WHERE id = ?")
    .bind(TS - 100 * 86400, rev.id)
    .run();

  // lifetime 永不删
  const life = await mk({ buyer_id: 'B_LIFE', afdian_order_no: 'C_LIFE', duration_mode: 'lifetime' });

  const res = await cleanupExpiredLicenses(env, TS);
  t('删除 1 枚过期超 30 天的码', res.licenses === 1, JSON.stringify(res));
  t('一并删除其设备', res.devices === 1, JSON.stringify(res));
  t('订单被归档 key 尾号', res.orders === 1, JSON.stringify(res));

  const arch = await env.DB.prepare("SELECT archived_key FROM orders WHERE out_trade_no = 'C_OLD'").first();
  t('归档的是掩码而非明文', /^••••[0-9A-Z]{4}$/.test(arch?.archived_key || ''), arch?.archived_key);

  const left = (await env.DB.prepare('SELECT COUNT(*) c FROM licenses').first()).c;
  t('未满 30 天 / revoked / lifetime 都保留（剩 3 枚）', left === 3, String(left));

  const lifeStill = await env.DB.prepare("SELECT id FROM licenses WHERE id = ?").bind(life.id).first();
  t('lifetime 码未被删除', !!lifeStill);
}

// ---------------- 25. 设备安全：IP 漂移 + 每日新增上限 ----------------

console.log('\n[25] 设备安全');
{
  const { handleVerify } = await import('../src/routes/verify.js');
  const { createLicense } = await import('../src/lib/license.js');
  const { generateKeyPairSync } = await import('node:crypto');
  const env = makeEnv();

  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  env.LICENSE_PRIVATE_KEY = privateKey;

  await env.DB.prepare(
    "INSERT INTO apps (id,name,slug,prefix,server_key,status,created_at) VALUES ('a_s','设备','slug_s','S','sk_s','active',0)"
  ).run();

  const mkLic = (maxDev) =>
    createLicense(env, {
      app_id: 'a_s',
      plan_id: 'plan_s',
      prefix: 'S',
      duration_mode: 'lifetime',
      max_devices: maxDev,
      verify_limit: 0,
      features: {},
      source: 'afdian',
      buyer_id: 'B_S',
    });

  const verify = async (key, fp, ip) => {
    const r = await handleVerify(
      new Request('https://x/api/v1/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
        body: JSON.stringify({ key, app: 'slug_s', fingerprint: fp }),
      }),
      env
    );
    return r.json();
  };

  // ---- IP 漂移：同一指纹最多允许 5 个不同 IP ----
  const lic1 = await mkLic(1);
  let last;
  for (let i = 1; i <= 5; i++) last = await verify(lic1.key, 'fp_shared', '10.0.0.' + i);
  t('同一指纹前 5 个不同 IP 全部允许', last?.ok === true, JSON.stringify(last).slice(0, 80));

  const over = await verify(lic1.key, 'fp_shared', '10.0.0.6');
  t('第 6 个不同 IP 被拒绝', over?.code === 'DEVICE_IP_LIMIT', over?.code);

  const again = await verify(lic1.key, 'fp_shared', '10.0.0.3');
  t('回到用过的 IP 仍放行（不误伤正常换网）', again?.ok === true, again?.code);

  // ---- 每日新增上限 = max_devices（解绑后也不能当天重绑绕过）----
  const lic2 = await mkLic(2);

  const a1 = await verify(lic2.key, 'fp_a', '10.9.0.1');
  const a2 = await verify(lic2.key, 'fp_b', '10.9.0.2');
  t('前 2 台（=max_devices）允许加入', a1?.ok === true && a2?.ok === true, `${a1?.code}/${a2?.code}`);

  // 模拟用户解绑一台：长度检查会通过，但 24h 计数仍是 2，应当被日限挡住
  await env.DB.prepare("DELETE FROM devices WHERE license_id = ? AND fingerprint = 'fp_b'").bind(lic2.id).run();
  const a3 = await verify(lic2.key, 'fp_c', '10.9.0.3');
  t(
    '解绑后当天重绑被日限挡住（防占坑绕过）',
    a3?.code === 'DEVICE_ADD_LIMIT',
    a3?.code,
  );

  // 超过 max_devices 直接 DEVICE_LIMIT（走的是长度检查，不消耗日限额）
  const lic4 = await mkLic(1);
  await verify(lic4.key, 'fp_only', '10.7.0.1');
  const a4 = await verify(lic4.key, 'fp_second', '10.7.0.2');
  t('超出设备上限返回 DEVICE_LIMIT', a4?.code === 'DEVICE_LIMIT', a4?.code);
}

// ---------------- 汇总 ----------------

console.log('\n' + '─'.repeat(46));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败清单：');
  failures.forEach((f) => console.log('  · ' + f));
  process.exit(1);
}
console.log('全部通过 ✅');
