import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fakeCtx } from './helpers/workers-stub.js';
import { EVENTS, RANK, RANKS, choose, emperorIn, promotionChance, score, start, view } from '../src/legio/rules.js';
import { handleRequest } from '../src/router.js';

const { Camp } = await import('../src/legio/camp.js');

// Plays a career to its end, always taking the first choice it is allowed.
function playOut(s, pickChoice = (card) => card.choices.findIndex((c) => !c.off)) {
  let clicks = 0;
  while (!s.over) {
    const card = view(s).card;
    const result = choose(s, pickChoice(card));
    assert.ok(result.ok, `${card.title}: ${result.error}`);
    if (++clicks > 3000) assert.fail('the career never ended');
  }
  return clicks;
}

test('a career starts with the recruiting officer asking where you were born', () => {
  const s = start(1);
  const v = view(s);
  assert.equal(v.card.title, 'Where were you born?');
  assert.equal(v.card.choices.length, 6);
  assert.equal(v.year, 235);
  assert.equal(v.emperor, 'Maximinus Thrax');
  assert.equal('seed' in v, false, 'the page never sees the dice');
});

test('the same seed and the same choices give the same career', () => {
  const a = start(42);
  const b = start(42);
  playOut(a);
  playOut(b);
  assert.equal(a.fate, b.fate);
  assert.equal(score(a), score(b));
});

test('every career ends, in a few dozen to a few hundred choices', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const s = start(seed);
    const clicks = playOut(s, (card) => {
      const open = card.choices.map((c, i) => (c.off ? -1 : i)).filter((i) => i >= 0);
      return open[(seed * 31 + s.turn * 17) % open.length];
    });
    assert.ok(clicks >= 3);
    assert.ok(s.fate, 'a finished career says how it ended');
    assert.ok(s.best >= s.rank);
  }
});

test('a recruit becomes a legionary after the first half-year', () => {
  const s = start(7);
  choose(s, 0); // Thracia
  choose(s, 0); // a farmer's son
  choose(s, 0); // begin training
  assert.equal(s.rank, RANK.tiro);
  // Drill, then answer whatever follows until the half-year is over.
  choose(s, 0);
  while (s.half === 0 && !s.over) choose(s, view(s).card.choices.findIndex((c) => !c.off));
  if (!s.over) assert.equal(s.rank, RANK.miles);
});

test('promotion boards weigh merit, a patron\'s letter and the clock', () => {
  const s = start(3);
  s.rank = RANK.optio;
  s.stats = { virtus: 40, gratia: 40, litterae: 30, milites: 0 };
  const plain = promotionChance(s, RANK.centurio, 0);
  assert.ok(promotionChance(s, RANK.centurio, 10) > plain);
  s.stats.virtus = 70;
  assert.ok(promotionChance(s, RANK.centurio, 0) > plain);
  // Before Gallienus, senators commanded the legions.
  s.stats = { virtus: 60, gratia: 60, litterae: 60, milites: 0 };
  s.year = 250;
  const early = promotionChance(s, RANK.legionis, 0);
  s.year = 265;
  assert.ok(promotionChance(s, RANK.legionis, 0) > early);
});

test('history: the emperors of the crisis in order', () => {
  assert.equal(emperorIn(235).name, 'Maximinus Thrax');
  assert.equal(emperorIn(251).name, 'Trebonianus Gallus');
  assert.equal(emperorIn(270).name, 'Aurelian');
  assert.equal(emperorIn(300).name, 'Diocletian');
  assert.equal(RANKS.at(-1).name, 'Imperator');
});

test('encounters only come to the ranks they were written for', () => {
  const ids = new Set();
  for (const e of EVENTS) {
    assert.ok(!ids.has(e.id), `${e.id} is unique`);
    ids.add(e.id);
    assert.ok(e.ranks[0] >= RANK.miles && e.ranks[0] <= e.ranks[1] && e.ranks[1] <= RANK.imperator, `${e.id} has a rank band`);
  }
  const seen = new Set();
  for (let seed = 1; seed <= 400; seed++) {
    const s = start(seed);
    playOut(s, (card) => {
      const c = s.queue[0];
      if (c.id === 'event') {
        const e = EVENTS.find((x) => x.id === c.args.id);
        assert.ok(s.rank >= e.ranks[0] && s.rank <= e.ranks[1], `${e.id} shown to a ${RANKS[s.rank].name}`);
        seen.add(e.id);
      }
      const open = card.choices.map((x, i) => (x.off ? -1 : i)).filter((i) => i >= 0);
      return open[(seed * 13 + s.turn * 7) % open.length];
    });
  }
  assert.ok(seen.size >= 40, `a good spread of encounters turns up (${seen.size})`);
});

