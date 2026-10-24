import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCtx } from './helpers/workers-stub.js';
import { handleRequest } from '../src/router.js';
import { masker, STALE_MS } from '../src/cfo/roblox.js';

const { CfoRoom } = await import('../src/cfo/room.js');

const post = (path, body, key = 'sekrit') => new Request(`http://x${path}`, { method: 'POST', headers: key ? { 'X-Roblox-Key': key } : {}, body: JSON.stringify(body) });

test('the Roblox route needs the shared key and reaches the room named by the code', async () => {
  let got = null;
  const env = { ROBLOX_KEY: 'sekrit', CFO_ROOMS: { idFromName: (n) => n, get: (id) => ({ roblox: async (b) => ((got = { id, b }), { version: 1 }) }) } };
  assert.equal((await handleRequest(post('/api/roblox/cfo/abcd', { op: 'poll' }), { ...env, ROBLOX_KEY: undefined })).status, 404);
  assert.equal((await handleRequest(post('/api/roblox/cfo/abcd', { op: 'poll' }, 'wrong'), env)).status, 401);
  assert.equal((await handleRequest(post('/api/roblox/cfo/abcd', { op: 'poll' }, null), env)).status, 401);
  assert.equal(got, null);
  const res = await handleRequest(post('/api/roblox/cfo/abcd', { op: 'poll', code: 'EVIL' }), env);
  assert.equal(res.status, 200);
  assert.deepEqual(got, { id: 'ABCD', b: { op: 'poll', code: 'ABCD' } });
});

test("web players' names are masked as whole words, longest first", () => {
  const mask = masker([{ name: 'Ann' }, { name: 'Anna' }, { name: 'Rob', roblox: '1' }]);
  assert.equal(mask("Anna pays Ann's rent to Rob. Annabel"), "Web player 2 pays Web player 1's rent to Rob. Annabel");
});

async function lobby() {
  const room = new CfoRoom(fakeCtx(), {});
  // A web player is seated as a socket would seat them.
  room.room.seats.push({ token: 'web-token-1', name: 'Miles', guest: false, account: 'miles', admin: false });
  room.socketsFor = (seat) => (room.room.seats[seat]?.roblox ? [] : [{}]);
  for (const [userId, name] of [['111', 'RobA'], ['222', 'RobB']]) {
    const r = await room.roblox({ op: 'join', userId, name, code: 'ABCD' });
    assert.equal(typeof r.seat, 'number');
    assert.equal(r.board.squares.length > 60, true);
  }
  return room;
}

test('Roblox players join, see masked web names, get a bookkeeper and play from the menu', async () => {
  const room = await lobby();
  assert.equal(room.room.seats[1].roblox, '111');
  const start = await room.roblox({ op: 'act', userId: '111', msg: { t: 'start' } });
  assert.equal(start.error, null); // the web player is the host, so nothing happens
  assert.equal(room.room.status, 'waiting');
  assert.equal(room.apply(0, { t: 'start' }).changed, true);
  assert.equal(room.room.status, 'playing');
  assert.ok(room.room.game.players[1].outsourced && room.room.game.players[2].outsourced);
  assert.ok(!room.room.game.players[0].outsourced);
  await room.changed();

  const first = await room.roblox({ op: 'poll', userIds: ['111', '222'], since: -1 });
  const view = first.views['111'];
  assert.equal(view.seat, 1);
  assert.deepEqual(view.seats.map((s) => s.name), ['Web player 1', 'RobA', 'RobB']);
  assert.ok(view.game.log.every((l) => !l.includes('Miles')));
  assert.ok(view.game.players[1].hand, 'a player sees their own hand');
  assert.equal(view.game.players[2].hand, undefined, "but not anyone else's");
  assert.deepEqual(await room.roblox({ op: 'poll', userIds: ['111'], since: first.version }), { version: first.version, same: true });

  // Play the web player's turn, then a Roblox player's, from the menu.
  room.apply(0, { t: 'act', a: 'roll' });
  while (room.room.game.turn === 0) room.apply(0, { t: 'act', a: room.room.game.phase === 'buy' ? 'pass' : 'end' });
  await room.changed();
  const turn = room.room.game.turn;
  const userId = room.room.seats[turn].roblox;
  const menu = (await room.roblox({ op: 'poll', userIds: [userId], since: -1 })).views[userId].game.moves;
  const roll = menu.find((m) => m.action.a === 'roll');
  assert.ok(roll, 'roll is on the menu');
  const before = room.room.version;
  const res = await room.roblox({ op: 'act', userId, msg: { t: 'act', ...roll.action } });
  assert.equal(res.error, null);
  assert.ok(res.version > before);
  assert.equal((await room.roblox({ op: 'act', userId, msg: { t: 'act', a: 'roll' } })).error, 'You have already rolled.');
  assert.equal((await room.roblox({ op: 'act', userId: '999', msg: { t: 'act', a: 'roll' } })).error, 'You are watching this game.');
});

test('a Roblox player whose server stops polling leaves the lobby, and shows away mid-game', async (t) => {
  const room = await lobby();
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + STALE_MS + 1000);
  await room.roblox({ op: 'poll', userIds: ['222'], since: -1 });
  assert.deepEqual(room.room.seats.map((s) => s.name), ['Miles', 'RobB']);
  room.apply(0, { t: 'start' });
  t.mock.method(Date, 'now', () => now + 3 * STALE_MS);
  assert.equal(room.isConnected(1), false);
  assert.equal(room.room.seats.length, 2, 'seats are kept once the game is on');
  await room.roblox({ op: 'poll', userIds: ['222'], since: -1 });
  assert.equal(room.isConnected(1), true);
});

test('bad Roblox requests are refused', async () => {
  const room = new CfoRoom(fakeCtx(), {});
  assert.equal((await room.roblox({ op: 'join', userId: 'abc' })).error, 'Bad user id.');
  assert.equal((await room.roblox({ op: 'nope' })).error, 'Unknown request.');
  assert.equal((await room.roblox({ op: 'act', userId: '1' })).error, 'Bad move.');
});
