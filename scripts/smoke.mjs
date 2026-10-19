// End-to-end check against a running server: `npm run dev`, then `node scripts/smoke.mjs [base-url]`.
// Plays the multiplayer flow with real WebSockets: join, sync, input, disconnect, rejoin, spectate,
// then signs up, logs in and pairs players through quick match.
import assert from 'node:assert/strict';

const base = process.argv[2] ?? 'http://localhost:8787';
const wsBase = base.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function join(code, name, token, cookie) {
  return open(`/api/rooms/${code}/ws?${new URLSearchParams({ name, token })}`, cookie);
}

function open(path, cookie) {
  const ws = new WebSocket(`${wsBase}${path}`, cookie ? { headers: { Cookie: cookie } } : undefined);
  const client = { ws, msgs: [], last: {} };
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    client.msgs.push(m);
    client.last[m.t] = m;
  });
  client.send = (m) => ws.send(JSON.stringify(m));
  client.until = async (pred, what, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred(client)) return;
      await sleep(20);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  ws.addEventListener('close', (e) => (client.closeCode = e.code));
  return client;
}

const { code } = await (await fetch(`${base}/api/new-room`)).json();
console.log('room', code);

const a = join(code, '<b>Alice</b>', 'token-alice-1');
await a.until((c) => c.last.welcome, 'alice welcome');
assert.equal(a.last.welcome.side, 'left');
await a.until((c) => c.last.lobby?.status === 'waiting', 'waiting lobby');

const b = join(code, 'Bob', 'token-bob-1');
await b.until((c) => c.last.welcome, 'bob welcome');
assert.equal(b.last.welcome.side, 'right');
await a.until((c) => c.last.lobby?.status === 'playing', 'game start');
assert.equal(a.last.lobby.players.left.name, '<b>Alice</b>'); // sent as data; the client renders it as text
console.log('both seated, game started');

await b.until((c) => c.msgs.filter((m) => m.t === 'state').length > 10, 'state stream');
const y0 = b.last.state.r;
b.send({ t: 'input', dir: y0 > 100 ? -1 : 1 });
await sleep(300);
b.send({ t: 'input', dir: 0 });
await sleep(100);
assert.notEqual(a.last.state.r, y0, 'alice should see bob\'s paddle move');
assert.equal(a.last.state.r, b.last.state.r, 'both clients agree on the paddle');
console.log('input syncs to the other player');

// Nobody defends, so someone concedes and earns a skill point to spend.
await a.until((c) => c.last.skills && (c.last.skills.left.points || c.last.skills.right.points), 'a skill point', 10000);
const loser = a.last.skills.left.points ? 'left' : 'right';
const buyer = loser === 'left' ? a : b;
buyer.send({ t: 'skill', id: 'reach2' }); // locked: needs reach1 first
buyer.send({ t: 'skill', id: 'reach1' });
await a.until((c) => c.last.skills[loser].owned.includes('reach1'), 'skill bought');
assert.deepEqual(a.last.skills[loser].owned, ['reach1']);
await a.until((c) => c.last.state[loser === 'left' ? 'lh' : 'rh'] > a.last.welcome.paddle.height, 'taller paddle');
console.log(`${loser} conceded, earned a point and bought a taller paddle`);

const spectator = join(code, 'Eve', 'token-eve-1');
await spectator.until((c) => c.last.welcome, 'spectator welcome');
assert.equal(spectator.last.welcome.side, null);
console.log('third connection spectates');

b.ws.close();
await a.until((c) => c.last.lobby?.status === 'paused', 'pause on disconnect');
assert.equal(a.last.lobby.players.right.connected, false);
console.log('disconnect pauses the game and holds the seat');

const b2 = join(code, 'Bob', 'token-bob-1');
await b2.until((c) => c.last.welcome, 'bob rejoin');
assert.equal(b2.last.welcome.side, 'right');
await a.until((c) => c.last.lobby?.status === 'playing', 'resume');
console.log('rejoining with the same token resumes as the same side');

const b3 = join(code, 'Bob', 'token-bob-1');
await b3.until((c) => c.last.welcome, 'bob second tab');
await b2.until((c) => c.last.replaced, 'older tab told it was replaced');
assert.equal(a.last.lobby.status, 'playing', 'replacing a tab does not pause');
console.log('a second tab replaces the first without pausing');

for (const c of [a, b3, spectator]) c.ws.close();
console.log('room flow passed');

// ---- Accounts ----
const post = (path, body, cookie) => fetch(`${base}${path}`, {
  method: 'POST', body: JSON.stringify(body), headers: cookie ? { Cookie: cookie } : {},
});
const user = `smoke${Date.now().toString(36).slice(-8)}`;
const reg = await post('/api/register', { username: user, password: 'smoke-password' });
assert.equal(reg.status, 200, await reg.clone().text());
assert.equal((await post('/api/register', { username: user.toUpperCase(), password: 'smoke-password' })).status, 400, 'names are unique ignoring case');
assert.equal((await post('/api/login', { username: user, password: 'wrong-password' })).status, 401);
const login = await post('/api/login', { username: user.toUpperCase(), password: 'smoke-password' });
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie').split(';')[0];
assert.match(login.headers.get('set-cookie'), /HttpOnly/);
const me = await (await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })).json();
assert.equal(me.name, user);
console.log('sign up, wrong password, log in and session lookup work');

// ---- Quick match ----
const q1 = open(`/api/match/pong/ws?token=token-q1-aaaa`, cookie);
await q1.until((c) => c.last.queued, 'queued');
const q2 = open(`/api/match/pong/ws?token=token-q2-aaaa`);
await q1.until((c) => c.last.matched, 'match for first player');
await q2.until((c) => c.last.matched, 'match for second player');
assert.equal(q1.last.matched.room, q2.last.matched.room);
for (const c of [q1, q2]) c.ws.close();
console.log('two players in the queue are paired into room', q1.last.matched.room);

const room2 = q1.last.matched.room;
const p1 = join(room2, 'Imposter', 'token-q1-aaaa', cookie);
const p2 = join(room2, 'Guest', 'token-q2-aaaa');
await p1.until((c) => c.last.lobby?.status === 'playing', 'matched game starts');
const players = p1.last.lobby.players;
const [mine, theirs] = p1.last.welcome.side === 'left' ? [players.left, players.right] : [players.right, players.left];
assert.equal(mine.name, user, 'signed-in player plays under their account name');
assert.equal(mine.guest, false);
assert.deepEqual([theirs.name, theirs.guest], ['Guest', true]);
console.log('matched players meet in the room; accounts and guests are told apart');

// The same player queueing from two tabs is never matched with themselves.
const t1 = open(`/api/match/pong/ws?token=token-t1-aaaa`, cookie);
await t1.until((c) => c.last.queued, 'tab one queued');
const t2 = open(`/api/match/pong/ws?token=token-t2-aaaa`, cookie);
await t2.until((c) => c.last.queued, 'tab two queued');
await t1.until((c) => c.last.replaced, 'older tab leaves the queue');
assert.equal(t2.last.matched, undefined);
t2.ws.close();
console.log('a second tab replaces the first in the queue');

assert.equal((await post('/api/logout', {}, cookie)).status, 200);
assert.equal((await (await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })).json()).name, null);
console.log('logout ends the session');

for (const c of [p1, p2]) c.ws.close();
console.log('smoke test passed');
process.exit(0);
