/* 授权中心 —— 零构建前端，公开页与管理台共用 */

const $ = (s, r = document) => r.querySelector(s);
const DEMO = new URLSearchParams(location.search).has('demo');
const isAdmin = () => DEMO || location.pathname.replace(/\/+$/, '').startsWith('/admin');

/* ---------------- 通用工具 ---------------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(ts) {
  if (!ts) return '永久';
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function tsToInput(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const inputToTs = (v) => (v ? Math.floor(new Date(v).getTime() / 1000) : null);

let toastTimer;
function toast(msg, isErr) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 2600);
}

async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
    toast('已复制');
  } catch {
    toast('复制失败，请手动选中', true);
  }
}

function openModal({ title, body, okText = '保存', onOk }) {
  $('#modal-root').innerHTML = `
    <div class="mask" id="mask">
      <div class="modal">
        <div class="modal-head">${esc(title)}</div>
        <form id="mform">
          <div class="modal-body">${body}</div>
          <div class="modal-foot">
            <button type="button" class="btn" id="mcancel">取消</button>
            <button type="submit" class="btn btn-primary">${esc(okText)}</button>
          </div>
        </form>
      </div>
    </div>`;
  const close = () => ($('#modal-root').innerHTML = '');
  $('#mcancel').onclick = close;
  $('#mask').onclick = (e) => { if (e.target.id === 'mask') close(); };
  $('#mform').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#mform button[type=submit]');
    btn.disabled = true;
    try {
      const r = await onOk(new FormData(e.target));
      if (r !== false) close();
    } catch (err) {
      toast(err.message || '操作失败', true);
    } finally {
      btn.disabled = false;
    }
  };
}

/* ---------------- API ---------------- */

const API = {
  token: localStorage.getItem('ak_token') || '',
  async call(path, { method = 'GET', body } = {}) {
    // 演示模式：走内置假数据，不请求后端（?demo=1）
    if (window.__DEMO_API) return window.__DEMO_API(path, method, body);
    const headers = {};
    if (body) headers['content-type'] = 'application/json';
    if (this.token) headers['authorization'] = 'Bearer ' + this.token;
    const res = await fetch('/admin/api/' + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      const e = new Error('UNAUTHORIZED');
      e.code = 401;
      throw e;
    }
    const data = await res.json().catch(() => null);
    // 业务错误统一在这里抛出，避免调用方拿到 {ok:false} 还当成功用。
    // 典型症状：额度熔断返回 {ok:false,code:'QUOTA_TIGHT'} 时，列表页会显示
    // 「共 undefined 条 / 没有符合条件的授权码」，把「被限流」伪装成「数据没了」。
    if (data && data.ok === false) {
      const e = new Error(data.message || data.code || '请求失败');
      e.code = data.code;
      e.data = data;
      throw e;
    }
    return data;
  },
};

/* ============================================================
   公开页
   ============================================================ */

function renderPublic() {
  document.title = '授权中心';
  $('#root').innerHTML = `
    <div class="wrap">
      <div class="brand" style="margin-bottom:22px">
        <div class="brand-dot"></div><span>授权中心</span>
      </div>

      <div class="tabs">
        <div class="tab active" data-tab="query">查询授权</div>
        <div class="tab" data-tab="claim">订单取码</div>
      </div>

      <div class="card card-pad">
        <div id="pane-query">
          <h1>查询我的授权</h1>
          <p class="sub" style="margin-bottom:16px">输入授权码可查看有效期与已绑定设备，并自助解绑旧设备。</p>
          <form id="f-query">
            <label class="field"><span>授权码</span>
              <input type="text" name="key" class="mono" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-X" autocomplete="off" />
            </label>
            <button class="btn btn-primary" type="submit">查询</button>
          </form>
          <div class="result" id="r-query"></div>
        </div>

        <div id="pane-claim" style="display:none">
          <h1>没收到授权码？</h1>
          <p class="sub" style="margin-bottom:16px">输入爱发电订单号，系统会把授权码重新发送到你的爱发电私信。</p>
          <form id="f-claim">
            <label class="field"><span>爱发电订单号</span>
              <input type="text" name="order" class="mono" placeholder="20261026xxxxxxxxxxxx" autocomplete="off" />
            </label>
            <button class="btn btn-primary" type="submit">重新发送授权码</button>
          </form>
          <div class="result" id="r-claim"></div>
        </div>
      </div>

      <p class="sub" style="text-align:center;margin-top:22px">遇到问题请联系作者</p>
    </div>`;

  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      $('#pane-query').style.display = t.dataset.tab === 'query' ? '' : 'none';
      $('#pane-claim').style.display = t.dataset.tab === 'claim' ? '' : 'none';
    };
  });

  $('#f-query').onsubmit = async (e) => {
    e.preventDefault();
    const key = new FormData(e.target).get('key').trim();
    if (!key) return;
    const box = $('#r-query');
    box.innerHTML = '<p class="sub">查询中…</p>';
    try {
      const r = await fetch('/api/v1/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key }),
      }).then((x) => x.json());
      box.innerHTML = renderStatus(r, key);
      const btn = $('#btn-unbind');
      if (btn) btn.onclick = () => doUnbind(key);
    } catch {
      box.innerHTML = '<div class="alert alert-err">网络错误，请稍后再试</div>';
    }
  };

  $('#f-claim').onsubmit = async (e) => {
    e.preventDefault();
    const order = new FormData(e.target).get('order').trim();
    if (!order) return;
    const box = $('#r-claim');
    box.innerHTML = '<p class="sub">查询中…</p>';
    try {
      const r = await fetch('/api/v1/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ out_trade_no: order }),
      }).then((x) => x.json());

      if (!r.ok) {
        box.innerHTML = `<div class="alert alert-warn">${esc(r.message || '未找到')}</div>`;
        return;
      }
      box.innerHTML = `
        <div class="card card-pad" style="margin-top:4px">
          <div class="alert alert-info" style="margin:0 0 10px">${esc(r.message || '授权码已发送')}</div>
          <p class="sub" style="margin:0">
            请打开爱发电 App 或网页版，在「消息 / 私信」里查看。若几分钟内仍未收到，可稍后重试或联系作者。
          </p>
        </div>`;
    } catch {
      box.innerHTML = '<div class="alert alert-err">网络错误，请稍后再试</div>';
    }
  };
}

function renderStatus(r, key) {
  if (!r.ok) return `<div class="alert alert-err">${esc(r.message || '查询失败')}</div>`;

  const map = {
    active: ['正常', 'tag-ok'],
    expired: ['已过期', 'tag-danger'],
    banned: ['已封禁', 'tag-danger'],
    revoked: ['已吊销', 'tag-danger'],
    app_disabled: ['软件已停用', 'tag-danger'],
  };
  const [txt, cls] = map[r.status] || [r.status, 'tag-mute'];

  const exp =
    r.duration_mode === 'lifetime'
      ? '永久有效'
      : r.expires_at
        ? fmtTime(r.expires_at)
        : r.activated_at === null || r.activated_at === undefined
          ? '未激活（首次激活后开始计时）'
          : '-';

  const devs = (r.devices || [])
    .map(
      (d) =>
        `<div class="dev-item"><div><div style="font-weight:520">${esc(d.label)}</div>
         <div class="sub" style="font-size:12px">最近使用 ${fmtTime(d.last_seen)}</div></div>
         <span class="tag tag-mute">槽位 ${d.slot}</span></div>`
    )
    .join('') || '<p class="sub" style="padding:8px 0">尚未绑定任何设备</p>';

  return `
    <div class="card card-pad" style="margin-top:4px">
      <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:6px">
        <div class="key-cell">${esc(key.toUpperCase())}</div>
        <span class="tag ${cls}">${txt}</span>
      </div>
      <div class="kv"><div class="k">软件</div><div class="v">${esc(r.app || '-')}</div></div>
      <div class="kv"><div class="k">有效期</div><div class="v">${esc(exp)}</div></div>
      <div class="kv"><div class="k">设备上限</div><div class="v">${r.max_devices} 台，已绑 ${(r.devices || []).length} 台</div></div>
      <div style="margin-top:14px">
        <p style="font-size:12.5px;color:var(--muted);margin:0 0 6px;font-weight:500">已绑定设备</p>
        ${devs}
      </div>
      ${
        r.can_self_unbind && r.status === 'active'
          ? `<button class="btn btn-danger" id="btn-unbind" style="margin-top:16px">解绑全部设备</button>
             <p class="sub" style="margin-top:8px;font-size:12px">换电脑/重装系统后用这个。每 ${r.unbind_cooldown || 30} 天限一次。</p>`
          : ''
      }
    </div>`;
}

async function doUnbind(key) {
  if (!confirm('确认解绑全部设备？解绑后需要在当前设备重新激活。')) return;
  try {
    const r = await fetch('/api/v1/unbind', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    }).then((x) => x.json());
    if (r.ok) {
      toast('已解绑');
      $('#f-query').dispatchEvent(new Event('submit'));
    } else {
      toast(r.message || '解绑失败', true);
    }
  } catch {
    toast('网络错误', true);
  }
}

/* ============================================================
   管理台
   ============================================================ */

const state = {
  view: 'dashboard',
  me: null,
  needLogin: false,
  authMode: 'both',
  apps: [],
  plans: [],
  afdianPlans: [],
  settings: null,
  licPage: 1,
  licFilter: { app_id: '', status: '', q: '' },
  ordFilter: { delivery: '', q: '' },
  ordPage: 1,
};

