// Prints what the website sends a Roblox player mid-game, for the Roblox screen test
// (roblox/tests/screens.luau): node scripts/roblox-fixture.mjs > roblox/tests/fixture.json
// Built from the current rules each time, so the test always draws today's format.
import { createGame, act } from '../src/cfo/rules.js';
import { robloxBoard, robloxState } from '../src/cfo/roblox.js';
import { DatabaseSync } from 'node:sqlite';
import { fakeCtx } from '../test/helpers/workers-stub.js';
import { seeded, MAX_DRIFT_MS, REDRIFT_MS, DAY_MS } from '../src/driftmail/world.js';
import { robloxWorld } from '../src/driftmail/roblox.js';
import { robloxLegio } from '../src/legio/roblox.js';

const { Ocean } = await import('../src/driftmail/ocean.js');
const { Camp } = await import('../src/legio/camp.js');

const seats = [{ name: 'Miles' }, { name: 'RobA', roblox: '1' }, { name: 'RobB', roblox: '2' }];
const room = { status: 'playing', seats, game: createGame(seats.map((s) => s.name), 42) };
const g = room.game;
for (let i = 0; i < 12; i++) {
  const s = g.turn;
  act(g, s, { a: 'roll' });
  if (g.phase === 'buy') act(g, s, { a: 'buy', zone: 0 }) && act(g, s, { a: 'buy' });
  act(g, s, { a: 'end' });
}
// One journal entry posted by the player whose view is drawn, so the journal has something in it.
const me = g.players[g.turn];
act(g, g.turn, { a: 'entry', year: 1, memo: me.docs[0].text, lines: me.docs[0].lines });
const waiting = { status: 'waiting', seats, game: null };

// Driftmail: a Roblox player's island with a letter, an old bottle on the sand, a journal page and
// an ability, as the website sends it.
const db = new DatabaseSync(':memory:');
const sql = {
  exec(query, ...params) {
    if (!params.length && query.split(';').filter((q) => q.trim()).length > 1) {
      db.exec(query);
      return { toArray: () => [] };
    }
    const rows = db.prepare(query).all(...params);
    return { toArray: () => rows };
  },
};
const ocean = new Ocean({ ...fakeCtx(), storage: { ...fakeCtx().storage, sql } }, {});
let now = 10 * DAY_MS;
ocean.now = () => now;
ocean.rand = seeded(5);
const rb = { userId: '1', name: 'RobA' };
await robloxWorld(ocean, { ...rb, op: 'state' });
await ocean.visit('miles');
await ocean.throwBottle('miles', { text: 'Is anyone out there?\nI can see smoke to the east.', signed: true, dir: 0, strength: 0.5 });
const island = ocean.island('roblox:1');
island.kit = { ...island.kit, pages: ['salt-knots'], abilities: ['knots'], fish: 3, bones: 2, builds: { desk: 1, workshop: 1 } };
ocean.saveIsland(island);
now += MAX_DRIFT_MS + 2 * REDRIFT_MS;
await ocean.alarm();
let world = await robloxWorld(ocean, { ...rb, op: 'state' });
world = await robloxWorld(ocean, { ...rb, op: 'open', id: world.beach[0].id });
ocean.oldBottle(ocean.island('roblox:1'), now);
await robloxWorld(ocean, { ...rb, op: 'throw', text: 'Hello from Roblox.', dir: 2, strength: 0.6 });
world = await robloxWorld(ocean, { ...rb, op: 'state' });

// Legio: a Roblox player's career a few cards in, with a finished career of theirs and a web
// player's on the leaderboard.
const legioDb = new DatabaseSync(':memory:');
const legioSql = { exec: (query, ...params) => (params.length || query.split(';').filter((q) => q.trim()).length < 2 ? (() => { const rows = legioDb.prepare(query).all(...params); return { toArray: () => rows }; })() : (legioDb.exec(query), { toArray: () => [] })) };
const camp = new Camp({ ...fakeCtx(), storage: { ...fakeCtx().storage, sql: legioSql } }, {});
let legioSeed = 0;
camp.seed = () => ++legioSeed;
for (const who of ['miles', 'roblox:1']) {
  let st = await camp.enlist(who);
  while (!st.run.over) st = await camp.choose(who, { i: st.run.card.choices.findIndex((c) => !c.off), turn: st.run.turn });
}
let legio = await robloxLegio(camp, { ...rb, op: 'enlist' });
for (let i = 0; i < 6; i++) legio = await robloxLegio(camp, { ...rb, op: 'choose', i: 0, turn: legio.run.turn });

console.log(JSON.stringify({
  legio,
  driftmail: world,
  board: robloxBoard(),
  waiting: robloxState(waiting, 1, 0),
  playing: robloxState(room, g.turn, 0),
  watching: robloxState(room, null, 0),
}));
