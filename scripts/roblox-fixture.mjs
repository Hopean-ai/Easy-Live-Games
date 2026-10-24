// Prints what the website sends a Roblox player mid-game, for the Roblox screen test
// (roblox/tests/screens.luau): node scripts/roblox-fixture.mjs > roblox/tests/fixture.json
// Built from the current rules each time, so the test always draws today's format.
import { createGame, act } from '../src/cfo/rules.js';
import { robloxBoard, robloxState } from '../src/cfo/roblox.js';

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
console.log(JSON.stringify({
  board: robloxBoard(),
  waiting: robloxState(waiting, 1, 0),
  playing: robloxState(room, g.turn, 0),
  watching: robloxState(room, null, 0),
}));