/* 导航图标：内联 SVG，避免几何字符在不同字体下渲染不一致 */
const ico = (d) =>
  `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

const NAV = [
  ['dashboard', ico('<rect x="2" y="2" width="5" height="5" rx="1.2"/><rect x="9" y="2" width="5" height="5" rx="1.2"/><rect x="2" y="9" width="5" height="5" rx="1.2"/><rect x="9" y="9" width="5" height="5" rx="1.2"/>'), '概览'],
  ['licenses', ico('<circle cx="5.2" cy="8" r="2.9"/><path d="M8.1 8h5.4M11.2 8v2.1M13.2 8v1.5"/>'), '授权码'],
  ['batch', ico('<rect x="2.2" y="2.2" width="7.2" height="7.2" rx="1.7"/><rect x="6.6" y="6.6" width="7.2" height="7.2" rx="1.7"/>'), '批量生成'],
  ['apps', ico('<path d="M8 1.9l5.3 3v6.2L8 14.1 2.7 11.1V4.9z"/><path d="M2.7 4.9L8 7.9l5.3-3M8 7.9v6.2"/>'), '软件'],
  ['plans', ico('<path d="M2 2.6h4.8l6.6 6.6a1.5 1.5 0 0 1 0 2.1l-2.2 2.2a1.5 1.5 0 0 1-2.1 0L2.6 7.4z"/><circle cx="5.1" cy="5.7" r=".9"/>'), '套餐'],
  ['orders', ico('<path d="M9.2 1.8H4.6A1.6 1.6 0 0 0 3 3.4v9.2a1.6 1.6 0 0 0 1.6 1.6h6.8a1.6 1.6 0 0 0 1.6-1.6V5.6z"/><path d="M9.2 1.8v3.8H13"/><path d="M5.6 9h4.8M5.6 11.4h3.2"/>'), '订单'],
  ['batches', ico('<path d="M8 2l6 3.1-6 3.1-6-3.1z"/><path d="M2 8.1l6 3.1 6-3.1"/><path d="M2 11.2l6 3.1 6-3.1"/>'), '批次'],
  ['settings', ico('<circle cx="8" cy="8" r="2.1"/><path d="M8 1.7v1.9M8 12.4v1.9M1.7 8h1.9M12.4 8h1.9M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3"/>'), '设置'],
];

async function bootAdmin() {
  try {
    const m = await API.call('me');
    state.me = m.actor;
    // me 顺带返回鉴权模式：authmode=none 时要在页头挂常驻警告
    state.authMode = m.mode || 'both';
    state.needLogin = false;
  } catch (e) {
    if (e.code === 401) {
      const am = await fetch('/admin/api/authmode').then((r) => r.json()).catch(() => ({ mode: 'both' }));
      state.authMode = am.mode || 'both';
      state.needLogin = true;
    }
  }
  renderAdmin();
  if (!state.needLogin) loadCommon();
}

async function loadCommon() {
  try {
    const [a, p, s] = await Promise.all([API.call('apps'), API.call('plans'), API.call('settings')]);
    state.apps = a.list || [];
    state.plans = p.list || [];
    state.settings = s;
    if (state.view === 'batch' || state.view === 'plans') renderView();
  } catch { /* ignore */ }
}

/* 表格横向溢出时给一张提示条。
   窄屏下表格必然要横向滚（列多），但用户常常不知道右边还有内容。
   用 MutationObserver 统一监听，省得每个列表函数各调一遍。 */
let _scrollRaf = 0;
let _scrollTimer = 0;
function markScrollable() {
  const calc = () => {
    document.querySelectorAll('.table-scroll').forEach((el) => {
      const card = el.closest('.table-card');
      const table = el.querySelector('table');
      if (!card || !table) return;
      // 用表格实际宽度和容器宽度比，比 scrollWidth 稳（scrollWidth 受滚动条/亚像素影响会误判）
      const overflow = table.getBoundingClientRect().width - el.clientWidth;
      // 容差 24px：桌面宽屏下常有几像素的舍入溢出，那种不需要提示
      card.classList.toggle('has-scroll', overflow > 24);
    });
  };
  cancelAnimationFrame(_scrollRaf);
  clearTimeout(_scrollTimer);
  _scrollRaf = requestAnimationFrame(calc);
  _scrollTimer = setTimeout(calc, 240); // 字体/布局稳定后再算一次
}

// 只注册一次。#root 元素本身不会被替换（renderAdmin 只改它的 innerHTML），
// 所以 observer 挂一次就够。之前每次 renderAdmin 都新建一个且从不 disconnect，
// 逛 10 个视图就是 10 个 observer 同时跑 markScrollable，每次表格刷新触发 10 次强制回流。
let _tablesWatched = false;
let _escBound = false;
function watchTables() {
  if (_tablesWatched) {
    markScrollable();
    return;
  }
  const root = $('#root');
  if (!root) return;
  _tablesWatched = true;
  new MutationObserver(markScrollable).observe(root, { childList: true, subtree: true });
  window.addEventListener('resize', markScrollable);
  markScrollable();
}

function renderAdmin() {
  document.title = 'Key 管理台';

  if (state.needLogin) {
    $('#root').innerHTML = `
      <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px">
        <div class="card card-pad" style="width:100%;max-width:380px">
          <div class="brand" style="margin-bottom:18px"><div class="brand-dot"></div><span>Key 管理台</span></div>
          ${
            state.authMode === 'access'
              ? `<div class="alert alert-warn">当前为 Cloudflare Access 模式但未通过验证。<br>请确认已为 <code>/admin</code> 配置 Access 策略，或改用口令模式。</div>`
              : `<form id="f-login">
                   <label class="field"><span>管理员口令</span>
                     <input type="password" name="password" autocomplete="current-password" autofocus />
                   </label>
                   <button class="btn btn-primary" style="width:100%" type="submit">登录</button>
                 </form>`
          }
          <p class="sub" style="margin-top:14px;text-align:center">
            <a href="/">返回查询页</a>
          </p>
        </div>
      </div>`;

    const f = $('#f-login');
    if (f) {
      f.onsubmit = async (e) => {
        e.preventDefault();
        const password = new FormData(e.target).get('password');
        try {
          const r = await fetch('/admin/api/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password }),
          }).then((x) => x.json());
          if (r.ok) {
            API.token = r.token;
            localStorage.setItem('ak_token', r.token);
            state.needLogin = false;
            bootAdmin();
          } else {
            toast(r.message || '登录失败', true);
          }
        } catch {
          toast('网络错误', true);
        }
      };
    }
    return;
  }

  $('#root').innerHTML = `
    <div class="shell">
      <aside class="side" id="side">
        <div class="side-head">
          <div class="brand"><div class="brand-dot"></div><span>Key 管理台</span></div>
          <button class="btn btn-ghost side-close" id="side-close" aria-label="关闭菜单">
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8"/>
            </svg>
          </button>
        </div>
        ${NAV.map(
          ([id, ico, label]) =>
            `<div class="nav-item ${state.view === id ? 'active' : ''}" data-nav="${id}">
               <span class="ico">${ico}</span><span>${label}</span></div>`
        ).join('')}
        <div class="side-foot">
          <div>${esc(state.me || '')}</div>
          <a href="/" style="font-size:12px">查看用户页 ↗</a>
        </div>
      </aside>
      <div class="side-mask" id="side-mask"></div>
      <main class="main">
        <div class="topbar">
          <div class="topbar-left">
            <button class="btn btn-ghost btn-menu" id="btn-menu" aria-label="打开菜单" aria-expanded="false">
              <svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
                <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/>
              </svg>
            </button>
            <h1 id="page-title"></h1>
          </div>
          <div class="row" id="page-actions"></div>
        </div>
        ${
          state.authMode === 'none'
            ? `<div class="alert alert-err" style="margin:0 0 14px">
                 <b>⚠️ 当前无鉴权（AUTH_MODE=none）</b><br>
                 任何知道本地址的人都能查看全部授权码、生成新码、导出数据、修改配置。<br>
                 正式上线前请配置 Cloudflare Access，并把 <code>AUTH_MODE</code> 改回
                 <code>access</code> 或 <code>both</code>。
               </div>`
            : ''
        }
        <div id="view"></div>
      </main>
    </div>`;

  // 移动端 / 平板的侧边栏抽屉
  const side = $('#side');
  const mask = $('#side-mask');
  const menuBtn = $('#btn-menu');
  const setDrawer = (open) => {
    side.classList.toggle('open', open);
    mask.classList.toggle('show', open);
    if (menuBtn) menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.body.classList.toggle('no-scroll', open);
  };
  if (menuBtn) menuBtn.onclick = () => setDrawer(!side.classList.contains('open'));
  if (mask) mask.onclick = () => setDrawer(false);
  if ($('#side-close')) $('#side-close').onclick = () => setDrawer(false);

  // Esc 收起抽屉：只绑一次。原来每次 renderAdmin 都 addEventListener，
  // 逛 N 个视图就累加 N 个监听，且闭包捕获的是已被替换掉的旧 DOM。
  // 这里改成监听器内部动态查元素，任何时刻都作用于当前 DOM。
  if (!_escBound) {
    _escBound = true;
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const s = $('#side');
      const m = $('#mask');
      if (s) s.classList.remove('open');
      if (m) m.classList.remove('show');
      const mb = $('#menu-btn');
      if (mb) mb.setAttribute('aria-expanded', 'false');
      document.body.classList.remove('no-scroll');
    });
  }

  document.querySelectorAll('[data-nav]').forEach((el) => {
    el.onclick = () => {
      state.view = el.dataset.nav;
      setDrawer(false); // 手机和平板上选完自动收起
      renderAdmin(); // 内部已调用 renderView，不要再重复调用，否则每个页面会发两次请求
    };
  });

  renderView();
  watchTables();
}

function renderView() {
  const t = $('#page-title');
  if (!t) return;
  const titles = {
    dashboard: '概览',
    licenses: '授权码',
    batch: '批量生成',
    apps: '软件 / 产品线',
    plans: '套餐',
    orders: '爱发电订单',
    batches: '生成批次',
    settings: '设置',
  };
  t.textContent = titles[state.view] || '';
  $('#page-actions').innerHTML = '';

  const fn = {
    dashboard: viewDashboard,
    licenses: viewLicenses,
    batch: viewBatch,
    apps: viewApps,
    plans: viewPlans,
    orders: viewOrders,
    batches: viewBatches,
    settings: viewSettings,
  }[state.view];
  if (fn) fn();
}

/* ---------------- 概览 ---------------- */

async function viewDashboard() {
  const box = $('#view');
  box.innerHTML = '<p class="sub">加载中…</p>';
  try {
    const s = await API.call('stats');
    const L = s.licenses || {};
    const q = s.quota || { used: 0, percent: 0, level: 0 };
    const qColor =
      q.percent >= 97 ? 'var(--danger)' : q.percent >= 92 ? '#d97706' : q.percent >= 70 ? 'var(--warn)' : 'var(--ok)';
    const qHint =
      q.percent >= 97
        ? '已达上限，仅 webhook 放行；北京时间 0 点恢复。'
        : q.percent >= 92
          ? '公开 API 已降级，仅 webhook 正常。'
          : q.percent >= 70
            ? '管理台开始限流，建议减少刷新。'
            : '额度充足。';
    box.innerHTML = `
      <div class="stat-grid">
        <div class="stat"><div class="k">授权码总数</div><div class="v">${L.total || 0}</div></div>
        <div class="stat"><div class="k">今日新增</div><div class="v">${s.today_new || 0}</div></div>
        <div class="stat"><div class="k">已过期</div><div class="v">${L.expired || 0}</div></div>
        <div class="stat"><div class="k">已封禁</div><div class="v">${L.banned || 0}</div></div>
        <div class="stat"><div class="k">绑定设备</div><div class="v">${s.devices || 0}</div></div>
        <div class="stat"><div class="k">待发私信</div><div class="v" style="color:${s.queue_pending ? 'var(--warn)' : 'inherit'}">${s.queue_pending || 0}</div></div>
      </div>

      <div class="card card-pad" style="margin-bottom:16px">
        <div class="row" style="justify-content:space-between;align-items:baseline">
          <h2 style="margin:0">今日 Worker 请求</h2>
          <span class="sub">${q.used.toLocaleString()} / 100,000 · ${q.percent}%</span>
        </div>
        <div style="height:10px;background:var(--surface-3);border-radius:5px;overflow:hidden;margin-top:10px">
          <div style="height:100%;width:${Math.min(100, q.percent)}%;background:${qColor};border-radius:5px;transition:width .3s"></div>
        </div>
        <p class="sub" style="margin-top:8px;font-size:12px">${qHint}</p>
      </div>

      ${
        s.orders?.unmatched
          ? `<div class="alert alert-warn">有 ${s.orders.unmatched} 笔订单未匹配到套餐，去「订单」页手工发码。</div>`
          : ''
      }
      ${s.orders?.failed ? `<div class="alert alert-err">有 ${s.orders.failed} 笔订单私信发送失败，去「订单」页重试。</div>` : ''}

      <div class="card card-pad">
        <h2>快速开始</h2>
        <p class="sub" style="margin-bottom:14px">顺序：建软件 → 建套餐（填爱发电 ID）→ 配 Webhook → 卖货自动发码。</p>
        <div class="row">
          <button class="btn btn-primary" onclick="state.view='apps';renderAdmin()">新建软件</button>
          <button class="btn" onclick="state.view='batch';renderAdmin()">批量生成</button>
          <button class="btn" onclick="state.view='orders';renderAdmin()">查看订单</button>
        </div>
      </div>

      <div class="card card-pad" style="margin-top:14px">
        <h2>接入信息</h2>
        <div class="kv"><div class="k">Webhook</div><div class="v mono">https://${esc(location.host)}/webhook/afdian</div></div>
        <div class="kv"><div class="k">验证接口</div><div class="v mono">https://${esc(location.host)}/api/v1/verify</div></div>
        <div class="kv"><div class="k">公钥</div><div class="v mono">https://${esc(location.host)}/api/v1/pubkey</div></div>
        <div class="kv"><div class="k">鉴权方式</div><div class="v">${esc(s.env?.auth_mode || '—')}${s.env?.access_configured ? '（Access 已配置）' : ''}</div></div>
        <div class="kv"><div class="k">爱发电 API</div><div class="v">${s.env?.afdian_configured ? '<span class="tag tag-ok">已配置</span>' : '<span class="tag tag-danger">未配置</span>'}</div></div>
      </div>`;
  } catch {
    box.innerHTML = '<div class="alert alert-err">加载失败</div>';
  }
}

/* ---------------- 授权码 ---------------- */

async function viewLicenses() {
  const box = $('#view');
  $('#page-actions').innerHTML = `
    <button class="btn" id="btn-new-lic">生成单个</button>
    <button class="btn" id="btn-export">导出 CSV</button>`;

  const appOpts = state.apps.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  box.innerHTML = `
    <div class="toolbar">
      <select id="f-app"><option value="">全部软件</option>${appOpts}</select>
      <select id="f-status">
        <option value="">全部状态</option>
        <option value="active">正常</option>
        <option value="unactivated">未激活</option>
        <option value="expired">已过期</option>
        <option value="banned">已封禁</option>
        <option value="revoked">已吊销</option>
      </select>
      <input type="text" id="f-q" placeholder="搜授权码 / 备注 / 订单号" />
      <div class="spacer"></div>
      <span class="sub" id="lic-count"></span>
    </div>
    <div class="table-card"><div class="table-scroll"><table>
      <thead><tr>
        <th>授权码</th><th>软件</th><th>套餐</th><th>状态</th><th>到期</th><th>设备</th><th>来源</th><th style="width:150px"></th>
      </tr></thead>
      <tbody id="lic-body"><tr><td colspan="8" class="empty">加载中…</td></tr></tbody>
    </table></div>
    <div class="pager" id="lic-pager"></div></div>`;

  $('#f-app').value = state.licFilter.app_id;
  $('#f-status').value = state.licFilter.status;
  $('#f-q').value = state.licFilter.q;

  const reload = () => {
    state.licFilter = { app_id: $('#f-app').value, status: $('#f-status').value, q: $('#f-q').value.trim() };
    state.licPage = 1;
    loadLicenses();
  };
  $('#f-app').onchange = reload;
  $('#f-status').onchange = reload;
  $('#f-q').onkeydown = (e) => { if (e.key === 'Enter') reload(); };
  $('#btn-new-lic').onclick = () => modalNewLic();
  $('#btn-export').onclick = exportCsv;

  loadLicenses();
}

async function loadLicenses() {
  const body = $('#lic-body');
  if (!body) return;
  const q = new URLSearchParams({
    page: state.licPage,
    size: 50,
    ...Object.fromEntries(Object.entries(state.licFilter).filter(([, v]) => v)),
  });
  let r;
  try {
    r = await API.call('licenses?' + q.toString());
  } catch (e) {
    // 401 交给全局处理；其余（含额度熔断）在表格里明确显示，不要伪装成「没有数据」
    if (e.code === 401) return;
    body.innerHTML = `<tr><td colspan="8" class="empty" style="color:var(--danger)">加载失败：${esc(
      e.message || e,
    )}</td></tr>`;
    const c = $('#lic-count');
    if (c) c.textContent = '加载失败';
    return;
  }
  const rows = r.list || [];
  $('#lic-count').textContent = `共 ${r.total} 条`;

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty">没有符合条件的授权码</td></tr>';
    $('#lic-pager').innerHTML = '';
    return;
  }

  const tag = (s) => {
    const m = { active: ['正常', 'tag-ok'], expired: ['已过期', 'tag-mute'], banned: ['已封禁', 'tag-danger'], revoked: ['已吊销', 'tag-danger'] };
    const [t, c] = m[s] || [s, 'tag-mute'];
    return `<span class="tag ${c}">${t}</span>`;
  };

  body.innerHTML = rows
    .map(
      (l) => `<tr>
      <td class="key-cell">${esc(l.key)}</td>
      <td>${esc(l.app_name || '-')}</td>
      <td>${esc(l.plan_name || '-')}</td>
      <td>${tag(l.eff_status)}</td>
      <td style="white-space:nowrap">${esc(l.expires_text)}</td>
      <td>${l.device_count}/${l.max_devices}</td>
      <td><span class="tag ${l.source === 'afdian' ? 'tag-info' : 'tag-mute'}">${l.source === 'afdian' ? '爱发电' : '手动'}</span></td>
      <td style="white-space:nowrap">
        <button class="btn btn-sm" data-detail="${l.id}">详情</button>
        <button class="btn btn-sm" data-renew="${l.id}">续期</button>
      </td>
    </tr>`
    )
    .join('');

  const pages = Math.max(1, Math.ceil(r.total / r.size));
  $('#lic-pager').innerHTML = `
    <button class="btn btn-sm" ${r.page <= 1 ? 'disabled' : ''} data-pg="${r.page - 1}">上一页</button>
    <span>${r.page} / ${pages}</span>
    <button class="btn btn-sm" ${r.page >= pages ? 'disabled' : ''} data-pg="${r.page + 1}">下一页</button>`;

  document.querySelectorAll('[data-pg]').forEach((b) => {
    b.onclick = () => { state.licPage = Number(b.dataset.pg); loadLicenses(); };
  });
  document.querySelectorAll('[data-detail]').forEach((b) => {
    b.onclick = () => modalLicDetail(b.dataset.detail);
  });
  document.querySelectorAll('[data-renew]').forEach((b) => {
    b.onclick = () => modalRenew(b.dataset.renew);
  });
}

function modalNewLic() {
  if (!state.apps.length) return toast('请先创建软件', true);
  const appOpts = state.apps.map((a) => `<option value="${a.id}" data-prefix="${esc(a.prefix)}">${esc(a.name)}</option>`).join('');

  openModal({
    title: '生成授权码',
    okText: '生成',
    body: `
      <label class="field"><span>所属软件</span><select name="app_id" id="m-app">${appOpts}</select></label>
      <div class="grid2">
        <label class="field"><span>套餐（可选）</span><select name="plan_id" id="m-plan"><option value="">不关联套餐</option></select></label>
        <label class="field"><span>前缀</span><input type="text" name="prefix" id="m-prefix" class="mono" /></label>
      </div>
      <div class="grid2">
        <label class="field"><span>期限模式</span>
          <select name="duration_mode" id="m-mode">
            <option value="from_activation">首次激活后 N 天</option>
            <option value="fixed">固定到期日</option>
            <option value="lifetime">永久</option>
          </select></label>
        <label class="field"><span>天数</span><input type="number" name="duration_days" value="30" min="1" /></label>
      </div>
      <label class="field" id="m-fixed-wrap" style="display:none"><span>固定到期时间</span>
        <input type="datetime-local" name="fixed_expires_at" /></label>
      <label class="field"><span>设备数上限</span><input type="number" name="max_devices" value="1" min="1" /></label>
      <label class="field"><span>备注</span><input type="text" name="note" placeholder="可选，方便自己记" /></label>`,
    onOk: async (fd) => {
      const body = {
        app_id: fd.get('app_id'),
        plan_id: fd.get('plan_id') || null,
        prefix: fd.get('prefix'),
        duration_mode: fd.get('duration_mode'),
        duration_days: Number(fd.get('duration_days') || 30),
        max_devices: Number(fd.get('max_devices') || 1),
        note: fd.get('note') || null,
        fixed_expires_at: inputToTs(fd.get('fixed_expires_at')),
      };
      const r = await API.call('licenses', { method: 'POST', body });
      if (!r.ok) throw new Error(r.message);
      toast('已生成：' + r.key);
      loadLicenses();
    },
  });

  const appSel = $('#m-app');
  const planSel = $('#m-plan');
  const syncPlan = () => {
    const app = state.apps.find((a) => a.id === appSel.value);
    $('#m-prefix').value = app ? app.prefix : '';
    const ps = state.plans.filter((p) => p.app_id === appSel.value);
    planSel.innerHTML = '<option value="">不关联套餐</option>' + ps.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  };
  appSel.onchange = syncPlan;
  syncPlan();

  $('#m-mode').onchange = (e) => {
    $('#m-fixed-wrap').style.display = e.target.value === 'fixed' ? '' : 'none';
  };
}

async function modalLicDetail(id) {
  const r = await API.call('licenses/' + id);
  if (!r.ok) return toast(r.message, true);
  const l = r.license;

  const devs = (r.devices || [])
    .map(
      (d) => `<div class="dev-item">
        <div><div style="font-weight:520">${esc(d.label || '未命名设备')}</div>
        <div class="sub" style="font-size:12px">首次 ${fmtTime(d.first_seen)} · 最近 ${fmtTime(d.last_seen)}</div></div>
        <button class="btn btn-sm btn-danger" data-kick="${d.id}">踢出</button></div>`
    )
    .join('') || '<p class="sub" style="padding:6px 0">尚未绑定设备</p>';

  openModal({
    title: '授权码详情',
    okText: '保存',
    body: `
      <label class="field"><span>授权码</span>
        <div class="key-big" style="font-size:14px;padding:10px">${esc(l.key)}</div>
      </label>
      <div class="row" style="margin-bottom:16px">
        <button type="button" class="btn btn-sm" id="btn-copy-key">复制</button>
        <button type="button" class="btn btn-sm" id="btn-ban">${l.status === 'banned' ? '解封' : '封禁'}</button>
        <button type="button" class="btn btn-sm" id="btn-reissue">换发</button>
        <button type="button" class="btn btn-sm btn-danger" id="btn-del">删除</button>
      </div>
      <div class="grid2">
        <label class="field"><span>状态</span>
          <select name="status">
            <option value="active" ${l.status === 'active' ? 'selected' : ''}>正常</option>
            <option value="banned" ${l.status === 'banned' ? 'selected' : ''}>封禁</option>
            <option value="revoked" ${l.status === 'revoked' ? 'selected' : ''}>吊销</option>
          </select></label>
        <label class="field"><span>设备上限</span><input type="number" name="max_devices" value="${l.max_devices}" min="1" /></label>
      </div>
      <div class="grid2">
        <label class="field"><span>期限天数</span><input type="number" name="duration_days" value="${l.duration_days ?? ''}" /></label>
        <label class="field"><span>到期时间</span><input type="datetime-local" name="expires_at" value="${tsToInput(l.expires_at)}" /></label>
      </div>
      <label class="field"><span>功能位 JSON（高级）</span>
        <textarea name="features" class="mono" placeholder='{"pro":true}'>${esc(JSON.stringify(l.features || {}, null, 2))}</textarea>
        <p class="sub" style="margin:-6px 0 14px;font-size:12px">留空 <code>{}</code> 表示不限功能。键名由客户端定义，客户端本地验签后读取。</p></label>
      <label class="field"><span>备注</span><input type="text" name="note" value="${esc(l.note || '')}" /></label>
      <div style="border-top:1px solid var(--border);margin:6px 0 12px"></div>
      <p style="font-size:12.5px;font-weight:560;margin:0 0 6px">已绑定设备（${(r.devices || []).length}/${l.max_devices}）</p>
      ${devs}`,
    onOk: async (fd) => {
      let features;
      try {
        features = JSON.parse(fd.get('features') || '{}');
      } catch {
        throw new Error('功能位不是合法 JSON');
      }
      const res = await API.call('licenses/' + id, {
        method: 'PATCH',
        body: {
          status: fd.get('status'),
          max_devices: Number(fd.get('max_devices') || 1),
          duration_days: fd.get('duration_days') ? Number(fd.get('duration_days')) : null,
          expires_at: inputToTs(fd.get('expires_at')),
          features,
          note: fd.get('note'),
        },
      });
      if (!res.ok) throw new Error(res.message);
      toast('已保存');
      loadLicenses();
    },
  });

  $('#btn-copy-key').onclick = () => copyText(l.key);
  $('#btn-reissue').onclick = async () => {
    if (
      !confirm(
        '换发会吊销当前授权码，并生成一枚新的。\n剩余时长、功能位、设备上限都会继承，但已绑定设备需要重新绑定。\n\n确认换发？'
      )
    )
      return;
    const res = await API.call(`licenses/${id}/reissue`, { method: 'POST' });
    if (!res.ok) return toast(res.message, true);
    $('#modal-root').innerHTML = '';
    openModal({
      title: '换发成功',
      okText: '完成',
      body: `
        <p class="sub" style="margin-bottom:10px">旧授权码已吊销，请把新授权码发给买家：</p>
        <div class="key-big">${esc(res.key)}</div>
        <div class="kv" style="margin-top:12px"><div class="k">旧授权码</div>
          <div class="v mono" style="text-decoration:line-through;color:var(--muted)">${esc(res.old_key)}</div></div>
        <p class="sub" style="margin-top:12px">买家需要在软件里重新输入新授权码，并重新绑定设备。</p>`,
      onOk: async () => {
        await copyText(res.key);
        loadLicenses();
      },
    });
  };
  $('#btn-ban').onclick = async () => {
    const ns = l.status === 'banned' ? 'active' : 'banned';
    const res = await API.call('licenses/' + id, { method: 'PATCH', body: { status: ns } });
    if (res.ok) { toast('已更新'); $('#modal-root').innerHTML = ''; loadLicenses(); }
  };
  $('#btn-del').onclick = async () => {
    if (!confirm('删除后不可恢复，且会解绑所有设备。确认？')) return;
    const res = await API.call('licenses/' + id, { method: 'DELETE' });
    if (res.ok) { toast('已删除'); $('#modal-root').innerHTML = ''; loadLicenses(); }
    else toast(res.message, true);
  };
  document.querySelectorAll('[data-kick]').forEach((b) => {
    b.onclick = async () => {
      const res = await API.call('devices/remove', { method: 'POST', body: { device_id: b.dataset.kick } });
      if (res.ok) { toast('已踢出该设备'); $('#modal-root').innerHTML = ''; modalLicDetail(id); }
    };
  });
}

function modalRenew(id) {
  openModal({
    title: '续期',
    okText: '确认',
    body: `
      <label class="field"><span>增加天数（可填负数缩减）</span>
        <input type="number" name="days" value="30" /></label>
      <div class="row" style="margin-bottom:6px">
        <button type="button" class="btn btn-sm" data-q="7">+7 天</button>
        <button type="button" class="btn btn-sm" data-q="30">+30 天</button>
        <button type="button" class="btn btn-sm" data-q="90">+90 天</button>
        <button type="button" class="btn btn-sm" data-q="365">+365 天</button>
      </div>
      <p class="sub">已过期或已激活的授权码，从当前到期时间往后累加；未激活的授权码直接增加天数。</p>`,
    onOk: async (fd) => {
      const r = await API.call(`licenses/${id}/renew`, { method: 'POST', body: { days: Number(fd.get('days')) } });
      if (!r.ok) throw new Error(r.message);
      toast('续期成功');
      loadLicenses();
    },
  });
  document.querySelectorAll('[data-q]').forEach((b) => {
    b.onclick = () => { document.querySelector('[name=days]').value = b.dataset.q; };
  });
}

async function exportCsv() {
  const q = new URLSearchParams(Object.fromEntries(Object.entries(state.licFilter).filter(([, v]) => v)));
  const res = await fetch('/admin/api/licenses/export?' + q.toString(), {
    headers: API.token ? { authorization: 'Bearer ' + API.token } : {},
  });
  if (!res.ok) return toast('导出失败', true);
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `licenses_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------- 批量生成 ---------------- */

