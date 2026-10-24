// The moves a seat can make right now, as a plain list of buttons, for clients that don't carry
// their own copy of the rules (the Roblox game). Legality always comes from rules.js: every
// candidate move is tried on a copy of the game and kept only if act() accepts it, so a rule
// change on the web reaches Roblox without touching the Roblox code.
//
// Every action act() knows must appear in MOVES or WEB_ONLY; test/cfo-moves.test.js fails when a
// new action is added to rules.js without saying which, so it can't be missed on Roblox.
import { SQUARES, ZONES, RARITIES, RETAIL, SUPPLY, BOARD, HEDGES, PROFILES, PLANNED_MOVE, FRAUD_CARDS, MARKET_CARDS, MONEY_SCALE, CONFIG } from './data.js';
import { act, turnActions, ACCOUNTS, INCOME_FIELDS } from './rules.js';

// Where a parameter's values come from. Each returns the values to try for one seat.
const DOMAINS = {
  seat: (v, me) => v.players.map((p, i) => i).filter((i) => i !== me && !v.players[i].out),
  ownTile: (v, me) => v.tiles.map((t, pos) => (t?.owner === me ? pos : -1)).filter((pos) => pos >= 0),
  airport: () => SQUARES.map((s, pos) => (!s.island && s.kind === 'transport' && s.mode === 'air' ? pos : -1)).filter((pos) => pos >= 0),
  zoning: (v) => (v.zoningRow ?? []).map((_, i) => i),
  ppe: (v) => (v.ppeRow ?? []).map((_, i) => i),
  hand: (v, me) => (v.players[me].hand ?? []).map((_, i) => i),
  offerToMe: (v, me) => (v.offers ?? []).filter((o) => o.to === me).map((o) => o.id),
  contractToMe: (v, me) => (v.contractOffers ?? []).filter((o) => o.to === me).map((o) => o.id),
  myContract: (v, me) => (v.contracts ?? []).filter((k) => k.seller === me || k.buyer === me).map((k) => k.id),
  rarity: () => Object.keys(RARITIES),
  steps: () => range(PLANNED_MOVE.min, PLANNED_MOVE.max),
  yesNo: () => [true, false],
  yes: () => [true],
  sale: () => Object.keys(RETAIL.sales),
  boardOption: () => Object.keys(BOARD),
  hedge: () => Object.keys(HEDGES),
  profile: () => Object.keys(PROFILES),
  policy: () => ['straight', 'accelerated'],
  production: () => Object.keys(SUPPLY.levels),
  pricing: () => Object.keys(RETAIL.pricing),
};

// A parameter the player types: tried at a few sizes to see whether the move is open at all.
const AMOUNT = (v, me) => [1, 10, 100, 1000, 10000].map((n) => n * MONEY_SCALE).concat([v.players[me].cash ?? 0, v.players[me].personalCash ?? 0]).filter((n) => n > 0);
const COUNT = () => [1, 5, 25];

