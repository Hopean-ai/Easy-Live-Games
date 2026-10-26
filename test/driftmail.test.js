import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fakeCtx } from './helpers/workers-stub.js';
import {
  DAY_MS, MAX_DRIFT_MS, REDRIFT_MS, TIDE_MS, clock, current, directionTo, drift, finder, placeIsland, seeded, shore,
} from '../src/driftmail/world.js';

const { Ocean } = await import('../src/driftmail/ocean.js');

// The Ocean object over a real in-memory SQLite, with a clock and dice the test controls.
function ocean({ claude = false, t = 10 * DAY_MS, seed = 1 } = {}) {
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
  const o = new Ocean({ ...fakeCtx(), storage: { ...fakeCtx().storage, sql } }, claude ? { ANTHROPIC_API_KEY: 'k' } : {});
  o.clock = t;
  o.now = () => o.clock;
  o.rand = seeded(seed);
  o.letters = [];
  o.write = async (castaway, letter) => {
    o.letters.push({ castaway: castaway.key, ...letter });
    return 'The gulls brought your bottle in this morning.';
  };
  return o;
}

const later = (o, ms) => { o.clock += ms; };

test('the island day runs five hours with two tides, and the current turns with it', () => {
  assert.equal(clock(0).part, 'night');
  assert.equal(clock(DAY_MS * 0.25).part, 'dawn');
  assert.equal(clock(DAY_MS * 0.75).part, 'dusk');
  assert.equal(clock(0).tide, 1);
  assert.ok(Math.abs(clock(TIDE_MS / 2).tide + 1) < 1e-9);
  assert.ok(clock(TIDE_MS / 4).ebbing);
  assert.ok(!clock((3 * TIDE_MS) / 4).ebbing);
  // Dawn runs north, midday east, dusk south.
  const north = current(DAY_MS * 0.25);
  assert.ok(Math.abs(Math.sin(north.angle) - 1) < 1e-9);
  assert.ok(Math.abs(Math.cos(current(DAY_MS * 0.5).angle) - 1) < 1e-9);
});

test('a throw is the same for the same dice, and the tide changes how far it goes', () => {
  const from = { x: 0, y: 0 };
  const a = drift({ from, dir: 2, strength: 0.5, t: TIDE_MS / 4, rand: seeded(7) });
  const b = drift({ from, dir: 2, strength: 0.5, t: TIDE_MS / 4, rand: seeded(7) });
  assert.deepEqual(a, b);
  const out = drift({ from, dir: 2, strength: 0.5, t: TIDE_MS / 4, rand: () => 0.5 });
  const back = drift({ from, dir: 2, strength: 0.5, t: (3 * TIDE_MS) / 4, rand: () => 0.5 });
  assert.ok(Math.hypot(out.x, out.y) > Math.hypot(back.x, back.y) - 8, 'outgoing tide carries further');
  assert.ok(a.arrives > TIDE_MS / 4);
});

test('a reply aimed back the way the letter came bends toward its writer', () => {
  const from = { x: 0, y: 0 };
  const writer = { x: 40, y: 0 };
  const plain = drift({ from, dir: 2, strength: 1, t: 0, rand: () => 0.5 });
  const aimed = drift({ from, dir: 2, strength: 1, t: 0, rand: () => 0.5, toward: writer });
  const wrongWay = drift({ from, dir: 6, strength: 1, t: 0, rand: () => 0.5, toward: writer });
  const dist = (p) => Math.hypot(p.x - writer.x, p.y - writer.y);
  assert.ok(dist(aimed) < dist(plain));
  assert.equal(dist(wrongWay), dist(drift({ from, dir: 6, strength: 1, t: 0, rand: () => 0.5 })));
  assert.equal(directionTo(from, writer), 2);
});

test('bottles wash up on the beach facing where they came from', () => {
  const island = { x: 0, y: 0 };
  assert.equal(shore(island, { x: 0, y: 10 }), 'north');
  assert.equal(shore(island, { x: 10, y: 1 }), 'east');
  assert.equal(shore(island, { x: -1, y: -10 }), 'south');
  assert.equal(shore(island, { x: -10, y: 0 }), 'west');
});

