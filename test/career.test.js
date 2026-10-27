import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fakeCtx } from './helpers/workers-stub.js';
import { act, bankBalance, cleanLines, sameEntry, start, statements, view } from '../src/career/rules.js';
import { CONFIG } from '../src/career/data.js';
import { handleRequest } from '../src/router.js';

const { Office } = await import('../src/career/office.js');

// A bot CFO that posts every document correctly (it reads the true entry), files on time, sets up
// the POS system and a reviewed bookkeeper, and funds each machine the cheapest way it can.
// `delegate: false` keeps everything on its own desk; `slip` posts that share of entries wrong.
function playOut(s, { delegate = true, honest = true, slip = 0 } = {}) {
  let n = 0;
  let k = 0;
  while (!s.over) {
    assert.ok(++n < 20000, 'the career never ended');
    const v = view(s);
    let r;
    if (v.card) {
      const open = v.card.choices.map((c, i) => (c.off ? -1 : i)).filter((i) => i >= 0);
      const i = v.card.title === 'The tax return' || v.card.title === 'Sam\'s holiday' ? (honest ? 0 : 1) : open[0];
      r = act(s, { type: 'choose', i });
    } else if (delegate && !s.pos && s.week > 4 && s.hours >= CONFIG.pos.setupHours) {
      r = act(s, { type: 'project', id: 'pos' });
    } else if (delegate && !s.bookkeeper && s.week > 8 && s.hours >= CONFIG.bookkeeper.hireHours) {
      r = act(s, { type: 'project', id: 'bookkeeper' });
    } else if (delegate && s.bookkeeper && !s.review) {
      r = act(s, { type: 'project', id: 'review' });
    } else {
      const d = s.docs.find((x) => !x.posted && x.week > s.lockedThrough);
      const cost = d ? (CONFIG.postHours[d.kind] ?? CONFIG.postHours.default) : Infinity;
      if (v.canFile && s.hours >= CONFIG.fileHours && (!d || s.hours - cost < CONFIG.fileHours)) {
        r = act(s, { type: 'file' });
      } else if (d && s.hours >= cost) {
        const wrong = slip && (k++ % Math.round(1 / slip) === 0);
        const lines = wrong ? d.lines.map((l, i) => (i === 0 ? { ...l, account: l.account === 'Rent expense' ? 'Supplies expense' : 'Rent expense' } : l)) : d.lines;
        r = act(s, { type: 'post', doc: d.id, lines });
      } else {
        r = act(s, { type: 'endWeek' });
      }
    }
    assert.equal(r.error, undefined, `week ${s.week}: ${r.error}`);
  }
  return s;
}

test('a career starts in week 1 with the first week\'s receipts and bills on the desk', () => {
  const s = start(1);
  const v = view(s);
  assert.equal(v.week, 1);
  assert.equal(v.month, 'January');
  assert.equal(v.hours, CONFIG.hoursPerWeek);
  assert.equal(v.bank, bankBalance(s));
  const kinds = new Set(v.inbox.map((d) => d.kind));
  for (const k of ['insurance', 'rent', 'stock', 'sale', 'wages']) assert.ok(kinds.has(k), `${k} arrives in week 1`);
  assert.equal('seed' in v, false, 'the page never sees the dice');
  for (const d of v.inbox) assert.equal('lines' in d, false, 'the page never sees the right answer before posting');
});

test('the books always balance, both the true books and the books as kept', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const s = playOut(start(seed));
    for (const kept of [false, true]) {
      const st = statements(s, { kept, year: 1 });
      assert.ok(Math.abs(st.assets - st.liabilities - st.equity) < 0.01, `seed ${seed} ${kept ? 'kept' : 'true'} books balance`);
    }
  }
});

test('a careful CFO who delegates graduates from the startup stage', () => {
  let graduated = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const s = playOut(start(seed));
    if (s.result === 'graduated') graduated++;
    assert.ok(s.score > 0);
  }
  assert.ok(graduated >= 18, `${graduated} of 20 graduated`);
});