// Each action: `group` (where the client shows it), `variants` (which parameters, from which
// domain; 'amount' and 'count' are typed in), `label` and, for moves that can't be undone, `confirm`.
// A variant whose candidates all fail is simply not offered.
export const MOVES = {
  roll: { group: 'turn', variants: [{}, { steps: 'steps' }], label: (m) => (m.steps ? `Plan a move of ${m.steps}` : 'Roll the dice') },
  buy: { group: 'turn', variants: [{}, { zone: 'zoning' }], label: (m, c) => (m.zone !== undefined ? `Buy as ${c.zoning(m.zone)}` : `Buy ${c.here()}`) },
  pass: { group: 'turn', variants: [{}], label: () => 'Pass' },
  end: { group: 'turn', variants: [{}], label: () => 'End turn' },
  fly: { group: 'turn', variants: [{}, { to: 'airport' }], label: (m, c) => (m.to !== undefined ? `Fly to ${c.square(m.to)}` : 'Fly to the island') },
  sell: { group: 'turn', variants: [{}, { option: 'sale' }], label: (m) => (m.option ? `Sell: ${RETAIL.sales[m.option].name ?? m.option}` : 'Sell widgets') },
  settle: { group: 'turn', variants: [{}], label: () => 'Settle a fraud at Customs' },
  personal: { group: 'turn', variants: [{}], label: () => 'Buy an executive perk' },
  build: { group: 'property', variants: [{ pos: 'ownTile', card: 'ppe' }, { pos: 'ownTile', card: 'ppe', lease: 'yes' }], label: (m, c) => `${m.lease ? 'Lease' : 'Build'} ${c.ppe(m.card)} on ${c.square(m.pos)}` },
  rezone: { group: 'property', variants: [{ pos: 'ownTile', zone: 'zoning' }], label: (m, c) => `Rezone ${c.square(m.pos)} as ${c.zoning(m.zone)}`, confirm: true },
  board: { group: 'company', variants: [{ option: 'boardOption' }, { option: ['restructure'], pos: 'ownTile' }], label: (m, c) => `${BOARD[m.option].name}${m.pos !== undefined ? `: ${c.square(m.pos)}` : ''}` },
  production: { group: 'company', variants: [{ level: 'production' }], label: (m) => `Production: ${SUPPLY.levels[m.level].name}` },
  pricing: { group: 'company', variants: [{ level: 'pricing' }], label: (m) => `Prices: ${RETAIL.pricing[m.level].name}` },
  profile: { group: 'company', variants: [{ option: 'profile' }], label: (m) => `${PROFILES[m.option].name}: ${PROFILES[m.option].text}` },
  policy: { group: 'company', variants: [{ option: 'policy' }], label: (m) => (m.option === 'accelerated' ? 'Accelerated depreciation' : 'Straight-line depreciation'), confirm: true },
  hedge: { group: 'company', variants: [{ option: 'hedge' }], label: (m) => `Buy ${HEDGES[m.option].name.toLowerCase()}` },
  ipo: { group: 'company', variants: [{}], label: () => 'Go public (IPO)', confirm: true },
  invest: { group: 'money', variants: [{ amount: 'amount' }], label: () => 'Buy new shares with personal cash' },
  pay: { group: 'money', variants: [{ amount: 'amount' }], label: () => 'Pay yourself a bonus' },
  dividend: { group: 'money', variants: [{ amount: 'amount' }], label: () => 'Pay a dividend' },
  borrow: { group: 'money', variants: [{ amount: 'amount' }], label: () => 'Borrow from the Bank' },
  repay: { group: 'money', variants: [{ amount: 'amount' }], label: () => 'Repay the loan' },
  issue: { group: 'money', variants: [{ count: 'count' }], label: () => 'Sell new shares (count)' },
  trade: { group: 'market', variants: [{ target: 'seat', count: 'count' }, { target: 'seat', count: 'count', sign: -1 }], label: (m, c) => `${m.sign ? 'Sell' : 'Buy'} ${c.player(m.target)}'s shares (count)` },
  acquire: { group: 'market', variants: [{ target: 'seat' }], label: (m, c) => `Buy ${c.player(m.target)}'s company`, confirm: true },
  hire: { group: 'market', variants: [{ target: 'seat', amount: 'amount' }], label: (m, c) => `Fund a subsidiary for ${c.player(m.target)}` },
  play: {
    group: 'cards',
    variants: [{ card: 'hand' }, { card: 'hand', target: 'seat' }, { card: 'hand', pos: 'ownTile', rarity: 'rarity' }, { card: 'hand', pos: 'ownTile', row: 'ppe' }, { card: 'hand', amount: 'amount' }],
    label: (m, c) => `Play ${c.card(m.card)}${m.target !== undefined ? ` on ${c.player(m.target)}` : ''}${m.pos !== undefined ? ` at ${c.square(m.pos)}` : ''}${m.rarity ? ` (${RARITIES[m.rarity].name})` : ''}${m.row !== undefined ? ` (${c.ppe(m.row)})` : ''}`,
  },
  bid: { group: 'deals', variants: [{ amount: 'amount' }, { amount: 'amount', zone: 'zoning' }], label: (m, c) => `Bid at the auction${m.zone !== undefined ? ` (${c.zoning(m.zone)})` : ''}` },
  respond: { group: 'deals', variants: [{ offer: 'offerToMe', accept: 'yesNo' }], label: (m, c) => `${m.accept ? 'Accept' : 'Decline'} ${c.offer(m.offer)}` },
  sign: { group: 'deals', variants: [{ offer: 'contractToMe', accept: 'yesNo' }], label: (m, c) => `${m.accept ? 'Sign' : 'Decline'} ${c.contract(m.offer)}` },
  breach: { group: 'deals', variants: [{ offer: 'myContract' }], label: () => 'Break a supply contract', confirm: true },
  cancel: { group: 'deals', variants: [{}], label: () => 'Withdraw your offer' },
  resign: { group: 'game', variants: [{}], label: () => 'Resign', confirm: true },
};

