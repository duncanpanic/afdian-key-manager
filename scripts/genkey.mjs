#!/usr/bin/env node
// 生成 RS256 密钥对（许可证令牌签发用）
// 用法：node scripts/genkey.mjs
// 产物：keys/private.pem（PKCS#8）、keys/public.pem（SPKI）

import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = resolve(process.cwd(), 'keys');
mkdirSync(outDir, { recursive: true });

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const privPath = resolve(outDir, 'private.pem');
const pubPath = resolve(outDir, 'public.pem');
writeFileSync(privPath, privateKey, 'utf8');
writeFileSync(pubPath, publicKey, 'utf8');

console.log('\n✅ 密钥对已生成\n');
console.log('  私钥：' + privPath);
console.log('  公钥：' + pubPath + '\n');

console.log('下一步（二选一）：\n');
console.log('【生产环境】把私钥写入 Worker Secret：');
console.log('  npx wrangler secret put LICENSE_PRIVATE_KEY');
console.log('  然后把 keys/private.pem 的全文粘贴进去（含 BEGIN/END 行）\n');

console.log('【本地开发】写入 .dev.vars：');
console.log('  LICENSE_PRIVATE_KEY=' + privateKey.replace(/\n/g, '\\n') + '\n');

console.log('⚠️  keys/ 已加入 .gitignore，请勿提交到仓库。私钥一旦泄露，任何人都能签发合法令牌。\n');
console.log('客户端内置的公钥（也在管理台「设置」页可复制）：\n');
console.log(publicKey);
