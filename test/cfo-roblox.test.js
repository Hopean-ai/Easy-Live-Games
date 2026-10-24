import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCtx } from './helpers/workers-stub.js';
import { handleRequest } from '../src/router.js';
import { masker, robloxState, STALE_MS } from '../src/cfo/roblox.js';

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

test("documents and memos that name web players are masked, without changing the game", async () => {
  const { createGame } = await import('../src/cfo/rules.js');
  const seats = [{ name: 'Miles' }, { name: 'RobA', roblox: '1' }];
  const room = { status: 'playing', seats, game: createGame(seats.map((s) => s.name), 7) };
  const me = room.game.players[1];
  me.docs.push({ id: 99, text: 'Rent paid to Miles: $1,400 paid', year: 1, archived: false, lines: [['expRent', 1400], ['cash', -1400]] });
  me.entries.push({ id: 5, year: 1, memo: 'Rent to Miles', lines: [['expRent', 1400], ['cash', -1400]] });
  const { books } = robloxState(room, 1, 0).game;
  assert.equal(books.docs.at(-1).text, 'Rent paid to Web player 1: $1,400 paid');
  assert.equal(books.entries.at(-1).memo, 'Rent to Web player 1');
  assert.equal(me.docs.at(-1).text, 'Rent paid to Miles: $1,400 paid');
  assert.equal(me.entries.at(-1).memo, 'Rent to Miles');
  assert.equal(books.docs.at(-1).lines, undefined, 'the right answer stays on the website');
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

test('Roblox players join, see masked web names and their books, and play from the menu', async () => {
  const room = await lobby();
  assert.equal(room.room.seats[1].roblox, '111');
  const start = await room.roblox({ op: 'act', userId: '111', msg: { t: 'start' } });
  assert.equal(start.error, null); // the web player is the host, so nothing happens
  assert.equal(room.room.status, 'waiting');
  assert.equal(room.apply(0, { t: 'start' }).changed, true);
  assert.equal(room.room.status, 'playing');
  assert.ok(!room.room.game.players[1].outsourced, 'Roblox players keep their own books, as on the web');
  await room.changed();

  const first = await room.roblox({ op: 'poll', userIds: ['111', '222'], since: -1 });
  const view = first.views['111'];
  assert.equal(view.seat, 1);
  assert.deepEqual(view.seats.map((s) => s.name), ['Web player 1', 'RobA', 'RobB']);
  assert.ok(view.game.log.every((l) => !l.includes('Miles')));
  assert.ok(view.game.players[1].hand, 'a player sees their own hand');
  assert.equal(view.game.players[2].hand, undefined, "but not anyone else's");
  assert.ok(view.game.books.docs.length > 0, 'their source documents are there to record');
  assert.deepEqual(view.game.books.openYears, [1]);
  // Record the opening capital as a journal entry, as a Roblox player would.
  const doc = room.room.game.players[1].docs[0];
  const entry = await room.roblox({ op: 'act', userId: '111', msg: { t: 'act', a: 'entry', year: 1, memo: 'Capital', lines: room.room.game.players[1].docs[0].lines.map(([acct, v]) => [acct, v]) } });
  assert.equal(entry.error, null, `entry refused: ${entry.error}`);
  assert.ok(doc);
  const after = (await room.roblox({ op: 'poll', userIds: ['111'], since: -1 })).views['111'];
  assert.equal(after.game.books.entries.length, 1);
  const latest = (await room.roblox({ op: 'poll', userIds: ['111'], since: -1 })).version;
  assert.deepEqual(await room.roblox({ op: 'poll', userIds: ['111'], since: latest }), { version: latest, same: true });

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
