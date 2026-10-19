// End-to-end check of CFO against a running server: `npm run dev`, then
// `node scripts/smoke-cfo.mjs [base-url]`. Three players quick match (the queue waits for more
// before starting with three), join the room, and play a few turns; one reconnects mid-game.
import assert from 'node:assert/strict';

const base = process.argv[2] ?? 'http://localhost:8787';
const wsBase = base.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open(path) {
  const ws = new WebSocket(`${wsBase}${path}`);
  const client = { ws, msgs: [], last: {} };
  ws.addEventListener('message', (e) => {
    if (e.data === 'pong') return;
    const m = JSON.parse(e.data);
    client.msgs.push(m);
    client.last[m.t] = m;
  });
  client.send = (m) => ws.send(JSON.stringify(m));
  client.until = async (pred, what, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred(client)) return;
      await sleep(20);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  return client;
}

const names = ['Ann', 'Ben', 'Cy'];
const queue = names.map((n) => open(`/api/match/cfo/ws?token=queue-token-${n}`));
await queue[2].until((c) => c.last.queued?.waiting === 3, 'three in the queue');
assert.ok(queue[2].last.queued.startsAt, 'a countdown starts once two are waiting');
console.log('three queued, waiting for more');
for (const q of queue) await q.until((c) => c.last.matched, 'matched', 20000);
const room = queue[0].last.matched.room;
assert.ok(queue.every((q) => q.last.matched.room === room && q.last.matched.players === 3));
console.log('matched into', room);

const join = (n) => open(`/api/rooms/cfo/${room}/ws?${new URLSearchParams({ token: `room-token-${n}`, name: n, expect: 3 })}`);
const players = names.map(join);
await players[0].until((c) => c.last.state?.status === 'playing', 'game start');
const seatOf = (c) => c.last.welcome.seat;
console.log('game started with', players[0].last.state.seats.map((s) => s.name).join(', '));

// Each player plays a few turns: roll, pass on anything for sale, end.
for (let i = 0; i < 9; i++) {
  const g = players[0].last.state.game;
  const cur = players.find((p) => seatOf(p) === g.turn);
  const before = cur.msgs.length;
  cur.send({ t: 'act', a: 'roll' });
  await cur.until((c) => c.msgs.length > before && c.last.state.game.phase !== 'roll', 'roll result');
  if (cur.last.state.game.phase === 'buy') cur.send({ t: 'act', a: 'pass' });
  if (cur.last.state.game.players[g.turn].fyeDue) cur.send({ t: 'act', a: 'statements' });
  cur.send({ t: 'act', a: 'end' });
  await players[0].until((c) => c.last.state.game.turn !== g.turn || c.last.state.game.phase === 'over', 'next turn');
}
console.log('nine turns played; log:', players[0].last.state.game.log.slice(-3).join(' | '));

// Acting out of turn is refused.
const idle = players.find((p) => seatOf(p) !== players[0].last.state.game.turn);
idle.send({ t: 'act', a: 'roll' });
await idle.until((c) => c.last.error, 'refusal');
assert.equal(idle.last.error.text, 'It is not your turn.');

// Hands stay private.
assert.ok(players.every((p) => p.last.state.game.players.filter((q) => q.hand).length === 1));

// A reconnecting player gets their seat back.
const seat = seatOf(players[1]);
players[1].ws.close();
await sleep(300);
const back = join('Ben');
await back.until((c) => c.last.welcome, 'welcome back');
assert.equal(seatOf(back), seat);
console.log('reconnect keeps the seat');

for (const p of [...players, back, ...queue]) p.ws.close();
console.log('CFO smoke test passed');
