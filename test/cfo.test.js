import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQUARES, BOARD_SIZE, ISLAND_START, posOfSpace, CONFIG, M, ZONES, RARITIES, FRAUD_CARDS, MARKET_CARDS, RETAIL, SUPPLY } from '../src/cfo/data.js';
import { createGame, act, timeout, current, viewFor, acquisitionPrice, companyValue, fraudRisk, balanceSheet, incomeStatement, canBuild, netWorth, bankOptions, retailTerms, sideOf, winOptions, post, production, tradePrice, salvageValue, rezoneFee } from '../src/cfo/rules.js';

const count = (kind) => SQUARES.filter((s) => s.kind === kind && !s.island).length;

test('the board: 58 spaces, 4 corners, 44 land, 8 transport, 6 decks', () => {
  assert.equal(BOARD_SIZE, 62);
  assert.equal(SQUARES.length, 62 + 24);
  assert.equal(SQUARES.filter((s) => s.island).length, 24);
  assert.equal(count('land'), 44);
  assert.equal(count('transport'), 8);
  assert.equal(count('deck'), 6);
  assert.deepEqual(['fraud', 'market'].map((d) => SQUARES.filter((s) => s.deck === d).length), [2, 4]);
  assert.deepEqual([0, 21, 31, 52].map((p) => SQUARES[p].kind), ['fye', 'bank', 'cpe', 'review']);
  assert.equal(SQUARES[posOfSpace(5)].mode, 'rail');
  assert.equal(SQUARES[posOfSpace(54)].mode, 'air');
  // One zoning card per lot: the main board's 47 plus the island's, less its pre-zoned landmarks.
  const lots = SQUARES.filter((s) => s.kind === 'land' && !s.landmark).length;
  assert.equal(lots, 60);
  assert.equal(Object.values(ZONES).reduce((n, z) => n + z.count, 0), lots);
  assert.equal(Object.values(RARITIES).reduce((n, r) => n + r.count, 0), lots, 'one PP&E card per lot too');
});

// Plays a whole game with a simple greedy strategy, checking the books balance after every step.
function playOut(seed, players = 4, options = {}) {
  const g = createGame(Array.from({ length: players }, (_, i) => `P${i}`), seed, options);
  for (let steps = 0; g.phase !== 'over'; steps++) {
    assert.ok(steps < 5000, 'game should end');
    const w = g.turn;
    const p = current(g);
    if (g.phase === 'roll') act(g, w, { a: 'roll' });
    else if (g.phase === 'buy') {
      if (act(g, w, { a: 'buy', zone: 0 })) act(g, w, { a: 'pass' });
    } else {
      for (let pos = 0; pos < SQUARES.length; pos++) if (!canBuild(g, pos)) act(g, w, { a: 'build', pos, card: 0 });
      // Fly to the island when rich, and home again after a lap.
      if (SQUARES[p.pos].mode === 'air' && p.ledger.cash > M(2000)) act(g, w, { a: 'fly' });
      if (p.atTerminal && p.islandLaps) act(g, w, { a: 'fly', to: posOfSpace(16) });
      if (p.hand.length) act(g, w, { a: 'play', card: 0, target: (w + 1) % players, pos: 0, rarity: 'common' });
      if (p.atBank) act(g, w, { a: 'borrow', amount: M(1000) });
      if (p.sale) act(g, w, { a: 'sell', option: 'premium' });
      if (p.ledger.cash > M(12000)) act(g, w, { a: 'acquire', target: (w + 1) % players });
      if (p.ledger.cash > M(3000)) act(g, w, { a: 'pay', amount: M(1000) });
      while (p.personalCash >= CONFIG.personalAssetPrice && !act(g, w, { a: 'personal' }));
      // A diligent bookkeeper: records every document correctly and files the true statements.
      for (const d of p.docs) act(g, w, { a: 'record', doc: d.id, lines: d.lines });
      if (p.fyePending) assert.equal(act(g, w, { a: 'statements', ...p.fyePending.truth }), null);
      if (g.phase === 'over') break; // a clean-books bonus can win the game
      assert.equal(act(g, w, { a: 'end' }), null);
    }
    for (const q of g.players) {
      const b = balanceSheet(q);
      assert.ok(Math.abs(b.totalAssets - b.totalLiabilitiesAndEquity) < 0.01, 'assets = liabilities + equity');
      assert.equal(b.assets.cash, q.ledger.cash);
      const held = q.carried + g.tiles.reduce((n, t) => n + (t && t.owner === g.players.indexOf(q) ? t.stock : 0), 0);
      if (!q.out) assert.equal(held, q.ledger.inventory, 'every widget is somewhere');
    }
  }
  return g;
}

test('whole games finish with balanced books, from 2 to 6 players', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const g = playOut(seed, 2 + (seed % 5), { easyBooks: seed % 2 === 0, autoStatements: seed % 4 === 1, maxYears: 8 });
    assert.ok(g.winner !== null);
    assert.ok(g.endReason);
    if (!g.easyBooks) assert.ok(g.players.every((p) => p.misstatements === 0), 'perfect books have no misstatements');
  }
});

test('players record their own entries and file their own statements', () => {
  const g = createGame(['A', 'B'], 21);
  const p = g.players[0];
  // The starting capital is the first document to record.
  assert.equal(p.docs.length, 1);
  const [doc] = p.docs;
  assert.equal(doc.text, 'Owner invests starting capital: $300,000 received');
  const view = viewFor(g, 0).players[0];
  assert.equal(view.docs[0].lines, undefined, 'the right answer is not sent');
  assert.equal(view.income, undefined, 'true statements are hidden');
  assert.equal(viewFor(g, 1).players[0].docs, undefined, 'others cannot see your documents');

  assert.equal(act(g, 0, { a: 'record', doc: 99, lines: [['cash', M(3000)]] }), 'Pick a document to record.');
  assert.equal(act(g, 0, { a: 'record', doc: 1, lines: [['cash', M(3000)], ['capital', -M(2000)]] }), 'Debits must equal credits.');
  assert.equal(act(g, 0, { a: 'record', doc: 1, lines: [['cash', M(3000)], ['nonsense', -M(3000)]] }), 'Pick an account for every line.');
  assert.equal(act(g, 0, { a: 'record', doc: 1, lines: [['cash', M(3000)], ['revOps', -M(3000)]] }), null);

  // Pass FYE: statements are due by the next year end, so the turn can go on.
  p.pos = BOARD_SIZE - 2;
  act(g, 0, { a: 'roll' });
  if (g.phase === 'buy') act(g, 0, { a: 'pass' });
  assert.ok(p.fyePending);
  assert.equal(act(g, 0, { a: 'end' }), null);
  const truth = p.fyePending.truth;
  assert.equal(truth.balance.capital, CONFIG.startCompanyCash);
  assert.equal(truth.balance.cash, p.ledger.cash);
  // The statements are built from the player's own entries: they review them and submit.
  // The miscoded capital entry and any unrecorded year-end documents are the misstatements.
  const unrecorded = p.docs.filter((d) => d.year === 1 && !d.recorded).length;
  const preview = viewFor(g, 0).players[0].preview;
  assert.equal(preview.income.revOps, undefined);
  assert.equal(viewFor(g, 1).players[0].preview, undefined, 'others cannot see it');
  assert.equal(act(g, 0, { a: 'statements' }), null);
  assert.equal(JSON.stringify(p.filed.balance), JSON.stringify(preview.balance), 'what was previewed is what is filed');
  assert.ok(p.lastCheck.wrongFields.includes('capital'));
  assert.equal(p.lastCheck.corrections.length, 1 + unrecorded);
  assert.equal(p.misstatements, 1 + unrecorded);
  assert.equal(viewFor(g, 1).players[0].filed.balance.capital, preview.balance.capital, 'others see what was filed');
  assert.notEqual(preview.balance.capital, truth.balance.capital);

  // The Interim Review fines misstatements.
  const cash = p.ledger.cash;
  Object.assign(g, { turn: 0, phase: 'roll' });
  while (p.pos !== 52) {
    Object.assign(g, { turn: 0, phase: 'roll' });
    p.pos = 52 - 7;
    act(g, 0, { a: 'roll' });
  }
  assert.equal(p.misstatements, 0);
  assert.ok(p.ledger.cash < cash);
});

test('easy books record everything automatically', () => {
  const g = createGame(['A', 'B'], 21, { easyBooks: true });
  const p = g.players[0];
  assert.equal(p.docs.length, 0);
  p.pos = BOARD_SIZE - 2;
  act(g, 0, { a: 'roll' });
  assert.equal(p.fyePending, null);
  assert.ok(viewFor(g, 0).players[0].income);
});

