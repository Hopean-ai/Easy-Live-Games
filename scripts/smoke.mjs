// End-to-end check against a running server: `npm run dev`, then `node scripts/smoke.mjs [base-url]`.
// Plays the multiplayer flow with real WebSockets: join, sync, input, disconnect, rejoin, spectate.
import assert from 'node:assert/strict';

const base = process.argv[2] ?? 'http://localhost:8787';
const wsBase = base.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function join(code, name, token) {
  const ws = new WebSocket(`${wsBase}/api/rooms/${code}/ws?${new URLSearchParams({ name, token })}`);
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
console.log('smoke test passed');
process.exit(0);