function viewBatch() {
  if (!state.apps.length) {
    $('#view').innerHTML = '<div class="alert alert-warn">还没有软件，请先到「软件」页创建一个。</div>';
    return;
  }
  const appOpts = state.apps.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');

  $('#view').innerHTML = `
    <div class="card card-pad" style="max-width:620px">
      <form id="f-batch">
        <label class="field"><span>所属软件</span><select name="app_id" id="b-app">${appOpts}</select></label>
        <div class="grid2">
          <label class="field"><span>套餐</span><select name="plan_id" id="b-plan"><option value="">不关联</option></select></label>
          <label class="field"><span>数量（单次上限 200）</span><input type="number" name="count" value="10" min="1" max="200" /></label>
        </div>
        <div class="grid2">
          <label class="field"><span>期限模式</span>
            <select name="duration_mode" id="b-mode">
              <option value="from_activation">首次激活后 N 天</option>
              <option value="fixed">固定到期日</option>
              <option value="lifetime">永久</option>
            </select></label>
          <label class="field"><span>天数</span><input type="number" name="duration_days" value="30" min="1" /></label>
        </div>
        <label class="field" id="b-fixed-wrap" style="display:none"><span>固定到期时间</span>
          <input type="datetime-local" name="fixed_expires_at" /></label>
        <div class="grid2">
          <label class="field"><span>前缀</span><input type="text" name="prefix" id="b-prefix" class="mono" /></label>
          <label class="field"><span>设备数上限</span><input type="number" name="max_devices" value="1" min="1" /></label>
        </div>
        <label class="field"><span>备注</span><input type="text" name="note" placeholder="如：双十一批次" /></label>
        <button class="btn btn-primary" type="submit">生成</button>
      </form>
    </div>
    <div id="b-result" style="margin-top:16px"></div>`;

  const appSel = $('#b-app');
  const planSel = $('#b-plan');
  const syncPlan = () => {
    const app = state.apps.find((a) => a.id === appSel.value);
    $('#b-prefix').value = app ? app.prefix : '';
    const ps = state.plans.filter((p) => p.app_id === appSel.value);
    planSel.innerHTML = '<option value="">不关联</option>' + ps.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  };
  appSel.onchange = syncPlan;
  syncPlan();

  planSel.onchange = () => {
    const p = state.plans.find((x) => x.id === planSel.value);
    if (!p) return;
    $('#b-mode').value = p.duration_mode;
    if (p.duration_days) document.querySelector('[name=duration_days]').value = p.duration_days;
    document.querySelector('[name=max_devices]').value = p.max_devices;
    $('#b-fixed-wrap').style.display = p.duration_mode === 'fixed' ? '' : 'none';
  };

  $('#b-mode').onchange = (e) => {
    $('#b-fixed-wrap').style.display = e.target.value === 'fixed' ? '' : 'none';
  };

  $('#f-batch').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      app_id: fd.get('app_id'),
      plan_id: fd.get('plan_id') || null,
      count: Number(fd.get('count')),
      duration_mode: fd.get('duration_mode'),
      duration_days: Number(fd.get('duration_days') || 30),
      max_devices: Number(fd.get('max_devices') || 1),
      prefix: fd.get('prefix'),
      note: fd.get('note') || '',
      fixed_expires_at: inputToTs(fd.get('fixed_expires_at')),
    };
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    btn.textContent = '生成中…';
    try {
      const r = await API.call('licenses/batch', { method: 'POST', body });
      if (!r.ok) throw new Error(r.message);
      $('#b-result').innerHTML = `
        <div class="card card-pad">
          <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:10px">
            <h2 style="margin:0">已生成 ${r.count} 个授权码</h2>
            <div class="row">
              <button class="btn btn-sm" id="btn-copy-all">复制全部</button>
              <button class="btn btn-sm" id="btn-csv">下载 CSV</button>
            </div>
          </div>
          <div class="copy-list" id="key-list">${r.keys.map((k) => `<div>${esc(k)}</div>`).join('')}</div>
          <p class="sub" style="margin-top:10px">批次号 ${esc(r.batch_id)}，可在「批次」页整批吊销。</p>
        </div>`;
      const text = r.keys.join('\n');
      $('#btn-copy-all').onclick = () => copyText(text);
      $('#btn-csv').onclick = () => {
        const blob = new Blob(['\uFEFF' + r.keys.join('\n')], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `batch_${r.batch_id}.csv`;
        a.click();
      };
      // 这里**不能**调 loadCommon()：它内部会 renderView() 重写整个 #view，
      // 把刚显示出来的授权码列表连同表单一起抹掉（用户会以为生成失败）。
      // 批次生成不影响 apps/plans 数据，概览页的计数下次进入时自然会重新拉。
    } catch (err) {
      toast(err.message || '生成失败', true);
    } finally {
      btn.disabled = false;
      btn.textContent = '生成';
    }
  };
}

