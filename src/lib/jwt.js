// JWT：RS256 签发（许可证令牌）+ HS256 会话（管理员登录）

import { b64urlEncodeString, b64urlDecodeString, pemToDer, now } from './util.js';

let _privKey = null;
let _privPem = '';
let _pubPem = '';

async function getPrivateKey(env) {
  const pem = env.LICENSE_PRIVATE_KEY;
  if (!pem) throw new Error('LICENSE_PRIVATE_KEY 未配置');
  if (_privKey && _privPem === pem) return _privKey;
  // extractable 必须为 true，否则无法从私钥中导出公钥给客户端使用
  _privKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['sign']
  );
  _privPem = pem;
  _pubPem = '';
  return _privKey;
}

export async function signRS256(env, payload) {
  const key = await getPrivateKey(env);
  const header = { alg: 'RS256', typ: 'JWT', kid: 'k1' };
  const h = b64urlEncodeString(JSON.stringify(header));
  const p = b64urlEncodeString(JSON.stringify(payload));
  const data = new TextEncoder().encode(`${h}.${p}`);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, data);
  const s = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${h}.${p}.${s}`;
}

/** 从私钥导出公钥（PEM），供客户端内置 */
export async function getPublicKeyPem(env) {
  if (_pubPem) return _pubPem;
  const key = await getPrivateKey(env);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  const pubJwk = { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true };
  const pubKey = await crypto.subtle.importKey(
    'jwk',
    pubJwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['verify']
  );
  const spki = await crypto.subtle.exportKey('spki', pubKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(spki)));
  const lines = b64.match(/.{1,64}/g).join('\n');
  _pubPem = `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
  return _pubPem;
}

// ---------- HS256 会话 ----------

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signHS256(secret, payload) {
  const h = b64urlEncodeString(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64urlEncodeString(JSON.stringify(payload));
  const data = new TextEncoder().encode(`${h}.${p}`);
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), data);
  const s = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${h}.${p}.${s}`;
}

export async function verifyHS256(secret, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const pad = (4 - (parts[2].length % 4)) % 4;
  const bin = atob(parts[2].replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad));
  const sig = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) sig[i] = bin.charCodeAt(i);
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig, data);
  if (!ok) return null;
  try {
    const payload = JSON.parse(b64urlDecodeString(parts[1]));
    if (payload.exp && payload.exp < now()) return null;
    return payload;
  } catch {
    return null;
  }
}