// Actions the Roblox game makes from screens of its own rather than menu buttons: the books, and
// the forms in FORMS below.
export const SCREENS = {
  outsource: 'books',
  entry: 'books',
  unpost: 'books',
  archive: 'books',
  statements: 'books',
  offer: 'form',
  contract: 'form',
  plan: 'form',
};

// Actions Roblox players don't get yet, and why. Empty for now; a new web action can go here until
// the Roblox game has a way to make it.
export const WEB_ONLY = {};

// Forms with several fields, drawn by the Roblox game from these descriptions. Field kinds: tile
// (a square, picked on the board), seat (another player), money, count, toggle, and choice (one of
// `options`). Only `fields` with a value are sent, so optional ones can be left blank.
export const FORMS = {
  offer: {
    title: 'Property deal',
    help: 'Offer to sell one of your squares to another player, or to buy one of theirs. They can accept or decline.',
    submit: 'Make the offer',
    fields: [
      { key: 'pos', kind: 'tile', label: 'Square' },
      { key: 'target', kind: 'seat', label: 'Other player' },
      { key: 'amount', kind: 'money', label: 'Price' },
    ],
  },
  contract: {
    title: 'Supply contract',
    help: 'Offer to supply widgets to another company each turn, or to buy them from it, at a fixed price.',
    submit: 'Offer the contract',
    fields: [
      { key: 'target', kind: 'seat', label: 'Other company' },
      { key: 'sell', kind: 'toggle', label: 'I supply the widgets' },
      { key: 'count', kind: 'count', label: 'Widgets a turn' },
      { key: 'amount', kind: 'money', label: 'Price per widget' },
      { key: 'years', kind: 'count', label: 'Years' },
    ],
  },
  plan: {
    title: 'Board plan for next year',
    help: 'Sealed until the shared year end, then carried out: store prices, production, and a dividend.',
    submit: 'Seal the plan',
    fields: [
      { key: 'pricing', kind: 'choice', label: 'Store prices', options: Object.entries(RETAIL.pricing).map(([id, x]) => ({ id, name: x.name })) },
      { key: 'production', kind: 'choice', label: 'Production', options: Object.entries(SUPPLY.levels).map(([id, x]) => ({ id, name: x.name })) },
      { key: 'amount', kind: 'money', label: 'Dividend' },
    ],
  },
};

