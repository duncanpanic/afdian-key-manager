// 真实 HTTP 端到端测试
//
// 前置：先启动本地服务  node scripts/dev-local.mjs
// 运行：node tests/e2e-http.mjs
//
// 覆盖：登录 → 建软件 → 建套餐 → 生成 key → 客户端验证 → 用公钥验签令牌

import { readFileSync } from 'node:fs';
import { verify } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE || 'http://localhost:8787';
const PASSWORD = process.env.ADMIN_PASSWORD || 'local-dev-password-123';

let pass = 0;
let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}  ${extra}`);
  }
};

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data, headers: res.headers };
}

console.log('\n[E2E] 真实 HTTP 全链路');

// 1. 健康检查：公钥接口
{
  const r = await api('/api/v1/pubkey');
  t('公钥接口可用', r.status === 200 && r.data.ok === true);
  t('公钥带长缓存', String(r.headers.get('cache-control')).includes('max-age=86400'));
  t('公钥内容正确', String(r.data.public_key).startsWith('-----BEGIN PUBLIC KEY-----'));
}

// 2. 登录
let token = '';
{
  const bad = await api('/admin/api/login', { method: 'POST', body: { password: 'wrong' } });
  t('错误口令被拒', bad.status === 401);

  const r = await api('/admin/api/login', { method: 'POST', body: { password: PASSWORD } });
  t('正确口令登录成功', r.status === 200 && r.data.ok === true);
  token = r.data.token || '';
  t('拿到会话令牌', token.split('.').length === 3);

  const me = await api('/admin/api/me', { token });
  t('会话可用', me.data.ok === true);

  const noAuth = await api('/admin/api/licenses');
  t('无令牌访问被拒', noAuth.status === 401);
}

// 3. 建软件
let appId = '';
const slug = 'e2e-' + Date.now().toString(36);
{
  const r = await api('/admin/api/apps', {
    method: 'POST',
    token,
    body: { name: 'E2E 测试软件', slug, prefix: 'E2E', note: '自动化测试' },
  });
  t('创建软件成功', r.data.ok === true, r.data.message || '');
  appId = r.data.id;

  const list = await api('/admin/api/apps', { token });
  const found = (list.data.list || []).find((a) => a.id === appId);
  t('软件出现在列表', !!found);
  t('自动生成 server_key', !!found && String(found.server_key).startsWith('sk_'));
}

// 4. 建套餐
let planId = '';
{
  const r = await api('/admin/api/plans', {
    method: 'POST',
    token,
    body: {
      app_id: appId,
      name: '月卡',
      duration_mode: 'from_activation',
      duration_days: 30,
      max_devices: 1,
      verify_limit: 100,
      afdian_type: 'plan',
      afdian_plan_id: 'AFD_E2E',
      features: { pro: true },
    },
  });
  t('创建套餐成功', r.data.ok === true, r.data.message || '');
  planId = r.data.id;
}

// 5. 生成 key
let key = '';
let licId = '';
{
  const r = await api('/admin/api/licenses', {
    method: 'POST',
    token,
    body: { app_id: appId, plan_id: planId, duration_mode: 'from_activation', duration_days: 30, max_devices: 1 },
  });
  t('生成授权码成功', r.data.ok === true, r.data.message || '');
  key = r.data.key || '';
  licId = r.data.id;
  t('授权码格式正确', /^E2E(-[0-9A-Z]{4}){5}-[0-9A-Z]$/.test(key), key);
}

// 6. 批量生成
{
  const r = await api('/admin/api/licenses/batch', {
    method: 'POST',
    token,
    body: { app_id: appId, plan_id: planId, count: 5, prefix: 'E2E' },
  });
  t('批量生成 5 个', r.data.ok === true && r.data.count === 5, r.data.message || '');
  t('批量结果无重复', new Set(r.data.keys || []).size === 5);
}

// 7. 客户端验证
let licToken = '';
{
  const p = await api('/api/v1/verify', {
    method: 'POST',
    body: { key, app: slug, fingerprint: 'fp-e2e-machine', label: 'E2E 测试机' },
  });
  t('验证成功', p.data.ok === true, p.data.code || '');
  licToken = p.data.token || '';
  t('返回三段的 JWT', licToken.split('.').length === 3);
  t('令牌有效期与套餐一致', Math.round((p.data.license.expires_at - p.data.license.activated_at) / 86400) === 30);
  t('功能位正确下发', p.data.license.features && p.data.license.features.pro === true);

  // 同设备再来一次
  const again = await api('/api/v1/verify', {
    method: 'POST',
    body: { key, app: slug, fingerprint: 'fp-e2e-machine' },
  });
  t('同设备二次验证通过', again.data.ok === true);

  // 第二台设备超限
  const other = await api('/api/v1/verify', {
    method: 'POST',
    body: { key, app: slug, fingerprint: 'fp-e2e-other' },
  });
  t('第二台设备被拒', other.data.code === 'DEVICE_LIMIT', other.data.code);

  // 错误场景
  const badKey = await api('/api/v1/verify', {
    method: 'POST',
    body: { key: 'E2E-AAAA-BBBB-CCCC-DDDD-EEEE-F', fingerprint: 'fp' },
  });
  t('非法 key 被拒', badKey.data.code === 'INVALID_KEY', badKey.data.code);

  const wrongApp = await api('/api/v1/verify', {
    method: 'POST',
    body: { key, app: 'not-this-app', fingerprint: 'fp-e2e-machine' },
  });
  t('软件不匹配被拒', wrongApp.data.code === 'APP_MISMATCH');
}

// 8. 用公钥验签令牌（模拟客户端本地校验）
{
  const pub = readFileSync(join(ROOT, 'keys', 'public.pem'), 'utf8');
  const [h, p, s] = licToken.split('.');
  const sig = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const ok = verify('RSA-SHA256', Buffer.from(`${h}.${p}`), pub, sig);
  t('客户端可用公钥验签令牌', ok === true);

  const payload = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  t('令牌内含 app 标识', payload.app === slug);
  t('令牌内含功能位', payload.f?.pro === true);
}

// 9. 用户查询页接口
{
  const r = await api('/api/v1/status', { method: 'POST', body: { key } });
  t('查询状态成功', r.data.ok === true);
  t('返回的 key 已打码', String(r.data.key).includes('•'), r.data.key);
  t('设备数正确', (r.data.devices || []).length === 1);
}

// 10. 管理端操作：续期 / 换发 / 封禁
{
  const renew = await api(`/admin/api/licenses/${licId}/renew`, { method: 'POST', token, body: { days: 30 } });
  t('续期成功', renew.data.ok === true);

  const reissue = await api(`/admin/api/licenses/${licId}/reissue`, { method: 'POST', token, body: {} });
  t('换发成功', reissue.data.ok === true, reissue.data.message || '');
  t('换发后 key 不同', reissue.data.key !== key);

  const old = await api(`/admin/api/licenses/${licId}`, { token });
  t('旧 key 已吊销', old.data.license?.status === 'revoked');

  const banned = await api(`/admin/api/licenses/${reissue.data.id}`, {
    method: 'PATCH',
    token,
    body: { status: 'banned' },
  });
  t('封禁成功', banned.data.ok === true);

  const denied = await api('/api/v1/verify', {
    method: 'POST',
    body: { key: reissue.data.key, app: slug, fingerprint: 'fp-x' },
  });
  t('封禁后无法验证', denied.data.code === 'BANNED');
}

// 11. 服务端校验接口
{
  const apps = await api('/admin/api/apps', { token });
  const app = (apps.data.list || []).find((a) => a.id === appId);
  const r = await fetch(BASE + '/api/v1/server/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + app.server_key },
    body: JSON.stringify({ key }),
  });
  const data = await r.json();
  t('服务端校验可用（旧 key 已吊销）', data.code === 'REVOKED', data.code);

  const bad = await fetch(BASE + '/api/v1/server/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk_wrong' },
    body: JSON.stringify({ key }),
  });
  t('错误 server_key 被拒', (await bad.json()).code === 'UNAUTHORIZED');
}

// 12. 页面可访问
{
  const home = await fetch(BASE + '/');
  t('用户页可访问', home.status === 200);
  const admin = await fetch(BASE + '/admin');
  t('管理台可访问（SPA 回退）', admin.status === 200);
  const js = await fetch(BASE + '/app.js');
  t('前端脚本可加载', js.status === 200);
}

console.log('\n' + '─'.repeat(46));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exit(1);
console.log('全链路打通 ✅');
