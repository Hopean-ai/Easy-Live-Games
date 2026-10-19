import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, newRoomCode } from '../src/router.js';

const worker = { fetch: handleRequest };
const ws = (url, headers = {}) => new Request(url, { headers: { Upgrade: 'websocket', ...headers } });

// A fake env: rooms and the matchmaker record the request they get; accounts know one session.
function env({ onRoom = () => new Response('ok'), onMatch = () => new Response('ok') } = {}) {
  const sessions = { good: 'Miles' };
  return {
    ROOMS: { idFromName: (name) => name, get: (id) => ({ fetch: (req) => onRoom(id, req) }) },
    MATCHMAKER: { idFromName: (name) => name, get: (id) => ({ fetch: (req) => onMatch(id, req) }) },
    ACCOUNTS: {
      idFromName: (name) => name,
      get: () => ({
        session: async (t) => sessions[t] ?? null,
        login: async (u, p) => (u === 'Miles' && p === 'password1' ? { name: 'Miles', token: 'good' } : { error: 'Wrong username or password.' }),
        register: async (u) => ({ name: u, token: 'new' }),
        logout: async (t) => delete sessions[t],
      }),
    },
    ASSETS: { fetch: () => new Response('asset') },
  };
}

test('new-room returns a readable code', async () => {
  const res = await worker.fetch(new Request('http://x/api/new-room'), env());
  const { code } = await res.json();
  assert.match(code, /^[A-HJ-NP-Z2-9]{5}$/);
  assert.match(newRoomCode(8), /^[A-HJ-NP-Z2-9]{8}$/);
});

test('room sockets route to the Durable Object named by the upper-cased code', async () => {
  let routed = null;
  const e = env({ onRoom: (id) => ((routed = id), new Response('ok')) });
  await worker.fetch(ws('http://x/api/rooms/abcd1/ws'), e);
  assert.equal(routed, 'ABCD1');
});

test('rejects bad codes and non-WebSocket requests', async () => {
  const e = env({ onRoom: () => assert.fail('should not reach the room') });
  const bad = await worker.fetch(ws('http://x/api/rooms/a%3Cb/ws'), e);
  assert.equal(bad.status, 400);
  const plain = await worker.fetch(new Request('http://x/api/rooms/ABCD/ws'), e);
  assert.equal(plain.status, 426);
});

test('signed-in players join rooms under their account name; spoofed headers are dropped', async () => {
  let seen = null;
  const e = env({ onRoom: (id, req) => ((seen = req), new Response('ok')) });
  await worker.fetch(ws('http://x/api/rooms/ABCD/ws?name=Imposter', { Cookie: 'sid=good' }), e);
  assert.equal(new URL(seen.url).searchParams.get('name'), 'Miles');
  assert.equal(seen.headers.get('X-Player-Account'), 'Miles');
  assert.equal(seen.headers.get('Cookie'), null);

  await worker.fetch(ws('http://x/api/rooms/ABCD/ws?name=Guesty', { 'X-Player-Account': 'Miles', Cookie: 'sid=bad' }), e);
  assert.equal(new URL(seen.url).searchParams.get('name'), 'Guesty');
  assert.equal(seen.headers.get('X-Player-Account'), null);
});

test('login sets an HttpOnly session cookie; a wrong password does not', async () => {
  const post = (path, body) => new Request(`http://x${path}`, { method: 'POST', body: JSON.stringify(body) });
  const ok = await worker.fetch(post('/api/login', { username: 'Miles', password: 'password1' }), env());
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { name: 'Miles' });
  assert.match(ok.headers.get('Set-Cookie'), /^sid=good; .*HttpOnly/);

  const bad = await worker.fetch(post('/api/login', { username: 'Miles', password: 'nope' }), env());
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('Set-Cookie'), null);

  const get = await worker.fetch(new Request('http://x/api/login'), env());
  assert.equal(get.status, 405);
});

test('/api/me reports the signed-in account, logout clears it', async () => {
  const e = env();
  const me = (cookie) => worker.fetch(new Request('http://x/api/me', { headers: { Cookie: cookie } }), e).then((r) => r.json());
  assert.deepEqual(await me('sid=good'), { name: 'Miles' });
  assert.deepEqual(await me(''), { name: null });
  const out = await worker.fetch(new Request('http://x/api/logout', { method: 'POST', headers: { Cookie: 'sid=good' } }), e);
  assert.match(out.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.deepEqual(await me('sid=good'), { name: null });
});

test('requests from another site are refused', async () => {
  const res = await worker.fetch(
    new Request('http://x/api/login', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' }),
    env(),
  );
  assert.equal(res.status, 403);
  const same = await worker.fetch(new Request('http://x/api/games', { headers: { Origin: 'http://x' } }), env());
  assert.equal(same.status, 200);
});

test('quick match queues by account or guest token, only for known games', async () => {
  let seen = null;
  const e = env({ onMatch: (id, req) => ((seen = { id, who: req.headers.get('X-Player') }), new Response('ok')) });
  await worker.fetch(ws('http://x/api/match/pong/ws?token=tab-token-1', { Cookie: 'sid=good', 'X-Player': 'spoof' }), e);
  assert.deepEqual(seen, { id: 'pong', who: 'account:miles' });
  await worker.fetch(ws('http://x/api/match/pong/ws?token=tab-token-1'), e);
  assert.deepEqual(seen, { id: 'pong', who: 'guest:tab-token-1' });
  const unknown = await worker.fetch(ws('http://x/api/match/chess/ws'), e);
  assert.equal(unknown.status, 404);
});

test('the games list names Pong and where to play it', async () => {
  const { games } = await (await worker.fetch(new Request('http://x/api/games'), env())).json();
  assert.deepEqual(games.map((g) => [g.id, g.page]), [['pong', '/pong']]);
  assert.equal(games[0].rooms, undefined);
});
