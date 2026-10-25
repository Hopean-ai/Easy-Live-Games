import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fakeCtx } from './helpers/workers-stub.js';
import { handleRequest } from '../src/router.js';

const { Accounts, LINK_CODE_TTL_MS } = await import('../src/accounts.js');
const { CfoRoom } = await import('../src/cfo/room.js');

// The Accounts object over a real in-memory SQLite, standing in for Durable Object storage.
function accounts() {
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
  return new Accounts({ ...fakeCtx(), storage: { ...fakeCtx().storage, sql } }, {});
}

async function withUser() {
  const a = accounts();
  a.sql.exec('INSERT INTO users (key, name, salt, hash, iterations, created) VALUES (?, ?, ?, ?, ?, ?)', 'miles_pitts', 'Miles_Pitts', '00', '00', 1, 0);
  return a;
}

test('a link code ties a Roblox player to the account, once, and moves on a new link', async () => {
  const a = await withUser();
  const { code, expires } = await a.robloxLinkCode('Miles_Pitts');
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.ok(expires > Date.now());
  assert.equal(await a.robloxAccount('111'), null);
  assert.deepEqual(await a.redeemRobloxLink('111', 'RobMiles', code.toLowerCase()), { account: 'Miles_Pitts' });
  assert.equal(await a.robloxAccount('111'), 'Miles_Pitts');
  assert.equal((await a.robloxLink('miles_pitts')).robloxName, 'RobMiles');
  assert.ok((await a.redeemRobloxLink('222', 'Other', code)).error, 'a code works once');

  // A second Roblox player linking the same account replaces the first.
  const again = await a.robloxLinkCode('Miles_Pitts');
  await a.redeemRobloxLink('222', 'Alt', again.code);
  assert.equal(await a.robloxAccount('111'), null);
  assert.equal(await a.robloxAccount('222'), 'Miles_Pitts');

  await a.unlinkRoblox({ roblox: '222' });
  assert.equal(await a.robloxLink('Miles_Pitts'), null);
});

test('link codes run out, a new one replaces the old, and wrong guesses lock the Roblox player out', async () => {
  const a = await withUser();
  const first = await a.robloxLinkCode('Miles_Pitts');
  const second = await a.robloxLinkCode('Miles_Pitts');
  assert.ok((await a.redeemRobloxLink('111', 'R', first.code)).error, 'the old code is gone');
  a.sql.exec('UPDATE link_codes SET expires = ?', Date.now() - 1);
  assert.ok((await a.redeemRobloxLink('111', 'R', second.code)).error, 'an expired code fails');

  const fresh = await a.robloxLinkCode('Miles_Pitts');
  for (let i = 0; i < 5; i++) await a.redeemRobloxLink('333', 'R', 'WRONG1');
  assert.match((await a.redeemRobloxLink('333', 'R', fresh.code)).error, /Too many/);
  assert.deepEqual(await a.redeemRobloxLink('444', 'R', fresh.code), { account: 'Miles_Pitts' }, 'others are not locked out');
  assert.ok(LINK_CODE_TTL_MS >= 60_000);
});