test('personal cash moves to the cent and is taxed on the year\'s total', () => {
  const g = createGame(['A', 'B'], 21);
  const p = g.players[0];
  g.phase = 'act';
  let start = p.personalCash;
  assert.equal(act(g, 0, { a: 'pay', amount: 12345 }), null);
  assert.equal(p.personalCash - start, 12345 - Math.round(12345 * CONFIG.personalTax), 'any amount, less tax');
  start = p.personalCash;
  for (let i = 0; i < 5; i++) assert.equal(act(g, 0, { a: 'pay', amount: 101 }), null);
  const total = 12345 + 505;
  assert.equal(p.personalCash - start, 505 - (Math.round(total * CONFIG.personalTax) - Math.round(12345 * CONFIG.personalTax)), 'splitting a payout saves no tax');
});

test('only the player whose turn it is may act, and only in order', () => {
  const g = createGame(['A', 'B'], 7);
  assert.equal(act(g, 1, { a: 'roll' }), 'It is not your turn.');
  assert.equal(act(g, 0, { a: 'end' }), 'Roll first.');
  assert.equal(act(g, 0, { a: 'roll' }), null);
  assert.equal(act(g, 0, { a: 'roll' }), 'You have already rolled.');
  assert.equal(act(g, 0, { a: 'nonsense' }), 'Unknown action.');
});

test('buying land takes a zoning card and posts a journal entry', () => {
  const g = createGame(['A', 'B'], 1);
  const p = g.players[0];
  // Roll from the start until the player lands somewhere for sale.
  while (g.phase !== 'buy') {
    Object.assign(g, { phase: 'roll', turn: 0 });
    p.pos = 0;
    act(g, 0, { a: 'roll' });
  }
  const sq = SQUARES[p.pos];
  const zone = g.zoningRow[1];
  const cash = p.ledger.cash;
  assert.equal(act(g, 0, { a: 'buy', zone: 1 }), null);
  assert.equal(g.tiles[p.pos].owner, 0);
  assert.equal(g.tiles[p.pos].zone, sq.kind === 'land' ? zone : null);
  assert.equal(p.ledger.cash, cash - sq.price);
  if (sq.kind === 'transport') {
    // A transport tile is part land, part PP&E that depreciates.
    assert.equal(p.ledger.land, Math.round(sq.price * CONFIG.transportLand));
    assert.equal(p.ledger.ppe, sq.price - p.ledger.land);
    assert.equal(g.tiles[p.pos].building.basis, p.ledger.ppe);
  } else {
    assert.equal(p.ledger.land, sq.price);
  }
});

test('a fiscal year end pays your salary, depreciates, taxes and closes the books', () => {
  const g = createGame(['A', 'B'], 3);
  const p = g.players[0];
  Object.assign(g.tiles[posOfSpace(1)], { owner: 0, zone: 'residential', building: { rarity: 'rare', cost: 1000, dep: 0 } });
  p.pos = BOARD_SIZE - 2; // any roll passes FYE
  const personal = p.personalCash;
  act(g, 0, { a: 'roll' });
  assert.equal(p.years, 1);
  const r = p.report.income;
  assert.equal(r.revenue.revRent, 1000 * ZONES.residential.yearly, 'Residential pays its tenants\' rent at the year end');
  // Salary: the base plus a share of the profit before it, paid automatically and taxed.
  const profitBefore = r.preTax + r.expenses.expSalary;
  assert.equal(r.expenses.expSalary, CONFIG.salary + Math.round(profitBefore * CONFIG.salaryBonus));
  assert.equal(p.personalCash - personal, r.expenses.expSalary - Math.round(r.expenses.expSalary * CONFIG.personalTax));
  assert.equal(r.expenses.expDep, 100);
  assert.equal(r.tax, Math.max(0, Math.round(r.preTax * CONFIG.corporateTax)));
  assert.equal(incomeStatement(p).netIncome, 0, 'income accounts start the new year at zero');
  assert.equal(-p.ledger.retained, r.netIncome);
});

// Gives player i `n` widgets on their token, keeping the books balanced.
function give(p, n) {
  p.ledger.inventory += n;
  p.ledger.capital -= n;
  p.carried += n;
}

const store = (g, owner, n, rarity, cost, stock = 0) =>
  Object.assign(g.tiles[posOfSpace(n)], { owner, zone: 'retail', building: { rarity, cost, dep: 0 }, stock });

test('stores sell from their own shelves every turn: the land sets how many, the PP&E the price', () => {
  const g = createGame(['A', 'B'], 3);
  const p = g.players[0];
  const big = M(100000);
  give(p, big);
  p.carried = 0;
  const [l1, l2] = [posOfSpace(1), posOfSpace(2)];
  const n1 = SQUARES[l1].price * RETAIL.perLandDollar;
  const n2 = SQUARES[l2].price * RETAIL.perLandDollar;
  store(g, 0, 1, 'rare', 1000, big - 100);
  store(g, 0, 2, 'uncommon', 200, 100);
  assert.deepEqual(retailTerms(g, 0), { units: n1 + n2, minPrice: RETAIL.prices.uncommon, maxPrice: RETAIL.prices.rare, stores: 2 });
  g.phase = 'act';
  act(g, 0, { a: 'end' });
  assert.equal(g.tiles[l1].stock, big - 100 - n1, 'a store sells as many as its land allows');
  assert.equal(g.tiles[l2].stock, 0, 'and no more than it has');
  assert.equal(incomeStatement(p).revenue.revSales, Math.round(n1 * RETAIL.prices.rare) + Math.round(100 * RETAIL.prices.uncommon));
  assert.equal(incomeStatement(p).expenses.cogs, n1 + 100);
});

test('landing on a store: your own runs a special sale, someone else\'s sells through theirs', () => {
  const g = createGame(['A', 'B'], 3);
  const [a, b] = g.players;
  const pos = posOfSpace(1);
  const n = SQUARES[pos].price * RETAIL.perLandDollar; // a normal turn's sales at this store
  const price = RETAIL.prices.rare;
  give(a, 10 * n);
  a.carried = 0;
  give(b, 10 * n);
  b.carried = 0;
  Object.assign(g.tiles[posOfSpace(12)], { owner: 1, zone: 'industrial', building: { rarity: 'common', cost: 100, dep: 0 }, stock: 10 * n });
  store(g, 0, 1, 'rare', 1000, 10 * n);
  g.phase = 'act';
  assert.equal(act(g, 0, { a: 'sell', option: 'clearance' }), 'There is no sale to make here.');
  a.sale = { pos };
  assert.equal(act(g, 0, { a: 'sell', option: 'clearance' }), null);
  assert.equal(g.tiles[pos].stock, 7 * n); // 3 turns' worth at 75% of the price
  assert.equal(incomeStatement(a).revenue.revSales, Math.round(3 * n * price * 0.75));
  assert.equal(a.sale, null, 'one sale per landing');

  g.turn = 1;
  b.sale = { pos };
  const before = a.ledger.cash;
  assert.equal(act(g, 1, { a: 'sell' }), null);
  assert.equal(g.tiles[posOfSpace(12)].stock, 9 * n, 'wholesale from the factory\'s warehouse');
  assert.equal(incomeStatement(b).revenue.revSales, Math.round(n * price));
  assert.equal(a.ledger.cash, before + Math.round(n * price * RETAIL.commission), 'the store owner keeps a commission');
  for (const p of g.players) {
    const s = balanceSheet(p);
    assert.ok(Math.abs(s.totalAssets - s.totalLiabilitiesAndEquity) < 0.01);
  }
});

