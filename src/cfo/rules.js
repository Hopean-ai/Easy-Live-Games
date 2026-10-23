// CFO rules as pure functions over a plain JSON game state, so the room can store the state as is
// and tests can play whole games without a server. All randomness comes from a seeded generator
// kept in the state.
//
// Each company keeps real double-entry books: every movement of company cash is a journal entry,
// and the income statement and balance sheet are read off the ledger. Personal cash and personal
// assets sit outside the company, as they would for a real owner.
import {
  CONFIG, M, BOARD_SIZE, SQUARES, ISLAND_START, LANDMARKS, onIsland, nextPos, SETS, MODES, ZONES, RARITIES, TRANSPORT_RENT, RETAIL, SUPPLY, CREDIT,
  FRAUD_CARDS, MARKET_CARDS, PERSONAL_CARDS, deckOf, BOARD, PLANNED_MOVE,
} from './data.js';

export const ACCOUNTS = {
  cash: 'Cash',
  receivable: 'Accounts receivable',
  inventory: 'Inventory (widgets)',
  land: 'Land',
  ppe: 'PP&E',
  accDep: 'Accumulated depreciation',
  investments: 'Investment in subsidiaries',
  goodwill: 'Goodwill',
  payable: 'Accounts payable',
  loan: 'Bank loan',
  affiliateLoan: 'Due to affiliate',
  capital: 'Contributed capital',
  retained: 'Retained earnings',
  draws: 'Distributions to shareholders',
  revSales: 'Widget sales',
  cogs: 'Cost of widgets sold',
  revRent: 'Rent revenue',
  revInterest: 'Interest revenue',
  revFreight: 'Freight revenue',
  revDividends: 'Dividend income',
  revOps: 'Operating revenue',
  revOther: 'Other revenue',
  gain: 'Gain (loss) on asset sales',
  expIdle: 'Idle factory capacity',
  expInvLoss: 'Inventory losses',
  expRent: 'Rent expense',
  expSalary: 'Salaries',
  expDep: 'Depreciation expense',
  expFreight: 'Freight expense',
  expTravel: 'Travel expense',
  expCommission: 'Sales commissions',
  expPropTax: 'Property tax',
  expProfessional: 'Professional fees',
  expBadDebt: 'Bad debts and factoring fees',
  expLegal: 'Legal costs and fines',
  expMarketing: 'Advertising and marketing',
  expResearch: 'Research and development',
  expOther: 'Other expenses',
  expInterest: 'Interest expense',
  expTax: 'Income tax expense',
};
// Miles: expenses split by what they are for, as a real income statement shows them.
const EXPENSE_DETAIL = ['expIdle', 'expInvLoss', 'expTravel', 'expCommission', 'expPropTax', 'expProfessional', 'expBadDebt', 'expLegal', 'expMarketing', 'expResearch'];
const TEMPORARY = ['revSales', 'cogs', 'revInterest', 'revFreight', 'revDividends', 'expFreight', 'revRent', 'revOps', 'revOther', 'gain', 'expRent', 'expSalary', 'expDep', 'expOther', 'expInterest', 'expTax', 'draws',
  ...EXPENSE_DETAIL];
const LOG_SIZE = 40;
const JOURNAL_SIZE = 60;
const DOC_KEEP = 150;
const MEMO_SIZE = 80;

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
    costing: true, // inventory at average cost, with freight in it (older games keep a fixed cost per widget)
    credit: true, // sales and supplier credit (games begun before it settle everything in cash)
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
      receivables: [], payables: [], clock: 0, terms: null, // trade credit: bills and the turns they fall due
      carried: 0, // widgets with nowhere to sit (a sold building's stock); the rest sit in factories and stores
      personalCash: CONFIG.startPersonalCash, assets: [], hand: [],
      frauds: 0, taxWaived: false, deduction: 0,
      // Shares in the company this player is CFO of: who holds how many. Miles: the CFO starts with
      // a stake (CONFIG.cfoShares of 100) and the founders, who aren't players, hold the rest.
      shares: { holders: { [g.players.length]: CONFIG.cfoShares }, founders: START_SHARES - CONFIG.cfoShares, public: 0 }, isPublic: false, parent: null,
      manual: !g.easyBooks, docs: [], docSeq: 0, entries: [], entrySeq: 0, bookLedger: Object.fromEntries(Object.keys(ACCOUNTS).map((a) => [a, 0])), fyePending: null, lastCheck: null, filed: null, misstatements: 0,
    };
    g.players.push(p);
    // Later seats can start with a little more, to offset going first.
    const capital = CONFIG.startCompanyCash + (g.players.length - 1) * CONFIG.seatBonus;
    post(p, 'Founders invest starting capital', { cash: capital, capital: -capital });
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
    p.docs.push({ id: p.docSeq, text: describe(text, entry), year: p.years + 1, lines: entry, archived: false });
    // Filed documents only fill the archive; the oldest go first.
    while (p.docs.length > DOC_KEEP && p.docs[0].filed) p.docs.shift();
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
  const expenses = {
    cogs: l.cogs, expIdle: l.expIdle ?? 0, expInvLoss: l.expInvLoss ?? 0, expFreight: l.expFreight, expRent: l.expRent, expSalary: l.expSalary ?? 0, expDep: l.expDep,
    expPropTax: l.expPropTax ?? 0, expTravel: l.expTravel ?? 0, expCommission: l.expCommission ?? 0, expProfessional: l.expProfessional ?? 0,
    expBadDebt: l.expBadDebt ?? 0, expLegal: l.expLegal ?? 0, expMarketing: l.expMarketing ?? 0, expResearch: l.expResearch ?? 0, expInterest: l.expInterest, expOther: l.expOther,
  };
  const totalRevenue = sum(Object.values(revenue));
  const totalExpenses = sum(Object.values(expenses));
  const preTax = totalRevenue - totalExpenses;
  return { revenue, expenses, totalRevenue, totalExpenses, preTax, tax: l.expTax, netIncome: preTax - l.expTax };
}

export function balanceSheet(p) {
  const l = p.ledger;
  const net = incomeStatement(p).netIncome;
  const assets = { cash: l.cash, receivable: l.receivable ?? 0, inventory: l.inventory, land: l.land, ppe: l.ppe, accDep: l.accDep, investments: l.investments, goodwill: l.goodwill };
  const liabilities = { payable: -l.payable || 0, loan: -l.loan || 0, affiliateLoan: -l.affiliateLoan || 0 };
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
  return Object.values(p.shares.holders).reduce((a, b) => a + b, 0) + (p.shares.founders ?? 0) + p.shares.public;
}

// What the market pays for the whole company: its cash at face value, plus the rest of its equity
// (the business itself) at a price-to-book set by its earnings. Miles: a parent is valued on its
// consolidated books, so what its subsidiaries earn counts, less the share their managers own.
export function companyValue(p, g = null) {
  const { equity, cash } = valueBasis(p, g);
  const business = equity - cash;
  const value = business > 0 ? cash + business * priceToBook(p, g) : equity;
  return round(Math.max(0, value) * (p.isPublic ? CONFIG.publicPremium : 1));
}

