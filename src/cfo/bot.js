import { SQUARES, RARITIES, CONFIG } from './data.js';

// A simple CFO player that works only from what a seat is shown (viewFor), so the same code can
// drive a player over a WebSocket (scripts/claude-players.mjs) or, later, inside the room.
//
// nextMove returns one action to send, or null when there is nothing to do. `tried` holds the
// actions already refused at this step (see stepKey), so a refused move is skipped, not repeated.
export function nextMove(view, seat, tried = new Set()) {
  const me = view?.players?.[seat];
  if (!me || me.out || view.phase === 'over') return null;
  const ok = (m) => (tried.has(JSON.stringify(m)) ? null : m);

  // Any time: hand the books to a bookkeeper, so every entry and filing is right.
  if (me.docs && !me.outsourced) {
    const m = ok({ a: 'outsource', on: true });
    if (m) return m;
  }
  // Turn down property offers made to us; a bot shouldn't sell its land on a whim.
  for (const o of view.offers ?? []) {
    if (o.to === seat) {
      const m = ok({ a: 'respond', offer: o.id, accept: false });
      if (m) return m;
    }
  }
  if (view.turn !== seat) return null;

  const cash = me.cash ?? 0;
  const reserve = CONFIG.startCompanyCash * 0.2;
  const mine = (z) => view.tiles.filter((t) => t && t.owner === seat && t.zone === z).length;

  if (view.phase === 'roll') return ok({ a: 'roll' }) ?? ok({ a: 'end' });

  if (view.phase === 'buy') {
    const sq = SQUARES[me.pos];
    if (sq && cash - sq.price >= reserve) {
      const row = view.zoningRow ?? [];
      // Factories first, then stores to sell their widgets, then rent.
      const want = mine('industrial') <= mine('retail') ? ['industrial', 'retail', 'residential', 'banking'] : ['retail', 'industrial', 'residential', 'banking'];
      const zone = sq.kind === 'land' && row.length ? Math.max(0, row.findIndex((z) => z === want.find((w) => row.includes(w)))) : undefined;
      const m = ok({ a: 'buy', ...(zone === undefined ? {} : { zone }) });
      if (m) return m;
    }
    return ok({ a: 'pass' }) ?? ok({ a: 'end' });
  }

  // Our turn, after the roll.
  if (me.sale) {
    const m = ok({ a: 'sell', option: 'clearance' });
    if (m) return m;
  }
  // Leave the island from its Terminal once we've made a lap, for the nearest airport.
  if (me.atTerminal && me.islandLaps > 0) {
    const airport = SQUARES.findIndex((s, i) => !s.island && s.kind === 'transport' && s.mode === 'air' && view.tiles[i]?.owner === seat);
    const to = airport >= 0 ? airport : SQUARES.findIndex((s) => !s.island && s.kind === 'transport' && s.mode === 'air');
    const m = ok({ a: 'fly', to });
    if (m) return m;
  }
  // Build the best PP&E we can afford on empty zoned land, keeping some cash back.
  const row = view.ppeRow ?? [];
  for (const [pos, t] of view.tiles.entries()) {
    if (!t || t.owner !== seat || !t.zone || t.building || SQUARES[pos].kind !== 'land') continue;
    const cards = row.map((r, card) => ({ card, price: RARITIES[r]?.price ?? Infinity }))
      .filter((c) => cash - c.price >= reserve)
      .sort((a, b) => b.price - a.price);
    for (const { card } of cards) {
      const m = ok({ a: 'build', pos, card });
      if (m) return m;
    }
  }
  // Spend spare personal cash on executive perks: they count toward the portfolio win.
  if (me.personalCash >= (me.personalPrice ?? CONFIG.personalAssetPrice)) {
    const m = ok({ a: 'personal' });
    if (m) return m;
  }
  return ok({ a: 'end' });
}

// Identifies one step of the game, so moves refused at that step can be remembered until it moves on.
export function stepKey(view) {
  return view ? `${view.turn}:${view.phase}:${view.log?.length ?? 0}` : '';
}
