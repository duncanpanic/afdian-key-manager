// Key 生成：Crockford Base32 + Luhn mod 32 校验位
// 格式： PREFIX-XXXX-XXXX-XXXX-XXXX-C
// 字符集剔除 I L O U，避免手抄/口述歧义

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // 32 字符
const N = 32;

function randomChars(n) {
  const bytes = new Uint8Array(n * 2);
  crypto.getRandomValues(bytes);
  let out = '';
  // 拒绝采样，消除 256 % 32 之外的偏差（256 是 32 的整数倍，其实无偏，这里保持严谨）
  for (let i = 0; i < bytes.length && out.length < n; i++) {
    out += ALPHABET[bytes[i] % N];
  }
  return out.slice(0, n);
}

// Luhn mod N 校验位
function luhnCheckChar(str) {
  let factor = 2;
  let sum = 0;
  for (let i = str.length - 1; i >= 0; i--) {
    const code = ALPHABET.indexOf(str[i]);
    if (code < 0) continue;
    let addend = factor * code;
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / N) + (addend % N);
    sum += addend;
  }
  return ALPHABET[(N - (sum % N)) % N];
}

const clean = (s) => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

/**
 * 拼装展示格式：PREFIX-XXXX-XXXX-XXXX-XXXX-XXXX-C
 * 校验位基于「前缀 + 随机体」整体计算，因此校验时无需知道前缀长度。
 */
export function formatKey(prefix, body) {
  const p = clean(prefix);
  const b = clean(body);
  const full = p + b;
  const all = full + luhnCheckChar(full);
  const rest = all.slice(p.length);
  return (p ? p + '-' : '') + (rest.match(/.{1,4}/g) || []).join('-');
}

/** 生成一枚 key（含校验位）。bodyLen 建议 20 位（100 bit 熵） */
export function generateKey(prefix, bodyLen = 20) {
  return formatKey(prefix, randomChars(bodyLen));
}

/** 本地校验格式与校验位 */
export function checkKeyFormat(key) {
  const raw = clean(key);
  if (raw.length < 12) return { valid: false, reason: 'too_short' };
  const body = raw.slice(0, -1);
  const check = raw.slice(-1);
  if (!ALPHABET.includes(check)) return { valid: false, reason: 'bad_char' };
  if (luhnCheckChar(body) !== check) return { valid: false, reason: 'checksum' };
  return { valid: true };
}

/** 查询用归一化：去掉所有分隔符，大写。数据库以它建唯一索引，避免分组差异导致查不到 */
export function normKey(key) {
  return clean(key);
}