test('factories make what the stores need each turn, and logistics ship it to them', () => {
  const g = createGame(['A', 'B'], 3);
  const [a, b] = g.players;
  const factory = posOfSpace(12); // top
  const cost = M(100);
  Object.assign(g.tiles[factory], { owner: 0, zone: 'industrial', building: { rarity: 'common', cost, dep: 0 }, stock: 0 });
  const cap = Math.round(ZONES.industrial.produce * Math.sqrt(cost * SQUARES[factory].price));
  assert.equal(production(factory, cost), cap, 'the building and the land count equally');
  const shop = posOfSpace(30); // bottom
  store(g, 0, 30, 'common', 100);
  const rail = posOfSpace(5); // top
  g.tiles[rail].owner = 1;
  assert.equal(sideOf(rail), sideOf(factory));

  // At the end of the turn the factory runs, paid from company cash, and B's railway on the
  // factory's side carries the widgets to the bottom store for freight. The store then sells them.
  const cash = a.ledger.cash;
  const bCash = b.ledger.cash;
  Object.assign(g, { turn: 0, phase: 'act' });
  act(g, 0, { a: 'end' });
  const freight = Math.round(cap * RETAIL.freight);
  assert.equal(b.ledger.cash, bCash + freight);
  assert.equal(g.tiles[factory].stock, 0);
  assert.equal(a.ledger.inventory, 0, 'everything shipped and sold');
  assert.equal(a.ledger.cash, cash - cap - freight + cap * RETAIL.prices.common);

  // Production is planned to demand: a store already holding its target gets nothing more made.
  const target = SQUARES[shop].price * RETAIL.perLandDollar * SUPPLY.levels.demand.cover;
  give(a, 2 * target);
  a.carried = 0;
  g.tiles[shop].stock = 2 * target;
  Object.assign(g, { turn: 0, phase: 'act' });
  act(g, 0, { a: 'end' });
  assert.equal(a.ledger.inventory, g.tiles[shop].stock, 'nothing new was made');

  // The dial: idle makes nothing; full capacity makes all it can, even with stores stocked.
  assert.equal(act(g, 1, { a: 'production', level: 'idle' }), null, 'any company can turn its own dial, on any turn');
  assert.equal(act(g, 0, { a: 'production', level: 'loud' }), 'Pick a production level.');
  act(g, 0, { a: 'production', level: 'full' });
  const held = a.ledger.inventory;
  Object.assign(g, { turn: 0, phase: 'act' });
  act(g, 0, { a: 'end' });
  const turnSales = SQUARES[shop].price * RETAIL.perLandDollar;
  assert.equal(a.ledger.inventory, held + cap - turnSales, 'a full shift is made though the store was stocked');
  act(g, 0, { a: 'production', level: 'idle' });
  const stocked = a.ledger.inventory;
  g.tiles[shop].stock -= 1; // room on the shelves
  give(a, -1);
  a.carried = 0;
  Object.assign(g, { turn: 0, phase: 'act' });
  act(g, 0, { a: 'end' });
  assert.ok(a.ledger.inventory < stocked, 'idle makes nothing');
  act(g, 0, { a: 'production', level: 'demand' });

  // With no transport on the factory's side, goods for another side wait in the factory.
  g.tiles[rail].owner = null;
  give(a, -g.tiles[shop].stock);
  a.carried = 0;
  g.tiles[shop].stock = 0;
  Object.assign(g, { turn: 0, phase: 'act' });
  act(g, 0, { a: 'end' });
  assert.equal(g.tiles[factory].stock, cap);
  assert.equal(g.tiles[shop].stock, 0);

  // Landing on your own factory runs an overtime shift.
  for (let s = 1; ; s++) {
    Object.assign(g, { turn: 0, phase: 'roll', seed: s });
    a.pos = factory - 7;
    const before = g.tiles[factory].stock;
    act(g, 0, { a: 'roll' });
    if (a.pos === factory) {
      assert.equal(g.tiles[factory].stock - before, cap * ZONES.industrial.overtime);
      break;
    }
  }
  for (const p of g.players) {
    const s = balanceSheet(p);
    assert.ok(Math.abs(s.totalAssets - s.totalLiabilitiesAndEquity) < 0.01);
  }
});

test('loans add a liability and charge interest at year end', () => {
  const g = createGame(['A', 'B'], 4);
  const p = g.players[0];
  g.phase = 'act';
  assert.match(act(g, 0, { a: 'borrow', amount: 500 }), /Bank/);
  p.atBank = true;
  assert.match(act(g, 0, { a: 'borrow', amount: CONFIG.loanLimit + 100 }), /at most/);
  assert.equal(act(g, 0, { a: 'borrow', amount: 2000 }), null);
  assert.equal(balanceSheet(p).liabilities.loan, 2000);
  assert.equal(act(g, 0, { a: 'repay', amount: 500 }), null);
  assert.equal(balanceSheet(p).liabilities.loan, 1500);
  // Repaying everything before the year end still pays interest on the most owed this year.
  assert.equal(act(g, 0, { a: 'repay', amount: 1500 }), null);
  Object.assign(g, { turn: 0, phase: 'roll' });
  p.pos = BOARD_SIZE - 2;
  act(g, 0, { a: 'roll' });
  assert.equal(p.report.income.expenses.expInterest, 2000 * CONFIG.loanInterest);
  // With nothing borrowed the next year, there is no interest.
  Object.assign(g, { turn: 0, phase: 'roll' });
  p.pos = BOARD_SIZE - 2;
  act(g, 0, { a: 'roll' });
  assert.equal(p.report.income.expenses.expInterest, 0);
});

test('a Shell Company loan is due to an affiliate, outside the Bank limit and its interest', () => {
  const g = createGame(['A', 'B'], 4, { easyBooks: true });
  const p = g.players[0];
  p.hand = ['shell'];
  g.phase = 'act';
  assert.equal(act(g, 0, { a: 'play', card: 0 }), null);
  assert.equal(balanceSheet(p).liabilities.affiliateLoan, M(1500));
  assert.equal(balanceSheet(p).liabilities.loan, 0);
  p.atBank = true;
  assert.equal(act(g, 0, { a: 'borrow', amount: CONFIG.loanLimit }), null, 'the Bank still lends its full limit');
  const s = balanceSheet(p);
  assert.ok(Math.abs(s.totalAssets - s.totalLiabilitiesAndEquity) < 0.01);
});

test('fraud: more of it means likelier to be caught, and being caught is an immediate loss', () => {
  const g = createGame(['A', 'B', 'C'], 5);
  const p = g.players[0];
  p.hand = ['cook'];
  g.phase = 'act';
  assert.match(act(g, 0, { a: 'play', card: 0 }), /no expenses/);
  post(p, 'Legal fees', { expOther: M(3000), cash: -M(3000) });
  const before = incomeStatement(p).netIncome;
  assert.equal(act(g, 0, { a: 'play', card: 0 }), null);
  assert.equal(incomeStatement(p).netIncome, before + M(2000), 'cooked books show more profit');
  assert.equal(p.ledger.ppe, M(2000));
  assert.equal(p.frauds, 1);
  assert.equal(viewFor(g, 1).players[0].frauds, undefined, 'others cannot see frauds');
  assert.equal(viewFor(g, 1).players[0].hand, undefined, 'others cannot see the hand');
  const one = fraudRisk(p, CONFIG.auditFraudChance);
  assert.ok(Math.abs(one - CONFIG.auditFraudChance) < 1e-9);
  p.frauds = 3;
  assert.ok(Math.abs(fraudRisk(p, CONFIG.auditFraudChance) - 9 * one) < 1e-9, 'risk grows with the square of the frauds');
  p.isPublic = true;
  assert.ok(fraudRisk(p, CONFIG.auditFraudChance) > fraudRisk({ ...p, isPublic: false }, CONFIG.auditFraudChance), 'public companies are watched harder');
  p.isPublic = false;
  p.frauds = 6;
  // Keep landing on the Interim Review until the frauds are found: the player is out at once.
  for (let i = 0; i < 200 && !p.out; i++) {
    Object.assign(g, { turn: 0, phase: 'roll' });
    p.pos = 52 - 7;
    act(g, 0, { a: 'roll' });
  }
  assert.ok(p.out, 'caught sooner or later');
  assert.match(g.log.join(' '), /convicted/);
});

test('the turn timer plays an absent player\'s turn through', () => {
  const g = createGame(['A', 'B', 'C'], 9);
  timeout(g);
  assert.notEqual(g.turn, 0);
  assert.equal(g.phase, 'roll');
});

test('resigning leaves the last company standing as the winner', () => {
  const g = createGame(['A', 'B'], 2);
  assert.equal(act(g, 1, { a: 'resign' }), null);
  assert.equal(g.phase, 'over');
  assert.equal(g.winner, 0);
  assert.ok(netWorth(g, g.players[0]) > 0);
});

test('each Banking building shows its owner one more private PP&E option', () => {
  const g = createGame(['A', 'B'], 11);
  const p = g.players[0];
  g.phase = 'act';
  p.ledger.cash = 1e6;
  const bank = posOfSpace(1);
  const empty = posOfSpace(2);
  Object.assign(g.tiles[bank], { owner: 0, zone: 'banking', building: { rarity: 'common', cost: 100, dep: 0 } });
  Object.assign(g.tiles[empty], { owner: 0, zone: 'industrial', building: null });
  assert.equal(bankOptions(g, 0).length, 1);
  assert.equal(bankOptions(g, 1).length, 0);
  assert.deepEqual(viewFor(g, 0).players[0].bankOptions, [g.ppeDeck.at(-1)]);
  assert.equal(viewFor(g, 1).players[0].bankOptions, undefined, 'others cannot see it');
  const extra = g.ppeDeck.at(-1);
  const left = g.ppeDeck.length;
  const row = [...g.ppeRow];
  assert.equal(act(g, 0, { a: 'build', pos: empty, card: g.ppeRow.length }), null);
  assert.equal(g.tiles[empty].building.rarity, extra);
  assert.equal(g.ppeDeck.length, left - 1);
  assert.deepEqual(g.ppeRow, row, 'the face-up row is untouched');
  assert.equal(act(g, 0, { a: 'build', pos: empty, card: 9 }), 'Pick a PP&E card.');
});