function valueBasis(p, g) {
  const c = g && consolidated(g, p);
  const equity = c ? c.balance.parentEquity : balanceSheet(p).totalEquity;
  return { equity, cash: Math.max(0, Math.min(c ? c.balance.assets.cash : companyCash(p), equity)) };
}

// Miles (change 2): the business is priced at its return on equity over the return investors
// require (the textbook justified price-to-book), within the market's limits. Cash sitting idle
// is worth its face value and no more, so it only adds value once it's put to work at a good
// return. A company with no closed year yet is priced at its books.
export function priceToBook(p, g = null) {
  const years = (p.earnings ?? []).slice(-CONFIG.earningsYears);
  const { equity, cash } = valueBasis(p, g);
  const business = equity - cash;
  if (!years.length || business <= 0) return 1;
  const earnings = years.reduce((a, b) => a + b, 0) / years.length;
  const [lo, hi] = CONFIG.priceToBook;
  return Math.min(hi, Math.max(lo, earnings / (business * CONFIG.requiredReturn)));
}

// Miles (change 1): total shareholder return, for the company's original 100 shares: the share
// price plus every dividend paid per share. Issuing shares at the market price doesn't move it.
export function shareholderValue(p, g = null) {
  return round((sharePrice(p, g) + (p.dividendsPerShare ?? 0)) * START_SHARES);
}
const START_SHARES = 100;

// New shares are issued at the market price, never below CONFIG.minIssuePrice.
export function issuePrice(p, g = null) {
  return Math.max(CONFIG.minIssuePrice, Math.ceil(sharePrice(p, g)));
}

function issueShares(p, who, n) {
  p.shares.holders[who] = (p.shares.holders[who] ?? 0) + n;
}

export function sharePrice(p, g = null) {
  return round(companyValue(p, g) / totalShares(p));
}

// Shares change hands with personal cash: buyers pay the market price rounded up to the cent,
// sellers get it rounded down.
export function tradePrice(p, g = null) {
  return sharePrice(p, g);
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
    if (held && !c.out) worth += (companyValue(c, g) * held) / totalShares(c);
  }
  return round(worth);
}

// How hard auditors look: public companies and convicted managers get caught and fined more.
function scrutiny(p) {
  return (p.isPublic ? CONFIG.publicScrutiny : 1) * (p.convicted ? CONFIG.publicScrutiny : 1);
}

// ---- Consolidated statements ----
// Miles: a parent's books add in its subsidiaries' line by line, as real group accounts do. The
// parent's investment is replaced by what it bought (the subsidiaries' assets and debts), the
// share its managers own shows as a noncontrolling interest, and dealings inside the group (rent,
// freight, fares, commissions, dividends) cancel out, since a group can't earn from itself. Each
// company closes its own fiscal year, so a subsidiary's figures are its own year to date.

export function subsidiariesOf(g, p) {
  const idx = g.players.indexOf(p);
  return g.players.filter((c) => c !== p && !c.out && c.parent === idx);
}

// Records a payment between two companies of one group, so consolidation can cancel it.
function intercompany(g, payer, payee, expAcct, revAcct, amount) {
  if (!(amount > 0) || payer === payee) return;
  const top = (c) => (c.parent !== null && g.players[c.parent] && !g.players[c.parent].out ? c.parent : g.players.indexOf(c));
  if (top(payer) !== top(payee)) return;
  payer.intra = { ...payer.intra, [expAcct]: round((payer.intra?.[expAcct] ?? 0) + amount) };
  payee.intra = { ...payee.intra, [revAcct]: round((payee.intra?.[revAcct] ?? 0) + amount) };
}

const INTRA_PAIRS = [['expRent', 'revRent'], ['expFreight', 'revFreight'], ['expTravel', 'revFreight'], ['expCommission', 'revOther']];

export function consolidated(g, p) {
  if (p.out || p.parent !== null) return null;
  const subs = subsidiariesOf(g, p);
  if (!subs.length) return null;
  const idx = g.players.indexOf(p);
  const group = [p, ...subs];
  const ledger = Object.fromEntries(Object.keys(ACCOUNTS).map((a) => [a, round(sum(group.map((c) => c.ledger[a] ?? 0)))]));
  let nci = 0;
  let nciIncome = 0;
  let retainedAdj = 0;
  const rows = [];
  for (const c of subs) {
    const own = (c.shares.holders[idx] ?? 0) / totalShares(c);
    const equity = balanceSheet(c).totalEquity;
    const net = incomeStatement(c).netIncome;
    const invested = Math.min(c.invested ?? 0, p.ledger.investments);
    // Out go the parent's investment and the subsidiary's own equity accounts...
    ledger.investments = round(ledger.investments - invested);
    for (const a of ['capital', 'retained', 'draws']) ledger[a] = round(ledger[a] - c.ledger[a]);
    // ...and in comes the parent's share of what the subsidiary has built up, less what it paid.
    retainedAdj += own * (equity - net) - invested;
    nci += (1 - own) * equity;
    nciIncome += (1 - own) * net;
    rows.push({ name: c.name, own: round(own * 100), equity, netIncome: net, invested });
  }
  // Dealings inside the group cancel: as much of each as both sides still show this year.
  const total = (acct) => sum(group.map((c) => c.intra?.[acct] ?? 0));
  const eliminated = {};
  for (const [exp, rev] of INTRA_PAIRS) {
    const x = Math.min(total(exp), total(rev), ledger[exp], -ledger[rev]);
    if (x > 0) {
      ledger[exp] = round(ledger[exp] - x);
      ledger[rev] = round(ledger[rev] + x);
      eliminated[exp] = round((eliminated[exp] ?? 0) + x);
    }
  }
  // Dividends from a subsidiary aren't income to the group; they were the parent's own profit already.
  const dividends = Math.min(total('dividends'), -ledger.revDividends);
  if (dividends > 0) {
    ledger.revDividends = round(ledger.revDividends + dividends);
    retainedAdj += dividends;
    eliminated.dividends = dividends;
  }
  const income = incomeStatement({ ledger });
  const parentIncome = round(income.netIncome - nciIncome);
  const assets = { cash: ledger.cash, receivable: ledger.receivable, inventory: ledger.inventory, land: ledger.land, ppe: ledger.ppe, accDep: ledger.accDep, investments: ledger.investments, goodwill: ledger.goodwill };
  const liabilities = { payable: -ledger.payable || 0, loan: -ledger.loan || 0, affiliateLoan: -ledger.affiliateLoan || 0 };
  const equity = { capital: -ledger.capital, retained: round(-ledger.retained + retainedAdj), netIncome: parentIncome, draws: -ledger.draws, nci: round(nci) };
  const totalLiabilities = sum(Object.values(liabilities));
  const totalEquity = sum(Object.values(equity));
  return {
    subsidiaries: rows,
    eliminated,
    income: { ...income, nciIncome: round(nciIncome), parentIncome },
    balance: {
      assets, liabilities, equity,
      totalAssets: sum(Object.values(assets)), totalLiabilities, totalEquity, totalLiabilitiesAndEquity: round(totalLiabilities + totalEquity),
      parentEquity: round(totalEquity - equity.nci),
    },
  };
}

// ---- Turn flow ----

export function current(g) {
  return g.players[g.turn];
}

