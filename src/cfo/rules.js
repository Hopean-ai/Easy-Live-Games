// CFO rules as pure functions over a plain JSON game state, so the room can store the state as is
// and tests can play whole games without a server. All randomness comes from a seeded generator
// kept in the state.
//
// Each company keeps real double-entry books: every movement of company cash is a journal entry,
// and the income statement and balance sheet are read off the ledger. Personal cash and personal
// assets sit outside the company, as they would for a real owner.
import {
  CONFIG, M, BOARD_SIZE, SQUARES, ISLAND_START, LANDMARKS, onIsland, nextPos, SETS, MODES, ZONES, RARITIES, TRANSPORT_RENT, RETAIL, SUPPLY,
  FRAUD_CARDS, MARKET_CARDS, PERSONAL_CARDS, deckOf,
} from './data.js';

export const ACCOUNTS = {
  cash: 'Cash',
  inventory: 'Inventory (widgets)',
  land: 'Land',
  ppe: 'PP&E',
  accDep: 'Accumulated depreciation',
  investments: 'Investment in subsidiaries',
  goodwill: 'Goodwill',
  loan: 'Bank loan',
  affiliateLoan: 'Due to affiliate',
  capital: 'Contributed capital',
  retained: 'Retained earnings',
  draws: 'Owner distributions',
  revSales: 'Widget sales',
  cogs: 'Cost of widgets sold',
  revRent: 'Rent revenue',
  revInterest: 'Interest revenue',
  revFreight: 'Freight revenue',
  revDividends: 'Dividend income',
  revOps: 'Operating revenue',
  revOther: 'Other revenue',
  gain: 'Gain (loss) on asset sales',
  expRent: 'Rent expense',
  expSalary: 'Salaries',
  expDep: 'Depreciation expense',
  expFreight: 'Freight expense',
  expOther: 'Other expenses',
  expInterest: 'Interest expense',
  expTax: 'Income tax expense',
};
const TEMPORARY = ['revSales', 'cogs', 'revInterest', 'revFreight', 'revDividends', 'expFreight', 'revRent', 'revOps', 'revOther', 'gain', 'expRent', 'expSalary', 'expDep', 'expOther', 'expInterest', 'expTax', 'draws'];
const LOG_SIZE = 40;
const JOURNAL_SIZE = 60;

// ---- Setup ----

// By default (as Miles wants) players record their own entries and fill in their own statements
// at each fiscal year end, checked against the true books kept here.
// options.autoStatements: players still record every entry, but their statements are generated
// from what they recorded, so journal mistakes flow through (Miles's choice for the easier mode).
// options.easyBooks: the game records every entry and prepares the statements itself. Rooms no
// longer offer it (Miles: no); tests and simulations use it to play fast.
export function createGame(names, seed = (Math.random() * 2 ** 32) >>> 0, options = {}) {
  if (names.length < CONFIG.minPlayers || names.length > CONFIG.maxPlayers) throw new Error('bad player count');
  const g = {
    seed: seed >>> 0,
    // What a widget goes into inventory at. Games begun before factory overhead keep $1 widgets.
    widgetCost: ZONES.industrial.variableCost + ZONES.industrial.overhead,
    turn: 0,
    phase: 'roll', // roll | buy | act | over
    dice: null,
    players: [],
    tiles: SQUARES.map((sq) => (sq.kind === 'land' || sq.kind === 'transport' ? { owner: null, zone: null, building: null, stock: 0 } : null)),
    zoningDeck: [],
    zoningRow: [],
    ppeDeck: [],
    ppeRow: [],
    fraudDeck: [],
    fraudDiscard: deckOf(FRAUD_CARDS),
    marketDeck: [],
    marketDiscard: deckOf(MARKET_CARDS),
    log: [],
    winner: null,
    endReason: null,
    easyBooks: Boolean(options.easyBooks),
    autoStatements: !options.easyBooks, // Miles: statements are always built from your own entries
    win: winOptions(options),
    second: null,
  };
  g.zoningDeck = shuffle(g, Object.entries(ZONES).flatMap(([id, z]) => Array(z.count).fill(id)));
  g.ppeDeck = shuffle(g, Object.entries(RARITIES).flatMap(([id, r]) => Array(r.count).fill(id)));
  refill(g.zoningRow, g.zoningDeck);
  refill(g.ppeRow, g.ppeDeck, CONFIG.ppeRowSize);

  // Player i is seat i; the room decides the seating order.
  for (const name of names) {
    const p = {
      name, pos: 0, out: false, skip: false, years: 0,
      ledger: Object.fromEntries(Object.keys(ACCOUNTS).map((a) => [a, 0])),
      journal: [], report: null,
      carried: 0, // widgets with nowhere to sit (a sold building's stock); the rest sit in factories and stores
      personalCash: CONFIG.startPersonalCash, assets: [], hand: [],
      frauds: 0, taxWaived: false, deduction: 0,
      // Shares in this player's company: who holds how many. Everyone starts owning all 100 of theirs.
      shares: { holders: { [g.players.length]: 100 }, public: 0 }, isPublic: false, parent: null,
      manual: !g.easyBooks, docs: [], docSeq: 0, bookLedger: Object.fromEntries(Object.keys(ACCOUNTS).map((a) => [a, 0])), fyePending: null, lastCheck: null, filed: null, misstatements: 0,
    };
    g.players.push(p);
    // Later seats can start with a little more, to offset going first.
    const capital = CONFIG.startCompanyCash + (g.players.length - 1) * CONFIG.seatBonus;
    post(p, 'Owner invests starting capital', { cash: capital, capital: -capital });
  }
  for (const p of g.players) snapshot(g, p, 0);
  log(g, `${g.players[0].name} goes first.`);
  return g;
}

// The room's win settings, with anything missing or out of range set to its default.
export function winOptions(o = {}) {
  const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Math.round(Number(v)) : d);
  return {
    valueTarget: num(o.valueTarget, M(5000), M(1_000_000), CONFIG.valueTarget),
    maxYears: num(o.maxYears, 0, 50, CONFIG.maxYears),
  };
}

// ---- Random ----

