import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGame, act, viewFor, tableActions } from '../src/cfo/rules.js';
import { nextMove, stepKey } from '../src/cfo/bot.js';
import { MOVES, WEB_ONLY, movesFor } from '../src/cfo/moves.js';

// The Roblox game offers only the moves in moves.js. When a new action is added to rules.js, this
// fails until it is listed in MOVES (Roblox players get it) or WEB_ONLY (they don't, and why).
test('every action the rules know is offered on Roblox or marked web only', () => {
  const inline = [...readFileSync(new URL('../src/cfo/rules.js', import.meta.url), 'utf8').matchAll(/action\.a === '(\w+)'/g)].map((m) => m[1]);
  const known = new Set([...inline, ...tableActions()]);
  for (const a of known) assert.ok(MOVES[a] || WEB_ONLY[a], `${a} is in rules.js but not in MOVES or WEB_ONLY in src/cfo/moves.js`);
  for (const a of [...Object.keys(MOVES), ...Object.keys(WEB_ONLY)]) assert.ok(known.has(a), `${a} is listed in moves.js but rules.js has no such action`);
  for (const a of Object.keys(MOVES)) assert.ok(!WEB_ONLY[a], `${a} is in both MOVES and WEB_ONLY`);
});

// Plays a seeded game with the bot, calling `check` every `every` steps.
function playBot(seed, steps, every, check, onMove = () => {}) {
  const g = createGame(['Ann', 'Ben', 'Cy'], seed);
  const tried = new Map();
  for (let n = 0; n < steps && g.phase !== 'over'; n++) {
    if (n % every === 0) check(g, n);
    let moved = false;
    for (let s = 0; s < g.players.length; s++) {
      const v = viewFor(g, s);
      const key = `${stepKey(v)}:${s}`;
      const t = tried.get(key) ?? new Set();
      tried.set(key, t);
      const m = nextMove(v, s, t);
      if (!m) continue;
      onMove(g, s, v, m, n);
      if (act(g, s, m)) t.add(JSON.stringify(m));
      moved = true;
      break;
    }
    if (!moved) break;
  }
  return g;
}

test('the move menu matches one built with a fresh copy, and every move on it is accepted', () => {
  let menus = 0;
  playBot(3, 1500, 97, (g) => {
    for (let s = 0; s < g.players.length; s++) {
      const v = viewFor(g, s);
      const quick = movesFor(g, s, v);
      assert.deepEqual(quick, movesFor(g, s, v, { fresh: true }), 'reusing the copy after a refused move changed the menu');
      for (const m of quick) {
        if (m.input) continue;
        assert.equal(act(structuredClone(g), s, m.action), null, `offered ${m.label} but the rules refuse it`);
      }
      menus += 1;
    }
  });
  assert.ok(menus > 10);
});

test("the bot's moves are all on the menu, so a Roblox player can make them too", () => {
  let checked = 0;
  playBot(5, 1500, Infinity, () => {}, (g, s, v, m, n) => {
    if (n % 11 || WEB_ONLY[m.a] || act(structuredClone(g), s, m) !== null) return;
    // A move whose extra fields change nothing is offered without them (see movesFor).
    const offered = movesFor(g, s, v).some(({ action: o }) => o.a === m.a && Object.keys(o).every((k) => o[k] === m[k]));
    assert.ok(offered, `the bot made ${JSON.stringify(m)} but the menu had no such move`);
    checked += 1;
  });
  assert.ok(checked > 15, `only ${checked} moves checked`);
});

test('a game moves on when every player picks only from the menu', () => {
  const g = createGame(['Ann', 'Ben'], 9);
  for (let s = 0; s < 2; s++) act(g, s, { a: 'outsource', on: true });
  const prefer = ['roll', 'buy', 'build', 'end', 'pass'];
  for (let n = 0; n < 150 && g.phase !== 'over'; n++) {
    const s = g.turn;
    const menu = movesFor(g, s, viewFor(g, s)).filter((m) => !m.input);
    const pick = prefer.map((a) => menu.find((m) => m.action.a === a)).find(Boolean);
    assert.ok(pick, `no way forward from phase ${g.phase}: ${menu.map((m) => m.label).join(', ')}`);
    assert.equal(act(g, s, pick.action), null);
  }
  assert.ok(g.players.some((p) => p.years > 0 || p.pos > 0));
});
