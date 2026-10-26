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
  assert.equal(opened.island.supplies.bottles, bob.island.supplies.bottles + 1, 'the empty bottle is yours to reuse');
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

// --- Events, fishing, journal pages --------------------------------------------------------

const { EVENTS, PAGES, cast, eventAt, eventOn, signAt, upcoming, flotsam } = await import('../src/driftmail/world.js');

// The first tide from `from` with an event of this kind.
function tideWith(kind, from = 0) {
  for (let n = from; n < from + 5000; n++) if (eventOn(n) === kind) return n;
  throw new Error(`no ${kind}`);
}

test('ocean events are rare, fixed by the tide, and the tide before can show a sign', () => {
  let count = 0;
  const kinds = new Set();
  for (let n = 0; n < 2800; n++) {
    const k = eventOn(n);
    if (k) {
      count++;
      kinds.add(k);
    }
  }
  assert.ok(count > 120 && count < 300, `about one tide in fourteen (${count})`);
  assert.deepEqual([...kinds].sort(), Object.keys(EVENTS).sort());
  const n = tideWith('storm', 100);
  assert.equal(eventAt(n * TIDE_MS + 5).kind, 'storm');
  assert.equal(eventAt(n * TIDE_MS + 5).end, (n + 1) * TIDE_MS);
  assert.ok(upcoming((n - 2) * TIDE_MS, 4).some((e) => e.kind === 'storm' && e.start === n * TIDE_MS));
  // Signs only ever point at the event that's actually coming.
  for (let k = 0; k < 2800; k++) {
    const sign = signAt(k * TIDE_MS);
    if (sign) assert.ok(EVENTS[eventOn(k + 1)].signs.includes(sign));
  }
});

test('a storm throws bottles much further than a calm sea', () => {
  const storm = tideWith('storm', 50);
  // A calm tide at the same time of the island day (two tides to a day).
  let calm = storm + 2;
  while (eventOn(calm)) calm += 2;
  const far = (n) => {
    let total = 0;
    for (let i = 0; i < 40; i++) {
      const p = drift({ from: { x: 0, y: 0 }, dir: 0, strength: 0.5, t: n * TIDE_MS + TIDE_MS / 4, rand: seeded(i) });
      total += Math.hypot(p.x, p.y);
    }
    return total;
  };
  assert.ok(far(storm) > far(calm) * 1.3);
  // Wreckage leaves old bottles far more often.
  const olds = (event) => Array.from({ length: 400 }, (_, i) => flotsam(seeded(i), event)).filter((w) => w === 'old bottle').length;
  assert.ok(olds('wreck') > olds(null) * 3);
});

test('fishing: once a tide, catches add fish and bones, and a shoal helps', async () => {
  const o = ocean({ seed: 3 });
  await o.visit('alice');
  let caught = 0;
  for (let i = 0; i < 30; i++) {
    const r = await o.fish('alice');
    assert.equal(r.error, undefined);
    assert.equal(typeof r.caught, 'string');
    if (r.caught !== 'nothing') caught++;
    assert.equal(r.kit.casts, 0);
    assert.ok((await o.fish('alice')).error, 'one cast a tide');
    later(o, TIDE_MS);
  }
  assert.ok(caught > 5);
  const shoal = tideWith('shoal', 200);
  const bites = (n) => Array.from({ length: 200 }, (_, i) => cast({ t: n * TIDE_MS + 1000, rand: seeded(i) })).filter(Boolean).length;
  let calm = shoal + 1;
  while (eventOn(calm)) calm++;
  // Same part of the day and tide, a whole number of island days apart.
  while ((calm - shoal) % 2) calm++;
  if (eventOn(calm)) calm += 2;
  assert.ok(bites(shoal) > bites(calm));
});