test('doing every document yourself can\'t keep up with a growing shop', () => {
  let graduated = 0;
  for (let seed = 1; seed <= 10; seed++) if (playOut(start(seed), { delegate: false }).result === 'graduated') graduated++;
  assert.ok(graduated <= 2, `${graduated} of 10 graduated without delegating`);
});

test('the monthly review counts wrong and missing documents', () => {
  const s = start(3);
  const sale = s.docs.find((d) => d.kind === 'sale');
  const wrong = sale.lines.map((l) => (l.account === 'Sales revenue' ? { ...l, account: 'Contributed capital' } : l));
  assert.equal(act(s, { type: 'post', doc: sale.id, lines: wrong }).ok, true);
  assert.equal(act(s, { type: 'file' }).error, 'You file the books in the last week of the month.');
  for (let i = 0; i < 3; i++) {
    while (s.request) act(s, { type: 'choose', i: s.request.kind === 'expand' ? 3 : 0 });
    act(s, { type: 'endWeek' });
  }
  while (s.request) act(s, { type: 'choose', i: s.request.kind === 'expand' ? 3 : 0 });
  assert.equal(act(s, { type: 'file' }).ok, true);
  const f = s.filings.at(-1);
  assert.equal(f.errors, 1);
  assert.equal(f.missing, s.docs.filter((d) => !d.posted && d.week <= 4).length);
  const review = view(s).review;
  const found = review.found.find((x) => x.id === sale.id);
  assert.equal(found.problem, 'wrong');
  assert.ok(sameEntry(found.correct, sale.lines), 'the review shows the right entry');
});

test('an entry must balance and use real accounts', () => {
  assert.match(cleanLines([{ account: 'Cash', dr: 10 }]).error, /two to eight/);
  assert.match(cleanLines([{ account: 'Cash', dr: 10 }, { account: 'Nope', cr: 10 }]).error, /Pick an account/);
  assert.match(cleanLines([{ account: 'Cash', dr: 10 }, { account: 'Sales revenue', cr: 9 }]).error, /must be equal/);
  assert.match(cleanLines([{ account: 'Cash', dr: 10, cr: 10 }, { account: 'Sales revenue', cr: 10 }]).error, /either a debit or a credit/);
  assert.deepEqual(cleanLines([{ account: 'Cash', dr: '10.005' }, { account: 'Sales revenue', cr: 10.01 }]).lines.length, 2);
});

test('posting costs hours, and a week with none left refuses more', () => {
  const s = start(4);
  s.hours = 1;
  const sale = s.docs.find((d) => d.kind === 'sale');
  assert.match(act(s, { type: 'post', doc: sale.id, lines: sale.lines }).error, /takes 2 hours/);
  const rent = s.docs.find((d) => d.kind === 'rent');
  assert.equal(act(s, { type: 'post', doc: rent.id, lines: rent.lines }).ok, true);
  assert.equal(s.hours, 0);
});

test('the POS system posts till receipts and the bookkeeper posts bills', () => {
  const s = start(5);
  assert.equal(act(s, { type: 'project', id: 'pos' }).ok, true);
  assert.ok(s.docs.filter((d) => d.kind === 'sale').every((d) => d.posted?.by === 'pos'), 'this week\'s receipts are posted at once');
  assert.equal(act(s, { type: 'project', id: 'bookkeeper' }).ok, true);
  act(s, { type: 'endWeek' });
  const bills = s.docs.filter((d) => d.week === 2 && ['stock', 'wages', 'bookkeeper'].includes(d.kind));
  assert.ok(bills.length >= 2 && bills.every((d) => d.posted?.by === 'bookkeeper'));
  assert.ok(s.docs.filter((d) => d.week === 2 && d.kind === 'sale').every((d) => d.posted?.by === 'pos'));
});

