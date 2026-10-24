// The CFO room's side of cross-play with the Roblox game (roblox/ in this repo). A Roblox game
// server can't hold a WebSocket open to us, so it speaks plain HTTP: it joins its players, sends
// their moves, and polls for changes every couple of seconds. The rules stay here; Roblox only
// draws what it is sent, including the list of moves (moves.js), so web changes reach it as is.
//
// Bump BRIDGE_VERSION when a change here would break a Roblox build already published; the Roblox
// game shows "update needed" instead of misbehaving until a newer build is published.
import { SQUARES, SETS, BOARD_SIZE, ISLAND_START, ISLAND_SIZE, LANDMARKS, CONFIG } from './data.js';
import { viewFor } from './rules.js';
import { slimView } from './moves.js';
import { sanitizeName } from '../names.js';

export const BRIDGE_VERSION = 1;
export const STALE_MS = 20_000; // a Roblox seat that hasn't polled for this long shows as away
export const MAX_ROBLOX_BODY = 4096;
const USER_ID = /^\d{1,20}$/;

const CORNER_NAMES = {
  fye: 'FYE', bank: 'Bank', cpe: 'CPE', review: 'Interim Review',
  terminal: 'Terminal', haven: 'Offshore Haven', customs: 'Customs', exchange: 'Exchange',
};
const DECK_NAMES = { market: 'Market Forces', fraud: 'Fraud', personal: 'Executive Perks' };

// The fixed board, sent once when a Roblox player joins.
export function robloxBoard() {
  return {
    size: BOARD_SIZE,
    islandStart: ISLAND_START,
    islandSize: ISLAND_SIZE,
    minPlayers: CONFIG.minPlayers,
    maxPlayers: CONFIG.maxPlayers,
    squares: SQUARES.map((s) => ({
      name: s.name ?? CORNER_NAMES[s.kind] ?? DECK_NAMES[s.deck] ?? s.kind,
      kind: s.kind,
      color: s.set !== undefined ? SETS[s.set].color : s.landmark ? LANDMARKS[s.landmark]?.color ?? '#f5f5f5' : null,
      price: s.price ?? null,
      island: Boolean(s.island),
    })),
  };
}

// Checks a request from the Roblox game server. Returns the cleaned request or an error string.
export function cleanRobloxRequest(body) {
  if (!body || typeof body !== 'object') return 'Bad request.';
  const op = body.op;
  if (op === 'join') {
    if (!USER_ID.test(String(body.userId ?? ''))) return 'Bad user id.';
    return { op, userId: String(body.userId), name: sanitizeName(body.name) };
  }
  if (op === 'leave' || op === 'act') {
    if (!USER_ID.test(String(body.userId ?? ''))) return 'Bad user id.';
    if (op === 'act' && (!body.msg || typeof body.msg !== 'object')) return 'Bad move.';
    return { op, userId: String(body.userId), msg: body.msg };
  }
  if (op === 'poll') {
    const ids = Array.isArray(body.userIds) ? body.userIds.map(String).filter((id) => USER_ID.test(id)).slice(0, CONFIG.maxPlayers * 2) : [];
    return { op, userIds: ids, since: Number.isInteger(body.since) ? body.since : -1 };
  }
  return 'Unknown request.';
}

// One Roblox player's picture of the room. Web players' names become "Web player N" in every
// name, log line and move label: Roblox needs text shown in its games to come from Roblox users
// or go through its filter, and these names come from outside.
export function robloxState(room, seat, host) {
  const g = room.game;
  const game = g ? slimView(g, seat ?? -1, viewFor(g, seat ?? -1)) : null;
  const mask = masker(room.seats);
  const seats = room.seats.map((s) => ({ name: mask(s.name), platform: s.roblox ? 'roblox' : 'web' }));
  if (game) {
    game.log = game.log.map(mask);
    for (const p of game.players) p.name = mask(p.name);
    for (const m of game.moves) m.label = mask(m.label);
  }
  return { seat, status: room.status, host, seats, game };
}

export function masker(seats) {
  const swaps = [];
  let n = 0;
  for (const s of seats) {
    if (s.roblox) continue;
    n += 1;
    swaps.push([s.name, `Web player ${n}`]);
  }
  // Longest names first, so "Ann" doesn't eat part of "Anna"; whole words only.
  swaps.sort((a, b) => b[0].length - a[0].length);
  const patterns = swaps.map(([name, mask]) => [new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, 'gu'), mask]);
  return (text) => patterns.reduce((t, [re, mask]) => t.replace(re, mask), String(text ?? ''));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