// The moves open to `seat`, each { id, label, group, action, input?, sign?, confirm? }. `view` is
// viewFor(game, seat). `input` says the client must add a typed `amount` or `count` to `action`.
export function movesFor(game, seat, view, { fresh = false } = {}) {
  const me = view.players[seat];
  if (!me || me.out || game.phase === 'over') return [];
  const c = labels(game, view, seat);
  const onTurn = new Set(turnActions());
  const legal = tester(game, seat, fresh);
  const out = [];
  const labelsSeen = new Set();
  for (const [a, spec] of Object.entries(MOVES)) {
    if (onTurn.has(a) && game.turn !== seat) continue; // act() refuses these off turn anyway
    const accepted = []; // the fixed parameters of moves already offered for this action
    for (const variant of spec.variants) {
      const { sign, ...params } = variant;
      const typed = Object.keys(params).find((k) => params[k] === 'amount' || params[k] === 'count');
      for (const fixed of product(Object.entries(params).filter(([k]) => k !== typed), view, seat)) {
        // A move that only adds parameters to one already offered is the same move.
        if (accepted.some((prev) => Object.keys(prev).every((k) => prev[k] === fixed[k]) && Object.keys(prev).length < Object.keys(fixed).length)) continue;
        const action = { a, ...fixed };
        const probes = !typed ? [null] : (params[typed] === 'amount' ? AMOUNT(view, seat) : COUNT()).map((n) => n * (sign ?? 1));
        if (!probes.some((n) => legal(n === null ? action : { ...action, [typed]: n }))) continue;
        if (!sign) accepted.push(fixed);
        let label;
        try {
          label = spec.label({ ...fixed, sign }, c);
        } catch {
          label = a;
        }
        if (labelsSeen.has(label)) continue; // e.g. two Common cards in the PP&E row
        labelsSeen.add(label);
        out.push({ id: out.length + 1, label, group: spec.group, action, ...(typed ? { input: typed } : {}), ...(sign ? { sign } : {}), ...(spec.confirm ? { confirm: true } : {}) });
      }
    }
  }
  return out;
}

// What a Roblox client needs to draw the game: much smaller than viewFor, and without anything the
// seat can't act on. Names are left as they are; the Roblox server masks web players' names.
export function slimView(game, seat, view) {
  const me = view.players[seat];
  return {
    turn: view.turn,
    phase: view.phase,
    dice: view.dice,
    winner: view.winner,
    endReason: view.endReason ?? null,
    year: view.calendar?.year ?? null,
    era: view.era?.name ?? null,
    log: view.log.slice(-30),
    tiles: view.tiles.map((t) => (t ? { owner: t.owner, zone: t.zone ?? null, rarity: t.building?.rarity ?? null, rent: t.rent ?? null } : null)),
    zoningRow: view.zoningRow ?? [],
    ppeRow: view.ppeRow ?? [],
    zoningLeft: view.zoningLeft,
    ppeLeft: view.ppeLeft,
    easyBooks: Boolean(view.easyBooks),
    players: view.players.map((p, i) => ({
      name: p.name,
      pos: p.pos,
      out: Boolean(p.out),
      skip: Boolean(p.skip),
      years: p.years,
      cash: p.cash,
      personalCash: p.personalCash,
      portfolio: p.portfolio,
      netWorth: p.netWorth,
      value: view.companyValues[i],
      isPublic: Boolean(p.isPublic),
      sharePrice: p.sharePrice,
      myShares: seat >= 0 ? p.shares?.holders?.[seat] ?? 0 : 0,
      totalShares: p.shares ? Object.values(p.shares.holders).reduce((a, b) => a + b, 0) + (p.shares.founders ?? 0) + p.shares.public : null,
      profile: p.profile ? PROFILES[p.profile]?.name ?? p.profile : null,
      hand: i === seat ? (p.hand ?? []).map((id) => cardName(id)) : undefined,
      frauds: i === seat ? p.frauds : undefined,
    })),
    books: me && !view.easyBooks && me.docs ? books(me) : null,
    offers: (view.offers ?? []).map((o) => ({ id: o.id, from: o.from, to: o.to, pos: o.pos, amount: o.amount })),
    forms: seat >= 0 && me && !me.out && view.phase !== 'over'
      ? ['offer', ...(view.modules?.markets ? ['contract'] : []), ...(view.calendar ? ['plan'] : [])]
      : [],
    moves: seat >= 0 ? movesFor(game, seat, view) : [],
  };
}