test('the finder is the nearest other island in reach, then anyone, then the sender', () => {
  const me = { key: 'me', x: 0, y: 0 };
  const near = { key: 'near', x: 10, y: 0 };
  const far = { key: 'far', x: 100, y: 0 };
  assert.equal(finder({ x: 8, y: 0 }, [me, near, far], 'me', 0).key, 'near');
  assert.equal(finder({ x: 60, y: 0 }, [me, far], 'me', 0), null);
  assert.equal(finder({ x: 60, y: 0 }, [me, far], 'me', 3 * REDRIFT_MS).key, 'far');
  assert.equal(finder({ x: 60, y: 0 }, [me], 'me', MAX_DRIFT_MS).key, 'me');
});

test('new islands spiral out from the middle, never on top of each other', () => {
  const spots = Array.from({ length: 50 }, (_, n) => placeIsland(n));
  for (let i = 0; i < spots.length; i++) {
    for (let j = 0; j < i; j++) assert.ok(Math.hypot(spots[i].x - spots[j].x, spots[i].y - spots[j].y) > 2);
  }
  assert.ok(Math.hypot(spots[49].x, spots[49].y) > Math.hypot(spots[5].x, spots[5].y));
});

test('a first visit makes an island with a starter crate and one unique thing', async () => {
  const o = ocean();
  const s = await o.visit('Miles_Pitts');
  assert.deepEqual(s.island.supplies, { bottles: 3, corks: 3, paper: 3, ink: 3 });
  assert.equal(s.island.curios.length, 3);
  assert.equal(s.island.curios.filter((c) => c.unique).length, 1);
  assert.deepEqual(s.beach, []);
  assert.equal('x' in s.island, false, 'coordinates stay on the server');
  // The castaways were placed first, in the middle.
  assert.ok(o.island('castaway:oda'));
  assert.equal((await o.visit('miles_pitts')).island.hand, s.island.hand);
});

test('flotsam arrives with the tides, at most two tides\' worth after time away', async () => {
  const o = ocean();
  await o.visit('a');
  const count = (s) => Object.values(s.island.supplies).reduce((x, y) => x + y, 0) + s.island.curios.length;
  const before = count(await o.visit('a'));
  later(o, 40 * TIDE_MS);
  const after = await o.visit('a');
  assert.ok(count(after) - before <= 2);
  assert.equal(after.found.length, count(after) - before);
});

test('throwing a letter uses supplies, and a neighbour finds it on the right beach', async () => {
  const o = ocean();
  await o.visit('alice');
  await o.visit('bob');
  const sent = await o.throwBottle('alice', { text: 'Is anyone out there?', signed: true, dir: 0, strength: 0.5 });
  assert.equal(sent.error, undefined);
  assert.deepEqual(sent.island.supplies, { bottles: 2, corks: 2, paper: 2, ink: 2 });
  assert.equal(sent.sent[0].ashore, false);
  assert.ok(await o.ctx.storage.getAlarm(), 'an alarm waits for the bottle');

  later(o, MAX_DRIFT_MS + 2 * REDRIFT_MS);
  await o.alarm();
  const bob = await o.visit('bob');
  assert.equal(bob.beach.length, 1);
  assert.match(bob.beach[0].shore, /^(north|east|south|west)$/);
  assert.equal(bob.shelf.length, 0, 'unread until opened');

  const opened = await o.openBottle('bob', bob.beach[0].id);
  assert.equal(opened.shelf[0].text, 'Is anyone out there?');
  assert.equal(opened.shelf[0].name, 'alice');
  assert.equal(opened.shelf[0].marked, false);
  assert.equal(opened.island.supplies.bottles, 4, 'the empty bottle is yours to reuse');
  assert.ok((await o.openBottle('bob', bob.beach[0].id)).error, 'opened only once');
  assert.ok((await o.openBottle('alice', bob.beach[0].id)).error, 'only by its finder');
});

test('unsigned letters carry the writer\'s hand but not their name', async () => {
  const o = ocean();
  const alice = await o.visit('alice');
  await o.visit('bob');
  await o.throwBottle('alice', { text: 'No names here.', signed: false, dir: 3, strength: 0.2 });
  later(o, MAX_DRIFT_MS + 2 * REDRIFT_MS);
  const bob = await o.visit('bob');
  const letter = (await o.openBottle('bob', bob.beach[0].id)).shelf[0];
  assert.equal(letter.name, null);
  assert.equal(letter.hand, alice.island.hand);
});