const post = (path, body, headers = {}) => new Request(`http://x${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

test('the web side needs a signed-in player; the Roblox side needs the key and never names the account', async () => {
  const a = await withUser();
  const env = {
    ROBLOX_KEY: 'sekrit',
    ADMIN_USERS: 'Miles_Pitts',
    ACCOUNTS: { idFromName: (n) => n, get: () => Object.assign(a, { session: async (t) => (t === 'good' ? 'Miles_Pitts' : null) }) },
  };
  assert.equal((await handleRequest(post('/api/roblox-link', { op: 'code' }), env)).status, 401);
  const { code } = await (await handleRequest(post('/api/roblox-link', { op: 'code' }, { Cookie: 'sid=good' }), env)).json();
  assert.ok(code);

  const key = { 'X-Roblox-Key': 'sekrit' };
  assert.equal((await handleRequest(post('/api/roblox/link', { op: 'redeem', userId: '111', code }), env)).status, 401);
  const bad = await handleRequest(post('/api/roblox/link', { op: 'redeem', userId: '111', name: 'RobMiles', code: 'NOPE22' }, key), env);
  assert.equal(bad.status, 400);
  const res = await handleRequest(post('/api/roblox/link', { op: 'redeem', userId: '111', name: 'RobMiles', code }, key), env);
  const body = await res.json();
  assert.deepEqual(body, { linked: true, admin: true, games: [] });
  assert.ok(!JSON.stringify(body).includes('Miles'), 'the Roblox side is not told the account name');

  const web = await (await handleRequest(new Request('http://x/api/roblox-link', { headers: { Cookie: 'sid=good' } }), env)).json();
  assert.equal(web.link.robloxName, 'RobMiles');

  // Joining a room as a linked player: the router names the account, whatever the body says.
  let got;
  env.CFO_ROOMS = { idFromName: (n) => n, get: () => ({ roblox: async (b) => ((got = b), { version: 1 }) }) };
  await handleRequest(post('/api/roblox/cfo/ABCD', { op: 'join', userId: '111', name: 'RobMiles', account: 'someone' }, key), env);
  assert.equal(got.account, 'Miles_Pitts');
  await handleRequest(post('/api/roblox/cfo/ABCD', { op: 'join', userId: '999', name: 'X', account: 'someone' }, key), env);
  assert.equal(got.account, null);

  await handleRequest(post('/api/roblox-link', { op: 'unlink' }, { Cookie: 'sid=good' }), env);
  const after = await (await handleRequest(post('/api/roblox/link', { op: 'status', userId: '111' }, key), env)).json();
  assert.equal(after.linked, false);
});

test('a linked player takes their seat between the web and Roblox mid-game', async () => {
  const room = new CfoRoom(fakeCtx(), { ADMIN_USERS: 'miles' });
  const closed = [];
  const webSocket = { send() {}, close: () => closed.push('web') };
  room.socketsFor = (seat) => (seat === 0 && !room.room.seats[0]?.roblox ? [webSocket] : []);
  room.room.seats.push({ token: 'web-token-1', name: 'Miles', guest: false, account: 'miles', admin: true });
  await room.roblox({ op: 'join', userId: '222', name: 'RobB', code: 'ABCD' });
  room.apply(0, { t: 'start' });
  assert.equal(room.room.status, 'playing');

  // On Roblox, as the account: the same seat, the web tab is told it was replaced.
  const joined = await room.roblox({ op: 'join', userId: '111', name: 'RobMiles', code: 'ABCD', account: 'Miles' });
  assert.equal(joined.seat, 0);
  assert.deepEqual(closed, ['web']);
  assert.equal(room.room.seats[0].roblox, '111');
  assert.equal(room.room.seats.length, 2);
  const view = (await room.roblox({ op: 'poll', userIds: ['111'], since: -1 })).views['111'];
  assert.equal(view.seat, 0);
  assert.equal(view.seats[0].name, 'RobMiles', 'the web name is shown as their Roblox name on Roblox');
  assert.ok(view.game.log.every((l) => !l.includes('Miles') || l.includes('RobMiles')));

  // Back on the web: the account takes the seat again.
  assert.equal(room.claimSeat('web-token-2', 'Miles', 'miles'), 0);
  assert.equal(room.room.seats[0].roblox, undefined);
  const watching = (await room.roblox({ op: 'poll', userIds: ['111'], since: -1 })).views['111'];
  assert.equal(watching.seat, null);
});

test('a linked Roblox player in a lobby is seated as their account, admin and all', async () => {
  const room = new CfoRoom(fakeCtx(), { ADMIN_USERS: 'miles' });
  room.socketsFor = () => [];
  await room.roblox({ op: 'join', userId: '222', name: 'RobB', code: 'ABCD' });
  await room.roblox({ op: 'join', userId: '111', name: 'RobMiles', code: 'ABCD', account: 'Miles' });
  assert.deepEqual(
    room.room.seats.map(({ name, guest, account, admin }) => ({ name, guest, account, admin })),
    [{ name: 'RobB', guest: true, account: null, admin: false }, { name: 'RobMiles', guest: false, account: 'miles', admin: true }],
  );
});