/* ---------------- 软件 ---------------- */

async function viewApps() {
  const r = await API.call('apps');
  state.apps = r.list || [];
  $('#page-actions').innerHTML = '<button class="btn btn-primary" id="btn-new-app">新建软件</button>';
  $('#btn-new-app').onclick = () => modalApp();

  $('#view').innerHTML = `
    <div class="table-card"><div class="table-scroll"><table>
      <thead><tr><th>名称</th><th>软件标识</th><th>Key 前缀</th><th class="num">授权码</th><th>状态</th><th style="width:90px"></th></tr></thead>
      <tbody>
        ${
          state.apps
            .map(
              (a) => `<tr>
          <td style="font-weight:520">${esc(a.name)}</td>
          <td class="mono">${esc(a.slug)}</td>
          <td class="mono">${esc(a.prefix)}</td>
          <td class="num">${a.lic_count}</td>
          <td><span class="tag ${a.status === 'active' ? 'tag-ok' : 'tag-mute'}">${a.status === 'active' ? '启用' : '停用'}</span></td>
          <td><button class="btn btn-sm" data-edit="${a.id}">编辑</button></td>
        </tr>`
            )
            .join('') || '<tr><td colspan="6" class="empty">还没有软件，点右上角新建</td></tr>'
        }
      </tbody>
    </table></div></div>
    <p class="sub" style="margin-top:12px">「软件标识」用于验证接口的 app 字段和软件间隔离，<b>与爱发电无关</b>；「Key 前缀」是生成授权码时印在码上的前缀。</p>`;

  document.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => modalApp(state.apps.find((a) => a.id === b.dataset.edit));
  });
}

