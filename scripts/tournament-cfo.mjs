// CFO strategy tournament: one bot plays a strategy against normal bots, seats rotated, on the real
// rules engine with perfect books. Prints win and bankruptcy rates per strategy.
//
//   node scripts/tournament-cfo.mjs [games per strategy] [players] [strategy,strategy,...]
//
// About ±2 points of win rate is noise at 600 games.
import { createGame, act, canBuild, companyCash, creditLimit } from '../src/cfo/rules.js';
import { SQUARES, RARITIES, CONFIG, M } from '../src/cfo/data.js';

// The normal bot: keeps a cash buffer, buys and builds (factories and stores first), goes public,
// and pays dividends out of company cash above what it saves for the dearest buildings.
const NORMAL = {
  reserve: M(500), payAbove: M(20000), payHow: 'dividend', ipo: true,
  zones: ['retail', 'industrial', 'banking', 'residential'],
  board: [], // board decisions to try each turn, in order, while keeping the buffer
  bid: 0.6, // share of the list price it bids for a lot at auction
  borrow: 0.5, // share of its credit limit it keeps borrowed
};

export const STRATEGIES = {
  normal: {},
  hoarder: { payAbove: Infinity },
  bonuses: { payHow: 'pay' },
  generous: { payAbove: M(5000) },
  residential: { zones: ['residential', 'retail', 'industrial', 'banking'] },
  noIpo: { ipo: false },
  marketer: { board: ['marketing'] },
  researcher: { board: ['research'] },
  boardroom: { board: ['research', 'marketing'] },
  noBids: { bid: 0 },
  accelerated: { policy: 'accelerated' },
  leaser: { lease: true },
  borrower: { borrow: 1 },
  noDebt: { borrow: 0 },
  bigBidder: { bid: 1 },
};

function zoneCount(g, seat, zone) {
  return g.tiles.filter((t) => t && t.owner === seat && t.zone === zone).length;
}

function turn(g, seat, s) {
  const p = g.players[seat];
  if (g.phase === 'roll') return act(g, seat, { a: 'roll' });
  if (s.policy && !p.policySet) act(g, seat, { a: 'policy', option: s.policy });
  if (g.phase === 'buy') {
    const sq = SQUARES[p.pos];
    if (companyCash(p) - (sq.price ?? 0) >= s.reserve) {
      // Take the zoning this company is shortest of, in its preferred order.
      const row = g.zoningRow;
      const want = [...s.zones].sort((a, b) => zoneCount(g, seat, a) - zoneCount(g, seat, b) || s.zones.indexOf(a) - s.zones.indexOf(b));
      const zone = Math.max(0, row.findIndex((z) => z === want.find((w) => row.includes(w))));
      if (!act(g, seat, { a: 'buy', zone })) return null;
    }
    act(g, seat, { a: 'pass' });
  }
  // Build the dearest PP&E it can afford while keeping its buffer.
  for (let pos = 0; pos < SQUARES.length; pos++) {
    if (canBuild(g, pos)) continue;
    const order = g.ppeRow.map((r, i) => [RARITIES[r].price, i]).sort((a, b) => b[0] - a[0]);
    for (const [price, card] of order) if (companyCash(p) - price >= s.reserve && !act(g, seat, { a: 'build', pos, card })) break;
    // Leasing: put up the dearest building whose yearly payment it can spare, with nothing down.
    if (s.lease && canBuild(g, pos) === null) for (const [price, card] of order) if (companyCash(p) - price * CONFIG.leaseRate >= s.reserve && !act(g, seat, { a: 'build', pos, card, lease: true })) break;
  }
  if (p.sale) act(g, seat, { a: 'sell', option: 'premium' });
  // Borrowing: call the bank and borrow this share of what it will lend.
  const room = Math.floor((creditLimit(p, g) * (s.borrow ?? 0)) + p.ledger.loan + (p.ledger.lease ?? 0));
  if (s.borrow && room > M(100) && act(g, seat, { a: 'borrow', amount: room })) {
    if (!act(g, seat, { a: 'board', option: 'financing' })) act(g, seat, { a: 'borrow', amount: room });
  }
  for (const option of s.board) if (companyCash(p) > M(3000) && !act(g, seat, { a: 'board', option })) break;
  if (s.ipo && !p.isPublic) act(g, seat, { a: 'ipo' });
  const extra = companyCash(p) - s.payAbove;
  if (extra > 0) act(g, seat, { a: s.payHow, amount: Math.floor(extra) });
  while (p.personalCash >= CONFIG.personalAssetPrice * 1.5 && !act(g, seat, { a: 'personal' }));
  if (g.phase === 'over') return null;
  return act(g, seat, { a: 'end' });
}

export function playGame(seed, strategies, options = {}) {
  const g = createGame(strategies.map((_, i) => `P${i}`), seed, { easyBooks: true, ...options });
  const plans = strategies.map((name) => ({ ...NORMAL, ...STRATEGIES[name] }));
  for (let steps = 0; g.phase !== 'over' && steps < 20000; steps++) {
    const seat = g.turn;
    if (turn(g, seat, plans[seat]) && g.phase !== 'over' && g.turn === seat) act(g, seat, { a: 'end' });
    // Sealed bids on any lot at auction, from every company that can spare the cash.
    if (g.auction) {
      g.players.forEach((p, i) => {
        const amount = Math.round(SQUARES[g.auction.pos].price * plans[i].bid);
        if (!p.out && plans[i].bid && !(i in g.auction.bids) && companyCash(p) - amount >= plans[i].reserve) act(g, i, { a: 'bid', amount, zone: 0 });
      });
    }
  }
  return g;
}

export function tournament(name, games, players, options = {}) {
  let wins = 0; let out = 0; let years = 0; const reasons = {};
  for (let i = 0; i < games; i++) {
    const seat = i % players;
    const strategies = Array.from({ length: players }, (_, k) => (k === seat ? name : 'normal'));
    const g = playGame(1000 + i, strategies, options);
    if (g.winner === seat) {
      wins++;
      const r = g.endReason.replace(/\$[\d,]+/, '$').replace(/after \d+/, 'after N');
      reasons[r] = (reasons[r] ?? 0) + 1;
    }
    if (g.players[seat].out) out++;
    years += Math.max(...g.players.map((p) => p.years));
  }
  return { name, wins: wins / games, out: out / games, years: years / games, reasons };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const games = Number(process.argv[2] ?? 200);
  const players = Number(process.argv[3] ?? 4);
  const names = (process.argv[4] ?? Object.keys(STRATEGIES).join(',')).split(',');
  for (const name of names) {
    const r = tournament(name, games, players);
    const pct = (x) => `${(x * 100).toFixed(1)}%`;
    console.log(`${name.padEnd(12)} wins ${pct(r.wins).padStart(6)}  out ${pct(r.out).padStart(6)}  years ${r.years.toFixed(1)}  ${JSON.stringify(r.reasons)}`);
  }
}