test('bones make a hook and fish make glue, which seals a bottle instead of a cork', async () => {
  const o = ocean();
  await o.visit('alice');
  await o.visit('bob');
  assert.ok((await o.craft('alice', 'hook')).error);
  const island = o.island('alice');
  island.kit.bones = 6;
  island.kit.fish = 2;
  o.saveIsland(island);
  const hooked = await o.craft('alice', 'hook');
  assert.equal(hooked.kit.hook, true);
  assert.equal(hooked.kit.bones, 1);
  assert.ok((await o.craft('alice', 'hook')).error, 'one hook is enough');
  const glued = await o.craft('alice', 'glue');
  assert.equal(glued.kit.glue, 1);
  assert.equal(glued.kit.fish, 0);
  const corks = glued.island.supplies.corks;
  const sent = await o.throwBottle('alice', { text: 'Sealed with glue.', dir: 1, strength: 0.4, glue: true });
  assert.equal(sent.error, undefined);
  assert.equal(sent.island.supplies.corks, corks);
  assert.equal(sent.kit.glue, 0);
  assert.ok((await o.throwBottle('alice', { text: 'Again.', dir: 1, strength: 0.4, glue: true })).error, 'no glue left');
});

test('an old bottle holds a journal page that can teach an ability', async () => {
  const o = ocean();
  await o.visit('alice');
  const island = o.island('alice');
  // Every page but the one on reading hands has been read, so that one comes next.
  island.kit.pages = PAGES.filter((p) => p.id !== 'keeper-hands').map((p) => p.id);
  o.oldBottle(island, o.now());
  o.saveIsland(island);
  const s = await o.visit('alice');
  const old = s.beach.find((b) => b.old);
  assert.ok(old);
  const opened = await o.openBottle('alice', old.id);
  assert.equal(opened.learned, 'Reading hands');
  assert.equal(opened.shelf[0].old, true);
  assert.equal(opened.shelf[0].title, 'On hands');
  assert.deepEqual(opened.abilities.map((a) => a.id), ['hands']);
  assert.equal(opened.journal.length, PAGES.length);
});

test('a page copied into a letter teaches its finder too, and costs paper and ink', async () => {
  const o = ocean();
  await o.visit('alice');
  await o.visit('bob');
  const island = o.island('alice');
  island.kit.pages = ['salt-knots'];
  o.saveIsland(island);
  assert.ok((await o.throwBottle('alice', { text: 'Try this.', dir: 0, strength: 0.5, page: 'keeper-signs' })).error, 'only pages you hold');
  const sent = await o.throwBottle('alice', { text: 'Try this.', dir: 0, strength: 0.5, page: 'salt-knots' });
  assert.equal(sent.error, undefined);
  assert.deepEqual(sent.island.supplies, { bottles: 2, corks: 2, paper: 1, ink: 1 });
  later(o, MAX_DRIFT_MS + 2 * REDRIFT_MS);
  await o.alarm();
  const bob = await o.visit('bob');
  const opened = await o.openBottle('bob', bob.beach[0].id);
  assert.equal(opened.learned, "Fisher's knots");
  assert.equal(opened.shelf[0].page.title, 'Knots');
  assert.equal(opened.kit.casts, 2, 'two casts a tide now');
});

test('abilities: reading hands groups letters, sea signs forecast, the current tells where bottles went', async () => {
  const o = ocean();
  await o.visit('alice');
  await o.visit('bob');
  for (const text of ['One.', 'Two.']) await o.throwBottle('alice', { text, dir: 0, strength: 0.5 });
  later(o, MAX_DRIFT_MS + 2 * REDRIFT_MS);
  await o.alarm();
  let bob = await o.visit('bob');
  for (const b of bob.beach) bob = await o.openBottle('bob', b.id);
  assert.equal(bob.shelf[0].handOf, undefined, 'not without the ability');
  assert.equal(bob.forecast, null);
  const island = o.island('bob');
  island.kit.abilities = ['hands', 'signs', 'currents'];
  o.saveIsland(island);
  await o.throwBottle('bob', { text: 'Back.', dir: 4, strength: 0.5 });
  bob = await o.visit('bob');
  const alices = bob.shelf.filter((l) => !l.own);
  assert.equal(alices.length, 2);
  assert.ok(alices.every((l) => l.handOf?.letters === 2 && l.handOf.mark === alices[0].handOf.mark));
  assert.ok(Array.isArray(bob.forecast));
  assert.match(bob.sent[0].rest, /^came to rest (not far|a good way|far) to the /);
});
