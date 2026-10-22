import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/router.js';
import { seatToken } from '../src/claude.js';
import { createGame, act, viewFor } from '../src/cfo/rules.js';
import { nextMove, stepKey } from '../src/cfo/bot.js';

const post = (url, body, headers = {}) =>
  new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

// A fake env: Miles is an admin, Ann is not; the CFO room answers claudePlayers; fetch is stubbed.
function env({ seats = { names: ['Claude 1', 'Claude 2'], status: 'waiting' }, secrets = true } = {}) {
  const calls = { room: [], fire: [] };
  const sessions = { miles: 'Miles_Pitts', ann: 'Ann' };
  return {
    calls,
    ADMIN_USERS: 'Miles_Pitts',
    ...(secrets ? { CLAUDE_ROUTINE_URL: 'https://api.anthropic.com/v1/claude_code/routines/trig_X/fire', CLAUDE_ROUTINE_TOKEN: 'sk-test' } : {}),
    ACCOUNTS: { idFromName: (n) => n, get: () => ({ session: async (t) => sessions[t] ?? null }) },
    CFO_ROOMS: { idFromName: (n) => n, get: (id) => ({ claudePlayers: async (count) => (calls.room.push({ id, count }), seats) }) },
  };
}

async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test('an admin calls the routine with the room, its origin and a seat token per player', async () => {
  const e = env();
  let sent = null;
  const res = await withFetch(async (url, init) => ((sent = { url, init }), Response.json({ claude_code_session_url: 'https://claude.ai/code/session_1' })), () =>
    handleRequest(post('https://game.example/api/rooms/cfo/abcde/claude', { count: 2 }, { Cookie: 'sid=miles', Origin: 'https://game.example' }), e));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { players: ['Claude 1', 'Claude 2'], session: 'https://claude.ai/code/session_1' });
  assert.deepEqual(e.calls.room, [{ id: 'ABCDE', count: 2 }]);
  assert.equal(sent.url, e.CLAUDE_ROUTINE_URL);
  assert.equal(sent.init.headers.Authorization, 'Bearer sk-test');
  assert.equal(sent.init.headers['anthropic-beta'], 'experimental-cc-routine-2026-04-01');
  const payload = JSON.parse(JSON.parse(sent.init.body).text);
  assert.equal(payload.base, 'https://game.example');
  assert.equal(payload.room, 'ABCDE');
  assert.equal(payload.players[0].token, await seatToken('sk-test', 'ABCDE', 'Claude 1'));
  assert.match(payload.players[0].token, /^[\w-]{8,64}$/);
  assert.notEqual(payload.players[0].token, payload.players[1].token);
});

test('only admins can call Claude players, and never cross-origin', async () => {
  const e = env();
  const fire = () => assert.fail('the routine should not be called');
  await withFetch(fire, async () => {
    for (const cookie of ['sid=ann', 'sid=nobody', '']) {
      const res = await handleRequest(post('https://game.example/api/rooms/cfo/ABCDE/claude', { count: 1 }, { Cookie: cookie }), e);
      assert.equal(res.status, 403);
    }
    const other = await handleRequest(post('https://game.example/api/rooms/cfo/ABCDE/claude', { count: 1 }, { Cookie: 'sid=miles', Origin: 'https://evil.example' }), e);
    assert.equal(other.status, 403);
    const get = await handleRequest(new Request('https://game.example/api/rooms/cfo/ABCDE/claude', { headers: { Cookie: 'sid=miles' } }), e);
    assert.equal(get.status, 405);
  });
  assert.equal(e.calls.room.length, 0);
});

test('Claude players explain what is missing: secrets, a sane count, a free seat', async () => {
  const req = (body) => post('https://g/api/rooms/cfo/ABCDE/claude', body, { Cookie: 'sid=miles' });
  const fire = () => assert.fail('the routine should not be called');
  await withFetch(fire, async () => {
    assert.equal((await handleRequest(req({ count: 1 }), env({ secrets: false }))).status, 503);
    for (const count of [0, 6, 1.5, 'x', undefined]) assert.equal((await handleRequest(req({ count }), env())).status, 400);
    const full = await handleRequest(req({ count: 1 }), env({ seats: { error: 'The room is full.' } }));
    assert.equal(full.status, 409);
    assert.equal((await full.json()).error, 'The room is full.');
  });
});

test('a refused routine call is reported, not swallowed', async () => {
  const res = await withFetch(async () => new Response('nope', { status: 401 }), () =>
    handleRequest(post('https://g/api/rooms/cfo/ABCDE/claude', { count: 1 }, { Cookie: 'sid=miles' }), env()));
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /401/);
});

test('Claude players finish whole games from what their seats are shown, with clean books', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const n = 2 + (seed % 5);
    const g = createGame(Array.from({ length: n }, (_, i) => `Claude ${i + 1}`), seed, {});
    const tried = Array.from({ length: n }, () => ({ key: '', set: new Set() }));
    for (let steps = 0; g.phase !== 'over'; steps++) {
      assert.ok(steps < 20000, 'the game should end');
      // Like the script: each seat looks at its own view and sends at most one move.
      const seat = [...Array(n).keys()].find((s) => {
        const v = viewFor(g, s);
        if (tried[s].key !== stepKey(v)) tried[s] = { key: stepKey(v), set: new Set() };
        return nextMove(v, s, tried[s].set);
      });
      assert.notEqual(seat, undefined, 'someone always has a move');
      const move = nextMove(viewFor(g, seat), seat, tried[seat].set);
      tried[seat].set.add(JSON.stringify(move));
      act(g, seat, move);
    }
    assert.ok(g.winner !== null);
    assert.ok(g.players.every((p) => p.misstatements === 0 && p.outsourced), 'a bookkeeper keeps every bot\'s books');
  }
});