function modalApp(a) {
  // 与 modalPlan 同一写法：编辑态一律按 id 判断，不靠「对象是否存在」。
  const editing = !!(a && a.id);
  openModal({
    title: editing ? '编辑软件' : '新建软件',
    body: `
      <label class="field"><span>软件名称</span><input type="text" name="name" value="${esc(a?.name || '')}" placeholder="如：示例工具 Pro" /></label>
      <label class="field"><span>软件标识</span>
        <input type="text" name="slug" class="mono" value="${esc(a?.slug || '')}" placeholder="v6-pro" ${editing ? 'readonly' : ''} />
        <span class="sub" style="font-size:12px">小写字母、数字、- 和 _，创建后不可改。这是本系统内部的软件代号，<b>不是爱发电的 slug</b>，和爱发电账号地址无关。</span></label>
      <label class="field"><span>Key 前缀</span>
        <input type="text" name="prefix" class="mono" value="${esc(a?.prefix || '')}" placeholder="DEMO" />
        <span class="sub" style="font-size:12px">会印在每一个授权码开头，建议 3-6 位纯字母数字。修改后只影响新生成的码，已发出去的码不变。</span></label>
      ${
        editing
          ? `<div class="field"><span>客户端接入参数</span>
               <div class="mono" style="background:var(--surface-2);padding:8px 10px;border-radius:6px;font-size:11.5px;word-break:break-all">app: "${esc(a.slug)}"</div>
               <span class="sub" style="font-size:12px">客户端调 <code>/api/v1/verify</code> 时传这个值，用于软件间隔离。不是必填项，但传了就能挡住「别的软件的码拿来用」。</span>
             </div>
             <label class="field"><span>状态</span><select name="status">
               <option value="active" ${a.status === 'active' ? 'selected' : ''}>启用</option>
               <option value="disabled" ${a.status === 'disabled' ? 'selected' : ''}>停用</option></select>
               <span class="sub" style="font-size:12px">停用后该软件下所有授权码立即无法验证（但不会删除）</span></label>
             <div class="field"><span>服务端凭证 server_key</span>
               <div class="mono" style="background:var(--surface-2);padding:8px 10px;border-radius:6px;font-size:11.5px;word-break:break-all">${esc(a.server_key || '（未生成）')}</div>
               <div class="row" style="margin-top:8px">
                 <button type="button" class="btn btn-sm" id="btn-copy-sk">复制</button>
                 <button type="button" class="btn btn-sm btn-danger" id="btn-rotate">重置</button>
               </div>
               <span class="sub" style="font-size:12px">给你的业务服务器调用 <code>/api/v1/server/check</code> 用，客户端永远不要放这个值。</span>
             </div>`
          : ''
      }
      <label class="field"><span>备注</span><input type="text" name="note" value="${esc(a?.note || '')}" /></label>`,
    onOk: async (fd) => {
      const body = { name: fd.get('name'), prefix: fd.get('prefix'), note: fd.get('note') };
      let r;
      if (editing) {
        body.status = fd.get('status');
        r = await API.call('apps/' + a.id, { method: 'PATCH', body });
      } else {
        body.slug = fd.get('slug');
        r = await API.call('apps', { method: 'POST', body });
      }
      if (!r.ok) throw new Error(r.message);
      toast(editing ? '已保存' : '已创建');
      // 只调 viewApps()：它内部会重拉 apps 并重绘。
      // 原来这里还并行调了 loadCommon()（拉 apps+plans+settings 三个接口），
      // 导致同一个 apps 接口两个请求同时在飞，而且 plans/settings 与本次改动无关。
      viewApps();
    },
  });

  if (editing) {
    if ($('#btn-copy-sk')) $('#btn-copy-sk').onclick = () => copyText(a.server_key || '');
    if ($('#btn-rotate'))
      $('#btn-rotate').onclick = async () => {
        if (!confirm('重置后旧的服务端凭证立即失效，用到它的服务需要同步更新。确认？')) return;
        const r = await API.call(`apps/${a.id}/rotate-key`, { method: 'POST' });
        if (!r.ok) return toast(r.message, true);
        toast('已重置，新凭证已复制');
        copyText(r.server_key);
        $('#modal-root').innerHTML = '';
        viewApps();
      };
  }
}

/* ---------------- 套餐 ---------------- */

// 拉取本地已同步的爱发电方案快照（只读本地库，不触发同步）
async function loadAfdianPlans() {
  try {
    const r = await API.call('afdian/plans');
    state.afdianPlans = r.ok ? r.list || [] : [];
  } catch {
    // 快照拉不到不该拖垮整个套餐页，下拉为空时用户仍可走「手工填写」
    state.afdianPlans = [];
  }
  return state.afdianPlans;
}

// 独立的一次性同步动作：把爱发电后台的商品/赞助方案拉到本地存起来。
// 同步完，新建套餐时在下拉里直接选，不用手抄 32 位 ID。
async function syncAfdian() {
  toast('正在从爱发电同步…');
  try {
    const s = await API.call('afdian/sync', { method: 'POST' });
    if (!s.ok) { toast(s.message || '同步失败', true); return; }
    await loadAfdianPlans();
    toast(`已同步 ${s.count} 个方案/商品，新建套餐时可直接下拉选择`);
    if (s.warn) toast('⚠ ' + s.warn, true);
    renderView();
  } catch (e) {
    toast('同步失败：' + (e.message || e), true);
  }
}

