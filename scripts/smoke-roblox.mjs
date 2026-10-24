// End-to-end check of Roblox cross-play against a running server. Start one with the key set:
//   npx wrangler dev --var ROBLOX_KEY:local-key
// then `node scripts/smoke-roblox.mjs [base-url] [key]`. A web player hosts a room over a
// WebSocket, two Roblox players join over HTTP as the Roblox game server would, and everyone
// plays a few turns; the Roblox players use only the menu the server sends them.
import assert from 'node:assert/strict';

const base = process.argv[2] ?? 'http://localhost:8787';
const key = process.argv[3] ?? 'local-key';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { code } = await (await fetch(`${base}/api/new-room`)).json();
const roblox = async (body, k = key) => {
  const res = await fetch(`${base}/api/roblox/cfo/${code}`, { method: 'POST', headers: { 'X-Roblox-Key': k, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, ...(await res.json()) };
};

assert.equal((await roblox({ op: 'poll', userIds: [] }, 'wrong')).status, 401);

const web = new WebSocket(`${base.replace(/^http/, 'ws')}/api/rooms/cfo/${code}/ws?token=smoke-web-token-1&name=Webby`);
const webState = { last: null, seat: null };
web.addEventListener('message', (e) => {
  if (e.data === 'pong') return;
  const m = JSON.parse(e.data);
  if (m.t === 'welcome') webState.seat = m.seat;
  if (m.t === 'state') webState.last = m;
});
await new Promise((r) => web.addEventListener('open', r));
while (webState.seat === null) await sleep(20);

const ids = ['1001', '1002'];
for (const [i, userId] of ids.entries()) {
  const r = await roblox({ op: 'join', userId, name: `Rob${i + 1}` });
  assert.equal(r.seat, i + 1);
  assert.equal(r.board.size, 62);
}
console.log('room', code, 'has a web player and two Roblox players');
await sleep(200);
assert.deepEqual(webState.last.seats.map((s) => s.platform), ['web', 'roblox', 'roblox']);

web.send(JSON.stringify({ t: 'start' }));
let poll;
for (let i = 0; i < 50; i++) {
  poll = await roblox({ op: 'poll', userIds: ids, since: -1 });
  if (poll.views[ids[0]].status === 'playing') break;
  await sleep(100);
}
const view = poll.views[ids[0]];
assert.equal(view.status, 'playing');
assert.equal(view.seats[0].name, 'Web player 1', 'web names are masked');
console.log('game started; Roblox sees', view.seats.map((s) => s.name).join(', '));

// Play: the web player rolls and ends; Roblox players pick roll, buy, then end from their menus.
let since = -1;
let robloxMoves = 0;
for (let step = 0; step < 60; step++) {
  const g = webState.last.game;
  if (g.turn === webState.seat) {
    web.send(JSON.stringify({ t: 'act', a: g.phase === 'roll' ? 'roll' : g.phase === 'buy' ? 'pass' : 'end' }));
    await sleep(150);
    continue;
  }
  const userId = ids[g.turn - 1];
  const p = await roblox({ op: 'poll', userIds: [userId], since });
  if (!p.same) since = p.version;
  const menu = p.views?.[userId]?.game.moves ?? [];
  const pick = ['roll', 'buy', 'end', 'pass'].map((a) => menu.find((m) => m.action.a === a && !m.input)).find(Boolean);
  if (!pick) {
    await sleep(100);
    continue;
  }
  const r = await roblox({ op: 'act', userId, msg: { t: 'act', ...pick.action } });
  assert.equal(r.error, null, `${pick.label} was refused: ${r.error}`);
  robloxMoves += 1;
  await sleep(150);
}
assert.ok(robloxMoves >= 10, `only ${robloxMoves} Roblox moves were made`);
console.log(`ok: ${robloxMoves} Roblox moves made from the menu, game log has ${webState.last.game.log.length} lines`);
web.close();