test('booking the CEO\'s holiday as travel is hidden from the review but not from an audit', () => {
  const s = start(6);
  s.request = { kind: 'holiday' };
  assert.equal(act(s, { type: 'choose', i: 1 }).ok, true);
  const doc = s.docs.find((d) => d.kind === 'holiday');
  assert.equal(doc.fraud, CONFIG.pressure.holiday);
  assert.equal(doc.posted.lines[0].account, 'Travel expense');
  assert.equal(s.year.hidden, CONFIG.pressure.holiday);
  assert.match(act(s, { type: 'post', doc: doc.id, lines: doc.lines }).error, /isn't on your desk/);
  assert.equal(view(s).journal.find((d) => d.id === doc.id).fixable, false);
});

test('a dishonest CFO is sometimes caught and pays back more than was saved', () => {
  let caught = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const s = playOut(start(seed), { honest: false });
    if (s.caught) {
      caught++;
      assert.ok(s.docs.some((d) => d.kind === 'backTax') || s.owed?.some((o) => o.kind === 'backTax'));
    }
  }
  assert.ok(caught >= 3 && caught <= 25, `${caught} of 30 caught`);
});

test('sloppy books fail the year end', () => {
  const s = playOut(start(7), { slip: 0.25 });
  assert.notEqual(s.years[0].problems, 0);
  assert.ok(s.years[0].problems > CONFIG.graduate.maxErrors);
});

test('Sam has to be answered before the week ends', () => {
  const s = start(8);
  s.request = { kind: 'holiday' };
  assert.equal(act(s, { type: 'endWeek' }).error, 'Answer Sam first.');
  assert.equal(act(s, { type: 'choose', i: 2 }).ok, true);
  assert.equal(act(s, { type: 'endWeek' }).ok, true);
  assert.equal(s.week, 2);
});

// The Office object over a real in-memory SQLite.
function office() {
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
  const o = new Office({ ...fakeCtx(), storage: { ...fakeCtx().storage, sql } }, {});
  let seed = 0;
  o.seed = () => ++seed;
  return o;
}

test('the office keeps one career per account and refuses a stale action', async () => {
  const o = office();
  assert.equal((await o.state('Miles')).run, null);
  const first = await o.begin('Miles');
  assert.equal(first.run.turn, 0);
  const doc = first.run.inbox.find((d) => d.kind === 'rent');
  const moved = await o.act('Miles', { type: 'post', doc: doc.id, lines: [{ account: 'Rent expense', dr: 2000 }, { account: 'Cash', cr: 2000 }], turn: 0 });
  assert.equal(moved.run.turn, 1);
  const stale = await o.act('Miles', { type: 'endWeek', turn: 0 });
  assert.match(stale.error, /out of date/);
  assert.equal((await o.state('miles')).run.turn, 1, 'accounts are case-insensitive');
  assert.equal((await o.state('Ana')).run, null);
});

test('winning the startup stage unlocks Classic for that account', async () => {
  const o = office();
  await o.begin('Miles');
  assert.equal(await o.classicUnlocked('Miles'), false);
  // Recording goes through act(): use a fresh run that's one end-week from the year end.
  const near = playUntilYearEnd(start(2));
  o.save('Miles', near);
  const done = await o.act('Miles', { type: 'endWeek', turn: near.turn });
  assert.equal(done.run.over, true);
  assert.equal(done.run.result, 'graduated');
  assert.equal(await o.classicUnlocked('Miles'), true);
  assert.equal(await o.classicUnlocked('Ana'), false);
  assert.equal((await o.state('Miles')).record.length, 1);
});