test('frauds can also be found when passing FYE', () => {
  let caught = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const g = createGame(['A', 'B', 'C'], seed, { easyBooks: true });
    const p = g.players[0];
    p.frauds = 8;
    p.pos = BOARD_SIZE - 2;
    act(g, 0, { a: 'roll' });
    if (p.out) caught += 1;
  }
  const expected = 200 * CONFIG.fyeFraudChance * 8 ** 2;
  assert.ok(caught > expected / 3 && caught < expected * 2, `about ${Math.round(expected)} of 200 caught, got ${caught}`);
});

test('going public raises cash, prices the company above its books, and doubles scrutiny', () => {
  const g = createGame(['A', 'B'], 31, { easyBooks: true });
  const [a, b] = g.players;
  g.phase = 'act';
  assert.match(act(g, 0, { a: 'ipo' }), /fiscal years/);
  a.years = CONFIG.ipoYears;
  const worth = netWorth(g, a);
  assert.equal(act(g, 0, { a: 'ipo' }), null);
  // Equity $300,000 x 1.2 / 100 shares = $3,600 a share; 25 new shares raise $90,000.
  assert.equal(CONFIG.publicPremium, 1.2);
  assert.equal(a.ledger.cash, M(3900));
  assert.equal(a.shares.public, 25);
  assert.equal(act(g, 0, { a: 'ipo' }), 'Your company is already public.');
  assert.ok(netWorth(g, a) > worth, 'the market premium counts toward net worth');

  // B buys shares with personal cash, then gets a cut of A's distributions.
  g.turn = 1;
  const bStart = b.personalCash;
  const price = tradePrice(a);
  assert.equal(act(g, 1, { a: 'trade', target: 0, count: 2 }), null);
  // Two shares cost their market price, rounded up to the cent.
  assert.equal(b.personalCash, bStart - Math.ceil(2 * price));
  assert.equal(a.shares.holders[1], 2);
  g.turn = 0;
  const aPersonal = a.personalCash;
  const bPersonal = b.personalCash;
  assert.equal(act(g, 0, { a: 'pay', amount: M(1400) }), null);
  // A holds 100 of 125 shares and B holds 2; each share of the payout is taxed at 20%.
  const net = (x) => x - Math.round(x * CONFIG.personalTax);
  assert.equal(a.personalCash, aPersonal + net(M(1400) * 100 / 125));
  assert.equal(b.personalCash, bPersonal + net(M(1400) * 2 / 125));
  g.turn = 1;
  // Small holdings can still be sold, at the price rounded down to the cent.
  const sell = tradePrice(a);
  assert.equal(act(g, 1, { a: 'trade', target: 0, count: -2 }), null);
  assert.equal(b.personalCash, bPersonal + net(M(1400) * 2 / 125) + Math.floor(2 * sell));
});

test('a knocked-out player can be hired to run a subsidiary', () => {
  const g = createGame(['A', 'B', 'C'], 32, { easyBooks: true });
  const [a, b, c] = g.players;
  assert.equal(act(g, 2, { a: 'resign' }), null);
  assert.ok(c.out);
  g.phase = 'act';
  assert.match(act(g, 0, { a: 'hire', target: 1, amount: M(1000) }), /out of the game/);
  assert.match(act(g, 0, { a: 'hire', target: 2, amount: M(500) }), /at least/);
  assert.equal(act(g, 0, { a: 'hire', target: 2, amount: M(1000) }), null);
  assert.equal(c.out, false);
  assert.equal(c.parent, 0);
  assert.equal(c.ledger.cash, M(1000));
  assert.equal(a.ledger.investments, M(1000));
  assert.deepEqual(c.shares.holders, { 0: 75, 2: 25 });

  // The subsidiary's distribution goes 75% to A's company, 25% to C personally.
  g.turn = 2;
  const cPersonal = c.personalCash;
  assert.equal(act(g, 2, { a: 'pay', amount: M(400) }), null);
  assert.equal(a.ledger.revDividends, -M(300));
  assert.equal(c.personalCash, cPersonal + M(100) - Math.round(M(100) * CONFIG.personalTax));
  for (const p of [a, b, c]) {
    const s = balanceSheet(p);
    assert.ok(Math.abs(s.totalAssets - s.totalLiabilitiesAndEquity) < 0.01);
  }
});

test('every Fraud and Market Forces card can be played or drawn and keeps the books balanced', () => {
  for (const id of [...Object.keys(FRAUD_CARDS), ...Object.keys(MARKET_CARDS)]) {
    const g = createGame(['A', 'B', 'C'], 41, { easyBooks: true });
    const [a, b] = g.players;
    // Set the table up so every card has something to act on.
    a.years = CONFIG.ipoYears;
    g.phase = 'act';
    act(g, 0, { a: 'ipo' });
    const land = posOfSpace(1);
    Object.assign(g.tiles[land], { owner: 0, zone: 'industrial', building: null });
    Object.assign(g.tiles[posOfSpace(2)], { owner: 0, zone: 'retail', building: { rarity: 'common', cost: M(100), dep: 0 }, stock: M(50) });
    Object.assign(g.tiles[posOfSpace(3)], { owner: 1, zone: 'residential', building: { rarity: 'common', cost: M(100), dep: 0 }, stock: 0 });
    a.ledger.inventory += M(50);
    a.ledger.capital -= M(50);
    b.assets.push('wealthy');
    a.frauds = 2; // so the cards that clear frauds have something to clear
    post(a, 'Legal fees', { expOther: M(500), cash: -M(500) }); // something for Cook the Books to move
    a.personalCash = M(2000);
    a.atBank = true;
    act(g, 0, { a: 'borrow', amount: M(500) });
    const keep = (FRAUD_CARDS[id] ?? MARKET_CARDS[id]).keep;
    if (keep) {
      a.hand = [id];
      const err = act(g, 0, { a: 'play', card: 0, target: id === 'insider' ? 0 : 1, pos: land, row: 1, rarity: 'common', amount: M(500) });
      assert.equal(err, null, `${id}: ${err}`);
      assert.equal(a.hand.length, 0, id);
    } else {
      g.marketDeck = [id];
      a.pos = posOfSpace(8) - 2; // the Market Forces square
      g.phase = 'roll';
      while (a.pos !== posOfSpace(8)) {
        Object.assign(g, { turn: 0, phase: 'roll' });
        a.pos = posOfSpace(8) - 2;
        g.marketDeck = [id];
        act(g, 0, { a: 'roll' });
      }
    }
    for (const p of g.players) {
      const s = balanceSheet(p);
      assert.ok(Math.abs(s.totalAssets - s.totalLiabilitiesAndEquity) < 0.01, id);
    }
  }
});

test('win conditions: company value, a year limit, and second place for the largest subsidiary', () => {
  const g = createGame(['A', 'B', 'C'], 51, { easyBooks: true, valueTarget: M(5000) });
  const [a] = g.players;
  g.phase = 'act';
  post(a, 'Windfall', { cash: M(2000), revOther: -M(2000) });
  act(g, 0, { a: 'end' });
  assert.equal(g.phase, 'over');
  assert.equal(g.winner, 0);
  assert.match(g.endReason, /company worth \$500,000/);

  const h = createGame(['A', 'B', 'C'], 52, { easyBooks: true });
  assert.deepEqual(h.win, { valueTarget: CONFIG.valueTarget, maxYears: CONFIG.maxYears });
  act(h, 2, { a: 'resign' });
  h.phase = 'act';
  act(h, 0, { a: 'hire', target: 2, amount: M(1000) });
  act(h, 1, { a: 'resign' });
  assert.equal(h.phase, 'over');
  assert.equal(h.winner, 0);
  assert.equal(h.second, 2, 'C runs the largest subsidiary');

  assert.deepEqual(winOptions({ valueTarget: -5, maxYears: 'x' }), { valueTarget: CONFIG.valueTarget, maxYears: CONFIG.maxYears });
  assert.deepEqual(winOptions({ maxYears: 0 }).maxYears, 0, 'a room can turn the year limit off');
});