test('every encounter answer works at every rank it fits', () => {
  for (const e of EVENTS) {
    for (let rank = e.ranks[0]; rank <= e.ranks[1]; rank++) {
      for (let i = 0; i < e.choices.length; i++) {
        const s = start(rank * 100 + i);
        choose(s, 0); choose(s, 0); choose(s, 0);
        Object.assign(s, { rank, best: rank, age: 40, married: true, denarii: rank % 2 ? 0 : 2000 });
        s.queue = [{ id: 'event', args: { id: e.id }, ready: true }, { id: 'orders', args: {}, ready: false }];
        const card = view(s).card;
        assert.equal(typeof card.choices[i].label, 'string');
        const result = choose(s, i);
        assert.ok(result.ok && typeof result.line === 'string', `${e.id} choice ${i} at ${RANKS[rank].name}`);
      }
    }
  }
});

test('a kindness to a tentmate comes back later', () => {
  const s = start(11);
  choose(s, 0); choose(s, 0); choose(s, 0);
  Object.assign(s, { rank: RANK.miles, served: 4 });
  s.stats.litterae = 30;
  s.queue = [{ id: 'event', args: { id: 'dizo' }, ready: true }, { id: 'orders', args: {}, ready: false }];
  choose(s, 0);
  assert.equal(s.threads.dizo, 7);
  s.served = 7;
  // Answer a plain card; the encounter behind it is drawn as it comes to the front.
  s.queue = [{ id: 'history', args: { key: 'plague' }, ready: true }, { id: 'event', args: {} }, { id: 'orders', args: {} }];
  choose(s, 0);
  assert.equal(s.queue[0].args.id, 'dizo_return');
  choose(s, 0);
  assert.equal(s.threads.dizo, undefined);
  assert.ok(s.story.some((line) => line.includes('Aurelius Dizo')));
});

test('a disabled choice is refused', () => {
  const s = start(5);
  assert.equal(choose(s, 99).error, 'You can\'t do that.');
});

// The Camp object over a real in-memory SQLite.
function camp() {
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
  const c = new Camp({ ...fakeCtx(), storage: { ...fakeCtx().storage, sql } }, {});
  let seed = 0;
  c.seed = () => ++seed;
  return c;
}

test('the camp keeps one career per account and refuses a stale answer', async () => {
  const c = camp();
  assert.equal((await c.state('Miles')).run, null);
  const first = await c.enlist('Miles');
  assert.equal(first.run.turn, 0);
  const moved = await c.choose('Miles', { i: 0, turn: 0 });
  assert.equal(moved.run.turn, 1);
  const stale = await c.choose('Miles', { i: 0, turn: 0 });
  assert.match(stale.error, /already been answered/);
  assert.equal(stale.run.turn, 1);
  assert.equal((await c.state('miles')).run.turn, 1, 'accounts are case-insensitive');
  assert.equal((await c.state('Ana')).run, null);
});

test('a finished career goes on the leaderboard once, best first', async () => {
  const c = camp();
  for (const who of ['Miles', 'Ana', 'Miles']) {
    let state = await c.enlist(who);
    while (!state.run.over) {
      const i = state.run.card.choices.findIndex((x) => !x.off);
      state = await c.choose(who, { i, turn: state.run.turn });
      assert.equal(state.error, undefined);
    }
    // Answering again after the end changes nothing.
    await c.choose(who, { i: 0, turn: state.run.turn });
  }
  const { leaderboard, best, careers } = await c.state('Miles');
  assert.equal(leaderboard.length, 3);
  assert.ok(leaderboard[0].score >= leaderboard[1].score && leaderboard[1].score >= leaderboard[2].score);
  assert.equal(careers, 2);
  assert.equal(best.score, Math.max(...leaderboard.filter((r) => r.account === 'Miles').map((r) => r.score)));
});

test('the router asks guests to sign in and passes players to the camp', async () => {
  const calls = [];
  const env = {
    ACCOUNTS: { idFromName: (n) => n, get: () => ({ session: async (t) => (t === 'good' ? 'Miles' : null) }) },
    CAMP: { idFromName: (n) => n, get: (id) => ({ state: async (who) => (calls.push([id, 'state', who]), { run: null }), choose: async (who, body) => (calls.push([id, 'choose', who, body]), { run: null }) }) },
  };
  const guest = await handleRequest(new Request('http://x/api/legio/state'), env);
  assert.equal(guest.status, 401);
  const headers = { Cookie: 'sid=good', 'Content-Type': 'application/json' };
  await handleRequest(new Request('http://x/api/legio/state', { headers }), env);
  await handleRequest(new Request('http://x/api/legio/choose', { method: 'POST', headers, body: JSON.stringify({ i: 2, turn: 5 }) }), env);
  assert.deepEqual(calls, [['legio', 'state', 'Miles'], ['legio', 'choose', 'Miles', { i: 2, turn: 5 }]]);
});