// Plays a careful career up to the last week of year 1, answered and filed, ready to end.
function playUntilYearEnd(s) {
  const yearWeeks = CONFIG.weeksPerMonth * CONFIG.monthsPerYear;
  const real = playOut(structuredClone(s));
  assert.equal(real.result, 'graduated');
  // Replay the same seed, stopping before the final endWeek.
  const t = structuredClone(s);
  let guard = 0;
  while (!(t.week === yearWeeks && !t.request && t.filings.some((f) => f.month === CONFIG.monthsPerYear) && !t.docs.some((d) => !d.posted && d.week === yearWeeks))) {
    assert.ok(++guard < 20000);
    const v = view(t);
    if (v.card) {
      act(t, { type: 'choose', i: v.card.title === 'The tax return' ? 0 : v.card.choices.findIndex((c) => !c.off) });
      continue;
    }
    if (!t.pos && t.week > 4 && t.hours >= CONFIG.pos.setupHours) { act(t, { type: 'project', id: 'pos' }); continue; }
    if (!t.bookkeeper && t.week > 8 && t.hours >= CONFIG.bookkeeper.hireHours) { act(t, { type: 'project', id: 'bookkeeper' }); continue; }
    if (t.bookkeeper && !t.review) { act(t, { type: 'project', id: 'review' }); continue; }
    const d = t.docs.find((x) => !x.posted && x.week > t.lockedThrough);
    const cost = d ? (CONFIG.postHours[d.kind] ?? CONFIG.postHours.default) : Infinity;
    if (v.canFile && t.hours >= CONFIG.fileHours && (!d || t.hours - cost < CONFIG.fileHours)) { act(t, { type: 'file' }); continue; }
    if (d && t.hours >= cost) { act(t, { type: 'post', doc: d.id, lines: d.lines }); continue; }
    act(t, { type: 'endWeek' });
  }
  return t;
}

test('the router asks guests to sign in and passes players to the office', async () => {
  const calls = [];
  const env = {
    ACCOUNTS: { idFromName: (n) => n, get: () => ({ session: async (t) => (t === 'good' ? 'Miles' : null) }) },
    OFFICE: { idFromName: (n) => n, get: (id) => ({ state: async (who) => (calls.push([id, 'state', who]), { run: null }), act: async (who, body) => (calls.push([id, 'act', who, body]), { run: null }) }) },
  };
  const guest = await handleRequest(new Request('http://x/api/career/state'), env);
  assert.equal(guest.status, 401);
  const headers = { Cookie: 'sid=good', 'Content-Type': 'application/json' };
  await handleRequest(new Request('http://x/api/career/state', { headers }), env);
  await handleRequest(new Request('http://x/api/career/act', { method: 'POST', headers, body: JSON.stringify({ type: 'endWeek', turn: 5 }) }), env);
  assert.deepEqual(calls, [['career', 'state', 'Miles'], ['career', 'act', 'Miles', { type: 'endWeek', turn: 5 }]]);
});

test('with the lock on, Classic CFO needs a won career, except for admins', async () => {
  const won = new Set(['ana']);
  const env = {
    CLASSIC_LOCK: 'on',
    ADMIN_USERS: 'Miles',
    ACCOUNTS: { idFromName: (n) => n, get: () => ({ session: async (t) => ({ a: 'Ana', b: 'Bo', m: 'Miles' })[t] ?? null }) },
    OFFICE: { idFromName: (n) => n, get: () => ({ classicUnlocked: async (who) => won.has(who.toLowerCase()) }) },
    CFO_ROOMS: { idFromName: (n) => n, get: () => ({ fetch: async () => new Response('room') }) },
    MATCHMAKER: { idFromName: (n) => n, get: () => ({ fetch: async () => new Response('queue') }) },
  };
  const ws = (sid, path = '/api/rooms/cfo/ABCD/ws') => handleRequest(new Request(`http://x${path}`, { headers: { Upgrade: 'websocket', ...(sid ? { Cookie: `sid=${sid}` } : {}) } }), env);
  assert.equal((await ws(null)).status, 403, 'guests are locked out');
  assert.equal((await ws('b')).status, 403);
  assert.equal(await (await ws('a')).text(), 'room');
  assert.equal(await (await ws('m')).text(), 'room', 'admins always play');
  assert.equal((await ws('b', '/api/match/cfo/ws')).status, 403);
  assert.equal(await (await handleRequest(new Request('http://x/api/rooms/cfo/ABCD/ws', { headers: { Upgrade: 'websocket', Cookie: 'sid=b' } }), { ...env, CLASSIC_LOCK: 'off' })).text(), 'room', 'off by default');
});