test('the island: fly in for a fare, loop it, buy a landmark, and fly home from the Terminal', () => {
  const g = createGame(['A', 'B'], 8, { valueTarget: M(1e6) });
  const [a, b] = g.players;
  const airport = posOfSpace(34);
  post(a, 'Test capital', { cash: M(20000), capital: -M(20000) });

  // Nobody owns the airport yet, so there are no flights.
  Object.assign(g, { turn: 0, phase: 'act' });
  a.pos = airport;
  assert.match(act(g, 0, { a: 'fly' }), /Nobody/);

  // B's airport flies A to the Terminal, and B keeps the fare.
  g.tiles[airport].owner = 1;
  const bCash = b.ledger.cash;
  assert.equal(act(g, 0, { a: 'fly' }), null);
  assert.equal(a.pos, ISLAND_START);
  assert.equal(b.ledger.cash, bCash + CONFIG.islandFare);
  assert.equal(incomeStatement(a).expenses.expFreight, CONFIG.islandFare);
  assert.match(act(g, 0, { a: 'fly', to: airport }), /already flown/);

  // Landmarks come with their zone and building.
  const resort = SQUARES.findIndex((s) => s.landmark === 'resort');
  Object.assign(g, { turn: 0, phase: 'buy' });
  a.pos = resort;
  assert.equal(act(g, 0, { a: 'buy' }), null);
  assert.equal(g.tiles[resort].zone, 'residential');
  assert.equal(g.tiles[resort].building.rarity, 'landmark');
  assert.ok(canBuild(g, resort));

  // Looping past the Terminal counts a lap, and only then can A fly home.
  Object.assign(g, { turn: 0, phase: 'act' });
  a.flew = false;
  assert.match(act(g, 0, { a: 'fly', to: airport }), /Terminal/);
  Object.assign(g, { turn: 0, phase: 'roll' });
  a.pos = ISLAND_START + 23;
  act(g, 0, { a: 'roll' });
  assert.ok(a.pos > ISLAND_START && a.pos < ISLAND_START + 24, 'stays on the island');
  assert.equal(a.islandLaps, 1);
  if (g.phase === 'buy') act(g, 0, { a: 'pass' });
  const before = b.ledger.cash;
  assert.equal(act(g, 0, { a: 'fly', to: airport }), null);
  assert.equal(a.pos, airport);
  assert.equal(b.ledger.cash, before + CONFIG.islandFare);
  const bs = balanceSheet(a);
  assert.ok(Math.abs(bs.totalAssets - bs.totalLiabilitiesAndEquity) < 0.01);
});

test('the portfolio win needs a lap of the island', () => {
  const g = createGame(['A', 'B'], 9);
  const a = g.players[0];
  a.assets.push(...Array(200).fill('mansion'));
  a.personalCash = CONFIG.portfolioGoal;
  Object.assign(g, { turn: 0, phase: 'act' });
  act(g, 0, { a: 'end' });
  assert.notEqual(g.phase, 'over');
  a.islandLaps = 1;
  Object.assign(g, { turn: 0, phase: 'act' });
  act(g, 0, { a: 'end' });
  assert.equal(g.phase, 'over');
  assert.equal(g.winner, 0);
});

test('your own transport ships to other sides free, even while you are away', () => {
  const g = createGame(['A', 'B'], 10);
  const a = g.players[0];
  const factory = posOfSpace(12); // top
  Object.assign(g.tiles[factory], { owner: 0, zone: 'industrial', building: { rarity: 'common', cost: 100, dep: 0 }, stock: 0 });
  give(a, 200);
  a.carried = 0;
  g.tiles[factory].stock = 200;
  const shop = posOfSpace(30); // bottom
  store(g, 0, 30, 'common', 100);
  g.tiles[posOfSpace(34)].owner = 0; // A's airport on the bottom side
  g.tiles[posOfSpace(5)].owner = 0; // A's railway on the top side
  // A is away on the island; at the end of the turn A's railway ships the top factory's stock to the bottom store.
  Object.assign(g, { turn: 0, phase: 'act' });
  a.pos = ISLAND_START + 3;
  assert.equal(act(g, 0, { a: 'end' }), null);
  assert.equal(g.tiles[factory].stock, 0);
  // Whatever the store didn't sell this turn is on its shelves.
  assert.ok(a.ledger.inventory < 200, 'some sold');
  assert.equal(g.tiles[shop].stock, a.ledger.inventory);
});

test('statements not filed by the next year end are filed blank', () => {
  const g = createGame(['A', 'B'], 22);
  const p = g.players[0];
  for (let year = 1; year <= 2; year++) {
    Object.assign(g, { turn: 0, phase: 'roll' });
    p.pos = BOARD_SIZE - 2;
    act(g, 0, { a: 'roll' });
  }
  assert.equal(p.fyePending.year, 2);
  assert.equal(p.filed.year, 1);
  assert.ok(p.misstatements > 0);
});

test('auto statements are built from the entries players record', () => {
  for (const mistake of [false, true]) {
    const g = createGame(['A', 'B'], 23, { autoStatements: true });
    const p = g.players[0];
    Object.assign(g, { turn: 0, phase: 'roll' });
    p.pos = BOARD_SIZE - 2;
    act(g, 0, { a: 'roll' });
    assert.ok(p.fyePending);
    for (const d of p.docs) act(g, 0, { a: 'record', doc: d.id, lines: d.lines });
    if (mistake) {
      // Book the starting capital as revenue instead.
      const first = p.docs[0];
      act(g, 0, { a: 'record', doc: first.id, lines: [['cash', 3000], ['revOther', -3000]] });
    }
    assert.equal(act(g, 0, { a: 'statements', income: { revOther: 999999 } }), null, 'typed numbers are ignored');
    if (mistake) {
      assert.ok(p.lastCheck.wrongFields.includes('capital'));
      assert.ok(p.lastCheck.wrongFields.includes('revOther'));
      assert.equal(p.lastCheck.corrections.length, 1);
      assert.equal(p.lastCheck.errors, 1, 'one wrong entry is one misstatement');
    } else {
      assert.equal(p.lastCheck.errors, 0);
      assert.equal(p.filed.balance.cash, p.lastCheck.truth.balance.cash);
    }
    // A second year carries the books forward, with the review's corrections in them.
    Object.assign(g, { turn: 0, phase: 'roll' });
    p.pos = BOARD_SIZE - 2;
    act(g, 0, { a: 'roll' });
    for (const d of p.docs) act(g, 0, { a: 'record', doc: d.id, lines: d.lines });
    assert.equal(act(g, 0, { a: 'statements' }), null);
    assert.equal(p.lastCheck.year, 2);
    assert.equal(p.lastCheck.errors, 0);
  }
});

test('buying a rival company takes it out of the game; public companies cost more', () => {
  const g = createGame(['A', 'B', 'C'], 24, { easyBooks: true, valueTarget: M(1e6) });
  const [a, b, c] = g.players;
  post(a, 'Test capital', { cash: M(20000), capital: -M(20000) });
  const lot = posOfSpace(1);
  g.tiles[lot].owner = 1;
  post(b, 'Bought land', { land: 80, cash: -80 });
  post(b, 'Test capital', { cash: M(10000), capital: -M(10000) });
  Object.assign(g, { turn: 0, phase: 'act' });

  const privatePrice = acquisitionPrice(b);
  assert.equal(privatePrice, Math.ceil(Math.max(CONFIG.acquireMin, companyValue(b) * CONFIG.acquirePremium) / CONFIG.personalUnit) * CONFIG.personalUnit);
  b.isPublic = true;
  assert.ok(acquisitionPrice(b) > privatePrice, 'public companies cost more');
  b.isPublic = false;

  const bPersonal = b.personalCash;
  assert.equal(act(g, 0, { a: 'acquire', target: 1 }), null);
  assert.ok(b.out);
  assert.equal(g.tiles[lot].owner, 0);
  assert.equal(b.personalCash, bPersonal + privatePrice, 'B owned all of it and is paid in full');
  assert.ok(a.ledger.goodwill > 0);
  const bs = balanceSheet(a);
  assert.ok(Math.abs(bs.totalAssets - bs.totalLiabilitiesAndEquity) < 0.01);
  assert.match(act(g, 0, { a: 'acquire', target: 1 }), /rival/);
  assert.notEqual(g.phase, 'over');
  // Buying the last rival wins.
  post(a, 'More capital', { cash: M(40000), capital: -M(40000) });
  assert.equal(act(g, 0, { a: 'acquire', target: 2 }), null);
  assert.equal(g.phase, 'over');
  assert.equal(g.winner, 0);
  assert.ok(c.out);
});

test('crafted actions get a plain error and never touch object internals', () => {
  const g = createGame(['A', 'B'], 51);
  g.players[0].hand = ['cook'];
  g.phase = 'act';
  for (const a of ['constructor', '__proto__', 'hasOwnProperty', 'toString']) assert.equal(typeof act(g, 1, { a }), 'string');
  assert.equal(act(g, 0, { a: 'play', card: 'length' }), 'Pick a card from your hand.');
  assert.equal(act(g, 0, { a: 'record', doc: 1, lines: [['constructor', 5], ['cash', -5]] }), 'Pick an account for every line.');
  g.players[0].pos = ISLAND_START;
  g.players[0].atTerminal = true;
  assert.equal(act(g, 0, { a: 'fly', to: '16' }), 'Pick an airport.');
  assert.equal(g.players[0].pos, ISLAND_START);
});