// 把本地快照展开成「建套餐」表单里用的下拉选项。
// 有型号的商品拆成每条型号；无型号商品与订阅方案各一条。
// 关键：无型号商品的订单里没有 sku_id，只能靠 plan_id 匹配，所以归到 'plan' 类型。
function afdianPickOptions() {
  const opts = [];
  const linkedName = (type, planId, skuId) => {
    const hit = (state.plans || []).find(
      (pl) =>
        (type === 'sku' && pl.afdian_type === 'sku' && pl.afdian_sku_id === skuId) ||
        (type === 'plan' && pl.afdian_type === 'plan' && pl.afdian_plan_id === planId),
    );
    return hit ? hit.name : null;
  };

  for (const p of state.afdianPlans || []) {
    const skus = Array.isArray(p.skus) ? p.skus : [];
    if (skus.length) {
      for (const s of skus) {
        const skuId = s.sku_id || null;
        opts.push({
          value: 'sku|' + p.plan_id + '|' + (skuId || ''),
          label:
            p.name +
            (s.name ? ' / ' + s.name : '') +
            ' · ¥' + (s.price ?? p.price ?? '?') +
            ' · 商品·型号',
          linked: linkedName('sku', null, skuId),
        });
      }
    } else {
      const isProduct = p.product_type === 1;
      opts.push({
        value: 'plan|' + p.plan_id,
        label: p.name + ' · ¥' + (p.price ?? '?') + ' · ' + (isProduct ? '商品' : '订阅'),
        linked: linkedName('plan', p.plan_id, null),
      });
    }
  }
  return opts;
}

// 编辑已有套餐时，反查它对应哪个下拉选项；
// 快照里找不到（商品被删/改名）就落到「手工填写」，把原值带出来。
function currentPickValue(p) {
  if (!p) return '__none__';
  const opts = afdianPickOptions();
  if (p.afdian_type === 'sku' && p.afdian_sku_id) {
    const hit = opts.find(
      (o) => o.value.startsWith('sku|') && o.value.endsWith('|' + p.afdian_sku_id),
    );
    return hit ? hit.value : '__manual__';
  }
  if (p.afdian_plan_id) {
    const hit = opts.find((o) => o.value === 'plan|' + p.afdian_plan_id);
    return hit ? hit.value : '__manual__';
  }
  return '__none__';
}

async function viewPlans() {
  const r = await API.call('plans');
  state.plans = r.list || [];
  // 已同步的爱发电方案快照：只读本地库，用于新建套餐时的下拉选项
  await loadAfdianPlans();
  $('#page-actions').innerHTML = `
    <button class="btn" id="btn-sync-afdian">🔄 同步爱发电方案</button>
    <button class="btn btn-primary" id="btn-new-plan">新建套餐</button>`;
  $('#btn-new-plan').onclick = () => modalPlan();
  $('#btn-sync-afdian').onclick = syncAfdian;
  if (!state.apps.length) {
    $('#view').innerHTML = '<div class="alert alert-warn">请先创建软件，套餐需要挂在软件下。</div>';
    return;
  }

  const modeMap = { from_activation: '首激活起算', fixed: '固定到期', lifetime: '永久' };

  // 从本地同步快照里反查方案名，让表格显示「商品名」而不是裸 ID
  const snapshotName = (pl) => {
    if (!pl.afdian_plan_id && !pl.afdian_sku_id) return null;
    const hit = (state.afdianPlans || []).find(
      (a) =>
        (pl.afdian_type === 'sku' &&
          (a.skus || []).some((s) => s.sku_id && s.sku_id === pl.afdian_sku_id)) ||
        (pl.afdian_type === 'plan' && a.plan_id === pl.afdian_plan_id),
    );
    return hit ? hit.name : null;
  };

  $('#view').innerHTML = `
    <div class="table-card"><div class="table-scroll"><table>
      <thead><tr><th>套餐</th><th>软件</th><th>期限</th><th>设备</th><th>爱发电映射</th><th>授权码</th><th style="width:90px"></th></tr></thead>
      <tbody>
        ${
          state.plans
            .map(
              (p) => `<tr>
          <td style="font-weight:520">${esc(p.name)}</td>
          <td>${esc(p.app_name || '-')}</td>
          <td>${modeMap[p.duration_mode]}${p.duration_mode === 'lifetime' ? '' : ' / ' + p.duration_days + '天'}</td>
          <td>${p.max_devices}</td>
          <td>${
            p.afdian_plan_id || p.afdian_sku_id
              ? `<span class="tag ${p.afdian_type === 'sku' ? 'tag-info' : 'tag-mute'}">${
                  p.afdian_type === 'sku' ? '商品' : '订阅'
                }</span> ${snapshotName(p) ? esc(snapshotName(p)) + '<br>' : ''}<span class="mono" style="font-size:11px;color:var(--muted)">${esc(
                  p.afdian_plan_id || p.afdian_sku_id,
                )}</span>`
              : '<span class="tag tag-warn">未映射</span>'
          }</td>
          <td>${p.lic_count}</td>
          <td><button class="btn btn-sm" data-edit="${p.id}">编辑</button></td>
        </tr>`
            )
            .join('') || '<tr><td colspan="7" class="empty">还没有套餐</td></tr>'
        }
      </tbody>
    </table></div></div>
    <p class="sub" style="margin-top:12px">流程：先点右上角 <b>🔄 同步爱发电方案</b> 把爱发电后台的商品拉下来（存本地，不会每次都请求爱发电），然后新建套餐时在「爱发电商品 / 赞助方案」里<b>下拉直接选</b>，ID 与类型自动填好，不用手抄 32 位。</p>`;

  document.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => modalPlan(state.plans.find((p) => p.id === b.dataset.edit));
  });
}

function modalPlan(p) {
  // p 是「要编辑的已有套餐」，可能为空（新建）。
  // 编辑态一律按 p.id 判断，不靠「对象是否存在」——
  // 否则将来若再引入「只带预填字段、无 id」的对象，会被当成编辑，PATCH 到 plans/undefined。
  const editing = !!(p && p.id);
  // 新建时没有 app_id，必须让用户显式选，不能默认落到第一个软件上
  const needPickApp = !p?.app_id;
  const appOpts =
    (needPickApp ? '<option value="">请选择软件…</option>' : '') +
    state.apps
      .map((a) => `<option value="${a.id}" ${p?.app_id === a.id ? 'selected' : ''}>${esc(a.name)}</option>`)
      .join('');

  // 当前套餐对应的下拉选项值（编辑时反查，新建时默认不关联）
  const curPick = currentPickValue(p);

  openModal({
    title: editing ? '编辑套餐' : '新建套餐',
    body: `
      <div class="grid2">
        <label class="field"><span>所属软件</span><select name="app_id">${appOpts}</select></label>
        <label class="field"><span>套餐名称</span><input type="text" name="name" value="${esc(p?.name || '')}" placeholder="月卡 / 年卡" /></label>
      </div>
      <div class="grid2">
        <label class="field"><span>期限模式</span>
          <select name="duration_mode" id="p-mode">
            <option value="from_activation" ${(p?.duration_mode ?? 'from_activation') === 'from_activation' ? 'selected' : ''}>首次激活后 N 天</option>
            <option value="fixed" ${p?.duration_mode === 'fixed' ? 'selected' : ''}>固定到期日</option>
            <option value="lifetime" ${p?.duration_mode === 'lifetime' ? 'selected' : ''}>永久</option>
          </select></label>
        <label class="field"><span>天数</span><input type="number" name="duration_days" value="${p?.duration_days ?? 30}" min="1" /></label>
      </div>
      <label class="field"><span>设备数上限</span><input type="number" name="max_devices" value="${p?.max_devices ?? 1}" min="1" /></label>
      <div style="border-top:1px solid var(--border);margin:4px 0 14px"></div>
      <label class="field"><span>爱发电商品 / 赞助方案</span>
        <select name="afdian_pick" id="p-pick">
          <option value="__none__">不关联爱发电（手工发码）</option>
          ${afdianPickOptions()
            .map(
              (o) =>
                `<option value="${esc(o.value)}" ${o.value === curPick ? 'selected' : ''}>${esc(o.label)}${
                  o.linked ? '　✓ 已建：' + esc(o.linked) : ''
                }</option>`,
            )
            .join('')}
          <option value="__manual__" ${curPick === '__manual__' ? 'selected' : ''}>✏️ 手工填写 ID…</option>
        </select>
        <span class="sub" id="p-pick-hint" style="font-size:12px">${
          state.afdianPlans.length
            ? '直接选已同步的方案，ID 自动填好。'
            : '还没有同步过。点右上角「🔄 同步爱发电方案」拉一次，之后就能在这里下拉选择。'
        }</span></label>
      <div id="p-manual" style="display:${curPick === '__manual__' ? '' : 'none'}">
        <label class="field"><span>爱发电售卖类型</span>
          <select name="afdian_type" id="p-type">
            <option value="plan" ${(p?.afdian_type ?? 'plan') === 'plan' ? 'selected' : ''}>赞助 / 订阅方案（按月扣款）</option>
            <option value="sku" ${p?.afdian_type === 'sku' ? 'selected' : ''}>商品 / 售卖型（有型号）</option>
          </select></label>
        <label class="field"><span id="p-id-label">爱发电 plan_id</span>
          <input type="text" name="afdian_id" id="p-id" class="mono"
            value="${esc(p?.afdian_type === 'sku' ? p?.afdian_sku_id || '' : p?.afdian_plan_id || '')}" /></label>
        <p class="sub" id="p-id-hint" style="margin:-6px 0 14px;font-size:12px"></p>
      </div>
      <label class="field"><span>功能位 JSON（高级）</span>
        <textarea name="features" class="mono" placeholder='{"pro":true}'>${esc(JSON.stringify(p?.features || {}, null, 2))}</textarea>
        <p class="sub" style="margin:-6px 0 14px;font-size:12px">键名由你的客户端自己定义，系统原样存进令牌、交给客户端读。留空 <code>{}</code> 表示所有用户权限相同。例：<code>{"pro":true,"export":false,"max_export":100}</code></p></label>
      <label class="field"><span>私信文案（留空用全局模板）</span>
        <textarea name="msg_template" placeholder="可用变量：{key} {plan} {app} {expires} {order}">${esc(p?.msg_template || '')}</textarea></label>
      <label class="field"><span>备注</span><input type="text" name="note" value="${esc(p?.note || '')}" /></label>`,
    onOk: async (fd) => {
      let features;
      try {
        features = JSON.parse(fd.get('features') || '{}');
      } catch {
        throw new Error('功能位不是合法 JSON');
      }
      const atype = fd.get('afdian_type') === 'sku' ? 'sku' : 'plan';
      const aid = (fd.get('afdian_id') || '').trim() || null;
      if (!fd.get('app_id')) throw new Error('请先选择所属软件');

      // 爱发电映射：下拉选项里带了正确的类型和 ID，无需手抄。
      //   __none__  → 不关联（手工发码）
      //   __manual__→ 手工填 ID，按选的类型走
      //   plan|xxx  → 订阅/无型号商品，匹配用 plan_id
      //   sku|x|y   → 有型号商品，匹配用 sku_id
      const pick = fd.get('afdian_pick') || '__none__';
      let afdian_type = 'plan';
      let afdian_plan_id = null;
      let afdian_sku_id = null;
      if (pick === '__manual__') {
        afdian_type = atype;
        afdian_plan_id = atype === 'plan' ? aid : null;
        afdian_sku_id = atype === 'sku' ? aid : null;
      } else if (pick !== '__none__') {
        const [kind, pid, sid] = pick.split('|');
        if (kind === 'sku') {
          afdian_type = 'sku';
          afdian_sku_id = sid || null;
        } else {
          afdian_type = 'plan';
          afdian_plan_id = pid || null;
        }
      }

      const body = {
        app_id: fd.get('app_id'),
        name: fd.get('name'),
        duration_mode: fd.get('duration_mode'),
        duration_days: Number(fd.get('duration_days') || 30),
        max_devices: Number(fd.get('max_devices') || 1),
        afdian_type,
        afdian_plan_id,
        afdian_sku_id,
        features,
        msg_template: fd.get('msg_template') || null,
        note: fd.get('note'),
      };
      const r = editing
        ? await API.call('plans/' + p.id, { method: 'PATCH', body })
        : await API.call('plans', { method: 'POST', body });
      if (!r.ok) throw new Error(r.message);
      toast(editing ? '已保存' : '已创建');
      viewPlans();
    },
  });

  // 下拉切换：只有选「手工填写」才展开类型 + ID 输入区
  const pickSel = $('#p-pick');
  if (pickSel) {
    const applyPick = () => {
      const isManual = pickSel.value === '__manual__';
      const manual = $('#p-manual');
      if (manual) manual.style.display = isManual ? '' : 'none';
      const hint = $('#p-pick-hint');
      if (hint) {
        hint.innerHTML = isManual
          ? '手工填写模式：下面的 ID 要从爱发电商品页的付款链接里复制。'
          : state.afdianPlans.length
            ? '直接选已同步的方案，ID 与类型自动填好。'
            : '还没有同步过。点右上角「🔄 同步爱发电方案」拉一次，之后就能在这里下拉选择。';
      }
    };
    pickSel.onchange = applyPick;
    applyPick();
  }

  const typeSel = $('#p-type');
  if (typeSel) {
    const sync = () => {
      const isSku = typeSel.value === 'sku';
      $('#p-id-label').textContent = isSku ? '爱发电 sku_id' : '爱发电 plan_id';
      $('#p-id-hint').textContent = isSku
        ? '有型号的售卖型商品填具体型号的 sku_id。若该商品<b>没有型号</b>，请切回上面选「赞助 / 订阅方案」，填它的 plan_id。'
        : '订阅 / 赞助方案填 plan_id；<b>没有型号</b>的售卖型商品也填 plan_id（这类订单里没有 sku_id，只能靠 plan_id 匹配）。';
    };
    typeSel.onchange = sync;
    sync();
  }
}

