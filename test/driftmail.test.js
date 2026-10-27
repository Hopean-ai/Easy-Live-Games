import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fakeCtx } from './helpers/workers-stub.js';
import {
  ACTIVE_MS, DAY_MS, MAX_DRIFT_MS, REDRIFT_MS, TIDE_MS, clock, current, directionTo, drift, finder, placeIsland, seeded, shore,
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

test('the island day runs an hour with two tides, and the current turns with it', () => {
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
  const sum = (obj) => Object.values(obj).reduce((x, y) => x + y, 0);
  const count = (s) => sum(s.island.supplies) + s.island.curios.length + sum(s.materials) + sum(s.seeds) + s.beach.length;
  const before = count(await o.visit('a'));
  later(o, TIDE_MS);
  const next = await o.visit('a');
  assert.ok(count(next) - before <= 3, 'three things at most each tide');
  assert.equal(next.found.length, count(next) - before);
  assert.equal(next.welcome, false);
  // Away for twenty hours: two tides' worth, and four more things the sea saved.
  later(o, 40 * TIDE_MS);
  const after = await o.visit('a');
  assert.ok(count(after) - count(next) <= 10);
  assert.equal(after.found.length, count(after) - count(next));
  assert.equal(after.welcome, true);
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
  later(o, 4 * 24 * DAY_MS); // four real days, at 24 island days a day
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
  const woods = Array.from({ length: 400 }, (_, i) => flotsam(seeded(i))).filter((w) => w === 'driftwood').length;
  assert.ok(woods > 80, 'driftwood is the commonest thing on a calm tide');
  const olds = (event) => Array.from({ length: 400 }, (_, i) => flotsam(seeded(i), event)).filter((w) => w === 'old bottle').length;
  assert.ok(olds('wreck') > olds(null) * 3);
});

test('fishing: a few casts a tide, catches add fish and bones, and a shoal helps', async () => {
  const o = ocean({ seed: 3 });
  await o.visit('alice');
  let caught = 0;
  for (let i = 0; i < 30; i++) {
    const r = await o.fish('alice');
    assert.equal(r.error, undefined);
    assert.equal(typeof r.caught, 'string');
    if (r.caught !== 'nothing') caught++;
    assert.equal(r.kit.casts, 3);
    for (let n = 0; n < 3; n++) assert.equal((await o.fish('alice')).error, undefined);
    assert.ok((await o.fish('alice')).error, 'four casts a tide');
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
  island.kit.builds = { workshop: 1 };
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
  island.kit.builds = { desk: 1 };
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
  assert.equal(opened.kit.casts, 6, 'two more casts a tide now');
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

// --- Island life, bottles, identity and the sea's mysteries ----------------------------------

const { blur, blurAmount, grow, plant, ripe, shelfRoom, sinkChance, BASE_ROOM, SHACK_ROOM } = await import('../src/driftmail/island.js');
const { clueText, echo, matchesClue } = await import('../src/driftmail/mysteries.js');
const { LIGHTHOUSE_PULL } = await import('../src/driftmail/world.js');

// Change an island directly, as if it had gathered for a while.
function give(o, key, fn) {
  const island = o.island(key);
  fn(island, island.kit);
  o.saveIsland(island);
}

async function deliver(o) {
  later(o, MAX_DRIFT_MS + 2 * REDRIFT_MS);
  await o.alarm();
}

test('gathering once a tide, and the shack goes up in three stages before storage', async () => {
  const o = ocean();
  await o.visit('a');
  const g = await o.act('a', { op: 'gather', what: 'leaves' });
  assert.equal(g.materials.leaves >= 2, true);
  assert.ok((await o.act('a', { op: 'gather', what: 'clay' })).error, 'once a tide');
  assert.ok((await o.act('a', { op: 'gather', what: 'gold' })).error);
  give(o, 'a', (_, k) => { k.materials = { driftwood: 20, leaves: 9, rope: 4, stones: 4 }; });
  assert.ok((await o.act('a', { op: 'build', what: 'shelves' })).error, 'shelves need the shack');
  let s;
  for (const stage of ['Shack frame', 'Shack walls', 'Shack roof']) {
    s = await o.act('a', { op: 'build', what: 'shack' });
    assert.equal(s.built, stage);
  }
  assert.ok((await o.act('a', { op: 'build', what: 'shack' })).error, 'finished');
  assert.equal(s.room, SHACK_ROOM);
  s = await o.act('a', { op: 'build', what: 'shelves' });
  assert.equal(s.room, SHACK_ROOM + 200);
  assert.equal(shelfRoom({}), BASE_ROOM);
  assert.ok((await o.act('a', { op: 'build', what: 'lighthouse' })).error, 'not enough stone');
});

test('the garden grows while watered, pauses while dry, and gives a crop and a seed back', async () => {
  const p = plant('reeds', 0);
  grow(p, 2 * TIDE_MS);
  assert.ok(ripe(p));
  const dry = plant('oak', 0);
  grow(dry, 10 * TIDE_MS);
  assert.equal(dry.growth, 2, 'two tides on one watering, then it waits');
  const o = ocean();
  await o.visit('a');
  assert.match((await o.act('a', { op: 'plant', plot: 2, crop: 'reeds' })).error, /garden beds/, 'two wild plots until there are beds');
  assert.ok((await o.act('a', { op: 'plant', plot: 0, crop: 'reeds' })).seeds.reeds === 1);
  assert.ok((await o.act('a', { op: 'plant', plot: 0, crop: 'berries' })).error, 'one crop a plot');
  assert.ok((await o.act('a', { op: 'harvest', plot: 0 })).error, 'not ready');
  later(o, TIDE_MS);
  await o.act('a', { op: 'water' });
  later(o, TIDE_MS);
  const h = await o.act('a', { op: 'harvest', plot: 0 });
  assert.equal(h.error, undefined);
  assert.equal(h.materials.reeds, 3);
  assert.equal(h.seeds.reeds, 2);
  assert.equal(h.garden[0].crop, null);
  // Garden beds: two more plots, and one more of everything picked.
  give(o, 'a', (_, k) => { k.builds = { garden: 1 }; });
  assert.equal((await o.act('a', { op: 'plant', plot: 2, crop: 'reeds' })).error, undefined);
  later(o, TIDE_MS);
  await o.act('a', { op: 'water' });
  later(o, TIDE_MS);
  assert.equal((await o.act('a', { op: 'harvest', plot: 2 })).materials.reeds, 7);
  // Wild reeds and berries can be gathered too.
  later(o, TIDE_MS);
  assert.equal((await o.act('a', { op: 'gather', what: 'berries' })).materials.berries >= 2, true);
});

test('recipes need their building and ability, and turn materials into supplies', async () => {
  const o = ocean();
  await o.visit('a');
  give(o, 'a', (_, k) => { k.materials = { reeds: 4, rope: 2, clay: 6, sand: 4, stones: 4, driftwood: 4, bark: 1 }; });
  assert.match((await o.act('a', { op: 'make', what: 'cork' })).error, /workshop/);
  const hidden = (await o.visit('a')).recipes.filter((r) => r.hidden).map((r) => r.id);
  assert.ok(hidden.includes('cork') && hidden.includes('hook') && !hidden.includes('paper'), 'workshop work is hidden until there is one');
  give(o, 'a', (_, k) => { k.builds = { workshop: 1 }; });
  assert.ok((await o.visit('a')).recipes.every((r) => !r.hidden), 'and shows once it is built');
  assert.ok((await o.act('a', { op: 'make', what: 'paper' })).error, 'needs a drying rack');
  await o.act('a', { op: 'build', what: 'rack' });
  const paper = await o.act('a', { op: 'make', what: 'paper' });
  assert.equal(paper.island.supplies.paper, 4);
  const cork = await o.act('a', { op: 'make', what: 'cork' });
  assert.equal(cork.island.supplies.corks, 5);
  await o.act('a', { op: 'build', what: 'kiln' });
  assert.equal((await o.act('a', { op: 'make', what: 'bottle' })).island.supplies.bottles, 4);
  assert.match((await o.act('a', { op: 'make', what: 'jar' })).error, /Kiln craft/);
});

test('a jar carries a curio and seeds to its finder; boxes need a dock', async () => {
  const o = ocean();
  await o.visit('alice');
  await o.visit('bob');
  give(o, 'alice', (_, k) => { k.materials = { jars: 1, wax: 1 }; });
  const curio = o.island('alice').curios[0].name;
  assert.match((await o.throwBottle('alice', { text: 'Box.', dir: 0, strength: 0.5, kind: 'box' })).error, /dock/);
  assert.ok((await o.throwBottle('alice', { text: 'Too much.', dir: 0, strength: 0.5, items: [{ kind: 'curio', index: 0 }, { kind: 'seeds', crop: 'oak' }] })).error, 'a bottle holds one thing');
  const sent = await o.throwBottle('alice', {
    text: 'For you.', dir: 0, strength: 0.5, kind: 'jar', items: [{ kind: 'curio', index: 0 }, { kind: 'seeds', crop: 'oak' }],
  });
  assert.equal(sent.error, undefined);
  assert.equal(sent.island.curios.length, 2);
  assert.equal(sent.seeds.oak, 0);
  await deliver(o);
  const bob = await o.visit('bob');
  assert.equal(bob.beach[0].kind, 'jar');
  const opened = await o.openBottle('bob', bob.beach[0].id);
  assert.ok(opened.island.curios.some((c) => c.name === curio));
  assert.equal(opened.seeds.oak, 2);
  assert.equal(opened.materials.jars, 1, 'the jar is yours to reuse');
  assert.equal(opened.shelf[0].items.length, 2);
});

test('drawings and maps go in a bottle; a map lists the writers you have heard from', async () => {
  const o = ocean();
  await o.visit('alice');
  await o.visit('bob');
  assert.match((await o.throwBottle('alice', { text: 'Look.', dir: 0, strength: 0.5, items: [{ kind: 'drawing', data: 'f0'.repeat(48) }] })).error, /writing desk/);
  for (const k of ['alice', 'bob']) give(o, k, (_, kit) => { kit.builds = { shack: 3, desk: 1 }; });
  assert.ok((await o.throwBottle('alice', { text: 'Look.', dir: 0, strength: 0.5, items: [{ kind: 'drawing', data: 'zz' }] })).error);
  const data = 'f0'.repeat(48);
  await o.throwBottle('alice', { text: 'Look.', signed: true, dir: 0, strength: 0.5, items: [{ kind: 'drawing', data }] });
  await deliver(o);
  let bob = await o.visit('bob');
  bob = await o.openBottle('bob', bob.beach[0].id);
  assert.equal(bob.shelf[0].items[0].data, data);
  assert.deepEqual(bob.chart.map((c) => c.name), ['alice']);
  const map = await o.throwBottle('bob', { text: 'Here is my chart.', dir: 4, strength: 0.5, items: [{ kind: 'map' }] });
  assert.equal(map.error, undefined);
  const row = o.sql.exec("SELECT items FROM bottles WHERE sender = 'bob'").toArray()[0];
  assert.equal(JSON.parse(row.items)[0].places[0].name, 'alice');
});

test('weighted and sailed bottles need deep current lore, which takes two pages', async () => {
  const o = ocean();
  await o.visit('a');
  give(o, 'a', (_, k) => { k.materials = { stones: 2 }; k.builds = { workshop: 1 }; });
  assert.match((await o.throwBottle('a', { text: 'Deep.', dir: 0, strength: 0.5, kind: 'weighted' })).error, /know how/);
  const island = o.island('a');
  assert.match(o.learn(island, 'salt-deep-1'), /1 of 2/);
  assert.equal(o.learn(island, 'keeper-deep-2'), 'Deep current lore');
  o.saveIsland(island);
  const sent = await o.throwBottle('a', { text: 'Deep.', dir: 0, strength: 0.5, kind: 'weighted' });
  assert.equal(sent.error, undefined);
  const plain = drift({ from: { x: 0, y: 0 }, dir: 0, strength: 0.5, t: TIDE_MS / 4, rand: () => 0.5 });
  const deep = drift({ from: { x: 0, y: 0 }, dir: 0, strength: 0.5, t: TIDE_MS / 4, rand: () => 0.5, kind: 'weighted' });
  assert.ok(Math.hypot(deep.x, deep.y) > Math.hypot(plain.x, plain.y) * 1.5);
  assert.ok(deep.arrives - TIDE_MS / 4 > (plain.arrives - TIDE_MS / 4) * 3);
});

test('long drifts and red tides blur a letter; double corks keep water out, and ink restoration reads through', () => {
  assert.equal(blurAmount({ drifted: 60 * 60 * 1000, kind: 'bottle' }), 0);
  assert.ok(blurAmount({ drifted: 8 * 60 * 60 * 1000, kind: 'bottle' }) > 0.2);
  assert.equal(blurAmount({ drifted: 8 * 60 * 60 * 1000, kind: 'double' }), 0);
  assert.ok(blurAmount({ drifted: 0, kind: 'bottle', stained: true }) > 0.2);
  const text = 'the quick brown fox jumps over the lazy dog again and again and again';
  const b = blur(text, 0.4, 7);
  assert.notEqual(b, text);
  assert.equal(b, blur(text, 0.4, 7), 'the same blur every time');
  assert.equal(b.length, text.length);
  assert.match(b, /·/);
});

test('a seal ring from the bench seals letters in wax, and a stamp marks them', async () => {
  const o = ocean();
  await o.visit('alice');
  await o.visit('bob');
  assert.ok((await o.act('alice', { op: 'seal', glyph: 2, wax: 3 })).error, 'needs a bench');
  give(o, 'alice', (_, k) => { k.materials = { driftwood: 5, stones: 2, wax: 1 }; k.bones = 1; k.abilities = ['carving']; });
  await o.act('alice', { op: 'build', what: 'bench' });
  const sealed = await o.act('alice', { op: 'seal', glyph: 2, wax: 3 });
  assert.deepEqual([sealed.seal.glyph, sealed.seal.wax, sealed.seal.ring], [2, 3, true]);
  assert.ok((await o.act('alice', { op: 'make', what: 'stamp' })).error, 'pick a pattern');
  const stamp = await o.act('alice', { op: 'make', what: 'stamp', pattern: 1 });
  assert.equal(stamp.stamp.name, 'a gull');
  const sent = await o.throwBottle('alice', { text: 'Sealed.', dir: 0, strength: 0.5, wax: true, stamp: true });
  assert.equal(sent.error, undefined);
  assert.equal(sent.materials.wax, undefined, 'the wax is used');
  await deliver(o);
  let bob = await o.visit('bob');
  bob = await o.openBottle('bob', bob.beach[0].id);
  assert.equal(bob.shelf[0].sealed, true);
  assert.equal(bob.shelf[0].stamp, 'a gull');
  assert.equal(bob.shelf[0].emblem, 2 + 16 * 3);
});

test('forgery copies a hand you hold three letters in, and a reader of hands can tell', async () => {
  const o = ocean();
  for (const k of ['alice', 'bob', 'carol']) await o.visit(k);
  for (const text of ['One.', 'Two.', 'Three.']) await o.throwBottle('alice', { text, dir: 0, strength: 0.5 });
  // Only bob and alice are about, so bob finds them all.
  give(o, 'carol', (i) => { i.seen = o.now() - 2 * ACTIVE_MS; });
  await deliver(o);
  let bob = await o.visit('bob');
  for (const b of bob.beach) bob = await o.openBottle('bob', b.id);
  const id = bob.shelf[0].id;
  assert.match((await o.throwBottle('bob', { text: 'As alice.', dir: 0, strength: 0.5, forge: id })).error, /copy a hand/);
  give(o, 'bob', (i, k) => { k.abilities = ['forgery']; i.supplies.paper = 5; i.supplies.ink = 5; i.supplies.bottles = 5; i.supplies.corks = 5; });
  bob = await o.visit('bob');
  assert.equal(bob.shelf[0].canForge, true);
  const forged = await o.throwBottle('bob', { text: 'As alice.', signed: true, dir: 0, strength: 0.5, forge: id });
  assert.equal(forged.error, undefined);
  const row = o.sql.exec("SELECT hand, forged, sender_name FROM bottles WHERE sender = 'bob'").toArray()[0];
  assert.equal(row.hand, o.island('alice').hand);
  assert.equal(row.forged, 1);
  assert.equal(row.sender_name, null, 'a forgery is never signed');
});

test('throwing a letter on with a line added, and burning one, take it off your shelf', async () => {
  const o = ocean();
  await o.visit('alice');
  await o.visit('bob');
  await o.throwBottle('alice', { text: 'Pass this on.', signed: true, dir: 0, strength: 0.5 });
  await deliver(o);
  let bob = await o.visit('bob');
  bob = await o.openBottle('bob', bob.beach[0].id);
  const id = bob.shelf[0].id;
  const passed = await o.act('bob', { op: 'pass', id, line: 'Bob was here too.', dir: 2, strength: 0.5 });
  assert.equal(passed.error, undefined);
  assert.equal(passed.shelf.length, 0);
  const row = o.sql.exec("SELECT * FROM bottles WHERE sender = 'bob'").toArray()[0];
  assert.equal(row.text, 'Pass this on.');
  assert.equal(row.sender_name, 'alice');
  assert.equal(row.added, 'Bob was here too.');
  assert.equal(row.added_hand, o.island('bob').hand);
  await deliver(o);
  let alice = await o.visit('alice');
  alice = await o.openBottle('alice', alice.beach[0].id);
  assert.equal(alice.shelf[0].added.text, 'Bob was here too.');
  const burned = await o.act('alice', { op: 'burn', id: alice.shelf[0].id });
  assert.equal(burned.shelf.length, 0);
});

test('marks: kind ones reach the writer, rude ones make their bottles sink', async () => {
  assert.equal(sinkChance({}), 0);
  assert.ok(sinkChance({ rude: 10 }) >= 0.5);
  assert.ok(sinkChance({ rude: 1, kind: 10 }) < 0.1);
  const o = ocean();
  await o.visit('alice');
  await o.visit('bob');
  await o.throwBottle('alice', { text: 'Hi.', dir: 0, strength: 0.5 });
  await deliver(o);
  let bob = await o.visit('bob');
  bob = await o.openBottle('bob', bob.beach[0].id);
  assert.ok((await o.act('bob', { op: 'mark', id: bob.shelf[0].id, mark: 'great' })).error);
  assert.equal((await o.act('bob', { op: 'mark', id: bob.shelf[0].id, mark: 'kind' })).error, undefined);
  assert.ok((await o.act('bob', { op: 'mark', id: bob.shelf[0].id, mark: 'rude' })).error, 'once a letter');
  assert.equal((await o.visit('alice')).marks.kind, 1);
  // Someone the whole sea has found rude: most of their bottles go down.
  for (let i = 0; i < 20; i++) o.sql.exec("INSERT INTO bottles (sender, text, hand, emblem, from_x, from_y, to_x, to_y, thrown, rest, arrives, finder, mark) VALUES ('alice', 'x', 1, 1, 0, 0, 0, 0, 0, 0, 0, 'z', 'rude')");
  give(o, 'alice', (i) => { i.supplies = { bottles: 9, corks: 9, paper: 9, ink: 9 }; });
  for (let i = 0; i < 8; i++) await o.throwBottle('alice', { text: `Rude ${i}.`, dir: 0, strength: 0.5 });
  await deliver(o);
  const sunk = o.sql.exec("SELECT COUNT(*) AS n FROM bottles WHERE finder = 'sea:deep'").toArray()[0].n;
  assert.ok(sunk >= 2, `some sank (${sunk})`);
});

test('pen pals: three letters each way, and replies ride a steady current', async () => {
  const o = ocean();
  await o.visit('alice');
  await o.visit('bob');
  give(o, 'alice', (i) => { i.supplies = { bottles: 9, corks: 9, paper: 9, ink: 9 }; });
  give(o, 'bob', (i) => { i.supplies = { bottles: 9, corks: 9, paper: 9, ink: 9 }; });
  for (let i = 0; i < 3; i++) {
    await o.throwBottle('alice', { text: `A${i}`, signed: true, dir: 0, strength: 0.5 });
    await o.throwBottle('bob', { text: `B${i}`, signed: true, dir: 0, strength: 0.5 });
  }
  await deliver(o);
  assert.ok(o.penPals('alice', 'bob'));
  assert.deepEqual((await o.visit('alice')).pals, ['bob']);
  // A steady current bends a reply home from further off.
  const from = { x: 0, y: 0 };
  const toward = { x: 20, y: 20 };
  const near = (steady) => {
    const p = drift({ from, dir: 0, strength: 0.5, t: TIDE_MS / 4, rand: () => 0.5, toward, steady });
    return Math.hypot(p.x - toward.x, p.y - toward.y);
  };
  assert.ok(near(true) < near(false));
});

test('a lighthouse draws in bottles drifting near', () => {
  const islands = [{ key: 'a', x: 10, y: 0 }, { key: 'b', x: -10 - LIGHTHOUSE_PULL / 2, y: 0, lighthouse: 1 }];
  assert.equal(finder({ x: 0, y: 0 }, islands, 'z', 0).key, 'b');
  islands[1].lighthouse = 0;
  assert.equal(finder({ x: 0, y: 0 }, islands, 'z', 0).key, 'a');
});

test('a beacon brings new castaways to wash up nearby', async () => {
  const o = ocean();
  for (let i = 0; i < 12; i++) await o.visit(`p${i}`);
  give(o, 'p0', (_, k) => { k.builds = { beacon: 1 }; });
  const near = [];
  for (let i = 0; i < 10; i++) {
    await o.visit(`new${i}`);
    const a = o.island('p0');
    const b = o.island(`new${i}`);
    near.push(Math.hypot(a.x - b.x, a.y - b.y) < 7);
  }
  assert.ok(near.filter(Boolean).length >= 4);
});

test('fishing extras: bait, a spear at low tide, traps, and snagging a bottle on its way', async () => {
  const o = ocean({ seed: 5 });
  await o.visit('alice');
  await o.visit('bob');
  assert.ok((await o.fish('alice', { bait: true })).error, 'no berries');
  give(o, 'alice', (_, k) => { k.materials = { berries: 3, driftwood: 4, rope: 2 }; k.bones = 2; k.builds = { workshop: 1 }; });
  const baited = await o.fish('alice', { bait: true });
  assert.equal(baited.materials.berries, 2);
  await o.act('alice', { op: 'make', what: 'spear' });
  // Low tide is the middle of each tide.
  o.clock = Math.floor(o.clock / TIDE_MS) * TIDE_MS + TIDE_MS / 2;
  const s = await o.act('alice', { op: 'spear' });
  assert.equal(s.error, undefined);
  assert.ok((await o.act('alice', { op: 'spear' })).error, 'once a tide');
  await o.act('alice', { op: 'make', what: 'trap' });
  assert.equal((await o.act('alice', { op: 'trap' })).kit.traps.length, 1);
  assert.ok((await o.act('alice', { op: 'traps' })).error, 'give it a tide');
  later(o, 3 * TIDE_MS);
  const pulled = await o.act('alice', { op: 'traps' });
  assert.equal(pulled.kit.traps.length, 0);
  assert.equal(pulled.materials.traps, 1);
  // A snag: bob's bottle, caught on alice's line.
  await o.throwBottle('bob', { text: 'Caught?', dir: 0, strength: 0.5 });
  give(o, 'alice', (_, k) => { k.snag = o.sql.exec("SELECT id FROM bottles WHERE sender = 'bob'").toArray()[0].id; });
  const kept = await o.act('alice', { op: 'snag', keep: true });
  assert.equal(kept.kit.snag, null);
  assert.equal(kept.beach.length >= 1, true);
});

test('the fog brings a bottle home changed, and a clue followed finds the hidden page', async () => {
  const words = 'Something remembered about the island across the water tonight';
  const changed = echo(seeded(2), words);
  assert.notEqual(changed, words);
  const c = { dir: 3, part: 'dusk', ebbing: false };
  assert.match(clueText(c), /^135° {3}· {3}18:00/);
  const fog = tideWith('fog', 300);
  const o = ocean({ t: fog * TIDE_MS + 1000, seed: 9 });
  await o.visit('alice');
  await o.visit('bob');
  give(o, 'alice', (i) => { i.supplies = { bottles: 9, corks: 9, paper: 9, ink: 9 }; });
  for (let i = 0; i < 6; i++) await o.throwBottle('alice', { text: `${words} ${i}`, dir: 0, strength: 0.5 });
  later(o, 4 * DAY_MS);
  await deliver(o);
  const home = o.sql.exec("SELECT COUNT(*) AS n FROM bottles WHERE finder = 'alice' AND strange = 'fog'").toArray()[0].n;
  assert.ok(home >= 1, 'some came home out of the fog');
  // A clue for right now, followed, swallows the bottle and leaves the hidden page.
  const now = clock(o.now());
  give(o, 'alice', (_, k) => { k.clues = [{ dir: 1, part: now.part, ebbing: now.ebbing, until: o.now() + DAY_MS }]; });
  assert.ok(matchesClue(o.island('alice').kit.clues[0], { dir: 1, t: o.now() }));
  await o.throwBottle('alice', { text: 'Following the numbers.', dir: 1, strength: 0.5 });
  await deliver(o);
  const alice = await o.visit('alice');
  const hidden = o.sql.exec("SELECT id FROM bottles WHERE finder = 'alice' AND page = 'hidden-1'").toArray()[0];
  assert.ok(hidden);
  const opened = await o.openBottle('alice', hidden.id);
  assert.ok(opened.journal.some((p) => p.id === 'hidden-1'));
  assert.equal(alice.clues.length, 0);
});

test('a full shelf stops you opening more until you make room', async () => {
  const o = ocean();
  await o.visit('a');
  const island = o.island('a');
  for (let i = 0; i < BASE_ROOM + 1; i++) o.oldBottle(island, o.now());
  o.saveIsland(island);
  let s = await o.visit('a');
  for (let i = 0; i < BASE_ROOM; i++) s = await o.openBottle('a', s.beach[0].id);
  assert.equal(s.held, BASE_ROOM);
  assert.match((await o.openBottle('a', s.beach[0].id)).error, /no room/);
  await o.act('a', { op: 'burn', id: s.shelf[0].id });
  assert.equal((await o.openBottle('a', s.beach[0].id)).error, undefined);
});

// --- Roblox ---------------------------------------------------------------------------------

const { robloxWorld, robloxView, BRIDGE_VERSION } = await import('../src/driftmail/roblox.js');

test('a Roblox player gets their own island, signed with their Roblox name, or their linked account\'s', async () => {
  const o = ocean();
  const mine = await robloxWorld(o, { op: 'state', userId: '42', name: 'RobloxRay', account: null });
  assert.equal(mine.bridge, BRIDGE_VERSION);
  assert.ok(o.island('roblox:42'));
  assert.equal(o.island('roblox:42').name, 'RobloxRay');
  await o.visit('alice');
  const linked = await robloxWorld(o, { op: 'state', userId: '43', name: 'Other', account: 'alice' });
  assert.equal(linked.hand, o.island('alice').hand);
  assert.equal(o.island('roblox:43'), null);
  assert.equal((await robloxWorld(o, { op: 'nope', userId: '42' })).error, 'Bad request.');
  const bad = await robloxWorld(o, { op: 'throw', userId: '42', name: 'RobloxRay', text: '', dir: 0, strength: 0.5 });
  assert.equal(bad.bridge, BRIDGE_VERSION);
  assert.ok(bad.error);
});

test('the Roblox view keeps every word players wrote in texts, by keys that name one text', async () => {
  const o = ocean();
  await o.visit('alice');
  await robloxWorld(o, { op: 'state', userId: '42', name: 'Ray' });
  await o.throwBottle('alice', { text: 'Hello from the web.', signed: true, dir: 0, strength: 0.5 });
  const island = o.island('roblox:42');
  o.oldBottle(island, o.now());
  o.saveIsland(island);
  later(o, MAX_DRIFT_MS + 2 * REDRIFT_MS);
  await o.alarm();
  let v = await robloxWorld(o, { op: 'state', userId: '42', name: 'Ray' });
  for (const b of v.beach) v = await robloxWorld(o, { op: 'open', userId: '42', name: 'Ray', id: b.id });
  const letter = v.shelf.find((l) => !l.old);
  const old = v.shelf.find((l) => l.old);
  assert.ok(letter && old);
  assert.equal(v.texts[letter.text], 'Hello from the web.');
  assert.equal(v.texts[letter.name], 'alice');
  assert.equal(old.text, null, 'the journals are the game\'s own words');
  assert.ok(old.body.length > 20);
  // Nothing a player wrote is anywhere else in the view.
  const { texts, ...rest } = v;
  assert.ok(!JSON.stringify(rest).includes('Hello from the web'));
  assert.ok(!JSON.stringify(rest).includes('alice'));
  const thrown = await robloxWorld(o, { op: 'throw', userId: '42', name: 'Ray', text: 'Back at you.', dir: 4, strength: 0.6, signed: true });
  assert.equal(thrown.texts[thrown.sent[0].text], 'Back at you.');
  assert.equal(robloxView(await o.visit('roblox:42')).sent[0].text, thrown.sent[0].text, 'the same key every time');
});

test('the Roblox view keeps new player words (chart names, added lines) in texts, and leaves drawings out', async () => {
  const o = ocean();
  await o.visit('alice');
  await robloxWorld(o, { op: 'state', userId: '42', name: 'Ray' });
  give(o, 'alice', (_, k) => { k.builds = { desk: 1 }; });
  give(o, 'roblox:42', (_, k) => { k.builds = { desk: 1 }; });
  await o.throwBottle('alice', { text: 'With a picture.', signed: true, dir: 0, strength: 0.5, items: [{ kind: 'drawing', data: 'ab'.repeat(48) }] });
  await deliver(o);
  let v = await robloxWorld(o, { op: 'state', userId: '42', name: 'Ray' });
  const letter = v.beach.find((b) => !b.old && !b.strange);
  v = await robloxWorld(o, { op: 'open', userId: '42', name: 'Ray', id: letter.id });
  const l = v.shelf.find((x) => x.id === letter.id);
  assert.deepEqual(l.items, [{ kind: 'drawing' }]);
  assert.equal(v.texts[v.chart[0].name], 'alice');
  const gathered = await robloxWorld(o, { op: 'gather', userId: '42', name: 'Ray', what: 'clay' });
  assert.equal(gathered.done, 'clay');
  assert.ok(gathered.materials.clay >= 2);
  const passed = await robloxWorld(o, { op: 'pass', userId: '42', name: 'Ray', id: letter.id, line: 'Ray read this too.', dir: 2, strength: 0.5 });
  assert.equal(passed.error, undefined);
  await deliver(o);
  let a = await o.visit('alice');
  a = await o.openBottle('alice', a.beach.find((b) => !b.old && !b.strange).id);
  const back = robloxView(a);
  const added = back.shelf.find((x) => x.added);
  assert.equal(back.texts[added.added.text], 'Ray read this too.');
  const { texts, ...rest } = back;
  assert.ok(!JSON.stringify(rest).includes('Ray read this'));
  assert.ok(!JSON.stringify(rest).includes('With a picture'));
});

test('fishing as a minigame: read the water, strike on the real bite, and answer each pull', async () => {
  const { SPOT_KINDS, livelySpot, spotsAt, ANSWERS } = await import('../src/driftmail/world.js');
  const signs = spotsAt(5 * TIDE_MS);
  assert.equal(signs.length, SPOT_KINDS.length);
  assert.equal(livelySpot(5 * TIDE_MS), livelySpot(5 * TIDE_MS + 1000), 'the same all tide');
  // Find a cast that bites, playing it right.
  const play = async (seed, wrong = 0, early = false) => {
    const o = ocean({ seed });
    await o.visit('a');
    for (let i = 0; i < 20; i++) {
      const c = await o.act('a', { op: 'cast', spot: livelySpot(o.now()) });
      assert.equal(c.error, undefined);
      if (c.line.bite) {
        const answers = c.line.runs.map((r, k) => (k < wrong ? 'nonsense' : ANSWERS[r]));
        return { o, c, r: await o.act('a', { op: 'reel', strike: early ? c.line.nibbles - 1 : c.line.nibbles, answers }) };
      }
      assert.ok((await o.act('a', { op: 'reel', strike: 0, answers: [] })).error, 'nothing to reel in');
      later(o, TIDE_MS);
    }
    throw new Error('nothing bit');
  };
  const good = await play(3);
  assert.notEqual(good.r.caught, 'nothing');
  assert.ok((await good.o.act('a', { op: 'reel', strike: 0, answers: [] })).error, 'the line comes in once');
  const snapped = await play(3, 3);
  assert.equal(snapped.r.caught, 'nothing');
  assert.match(snapped.r.lost, /snapped/);
  const forgiven = await play(3, 1);
  assert.notEqual(forgiven.r.caught, 'nothing', 'one wrong move is forgiven');
  let s = 4;
  let nibbly;
  do nibbly = await play(s++); while (nibbly.c.line.nibbles === 0);
  const early = await play(s - 1, 0, true);
  assert.match(early.r.lost, /nibble/);
  assert.ok((await early.o.act('a', { op: 'cast', spot: 'moon' })).error);
});