test('a fire sale for fees sells only the widgets it needs, and never ones already shipped', () => {
  const g = createGame(['A', 'B'], 52, { easyBooks: true });
  const a = g.players[0];
  post(a, 'Made widgets', { inventory: M(1000), cash: -M(1000) });
  a.carried = M(1000);
  post(a, 'Spent', { expOther: a.ledger.cash, cash: -a.ledger.cash });
  Object.assign(g, { turn: 1, phase: 'act' });
  // B's store stands to receive nothing; A owes B rent it can only pay by selling widgets.
  const lot = SQUARES.findIndex((s) => s.kind === 'land' && !s.island);
  Object.assign(g.tiles[lot], { owner: 1, zone: 'residential' });
  Object.assign(g, { turn: 0, phase: 'roll' });
  a.pos = lot;
  timeout(g); // roll on: lands somewhere, maybe charged
  const total = a.carried + g.tiles.reduce((n, t) => n + (t?.owner === 0 ? t.stock : 0), 0);
  assert.equal(total, a.ledger.inventory, 'widgets on the board match the books');
  assert.ok(a.ledger.inventory >= 0);
});

test('shares trade at the market price to the cent, so even cheap shares can be sold', () => {
  const g = createGame(['A', 'B'], 53, { easyBooks: true });
  const [a, b] = g.players;
  a.years = CONFIG.ipoYears;
  g.phase = 'act';
  assert.equal(act(g, 0, { a: 'ipo' }), null);
  // Pay nearly everything out: shares are now worth a few dollars each.
  assert.equal(act(g, 0, { a: 'pay', amount: a.ledger.cash - M(100) }), null);
  const price = tradePrice(a);
  const before = a.personalCash;
  assert.equal(act(g, 0, { a: 'trade', target: 0, count: -1 }), null);
  assert.equal(a.personalCash, before + Math.floor(price));
  g.turn = 1;
  const bCash = b.personalCash;
  assert.equal(act(g, 1, { a: 'trade', target: 0, count: 1 }), null);
  assert.equal(b.personalCash, bCash - Math.ceil(tradePrice(a)));
});

test('subsidiaries: no nested hires, failed ones are written off, and cards and zoning go back', () => {
  const g = createGame(['A', 'B', 'C', 'D'], 54, { easyBooks: true });
  const [a, , c, d] = g.players;
  c.hand = ['backdate', 'cook'];
  const fraudCards = () => g.fraudDeck.length + g.fraudDiscard.length + g.players.reduce((n, p) => n + p.hand.filter((h) => FRAUD_CARDS[h]).length, 0);
  const cardsBefore = fraudCards();
  const lot = SQUARES.findIndex((s) => s.kind === 'land' && !s.island);
  Object.assign(g.tiles[lot], { owner: 2, zone: 'retail' });
  const zoningBefore = g.zoningDeck.length + g.zoningRow.length;
  act(g, 2, { a: 'resign' });
  act(g, 3, { a: 'resign' });
  assert.equal(fraudCards(), cardsBefore, 'cards in hand go back to the discard pile');
  assert.equal(g.zoningDeck.length + g.zoningRow.length, zoningBefore + 1, 'zoning goes back to the deck');
  assert.equal(g.tiles[lot].zone, null);
  Object.assign(g, { turn: 0, phase: 'act' });
  assert.equal(act(g, 0, { a: 'hire', target: 2, amount: M(1000) }), null);
  Object.assign(g, { turn: 2, phase: 'act' });
  assert.match(act(g, 2, { a: 'hire', target: 3, amount: M(1000) }), /cannot hire/);
  assert.equal(d.out, true);
  // C's subsidiary fails: A's investment in it is written off.
  act(g, 2, { a: 'resign' });
  assert.equal(a.ledger.investments, 0);
  assert.equal(a.ledger.expOther, M(1000));
});

test('a convicted manager is watched more closely when hired back', () => {
  const g = createGame(['A', 'B', 'C'], 55, { easyBooks: true });
  const c = g.players[2];
  c.frauds = 1;
  assert.ok(Math.abs(fraudRisk(c, 0.2) - 0.2) < 1e-9);
  c.convicted = true;
  act(g, 2, { a: 'resign' });
  Object.assign(g, { turn: 0, phase: 'act' });
  assert.equal(act(g, 0, { a: 'hire', target: 2, amount: M(1000) }), null);
  assert.equal(c.frauds, 0, 'the new company starts with clean books');
  c.frauds = 1;
  assert.ok(Math.abs(fraudRisk(c, 0.2) - 0.4) < 1e-9, 'but the record doubles the scrutiny');
});

test('an absent player\'s books are kept for them when their turn times out', () => {
  const g = createGame(['A', 'B'], 56);
  const a = g.players[0];
  Object.assign(g, { turn: 0, phase: 'roll' });
  a.pos = BOARD_SIZE - 2;
  act(g, 0, { a: 'roll' });
  assert.ok(a.fyePending);
  act(g, 0, { a: 'end' });
  act(g, 1, { a: 'roll' });
  act(g, 1, { a: 'end' });
  if (g.phase === 'buy') act(g, 1, { a: 'pass' });
  if (g.turn === 1) act(g, 1, { a: 'end' });
  assert.equal(g.turn, 0);
  timeout(g);
  assert.equal(a.fyePending, null);
  assert.equal(a.lastCheck.errors, 0);
});

test('with manual books, rivals see only filed figures and market prices', () => {
  const g = createGame(['A', 'B'], 57);
  const v = viewFor(g, 1);
  assert.equal(v.players[0].cash, null);
  assert.equal(v.players[0].inventory, null);
  assert.equal(v.players[0].sharePrice, null);
  assert.equal(v.companyValues[0], null);
  assert.equal(v.players[1].cash, CONFIG.startCompanyCash + CONFIG.seatBonus, 'the second seat starts with a little more');
  assert.ok(v.players[0].acquisitionPrice > 0);
  assert.equal(viewFor(createGame(['A', 'B'], 57, { easyBooks: true }), 1).players[0].cash, CONFIG.startCompanyCash);
});

test('buying a company you hold shares in pays only the other holders', () => {
  const g = createGame(['A', 'B'], 58, { easyBooks: true });
  const [a, b] = g.players;
  b.shares.holders[0] = 20;
  b.shares.holders[1] = 80;
  post(a, 'Raised', { cash: M(20000), capital: -M(20000) });
  Object.assign(g, { turn: 0, phase: 'act' });
  const price = acquisitionPrice(b);
  const personal = a.personalCash;
  const cash = a.ledger.cash;
  assert.equal(act(g, 0, { a: 'acquire', target: 1 }), null);
  assert.equal(a.personalCash, personal, 'the buyer is not paid for their own shares');
  assert.equal(a.ledger.cash, cash - price * 0.8 + CONFIG.startCompanyCash + CONFIG.seatBonus);
});

test('scarce ways to clear frauds: two cards and a settlement at island Customs', () => {
  const g = createGame(['A', 'B'], 59, { easyBooks: true });
  const a = g.players[0];
  Object.assign(g, { turn: 0, phase: 'act' });
  a.hand = ['limitations', 'shred'];
  assert.match(act(g, 0, { a: 'play', card: 0 }), /no frauds/);
  a.frauds = 3;
  assert.equal(act(g, 0, { a: 'play', card: 0 }), null);
  assert.equal(a.frauds, 2);
  assert.equal(act(g, 0, { a: 'play', card: 0 }), null);
  assert.equal(a.frauds, 1, 'shredding clears two but counts as one');

  assert.match(act(g, 0, { a: 'settle' }), /Customs/);
  a.atCustoms = true;
  post(a, 'Test capital', { cash: CONFIG.settlement, capital: -CONFIG.settlement });
  const cash = a.ledger.cash;
  assert.equal(act(g, 0, { a: 'settle' }), null);
  assert.equal(a.frauds, 0);
  assert.equal(a.ledger.cash, cash - CONFIG.settlement);
  a.frauds = 1;
  assert.match(act(g, 0, { a: 'settle' }), /Customs/, 'once per visit');
});

test('the Personal Assets square always gives a free card or a discount on one card', () => {
  const g = createGame(['A', 'B'], 48);
  const p = g.players[0];
  const target = posOfSpace(48);
  assert.equal(SQUARES[target].deck, 'personal');
  const seen = { free: 0, half: 0, quarter: 0, none: 0 };
  for (let landings = 0; landings < 300;) {
    Object.assign(g, { turn: 0, phase: 'roll' });
    p.pos = target - 7;
    p.assets = [];
    act(g, 0, { a: 'roll' });
    if (p.pos !== target) continue;
    landings += 1;
    const price = viewFor(g, 0).players[0].personalPrice;
    if (p.assets.length) seen.free += 1;
    else if (price === CONFIG.personalAssetPrice / 2) seen.half += 1;
    else if (price === CONFIG.personalAssetPrice * 0.75) seen.quarter += 1;
    else seen.none += 1;
    if (price < CONFIG.personalAssetPrice) {
      // The discount covers one card; the next one is full price.
      p.personalCash = 2 * CONFIG.personalAssetPrice;
      assert.equal(act(g, 0, { a: 'personal' }), null);
      assert.equal(p.personalCash, 2 * CONFIG.personalAssetPrice - price);
      assert.equal(viewFor(g, 0).players[0].personalPrice, CONFIG.personalAssetPrice);
    }
  }
  assert.equal(seen.none, 0, 'every landing gives something');
  delete seen.none;
  for (const [k, n] of Object.entries(seen)) assert.ok(n > 30, `${k} happened ${n} times in 300`);
});

