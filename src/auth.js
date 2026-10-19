// Password hashing, session tokens and cookie helpers. Pure WebCrypto, so the tests run in Node
// and nothing here needs a secret configured in Cloudflare.

export const SESSION_COOKIE = 'sid';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Workers caps PBKDF2 at 100,000 iterations. The count is stored with each hash so it can change.
export const PBKDF2_ITERATIONS = 100_000;
const USERNAME = /^[A-Za-z0-9_-]{3,16}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;

export function checkUsername(raw) {
  const name = String(raw ?? '').trim();
  return USERNAME.test(name) ? name : null;
}

export function checkPassword(raw) {
  if (typeof raw !== 'string') return 'Enter a password.';
  if (raw.length < MIN_PASSWORD) return `Passwords need at least ${MIN_PASSWORD} characters.`;
  if (raw.length > MAX_PASSWORD) return `Passwords can be at most ${MAX_PASSWORD} characters.`;
  return null;
}

export async function hashPassword(password, salt = randomBytes(16), iterations = PBKDF2_ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return { salt: toHex(salt), hash: toHex(new Uint8Array(bits)), iterations };
}

export async function verifyPassword(password, stored) {
  const { hash } = await hashPassword(password, fromHex(stored.salt), stored.iterations);
  return sameString(hash, stored.hash);
}

// Session tokens go to the browser; only their SHA-256 is stored, so a leaked table can't log anyone in.
export function newSessionToken() {
  return toBase64Url(randomBytes(32));
}

export async function tokenKey(token) {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));
}

export function readCookie(request, name) {
  const header = request.headers.get('Cookie') ?? '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionCookie(token, request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  const maxAge = token ? Math.floor(SESSION_TTL_MS / 1000) : 0;
  return `${SESSION_COOKIE}=${token ?? ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  return new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
}

function toBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Constant-time comparison, so response timing doesn't reveal how much of a hash matched.
function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
