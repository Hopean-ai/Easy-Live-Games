import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkUsername, checkPassword, hashPassword, verifyPassword, newSessionToken, tokenKey, readCookie, sessionCookie,
} from '../src/auth.js';

test('usernames are 3 to 16 safe characters', () => {
  assert.equal(checkUsername(' miles_2 '), 'miles_2');
  assert.equal(checkUsername('ab'), null);
  assert.equal(checkUsername('a'.repeat(17)), null);
  assert.equal(checkUsername('<b>x</b>'), null);
  assert.equal(checkUsername(undefined), null);
});

test('passwords need 8 to 128 characters', () => {
  assert.equal(checkPassword('longenough'), null);
  assert.match(checkPassword('short'), /at least 8/);
  assert.match(checkPassword('x'.repeat(129)), /at most 128/);
  assert.ok(checkPassword(12345678));
});

test('a hashed password verifies, a wrong one does not, and salts differ', async () => {
  const stored = await hashPassword('correct horse', undefined, 1000);
  assert.equal(await verifyPassword('correct horse', stored), true);
  assert.equal(await verifyPassword('correct horsf', stored), false);
  const again = await hashPassword('correct horse', undefined, 1000);
  assert.notEqual(again.salt, stored.salt);
  assert.notEqual(again.hash, stored.hash);
});

test('session tokens are random and stored only as a digest', async () => {
  const a = newSessionToken();
  assert.match(a, /^[\w-]{43}$/);
  assert.notEqual(a, newSessionToken());
  const key = await tokenKey(a);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(key, await tokenKey(a));
});

test('cookies are read by name and set HttpOnly, Secure only over https', () => {
  const req = new Request('https://x/', { headers: { Cookie: 'a=1; sid=abc-123; b=2' } });
  assert.equal(readCookie(req, 'sid'), 'abc-123');
  assert.equal(readCookie(req, 'nope'), null);
  const set = sessionCookie('tok', req);
  assert.match(set, /^sid=tok; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
  assert.doesNotMatch(sessionCookie('tok', new Request('http://localhost/')), /Secure/);
  assert.match(sessionCookie(null, req), /^sid=; .*Max-Age=0/);
});
