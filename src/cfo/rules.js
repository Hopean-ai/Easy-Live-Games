// CFO rules as pure functions over a plain JSON game state, so the room can store the state as is
// and tests can play whole games without a server. All randomness comes from a seeded generator
// kept in the state.
//
// Each company keeps real double-entry books: every movement of company cash is a journal entry,
// and the income statement and balance sheet are read off the ledger. Personal cash and personal
// assets sit outside the company, as they would for a real owner.
import {
  CONFIG, BOARD_SIZE, CPE_POS, SQUARES, SETS, MODES, ZONES, RARITIES, TRANSPORT_RENT,
  FRAUD_CARDS, MARKET_CARDS, PERSONAL_CARDS, deckOf,
} from './data.js';

export const ACCOUNTS = {
  cash: 'Cash',
  land: 'Land',
  ppe: 'PP&E',
  accDep: 'Accumulated depreciation',
  loan: 'Bank loan',
  capital: 'Contributed capital',
  retained: 'Retained earnings',
  draws: 'Owner distributions',
  revRent: 'Rent revenue',
  revOps: 'Operating revenue',
  revOther: 'Other revenue',
  gain: 'Gain (loss) on asset sales',
  expRent: 'Rent expense',
  expDep: 'Depreciation expense',
  expOther: 'Other expenses',
  expInterest: 'Interest expense',
  expTax: 'Income tax expense',
};
const TEMPORARY = ['revRent', 'revOps', 'revOther', 'gain', 'expRent', 'expDep', 'expOther', 'expInterest', 'expTax', 'draws'];
const LOG_SIZE = 40;
const JOURNAL_SIZE = 60;

// ---- Setup ----

