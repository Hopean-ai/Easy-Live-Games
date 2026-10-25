import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { GAMES, robloxGames, publicGames } from '../src/games.js';
import { handleRequest } from '../src/router.js';
import { BRIDGE_VERSION as CFO_BRIDGE } from '../src/cfo/roblox.js';

// Each Roblox game's website bridge version, by game id. A new game on Roblox adds its own here.
const BRIDGES = { cfo: CFO_BRIDGE };
const luau = (dir, name) => new URL(`../roblox/src/${dir}/games/${name}.luau`, import.meta.url);

// A game on Roblox has a module in shared/games (its id and bridge version) and one in
// client/games (its screens), and the Roblox side has no module for a game the website doesn't
// offer there.
test('every game on Roblox has its Luau modules, and the bridge versions match', () => {
  const onRoblox = GAMES.filter((g) => g.roblox);
  assert.ok(onRoblox.length > 0);
  for (const g of onRoblox) {
    assert.ok(existsSync(luau('shared', g.roblox)), `add roblox/src/shared/games/${g.roblox}.luau for ${g.id}`);
    assert.ok(existsSync(luau('client', g.roblox)), `add roblox/src/client/games/${g.roblox}.luau for ${g.id}`);
    const shared = readFileSync(luau('shared', g.roblox), 'utf8');
    assert.equal(shared.match(/\.ID = "([^"]+)"/)?.[1], g.id, `${g.roblox}.luau names the website id`);
    assert.ok(g.id in BRIDGES, `add ${g.id}'s BRIDGE_VERSION to BRIDGES in this test`);
    assert.equal(Number(shared.match(/\.SUPPORTED = (\d+)/)?.[1]), BRIDGES[g.id],
      `update SUPPORTED in roblox/src/shared/games/${g.roblox}.luau with ${g.id}'s BRIDGE_VERSION`);
  }
  for (const dir of ['shared', 'client']) {
    const files = readdirSync(new URL(`../roblox/src/${dir}/games/`, import.meta.url)).filter((f) => f.endsWith('.luau'));
    assert.deepEqual(files.sort(), onRoblox.map((g) => `${g.roblox}.luau`).sort(), `roblox/src/${dir}/games has a module for each game on Roblox, and no others`);
  }
});

test('Pong is not on Roblox; the hub lists the rest with their table sizes', () => {
  const list = robloxGames();
  assert.ok(!list.some((g) => g.id === 'pong'));
  assert.deepEqual(list.find((g) => g.id === 'cfo'), { id: 'cfo', name: 'CFO', blurb: GAMES.find((g) => g.id === 'cfo').blurb, players: '2–6', minPlayers: 2, maxPlayers: 6 });
  assert.equal(publicGames().find((g) => g.id === 'cfo').roblox, true);
  assert.equal(publicGames().find((g) => g.id === 'pong').roblox, false);
});

const key = { 'X-Roblox-Key': 'sekrit' };
const post = (path, body, headers = key) => new Request(`http://x${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('the Roblox routes take any game on Roblox, and only those', async () => {
  const got = [];
  const rooms = (tag) => ({ idFromName: (n) => n, get: (n) => ({ roblox: async (b) => (got.push([tag, n, b.op]), { version: 1 }) }) });
  const queued = [];
  const env = {
    ROBLOX_KEY: 'sekrit',
    CFO_ROOMS: rooms('cfo'),
    ROOMS: rooms('pong'),
    MATCHMAKER: { idFromName: (n) => n, get: (n) => ({ httpQueue: async (q) => (queued.push([n, q]), { queued: { waiting: 1, max: q.max } }) }) },
  };
  assert.equal((await handleRequest(post('/api/roblox/games', {}, {}), env)).status, 401, 'the list needs the key');
  const list = await (await handleRequest(post('/api/roblox/games', {}), env)).json();
  assert.deepEqual(list.games.map((g) => g.id), robloxGames().map((g) => g.id));

  assert.equal((await handleRequest(post('/api/roblox/cfo/abcd', { op: 'poll' }), env)).status, 200);
  assert.deepEqual(got.at(-1), ['cfo', 'ABCD', 'poll']);
  assert.equal((await handleRequest(post('/api/roblox/pong/ABCD', { op: 'poll' }), env)).status, 404, 'Pong is not on Roblox');
  assert.equal((await handleRequest(post('/api/roblox/nope/ABCD', { op: 'poll' }), env)).status, 404);
  assert.equal(got.length, 1);

  const q = await (await handleRequest(post('/api/roblox/match/cfo', { op: 'join', userId: '7' }), env)).json();
  assert.deepEqual(q, { queued: { waiting: 1, max: 6 } });
  assert.deepEqual(queued[0], ['cfo', { who: 'roblox:7', op: 'join', min: 2, max: 6 }]);
  assert.equal((await handleRequest(post('/api/roblox/match/pong', { op: 'join', userId: '7' }), env)).status, 404);
});