function rand(g) {
  g.seed = (g.seed + 0x6d2b79f5) >>> 0;
  let t = g.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function shuffle(g, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand(g) * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function refill(row, deck, size = CONFIG.rowSize) {
  while (row.length < size && deck.length) row.push(deck.pop());
}

function drawFrom(g, deckKey, discardKey) {
  if (!g[deckKey].length) g[deckKey] = shuffle(g, g[discardKey].splice(0));
  return g[deckKey].pop() ?? null;
}

// ---- Books ----

// Posts a balanced journal entry; positive amounts are debits, negative are credits. With manual
// books it also hands the player a source document to record the entry from themselves.
export function post(p, text, lines, { doc = true } = {}) {
  let sum = 0;
  for (const [acct, amt] of Object.entries(lines)) {
    if (!(acct in ACCOUNTS) || !Number.isFinite(amt)) throw new Error(`bad journal line ${acct}`);
    sum += amt;
  }
  if (Math.abs(sum) > 1e-6) throw new Error(`unbalanced entry: ${text}`);
  for (const [acct, amt] of Object.entries(lines)) p.ledger[acct] = round((p.ledger[acct] ?? 0) + amt);
  if (lines.loan) p.peakLoan = Math.max(p.peakLoan ?? 0, -p.ledger.loan); // for the year's interest
  const entry = Object.entries(lines).map(([a, v]) => [a, round(v)]).filter(([, v]) => v !== 0);
  p.journal.push({ text, lines: entry });
  if (p.journal.length > JOURNAL_SIZE) p.journal.shift();
  if (p.manual && doc) {
    p.docSeq += 1;
    p.docs.push({ id: p.docSeq, text: describe(text, entry), year: p.years + 1, lines: entry, recorded: null });
  }
}

// A source document says what happened and how much cash moved, not which accounts to use.
function describe(text, entry) {
  const cash = entry.find(([a]) => a === 'cash')?.[1];
  if (cash > 0) return `${text}: ${money(cash)} received`;
  if (cash < 0) return `${text}: ${money(-cash)} paid`;
  const amount = entry.filter(([, v]) => v > 0).reduce((n, [, v]) => n + v, 0);
  return `${text}: ${money(amount)}`;
}

const round = (n) => Math.round(n * 100) / 100 || 0; // never -0
const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

export function companyCash(p) {
  return p.ledger.cash;
}

export function incomeStatement(p) {
  const l = p.ledger;
  const revenue = { revSales: -l.revSales, revRent: -l.revRent, revInterest: -l.revInterest, revFreight: -l.revFreight, revDividends: -l.revDividends, revOps: -l.revOps, revOther: -l.revOther, gain: -l.gain };
  const expenses = { cogs: l.cogs, expFreight: l.expFreight, expRent: l.expRent, expSalary: l.expSalary ?? 0, expDep: l.expDep, expInterest: l.expInterest, expOther: l.expOther };
  const totalRevenue = sum(Object.values(revenue));
  const totalExpenses = sum(Object.values(expenses));
  const preTax = totalRevenue - totalExpenses;
  return { revenue, expenses, totalRevenue, totalExpenses, preTax, tax: l.expTax, netIncome: preTax - l.expTax };
}

export function balanceSheet(p) {
  const l = p.ledger;
  const net = incomeStatement(p).netIncome;
  const assets = { cash: l.cash, inventory: l.inventory, land: l.land, ppe: l.ppe, accDep: l.accDep, investments: l.investments, goodwill: l.goodwill };
  const liabilities = { loan: -l.loan || 0, affiliateLoan: -l.affiliateLoan || 0 };
  const equity = { capital: -l.capital, retained: -l.retained, netIncome: net, draws: -l.draws };
  const totalLiabilities = sum(Object.values(liabilities));
  const totalEquity = sum(Object.values(equity));
  return {
    assets, liabilities, equity,
    totalAssets: sum(Object.values(assets)), totalLiabilities, totalEquity, totalLiabilitiesAndEquity: round(totalLiabilities + totalEquity),
  };
}

const sum = (xs) => round(xs.reduce((a, b) => a + b, 0));

export function portfolio(p) {
  return p.assets.reduce((v, id) => v + PERSONAL_CARDS[id].value, 0);
}

// ---- Shares ----
// Miles: going public raises cash and counts toward winning (the market values a public company
// above its books), but brings tighter fraud scrutiny. Subsidiaries are part-owned by a parent.

export function totalShares(p) {
  return Object.values(p.shares.holders).reduce((a, b) => a + b, 0) + p.shares.public;
}

// What the market pays for the whole company.
export function companyValue(p) {
  return Math.max(0, balanceSheet(p).totalEquity) * (p.isPublic ? CONFIG.publicPremium : 1);
}

export function sharePrice(p) {
  return round(companyValue(p) / totalShares(p));
}

// Shares change hands with personal cash: buyers pay the market price rounded up to the cent,
// sellers get it rounded down.
export function tradePrice(p) {
  return sharePrice(p);
}

function tradeTotal(price, count) {
  const exact = price * Math.abs(count);
  return (count > 0 ? Math.ceil(exact / CONFIG.personalUnit) : Math.floor(exact / CONFIG.personalUnit + 1e-9)) * CONFIG.personalUnit;
}

// A subsidiary's parent holds its shares in the company, which shows on the parent's own books.
export function netWorth(g, p) {
  const idx = g.players.indexOf(p);
  let worth = p.personalCash + portfolio(p);
  for (const c of g.players) {
    const held = c.parent === idx ? 0 : (c.shares.holders[idx] ?? 0);
    if (held && !c.out) worth += (companyValue(c) * held) / totalShares(c);
  }
  return round(worth);
}

// How hard auditors look: public companies and convicted managers get caught and fined more.
function scrutiny(p) {
  return (p.isPublic ? CONFIG.publicScrutiny : 1) * (p.convicted ? CONFIG.publicScrutiny : 1);
}

// ---- Turn flow ----

export function current(g) {
  return g.players[g.turn];
}

// Actions come straight from browsers, so keep only the fields actions use, with the right types.
// Names are looked up as own keys, so 'constructor' or '__proto__' can't reach object internals.
const INT_FIELDS = ['card', 'row', 'zone', 'pos', 'target', 'to', 'count', 'doc', 'offer'];
const MAX_AMOUNT = 1e9;
function cleanAction(action) {
  if (!action || typeof action !== 'object' || typeof action.a !== 'string') return null;
  const out = { a: action.a };
  for (const f of INT_FIELDS) if (Number.isInteger(action[f]) && Math.abs(action[f]) <= MAX_AMOUNT) out[f] = action[f];
  if (Number.isFinite(action.amount) && Math.abs(action.amount) <= MAX_AMOUNT) out.amount = action.amount;
  if (typeof action.option === 'string' && Object.hasOwn(RETAIL.sales, action.option)) out.option = action.option;
  if (typeof action.rarity === 'string' && Object.hasOwn(RARITIES, action.rarity)) out.rarity = action.rarity;
  if (Array.isArray(action.lines)) out.lines = action.lines;
  if (typeof action.on === 'boolean') out.on = action.on;
  if (typeof action.accept === 'boolean') out.accept = action.accept;
  if (typeof action.level === 'string' && (Object.hasOwn(SUPPLY.levels, action.level) || Object.hasOwn(RETAIL.pricing, action.level))) out.level = action.level;
  for (const k of ['income', 'balance']) {
    const src = action[k];
    if (!src || typeof src !== 'object') continue;
    out[k] = {};
    for (const f of k === 'income' ? INCOME_FIELDS : BALANCE_FIELDS) {
      const v = Number(src[f]);
      if (Number.isFinite(v) && Math.abs(v) <= MAX_AMOUNT) out[k][f] = v;
    }
  }
  return out;
}

// Applies one player action. Returns null on success or a short error for that player.
// Games saved before an account existed get it at zero, so their books keep adding up.
function upgrade(g) {
  for (const p of g.players) {
    for (const a of Object.keys(ACCOUNTS)) {
      p.ledger[a] ??= 0;
      if (p.bookLedger) p.bookLedger[a] ??= 0;
    }
  }
  // Games begun with typed statements switch to statements built from entries. Their books so far
  // are the true ledger without the documents not yet filed, closed into retained earnings.
  if (!g.easyBooks && !g.autoStatements) {
    g.autoStatements = true;
    for (const p of g.players) {
      const book = { ...p.ledger };
      for (const d of p.docs ?? []) for (const [a, v] of d.lines) book[a] = round(book[a] - v);
      for (const a of TEMPORARY) {
        book.retained = round(book.retained + book[a]);
        book[a] = 0;
      }
      p.bookLedger = book;
    }
  }
}

export function act(g, who, raw) {
  upgrade(g);
  if (g.phase === 'over') return 'The game is over.';
  const p = g.players[who];
  if (!p || p.out) return 'You are not in this game.';
  const action = cleanAction(raw);
  if (!action) return 'Unknown action.';
  if (action.a === 'resign') {
    bankrupt(g, p, `${p.name} resigns.`);
    afterAction(g);
    return null;
  }
  // Miles: a production dial, which a company can turn at any time.
  // Miles: a pricing dial for the company's stores, also turned at any time.
  if (action.a === 'pricing') {
    if (!Object.hasOwn(RETAIL.pricing, action.level ?? '')) return 'Pick a price level.';
    p.pricing = action.level;
    log(g, `${p.name} sets ${RETAIL.pricing[action.level].name.toLowerCase()} at their stores.`);
    return null;
  }
  // The owner puts personal cash into the company as more capital, at any time.
  if (action.a === 'invest') {
    const amount = Math.floor(Number(action.amount) * 100) / 100;
    if (!(amount > 0)) return 'Enter an amount.';
    if (p.parent !== null) return 'Your company is a subsidiary; its parent company funds it.';
    if (amount > p.personalCash) return 'You do not have that much personal cash.';
    p.personalCash = round(p.personalCash - amount);
    post(p, 'Owner invests more capital', { cash: amount, capital: -amount });
    log(g, `${p.name} invests ${money(amount)} of their own money in their company.`);
    afterAction(g);
    return null;
  }
  if (action.a === 'production') {
    if (!Object.hasOwn(SUPPLY.levels, action.level ?? '')) return 'Pick a production level.';
    p.production = action.level;
    log(g, `${p.name} sets production to ${SUPPLY.levels[action.level].name.toLowerCase()}.`);
    return null;
  }
  if (Object.hasOwn(BOOKS, action.a) || Object.hasOwn(DEALS, action.a)) {
    const err = (BOOKS[action.a] ?? DEALS[action.a])(g, p, action);
    if (!err) afterAction(g); // a clean-books bonus can reach the value target
    return err ?? null;
  }
  if (g.turn !== who) return 'It is not your turn.';
  if (!Object.hasOwn(ACTIONS, action.a)) return 'Unknown action.';
  const handler = ACTIONS[action.a];
  const err = handler(g, p, action);
  if (!err) afterAction(g);
  return err ?? null;
}

// The turn timer ran out: do the least surprising thing for an absent player.
export function timeout(g) {
  if (g.phase === 'over') return;
  const p = current(g);
  // Their books are kept for them, so fines don't bankrupt someone who has only stepped away.
  if (p.manual) {
    for (const d of p.docs) d.recorded ??= d.lines;
    if (p.fyePending) BOOKS.statements(g, p, p.fyePending.truth);
  }
  if (g.phase === 'roll') ACTIONS.roll(g, p);
  if (g.phase === 'buy') ACTIONS.pass(g, p);
  if (g.phase === 'act') {
    ACTIONS.end(g, p);
  }
  afterAction(g);
}

const ACTIONS = {
  roll(g, p) {
    if (g.phase !== 'roll') return 'You have already rolled.';
    p.atBank = false;
    p.atTerminal = false;
    p.atExchange = false;
    p.personalOffer = 0;
    p.atCustoms = false;
    p.flew = false;
    p.sale = null;
    const d = [1 + Math.floor(rand(g) * 6), 1 + Math.floor(rand(g) * 6)];
    g.dice = d;
    log(g, `${p.name} rolls ${d[0]} + ${d[1]}.`);
    if (d[0] === d[1] && p.assets.includes('horses') && !p.raced) {
      p.raced = true;
      const prize = p.assets.filter((x) => x === 'horses').length * PERSONAL_CARDS.horses.prize;
      p.personalCash += prize;
      log(g, `${p.name}'s horses win ${money(prize)} at the races.`);
    }
    // Step square by square: widgets are picked up, dropped off and shipped along the way.
    for (let i = 0; i < d[0] + d[1] && !p.out; i++) {
      p.pos = nextPos(p.pos);
      if (p.pos === 0) fiscalYearEnd(g, p);
      if (p.pos === ISLAND_START) {
        // Passing or landing on the island's Terminal completes a lap and offers a flight home.
        // It also closes the fiscal year, so a company stuck on the island still keeps its books.
        p.islandLaps = (p.islandLaps ?? 0) + 1;
        p.atTerminal = true;
        log(g, `${p.name} completes a lap of the island.`);
        const houses = p.assets.filter((a) => a === 'beach').length;
        if (houses) {
          p.personalCash += houses * PERSONAL_CARDS.beach.lap;
          log(g, `${p.name} collects ${money(houses * PERSONAL_CARDS.beach.lap)} renting out beach houses.`);
        }
        fiscalYearEnd(g, p);
      }
      if (!p.out) visit(g, p, p.pos, i === d[0] + d[1] - 1);
    }
    g.phase = 'act';
    if (!p.out && g.phase !== 'over') land(g, p);
    return null;
  },

  buy(g, p, { zone } = {}) {
    if (g.phase !== 'buy') return 'There is nothing to buy.';
    const sq = SQUARES[p.pos];
    const tile = g.tiles[p.pos];
    if (sq.landmark) return buyLandmark(g, p, sq, tile);
    if (companyCash(p) < sq.price) return 'Your company cannot afford it.';
    let zoneId = null;
    if (sq.kind === 'land' && g.zoningRow.length) {
      if (!Number.isInteger(zone) || !g.zoningRow[zone]) return 'Pick a zoning card.';
      zoneId = g.zoningRow.splice(zone, 1)[0];
      refill(g.zoningRow, g.zoningDeck);
    }
    if (sq.kind === 'transport') {
      // The price covers the land and the structures on it, which are PP&E and depreciate.
      const land = transportLand(p.pos);
      const ppe = sq.price - land;
      post(p, `Bought ${sq.name}: ${money(land)} land, ${money(ppe)} PP&E`, { land, ppe, cash: -sq.price });
      Object.assign(tile, { landBasis: land, building: { rarity: 'transport', cost: ppe, basis: ppe, dep: 0 } });
    } else {
      post(p, `Bought ${sq.name}`, { land: sq.price, cash: -sq.price });
    }
    tile.owner = g.turn;
    tile.zone = zoneId;
    g.phase = 'act';
    log(g, `${p.name} buys ${sq.name} for ${money(sq.price)}${zoneId ? `, zoned ${ZONES[zoneId].name}` : ''}.`);
    return null;
  },

  // Fly to the island from an owned airport you landed on, or home from the island's Terminal
  // to any airport (`to`). The fare goes to the airport's owner; your own airport flies you free.
  fly(g, p, { to } = {}) {
    if (g.phase !== 'act') return 'Finish landing first.';
    if (p.flew) return 'You have already flown this turn.';
    const home = onIsland(p.pos);
    const airport = home ? to : p.pos;
    if (home && !p.atTerminal) return 'Flights leave the island from its Terminal.';
    if (SQUARES[airport]?.kind !== 'transport' || SQUARES[airport].mode !== 'air') return 'Pick an airport.';
    const owner = g.tiles[airport].owner;
    if (!home && owner === null) return 'Nobody runs flights from this airport yet.';
    if (owner !== null && owner !== g.turn) {
      if (companyCash(p) < CONFIG.islandFare) return `The fare is ${money(CONFIG.islandFare)}.`;
      const fare = charge(g, p, CONFIG.islandFare, 'expFreight', `Airfare on ${g.players[owner].name}'s ${SQUARES[airport].name}`);
      post(g.players[owner], `Airfare from ${p.name}`, { cash: fare, revFreight: -fare });
    } else if (owner === null) {
      if (companyCash(p) < CONFIG.islandFare) return `The fare is ${money(CONFIG.islandFare)}.`;
      charge(g, p, CONFIG.islandFare, 'expFreight', 'Airfare');
    }
    p.flew = true;
    p.atTerminal = false;
    p.sale = null;
    if (home) {
      p.pos = airport;
      log(g, `${p.name} flies home to ${SQUARES[airport].name}.`);
      visit(g, p, airport);
    } else {
      p.pos = ISLAND_START;
      log(g, `${p.name} flies to the island.`);
      visit(g, p, ISLAND_START);
    }
    return null;
  },

  pass(g, p) {
    if (g.phase !== 'buy') return 'There is nothing to pass on.';
    g.phase = 'act';
    return null;
  },

  // Builds on empty zoned land, or upgrades PP&E already there (Miles): the old building is
  // destroyed for its salvage value, which goes toward the new one.
  build(g, p, { pos, card } = {}) {
    if (g.phase !== 'act') return 'Roll first.';
    const upgrade = Boolean(g.tiles[pos]?.building);
    const err = upgrade ? canUpgrade(g, pos) : canBuild(g, pos);
    if (err) return err;
    // Cards past the face-up row are the private extras that Banking buildings show you.
    const extras = bankOptions(g, g.turn);
    const fromRow = card < g.ppeRow.length;
    const rarity = fromRow ? g.ppeRow[card] : extras[card - g.ppeRow.length];
    if (!Number.isInteger(card) || card < 0 || !rarity) return 'Pick a PP&E card.';
    const price = RARITIES[rarity].price;
    const old = g.tiles[pos].building;
    if (upgrade && price <= old.cost) return `An upgrade must cost more than the ${money(old.cost)} PP&E there now.`;
    if (companyCash(p) + (upgrade ? salvageValue(old) : 0) < price) return 'Your company cannot afford it.';
    if (upgrade) scrapBuilding(g, p, g.tiles[pos], pos, 'upgrade');
    if (fromRow) {
      g.ppeRow.splice(card, 1);
      refill(g.ppeRow, g.ppeDeck, CONFIG.ppeRowSize);
    } else {
      g.ppeDeck.splice(g.ppeDeck.length - 1 - (card - g.ppeRow.length), 1);
    }
    putBuilding(g, p, pos, rarity, price);
    return null;
  },

  // Miles: rezoning swaps the land's zoning for a face-up zoning card, for a fee. Any PP&E on it
  // is destroyed for its salvage value and has to be rebuilt.
  rezone(g, p, { pos, zone } = {}) {
    if (g.phase !== 'act') return 'Roll first.';
    const t = g.tiles[pos];
    if (!t || t.owner !== g.turn || SQUARES[pos].kind !== 'land') return 'Rezone land you own.';
    if (SQUARES[pos].landmark) return 'Landmarks keep their zoning.';
    if (!Number.isInteger(zone) || !g.zoningRow[zone]) return 'Pick a zoning card.';
    if (g.zoningRow[zone] === t.zone) return `It is already zoned ${ZONES[t.zone].name}.`;
    const fee = rezoneFee(pos);
    if (companyCash(p) + (t.building ? salvageValue(t.building) : 0) < fee) return 'Your company cannot afford the fee.';
    if (t.building) scrapBuilding(g, p, t, pos, 'rezoning');
    // Miles: the fee makes the land more useful, so it's capitalized into the land's cost.
    post(p, `Rezoning fee for ${SQUARES[pos].name}`, { land: fee, cash: -fee });
    t.landBasis = (t.landBasis ?? SQUARES[pos].price) + fee;
    const was = t.zone;
    returnZoning(g, t);
    t.zone = g.zoningRow.splice(zone, 1)[0];
    refill(g.zoningRow, g.zoningDeck);
    log(g, `${p.name} rezones ${SQUARES[pos].name}${was ? ` from ${ZONES[was].name}` : ''} to ${ZONES[t.zone].name} for ${money(fee)}.`);
    return null;
  },

  // Pay yourself: company cash becomes personal cash, less personal tax.
  pay(g, p, { amount } = {}) {
    if (g.phase === 'buy') return 'Buy or pass first.';
    amount = Math.floor(Number(amount));
    if (!(amount > 0)) return 'Enter an amount.';
    if (amount > companyCash(p)) return 'Your company does not have that much cash.';
    post(p, 'Owner distribution', { draws: amount, cash: -amount });
    // Every shareholder gets their share of a distribution. A parent company's share goes to its
    // books as dividend income; people's shares are taxed; the public's share leaves the game.
    const total = totalShares(p);
    for (const [h, n] of Object.entries(p.shares.holders)) {
      const q = g.players[h];
      const part = Math.floor((amount * n) / total / CONFIG.personalUnit) * CONFIG.personalUnit;
      if (!part || q.out) continue;
      if (Number(h) === p.parent) {
        post(q, `Dividend from ${p.name}`, { cash: part, revDividends: -part });
        log(g, `${q.name}'s company receives a ${money(part)} dividend from ${p.name}.`);
      } else {
        const tax = personalIncome(q, part);
        log(g, `${q.name} receives ${money(part)} from ${p.name}'s company (${money(tax)} personal tax).`);
      }
    }
    return null;
  },

  // Sell new shares to the public. The company keeps the cash.
  ipo(g, p) {
    if (g.phase === 'buy') return 'Buy or pass first.';
    if (p.isPublic) return 'Your company is already public.';
    if (p.parent !== null) return 'A subsidiary cannot go public.';
    if (p.years < CONFIG.ipoYears) return `You need ${CONFIG.ipoYears} fiscal years of history to go public.`;
    if (balanceSheet(p).totalEquity <= 0) return 'Investors will not buy into a company with no equity.';
    // Miles: realism. As with the SEC, investors want clean statements before a listing.
    if (p.manual && (p.misstatements || p.lastCheck?.errors)) return 'Investors want clean statements first: your last filing had misstatements.';
    const price = round((balanceSheet(p).totalEquity * CONFIG.publicPremium) / totalShares(p));
    const raised = Math.round(price * CONFIG.ipoShares);
    p.shares.public += CONFIG.ipoShares;
    p.isPublic = true;
    post(p, `Initial public offering of ${CONFIG.ipoShares} shares`, { cash: raised, capital: -raised });
    log(g, `${p.name}'s company goes public, selling ${CONFIG.ipoShares} shares at ${money(price)} for ${money(raised)}.`);
    return null;
  },

  // Buy or sell shares of a public company on the market, with personal cash.
  trade(g, p, { target, count } = {}) {
    if (g.phase === 'buy') return 'Buy or pass first.';
    const c = g.players[target];
    if (!c || c.out || !c.isPublic) return 'Pick a public company.';
    count = Math.trunc(Number(count));
    if (!count) return 'Enter how many shares.';
    const me = String(g.players.indexOf(p));
    const price = tradePrice(c);
    const total = tradeTotal(price, count);
    if (count > 0) {
      if (count > c.shares.public) return `Only ${c.shares.public} shares are on the market.`;
      if (total > p.personalCash) return 'You do not have enough personal cash.';
      p.personalCash -= total;
      c.shares.public -= count;
      c.shares.holders[me] = (c.shares.holders[me] ?? 0) + count;
      log(g, `${p.name} buys ${count} shares of ${c.name}'s company for ${money(total)}.`);
    } else {
      if (-count > (c.shares.holders[me] ?? 0)) return 'You do not hold that many shares.';
      if (c.shares.holders[me] + count <= 0 && c === p) return 'You cannot sell all of your own company.';
      if (!total) return `Those shares are worth less than ${money(CONFIG.personalUnit)} together.`;
      p.personalCash += total;
      c.shares.public += -count;
      c.shares.holders[me] += count;
      if (!c.shares.holders[me]) delete c.shares.holders[me];
      log(g, `${p.name} sells ${-count} shares of ${c.name}'s company for ${money(total)}.`);
    }
    return null;
  },

  // Miles: in a 3+ player game, someone knocked out early can be hired to run a subsidiary.
  // Miles: while a rival's company still exists, you can buy it outright to take them out of the
  // game. The price is its market value plus a premium, so a public company (valued at a
  // multiple of its books) costs more. Its shareholders are paid in personal cash, the public's
  // shares are bought back, and its business (land, buildings, cash, debts) joins yours.
  acquire(g, p, { target } = {}) {
    if (g.phase === 'buy') return 'Buy or pass first.';
    const q = g.players[target];
    if (p.parent !== null) return 'A subsidiary cannot buy other companies.';
    if (!q || q === p || q.out || q.parent !== null) return 'Pick a rival independent company.';
    const price = acquisitionPrice(q);
    if (companyCash(p) < price) return `Buying ${q.name}'s company costs ${money(price)}.`;
    acquireCompany(g, p, q, price);
    return null;
  },

  hire(g, p, { target, amount } = {}) {
    if (g.phase === 'buy') return 'Buy or pass first.';
    if (g.players.length < 3) return 'Subsidiaries need a game of three or more.';
    if (p.parent !== null) return 'A subsidiary cannot hire its own subsidiary.';
    const q = g.players[target];
    if (!q || !q.out) return 'Pick a player who is out of the game.';
    amount = Math.floor(Number(amount));
    if (!(amount >= CONFIG.subsidiaryMin) || amount % CONFIG.personalUnit) return `Fund it with at least ${money(CONFIG.subsidiaryMin)}.`;
    if (amount > companyCash(p)) return 'Your company does not have that much cash.';
    const parent = g.players.indexOf(p);
    post(p, `Invested in ${q.name}'s new subsidiary`, { investments: amount, cash: -amount });
    restart(g, q, parent, amount);
    q.invested = amount;
    log(g, `${p.name} hires ${q.name} to run a subsidiary with ${money(amount)} of capital.`);
    return null;
  },

  personal(g, p) {
    if (g.phase === 'buy') return 'Buy or pass first.';
    const price = personalPrice(p);
    if (p.personalCash < price) return `You need ${money(price)} of personal cash.`;
    p.personalCash -= price;
    p.personalOffer = 0;
    gainPersonal(g, p, drawPersonal(g), 'buys');
    return null;
  },

  play(g, p, msg = {}) {
    if (g.phase === 'buy') return 'Buy or pass first.';
    const id = Number.isInteger(msg.card) ? p.hand[msg.card] : undefined;
    if (!id || !Object.hasOwn(PLAYS, id)) return 'Pick a card from your hand.';
    const err = PLAYS[id](g, p, msg);
    if (err) return err;
    p.hand.splice(msg.card, 1);
    if (FRAUD_CARDS[id]) {
      p.frauds += 1;
      g.fraudDiscard.push(id);
    } else {
      g.marketDiscard.push(id);
    }
    return null;
  },

  // Miles: a few scarce ways to clear a fraud. At island Customs you can quietly settle one.
  settle(g, p) {
    if (g.phase !== 'act' || !p.atCustoms) return 'You can only settle at island Customs.';
    if (!p.frauds) return 'You have no frauds to settle.';
    if (companyCash(p) < CONFIG.settlement) return `Settling costs ${money(CONFIG.settlement)}.`;
    post(p, 'Legal settlement', { expOther: CONFIG.settlement, cash: -CONFIG.settlement });
    p.frauds -= 1;
    p.atCustoms = false;
    log(g, `${p.name} pays ${money(CONFIG.settlement)} in legal fees at Customs.`);
    return null;
  },

  // Only on a turn that ended at the Bank.
  borrow(g, p, { amount } = {}) {
    if (g.phase !== 'act' || !p.atBank) return 'You can only borrow at the Bank.';
    amount = Math.floor(Number(amount));
    const room = CONFIG.loanLimit + p.ledger.loan; // loan is a credit balance
    if (!(amount > 0)) return 'Enter an amount.';
    if (amount > room) return `The Bank will lend at most ${money(room)} more.`;
    post(p, 'Bank loan', { cash: amount, loan: -amount });
    log(g, `${p.name} borrows ${money(amount)} from the Bank.`);
    return null;
  },

  repay(g, p, { amount } = {}) {
    if (g.phase === 'buy') return 'Buy or pass first.';
    amount = Math.min(Math.floor(Number(amount)), -p.ledger.loan);
    if (!(amount > 0)) return 'There is no loan to repay.';
    if (amount > companyCash(p)) return 'Your company does not have that much cash.';
    post(p, 'Loan repayment', { loan: amount, cash: -amount });
    log(g, `${p.name} repays ${money(amount)} of their loan.`);
    return null;
  },

  // A one-off sale offered by landing on a Retail square.
  sell(g, p, { option } = {}) {
    if (g.phase !== 'act' || !p.sale) return 'There is no sale to make here.';
    const { pos } = p.sale;
    const tile = g.tiles[pos];
    const owner = tile.owner;
    const { units, price } = storeSales(g, pos, tile);
    if (owner === g.turn) {
      const s = RETAIL.sales[option];
      if (!s) return 'Pick a kind of sale.';
      if (!tile.stock) return 'This store has no widgets on its shelves.';
      sellWidgets(g, p, tile, units * s.volume, price * s.price, `${s.name} at ${SQUARES[pos].name}`);
    } else {
      // Wholesale: the rival's store takes widgets from your factories' warehouses.
      const stock = g.tiles.filter((t) => isMine(g, t, 'industrial') && t.stock);
      if (!stock.length) return 'Your factories have no widgets waiting.';
      let sold = 0;
      for (const t of stock) sold += sellWidgets(g, p, t, units - sold / price, price, `Widgets sold through ${g.players[owner].name}'s ${SQUARES[pos].name}`);
      const cut = Math.round(sold * RETAIL.commission);
      if (cut) {
        post(p, `Commission to ${g.players[owner].name}`, { expOther: cut, cash: -cut });
        post(g.players[owner], `Commission from ${p.name}`, { cash: cut, revOther: -cut });
      }
    }
    p.sale = null;
    return null;
  },

  end(g, p) {
    if (g.phase === 'roll') return 'Roll first.';
    if (g.phase === 'buy') ACTIONS.pass(g, p);
    p.sale = null;
    operate(g, p);
    // Every store sells from its own shelves.
    g.tiles.forEach((t, pos) => {
      if (t?.owner === g.turn && t.zone === 'retail' && t.building && t.stock) {
        const { units, price } = storeSales(g, pos, t);
        sellWidgets(g, p, t, units, price, `Widget sales at ${SQUARES[pos].name}`);
      }
    });
    nextTurn(g);
    return null;
  },
};

// The Exchange on the island sells personal assets at half price; a Personal Assets square can
// discount one card. The better of the two applies.
export function personalPrice(p) {
  const off = Math.max(p.atExchange ? 0.5 : 0, p.personalOffer ?? 0);
  return Math.round(CONFIG.personalAssetPrice * (1 - off));
}

function personalSquare(g, p) {
  let r = rand(g);
  const odds = CONFIG.personalSquareOdds;
  const hit = odds.find((o) => (r -= o.chance) < 0) ?? odds[odds.length - 1];
  if (hit.free) return gainPersonal(g, p, drawPersonal(g), 'is given');
  p.personalOffer = hit.discount;
  log(g, `${p.name} is offered ${Math.round(hit.discount * 100)}% off one personal asset this turn.`);
}

// Island landmarks come with their zone and building, so they are bought whole.
function buyLandmark(g, p, sq, tile) {
  const lm = LANDMARKS[sq.landmark];
  if (companyCash(p) < sq.price + lm.building) return 'Your company cannot afford it.';
  post(p, `Bought ${sq.name}`, { land: sq.price, ppe: lm.building, cash: -(sq.price + lm.building) });
  tile.owner = g.turn;
  tile.zone = lm.zone;
  tile.building = { rarity: 'landmark', cost: lm.building, dep: 0 };
  g.phase = 'act';
  log(g, `${p.name} buys the ${sq.name} for ${money(sq.price + lm.building)}.`);
  return null;
}

// A factory's capacity for one turn, sized by both the building's cost and the land's price so
// pricier land is better (Miles). See ZONES.industrial for what the widgets cost.
export function production(pos, cost) {
  return Math.round(ZONES.industrial.produce * Math.sqrt(cost * SQUARES[pos].price));
}

// Miles: a store's PP&E sets its price per widget, and its land sets how many it sells a turn.
export function storeTerms(pos, t) {
  return { units: Math.round(SQUARES[pos].price * RETAIL.perLandDollar), price: RETAIL.prices[t.building.rarity] ?? RETAIL.prices.common };
}

// What a store sells in a normal turn once its owner's pricing dial and the competition on its
// side of the board are counted: each rival store there priced lower takes RETAIL.competition of
// its customers, and each priced higher sends as many more.
const PRICE_RANK = { low: 0, normal: 1, premium: 2 };
export function storeSales(g, pos, t) {
  const base = storeTerms(pos, t);
  const level = g.players[t.owner]?.pricing ?? 'normal';
  const dial = RETAIL.pricing[level];
  let share = 1;
  g.tiles.forEach((r, i) => {
    if (i === pos || r?.zone !== 'retail' || !r.building || r.owner === null || r.owner === t.owner || sideOf(i) !== sideOf(pos) || g.players[r.owner].out) return;
    share += RETAIL.competition * Math.sign(PRICE_RANK[g.players[r.owner].pricing ?? 'normal'] - PRICE_RANK[level]);
  });
  return { units: Math.round(base.units * dial.volume * Math.max(0.5, share)), price: round(base.price * dial.price) };
}

// A company's stores: how many widgets they sell in a normal turn, and their prices.
export function retailTerms(g, idx) {
  const stores = g.tiles.map((t, pos) => ({ t, pos })).filter(({ t }) => t?.owner === idx && t.zone === 'retail' && t.building).map(({ t, pos }) => storeSales(g, pos, t));
  const prices = stores.map((s) => s.price);
  return { units: stores.reduce((n, s) => n + s.units, 0), minPrice: Math.min(...prices, Infinity), maxPrice: Math.max(...prices, 0), stores: stores.length };
}

// Sells up to `units` widgets (at the game's widget cost) from `from` (a store tile's shelves, or the
// player's storage, with a count in .stock / .carried) at `price` each; returns the revenue.
function sellWidgets(g, p, from, units, price, text) {
  const key = from === p ? 'carried' : 'stock';
  const n = Math.min(Math.floor(from[key]), Math.round(units));
  if (n <= 0) return 0;
  from[key] -= n;
  if (n <= 0) return 0;
  const revenue = Math.round(n * price);
  post(p, text, { cash: revenue, revSales: -revenue });
  const cost = widgetValue(g, n);
  post(p, `Cost of widgets sold (${n.toLocaleString('en-US')} at ${money(widgetCost(g))})`, { cogs: cost, inventory: -cost });
  log(g, `${p.name} sells ${n.toLocaleString('en-US')} widgets for ${money(revenue)}.`);
  return revenue;
}

// ---- Moving widgets ----
// The board's four sides, by position (corners belong to none). Shipping stays on a side by truck
// and needs a transport line to cross to another.
export function sideOf(pos) {
  if (pos >= 1 && pos <= 20) return 'top';
  if (pos >= 22 && pos <= 30) return 'right';
  if (pos >= 32 && pos <= 51) return 'bottom';
  if (pos >= 53 && pos < BOARD_SIZE) return 'left';
  if (pos >= BOARD_SIZE) return 'island';
  return null;
}

const isMine = (g, t, kind) => t?.owner === g.turn && t.zone === kind && t.building;

// Landing on your own factory runs an overtime shift. Otherwise the token doesn't move goods: the
// company's logistics do, at the end of each of its turns (see `operate`).
function visit(g, p, pos, landing) {
  const t = g.tiles[pos];
  if (landing && isMine(g, t, 'industrial')) makeWidgets(g, p, pos, production(pos, t.building.cost) * ZONES.industrial.overtime, 'Overtime shift');
}

// What widgets cost: `widgetCost` a unit (ZONES.industrial), or $1 in games begun before overhead.
export const widgetCost = (g) => g.widgetCost ?? 1;
const widgetValue = (g, n) => round(n * widgetCost(g));
export function widgetsHeld(g, p) {
  const idx = g.players.indexOf(p);
  return p.carried + g.tiles.reduce((n, t) => n + (t?.owner === idx ? t.stock : 0), 0);
}

function makeWidgets(g, p, pos, want, why = 'Widgets made') {
  const n = Math.min(Math.round(want), Math.max(0, Math.floor(companyCash(p) / widgetCost(g))));
  if (n <= 0) return 0;
  const cost = widgetValue(g, n);
  post(p, `${why} at ${SQUARES[pos].name} (${n.toLocaleString('en-US')} at ${money(widgetCost(g))})`, { inventory: cost, cash: -cost });
  g.tiles[pos].stock = (g.tiles[pos].stock ?? 0) + n;
  log(g, `${p.name}'s ${SQUARES[pos].name} makes ${n.toLocaleString('en-US')} widgets.`);
  return n;
}

// Who carries goods out of a factory on `side`: your own transport line there carries them free;
// otherwise you pay freight per widget, to a rival whose line is there or, with none, to a hired
// carrier (the bank). Goods made on the island move through its Terminal free.
function carrierOn(g, side) {
  if (side === 'island') return { free: true };
  const lines = g.tiles.map((t, i) => ({ t, i })).filter(({ t, i }) => SQUARES[i].kind === 'transport' && sideOf(i) === side && t.owner !== null && !g.players[t.owner].out);
  const mine = lines.find(({ t }) => t.owner === g.turn);
  if (mine) return { free: true };
  return lines[0] ? { owner: g.players[lines[0].t.owner], pos: lines[0].i } : { hired: true };
}

// The island is reached by air: you need an airport of your own to ship to or from it.
const ownsAirport = (g) => g.tiles.some((t, i) => t?.owner === g.turn && SQUARES[i].kind === 'transport' && SQUARES[i].mode === 'air');

// The company's supply chain, run at the end of each of its owner's turns, like a real one runs
// every day without the CEO driving the goods around:
// 1. Production follows the company's dial (SUPPLY.levels): matching demand, factories make only
//    what the stores need to hold `cover` turns of sales, up to each factory's capacity for a
//    turn; at full capacity they make all they can; idle, nothing.
// 2. Logistics fill each store up to that target from the factories, nearest first. Shipping is
//    free from a factory on a side where you own a transport line; otherwise it costs freight per
//    widget (see `carrierOn`). The island and the main board are linked only by your own airport.
function operate(g, p) {
  const factories = g.tiles.map((t, pos) => ({ t, pos })).filter(({ t }) => isMine(g, t, 'industrial'));
  const stores = g.tiles.map((t, pos) => ({ t, pos })).filter(({ t }) => isMine(g, t, 'retail'));
  // Widgets anywhere else (from older rules, or a sold building's shelves) go to the first warehouse.
  const depot = factories[0] ?? stores[0];
  if (p.carried && depot) {
    depot.t.stock += p.carried;
    p.carried = 0;
  }
  const level = SUPPLY.levels[p.production] ?? SUPPLY.levels.demand;
  const target = ({ t, pos }) => storeSales(g, pos, t).units * level.cover;
  const onHand = p.carried + [...factories, ...stores].reduce((n, { t }) => n + t.stock, 0);
  let budget = !level.make ? 0 : level.flatOut ? Infinity : Math.max(0, stores.reduce((n, s) => n + target(s), 0) - onHand);
  for (const { t, pos } of factories) {
    if (!isMine(g, t, 'industrial')) continue; // sold to cover an earlier factory's idle overhead
    const cap = production(pos, t.building.cost);
    const made = budget > 0 ? makeWidgets(g, p, pos, Math.min(budget, cap)) : 0;
    budget -= made;
    // The overhead on capacity left idle isn't absorbed by any widget, so it is a cost of the turn.
    const idle = g.widgetCost === undefined ? 0 : round((cap - made) * ZONES.industrial.overhead);
    if (idle > 0) charge(g, p, idle, 'cogs', `Idle capacity at ${SQUARES[pos].name}: overhead on ${(cap - made).toLocaleString('en-US')} widgets not made`);
    if (p.out) return;
  }
  // Paying for idle capacity may have meant selling buildings, so ship only between what is left.
  const open = (list, kind) => list.filter(({ t }) => isMine(g, t, kind));
  const shops = open(stores, 'retail');
  const need = new Map(shops.map((s) => [s, Math.max(0, target(s) - s.t.stock)]));
  const airport = ownsAirport(g);
  for (const f of open(factories, 'industrial')) {
    const side = sideOf(f.pos);
    const carrier = carrierOn(g, side);
    const reach = shops.filter((s) => (side === 'island') === (sideOf(s.pos) === 'island') || airport)
      .sort((a, b) => (sideOf(a.pos) === side ? 0 : 1) - (sideOf(b.pos) === side ? 0 : 1));
    for (const s of reach) {
      const n = Math.min(f.t.stock, need.get(s));
      if (n <= 0) continue;
      if (!carrier.free) {
        const by = carrier.owner ? `${carrier.owner.name}'s ${SQUARES[carrier.pos].name}` : 'a hired carrier';
        const fee = charge(g, p, n * RETAIL.freight, 'expFreight', `Freight on ${by} to ${SQUARES[s.pos].name}`);
        if (fee && carrier.owner) post(carrier.owner, `Freight from ${p.name}`, { cash: fee, revFreight: -fee });
        if (p.out) return;
      }
      const m = Math.min(n, f.t.stock); // paying the freight may have meant selling widgets
      f.t.stock -= m;
      s.t.stock += m;
      need.set(s, need.get(s) - m);
    }
  }
}

// Miles: bank control gives another card option. Each Banking building a company owns lets it
// see one more card off the top of the PP&E deck, privately, up to CONFIG.maxBankOptions.
export function bankOptions(g, idx) {
  const banks = g.tiles.filter((t) => t?.owner === idx && t.zone === 'banking' && t.building).length;
  const n = Math.min(banks, CONFIG.maxBankOptions, g.ppeDeck.length);
  return n ? g.ppeDeck.slice(-n).reverse() : [];
}

export function canBuild(g, pos) {
  const tile = g.tiles[pos];
  if (!tile || tile.owner !== g.turn) return 'Build on land you own.';
  if (SQUARES[pos].kind !== 'land') return 'Transport tiles cannot be built on.';
  if (!tile.zone) return 'That land has no zoning.';
  if (tile.building) return 'That land already has a building.';
  return null;
}

export const transportLand = (pos) => Math.round(SQUARES[pos].price * CONFIG.transportLand);

export function canUpgrade(g, pos) {
  const tile = g.tiles[pos];
  if (SQUARES[pos]?.kind !== 'land') return 'Only buildings on land can be upgraded.';
  if (!tile || tile.owner !== g.turn) return 'Upgrade PP&E you own.';
  if (!tile.building) return 'There is no PP&E there to upgrade.';
  if (SQUARES[pos].landmark) return 'Landmarks cannot be upgraded.';
  return null;
}

export const salvageValue = (b) => Math.round(((b.basis ?? b.cost) - b.dep) * CONFIG.salvage);
export const rezoneFee = (pos) => Math.round(SQUARES[pos].price * CONFIG.rezoneFee);

// Destroys a building for its salvage value; anything above that on the books is a loss.
function scrapBuilding(g, p, t, pos, why) {
  const b = t.building;
  const basis = b.basis ?? b.cost;
  const salvage = salvageValue(b);
  post(p, `Destroyed the ${RARITIES[b.rarity].name} PP&E on ${SQUARES[pos].name} for ${why} (cost ${money(basis)}, accumulated depreciation ${money(b.dep)}), salvaged for ${Math.round(CONFIG.salvage * 100)}% of book value`, { cash: salvage, accDep: b.dep, ppe: -basis, gain: basis - b.dep - salvage });
  t.building = null;
  p.carried += t.stock ?? 0;
  t.stock = 0;
  log(g, `${p.name} destroys the ${RARITIES[b.rarity].name} PP&E on ${SQUARES[pos].name} for ${why}, salvaging ${money(salvage)}.`);
}

function putBuilding(g, p, pos, rarity, price) {
  post(p, `Built ${RARITIES[rarity].name} PP&E on ${SQUARES[pos].name}`, { ppe: price, cash: -price });
  // `cost` sizes what the building produces; `basis` is what was paid, which the books carry.
  g.tiles[pos].building = { rarity, cost: RARITIES[rarity].price, basis: price, dep: 0 };
  log(g, `${p.name} builds ${RARITIES[rarity].name} PP&E on ${SQUARES[pos].name} for ${money(price)}.`);
}

function nextTurn(g) {
  if (g.phase === 'over') return;
  for (let i = 1; i <= g.players.length; i++) {
    const n = (g.turn + i) % g.players.length;
    const p = g.players[n];
    if (p.out) continue;
    if (p.skip) {
      p.skip = false;
      log(g, `${p.name} sits out a turn at CPE.`);
      continue;
    }
    g.turn = n;
    g.phase = 'roll';
    g.dice = null;
    return;
  }
  // Everyone left was sitting out; the first of them plays.
  g.turn = g.players.findIndex((p) => !p.out);
  g.phase = 'roll';
}

function afterAction(g) {
  if (g.phase === 'over') return;
  const win = g.win ?? winOptions();
  const alive = g.players.filter((p) => !p.out);
  const independent = alive.filter((p) => p.parent === null);
  if (independent.length === 1) return finish(g, independent[0], 'the last company standing');
  if (!independent.length) return finish(g, alive[0] ?? g.players[0], 'the last company standing');
  const big = independent.find((p) => companyValue(p) >= win.valueTarget);
  if (big) return finish(g, big, `a company worth ${money(win.valueTarget)}`);
  // Miles: the portfolio only wins after a lap of the island.
  const rich = alive.find((p) => portfolio(p) >= CONFIG.portfolioGoal && p.islandLaps > 0);
  if (rich) return finish(g, rich, `a personal asset portfolio of ${money(CONFIG.portfolioGoal)}`);
  if (win.maxYears && alive.every((p) => p.years >= win.maxYears)) {
    const best = alive.reduce((a, b) => (netWorth(g, b) > netWorth(g, a) ? b : a));
    return finish(g, best, `the highest net worth after ${win.maxYears} fiscal years`);
  }
  if (current(g).out) nextTurn(g);
}

// One point on the end-of-game recap charts: where a company and its owner stood.
function snapshot(g, p, year, netIncome = null) {
  (p.history ??= []).push({ year, value: companyValue(p), cash: companyCash(p), netWorth: netWorth(g, p), netIncome });
}

function finish(g, p, reason) {
  g.phase = 'over';
  // The final point: where everyone still playing stood when the game ended, partway into a year.
  for (const q of g.players) if (!q.out) snapshot(g, q, q.years + 0.5);
  g.winner = g.players.indexOf(p);
  g.endReason = reason;
  log(g, `${p.name} wins with ${reason}.`);
  // Second place: whoever runs the largest subsidiary still going.
  const subs = g.players.filter((q) => q !== p && !q.out && q.parent !== null);
  if (subs.length) {
    const best = subs.reduce((a, b) => (companyValue(b) > companyValue(a) ? b : a));
    g.second = g.players.indexOf(best);
    log(g, `${best.name} is second, running the largest subsidiary.`);
  }
}

// ---- Landing ----

function land(g, p) {
  const sq = SQUARES[p.pos];
  const tile = g.tiles[p.pos];
  if (tile) {
    if (tile.owner === null) {
      g.phase = 'buy';
      return;
    }
    if (tile.owner !== g.turn) payRent(g, p, g.players[tile.owner], rentFor(g, p.pos));
    if (!p.out && tile.zone === 'retail' && tile.building) p.sale = { pos: p.pos };
    return;
  }
  switch (sq.kind) {
    case 'fye':
      return; // the fiscal year already closed on the way in
    case 'cpe':
      if (p.assets.includes('cabin')) return log(g, `${p.name} studies at their mountain cabin and carries on.`);
      p.skip = true;
      log(g, `${p.name} is at Continuing Professional Education and will sit out a turn.`);
      return;
    case 'review':
      return audit(g, p);
    case 'bank':
      p.atBank = true;
      log(g, `${p.name} visits the Bank.`);
      return;
    case 'terminal':
      return log(g, `${p.name} is at the island Terminal and can fly home.`);
    case 'haven':
      log(g, `${p.name} visits an Offshore Haven.`);
      return drawCard(g, p, 'fraud');
    case 'customs':
      log(g, `${p.name} is held at Customs while auditors go through the books.`);
      audit(g, p);
      if (!p.out) p.atCustoms = true;
      return;
    case 'exchange':
      p.atExchange = true;
      return log(g, `${p.name} visits the Exchange, where personal assets are half price this turn.`);
    case 'deck':
      if (sq.deck === 'personal') return personalSquare(g, p);
      return drawCard(g, p, sq.deck);
  }
}

export function rentFor(g, pos) {
  const sq = SQUARES[pos];
  const tile = g.tiles[pos];
  if (tile.owner === null) return 0;
  if (sq.kind === 'transport') {
    const owned = g.tiles.filter((t, i) => t?.owner === tile.owner && SQUARES[i].mode === sq.mode).length;
    return TRANSPORT_RENT * 2 ** (owned - 1);
  }
  const fullSet = sq.set !== undefined && SQUARES.every((s, i) => s?.set !== sq.set || s.kind !== 'land' || g.tiles[i].owner === tile.owner);
  let rent = sq.price * CONFIG.landRent * (fullSet ? 2 : 1);
  if (tile.building && tile.zone) rent += tile.building.cost * ZONES[tile.zone].rent;
  return Math.round(rent);
}

function payRent(g, p, owner, amount) {
  const paid = charge(g, p, amount, 'expRent', `Rent to ${owner.name}`);
  if (paid > 0) post(owner, `Rent from ${p.name}`, { cash: paid, revRent: -paid });
  log(g, `${p.name} pays ${owner.name} ${money(paid)} rent.`);
}

// Takes `amount` of company cash for an expense, selling assets to the bank if it must. Returns
// what was actually paid; a company that still can't pay is bankrupt.
function charge(g, p, amount, account, text) {
  amount = Math.round(amount);
  if (amount <= 0) return 0;
  if (companyCash(p) < amount) liquidate(g, p, amount);
  const paid = Math.max(0, Math.min(amount, companyCash(p)));
  if (paid > 0) post(p, text, { [account]: paid, cash: -paid });
  if (paid < amount) bankrupt(g, p, `${p.name}'s company cannot pay ${money(amount)} and goes bankrupt.`);
  return paid;
}

// Sells buildings (cheapest first), then land, back to the bank until cash covers `need`.
function liquidate(g, p, need) {
  const idx = g.players.indexOf(p);
  const owned = g.tiles.map((t, pos) => ({ t, pos })).filter(({ t }) => t?.owner === idx);
  if (widgetsHeld(g, p) > 0 && companyCash(p) < need) {
    // Only as many widgets as the shortfall needs, from storage first, then factories and shelves.
    let units = Math.min(widgetsHeld(g, p), Math.ceil((need - companyCash(p)) / CONFIG.liquidation));
    const sold = units;
    const take = Math.min(p.carried, units);
    p.carried -= take;
    units -= take;
    for (const { t } of owned) {
      const n = Math.min(t.stock, units);
      t.stock -= n;
      units -= n;
    }
    const stock = sold - units;
    const proceeds = Math.round(stock * CONFIG.liquidation);
    if (stock > 0) {
      const cost = widgetValue(g, stock);
      post(p, `Cash shortfall: the bank bought ${stock.toLocaleString('en-US')} widgets (cost ${money(widgetCost(g))} each, ${money(cost)} in all) at $${CONFIG.liquidation.toFixed(2)} each`, { cash: proceeds, gain: round(cost - proceeds), inventory: -cost });
      log(g, `${p.name} dumps ${stock.toLocaleString('en-US')} widgets for ${money(proceeds)}.`);
    }
  }
  const buildings = owned.filter(({ t, pos }) => t.building && SQUARES[pos].kind === 'land').sort((a, b) => a.t.building.cost - b.t.building.cost);
  for (const { t, pos } of buildings) {
    if (companyCash(p) >= need) return;
    sellBuilding(g, p, t, pos);
  }
  const lands = owned.sort((a, b) => SQUARES[a.pos].price - SQUARES[b.pos].price);
  for (const { t, pos } of lands) {
    if (companyCash(p) >= need) return;
    sellLand(g, p, t, pos);
  }
}

function sellBuilding(g, p, t, pos) {
  const b = t.building;
  const proceeds = Math.round(b.cost * CONFIG.liquidation);
  const basis = b.basis ?? b.cost;
  const book = basis - b.dep;
  post(p, `Cash shortfall: the bank bought the ${RARITIES[b.rarity]?.name ?? ''} PP&E on ${SQUARES[pos].name} (cost ${money(basis)}, accumulated depreciation ${money(b.dep)}) for ${Math.round(CONFIG.liquidation * 100)}% of its cost`, { cash: proceeds, accDep: b.dep, ppe: -basis, gain: book - proceeds });
  t.building = null;
  p.carried += t.stock;
  t.stock = 0;
  log(g, `${p.name} sells the building on ${SQUARES[pos].name} for ${money(proceeds)}.`);
}

function sellLand(g, p, t, pos) {
  if (t.building) sellBuilding(g, p, t, pos);
  const sq = SQUARES[pos];
  const proceeds = Math.round(sq.price * CONFIG.liquidation);
  const basis = t.landBasis ?? sq.price;
  post(p, `Cash shortfall: the bank bought the land at ${sq.name} (cost ${money(basis)}) for ${Math.round(CONFIG.liquidation * 100)}% of its list price`, { cash: proceeds, land: -basis, gain: basis - proceeds });
  delete t.landBasis;
  returnZoning(g, t);
  t.owner = null;
  t.zone = null;
  log(g, `${p.name} sells ${sq.name} for ${money(proceeds)}.`);
}

export function acquisitionPrice(q) {
  const raw = Math.max(CONFIG.acquireMin, companyValue(q) * CONFIG.acquirePremium);
  return Math.ceil(raw / CONFIG.personalUnit) * CONFIG.personalUnit;
}

function acquireCompany(g, p, q, price) {
  const me = g.players.indexOf(p);
  const them = g.players.indexOf(q);
  // The buyer takes on the target's assets and debts; anything paid above their book value is goodwill.
  // Shares the buyer already holds aren't paid for again, and never pay the buyer personally.
  const total = totalShares(q);
  const held = q.shares.holders[me] ?? 0;
  const paid = Math.ceil((price * (total - held)) / total / CONFIG.personalUnit) * CONFIG.personalUnit;
  const lines = {};
  for (const a of ['cash', 'inventory', 'land', 'ppe', 'accDep', 'investments', 'goodwill', 'loan', 'affiliateLoan']) lines[a] = q.ledger[a];
  lines.cash -= paid;
  const net = Object.values(lines).reduce((a, b) => a + b, 0);
  if (net < 0) lines.goodwill += -net;
  else lines.gain = -net; // a bargain purchase
  post(p, `Bought ${q.name}'s company`, lines);
  // Shareholders are paid in personal cash; the public's shares are bought back.
  for (const [h, n] of Object.entries(q.shares.holders)) {
    const part = Math.floor((price * n) / total / CONFIG.personalUnit) * CONFIG.personalUnit;
    if (part && Number(h) !== me && (!g.players[h].out || Number(h) === them)) g.players[h].personalCash += part;
  }
  g.tiles.forEach((t) => {
    if (t?.owner === them) t.owner = me;
  });
  g.offers = (g.offers ?? []).filter((o) => o.from !== them && o.to !== them);
  p.carried += q.carried;
  // The target's own subsidiaries now belong to the buyer.
  for (const c of g.players) {
    if (c.parent !== them) continue;
    c.parent = me;
    c.shares.holders[me] = (c.shares.holders[me] ?? 0) + (c.shares.holders[them] ?? 0);
    delete c.shares.holders[them];
  }
  discardHand(g, q);
  Object.assign(q, { out: true, carried: 0, docs: [], fyePending: null, peakLoan: 0, ledger: Object.fromEntries(Object.keys(ACCOUNTS).map((a) => [a, 0])) });
  log(g, `${p.name} buys ${q.name}'s company for ${money(paid)}. ${q.name} is out of the game.`);
}

function bankrupt(g, p, text) {
  if (p.out) return;
  const idx = g.players.indexOf(p);
  // A failed parent's stake in its subsidiaries goes to the market.
  for (const c of g.players) {
    if (c.parent !== idx) continue;
    c.shares.public += c.shares.holders[idx] ?? 0;
    delete c.shares.holders[idx];
    c.parent = null;
  }
  g.tiles.forEach((t) => {
    if (t?.owner !== idx) return;
    returnZoning(g, t);
    Object.assign(t, { owner: null, zone: null, building: null, stock: 0 });
    delete t.landBasis;
  });
  g.offers = (g.offers ?? []).filter((o) => o.from !== idx && o.to !== idx);
  discardHand(g, p);
  p.out = true;
  log(g, text);
  // A parent's investment in a failed subsidiary is lost.
  const host = g.players[p.parent];
  if (host && !host.out && p.invested) {
    const lost = Math.min(p.invested, host.ledger.investments);
    if (lost > 0) post(host, `Wrote off the investment in ${p.name}'s subsidiary`, { expOther: lost, investments: -lost });
    p.invested = 0;
  }
}

// Cards held by a player leaving the game go back to the discard piles.
function discardHand(g, p) {
  for (const id of p.hand) (FRAUD_CARDS[id] ? g.fraudDiscard : g.marketDiscard).push(id);
  p.hand = [];
}

// Zoning on land that goes back to the bank returns to the bottom of the deck.
function returnZoning(g, t) {
  if (!t.zone) return;
  g.zoningDeck.unshift(t.zone);
  refill(g.zoningRow, g.zoningDeck);
}

// Personal income from a company, taxed on the person's running total for the year so splitting
// payouts saves nothing. Returns the tax.
function personalIncome(q, amount) {
  q.yearDraws = (q.yearDraws ?? 0) + amount;
  const due = Math.round((q.yearDraws * CONFIG.personalTax) / CONFIG.personalUnit) * CONFIG.personalUnit;
  let tax = q.taxFree ? 0 : Math.max(0, due - (q.yearTax ?? 0));
  q.yearTax = due;
  const relief = Math.min(tax, q.deduction);
  q.deduction -= relief;
  tax -= relief;
  q.personalCash += amount - tax;
  return tax;
}

// Brings a knocked-out player back as the manager of a new subsidiary. They keep their personal
// cash and assets; the company starts fresh, owned mostly by the parent.
function restart(g, q, parent, capital) {
  const me = g.players.indexOf(q);
  const host = g.players[parent];
  Object.assign(q, {
    out: false, skip: false, pos: host.pos, years: host.years, atBank: false, sale: null,
    ledger: Object.fromEntries(Object.keys(ACCOUNTS).map((a) => [a, 0])),
    journal: [], report: null, hand: [], frauds: 0, taxWaived: false, carried: 0,
    docs: [], fyePending: null, lastCheck: null, filed: null, misstatements: 0,
    bookLedger: Object.fromEntries(Object.keys(ACCOUNTS).map((a) => [a, 0])),
    shares: { holders: { [parent]: 100 - CONFIG.managerShares, [me]: CONFIG.managerShares }, public: 0 },
    isPublic: false, parent,
  });
  post(q, `Capital from ${host.name}`, { cash: capital, capital: -capital });
}

// ---- Fiscal year end ----

function fiscalYearEnd(g, p) {
  // Miles: statements are worked on through the following year, even on other players' turns.
  // Whatever is still unfiled at the next year end is filed blank.
  if (p.fyePending) {
    if (!g.autoStatements) log(g, `${p.name} misses the deadline for fiscal year ${p.fyePending.year}'s statements.`);
    BOOKS.statements(g, p, {});
  }
  // If the PP&E row is nearly all big cards, its priciest goes to the bottom of the deck, so a row
  // of cards nobody can afford yet doesn't stall building.
  if (g.ppeDeck.length && g.ppeRow.filter((r) => RARITIES[r].price < RARITIES.epic.price).length < 2) {
    const i = g.ppeRow.reduce((m, r, k) => (RARITIES[r].price > RARITIES[g.ppeRow[m]].price ? k : m), 0);
    g.ppeDeck.unshift(...g.ppeRow.splice(i, 1));
    refill(g.ppeRow, g.ppeDeck, CONFIG.ppeRowSize);
  }
  const idx = g.players.indexOf(p);
  const mine = g.tiles.map((t, pos) => ({ t, pos })).filter(({ t }) => t?.owner === idx && t.building);
  const each = (zone, fn) => mine.filter(({ t }) => t.zone === zone).forEach(({ t, pos }) => fn(t.building, SQUARES[pos].name, ZONES[zone]));

  // Banking first. The company's cash sits in its own bank and earns interest once, however many
  // banks it owns; each bank adds fees from its outside customers, in line with its size.
  const interest = mine.some(({ t }) => t.zone === 'banking') ? Math.max(0, Math.round(companyCash(p) * ZONES.banking.interest)) : 0;
  if (interest) post(p, 'Interest on company cash held at its own bank', { cash: interest, revInterest: -interest });
  each('banking', (b, name, z) => {
    const earned = Math.round(b.cost * z.yearly);
    if (earned) post(p, `Banking fees at ${name}`, { cash: earned, revInterest: -earned });
  });
  each('residential', (b, name, z) => {
    const earned = Math.round(b.cost * z.yearly);
    if (earned) post(p, `Tenant rent at ${name}`, { cash: earned, revRent: -earned });
  });
  // Miles: one depreciation entry for the year, covering every building.
  let depreciation = 0;
  let depreciated = 0;
  for (const { t } of mine) {
    const basis = t.building.basis ?? t.building.cost;
    const dep = Math.min(Math.round(basis * CONFIG.depreciation), basis - t.building.dep);
    t.building.dep += dep;
    depreciation += dep;
    if (dep) depreciated += 1;
  }
  if (depreciation) post(p, `Depreciation for the year on ${depreciated} building${depreciated > 1 ? 's' : ''}`, { expDep: depreciation, accDep: -depreciation });

  // Miles: interest is on the most the company owed the Bank this year, so a loan repaid before
  // the year end still pays for the time it was out.
  const owed = Math.max(p.peakLoan ?? 0, -p.ledger.loan);
  p.peakLoan = -p.ledger.loan;
  if (owed > 0) charge(g, p, owed * CONFIG.loanInterest, 'expInterest', `Loan interest (${Math.round(CONFIG.loanInterest * 100)}% of the most owed this year, ${money(owed)})`);
  if (p.out) return;
  if (p.outsourced) charge(g, p, CONFIG.bookkeeperFee, 'expOther', 'Bookkeeping fees');
  if (p.out) return;
  // Miles: the year end is payday. The company pays you automatically: a base salary plus a bonus
  // on the year's profit before your pay, as much as its cash allows. It is a company expense,
  // and personal income taxed like any other.
  const due = CONFIG.salary + Math.max(0, incomeStatement(p).preTax) * CONFIG.salaryBonus;
  const salary = Math.round(Math.min(due, Math.max(0, companyCash(p))));
  if (salary) {
    post(p, 'Salary paid to you', { expSalary: salary, cash: -salary });
    const tax = personalIncome(p, salary);
    log(g, `${p.name} is paid a ${money(salary)} salary (${money(tax)} personal tax).`);
  }

  const preTax = incomeStatement(p).preTax;
  if (preTax > 0 && p.taxWaived) {
    log(g, `${p.name}'s books show no taxable income this year.`);
  } else if (preTax > 0) {
    charge(g, p, preTax * CONFIG.corporateTax, 'expTax', 'Corporate income tax');
  }
  p.taxWaived = false;
  if (p.out) return;

  // Miles: fraud can also be caught at FYE.
  if (fraudCheck(g, p, CONFIG.fyeFraudChance, 'Year-end testing')) return;
  // Old frauds age off the record, as the statute of limitations runs out.
  if (CONFIG.fraudExpiryYears && p.frauds) {
    p.fraudClock = (p.fraudClock ?? 0) + 1;
    if (p.fraudClock >= CONFIG.fraudExpiryYears) {
      p.frauds -= 1;
      p.fraudClock = 0;
    }
  } else {
    p.fraudClock = 0;
  }

  personalYearEnd(g, p);

  p.years += 1;
  const statement = incomeStatement(p);
  p.report = { year: p.years, income: statement, balance: balanceSheet(p) };
  snapshot(g, p, p.years, statement.netIncome);
  const truth = { income: incomeFields(p) };
  // Close the year: revenues, expenses and distributions roll into retained earnings.
  const closing = {};
  let total = 0;
  for (const a of TEMPORARY) {
    if (p.ledger[a]) {
      closing[a] = -p.ledger[a];
      total += p.ledger[a];
    }
  }
  if (total || Object.keys(closing).length) post(p, `Close fiscal year ${p.years}`, { ...closing, retained: total }, { doc: false });
  if (p.manual) {
    truth.balance = balanceFields(p);
    p.fyePending = { year: p.years, truth };
    if (p.outsourced) {
      for (const d of p.docs) if (d.year <= p.years) d.recorded = d.lines;
      BOOKS.statements(g, p, structuredClone(truth));
    }
  }
  log(g, `${p.name} closes fiscal year ${p.years} with net income of ${money(statement.netIncome)}.`);
}

function personalYearEnd(g, p) {
  p.yearDraws = 0;
  p.yearTax = 0;
  p.taxFree = false;
  p.raced = false;
  const count = (id) => p.assets.filter((a) => a === id).length;
  p.personalCash += count('mansion') * PERSONAL_CARDS.mansion.yearly + count('cabin') * PERSONAL_CARDS.cabin.yearly;
  p.deduction = count('intelligent') ? M(100) : 0;
  const wealthy = count('wealthy');
  if (wealthy) p.personalCash += M(10 ** wealthy);
  let attractive = count('attractive');
  while (attractive) {
    const cost = M(count('loyal') && attractive > 1 ? 25 : 10 ** attractive);
    if (p.personalCash >= cost) {
      p.personalCash -= cost;
      break;
    }
    p.assets.splice(p.assets.indexOf('attractive'), 1);
    attractive -= 1;
    log(g, `${p.name} cannot keep up an Attractive Spouse.`);
  }
}

// ---- Cards ----

function drawPersonal(g) {
  // Drawn with replacement, weighted by the deck counts, so the deck never runs out.
  const deck = deckOf(PERSONAL_CARDS);
  return deck[Math.floor(rand(g) * deck.length)];
}

function gainPersonal(g, p, id, verb) {
  const card = PERSONAL_CARDS[id];
  if (card.spouse && id !== 'loyal') {
    p.assets = p.assets.filter((a) => !PERSONAL_CARDS[a].spouse || a === 'loyal' || a === id);
  }
  p.assets.push(id);
  log(g, `${p.name} ${verb} a personal asset: ${card.name} (${money(card.value)}).`);
}

function drawCard(g, p, deck) {
  const fraud = deck === 'fraud';
  const id = fraud ? drawFrom(g, 'fraudDeck', 'fraudDiscard') : drawFrom(g, 'marketDeck', 'marketDiscard');
  if (!id) return;
  const card = (fraud ? FRAUD_CARDS : MARKET_CARDS)[id];
  if (card.keep) {
    p.hand.push(id);
    // Fraud cards stay secret; other players only see that one was drawn.
    log(g, fraud ? `${p.name} draws a Fraud card.` : `${p.name} draws ${card.name}.`);
    return;
  }
  log(g, `Market Forces: ${card.name}. ${card.text}`);
  MARKET_NOW[id](g, p);
  g.marketDiscard.push(id);
}

const alive = (g) => g.players.filter((q) => !q.out);

const MARKET_NOW = {
  recession(g) {
    for (const q of alive(g)) charge(g, q, companyCash(q) * 0.1, 'expOther', 'Recession losses');
  },
  boom(g) {
    for (const q of alive(g)) post(q, 'Economic boom', { cash: M(500), revOther: -M(500) });
  },
  lawsuit(g, p) {
    charge(g, p, M(750), 'expOther', 'Lawsuit settlement');
  },
  shipping(g) {
    g.players.forEach((q, i) => {
      const n = g.tiles.filter((t, pos) => t?.owner === i && SQUARES[pos].kind === 'transport').length;
      if (n && !q.out) post(q, 'Higher shipping rates', { cash: M(150) * n, revOther: -M(150) * n });
    });
  },
  rates(g) {
    for (const q of alive(g)) if (q.ledger.loan < 0) charge(g, q, -q.ledger.loan * 0.1, 'expInterest', 'Interest rate hike');
  },
  housing(g) {
    g.tiles.forEach((t, pos) => {
      if (t?.zone !== 'residential' || !t.building || t.owner === null) return;
      const q = g.players[t.owner];
      const rent = Math.round(t.building.cost / 2);
      if (!q.out) post(q, `Housing boom at ${SQUARES[pos].name}`, { cash: rent, revRent: -rent });
    });
  },
  shortage(g) {
    g.tiles.forEach((t, pos) => {
      if (t?.zone === 'retail' && t.building && t.stock && !g.players[t.owner].out) {
        sellWidgets(g, g.players[t.owner], t, storeSales(g, pos, t).units, 3, `Shortage sales at ${SQUARES[pos].name}`);
      }
    });
  },
  rezoning(g) {
    g.zoningDeck.unshift(...g.zoningRow.splice(0));
    refill(g.zoningRow, g.zoningDeck);
  },
  holiday(g) {
    for (const q of alive(g)) q.taxWaived = true;
  },
  spoilage(g) {
    g.players.forEach((q, i) => {
      if (q.out || widgetsHeld(g, q) < 1) return;
      // Take 10% from each place the widgets sit, then book the loss.
      let lost = 0;
      const cut = (n) => Math.floor(n / 10);
      lost += cut(q.carried);
      q.carried -= cut(q.carried);
      for (const t of g.tiles) {
        if (t?.owner === i && t.stock) {
          lost += cut(t.stock);
          t.stock -= cut(t.stock);
        }
      }
      if (lost) post(q, `Widgets lost to supply chain disruption (${lost.toLocaleString('en-US')})`, { expOther: widgetValue(g, lost), inventory: -widgetValue(g, lost) });
    });
  },
};

const PLAYS = {
  stuffing(g, p) {
    const { maxPrice: price, stores } = retailTerms(g, g.turn);
    if (!stores) return 'You need a store to book sales through.';
    if (widgetsHeld(g, p) < 1) return 'You have no widgets.';
    let left = M(500); // widgets
    left -= sellWidgets(g, p, p, left, price, 'Early widget sales') / price;
    for (const [i, t] of g.tiles.entries()) {
      if (left < 1) break;
      if (t?.owner === g.turn && t.stock) left -= sellWidgets(g, p, t, left, price, `Early widget sales from ${SQUARES[i].name}`) / price;
    }
    return null;
  },
  insider(g, p, { target }) {
    const c = g.players[target];
    if (!c || c.out || !c.isPublic) return 'Pick a public company.';
    const count = Math.min(10, c.shares.public);
    const price = tradePrice(c) / 2;
    let n = count;
    while (n && tradeTotal(price, n) > p.personalCash) n -= 1;
    if (!n) return 'You cannot afford any shares.';
    const me = String(g.players.indexOf(p));
    p.personalCash -= tradeTotal(price, n);
    c.shares.public -= n;
    c.shares.holders[me] = (c.shares.holders[me] ?? 0) + n;
    log(g, `${p.name} buys ${n} shares of ${c.name}'s company.`);
    return null;
  },
  shred(g, p) {
    if (!p.frauds) return 'You have no frauds to cover up.';
    p.frauds -= Math.min(2, p.frauds); // playing the card then adds one back
    return null;
  },
  limitations(g, p) {
    if (!p.frauds) return 'You have no frauds on record.';
    p.frauds -= 1;
    return null;
  },
  evasion(g, p) {
    p.taxFree = true;
    return null;
  },
  shell(g, p) {
    post(p, 'Loan from an affiliate', { cash: M(1500), affiliateLoan: -M(1500) });
    return null;
  },
  ponzi(g, p) {
    let got = 0;
    for (const q of alive(g)) {
      if (q === p) continue;
      const take = Math.min(M(100), q.personalCash);
      q.personalCash -= take;
      got += take;
    }
    p.personalCash += got;
    log(g, `${p.name} collects ${money(got)} from "investors".`);
    return null;
  },
  // `row` picks the PP&E card; `card` already names the hand card being played.
  backdate(g, p, { pos, row }) {
    const err = canBuild(g, pos);
    if (err) return err;
    const rarity = g.ppeRow[row];
    if (!rarity) return 'Pick an available PP&E card.';
    const price = Math.round(RARITIES[rarity].price / 2);
    if (companyCash(p) < price) return 'Your company cannot afford it.';
    g.ppeRow.splice(row, 1);
    refill(g.ppeRow, g.ppeDeck, CONFIG.ppeRowSize);
    putBuilding(g, p, pos, rarity, price);
    return null;
  },
  bribe(g, p) {
    const cost = M(100) * g.zoningRow.length;
    if (!g.zoningRow.length) return 'There are no zoning cards to replace.';
    if (companyCash(p) < cost) return 'Your company cannot afford it.';
    post(p, 'Consulting fees', { expOther: cost, cash: -cost }); // the bribe, as it appears in the books
    g.zoningDeck.unshift(...g.zoningRow.splice(0));
    refill(g.zoningRow, g.zoningDeck);
    log(g, `${p.name} has the zoning board's available cards replaced.`);
    return null;
  },
  embezzle(g, p, { amount }) {
    amount = Math.min(M(2000), Math.floor(Number(amount) || M(2000)), Math.floor(companyCash(p)));
    if (!(amount > 0)) return 'Your company has no cash to take.';
    post(p, 'Miscellaneous expenses', { expOther: amount, cash: -amount });
    p.personalCash += amount;
    log(g, `${p.name}'s company books ${money(amount)} of miscellaneous expenses.`);
    return null;
  },
  // Capitalizing expenses, as at WorldCom: the costs move onto the balance sheet as an asset that
  // isn't there, so profit and equity (and the tax on that profit) go up.
  cook(g, p) {
    let left = M(2000);
    const lines = { ppe: 0 };
    for (const acct of ['expOther', 'expRent', 'expFreight']) {
      const moved = Math.min(left, Math.max(0, p.ledger[acct]));
      if (!moved) continue;
      lines[acct] = -moved;
      lines.ppe += moved;
      left -= moved;
    }
    if (!lines.ppe) return 'Your company has no expenses this year to move.';
    post(p, 'Capitalized improvements', lines);
    return null;
  },
  kickback(g, p) {
    for (const q of alive(g)) {
      if (q === p) continue;
      const paid = charge(g, q, M(200), 'expOther', `Fees to ${p.name}`);
      if (paid) post(p, `Fees from ${q.name}`, { cash: paid, revOther: -paid });
    }
    log(g, `Every company pays ${p.name} a ${money(M(200))} fee.`);
    return null;
  },
  whistle(g, p, { target }) {
    const q = g.players[target];
    if (!q || q === p || q.out) return 'Pick another player.';
    log(g, `${p.name} tips off the regulators about ${q.name}'s company.`);
    if (fraudCheck(g, q, CONFIG.auditFraudChance, 'A whistleblower\'s tip')) {
      p.personalCash += M(1000);
      log(g, `${p.name} collects a ${money(M(1000))} whistleblower reward.`);
    } else {
      log(g, `The regulators find nothing at ${q.name}'s company.`);
    }
    return null;
  },
  alienation(g, p, { target }) {
    const q = g.players[target];
    if (!q || q === p || q.out) return 'Pick another player.';
    if (q.assets.includes('loyal')) return `${q.name} has a Loyal Spouse; their spouses can't be taken.`;
    const spouses = q.assets.filter((a) => PERSONAL_CARDS[a].spouse);
    if (!spouses.length) return `${q.name} has no Spouse cards.`;
    if (p.personalCash < M(1000)) return `You need ${money(M(1000))} of personal cash.`;
    p.personalCash -= M(1000);
    q.assets = q.assets.filter((a) => !PERSONAL_CARDS[a].spouse);
    p.assets = p.assets.filter((a) => !PERSONAL_CARDS[a].spouse || a === 'loyal');
    p.assets.push(...spouses);
    log(g, `${p.name} pays ${money(M(1000))} and takes ${q.name}'s spouse cards.`);
    return null;
  },
  contractor(g, p, { pos, rarity }) {
    const err = canBuild(g, pos);
    if (err) return err;
    const i = g.ppeDeck.indexOf(rarity);
    if (i < 0) return 'That card is not in the PP&E deck.';
    const price = Math.round(RARITIES[rarity].price * 0.9);
    if (companyCash(p) < price) return 'Your company cannot afford it.';
    g.ppeDeck.splice(i, 1);
    putBuilding(g, p, pos, rarity, price);
    return null;
  },
};

function audit(g, p) {
  const n = p.misstatements;
  if (n) {
    p.misstatements = 0;
    const fine = n * CONFIG.misstatementFine * scrutiny(p);
    charge(g, p, fine, 'expOther', 'Audit adjustments');
    log(g, `Interim Review finds ${n} misstatement${n > 1 ? 's' : ''} in ${p.name}'s books: ${money(fine)} in fines.`);
    if (p.out) return;
  }
  if (!fraudCheck(g, p, CONFIG.auditFraudChance, 'The Interim Review')) log(g, `Interim Review: ${n ? 'no fraud' : 'nothing wrong'} found at ${p.name}'s company.`);
}

// The chance that a check finds a player out. Miles: fraud in moderation should be a viable
// strategy, so the risk grows with the square of the frauds on record: one or two are a small
// risk, five or more are likely to be found. Public companies get twice the scrutiny.
export function fraudRisk(p, chance) {
  if (!p.frauds) return 0;
  return Math.min(1, chance * scrutiny(p) * p.frauds ** 2);
}

// Miles: being caught is an immediate loss. Returns true if the player was convicted.
function fraudCheck(g, p, chance, who) {
  if (!p.frauds || rand(g) >= fraudRisk(p, chance)) return false;
  p.convicted = true; // a rehired manager's record follows them
  bankrupt(g, p, `${who} uncovers fraud at ${p.name}'s company. ${p.name} is convicted and out of the game.`);
  return true;
}

// ---- Players' own books ----
// The statement lines a player fills in. Amounts are as they'd be written: accumulated
// depreciation, the loan and equity as positive numbers, net income signed.
export const INCOME_FIELDS = ['revSales', 'revRent', 'revInterest', 'revFreight', 'revDividends', 'revOther', 'gain', 'cogs', 'expFreight', 'expRent', 'expSalary', 'expDep', 'expInterest', 'expOther', 'expTax', 'netIncome'];
export const BALANCE_FIELDS = ['cash', 'inventory', 'land', 'ppe', 'accDep', 'investments', 'goodwill', 'totalAssets', 'loan', 'affiliateLoan', 'capital', 'retained', 'totalLiabilitiesAndEquity'];
const CREDIT_NORMAL = new Set(['revSales', 'revRent', 'revInterest', 'revFreight', 'revDividends', 'revOps', 'revOther', 'gain', 'accDep', 'loan', 'affiliateLoan', 'capital', 'retained']);
const TOLERANCE = 1;

// The statements a player's own recorded entries add up to, for auto statements: their books so
// far plus this year's recorded documents, with the year then closed into retained earnings.
function statementsFromEntries(p, year) {
  const ledger = { ...(p.bookLedger ?? Object.fromEntries(Object.keys(ACCOUNTS).map((a) => [a, 0]))) };
  for (const d of p.docs) {
    if (d.year > year || !d.recorded) continue;
    for (const [acct, v] of d.recorded) ledger[acct] = round(ledger[acct] + v);
  }
  const books = { ledger };
  const income = incomeFields(books);
  let total = 0;
  for (const a of TEMPORARY) {
    total += ledger[a];
    ledger[a] = 0;
  }
  ledger.retained = round(ledger.retained + total);
  return { income, balance: balanceFields(books), ledger };
}

function incomeFields(p) {
  const out = {};
  for (const f of INCOME_FIELDS) out[f] = f === 'netIncome' ? incomeStatement(p).netIncome : round(CREDIT_NORMAL.has(f) ? -p.ledger[f] : p.ledger[f]);
  return out;
}

function balanceFields(p) {
  const b = balanceSheet(p);
  const out = {};
  for (const f of BALANCE_FIELDS) {
    if (f === 'totalAssets') out[f] = b.totalAssets;
    else if (f === 'totalLiabilitiesAndEquity') out[f] = b.totalLiabilitiesAndEquity;
    else out[f] = round(CREDIT_NORMAL.has(f) ? -p.ledger[f] : p.ledger[f]);
  }
  return out;
}

function sameEntry(a, b) {
  const net = (lines) => {
    const m = {};
    for (const [acct, v] of lines) m[acct] = (m[acct] ?? 0) + v;
    return m;
  };
  const x = net(a);
  const y = net(b);
  for (const acct of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (Math.abs((x[acct] ?? 0) - (y[acct] ?? 0)) > TOLERANCE) return false;
  }
  return true;
}

// ---- Deals between players ----
// Miles: players trade property with each other. Either side names a price for one lot or
// transport tile, with whatever is built on it, and the other side accepts or declines. Deals can
// be made at any time. Each player has at most one open offer.
const DEALS = {
  offer(g, p, { pos, target, amount } = {}) {
    if (g.phase === 'over') return 'The game is over.';
    const me = g.players.indexOf(p);
    const tile = g.tiles[pos];
    if (!tile || tile.owner === null) return 'Pick a lot or transport tile that a player owns.';
    const q = g.players[target];
    if (!q || q === p || q.out) return 'Pick another player.';
    if (tile.owner !== me && tile.owner !== target) return 'One of you must own it.';
    amount = Math.round(Number(amount));
    if (!(amount > 0)) return 'Enter a price.';
    if (tile.owner === target && amount > companyCash(p)) return 'Your company does not have that much cash.';
    g.offers = (g.offers ?? []).filter((o) => o.from !== me);
    g.offerSeq = (g.offerSeq ?? 0) + 1;
    g.offers.push({ id: g.offerSeq, from: me, to: target, pos, amount, seller: tile.owner });
    const sq = SQUARES[pos];
    log(g, tile.owner === me
      ? `${p.name} offers to sell ${sq.name} to ${q.name} for ${money(amount)}.`
      : `${p.name} offers ${q.name} ${money(amount)} for ${sq.name}.`);
    return null;
  },
  cancel(g, p) {
    const me = g.players.indexOf(p);
    if (!(g.offers ?? []).some((o) => o.from === me)) return 'You have no open offer.';
    g.offers = g.offers.filter((o) => o.from !== me);
    return null;
  },
  respond(g, p, { offer, accept } = {}) {
    const me = g.players.indexOf(p);
    const o = (g.offers ?? []).find((x) => x.id === offer && x.to === me);
    if (!o) return 'That offer is no longer open.';
    g.offers = g.offers.filter((x) => x !== o);
    const from = g.players[o.from];
    const sq = SQUARES[o.pos];
    if (!accept) {
      log(g, `${p.name} turns down ${from.name}'s offer for ${sq.name}.`);
      return null;
    }
    if (from.out || g.tiles[o.pos].owner !== o.seller) return 'That offer is no longer open.';
    const buyer = o.seller === o.from ? p : from;
    if (companyCash(buyer) < o.amount) return `${buyer.name}'s company cannot pay ${money(o.amount)}.`;
    transferProperty(g, o.pos, g.players[o.seller], buyer, o.amount);
    return null;
  },
};

// The seller books the sale against what the lot and building are carried at; the buyer carries
// them at what was paid, land first up to its list price and the rest as the building.
function transferProperty(g, pos, seller, buyer, amount) {
  const sq = SQUARES[pos];
  const t = g.tiles[pos];
  const landBasis = t.landBasis ?? sq.price;
  const b = t.building;
  const basis = b ? (b.basis ?? b.cost) : 0;
  const sold = { cash: amount, land: -landBasis, gain: landBasis + basis - (b?.dep ?? 0) - amount };
  if (b) Object.assign(sold, { ppe: -basis, accDep: b.dep });
  post(seller, `Sold ${sq.name} to ${buyer.name} (land cost ${money(landBasis)}${b ? `; PP&E cost ${money(basis)}, accumulated depreciation ${money(b.dep)}` : ''})`, sold);
  const land = b ? Math.min(amount, sq.kind === 'transport' ? transportLand(pos) : sq.price) : amount;
  const bought = { land, cash: -amount };
  if (b && amount > land) bought.ppe = amount - land;
  post(buyer, `Bought ${sq.name} from ${seller.name}`, bought);
  // Widgets waiting there stay the seller's; they go to the seller's other warehouses.
  seller.carried += t.stock;
  t.stock = 0;
  t.owner = g.players.indexOf(buyer);
  t.landBasis = land;
  if (b) Object.assign(b, { basis: amount - land, dep: 0 });
  // An offer on this property from before the sale no longer applies.
  g.offers = (g.offers ?? []).filter((o) => o.pos !== pos);
  log(g, `${seller.name} sells ${sq.name} to ${buyer.name} for ${money(amount)}.`);
}

// These may be done at any time, not only on your own turn.
const BOOKS = {
  // A bookkeeper records every entry and files the statements, for a yearly fee and no clean-books bonus.
  outsource(g, p, { on } = {}) {
    if (!p.manual) return 'This game keeps the books for you.';
    p.outsourced = Boolean(on);
    log(g, `${p.name} ${p.outsourced ? 'hires' : 'lets go of'} a bookkeeper.`);
    return null;
  },
  record(g, p, { doc, lines } = {}) {
    if (!p.manual) return 'This game keeps the books for you.';
    const d = p.docs.find((x) => x.id === doc);
    if (!d) return 'Pick a document to record.';
    if (!Array.isArray(lines) || !lines.length || lines.length > 8) return 'An entry needs one to eight lines.';
    const clean = [];
    let sum = 0;
    for (const line of lines) {
      const [acct, amt] = Array.isArray(line) ? line : [];
      const v = round(Number(amt));
      if (typeof acct !== 'string' || !Object.hasOwn(ACCOUNTS, acct)) return 'Pick an account for every line.';
      if (!Number.isFinite(v) || v === 0 || Math.abs(v) > 1e9) return 'Every line needs a debit or a credit.';
      clean.push([acct, v]);
      sum += v;
    }
    if (Math.abs(sum) > 0.005) return 'Debits must equal credits.';
    d.recorded = clean;
    return null;
  },

  statements(g, p, { income = {}, balance = {} } = {}) {
    const pending = p.fyePending;
    if (!pending) return 'You have no statements due.';
    if (g.autoStatements) {
      const own = statementsFromEntries(p, pending.year);
      ({ income, balance } = own);
      p.bookLedger = own.ledger;
    }
    const read = (src, fields) => Object.fromEntries(fields.map((f) => [f, round(Number(src?.[f]) || 0)]));
    const filed = { year: pending.year, income: read(income, INCOME_FIELDS), balance: read(balance, BALANCE_FIELDS) };
    const wrongFields = [];
    for (const [kind, fields] of [['income', INCOME_FIELDS], ['balance', BALANCE_FIELDS]]) {
      for (const f of fields) if (Math.abs(filed[kind][f] - pending.truth[kind][f]) > TOLERANCE) wrongFields.push(f);
    }
    const yearDocs = p.docs.filter((d) => d.year <= pending.year);
    const wrongDocs = yearDocs.filter((d) => !d.recorded || !sameEntry(d.recorded, d.lines));
    p.docs = p.docs.filter((d) => d.year > pending.year);
    // A wrong entry is one misstatement; with typed statements, each statement with a wrong line
    // is one more (a single slip throws off several totals, which isn't fined again).
    const wrongStatements = g.autoStatements ? 0 : ['income', 'balance'].filter((k) => wrongFields.some((f) => (k === 'income' ? INCOME_FIELDS : BALANCE_FIELDS).includes(f))).length;
    const errors = wrongStatements + wrongDocs.length;
    // The reviewer's corrections go into the books, so a slip isn't carried into later years.
    if (g.autoStatements) {
      const fix = p.bookLedger;
      for (const d of wrongDocs) {
        for (const [acct, v] of d.lines) fix[acct] = round(fix[acct] + v);
        for (const [acct, v] of d.recorded ?? []) fix[acct] = round(fix[acct] - v);
      }
      let closed = 0;
      for (const a of TEMPORARY) {
        closed += fix[a];
        fix[a] = 0;
      }
      fix.retained = round(fix.retained + closed);
    }
    p.misstatements += errors;
    p.filed = filed;
    p.fyePending = null;
    p.lastCheck = {
      year: pending.year,
      errors,
      truth: pending.truth,
      wrongFields,
      corrections: wrongDocs.map((d) => ({ text: d.text, lines: d.lines, recorded: d.recorded })),
      entries: yearDocs.length,
    };
    if (!errors && !p.outsourced) post(p, 'Bonus for clean books', { cash: CONFIG.cleanBooksBonus, revOther: -CONFIG.cleanBooksBonus });
    log(g, `${p.name} files statements for fiscal year ${pending.year}.`);
    return null;
  },
};

function log(g, text) {
  g.log.push(text);
  if (g.log.length > LOG_SIZE) g.log.shift();
}

// ---- What each player may see ----

// Everything is public except other players' hands, unaudited frauds, journals and the decks.
export function viewFor(g, who) {
  upgrade(g);
  // With manual books, a rival's company shows only what it filed; market prices stay public.
  const open = (i) => g.easyBooks || i === who;
  return {
    turn: g.turn,
    phase: g.phase,
    dice: g.dice,
    widgetCost: widgetCost(g),
    winner: g.winner,
    second: g.second ?? null,
    endReason: g.endReason,
    win: g.win,
    companyValues: g.players.map((p, i) => (open(i) ? companyValue(p) : null)),
    offers: g.offers ?? [],
    easyBooks: g.easyBooks,
    autoStatements: Boolean(g.autoStatements),
    log: g.log,
    tiles: g.tiles.map((t, pos) => (t ? { ...t, rent: rentFor(g, pos) } : null)),
    zoningRow: g.zoningRow,
    ppeRow: g.ppeRow,
    ppeDeckCounts: counts(g.ppeDeck),
    zoningLeft: g.zoningDeck.length,
    ppeLeft: g.ppeDeck.length,
    players: g.players.map((p, i) => ({
      name: p.name,
      pos: p.pos,
      out: p.out,
      skip: p.skip,
      years: p.years,
      cash: open(i) ? companyCash(p) : p.filed?.balance.cash ?? null,
      personalCash: p.personalCash,
      assets: p.assets,
      portfolio: portfolio(p),
      netWorth: netWorth(g, p),
      shares: p.shares,
      isPublic: p.isPublic,
      parent: p.parent,
      sharePrice: open(i) || p.isPublic ? sharePrice(p) : null,
      tradePrice: open(i) || p.isPublic ? tradePrice(p) : null,
      acquisitionPrice: acquisitionPrice(p),
      handCount: p.hand.length,
      // With manual books everyone sees only the statements a player filed; the truth stays hidden.
      ...(g.easyBooks ? { income: incomeStatement(p), balance: balanceSheet(p), report: p.report } : { filed: p.filed, loan: open(i) ? -p.ledger.loan : p.filed?.balance.loan ?? null }),
      fyeDue: p.fyePending?.year ?? null,
      ...(i === who && p.fyePending && g.autoStatements ? { preview: (({ income, balance }) => ({ income, balance }))(statementsFromEntries(p, p.fyePending.year)) } : {}),
      atBank: Boolean(p.atBank),
      atTerminal: Boolean(p.atTerminal),
      atExchange: Boolean(p.atExchange),
      personalPrice: personalPrice(p),
      atCustoms: Boolean(p.atCustoms),
      flew: Boolean(p.flew),
      islandLaps: p.islandLaps ?? 0,
      sale: p.sale ?? null,
      inventory: open(i) ? p.ledger.inventory : null,
      carried: p.carried,
      production: p.production ?? 'demand',
      pricing: p.pricing ?? 'normal',
      widgets: open(i) ? widgetsHeld(g, p) : null,
      retail: retailTerms(g, i),
      // The recap charts; kept back until the game ends, since manual books hide a rival's true figures.
      history: g.phase === 'over' ? p.history ?? [] : null,
      ...(i === who && !g.easyBooks ? {
        docs: p.docs.map(({ id, text, year, recorded }) => ({ id, text, year, recorded })),
        lastCheck: p.lastCheck,
        misstatements: p.misstatements,
      } : {}),
      ...(i === who ? { bankOptions: bankOptions(g, i), hand: p.hand, journal: g.easyBooks ? p.journal : undefined, frauds: p.frauds, fraudRisk: { audit: fraudRisk(p, CONFIG.auditFraudChance), fye: fraudRisk(p, CONFIG.fyeFraudChance) }, taxWaived: p.taxWaived, deduction: p.deduction, outsourced: Boolean(p.outsourced) } : {}),
    })),
  };
}

function counts(arr) {
  const c = {};
  for (const x of arr) c[x] = (c[x] ?? 0) + 1;
  return c;
}

export { MODES, SETS };