/* ---------------- 订单 ---------------- */

async function viewOrders() {
  $('#page-actions').innerHTML = `
    <button class="btn" id="btn-sync-ord">从爱发电同步</button>
    <button class="btn" id="btn-reload-ord">刷新</button>`;
  $('#view').innerHTML = `
    <div class="toolbar">
      <select id="o-delivery">
        <option value="">全部</option>
        <option value="sent">已发送</option>
        <option value="pending">待发送</option>
        <option value="failed">发送失败</option>
        <option value="unmatched">未匹配套餐</option>
        <option value="manual">手工发码</option>
      </select>
      <input type="text" id="o-q" placeholder="订单号 / 用户ID / 留言" />
      <div class="spacer"></div>
      <span class="sub" id="o-count"></span>
    </div>
    <div class="table-card"><div class="table-scroll"><table>
      <thead><tr><th>订单号</th><th>金额</th><th>套餐</th><th>买家 user_id</th><th>授权码 / 设备</th><th>投递</th><th>时间</th><th style="width:120px"></th></tr></thead>
      <tbody id="o-body"><tr><td colspan="7" class="empty">加载中…</td></tr></tbody>
    </table></div><div class="pager" id="o-pager"></div></div>`;

  const reload = () => {
    state.ordFilter = { delivery: $('#o-delivery').value, q: $('#o-q').value.trim() };
    state.ordPage = 1;
    loadOrders();
  };
  $('#o-delivery').onchange = reload;
  $('#o-q').onkeydown = (e) => { if (e.key === 'Enter') reload(); };
  $('#btn-reload-ord').onclick = reload;
  $('#btn-sync-ord').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '同步中…';
    try {
      const r = await API.call('orders/sync', { method: 'POST' });
      if (r.ok) {
        toast(r.added ? `扫描 ${r.scanned} 单，补发 ${r.added} 单` : `扫描 ${r.scanned} 单，无漏单`);
        loadOrders();
      } else {
        toast(r.message || '同步失败', true);
      }
    } catch (err) {
      toast(err.message || '同步失败', true);
    } finally {
      btn.disabled = false;
      btn.textContent = '从爱发电同步';
    }
  };
  loadOrders();
}

async function loadOrders() {
  const q = new URLSearchParams({
    page: state.ordPage,
    ...Object.fromEntries(Object.entries(state.ordFilter).filter(([, v]) => v)),
  });
  let r;
  try {
    r = await API.call('orders?' + q.toString());
  } catch (e) {
    if (e.code === 401) return;
    const b = $('#o-body');
    if (b) {
      b.innerHTML = `<tr><td colspan="8" class="empty" style="color:var(--danger)">加载失败：${esc(
        e.message || e,
      )}</td></tr>`;
    }
    const c = $('#o-count');
    if (c) c.textContent = '加载失败';
    return;
  }
  const rows = r.list || [];
  $('#o-count').textContent = `共 ${r.total} 条`;
  const body = $('#o-body');

  const dt = { sent: ['已发送', 'tag-ok'], pending: ['待发送', 'tag-warn'], failed: ['失败', 'tag-danger'], unmatched: ['未匹配', 'tag-danger'], manual: ['手工', 'tag-info'] };

  body.innerHTML = rows.length
    ? rows
        .map((o) => {
          const [t, c] = dt[o.delivery] || [o.delivery || '-', 'tag-mute'];
          return `<tr>
        <td class="mono" style="font-size:11.5px">${esc(o.out_trade_no)}</td>
        <td class="num">¥${esc(o.amount || '0')}</td>
        <td>${
          o.product_type === 1
            ? '<span class="tag tag-info">商品</span> '
            : o.product_type === 0
              ? '<span class="tag tag-mute">订阅</span> '
              : ''
        }${esc(o.plan_name || '-')}</td>
        <td class="mono" style="font-size:11px" title="${esc(o.afdian_user_id || '')}">
          ${esc((o.afdian_user_id || '-').slice(0, 10))}${(o.afdian_user_id || '').length > 10 ? '…' : ''}
        </td>
        <td class="key-cell">${
          o.key
            ? esc(o.key)
            : o.archived_key
              ? `<span class="sub">${esc(o.archived_key)} 已清理</span>`
              : '-'
        }${o.issue_type === 'renew' ? ' <span class="tag tag-info">续费</span>' : ''}${
          o.device_count
            ? `<div class="sub" style="font-size:11px;margin-top:2px">${o.device_count} 台${
                o.lic_max_devices ? ' / 上限 ' + o.lic_max_devices : ''
              }${o.device_brief ? ' · ' + esc(o.device_brief) : ''}</div>`
            : ''
        }</td>
        <td><span class="tag ${c}">${t}</span>${
          o.delivery_error && o.delivery !== 'failed'
            ? ` <span title="${esc(o.delivery_error)}" style="cursor:help;color:var(--warn)">⚠</span>`
            : ''
        }</td>
        <td style="white-space:nowrap" class="sub">${esc(fmtTime(o.created_at))}</td>
        <td style="white-space:nowrap">
          ${o.license_id ? `<button class="btn btn-sm" data-retry="${esc(o.out_trade_no)}">重发</button>` : `<button class="btn btn-sm btn-primary" data-issue="${esc(o.out_trade_no)}">发码</button>`}
        </td></tr>`;
        })
        .join('')
    : '<tr><td colspan="8" class="empty">暂无订单</td></tr>';

  const pages = Math.max(1, Math.ceil(r.total / 50));
  $('#o-pager').innerHTML = `
    <button class="btn btn-sm" ${r.page <= 1 ? 'disabled' : ''} data-pg="${r.page - 1}">上一页</button>
    <span>${r.page} / ${pages}</span>
    <button class="btn btn-sm" ${r.page >= pages ? 'disabled' : ''} data-pg="${r.page + 1}">下一页</button>`;

  document.querySelectorAll('#o-pager [data-pg]').forEach((b) => {
    b.onclick = () => { state.ordPage = Number(b.dataset.pg); loadOrders(); };
  });
  document.querySelectorAll('[data-retry]').forEach((b) => {
    b.onclick = async () => {
      const res = await API.call(`orders/${b.dataset.retry}/retry`, { method: 'POST' });
      toast(res.ok ? (res.sent ? '私信已发送' : '重试已提交') : res.message, !res.ok);
      loadOrders();
    };
  });
  document.querySelectorAll('[data-issue]').forEach((b) => {
    b.onclick = () => {
      if (!state.plans.length) return toast('请先创建套餐', true);
      openModal({
        title: '手工发码',
        okText: '生成并发送',
        body: `<label class="field"><span>选择套餐</span><select name="plan_id">
          ${state.plans.map((p) => `<option value="${p.id}">${esc(p.name)}（${esc(p.app_name || '')}）</option>`).join('')}
        </select></label>
        <label class="field" style="display:flex;gap:8px;align-items:flex-start">
          <input type="checkbox" name="force_new" style="width:auto;margin-top:3px" />
          <span style="margin:0">强制生成新码（不续到该买家已有的旧码上）<br>
          <span class="sub" style="font-size:12px">不勾选时，若该买家此前买过同软件且还在有效期，会直接续期到旧码。</span></span>
        </label>
        <p class="sub">将按该套餐生成授权码，并私信发给买家。</p>`,
        onOk: async (fd) => {
          const res = await API.call(`orders/${b.dataset.issue}/issue`, {
            method: 'POST',
            body: { plan_id: fd.get('plan_id'), force_new: !!fd.get('force_new') },
          });
          if (!res.ok) throw new Error(res.message);
          toast(res.renewed ? '已续期到该买家的旧授权码' : '已发码：' + res.key);
          loadOrders();
        },
      });
    };
  });
}

