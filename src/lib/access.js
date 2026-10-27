// Cloudflare Access JWT 校验
// Access 会在受保护请求上注入 CF-Access-Jwt-Assertion 头（RS256 签名的 JWT）
// 公钥来自 https://<team>.cloudflareaccess.com/cdn-cgi/access/certs

import { b64urlDecodeString, flexibleB64ToBytes, now } from './util.js';

let jwksCache = { keys: null, at: 0 };
const JWKS_TTL = 3600;

async function fetchJwks(teamDomain) {
  if (jwksCache.keys && now() - jwksCache.at < JWKS_TTL) return jwksCache.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error('无法获取 Access 公钥: ' + res.status);
  const data = await res.json();
  jwksCache = { keys: data.keys || [], at: now() };
  return jwksCache.keys;
}

export async function verifyAccessJwt(token, env) {
  const team = env.CF_ACCESS_TEAM_DOMAIN;
  const aud = env.CF_ACCESS_AUD;
  if (!team || !aud) return null;

  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;

  let header, payload;
  try {
    header = JSON.parse(b64urlDecodeString(parts[0]));
    payload = JSON.parse(b64urlDecodeString(parts[1]));
  } catch {
    return null;
  }
  if (header.alg !== 'RS256') return null;
  if (payload.exp && payload.exp < now()) return null;

  const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audList.includes(aud)) return null;

  const keys = await fetchJwks(team);
  const jwk = keys.find((k) => !header.kid || k.kid === header.kid) || keys[0];
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    flexibleB64ToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );

  if (!ok) return null;
  return { email: payload.email || payload.common_name || 'access', sub: payload.sub };
}