test('you can\'t throw without supplies, words, or a direction', async () => {
  const o = ocean();
  await o.visit('alice');
  assert.ok((await o.throwBottle('alice', { text: '  ', dir: 0, strength: 1 })).error);
  assert.ok((await o.throwBottle('alice', { text: 'x'.repeat(601), dir: 0, strength: 1 })).error);
  assert.ok((await o.throwBottle('alice', { text: 'hi', dir: 9, strength: 1 })).error);
  assert.ok((await o.throwBottle('nobody', { text: 'hi', dir: 0, strength: 1 })).error);
  for (let i = 0; i < 3; i++) assert.equal((await o.throwBottle('alice', { text: `letter ${i}`, dir: i, strength: 1 })).error, undefined);
  assert.match((await o.throwBottle('alice', { text: 'one more', dir: 0, strength: 1 })).error, /bottle, a cork/);
});

test('with nobody else in the ocean, a bottle washes back to its sender after a day', async () => {
  const o = ocean();
  await o.visit('alone');
  await o.throwBottle('alone', { text: 'Hello?', dir: 4, strength: 1 });
  later(o, 6 * 60 * 60 * 1000);
  await o.alarm();
  assert.equal((await o.visit('alone')).beach.length, 0);
  later(o, MAX_DRIFT_MS);
  await o.alarm();
  const s = await o.visit('alone');
  assert.equal(s.beach.length, 1);
  assert.equal((await o.openBottle('alone', s.beach[0].id)).shelf[0].own, true);
});

test('quiet islands get nothing: bottles drift past to active ones', async () => {
  const o = ocean();
  await o.visit('gone');
  later(o, 4 * DAY_MS * 5); // 4 real days at five island days a day
  await o.visit('here');
  await o.visit('writer');
  await o.throwBottle('writer', { text: 'Anyone?', dir: 0, strength: 0.5 });
  later(o, MAX_DRIFT_MS + 2 * REDRIFT_MS);
  await o.alarm();
  const here = o.sql.exec("SELECT COUNT(*) AS n FROM bottles WHERE finder = 'here'").toArray()[0].n;
  const gone = o.sql.exec("SELECT COUNT(*) AS n FROM bottles WHERE finder = 'gone'").toArray()[0].n;
  assert.equal(gone, 0);
  assert.equal(here, 1);
});

test('a Claude castaway answers a letter that reaches it, signed and wave-marked, aimed back home', async () => {
  const o = ocean({ claude: true });
  await o.visit('alice');
  await o.throwBottle('alice', { text: 'Hello from a new island.', signed: false, dir: 0, strength: 0.5 });
  later(o, MAX_DRIFT_MS + 2 * REDRIFT_MS);
  await o.alarm();
  const landed = o.sql.exec('SELECT finder, reply_due FROM bottles').toArray()[0];
  assert.match(landed.finder, /^castaway:/, 'only the castaways are near');
  later(o, 60 * 60 * 1000);
  await o.alarm();
  assert.equal(o.letters.length, 1);
  assert.equal(o.letters[0].text, 'Hello from a new island.');
  assert.equal(o.letters[0].senderName, null);
  const reply = o.sql.exec('SELECT * FROM bottles WHERE sender = ?', landed.finder).toArray()[0];
  assert.equal(reply.marked, 1);
  assert.ok(reply.sender_name);
  assert.ok(reply.reply_to);
  // Answered once, however many alarms follow.
  later(o, 60 * 60 * 1000);
  await o.alarm();
  assert.equal(o.letters.length, 1);

  later(o, MAX_DRIFT_MS + 2 * REDRIFT_MS);
  await o.alarm();
  const s = await o.visit('alice');
  const letter = (await o.openBottle('alice', s.beach[0].id)).shelf[0];
  assert.equal(letter.marked, true);
  assert.equal(letter.replyTo, 'Hello from a new island.');
});

test('without a Claude key the castaways stay quiet and bottles pass them by', async () => {
  const o = ocean();
  await o.visit('alice');
  await o.visit('bob');
  for (let i = 0; i < 3; i++) await o.throwBottle('alice', { text: `try ${i}`, dir: i * 2, strength: 0.5 });
  later(o, MAX_DRIFT_MS + 2 * REDRIFT_MS);
  await o.alarm();
  assert.equal(o.sql.exec("SELECT COUNT(*) AS n FROM bottles WHERE finder LIKE 'castaway:%'").toArray()[0].n, 0);
});