test('plain personal assets have small effects', () => {
  const g = createGame(['A', 'B'], 7);
  const p = g.players[0];
  // Mountain Cabin: no sitting out at CPE.
  p.assets = ['cabin'];
  while (p.pos !== 31) {
    Object.assign(g, { turn: 0, phase: 'roll' });
    p.pos = 31 - 7;
    act(g, 0, { a: 'roll' });
  }
  assert.equal(Boolean(p.skip), false);
  // Country Mansion: income each fiscal year.
  p.assets = ['mansion', 'mansion'];
  const kept = p.ledger.cash;
  post(p, 'Test: empty the company so no salary is paid', { cash: -kept, capital: kept });
  const before = p.personalCash;
  Object.assign(g, { turn: 0, phase: 'roll' });
  p.pos = BOARD_SIZE - 2;
  p.raced = true;
  act(g, 0, { a: 'roll' });
  assert.equal(p.personalCash - before, M(200));
  post(p, 'Test: refill the company', { cash: kept, capital: -kept });
  // Horses: one win at the races per fiscal year, on doubles.
  p.assets = ['horses'];
  p.raced = false;
  let wins = 0;
  for (let i = 0; i < 60; i++) {
    Object.assign(g, { turn: 0, phase: 'roll' });
    p.pos = 2;
    const cash = p.personalCash;
    act(g, 0, { a: 'roll' });
    if (p.personalCash > cash) wins += 1;
  }
  assert.equal(wins, 1);
  // Beach House: rent on each island lap.
  p.assets = ['beach'];
  Object.assign(g, { turn: 0, phase: 'roll' });
  p.pos = ISLAND_START + 23;
  p.raced = true;
  const cash = p.personalCash;
  act(g, 0, { a: 'roll' });
  assert.ok(p.personalCash >= cash + M(100));
});

test('frauds age off the record, one every few fiscal years', () => {
  const g = createGame(['A', 'B'], 61, { easyBooks: true });
  const p = g.players[0];
  p.frauds = 2;
  const yearEnd = () => {
    Object.assign(g, { turn: 0, phase: 'roll' });
    p.pos = BOARD_SIZE - 2;
    act(g, 0, { a: 'roll' });
  };
  for (let y = 1; y < CONFIG.fraudExpiryYears && !p.out; y++) yearEnd();
  if (p.out) return; // caught along the way, which can happen
  assert.equal(p.frauds, 2);
  yearEnd();
  if (p.out) return;
  assert.equal(p.frauds, 1);
});

test('a bookkeeper records and files everything for a fee, with no clean-books bonus', () => {
  const g = createGame(['A', 'B'], 62);
  const p = g.players[0];
  assert.equal(act(g, 0, { a: 'outsource', on: true }), null);
  Object.assign(g, { turn: 0, phase: 'roll' });
  p.pos = BOARD_SIZE - 2;
  act(g, 0, { a: 'roll' });
  assert.equal(p.fyePending, null, 'the statements are filed');
  assert.equal(p.misstatements, 0);
  assert.ok(p.journal.some((e) => e.text === 'Bookkeeping fees'));
  assert.ok(!p.journal.some((e) => e.text === 'Bonus for clean books'));
  assert.equal(act(g, 0, { a: 'outsource', on: false }), null);
  assert.equal(p.outsourced, false);
});

test('going public needs a clean filing', () => {
  const g = createGame(['A', 'B'], 63);
  const p = g.players[0];
  Object.assign(g, { turn: 0, phase: 'act' });
  p.years = CONFIG.ipoYears;
  p.lastCheck = { errors: 2 };
  assert.match(act(g, 0, { a: 'ipo' }), /clean statements/);
  p.lastCheck = { errors: 0 };
  assert.equal(act(g, 0, { a: 'ipo' }), null);
});

test('a whistleblower tip runs a fraud check on a rival and pays a reward on a conviction', () => {
  let rewarded = 0;
  for (let seed = 0; seed < 40; seed++) {
    const g = createGame(['A', 'B'], 900 + seed, { easyBooks: true });
    const [a, b] = g.players;
    b.frauds = 9; // about a 50% chance at Interim Review odds
    Object.assign(g, { turn: 0, phase: 'act' });
    a.hand = ['whistle'];
    const cash = a.personalCash;
    assert.equal(act(g, 0, { a: 'play', card: 0, target: 1 }), null);
    if (b.out) {
      rewarded += 1;
      assert.equal(a.personalCash, cash + M(1000));
    } else {
      assert.equal(a.personalCash, cash);
    }
  }
  assert.ok(rewarded > 5 && rewarded < 35, `${rewarded} of 40`);
});

test('a discounted building is booked, depreciated and sold at what was paid', () => {
  const g = createGame(['A', 'B'], 64, { easyBooks: true });
  const p = g.players[0];
  const pos = posOfSpace(1);
  Object.assign(g.tiles[pos], { owner: 0, zone: 'retail', building: null });
  Object.assign(g, { turn: 0, phase: 'act' });
  g.ppeRow[0] = 'rare';
  p.hand = ['backdate'];
  assert.equal(act(g, 0, { a: 'play', card: 0, pos, row: 0 }), null);
  const b = g.tiles[pos].building;
  assert.equal(b.basis, RARITIES.rare.price / 2);
  assert.equal(p.ledger.ppe, b.basis);
  Object.assign(g, { turn: 0, phase: 'roll' });
  p.pos = BOARD_SIZE - 2;
  act(g, 0, { a: 'roll' });
  if (p.out) return;
  assert.equal(-p.ledger.accDep, Math.round(b.basis * CONFIG.depreciation));
});

test('players trade property: offers, the books on both sides, and stale offers', () => {
  const g = createGame(['A', 'B', 'C'], 65);
  const [a, b] = g.players;
  const pos = posOfSpace(1);
  const price = SQUARES[pos].price;
  Object.assign(g.tiles[pos], { owner: 0, zone: 'retail', building: { rarity: 'common', cost: M(100), basis: M(100), dep: M(20) }, stock: 50 });
  post(a, 'Setup', { land: price, ppe: M(100), accDep: -M(20), capital: -(price + M(80)) });
  // B bids on A's lot; A accepts. Either side can propose, at any time.
  assert.equal(act(g, 1, { a: 'offer', pos, target: 0, amount: M(10000) }), 'Your company does not have that much cash.');
  assert.equal(act(g, 1, { a: 'offer', pos, target: 2, amount: M(100) }), 'One of you must own it.');
  assert.equal(act(g, 1, { a: 'offer', pos, target: 0, amount: M(500) }), null);
  const offer = viewFor(g, 0).offers[0];
  assert.equal(offer.from, 1);
  const aCash = a.ledger.cash;
  const bCash = b.ledger.cash;
  assert.equal(act(g, 0, { a: 'respond', offer: offer.id, accept: true }), null);
  assert.equal(g.tiles[pos].owner, 1);
  assert.equal(a.ledger.cash, aCash + M(500));
  assert.equal(b.ledger.cash, bCash - M(500));
  assert.equal(a.ledger.land, 0);
  assert.equal(a.ledger.ppe, 0);
  assert.equal(a.ledger.accDep, 0);
  assert.equal(-a.ledger.gain, M(500) - (price + M(80)), 'A books the gain over book value');
  assert.equal(b.ledger.land, price);
  assert.equal(b.ledger.ppe, M(500) - price);
  assert.equal(a.carried, 50, 'widgets left at the lot stay the seller\'s');
  assert.ok(a.docs.some((d) => d.text.startsWith(`Sold ${SQUARES[pos].name} to B`)));
  assert.ok(b.docs.some((d) => d.text.startsWith(`Bought ${SQUARES[pos].name} from A`)));
  for (const p of g.players) {
    const s = balanceSheet(p);
    assert.ok(Math.abs(s.totalAssets - s.totalLiabilitiesAndEquity) < 0.01);
  }
  // B offers it on to C, then sells it to the bank: C can no longer accept, and declining clears it.
  assert.equal(act(g, 1, { a: 'offer', pos, target: 2, amount: M(300) }), null);
  assert.equal(act(g, 1, { a: 'offer', pos, target: 2, amount: M(400) }), null);
  assert.equal(g.offers.length, 1, 'a new offer replaces your old one');
  const id = g.offers[0].id;
  assert.equal(act(g, 2, { a: 'respond', offer: id, accept: false }), null);
  assert.equal(g.offers.length, 0);
  assert.equal(act(g, 2, { a: 'respond', offer: id, accept: true }), 'That offer is no longer open.');
});