// Actions come straight from browsers, so keep only the fields actions use, with the right types.
// Names are looked up as own keys, so 'constructor' or '__proto__' can't reach object internals.
const INT_FIELDS = ['card', 'row', 'zone', 'pos', 'target', 'to', 'count', 'doc', 'offer', 'entry', 'year', 'steps'];
const MAX_AMOUNT = 1e9;
function cleanAction(action) {
  if (!action || typeof action !== 'object' || typeof action.a !== 'string') return null;
  const out = { a: action.a };
  for (const f of INT_FIELDS) if (Number.isInteger(action[f]) && Math.abs(action[f]) <= MAX_AMOUNT) out[f] = action[f];
  if (Number.isFinite(action.amount) && Math.abs(action.amount) <= MAX_AMOUNT) out.amount = action.amount;
  if (typeof action.option === 'string' && (Object.hasOwn(RETAIL.sales, action.option) || Object.hasOwn(BOARD, action.option))) out.option = action.option;
  if (typeof action.rarity === 'string' && Object.hasOwn(RARITIES, action.rarity)) out.rarity = action.rarity;
  if (Array.isArray(action.lines)) out.lines = action.lines;
  if (typeof action.on === 'boolean') out.on = action.on;
  if (typeof action.memo === 'string') out.memo = action.memo.slice(0, MEMO_SIZE);
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
    // Games saved when each document had its own entry: those entries join the open journal and
    // their documents go to the archive.
    if (p.manual && !p.entries) {
      p.entries = [];
      p.entrySeq = 0;
      for (const d of p.docs ?? []) {
        if (d.recorded) {
          p.entrySeq += 1;
          p.entries.push({ id: p.entrySeq, year: d.year, memo: d.text.slice(0, MEMO_SIZE), lines: d.recorded });
        }
        d.archived = Boolean(d.recorded);
        delete d.recorded;
      }
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
  // The CFO buys new shares in the company with personal cash, at any time, at the market price.
  if (action.a === 'invest') {
    const amount = Math.floor(Number(action.amount) * 100) / 100;
    if (!(amount > 0)) return 'Enter an amount.';
    if (p.parent !== null) return 'Your company is a subsidiary; its parent company funds it.';
    if (amount > p.personalCash) return 'You do not have that much personal cash.';
    const price = issuePrice(p, g);
    const n = Math.floor(amount / price);
    if (!n) return `New shares cost ${money(price)} each.`;
    const paid = round(n * price);
    p.personalCash = round(p.personalCash - paid);
    issueShares(p, g.players.indexOf(p), n);
    post(p, `${n} new shares bought by the CFO`, { cash: paid, capital: -paid });
    log(g, `${p.name} buys ${n} new shares in their company for ${money(paid)}.`);
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
    catchUp(p, Infinity, 'Entries made for you while you were away');
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
  // Change 3b: `steps` plans the move instead of rolling, once per fiscal year.
  roll(g, p, { steps } = {}) {
    if (g.phase !== 'roll') return 'You have already rolled.';
    if (steps !== undefined) {
      if (!(steps >= PLANNED_MOVE.min && steps <= PLANNED_MOVE.max)) return `Plan a move of ${PLANNED_MOVE.min} to ${PLANNED_MOVE.max} squares.`;
      if (p.planned) return 'You have already planned a move this fiscal year.';
    }
    p.atBank = false;
    p.boardAction = null;
    p.atTerminal = false;
    p.atExchange = false;
    p.personalOffer = 0;
    p.atCustoms = false;
    p.flew = false;
    p.sale = null;
    const d = steps !== undefined ? [steps, 0] : [1 + Math.floor(rand(g) * 6), 1 + Math.floor(rand(g) * 6)];
    g.dice = d;
    if (steps !== undefined) {
      p.planned = true;
      log(g, `${p.name} plans a move of ${steps}.`);
    } else {
      log(g, `${p.name} rolls ${d[0]} + ${d[1]}.`);
    }
    if (steps === undefined && d[0] === d[1] && p.assets.includes('horses') && !p.raced) {
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
      const fare = charge(g, p, CONFIG.islandFare, 'expTravel', `Airfare on ${g.players[owner].name}'s ${SQUARES[airport].name}`);
      post(g.players[owner], `Airfare from ${p.name}`, { cash: fare, revFreight: -fare });
      intercompany(g, p, g.players[owner], 'expTravel', 'revFreight', fare);
    } else if (owner === null) {
      if (companyCash(p) < CONFIG.islandFare) return `The fare is ${money(CONFIG.islandFare)}.`;
      charge(g, p, CONFIG.islandFare, 'expTravel', 'Airfare');
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

  // Pay yourself a bonus: company cash becomes personal cash, less personal tax. Miles: you are the
  // CFO, not the owner, so it is pay (an expense), not a distribution to shareholders.
  pay(g, p, { amount } = {}) {
    if (g.phase === 'buy') return 'Buy or pass first.';
    amount = Math.floor(Number(amount));
    if (!(amount > 0)) return 'Enter an amount.';
    if (amount > companyCash(p)) return 'Your company does not have that much cash.';
    post(p, 'Bonus paid to you', { expSalary: amount, cash: -amount });
    const tax = personalIncome(p, amount);
    log(g, `${p.name} is paid a ${money(amount)} bonus (${money(tax)} personal tax).`);
    return null;
  },

  // Pay a dividend to every shareholder (payDividend).
  dividend(g, p, { amount } = {}) {
    if (g.phase === 'buy') return 'Buy or pass first.';
    amount = Math.floor(Number(amount));
    if (!(amount > 0)) return 'Enter an amount.';
    if (amount > companyCash(p)) return 'Your company does not have that much cash.';
    payDividend(g, p, amount);
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
    const price = round((companyValue(p, g) * CONFIG.publicPremium) / totalShares(p));
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
    const price = tradePrice(c, g);
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
    const price = acquisitionPrice(q, g);
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
    post(p, 'Legal settlement', { expLegal: CONFIG.settlement, cash: -CONFIG.settlement });
    p.frauds -= 1;
    p.atCustoms = false;
    log(g, `${p.name} pays ${money(CONFIG.settlement)} in legal fees at Customs.`);
    return null;
  },

  // Only on a turn that ended at the Bank, or after calling the bank (a board decision).
  borrow(g, p, { amount } = {}) {
    if (g.phase !== 'act' || !p.atBank) return 'You can only borrow at the Bank, or after calling it.';
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

  // Miles (change 3): one board decision a turn, wherever you landed.
  board(g, p, { option, pos } = {}) {
    if (g.phase !== 'act') return 'Roll first.';
    if (p.boardAction) return 'You have already made this turn\'s board decision.';
    const idx = g.turn;
    if (option === 'marketing') {
      if (p.marketing) return 'Your campaign is already running this fiscal year.';
      const stores = g.tiles.filter((t) => t?.owner === idx && t.zone === 'retail' && t.building).length;
      if (!stores) return 'You have no stores to advertise.';
      const cost = stores * BOARD.marketing.perStore;
      if (companyCash(p) < cost) return `A campaign for ${stores} store${stores > 1 ? 's' : ''} costs ${money(cost)}.`;
      post(p, `Marketing campaign for ${stores} store${stores > 1 ? 's' : ''}`, { expMarketing: cost, cash: -cost });
      p.marketing = true;
      log(g, `${p.name} runs a marketing campaign: their stores sell ${Math.round(BOARD.marketing.boost * 100)}% more this fiscal year.`);
    } else if (option === 'research') {
      if ((p.research ?? 0) >= BOARD.research.levels) return 'Your factories are already as efficient as research can make them.';
      if (companyCash(p) < BOARD.research.cost) return `Research costs ${money(BOARD.research.cost)}.`;
      post(p, 'Process improvement research', { expResearch: BOARD.research.cost, cash: -BOARD.research.cost });
      p.research = (p.research ?? 0) + 1;
      log(g, `${p.name} invests in research: widgets now cost ${money(unitCost(g, p))} to make.`);
    } else if (option === 'financing') {
      p.atBank = true;
      log(g, `${p.name} calls the Bank.`);
    } else if (option === 'restructure') {
      const t = g.tiles[pos];
      if (!t || t.owner !== idx || SQUARES[pos].landmark) return 'Pick a building or lot you own.';
      if (t.building && SQUARES[pos].kind === 'land') sellBuilding(g, p, t, pos, 'Restructuring');
      else sellLand(g, p, t, pos, 'Restructuring');
    } else {
      return 'Pick a board decision.';
    }
    p.boardAction = option;
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
        post(p, `Commission to ${g.players[owner].name}`, { expCommission: cut, cash: -cut });
        post(g.players[owner], `Commission from ${p.name}`, { cash: cut, revOther: -cut });
        intercompany(g, p, g.players[owner], 'expCommission', 'revOther', cut);
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
        sellWidgets(g, p, t, units, price, `Widget sales at ${SQUARES[pos].name}`, Boolean(g.credit));
      }
    });
    nextTurn(g);
    return null;
  },
};

// Every shareholder gets their share. A parent company's share goes to its books as dividend
// income; people's shares are taxed; the founders' and the public's leave the game.
function payDividend(g, p, amount, text = 'Dividend paid to shareholders') {
  post(p, text, { draws: amount, cash: -amount });
  const total = totalShares(p);
  p.dividendsPerShare = round((p.dividendsPerShare ?? 0) + amount / total);
  for (const [h, n] of Object.entries(p.shares.holders)) {
    const q = g.players[h];
    const part = Math.floor((amount * n) / total / CONFIG.personalUnit) * CONFIG.personalUnit;
    if (!part || q.out) continue;
    if (Number(h) === p.parent) {
      post(q, `Dividend from ${p.name}`, { cash: part, revDividends: -part });
      q.intra = { ...q.intra, dividends: (q.intra?.dividends ?? 0) + part };
      log(g, `${q.name}'s company receives a ${money(part)} dividend from ${p.name}.`);
    } else {
      const tax = personalIncome(q, part);
      log(g, `${q.name} receives a ${money(part)} dividend from ${p.name}'s company (${money(tax)} personal tax).`);
    }
  }
}

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
  const boost = g.players[t.owner]?.marketing ? 1 + BOARD.marketing.boost : 1;
  return { units: Math.round(base.units * dial.volume * Math.max(0.5, share) * boost), price: round(base.price * dial.price) };
}

// A company's stores: how many widgets they sell in a normal turn, and their prices.
export function retailTerms(g, idx) {
  const stores = g.tiles.map((t, pos) => ({ t, pos })).filter(({ t }) => t?.owner === idx && t.zone === 'retail' && t.building).map(({ t, pos }) => storeSales(g, pos, t));
  const prices = stores.map((s) => s.price);
  return { units: stores.reduce((n, s) => n + s.units, 0), minPrice: Math.min(...prices, Infinity), maxPrice: Math.max(...prices, 0), stores: stores.length };
}

// Sells up to `units` widgets (at the company's average cost) from `from` (a store tile's shelves, or the
// player's storage, with a count in .stock / .carried) at `price` each; returns the revenue.
function sellWidgets(g, p, from, units, price, text, credit = false) {
  const key = from === p ? 'carried' : 'stock';
  const n = Math.min(Math.floor(from[key]), Math.round(units));
  if (n <= 0) return 0;
  const cost = costOf(g, p, n);
  const each = averageCost(g, p);
  from[key] -= n;
  const revenue = Math.round(n * price);
  const onCredit = credit ? Math.round(revenue * CREDIT.salesShare) : 0;
  if (revenue > onCredit) post(p, onCredit ? `${text}, paid in cash` : text, { cash: revenue - onCredit, revSales: onCredit - revenue });
  if (onCredit) sellOnCredit(p, `${text}, on credit`, onCredit);
  post(p, `Cost of widgets sold (${n.toLocaleString('en-US')} at $${each.toFixed(2)})`, { cogs: cost, inventory: -cost });
  log(g, `${p.name} sells ${n.toLocaleString('en-US')} widgets for ${money(revenue)}.`);
  return revenue;
}

// ---- Trade credit ----
// Miles: some sales are collected later (Accounts receivable) and materials are paid later
// (Accounts payable). Bills fall due a number of the company's own turns later; `p.clock` counts
// those turns, and cards change the periods for the rest of a fiscal year (`p.terms`).

export function creditTerms(p) {
  return { collect: p.terms?.collect ?? CREDIT.collectTurns, pay: p.terms?.pay ?? CREDIT.payTurns };
}

const billTotal = (bills) => round(bills.reduce((n, b) => n + b.amount, 0));

function sellOnCredit(p, text, amount) {
  post(p, text, { receivable: amount, revSales: -amount });
  (p.receivables ??= []).push({ amount, due: (p.clock ?? 0) + creditTerms(p).collect });
}

function buyOnCredit(p, text, amount) {
  post(p, text, { inventory: amount, payable: -amount });
  (p.payables ??= []).push({ amount, due: (p.clock ?? 0) + creditTerms(p).pay });
}

// At the end of each of the company's turns: customers whose bills are due pay, then the company
// pays the suppliers it owes. Fictitious bills (a fraud) never fall due.
function settleCredit(g, p) {
  p.clock = (p.clock ?? 0) + 1;
  const due = (b) => b.due !== null && b.due <= p.clock;
  const collected = billTotal((p.receivables ?? []).filter(due));
  if (collected) post(p, 'Customers pay their bills', { cash: collected, receivable: -collected });
  p.receivables = (p.receivables ?? []).filter((b) => !due(b));
  const owed = billTotal((p.payables ?? []).filter(due));
  p.payables = (p.payables ?? []).filter((b) => !due(b));
  if (owed) payBills(g, p, owed, 'Suppliers paid');
}

// Pays suppliers `amount` (already taken off the bills list), selling assets if need be.
function payBills(g, p, amount, text) {
  charge(g, p, amount, 'payable', text);
}

// A factor buys every genuine bill customers owe, paying now less its fee.
function factor(p, text = 'Receivables sold to a factor') {
  const real = (p.receivables ?? []).filter((b) => !b.fake);
  const amount = billTotal(real);
  if (!amount) return 0;
  const fee = round(amount * CREDIT.factoringFee);
  post(p, text, { cash: round(amount - fee), expBadDebt: fee, receivable: -amount });
  p.receivables = p.receivables.filter((b) => b.fake);
  return amount;
}

// Writes off `share` of every bill customers owe as a bad debt; with `fakeOnly`, just the
// fictitious ones booked before this fiscal year.
function writeOff(p, share, text, fakeOnly = false) {
  let total = 0;
  for (const b of p.receivables ?? []) {
    if (fakeOnly && !(b.fake && b.year < p.years)) continue;
    const cut = round(b.amount * share);
    b.amount = round(b.amount - cut);
    total += cut;
  }
  p.receivables = (p.receivables ?? []).filter((b) => b.amount > 0);
  total = round(total);
  if (total) post(p, text, { expBadDebt: total, receivable: -total });
  return total;
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

// Miles: inventory at average cost. What it cost to make widgets and get them to the shelves
// (materials, absorbed overhead, freight) sits in Inventory until they're sold; each widget
// sold or lost takes the average cost with it. Older games keep a fixed cost per widget.
export function averageCost(g, p) {
  const units = widgetsHeld(g, p);
  return g.costing && units > 0 ? p.ledger.inventory / units : widgetCost(g);
}

// The cost of `n` of a company's widgets; the last of them take whatever is left.
function costOf(g, p, n) {
  if (!g.costing) return widgetValue(g, n);
  return n >= widgetsHeld(g, p) ? p.ledger.inventory : round(n * averageCost(g, p));
}

// Inventory left with no widgets (cents of rounding, or freight paid as the last ones were sold off)
// is a cost of the goods already gone.
function tidyInventory(g, p) {
  if (g.costing && widgetsHeld(g, p) < 1e-9 && p.ledger.inventory && !p.out) {
    post(p, 'Inventory cost left after the last widgets went', { cogs: p.ledger.inventory, inventory: -p.ledger.inventory });
  }
}

// Lower of cost or market: at the year end, widgets that cost more than the company can sell them
// for are written down to that price: its own stores' lowest price, or a rival store's wholesale
// price after commission when it has none.
function writeDownInventory(g, p) {
  if (!g.costing) return;
  const units = widgetsHeld(g, p);
  if (units < 1) return;
  const r = retailTerms(g, g.players.indexOf(p));
  const market = r.stores ? r.minPrice : RETAIL.prices.common * (1 - RETAIL.commission);
  const loss = round(p.ledger.inventory - units * market);
  if (loss > 0) post(p, `Inventory written down to market ($${market.toFixed(2)} a widget)`, { expInvLoss: loss, inventory: -loss });
}
export function widgetsHeld(g, p) {
  const idx = g.players.indexOf(p);
  return p.carried + g.tiles.reduce((n, t) => n + (t?.owner === idx ? t.stock : 0), 0);
}

// What a company's factories pay per widget: research cuts it (change 3), with average costing only.
export function unitCost(g, p) {
  return g.costing ? round(widgetCost(g) - (p.research ?? 0) * BOARD.research.saving) : widgetCost(g);
}

function makeWidgets(g, p, pos, want, why = 'Widgets made') {
  const unit = unitCost(g, p);
  const n = Math.min(Math.round(want), Math.max(0, Math.floor(companyCash(p) / unit)));
  if (n <= 0) return 0;
  const cost = round(n * unit);
  const label = `${why} at ${SQUARES[pos].name} (${n.toLocaleString('en-US')} at ${money(unit)})`;
  // With trade credit the materials are bought on account; the factory's own overhead is paid now.
  const materials = g.credit ? Math.min(Math.floor(cost), Math.round(n * ZONES.industrial.variableCost)) : 0; // whole dollars, as bills are paid
  if (materials) buyOnCredit(p, `${label}: materials on credit`, materials);
  if (cost > materials) post(p, materials ? `${label}: factory overhead` : label, { inventory: round(cost - materials), cash: -round(cost - materials) });
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
// every day without the CFO driving the goods around:
// 1. Production follows the company's dial (SUPPLY.levels): matching demand, factories make only
//    what the stores need to hold `cover` turns of sales, up to each factory's capacity for a
//    turn; at full capacity they make all they can; idle, nothing.
// 2. Logistics fill each store up to that target from the factories, nearest first. Shipping is
//    free from a factory on a side where you own a transport line; otherwise it costs freight per
//    widget (see `carrierOn`). The island and the main board are linked only by your own airport.
function operate(g, p) {
  settleCredit(g, p);
  if (p.out) return;
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
    if (idle > 0) charge(g, p, idle, 'expIdle', `Idle capacity at ${SQUARES[pos].name}: overhead on ${(cap - made).toLocaleString('en-US')} widgets not made`);
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
        // With inventory costing, freight to your own stores is part of what the widgets cost.
        const fee = charge(g, p, n * RETAIL.freight, g.costing ? 'inventory' : 'expFreight', `Freight on ${by} to ${SQUARES[s.pos].name}`);
        if (fee && carrier.owner) post(carrier.owner, `Freight from ${p.name}`, { cash: fee, revFreight: -fee });
        if (fee && carrier.owner && !g.costing) intercompany(g, p, carrier.owner, 'expFreight', 'revFreight', fee);
        if (p.out) return;
      }
      const m = Math.min(n, f.t.stock); // paying the freight may have meant selling widgets
      f.t.stock -= m;
      s.t.stock += m;
      need.set(s, need.get(s) - m);
    }
  }
  tidyInventory(g, p);
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
  const big = independent.find((p) => shareholderValue(p, g) >= win.valueTarget);
  if (big) return finish(g, big, `${money(win.valueTarget)} of shareholder value`);
  // Miles: the portfolio only wins after a lap of the island.
  const rich = alive.find((p) => portfolio(p) >= CONFIG.portfolioGoal && p.islandLaps > 0);
  if (rich) return finish(g, rich, `a personal asset portfolio of ${money(CONFIG.portfolioGoal)}`);
  if (win.maxYears && alive.every((p) => p.years >= win.maxYears)) {
    const card = scorecard(g);
    return finish(g, g.players[card[0].seat], `the best CFO scorecard after ${win.maxYears} fiscal years`);
  }
  if (current(g).out) nextTurn(g);
}