export function createGame(names, seed = (Math.random() * 2 ** 32) >>> 0) {
  if (names.length < CONFIG.minPlayers || names.length > CONFIG.maxPlayers) throw new Error('bad player count');
  const g = {
    seed: seed >>> 0,
    turn: 0,
    phase: 'roll', // roll | buy | act | over
    dice: null,
    players: [],
    tiles: SQUARES.map((sq) => (sq.kind === 'land' || sq.kind === 'transport' ? { owner: null, zone: null, building: null } : null)),
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
  };
  g.zoningDeck = shuffle(g, Object.entries(ZONES).flatMap(([id, z]) => Array(z.count).fill(id)));
  g.ppeDeck = shuffle(g, Object.entries(RARITIES).flatMap(([id, r]) => Array(r.count).fill(id)));
  refill(g.zoningRow, g.zoningDeck);
  refill(g.ppeRow, g.ppeDeck);

  // Player i is seat i; the room decides the seating order.
  for (const name of names) {
    const p = {
      name, pos: 0, out: false, skip: false, years: 0,
      ledger: Object.fromEntries(Object.keys(ACCOUNTS).map((a) => [a, 0])),
      journal: [], report: null,
      personalCash: CONFIG.startPersonalCash, assets: [], hand: [],
      frauds: 0, taxWaived: false, deduction: 0,
    };
    g.players.push(p);
    post(p, 'Owner invests starting capital', { cash: CONFIG.startCompanyCash, capital: -CONFIG.startCompanyCash });
  }
  log(g, `${g.players[0].name} goes first.`);
  return g;
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

function refill(row, deck) {
  while (row.length < CONFIG.rowSize && deck.length) row.push(deck.pop());
}

function drawFrom(g, deckKey, discardKey) {
  if (!g[deckKey].length) g[deckKey] = shuffle(g, g[discardKey].splice(0));
  return g[deckKey].pop() ?? null;
}

// ---- Books ----

// Posts a balanced journal entry; positive amounts are debits, negative are credits.
export function post(p, text, lines) {
  let sum = 0;
  for (const [acct, amt] of Object.entries(lines)) {
    if (!(acct in ACCOUNTS) || !Number.isFinite(amt)) throw new Error(`bad journal line ${acct}`);
    sum += amt;
  }
  if (Math.abs(sum) > 1e-6) throw new Error(`unbalanced entry: ${text}`);
  for (const [acct, amt] of Object.entries(lines)) p.ledger[acct] = round(p.ledger[acct] + amt);
  p.journal.push({ text, lines: Object.entries(lines).map(([a, v]) => [a, round(v)]) });
  if (p.journal.length > JOURNAL_SIZE) p.journal.shift();
}

const round = (n) => Math.round(n * 100) / 100;
const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

export function companyCash(p) {
  return p.ledger.cash;
}

export function incomeStatement(p) {
  const l = p.ledger;
  const revenue = { revRent: -l.revRent, revOps: -l.revOps, revOther: -l.revOther, gain: -l.gain };
  const expenses = { expRent: l.expRent, expDep: l.expDep, expInterest: l.expInterest, expOther: l.expOther };
  const totalRevenue = sum(Object.values(revenue));
  const totalExpenses = sum(Object.values(expenses));
  const preTax = totalRevenue - totalExpenses;
  return { revenue, expenses, totalRevenue, totalExpenses, preTax, tax: l.expTax, netIncome: preTax - l.expTax };
}

export function balanceSheet(p) {
  const l = p.ledger;
  const net = incomeStatement(p).netIncome;
  const assets = { cash: l.cash, land: l.land, ppe: l.ppe, accDep: l.accDep };
  const liabilities = { loan: -l.loan };
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

export function netWorth(p) {
  return round(balanceSheet(p).totalEquity + p.personalCash + portfolio(p));
}

// ---- Turn flow ----

export function current(g) {
  return g.players[g.turn];
}

// Applies one player action. Returns null on success or a short error for that player.
export function act(g, who, action) {
  if (g.phase === 'over') return 'The game is over.';
  const p = g.players[who];
  if (!p || p.out) return 'You are not in this game.';
  if (action?.a === 'resign') {
    bankrupt(g, p, `${p.name} resigns.`);
    afterAction(g);
    return null;
  }
  if (g.turn !== who) return 'It is not your turn.';
  const handler = ACTIONS[action?.a];
  if (!handler) return 'Unknown action.';
  const err = handler(g, p, action);
  if (!err) afterAction(g);
  return err ?? null;
}

// The turn timer ran out: do the least surprising thing for an absent player.
export function timeout(g) {
  if (g.phase === 'over') return;
  const p = current(g);
  if (g.phase === 'roll') ACTIONS.roll(g, p);
  if (g.phase === 'buy') ACTIONS.pass(g, p);
  if (g.phase === 'act') ACTIONS.end(g, p);
  afterAction(g);
}

const ACTIONS = {
  roll(g, p) {
    if (g.phase !== 'roll') return 'You have already rolled.';
    p.atBank = false;
    const d = [1 + Math.floor(rand(g) * 6), 1 + Math.floor(rand(g) * 6)];
    g.dice = d;
    const from = p.pos;
    p.pos = (p.pos + d[0] + d[1]) % BOARD_SIZE;
    log(g, `${p.name} rolls ${d[0]} + ${d[1]}.`);
    if (p.pos < from) fiscalYearEnd(g, p);
    g.phase = 'act';
    if (!p.out && g.phase !== 'over') land(g, p);
    return null;
  },

  buy(g, p, { zone } = {}) {
    if (g.phase !== 'buy') return 'There is nothing to buy.';
    const sq = SQUARES[p.pos];
    const tile = g.tiles[p.pos];
    if (companyCash(p) < sq.price) return 'Your company cannot afford it.';
    let zoneId = null;
    if (sq.kind === 'land' && g.zoningRow.length) {
      if (!Number.isInteger(zone) || !g.zoningRow[zone]) return 'Pick a zoning card.';
      zoneId = g.zoningRow.splice(zone, 1)[0];
      refill(g.zoningRow, g.zoningDeck);
    }
    post(p, `Bought ${sq.name}`, { land: sq.price, cash: -sq.price });
    tile.owner = g.turn;
    tile.zone = zoneId;
    g.phase = 'act';
    log(g, `${p.name} buys ${sq.name} for ${money(sq.price)}${zoneId ? `, zoned ${ZONES[zoneId].name}` : ''}.`);
    return null;
  },

  pass(g, p) {
    if (g.phase !== 'buy') return 'There is nothing to pass on.';
    g.phase = 'act';
    return null;
  },

  build(g, p, { pos, card } = {}) {
    if (g.phase !== 'act') return 'Roll first.';
    const err = canBuild(g, pos);
    if (err) return err;
    const rarity = g.ppeRow[card];
    if (!rarity) return 'Pick a PP&E card.';
    const price = RARITIES[rarity].price;
    if (companyCash(p) < price) return 'Your company cannot afford it.';
    g.ppeRow.splice(card, 1);
    refill(g.ppeRow, g.ppeDeck);
    putBuilding(g, p, pos, rarity, price);
    return null;
  },

  // Pay yourself: company cash becomes personal cash, less personal tax.
  pay(g, p, { amount } = {}) {
    if (g.phase === 'buy') return 'Buy or pass first.';
    amount = Math.floor(Number(amount));
    if (!(amount > 0)) return 'Enter an amount.';
    if (amount > companyCash(p)) return 'Your company does not have that much cash.';
    post(p, 'Owner distribution', { draws: amount, cash: -amount });
    let tax = Math.round(amount * CONFIG.personalTax);
    const relief = Math.min(tax, p.deduction);
    p.deduction -= relief;
    tax -= relief;
    p.personalCash += amount - tax;
    log(g, `${p.name} pays themself ${money(amount)} (${money(tax)} personal tax).`);
    return null;
  },

  personal(g, p) {
    if (g.phase === 'buy') return 'Buy or pass first.';
    if (p.personalCash < CONFIG.personalAssetPrice) return `You need ${money(CONFIG.personalAssetPrice)} of personal cash.`;
    p.personalCash -= CONFIG.personalAssetPrice;
    gainPersonal(g, p, drawPersonal(g), 'buys');
    return null;
  },

  play(g, p, msg = {}) {
    if (g.phase === 'buy') return 'Buy or pass first.';
    const id = p.hand[msg.card];
    if (!id) return 'Pick a card from your hand.';
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

  end(g, p) {
    if (g.phase === 'roll') return 'Roll first.';
    if (g.phase === 'buy') ACTIONS.pass(g, p);
    nextTurn(g);
    return null;
  },
};

export function canBuild(g, pos) {
  const tile = g.tiles[pos];
  if (!tile || tile.owner !== g.turn) return 'Build on land you own.';
  if (SQUARES[pos].kind !== 'land') return 'Transport tiles cannot be built on.';
  if (!tile.zone) return 'That land has no zoning.';
  if (tile.building) return 'That land already has a building.';
  return null;
}

function putBuilding(g, p, pos, rarity, price) {
  post(p, `Built ${RARITIES[rarity].name} PP&E on ${SQUARES[pos].name}`, { ppe: price, cash: -price });
  g.tiles[pos].building = { rarity, cost: RARITIES[rarity].price, dep: 0 };
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
  const alive = g.players.filter((p) => !p.out);
  if (alive.length === 1) return finish(g, alive[0], 'last company standing');
  const rich = alive.find((p) => portfolio(p) >= CONFIG.portfolioGoal);
  if (rich) return finish(g, rich, `a personal asset portfolio of ${money(CONFIG.portfolioGoal)}`);
  if (alive.every((p) => p.years >= CONFIG.maxYears)) {
    const best = alive.reduce((a, b) => (netWorth(b) > netWorth(a) ? b : a));
    return finish(g, best, `the highest net worth after ${CONFIG.maxYears} fiscal years`);
  }
  if (current(g).out) nextTurn(g);
}

function finish(g, p, reason) {
  g.phase = 'over';
  g.winner = g.players.indexOf(p);
  g.endReason = reason;
  log(g, `${p.name} wins with ${reason}.`);
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
    return;
  }
  switch (sq.kind) {
    case 'fye':
      return; // the fiscal year already closed on the way in
    case 'cpe':
      p.skip = true;
      log(g, `${p.name} is at Continuing Professional Education and will sit out a turn.`);
      return;
    case 'review':
      return audit(g, p);
    case 'bank':
      p.atBank = true;
      log(g, `${p.name} visits the Bank.`);
      return;
    case 'deck':
      if (sq.deck === 'personal') return gainPersonal(g, p, drawPersonal(g), 'draws');
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
  const fullSet = SQUARES.every((s, i) => s?.set !== sq.set || s.kind !== 'land' || g.tiles[i].owner === tile.owner);
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
  const buildings = owned.filter(({ t }) => t.building).sort((a, b) => a.t.building.cost - b.t.building.cost);
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
  const book = b.cost - b.dep;
  post(p, `Sold PP&E on ${SQUARES[pos].name} to the bank`, { cash: proceeds, accDep: b.dep, ppe: -b.cost, gain: book - proceeds });
  t.building = null;
  log(g, `${p.name} sells the building on ${SQUARES[pos].name} for ${money(proceeds)}.`);
}

function sellLand(g, p, t, pos) {
  if (t.building) sellBuilding(g, p, t, pos);
  const sq = SQUARES[pos];
  const proceeds = Math.round(sq.price * CONFIG.liquidation);
  post(p, `Sold ${sq.name} to the bank`, { cash: proceeds, land: -sq.price, gain: sq.price - proceeds });
  t.owner = null;
  t.zone = null;
  log(g, `${p.name} sells ${sq.name} for ${money(proceeds)}.`);
}

function bankrupt(g, p, text) {
  if (p.out) return;
  const idx = g.players.indexOf(p);
  g.tiles.forEach((t) => {
    if (t?.owner === idx) Object.assign(t, { owner: null, zone: null, building: null });
  });
  p.out = true;
  log(g, text);
}

// ---- Fiscal year end ----

function fiscalYearEnd(g, p) {
  p.years += 1;
  post(p, 'Core business revenue', { cash: CONFIG.baseRevenue, revOps: -CONFIG.baseRevenue });
  const idx = g.players.indexOf(p);
  g.tiles.forEach((t, pos) => {
    if (t?.owner !== idx || !t.building) return;
    const earned = Math.round(t.building.cost * ZONES[t.zone].yearly);
    if (earned) post(p, `Operations at ${SQUARES[pos].name}`, { cash: earned, revOps: -earned });
    const dep = Math.min(Math.round(t.building.cost * CONFIG.depreciation), t.building.cost - t.building.dep);
    if (dep) {
      t.building.dep += dep;
      post(p, `Depreciation on ${SQUARES[pos].name}`, { expDep: dep, accDep: -dep });
    }
  });

  if (p.ledger.loan < 0) charge(g, p, -p.ledger.loan * CONFIG.loanInterest, 'expInterest', 'Loan interest');
  if (p.out) return;

  const preTax = incomeStatement(p).preTax;
  if (preTax > 0 && p.taxWaived) {
    log(g, `${p.name}'s books show no taxable income this year.`);
  } else if (preTax > 0) {
    charge(g, p, preTax * CONFIG.corporateTax, 'expTax', 'Corporate income tax');
  }
  p.taxWaived = false;

  personalYearEnd(g, p);

  const statement = incomeStatement(p);
  p.report = { year: p.years, income: statement, balance: balanceSheet(p) };
  // Close the year: revenues, expenses and distributions roll into retained earnings.
  const closing = {};
  let total = 0;
  for (const a of TEMPORARY) {
    if (p.ledger[a]) {
      closing[a] = -p.ledger[a];
      total += p.ledger[a];
    }
  }
  if (total || Object.keys(closing).length) post(p, `Close fiscal year ${p.years}`, { ...closing, retained: total });
  log(g, `${p.name} closes fiscal year ${p.years} with net income of ${money(statement.netIncome)}.`);
}

function personalYearEnd(g, p) {
  const count = (id) => p.assets.filter((a) => a === id).length;
  p.deduction = count('intelligent') ? 100 : 0;
  const wealthy = count('wealthy');
  if (wealthy) p.personalCash += 10 ** wealthy;
  let attractive = count('attractive');
  while (attractive) {
    const cost = count('loyal') && attractive > 1 ? 25 : 10 ** attractive;
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
    for (const q of alive(g)) post(q, 'Economic boom', { cash: 500, revOther: -500 });
  },
  lawsuit(g, p) {
    charge(g, p, 750, 'expOther', 'Lawsuit settlement');
  },
  shipping(g) {
    g.players.forEach((q, i) => {
      const n = g.tiles.filter((t, pos) => t?.owner === i && SQUARES[pos].kind === 'transport').length;
      if (n && !q.out) post(q, 'Higher shipping rates', { cash: 150 * n, revOther: -150 * n });
    });
  },
};

const PLAYS = {
  bribe(g, p) {
    const cost = 100 * g.zoningRow.length;
    if (!g.zoningRow.length) return 'There are no zoning cards to replace.';
    if (companyCash(p) < cost) return 'Your company cannot afford it.';
    post(p, 'Consulting fees', { expOther: cost, cash: -cost }); // the bribe, as it appears in the books
    g.zoningDeck.unshift(...g.zoningRow.splice(0));
    refill(g.zoningRow, g.zoningDeck);
    log(g, `${p.name} has the zoning board's available cards replaced.`);
    return null;
  },
  embezzle(g, p, { amount }) {
    amount = Math.min(2000, Math.floor(Number(amount) || 2000), Math.floor(companyCash(p)));
    if (!(amount > 0)) return 'Your company has no cash to take.';
    post(p, 'Miscellaneous expenses', { expOther: amount, cash: -amount });
    p.personalCash += amount;
    log(g, `${p.name}'s company books ${money(amount)} of miscellaneous expenses.`);
    return null;
  },
  cook(g, p) {
    if (p.taxWaived) return 'Your books are already cooked for this year.';
    p.taxWaived = true;
    return null;
  },
  kickback(g, p) {
    for (const q of alive(g)) {
      if (q === p) continue;
      const paid = charge(g, q, 200, 'expOther', `Fees to ${p.name}`);
      if (paid) post(p, `Fees from ${q.name}`, { cash: paid, revOther: -paid });
    }
    log(g, `Every company pays ${p.name} a $200 fee.`);
    return null;
  },
  alienation(g, p, { target }) {
    const q = g.players[target];
    if (!q || q === p || q.out) return 'Pick another player.';
    if (q.assets.includes('loyal')) return `${q.name} has a Loyal Spouse; their spouses can't be taken.`;
    const spouses = q.assets.filter((a) => PERSONAL_CARDS[a].spouse);
    if (!spouses.length) return `${q.name} has no Spouse cards.`;
    if (p.personalCash < 1000) return 'You need $1,000 of personal cash.';
    p.personalCash -= 1000;
    q.assets = q.assets.filter((a) => !PERSONAL_CARDS[a].spouse);
    p.assets = p.assets.filter((a) => !PERSONAL_CARDS[a].spouse || a === 'loyal');
    p.assets.push(...spouses);
    log(g, `${p.name} pays $1,000 and takes ${q.name}'s spouse cards.`);
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
  if (!p.frauds) {
    log(g, `Interim Review: ${p.name}'s books are clean.`);
    return;
  }
  const n = p.frauds;
  p.frauds = 0;
  charge(g, p, n * CONFIG.fraudFine, 'expOther', 'Fraud penalties');
  if (p.out) return;
  p.pos = CPE_POS;
  p.skip = true;
  log(g, `Interim Review finds ${n} fraud${n > 1 ? 's' : ''} at ${p.name}'s company: ${money(n * CONFIG.fraudFine)} in fines and off to CPE.`);
}

function log(g, text) {
  g.log.push(text);
  if (g.log.length > LOG_SIZE) g.log.shift();
}

// ---- What each player may see ----

// Everything is public except other players' hands, unaudited frauds, journals and the decks.
export function viewFor(g, who) {
  return {
    turn: g.turn,
    phase: g.phase,
    dice: g.dice,
    winner: g.winner,
    endReason: g.endReason,
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
      cash: companyCash(p),
      personalCash: p.personalCash,
      assets: p.assets,
      portfolio: portfolio(p),
      netWorth: netWorth(p),
      handCount: p.hand.length,
      income: incomeStatement(p),
      balance: balanceSheet(p),
      report: p.report,
      atBank: Boolean(p.atBank),
      ...(i === who ? { hand: p.hand, journal: p.journal, frauds: p.frauds, taxWaived: p.taxWaived, deduction: p.deduction } : {}),
    })),
  };
}

function counts(arr) {
  const c = {};
  for (const x of arr) c[x] = (c[x] ?? 0) + 1;
  return c;
}

export { MODES, SETS };