test('upgrading PP&E puts its salvage value toward the new building', () => {
  const g = createGame(['A', 'B'], 12, { easyBooks: true });
  const p = g.players[0];
  g.phase = 'act';
  const pos = posOfSpace(12);
  Object.assign(g.tiles[pos], { owner: 0, zone: 'industrial', building: { rarity: 'common', cost: RARITIES.common.price, basis: RARITIES.common.price, dep: M(20) }, stock: 50 });
  const old = g.tiles[pos].building;
  const salvage = salvageValue(old);
  assert.equal(salvage, Math.round((old.basis - old.dep) * CONFIG.salvage));
  const pricier = g.ppeRow.findIndex((r) => RARITIES[r].price > old.cost);
  const cheaper = g.ppeRow.findIndex((r) => RARITIES[r].price <= old.cost);
  if (cheaper >= 0) assert.match(act(g, 0, { a: 'build', pos, card: cheaper }), /must cost more/);
  const rarity = g.ppeRow[pricier];
  const price = RARITIES[rarity].price;
  // Enough cash only with the salvage counted.
  p.ledger.capital += p.ledger.cash - (price - salvage);
  p.ledger.cash = price - salvage;
  const carried = p.carried;
  assert.equal(act(g, 0, { a: 'build', pos, card: pricier }), null);
  assert.equal(g.tiles[pos].building.rarity, rarity);
  assert.equal(g.tiles[pos].building.dep, 0);
  assert.equal(p.ledger.cash, 0, 'the upgrade costs the new price less the salvage');
  assert.equal(p.carried, carried + 50, 'widgets left in the old building are kept');
  assert.equal(p.ledger.ppe, price - old.basis);
  assert.equal(-p.ledger.gain, salvage - (old.basis - old.dep), 'the rest of its book value is a loss');
  const s = balanceSheet(p);
  assert.ok(Math.abs(s.totalAssets - s.totalLiabilitiesAndEquity) < 0.01);
});

test('rezoning costs a fee and the PP&E must be rebuilt', () => {
  const g = createGame(['A', 'B'], 13, { easyBooks: true });
  const p = g.players[0];
  g.phase = 'act';
  const pos = posOfSpace(12);
  Object.assign(g.tiles[pos], { owner: 0, zone: 'industrial', building: { rarity: 'rare', cost: RARITIES.rare.price, basis: RARITIES.rare.price, dep: 0 }, stock: 0 });
  const card = g.zoningRow.findIndex((z) => z !== 'industrial');
  const to = g.zoningRow[card];
  const same = g.zoningRow.indexOf('industrial');
  if (same >= 0) assert.match(act(g, 0, { a: 'rezone', pos, zone: same }), /already zoned/);
  const salvage = salvageValue(g.tiles[pos].building);
  const cash = p.ledger.cash;
  const deck = g.zoningDeck.length;
  const land = p.ledger.land;
  assert.equal(act(g, 0, { a: 'rezone', pos, zone: card }), null);
  assert.equal(g.tiles[pos].zone, to);
  assert.equal(g.tiles[pos].building, null, 'the PP&E is gone and must be rebuilt');
  assert.equal(p.ledger.cash, cash + salvage - rezoneFee(pos));
  assert.equal(rezoneFee(pos), Math.round(SQUARES[pos].price * CONFIG.rezoneFee));
  assert.equal(p.ledger.land - land, rezoneFee(pos), 'the fee is added to the land\'s cost');
  assert.equal(g.tiles[pos].landBasis, SQUARES[pos].price + rezoneFee(pos));
  assert.equal(g.zoningRow.length, CONFIG.rowSize);
  assert.equal(g.zoningDeck.length, deck, 'the old zoning goes back as the new card comes off');
  assert.equal(act(g, 1, { a: 'rezone', pos, zone: 0 }), 'It is not your turn.');
  g.turn = 1;
  assert.equal(act(g, 1, { a: 'rezone', pos, zone: 0 }), 'Rezone land you own.');
  const s = balanceSheet(p);
  assert.ok(Math.abs(s.totalAssets - s.totalLiabilitiesAndEquity) < 0.01);
});

test('shipping to the island needs an airport of your own', () => {
  const g = createGame(['A', 'B'], 14, { easyBooks: true });
  const p = g.players[0];
  const shop = ISLAND_START + 3;
  Object.assign(g.tiles[shop], { owner: 0, zone: 'retail', building: { rarity: 'common', cost: 100, dep: 0 }, stock: 0 });
  const factory = posOfSpace(12);
  Object.assign(g.tiles[factory], { owner: 0, zone: 'industrial', building: { rarity: 'common', cost: 100, dep: 0 }, stock: 0 });
  give(p, 1000);
  p.carried = 0;
  g.tiles[factory].stock = 1000;
  g.tiles[posOfSpace(5)].owner = 0; // A's railway on the factory's side
  Object.assign(g, { turn: 0, phase: 'act' });
  act(g, 0, { a: 'end' });
  assert.equal(g.tiles[shop].stock, 0, 'a railway does not reach the island');
  g.tiles[posOfSpace(34)].owner = 0; // A's airport
  Object.assign(g, { turn: 0, phase: 'act' });
  act(g, 0, { a: 'end' });
  assert.ok(g.tiles[factory].stock < 1000, 'an airport does');
  assert.equal(p.ledger.inventory, g.tiles[factory].stock + g.tiles[shop].stock);
});

test('a game begun with typed statements switches to statements built from entries', () => {
  const g = createGame(['A', 'B'], 23);
  g.autoStatements = false; // as saved before the switch
  const p = g.players[0];
  Object.assign(g, { turn: 0, phase: 'roll' });
  p.pos = BOARD_SIZE - 2;
  act(g, 0, { a: 'roll' });
  assert.equal(g.autoStatements, true);
  for (const d of p.docs) act(g, 0, { a: 'record', doc: d.id, lines: d.lines });
  assert.equal(act(g, 0, { a: 'statements' }), null);
  assert.equal(p.lastCheck.errors, 0, 'correct entries make correct statements');
});

test('a transport tile is booked as land and PP&E, and its PP&E depreciates', () => {
  const g = createGame(['A', 'B'], 15, { easyBooks: true });
  const p = g.players[0];
  const airport = posOfSpace(34);
  const price = SQUARES[airport].price;
  Object.assign(g, { turn: 0, phase: 'buy' });
  p.pos = airport;
  assert.equal(act(g, 0, { a: 'buy' }), null);
  const land = Math.round(price * CONFIG.transportLand);
  assert.equal(p.ledger.land, land);
  assert.equal(p.ledger.ppe, price - land);
  assert.match(act(g, 0, { a: 'build', pos: airport, card: 0 }), /Only buildings on land/);
  // A year end depreciates the structures, not the land.
  Object.assign(g, { turn: 0, phase: 'roll' });
  p.pos = BOARD_SIZE - 2;
  act(g, 0, { a: 'roll' });
  assert.equal(-p.ledger.accDep, Math.round((price - land) * CONFIG.depreciation));
  const s = balanceSheet(p);
  assert.ok(Math.abs(s.totalAssets - s.totalLiabilitiesAndEquity) < 0.01);
});

test('a fiscal year end books one depreciation entry for all buildings', () => {
  const g = createGame(['A', 'B'], 16);
  const p = g.players[0];
  for (const n of [1, 2, 3]) Object.assign(g.tiles[posOfSpace(n)], { owner: 0, zone: 'industrial', building: { rarity: 'common', cost: 1000, dep: 0 } });
  p.pos = BOARD_SIZE - 2;
  act(g, 0, { a: 'roll' });
  const deps = p.docs.filter((d) => d.text.startsWith('Depreciation'));
  assert.equal(deps.length, 1);
  assert.deepEqual(deps[0].lines.find(([a]) => a === 'expDep'), ['expDep', 300]);
});

test('over whole games, statements built from correct entries match the true books', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const g = createGame(['A', 'B', 'C'], seed, { maxYears: 5 });
    for (let step = 0; step < 2000 && g.phase !== 'over'; step++) {
      const i = g.turn;
      for (const [k, q] of g.players.entries()) {
        if (q.out) continue;
        for (const d of q.docs) if (!d.recorded) act(g, k, { a: 'record', doc: d.id, lines: d.lines });
        if (!q.fyePending) continue;
        const { preview } = viewFor(g, k).players[k];
        for (const kind of ['income', 'balance']) {
          for (const [f, v] of Object.entries(q.fyePending.truth[kind])) assert.ok(Math.abs(preview[kind][f] - v) <= 1, `seed ${seed}: ${f}`);
        }
        assert.equal(act(g, k, { a: 'statements' }), null);
        assert.equal(q.lastCheck.errors, 0);
      }
      if (g.phase === 'roll') act(g, i, { a: 'roll' });
      else if (g.phase === 'buy') act(g, i, { a: g.players[i].ledger.cash > M(2000) ? 'buy' : 'pass', zone: 0 });
      else {
        act(g, i, { a: 'build', pos: g.tiles.findIndex((t) => t && t.owner === i && t.zone && !t.building), card: 0 });
        act(g, i, { a: 'end' });
      }
    }
  }
});