// Miles (change 1b): at the year limit, CFOs are ranked as a board would rank them for a bonus.
// Each measure gives the best player as many points as there are players, the next one fewer, and
// so on, times its weight. Ties on points go to net worth. Clean filings count only with real books.
export const SCORECARD = [
  { id: 'tsr', name: 'Shareholder value', weight: 2, of: (g, p) => shareholderValue(p, g) },
  { id: 'worth', name: 'Personal net worth', weight: 2, of: (g, p) => netWorth(g, p) },
  { id: 'roe', name: 'Return on equity', weight: 1, of: (g, p) => returnOnEquity(p) },
  { id: 'clean', name: 'Clean filings', weight: 1, of: (g, p) => p.cleanYears ?? 0, manual: true },
];

export function returnOnEquity(p) {
  const years = p.roeYears ?? [];
  const equity = years.reduce((a, y) => a + Math.max(0, y.equity), 0);
  return equity > 0 ? round(years.reduce((a, y) => a + y.income, 0) / equity) : 0;
}

export function scorecard(g) {
  const rows = g.players.map((p, seat) => ({ seat, out: p.out, scores: {}, points: 0, worth: netWorth(g, p) })).filter((r) => !r.out);
  for (const m of SCORECARD) {
    if (m.manual && g.easyBooks) continue;
    const vals = rows.map((r) => (r.scores[m.id] = m.of(g, g.players[r.seat])));
    for (const r of rows) r.points += m.weight * (1 + vals.filter((v) => v < r.scores[m.id]).length);
  }
  return rows.sort((a, b) => b.points - a.points || b.worth - a.worth);
}

