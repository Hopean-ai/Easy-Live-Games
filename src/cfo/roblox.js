// The CFO room's side of cross-play with the Roblox game (roblox/ in this repo). A Roblox game
// server can't hold a WebSocket open to us, so it speaks plain HTTP: it joins its players, sends
// their moves, and polls for changes every couple of seconds. The rules stay here; Roblox only
// draws what it is sent, including the list of moves (moves.js), so web changes reach it as is.
//
// Bump BRIDGE_VERSION when a change here would break a Roblox build already published; the Roblox
// game shows "update needed" instead of misbehaving until a newer build is published.
import { SQUARES, SETS, BOARD_SIZE, ISLAND_START, ISLAND_SIZE, LANDMARKS, CONFIG, BOARD_GRID, gridPos, MODES, ZONES, RARITIES, MONEY_SCALE } from './data.js';
import { viewFor, ACCOUNTS, INCOME_FIELDS, BALANCE_FIELDS } from './rules.js';
import { slimView, FORMS } from './moves.js';
import { sanitizeName } from '../names.js';

export const BRIDGE_VERSION = 1;
export const STALE_MS = 20_000; // a Roblox seat that hasn't polled for this long shows as away
const USER_ID = /^\d{1,20}$/;

// The board's words and colours, as public/cfo.js and cfo.css draw them on the web.
const CORNER_NAMES = {
  fye: ['FYE', 'Fiscal year end'], bank: ['Bank', 'Borrow here'], cpe: ['CPE', 'Sit out a turn'], review: ['Interim Review', 'Audit'],
  terminal: ['Terminal', 'Fly home'], haven: ['Offshore Haven', 'Draw Fraud'], customs: ['Customs', 'Audit'], exchange: ['Exchange', 'Assets ½ price'],
};
const DECK_NAMES = { market: 'Market Forces', fraud: 'Fraud', personal: 'Executive Perks' };
const BACKGROUNDS = { fye: '#1f2630', bank: '#1f2630', cpe: '#1f2630', review: '#1f2630', deck: '#241d2e', transport: '#1b2430', terminal: '#10393c', haven: '#10393c', customs: '#10393c', exchange: '#10393c' };
const ZONE_TAGS = {
  industrial: { mark: 'Ind', color: '#9aa5b1' }, retail: { mark: 'Shop', color: '#f0b429' },
  banking: { mark: 'Bank', color: '#5ad1a5' }, residential: { mark: 'Res', color: '#ff9fb5' },
};
const RARITY_COLORS = { common: '#d0d4da', uncommon: '#6fdc8c', rare: '#6ea8ff', epic: '#c792ea', legendary: '#ff9f43', landmark: '#ffe9a8' };
const FIELD_LABELS = {
  netIncome: 'Net income (loss)', totalAssets: 'Total assets', totalLiabilitiesAndEquity: 'Total liabilities and equity',
  accDep: 'Less accumulated depreciation', retained: 'Retained earnings',
};

function money(n) {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

// The fixed parts of the game, sent once when a Roblox player joins.
export function robloxBoard() {
  return {
    size: BOARD_SIZE,
    islandStart: ISLAND_START,
    islandSize: ISLAND_SIZE,
    grid: BOARD_GRID,
    minPlayers: CONFIG.minPlayers,
    maxPlayers: CONFIG.maxPlayers,
    moneyScale: MONEY_SCALE,
    squares: SQUARES.map((s, pos) => {
      const [row, col] = gridPos(pos);
      const title = s.kind === 'land' ? s.name
        : s.kind === 'transport' ? MODES[s.mode].name
          : s.kind === 'deck' ? DECK_NAMES[s.deck] ?? s.deck
            : CORNER_NAMES[s.kind]?.[0] ?? s.kind;
      const sub = s.price ? money(s.price + (s.landmark ? LANDMARKS[s.landmark].building : 0)) : CORNER_NAMES[s.kind]?.[1] ?? '';
      return {
        name: s.name ?? title,
        title,
        sub,
        kind: s.kind,
        row,
        col,
        stripe: s.kind === 'land' ? (s.landmark ? '#f5f5f5' : SETS[s.set].color) : null,
        background: s.island && !BACKGROUNDS[s.kind] ? '#14292b' : BACKGROUNDS[s.kind] ?? '#171b22',
        border: s.island ? '#1f4d50' : '#2a313c',
        price: s.price ?? null,
        island: Boolean(s.island),
        landmark: Boolean(s.landmark),
        set: s.set !== undefined ? `${SETS[s.set].name} set of ${SETS[s.set].size}` : null,
      };
    }),
    zones: Object.fromEntries(Object.entries(ZONES).map(([id, z]) => [id, { name: z.name, ...(ZONE_TAGS[id] ?? { mark: z.name.slice(0, 4), color: '#9aa5b1' }) }])),
    rarities: Object.fromEntries(Object.entries(RARITIES).map(([id, r]) => [id, { name: r.name, price: r.price, color: RARITY_COLORS[id] ?? '#d0d4da' }])),
    // For the journal: every account, and the lines of the two statements in order.
    accounts: Object.entries(ACCOUNTS).map(([id, name]) => ({ id, name })),
    income: INCOME_FIELDS.map((id) => ({ id, name: FIELD_LABELS[id] ?? ACCOUNTS[id] ?? id, total: id === 'netIncome' })),
    balance: BALANCE_FIELDS.map((id) => ({ id, name: FIELD_LABELS[id] ?? ACCOUNTS[id] ?? id, total: /^total/.test(id) })),
    forms: FORMS,
    bookkeeperFee: CONFIG.bookkeeperFee,
    cleanBooksBonus: CONFIG.cleanBooksBonus,
  };
}

// Checks a request from the Roblox game server. Returns the cleaned request or an error string.
export function cleanRobloxRequest(body) {
  if (!body || typeof body !== 'object') return 'Bad request.';
  const op = body.op;
  if (op === 'join') {
    if (!USER_ID.test(String(body.userId ?? ''))) return 'Bad user id.';
    // account is set by the router for a linked Roblox player, never by the Roblox server.
    const account = typeof body.account === 'string' && body.account ? body.account.toLowerCase() : null;
    return { op, userId: String(body.userId), name: sanitizeName(body.name), expect: Number.isInteger(body.expect) ? body.expect : 0, account };
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
    // Documents and memos name the other players too ("Rent from Miles"). Copies, so the game's
    // own records are left alone.
    if (game.books) {
      game.books.docs = game.books.docs.map((d) => ({ ...d, text: mask(d.text) }));
      game.books.entries = game.books.entries.map((e) => ({ ...e, memo: mask(e.memo ?? '') }));
    }
  }
  return { seat, status: room.status, host, seats, game };
}

//
// A linked player can move a seat between the web and Roblox mid-game, but the game keeps the name
// it started with. A Roblox seat whose name came from the web shows its Roblox name instead.
export function masker(seats) {
  const swaps = [];
  let n = 0;
  for (const s of seats) {
    if (s.roblox) {
      if (s.robloxName && s.robloxName !== s.name) swaps.push([s.name, s.robloxName]);
      continue;
    }
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