/* ---------------- 批次 ---------------- */

async function viewBatches() {
  const r = await API.call('batches');
  $('#view').innerHTML = `
    <div class="table-card"><div class="table-scroll"><table>
      <thead><tr><th>批次号</th><th>软件</th><th>套餐</th><th>前缀</th><th>数量</th><th>备注</th><th>时间</th><th style="width:110px"></th></tr></thead>
      <tbody>
        ${
          (r.list || [])
            .map(
              (b) => `<tr>
          <td class="mono" style="font-size:11.5px">${esc(b.id)}</td>
          <td>${esc(b.app_name || '-')}</td>
          <td>${esc(b.plan_name || '-')}</td>
          <td class="mono">${esc(b.prefix || '')}</td>
          <td>${b.count}</td>
          <td>${esc(b.note || '')}</td>
          <td class="sub" style="white-space:nowrap">${esc(fmtTime(b.created_at))}</td>
          <td>
            <button class="btn btn-sm btn-danger" data-revoke="${b.id}">整批吊销</button>
          </td></tr>`
            )
            .join('') || '<tr><td colspan="8" class="empty">还没有批量生成记录</td></tr>'
        }
      </tbody>
    </table></div></div>`;

  document.querySelectorAll('[data-revoke]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('将吊销该批次内所有「正常」状态的授权码，确认？')) return;
      const res = await API.call(`batches/${b.dataset.revoke}/revoke`, { method: 'POST' });
      toast(res.ok ? `已吊销 ${res.revoked} 个` : res.message, !res.ok);
      viewBatches();
    };
  });
}

/* ---------------- 设置 ---------------- */

async function viewSettings() {
  // 两个接口互不依赖，并发拉，省一个 RTT（约 40~120ms）
  const [s, pkRes] = await Promise.all([
    API.call('settings'),
    API.call('pubkey').catch(() => null), // 未配置私钥时 pubkey 会失败，不影响设置页
  ]);
  if (!s.ok) return;
  state.settings = s;
  const pk = (pkRes && pkRes.public_key) || '';

  const e = s.env || {};
  const rate = s.rate || { presets: [], profile: 'normal', today_blocked: 0 };
  $('#view').innerHTML = `
    <div class="card card-pad" style="max-width:720px">
      <h2>站点</h2>
      <form id="f-set">
        <label class="field"><span>站点名称</span><input type="text" name="site_name" value="${esc(s.site_name || '')}" /></label>
        <label class="field"><span>全局私信文案</span>
          <textarea name="msg_template" rows="6" placeholder="留空使用默认模板">${esc(s.msg_template || '')}</textarea>
          <span class="sub" style="font-size:12px">可用变量：{key} {plan} {app} {expires} {order} {amount}</span></label>
        <button class="btn btn-primary" type="submit">保存</button>
      </form>
    </div>

    <div class="card card-pad" style="max-width:720px;margin-top:14px">
      <h2>请求限流</h2>
      <p class="sub" style="margin-bottom:14px">
        限制「同一个 IP 在单位时间内最多请求几次」，防止有人用脚本刷接口烧掉每天的请求额度。
        选一个档位即可，下面是这一档的具体数值。
      </p>
      <div class="rate-opts">
        ${(rate.presets || [])
          .map(
            (p) => `
          <label class="rate-opt ${p.id === rate.profile ? 'active' : ''}">
            <input type="radio" name="rate_profile" value="${p.id}" ${p.id === rate.profile ? 'checked' : ''} />
            <span class="rate-body">
              <span class="rate-name">${esc(p.label)}${
                p.id === rate.profile ? '<span class="tag tag-info plain">当前</span>' : ''
              }</span>
              <span class="rate-desc">${esc(p.desc)}</span>
              <span class="rate-nums">验证 ${p.verify} 次/分 · 查询 ${p.status} 次/分 · 取码 ${p.claim} 次/10分 · 解绑 ${p.unbind} 次/小时</span>
            </span>
          </label>`
          )
          .join('')}
      </div>
      <div class="row" style="margin-top:16px">
        <button class="btn btn-primary" id="btn-save-rate">保存限流设置</button>
        <span class="sub" style="font-size:12.5px">
          今日已拦截 <b>${rate.today_blocked || 0}</b> 次
          ${
            (rate.today_blocked || 0) === 0
              ? '（一直是 0 说明没人在刷，可以放心）'
              : '（持续增长说明有人在刷，可考虑收紧一档）'
          }
        </span>
      </div>
      <p class="sub" style="font-size:12px;margin-top:12px">
        注：「输错授权码」有单独一道更严的闸（每 IP 每分钟 ${rate.bad_key_limit || 20} 次），这一道不受档位影响。
      </p>
    </div>

    <div class="card card-pad" style="max-width:720px;margin-top:14px">
      <h2>私信通道自检</h2>
      <p class="sub" style="margin-bottom:12px">
        发一条测试私信，验证爱发电 token 与私信通道是否正常。
        <b>收件人必须是赞助过你的人</b>——爱发电规定只能给赞助关系方发私信，
        填自己的 user_id 会返回「需要赞助对方或被对方赞助才可以发送私信」。
      </p>
      <div class="grid2">
        <label class="field"><span>收件人 user_id</span>
          <input type="text" id="tm-user" class="mono" placeholder="留空 = 自己的 user_id" /></label>
        <label class="field"><span>内容</span>
          <input type="text" id="tm-content" placeholder="留空 = 默认测试文案" /></label>
      </div>
      <button class="btn" id="btn-test-msg">发送测试私信</button>
      <div id="tm-result" class="sub" style="margin-top:10px"></div>
    </div>

    <div class="card card-pad" style="max-width:720px;margin-top:14px">
      <h2>运行环境</h2>
      <div class="kv"><div class="k">鉴权模式</div><div class="v">${esc(e.auth_mode)}${e.access_configured ? '（Access 已配置）' : '（Access 未配置）'}</div></div>
      <div class="kv"><div class="k">爱发电 API</div><div class="v">${e.afdian_configured ? '<span class="tag tag-ok">已配置</span>' : '<span class="tag tag-danger">未配置 user_id / token</span>'}</div></div>
      <div class="kv"><div class="k">令牌有效期</div><div class="v">${esc(e.token_ttl_hours)} 小时</div></div>
      <div class="kv"><div class="k">解绑冷却</div><div class="v">${esc(e.unbind_cooldown)} 天</div></div>
      <div class="kv"><div class="k">Webhook 地址</div><div class="v mono">https://${esc(location.host)}/webhook/afdian</div></div>
    </div>

    <div class="card card-pad" style="max-width:720px;margin-top:14px">
      <h2>客户端验签公钥</h2>
      <p class="sub" style="margin-bottom:10px">把这段公钥内置到你的软件里，用于离线校验令牌。</p>
      ${
        pk
          ? `<pre class="mono" style="background:var(--surface-2);padding:12px;border-radius:8px;overflow:auto;font-size:11.5px;white-space:pre-wrap">${esc(pk)}</pre>
             <button class="btn btn-sm" id="btn-copy-pk">复制公钥</button>`
          : '<div class="alert alert-err">尚未配置 LICENSE_PRIVATE_KEY，无法签发许可证令牌。</div>'
      }
    </div>`;

  $('#f-set').onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const r = await API.call('settings', {
      method: 'POST',
      body: { site_name: fd.get('site_name'), msg_template: fd.get('msg_template') },
    });
    toast(r.ok ? '已保存' : r.message, !r.ok);
  };
  if ($('#btn-copy-pk')) $('#btn-copy-pk').onclick = () => copyText(pk);

  // 私信通道自检
  if ($('#btn-test-msg')) {
    $('#btn-test-msg').onclick = async () => {
      const btn = $('#btn-test-msg');
      btn.disabled = true;
      $('#tm-result').textContent = '发送中…';
      try {
        const r = await API.call('afdian/test-msg', {
          method: 'POST',
          body: {
            user_id: ($('#tm-user').value || '').trim() || undefined,
            content: ($('#tm-content').value || '').trim() || undefined,
          },
        });
        const box = $('#tm-result');
        if (r.ok) {
          box.innerHTML = '<span class="tag tag-ok">发送成功</span> 去爱发电后台的「私信」里看';
        } else {
          const hint =
            r.ec === 400001
              ? '对方没赞助过你 —— 只能给赞助过你的人发私信'
              : r.ec === 400004
                ? 'token 无效，需要重新配置 AFDIAN_TOKEN'
                : '见下方错误码';
          box.innerHTML = `<span class="tag tag-danger">失败</span> ec=${esc(String(r.ec))} · ${esc(
            r.em || '',
          )}<br><span style="color:var(--muted)">${esc(hint)}</span>`;
        }
      } catch (e) {
        $('#tm-result').textContent = '请求失败：' + (e.message || e);
      } finally {
        btn.disabled = false;
      }
    };
  }

  // 限流档位：点卡片即选中，再点保存
  const rateOpts = document.querySelectorAll('.rate-opt');
  rateOpts.forEach((el) => {
    el.onclick = () => {
      rateOpts.forEach((x) => x.classList.remove('active'));
      el.classList.add('active');
      el.querySelector('input').checked = true;
    };
  });

  $('#btn-save-rate').onclick = async () => {
    const picked = document.querySelector('input[name="rate_profile"]:checked');
    if (!picked) return toast('请先选一个档位', true);
    const r = await API.call('settings', { method: 'POST', body: { rate_profile: picked.value } });
    if (!r.ok) return toast(r.message || '保存失败', true);
    toast('已保存，1 分钟内生效');
    viewSettings();
  };
}

/* ============================================================
   启动
   ============================================================ */

window.copyText = copyText;
window.state = state;
window.renderAdmin = renderAdmin;

if (isAdmin()) bootAdmin();
else renderPublic();