// One point on the end-of-game recap charts: where a company and its owner stood.
function snapshot(g, p, year, netIncome = null) {
  (p.history ??= []).push({ year, value: companyValue(p, g), cash: companyCash(p), netWorth: netWorth(g, p), netIncome });
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
  intercompany(g, p, owner, 'expRent', 'revRent', paid);
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
  // Short of cash, a company sells what customers owe it before anything else.
  if (companyCash(p) < need) factor(p, 'Cash shortfall: receivables sold to a factor');
  const owned = g.tiles.map((t, pos) => ({ t, pos })).filter(({ t }) => t?.owner === idx);
  if (widgetsHeld(g, p) > 0 && companyCash(p) < need) {
    // Only as many widgets as the shortfall needs, from storage first, then factories and shelves.
    let units = Math.min(widgetsHeld(g, p), Math.ceil((need - companyCash(p)) / CONFIG.liquidation));
    const sold = units;
    const cost = costOf(g, p, units);
    const each = averageCost(g, p);
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
      post(p, `Cash shortfall: the bank bought ${stock.toLocaleString('en-US')} widgets (cost $${each.toFixed(2)} each, ${money(cost)} in all) at $${CONFIG.liquidation.toFixed(2)} each`, { cash: proceeds, gain: round(cost - proceeds), inventory: -cost });
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

function sellBuilding(g, p, t, pos, why = 'Cash shortfall') {
  const b = t.building;
  const proceeds = Math.round(b.cost * CONFIG.liquidation);
  const basis = b.basis ?? b.cost;
  const book = basis - b.dep;
  post(p, `${why}: the bank bought the ${RARITIES[b.rarity]?.name ?? ''} PP&E on ${SQUARES[pos].name} (cost ${money(basis)}, accumulated depreciation ${money(b.dep)}) for ${Math.round(CONFIG.liquidation * 100)}% of its cost`, { cash: proceeds, accDep: b.dep, ppe: -basis, gain: book - proceeds });
  t.building = null;
  p.carried += t.stock;
  t.stock = 0;
  log(g, `${p.name} sells the building on ${SQUARES[pos].name} for ${money(proceeds)}.`);
}

function sellLand(g, p, t, pos, why = 'Cash shortfall') {
  if (t.building) sellBuilding(g, p, t, pos, why);
  const sq = SQUARES[pos];
  const proceeds = Math.round(sq.price * CONFIG.liquidation);
  const basis = t.landBasis ?? sq.price;
  post(p, `${why}: the bank bought the land at ${sq.name} (cost ${money(basis)}) for ${Math.round(CONFIG.liquidation * 100)}% of its list price`, { cash: proceeds, land: -basis, gain: basis - proceeds });
  delete t.landBasis;
  returnZoning(g, t);
  t.owner = null;
  t.zone = null;
  log(g, `${p.name} sells ${sq.name} for ${money(proceeds)}.`);
}

export function acquisitionPrice(q, g = null) {
  const raw = Math.max(CONFIG.acquireMin, companyValue(q, g) * CONFIG.acquirePremium);
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
  for (const a of ['cash', 'receivable', 'inventory', 'land', 'ppe', 'accDep', 'investments', 'goodwill', 'payable', 'loan', 'affiliateLoan']) lines[a] = q.ledger[a] ?? 0;
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
  // Its customers' and suppliers' bills come too, falling due on the buyer's clock.
  const shift = (b) => ({ ...b, due: b.due === null ? null : b.due - (q.clock ?? 0) + (p.clock ?? 0) });
  p.receivables = [...(p.receivables ?? []), ...(q.receivables ?? []).map(shift)];
  p.payables = [...(p.payables ?? []), ...(q.payables ?? []).map(shift)];
  q.receivables = [];
  q.payables = [];
  // The target's own subsidiaries now belong to the buyer.
  for (const c of g.players) {
    if (c.parent !== them) continue;
    c.parent = me;
    c.shares.holders[me] = (c.shares.holders[me] ?? 0) + (c.shares.holders[them] ?? 0);
    delete c.shares.holders[them];
  }
  discardHand(g, q);
  Object.assign(q, { out: true, carried: 0, docs: [], entries: [], fyePending: null, peakLoan: 0, ledger: Object.fromEntries(Object.keys(ACCOUNTS).map((a) => [a, 0])) });
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
  p.receivables = [];
  p.payables = [];
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
    receivables: [], payables: [], terms: null,
    docs: [], entries: [], fyePending: null, lastCheck: null, filed: null, misstatements: 0,
    bookLedger: Object.fromEntries(Object.keys(ACCOUNTS).map((a) => [a, 0])),
    shares: { holders: { [parent]: 100 - CONFIG.managerShares, [me]: CONFIG.managerShares }, founders: 0, public: 0 },
    isPublic: false, parent, earnings: [], roeYears: [], dividendsPerShare: 0,
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

  // Miles: a property tax. The town assesses every lot and transport tile the company owns at its
  // list price, plus what its building cost, and bills a share of that each fiscal year end.
  let assessed = 0;
  let parcels = 0;
  g.tiles.forEach((t, pos) => {
    if (t?.owner !== idx) return;
    assessed += (SQUARES[pos].kind === 'transport' ? transportLand(pos) : SQUARES[pos].price) + (t.building?.cost ?? 0);
    parcels += 1;
  });
  if (assessed) charge(g, p, assessed * CONFIG.propertyTax, 'expPropTax', `Property tax (${CONFIG.propertyTax * 100}% of ${money(assessed)} assessed on ${parcels} propert${parcels > 1 ? 'ies' : 'y'})`);
  if (p.out) return;

  // Miles: interest is on the most the company owed the Bank this year, so a loan repaid before
  // the year end still pays for the time it was out.
  const owed = Math.max(p.peakLoan ?? 0, -p.ledger.loan);
  p.peakLoan = -p.ledger.loan;
  if (owed > 0) charge(g, p, owed * CONFIG.loanInterest, 'expInterest', `Loan interest (${Math.round(CONFIG.loanInterest * 100)}% of the most owed this year, ${money(owed)})`);
  if (p.out) return;
  // Miles: a bookkeeper is paid by the document, for every one it posts at this year end.
  const covered = p.outsourced ? p.docs.filter((d) => !d.filed && d.year <= p.years + 1).length : 0;
  if (covered) charge(g, p, covered * CONFIG.bookkeeperFee, 'expProfessional', `Bookkeeping fees (${covered} document${covered > 1 ? 's' : ''} at ${money(CONFIG.bookkeeperFee)})`);
  if (p.out) return;
  // Miles: the year end is payday. The company pays you automatically: a base salary plus a bonus
  // on the year's profit before your pay, as much as its cash allows. It is a company expense,
  // and personal income taxed like any other.
  const bonus = Math.max(0, incomeStatement(p).preTax) * CONFIG.salaryBonus;
  // Miles: once the company is public, the profit share of the CFO's pay comes as new shares at
  // the market price (a stock award), which isn't cash so isn't taxed until the shares are sold.
  const award = p.isPublic && p.parent === null ? Math.floor(bonus / issuePrice(p, g)) : 0;
  if (award) {
    const value = round(award * issuePrice(p, g));
    issueShares(p, g.players.indexOf(p), award);
    post(p, `Stock award: ${award} new shares paid to you`, { expSalary: value, capital: -value });
    log(g, `${p.name} is awarded ${award} new shares (${money(value)}).`);
  }
  const due = CONFIG.salary + (award ? 0 : bonus);
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
  writeDownInventory(g, p);
  // Fictitious receivables from an earlier year can't be collected, so the year end writes them off.
  writeOff(p, 1, 'Bad debts written off', true);
  p.terms = null; // card terms last for the rest of the fiscal year
  p.marketing = false; // and so does a marketing campaign
  p.planned = false; // a planned move can be used again next year

  p.years += 1;
  const statement = incomeStatement(p);
  p.report = { year: p.years, income: statement, balance: balanceSheet(p) };
  // What the market prices the company on (change 2), and its return on equity for the scorecard.
  const group = consolidated(g, p);
  (p.earnings ??= []).push(group ? group.income.parentIncome : statement.netIncome);
  if (p.earnings.length > CONFIG.earningsYears) p.earnings.shift();
  (p.roeYears ??= []).push({ income: statement.netIncome, equity: balanceSheet(p).totalEquity });
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
  p.intra = null; // this year's dealings within the group, closed with the accounts they sit in
  if (p.manual) {
    truth.balance = balanceFields(p);
    p.fyePending = { year: p.years, truth };
    if (p.outsourced) {
      catchUp(p, p.years, "Your bookkeeper's entries");
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
    charge(g, p, M(750), 'expLegal', 'Lawsuit settlement');
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
  default(g) {
    for (const q of alive(g)) writeOff(q, CREDIT.badDebt, 'Bad debts: a customer goes under');
  },
  crunch(g) {
    for (const q of alive(g)) {
      const owed = billTotal(q.payables ?? []);
      q.payables = [];
      if (owed) payBills(g, q, owed, 'Suppliers paid early (credit crunch)');
    }
  },
  // Miles (change 2b): cash beyond what the business needs belongs to shareholders.
  activist(g) {
    for (const q of alive(g)) {
      const excess = companyCash(q) - balanceSheet(q).totalAssets * CONFIG.activistCash;
      const amount = Math.floor(Math.max(0, excess) * CONFIG.activistPayout);
      if (amount > 0) {
        log(g, `An activist investor makes ${q.name}'s company pay out ${money(amount)} of idle cash.`);
        payDividend(g, q, amount, 'Special dividend demanded by an activist investor');
      }
    }
  },
  spoilage(g) {
    g.players.forEach((q, i) => {
      if (q.out || widgetsHeld(g, q) < 1) return;
      // Take 10% from each place the widgets sit, then book the loss.
      const each = averageCost(g, q);
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
      if (lost) post(q, `Widgets lost to supply chain disruption (${lost.toLocaleString('en-US')})`, { expInvLoss: round(lost * each), inventory: -round(lost * each) });
    });
  },
};

const PLAYS = {
  factoring(g, p) {
    if (!factor(p)) return 'No customers owe you anything.';
    return null;
  },
  creditDept(g, p) {
    p.terms = { ...creditTerms(p), collect: CREDIT.fastCollect };
    for (const b of p.receivables ?? []) if (b.due !== null) b.due = Math.min(b.due, p.clock + CREDIT.fastCollect);
    log(g, `${p.name}'s customers now pay ${CREDIT.fastCollect} turn after a sale.`);
    return null;
  },
  supplierTerms(g, p) {
    p.terms = { ...creditTerms(p), pay: CREDIT.slowPay };
    for (const b of p.payables ?? []) b.due = Math.max(b.due, p.clock + CREDIT.slowPay);
    log(g, `${p.name} now pays suppliers ${CREDIT.slowPay} turns after a purchase.`);
    return null;
  },
  dispute(g, p) {
    if (!p.payables?.length) return 'You owe your suppliers nothing.';
    for (const b of p.payables) b.due += CREDIT.disputeDelay;
    return null;
  },
  fictitious(g, p, { amount }) {
    amount = Math.min(M(1500), Math.floor(Number(amount) || M(1500)));
    if (!(amount > 0)) return 'Enter an amount.';
    post(p, 'Widget sales on credit', { receivable: amount, revSales: -amount });
    (p.receivables ??= []).push({ amount, due: null, fake: true, year: p.years });
    return null;
  },
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
    const price = tradePrice(c, g) / 2;
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
    post(p, 'Consulting fees', { expProfessional: cost, cash: -cost }); // the bribe, as it appears in the books
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
    for (const acct of ['expOther', 'expRent', 'expFreight', 'expTravel', 'expCommission', 'expProfessional', 'expLegal', 'expPropTax', 'expIdle']) {
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
    charge(g, p, fine, 'expLegal', 'Audit adjustments');
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
export const INCOME_FIELDS = ['revSales', 'revRent', 'revInterest', 'revFreight', 'revDividends', 'revOther', 'gain', 'cogs', 'expIdle', 'expInvLoss', 'expFreight', 'expRent', 'expSalary', 'expDep', 'expPropTax', 'expTravel', 'expCommission', 'expProfessional', 'expBadDebt', 'expLegal', 'expMarketing', 'expResearch', 'expInterest', 'expOther', 'expTax', 'netIncome'];
export const BALANCE_FIELDS = ['cash', 'receivable', 'inventory', 'land', 'ppe', 'accDep', 'investments', 'goodwill', 'totalAssets', 'payable', 'loan', 'affiliateLoan', 'capital', 'retained', 'totalLiabilitiesAndEquity'];
const CREDIT_NORMAL = new Set(['revSales', 'revRent', 'revInterest', 'revFreight', 'revDividends', 'revOps', 'revOther', 'gain', 'accDep', 'payable', 'loan', 'affiliateLoan', 'capital', 'retained']);
const TOLERANCE = 1;

// Miles: documents and the journal are kept apart. Documents pile up for the player to archive
// whenever they like, and they post journal entries whenever they like, one entry for many
// documents or many for one. Nothing ties an entry to a document; each entry is dated to a fiscal
// year, and the year's statements are built from that year's entries.

// The ledger before the year end close: the books so far plus the entries, or the documents' true
// lines, dated up to that year.
function openLedger(p, year, items) {
  const ledger = { ...(p.bookLedger ?? Object.fromEntries(Object.keys(ACCOUNTS).map((a) => [a, 0]))) };
  for (const x of items) {
    if (x.year > year || x.filed) continue;
    for (const [acct, v] of x.lines) ledger[acct] = round((ledger[acct] ?? 0) + v);
  }
  return ledger;
}

// The years a player may post to: the year whose statements are due, and the one under way.
function openYears(p) {
  return p.fyePending ? [p.fyePending.year, p.years + 1] : [p.years + 1];
}

// Posts whatever the journal is missing for documents dated up to `year`, as one entry a year, and
// archives those documents. For a bookkeeper, and for a player whose turn timed out.
function catchUp(p, year, memo) {
  const years = [...p.docs.filter((d) => !d.filed), ...p.entries].map((x) => x.year).filter((y) => y <= year);
  for (const y of new Set(years)) {
    const diff = {};
    for (const d of p.docs) if (d.year === y && !d.filed) for (const [a, v] of d.lines) diff[a] = (diff[a] ?? 0) + v;
    for (const e of p.entries) if (e.year === y) for (const [a, v] of e.lines) diff[a] = (diff[a] ?? 0) - v;
    const lines = Object.entries(diff).map(([a, v]) => [a, round(v)]).filter(([, v]) => v !== 0);
    if (lines.length) {
      p.entrySeq = (p.entrySeq ?? 0) + 1;
      p.entries.push({ id: p.entrySeq, year: y, memo, lines });
    }
  }
  for (const d of p.docs) if (d.year <= year) d.archived = true;
}

// The statements a player's own entries add up to: their books so far plus the entries dated up to
// that year, with the year then closed into retained earnings.
function statementsFromEntries(p, year) {
  const ledger = openLedger(p, year, p.entries);
  const books = { ledger };
  const income = incomeFields(books);
  closeLedger(ledger);
  return { income, balance: balanceFields(books), ledger };
}

function closeLedger(ledger) {
  let total = 0;
  for (const a of TEMPORARY) {
    total += ledger[a];
    ledger[a] = 0;
  }
  ledger.retained = round(ledger.retained + total);
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
  // Moves documents to the archive, or back to the inbox. With no document named, archives them all.
  archive(g, p, { doc, on = true } = {}) {
    if (!p.manual) return 'This game keeps the books for you.';
    const list = doc === undefined ? p.docs.filter((d) => !d.archived) : p.docs.filter((d) => d.id === doc);
    if (!list.length) return doc === undefined ? 'Your inbox is empty.' : 'Pick a document.';
    for (const d of list) d.archived = Boolean(on);
    return null;
  },
  // Posts a new journal entry, or changes one (named by `entry`) in a year not yet filed.
  entry(g, p, { entry, year, memo, lines } = {}) {
    if (!p.manual) return 'This game keeps the books for you.';
    const old = entry === undefined ? null : p.entries.find((e) => e.id === entry);
    if (entry !== undefined && !old) return 'That entry is no longer in your journal.';
    const years = openYears(p);
    year ??= old?.year ?? years[0];
    if (!years.includes(year)) return `Entries can go in fiscal year ${years.join(' or ')}.`;
    if (!Array.isArray(lines) || !lines.length || lines.length > 12) return 'An entry needs one to twelve lines.';
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
    memo = (memo ?? old?.memo ?? '').trim();
    if (old) Object.assign(old, { year, memo, lines: clean });
    else {
      if (p.entries.length >= 400) return 'Your journal is full until you file your statements.';
      p.entrySeq = (p.entrySeq ?? 0) + 1;
      p.entries.push({ id: p.entrySeq, year, memo, lines: clean });
    }
    return null;
  },
  unpost(g, p, { entry } = {}) {
    if (!p.manual) return 'This game keeps the books for you.';
    if (!p.entries.some((e) => e.id === entry)) return 'That entry is no longer in your journal.';
    p.entries = p.entries.filter((e) => e.id !== entry);
    return null;
  },

  statements(g, p, { income = {}, balance = {} } = {}) {
    const pending = p.fyePending;
    if (!pending) return 'You have no statements due.';
    if (g.autoStatements) ({ income, balance } = statementsFromEntries(p, pending.year));
    const read = (src, fields) => Object.fromEntries(fields.map((f) => [f, round(Number(src?.[f]) || 0)]));
    const filed = { year: pending.year, income: read(income, INCOME_FIELDS), balance: read(balance, BALANCE_FIELDS) };
    const wrongFields = [];
    for (const [kind, fields] of [['income', INCOME_FIELDS], ['balance', BALANCE_FIELDS]]) {
      for (const f of fields) if (Math.abs(filed[kind][f] - pending.truth[kind][f]) > TOLERANCE) wrongFields.push(f);
    }
    // With no entry tied to a document, the review compares each account with the true books. A
    // slip throws off two accounts, so two wrong accounts make one misstatement (Miles's choice).
    const truthLedger = openLedger(p, pending.year, p.docs);
    const ownLedger = openLedger(p, pending.year, p.entries);
    const corrections = Object.keys(ACCOUNTS)
      .filter((a) => Math.abs((ownLedger[a] ?? 0) - (truthLedger[a] ?? 0)) > TOLERANCE)
      .map((a) => ({ account: a, recorded: ownLedger[a] ?? 0, correct: truthLedger[a] ?? 0 }));
    const wrongStatements = g.autoStatements ? 0 : ['income', 'balance'].filter((k) => wrongFields.some((f) => (k === 'income' ? INCOME_FIELDS : BALANCE_FIELDS).includes(f))).length;
    const errors = wrongStatements + Math.ceil(corrections.length / 2);
    // The reviewer's corrections go into the books, so a slip isn't carried into later years.
    const entries = p.entries.filter((e) => e.year <= pending.year).length;
    closeLedger(truthLedger);
    p.bookLedger = truthLedger;
    p.entries = p.entries.filter((e) => e.year > pending.year);
    for (const d of p.docs) {
      if (d.year > pending.year || d.filed) continue;
      d.filed = true;
      delete d.lines;
    }
    p.misstatements += errors;
    p.filed = filed;
    p.fyePending = null;
    p.lastCheck = {
      year: pending.year,
      errors,
      truth: pending.truth,
      wrongFields,
      corrections,
      entries,
    };
    if (!errors) p.cleanYears = (p.cleanYears ?? 0) + 1;
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
    companyValues: g.players.map((p, i) => (open(i) ? companyValue(p, g) : null)),
    shareholderValues: g.players.map((p, i) => (open(i) || p.isPublic ? shareholderValue(p, g) : null)),
    scorecard: g.phase === 'over' && g.win?.maxYears ? scorecard(g) : null,
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
      sharePrice: open(i) || p.isPublic ? sharePrice(p, g) : null,
      priceToBook: open(i) || p.isPublic ? round(priceToBook(p, g)) : null,
      dividendsPerShare: p.dividendsPerShare ?? 0,
      boardAction: p.boardAction ?? null,
      marketing: Boolean(p.marketing),
      research: p.research ?? 0,
      unitCost: unitCost(g, p),
      planned: Boolean(p.planned),
      tradePrice: open(i) || p.isPublic ? tradePrice(p, g) : null,
      acquisitionPrice: acquisitionPrice(p, g),
      consolidated: open(i) ? consolidated(g, p) : null,
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
      averageCost: open(i) ? round(averageCost(g, p)) : null,
      retail: retailTerms(g, i),
      credit: g.credit && open(i) ? { receivable: p.ledger.receivable ?? 0, payable: -(p.ledger.payable ?? 0), ...creditTerms(p) } : null,
      // The recap charts; kept back until the game ends, since manual books hide a rival's true figures.
      history: g.phase === 'over' ? p.history ?? [] : null,
      ...(i === who && !g.easyBooks ? {
        docs: p.docs.map(({ id, text, year, archived }) => ({ id, text, year, archived })),
        entries: p.entries,
        openYears: openYears(p),
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