// A player's own books, for the Roblox journal screens.
function books(me) {
  return {
    outsourced: Boolean(me.outsourced),
    docs: me.docs,
    entries: me.entries ?? [],
    openYears: me.openYears ?? [],
    fyeDue: me.fyeDue ?? null,
    preview: me.preview ?? null,
    check: me.lastCheck ? checkText(me) : null,
  };
}

// The last review of the player's statements, in words, as the web page shows it.
function checkText(me) {
  const c = me.lastCheck;
  if (!c.errors) return { errors: 0, head: `Fiscal year ${c.year}: clean books. You earned the ${money(CONFIG.cleanBooksBonus)} bonus.`, lines: [] };
  const filed = me.filed ?? { income: {}, balance: {} };
  const label = (f) => ({ netIncome: 'Net income (loss)', totalAssets: 'Total assets', totalLiabilitiesAndEquity: 'Total liabilities and equity', accDep: 'Less accumulated depreciation' }[f] ?? ACCOUNTS[f] ?? f);
  const lines = (c.wrongFields ?? []).map((f) => {
    const kind = INCOME_FIELDS.includes(f) ? 'income' : 'balance';
    return `${label(f)}: you filed ${money(filed[kind]?.[f] ?? 0)}, correct ${money(c.truth?.[kind]?.[f] ?? 0)}`;
  });
  return { errors: c.errors, head: `Fiscal year ${c.year}: ${c.errors} misstatement${c.errors > 1 ? 's' : ''}, to be fined at your next Interim Review.`, lines };
}

// Tries moves on a copy of the game. A refused move leaves the game as it was (act() checks before
// it changes anything), so the copy is reused until a move succeeds; copying is most of the cost.
// test/cfo-moves.test.js checks the menu matches one built with a fresh copy for every try.
function tester(game, seat, fresh) {
  let scratch = null;
  return (action) => {
    scratch ??= structuredClone(game);
    let ok = false;
    try {
      ok = act(scratch, seat, action) === null;
    } catch {
      scratch = null;
    }
    if (ok || fresh) scratch = null;
    return ok;
  };
}

function* product(entries, view, seat) {
  if (!entries.length) {
    yield {};
    return;
  }
  const [[k, domain], ...rest] = entries;
  const values = Array.isArray(domain) ? domain : DOMAINS[domain]?.(view, seat) ?? [];
  for (const v of values) for (const tail of product(rest, view, seat)) yield { [k]: v, ...tail };
}

function labels(game, view, seat) {
  return {
    square: (pos) => SQUARES[pos]?.name ?? `square ${pos}`,
    here: () => SQUARES[view.players[seat]?.pos]?.name ?? 'this square',
    player: (i) => view.players[i]?.name ?? `player ${i + 1}`,
    zoning: (i) => ZONES[view.zoningRow?.[i]]?.name ?? 'zoning',
    ppe: (i) => RARITIES[view.ppeRow?.[i]]?.name ?? 'PP&E',
    card: (i) => cardName(view.players[seat]?.hand?.[i]),
    offer: (id) => {
      const o = (view.offers ?? []).find((x) => x.id === id);
      return o ? `${view.players[o.from]?.name}'s offer for ${SQUARES[o.pos]?.name} (${money(o.amount)})` : 'the offer';
    },
    contract: (id) => {
      const o = (view.contractOffers ?? []).find((x) => x.id === id);
      return o ? `${view.players[o.from]?.name}'s supply contract (${o.units} a turn at $${o.price})` : 'the contract';
    },
  };
}

function cardName(id) {
  return FRAUD_CARDS[id]?.name ?? MARKET_CARDS[id]?.name ?? String(id ?? 'a card');
}

function money(n) {
  return `$${Math.round(n ?? 0).toLocaleString('en-US')}`;
}

function range(a, b) {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}
