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
const waiting = { status: 'waiting', seats, game: null };
console.log(JSON.stringify({
  board: robloxBoard(),
  waiting: robloxState(waiting, 1, 0),
  playing: robloxState(room, g.turn, 0),
  watching: robloxState(room, null, 0),
}));
