/* 界面演示数据（仅在 URL 带 ?demo=1 时启用）
   用途：不连后端也能预览管理台全部页面，方便调界面。
   生产环境下本文件加载后立即返回，不定义任何东西。 */
(function () {
  if (!new URLSearchParams(location.search).has('demo')) return;

  const now = Math.floor(Date.now() / 1000);
  const D = 86400;
  const fmt = (t) => {
    if (!t) return '永久';
    const d = new Date(t * 1000 + 8 * 3600 * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  };

  const APPS = [
    { id: 'app_1', name: '示例工具 Pro', slug: 'demo-pro', prefix: 'DEMO', server_key: 'sk_9f2c8a1b4d6e7f0a2b3c4d5e6f7a8b9c', status: 'active', note: '主力产品', lic_count: 186 },
    { id: 'app_2', name: '示例下载器', slug: 'demo-dl', prefix: 'CMIC', server_key: 'sk_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d', status: 'active', note: '', lic_count: 74 },
    { id: 'app_3', name: '示例订阅工具', slug: 'demo-sub', prefix: 'NODE', server_key: 'sk_aa11bb22cc33dd44ee55ff6677889900', status: 'disabled', note: '暂停维护', lic_count: 32 },
  ];

  const PLANS = [
    { id: 'plan_1', app_id: 'app_1', app_name: '示例工具 Pro', name: '月卡', duration_mode: 'from_activation', duration_days: 30, max_devices: 1, verify_limit: 100, features: { pro: true }, afdian_plan_id: 'afd_a45353328af911eb', afdian_sku_id: '', afdian_type: 'plan', msg_template: '', status: 'active', note: '', lic_count: 120 },
    { id: 'plan_2', app_id: 'app_1', app_name: '示例工具 Pro', name: '年卡', duration_mode: 'from_activation', duration_days: 365, max_devices: 3, verify_limit: 100, features: { pro: true, export: true }, afdian_plan_id: 'afd_b6635a44b8f2', afdian_sku_id: '', afdian_type: 'plan', msg_template: '', status: 'active', note: '', lic_count: 66 },
    { id: 'plan_3', app_id: 'app_2', app_name: '漫画下载器', name: '永久版', duration_mode: 'lifetime', duration_days: null, max_devices: 2, verify_limit: 100, features: { pro: true }, afdian_plan_id: '', afdian_sku_id: 'sku_436eba6ce9', afdian_type: 'sku', msg_template: '', status: 'active', note: '售卖型商品', lic_count: 74 },
  ];

  const LICENSES = [
    { id: 'lic_1', key: 'DEMO-R73Z-HZRX-NTQV-9K3R-0RK3-1', app_id: 'app_1', app_name: '示例工具 Pro', plan_name: '年卡', duration_mode: 'from_activation', duration_days: 365, activated_at: now - 40 * D, expires_at: now + 325 * D, max_devices: 3, device_count: 2, features: { pro: true, export: true }, status: 'active', source: 'afdian', note: '', created_at: now - 41 * D },
    { id: 'lic_2', key: 'DEMO-KWWM-CEQB-QFS0-2NV9-MCDG-R', app_id: 'app_1', app_name: '示例工具 Pro', plan_name: '月卡', duration_mode: 'from_activation', duration_days: 30, activated_at: now - 25 * D, expires_at: now + 5 * D, max_devices: 1, device_count: 1, features: { pro: true }, status: 'active', source: 'afdian', note: '', created_at: now - 26 * D },
    { id: 'lic_3', key: 'DEMO-9K3M-7XQP-2RTW-H5NZ-A8F2-B', app_id: 'app_1', app_name: '示例工具 Pro', plan_name: '月卡', duration_mode: 'from_activation', duration_days: 30, activated_at: now - 20 * D, expires_at: now - 1 * D, max_devices: 1, device_count: 1, features: { pro: true }, status: 'active', source: 'manual', note: '老客户', created_at: now - 50 * D },
    { id: 'lic_4', key: 'CMIC-2Q7Y-VN4K-J8WD-6MFB-P3ZC-9', app_id: 'app_2', app_name: '漫画下载器', plan_name: '永久版', duration_mode: 'lifetime', duration_days: null, activated_at: now - 90 * D, expires_at: null, max_devices: 2, device_count: 1, features: { pro: true }, status: 'active', source: 'afdian', note: '', created_at: now - 90 * D },
    { id: 'lic_5', key: 'NODE-H4TX-8WJR-5DQN-3KZB-7YVG-2', app_id: 'app_3', app_name: '节点订阅工具', plan_name: '月卡', duration_mode: 'from_activation', duration_days: 30, activated_at: null, expires_at: null, max_devices: 1, device_count: 0, features: {}, status: 'banned', source: 'manual', note: '共享倒卖，已封禁', created_at: now - 7 * D },
  ];

  const CRON_DAYS = [0, 0, 1, 2, 3];
  const ORDERS = [
    { out_trade_no: '202610261038455397541020050', amount: '29.90', plan_name: '年卡', key: LICENSES[0].key, license_id: 'lic_1', issue_type: 'renew', product_type: 0, delivery: 'sent', created_at: now - 3 * 3600 },
    { out_trade_no: '202610252011234567890123456', amount: '9.90', plan_name: '月卡', key: LICENSES[1].key, license_id: 'lic_2', issue_type: 'new', product_type: 0, delivery: 'sent', created_at: now - 30 * 3600 },
    { out_trade_no: '202610242109876543210987654', amount: '9.90', plan_name: '', key: '', license_id: null, issue_type: null, product_type: 0, delivery: 'unmatched', created_at: now - 54 * 3600 },
    { out_trade_no: '202610241500111122223333444', amount: '199.00', plan_name: '永久版', key: LICENSES[3].key, license_id: 'lic_4', issue_type: 'new', product_type: 1, delivery: 'failed', delivery_error: '爱发电接口 400004：token 无效', created_at: now - 60 * 3600 },
  ];

  const BATCHES = [
    { id: 'bat_a1b2c3d4', app_name: '示例工具 Pro', plan_name: '月卡', prefix: 'DEMO', count: 50, note: '双十一备货', created_at: now - 5 * D },
    { id: 'bat_e5f6g7h8', app_name: '漫画下载器', plan_name: '永久版', prefix: 'CMIC', count: 20, note: '', created_at: now - 20 * D },
  ];

  const list = (arr) => ({ ok: true, list: arr });

  window.__DEMO_API = function (path, method) {
    if (path === 'me') return { ok: true, actor: '演示账号' };
    if (path === 'authmode') return { ok: true, mode: 'both', access: true };

    if (path === 'stats') {
      return {
        ok: true,
        licenses: { total: 292, lifetime: 74, banned: 3, expired: 21, unactivated: 18 },
        devices: 231,
        orders: { total: 186, unmatched: 1, failed: 1 },
        today_new: 6,
        queue_pending: 2,
        quota: { day: '2026-10-26', used: 8412, limit: 100000, percent: 8.4, level: 0 },
        env: { auth_mode: 'both', access_configured: true, afdian_configured: true },
      };
    }

    if (path === 'quota') return { ok: true, used: 8412, limit: 100000, percent: 8.4, level: 0 };
    if (path === 'apps') return list(APPS);
    if (path === 'plans') return list(PLANS);
    if (path === 'batches') return list(BATCHES);

    if (path.startsWith('licenses/')) {
      const id = path.slice(9);
      const l = LICENSES.find((x) => x.id === id) || LICENSES[0];
      return {
        ok: true,
        license: { ...l, features: l.features },
        devices:
          l.device_count > 0
            ? Array.from({ length: l.device_count }).map((_, i) => ({
                id: 'dev_' + i,
                label: i === 0 ? 'Windows-PC' : 'DESKTOP-' + (i + 1) + 'AB',
                first_seen: l.activated_at || now - 10 * D,
                last_seen: now - i * 3600,
              }))
            : [],
      };
    }

    if (path.startsWith('licenses')) {
      return {
        ok: true,
        list: LICENSES.map((l) => ({
          ...l,
          eff_status: l.status === 'banned' ? 'banned' : l.expires_at && l.expires_at < now ? 'expired' : 'active',
          expires_text: fmt(l.expires_at),
        })),
        total: LICENSES.length,
        page: 1,
        size: 50,
      };
    }

    if (path.startsWith('orders')) return { ok: true, list: ORDERS, total: ORDERS.length, page: 1 };

    if (path === 'settings') {
      return {
        ok: true,
        site_name: '授权中心',
        msg_template: '感谢你的支持！\n\n你的授权码：{key}\n套餐：{plan}\n有效期：{expires}\n\n在软件中输入授权码即可激活。',
        claim_hint: '',
        rate: {
          profile: 'normal',
          bad_key_limit: 20,
          today_blocked: 7,
          presets: [
            {
              id: 'loose',
              label: '宽松',
              desc: '用户多、或者用户在共享网络（公司/校园/移动网络）下时选这档',
              verify: 300,
              status: 60,
              claim: 40,
              unbind: 20,
              srv: 600,
            },
            {
              id: 'normal',
              label: '标准',
              desc: '默认档位，绝大多数情况用这个',
              verify: 120,
              status: 30,
              claim: 20,
              unbind: 10,
              srv: 300,
            },
            {
              id: 'strict',
              label: '严格',
              desc: '被刷过、或者用户量很少想收紧时选',
              verify: 60,
              status: 15,
              claim: 10,
              unbind: 5,
              srv: 150,
            },
          ],
        },
        env: {
          auth_mode: 'both',
          access_configured: true,
          afdian_configured: true,
          token_ttl_hours: '24',
          unbind_cooldown: '30',
          allow_unsigned: false,
        },
      };
    }

    if (path === 'pubkey') {
      return {
        ok: true,
        alg: 'RS256',
        public_key:
          '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA(演示数据，\n非真实公钥)wwdaCg1Bt+UKZKs0R54ylYnuANma49IpgoOwNmk3a0rhg/PQuhUJ\n0EOZSowIC44l0K3+fqGns3Ygi4AfmEfS4EKbdk1ahSxu7Zkp2rHMt+R9GarQFQkw\n-----END PUBLIC KEY-----',
      };
    }

    // 写操作一律返回成功
    if (method !== 'GET') {
      if (path.includes('reissue')) return { ok: true, key: 'DEMO-NEW9-KEY2-GEN3-ERAT-4ED5-X', old_key: LICENSES[0].key };
      if (path.includes('batch')) return { ok: true, batch_id: 'bat_demo01', keys: ['DEMO-DEMO-AAAA-BBBB-CCCC-1', 'DEMO-DEMO-AAAA-BBBB-CCCC-2'], count: 2 };
      if (path.includes('renew')) return { ok: true, duration_days: 60, expires_at: now + 60 * D };
      if (path.includes('sync')) return { ok: true, scanned: 50, added: 0, renewed: 0, pages: 1 };
      return { ok: true };
    }

    return { ok: true };
  };

  /* 调试用：?demo=1&drawer=1 直接展开移动端侧栏，方便截图检查 */
  if (new URLSearchParams(location.search).has('drawer')) {
    let n = 0;
    const t2 = setInterval(() => {
      const btn = document.querySelector('#btn-menu');
      if (btn) { btn.click(); clearInterval(t2); }
      else if (++n > 60) clearInterval(t2);
    }, 50);
  }

  /* 调试用：?demo=1&view=licenses 可直接落到某个页面，方便逐个截图检查 */
  const v = new URLSearchParams(location.search).get('view');
  if (v) {
    // bootAdmin 是异步的，得等它渲染完再切，否则会被覆盖回概览
    let tries = 0;
    const timer = setInterval(() => {
      if (typeof state !== 'undefined' && typeof renderAdmin === 'function' && document.querySelector('#view')) {
        state.view = v;
        renderAdmin();
        clearInterval(timer);
      } else if (++tries > 60) {
        clearInterval(timer);
      }
    }, 50);
  }
})();
