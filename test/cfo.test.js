import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQUARES, BOARD_SIZE, posOfSpace, CONFIG, ZONES, RARITIES } from '../src/cfo/data.js';
import { createGame, act, timeout, current, viewFor, balanceSheet, incomeStatement, canBuild, netWorth, bankOptions, retailTerms, sideOf } from '../src/cfo/rules.js';

const count = (kind) => SQUARES.filter((s) => s.kind === kind).length;

test('the board matches the spreadsheet: 58 spaces, 4 corners, 47 land, 8 transport', () => {
  assert.equal(BOARD_SIZE, 62);
  assert.equal(SQUARES.length, 62);
  assert.equal(count('land'), 47);
  assert.equal(count('transport'), 8);
  assert.equal(count('deck'), 3);
  assert.deepEqual([0, 21, 31, 52].map((p) => SQUARES[p].kind), ['fye', 'bank', 'cpe', 'review']);
  assert.equal(SQUARES[posOfSpace(5)].mode, 'rail');
  assert.equal(SQUARES[posOfSpace(54)].mode, 'air');
  assert.equal(Object.values(ZONES).reduce((n, z) => n + z.count, 0), 47);
  assert.equal(Object.values(RARITIES).reduce((n, r) => n + r.count, 0), 47);
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
      for (let pos = 0; pos < BOARD_SIZE; pos++) if (!canBuild(g, pos)) act(g, w, { a: 'build', pos, card: 0 });
      if (p.hand.length) act(g, w, { a: 'play', card: 0, target: (w + 1) % players, pos: 0, rarity: 'common' });
      if (p.atBank) act(g, w, { a: 'borrow', amount: 1000 });
      if (p.sale) act(g, w, { a: 'sell', option: 'premium' });
      if (p.ledger.cash > 3000) act(g, w, { a: 'pay', amount: 1000 });
      while (p.personalCash >= CONFIG.personalAssetPrice && !act(g, w, { a: 'personal' }));
      // A diligent bookkeeper: records every document correctly and files the true statements.
      for (const d of p.docs) act(g, w, { a: 'record', doc: d.id, lines: d.lines });
      if (p.fyePending) assert.equal(act(g, w, { a: 'statements', ...p.fyePending.truth }), null);
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
    const g = playOut(seed, 2 + (seed % 5), { easyBooks: seed % 2 === 0 });
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
  assert.equal(doc.text, 'Owner invests starting capital: $3,000 received');
  const view = viewFor(g, 0).players[0];
  assert.equal(view.docs[0].lines, undefined, 'the right answer is not sent');
  assert.equal(view.income, undefined, 'true statements are hidden');
  assert.equal(viewFor(g, 1).players[0].docs, undefined, 'others cannot see your documents');

  assert.equal(act(g, 0, { a: 'record', doc: 99, lines: [['cash', 3000]] }), 'Pick a document to record.');
  assert.equal(act(g, 0, { a: 'record', doc: 1, lines: [['cash', 3000], ['capital', -2000]] }), 'Debits must equal credits.');
  assert.equal(act(g, 0, { a: 'record', doc: 1, lines: [['cash', 3000], ['nonsense', -3000]] }), 'Pick an account for every line.');
  assert.equal(act(g, 0, { a: 'record', doc: 1, lines: [['cash', 3000], ['revOps', -3000]] }), null);

  // Pass FYE: the turn can't end until statements are filed.
  p.pos = BOARD_SIZE - 2;
  act(g, 0, { a: 'roll' });
  if (g.phase === 'buy') act(g, 0, { a: 'pass' });
  assert.ok(p.fyePending);
  assert.match(act(g, 0, { a: 'end' }), /File your statements/);
  const truth = p.fyePending.truth;
  assert.equal(truth.balance.capital, 3000);
  assert.equal(truth.balance.cash, p.ledger.cash);
  // File with one wrong line; the miscoded capital entry counts too, as do unrecorded year-end documents.
  const unrecorded = p.docs.filter((d) => d.year === 1 && !d.recorded).length;
  assert.equal(act(g, 0, { a: 'statements', income: truth.income, balance: { ...truth.balance, cash: truth.balance.cash + 50 } }), null);
  assert.deepEqual(p.lastCheck.wrongFields, ['cash']);
  assert.equal(p.lastCheck.corrections.length, 1 + unrecorded);
  assert.equal(p.misstatements, 2 + unrecorded);
  assert.equal(viewFor(g, 1).players[0].filed.balance.cash, truth.balance.cash + 50, 'others see what was filed');
  assert.equal(act(g, 0, { a: 'end' }), null);

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

test('personal cash moves in $100s and is taxed on the year\'s total', () => {
  const g = createGame(['A', 'B'], 21);
  const p = g.players[0];
  g.phase = 'act';
  assert.match(act(g, 0, { a: 'pay', amount: 150 }), /multiples of \$100/);
  const start = p.personalCash;
  for (let i = 0; i < 5; i++) assert.equal(act(g, 0, { a: 'pay', amount: 100 }), null);
  assert.equal(p.personalCash - start, 400, '20% of $500, however it is split');
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
  assert.equal(p.ledger.land, sq.price); // transport routes are carried with land
});

test('a fiscal year end makes widgets, depreciates, taxes and closes the books', () => {
  const g = createGame(['A', 'B'], 3);
  const p = g.players[0];
  Object.assign(g.tiles[posOfSpace(1)], { owner: 0, zone: 'industrial', building: { rarity: 'rare', cost: 1000, dep: 0 } });
  p.pos = BOARD_SIZE - 2; // any roll passes FYE
  act(g, 0, { a: 'roll' });
  assert.equal(p.years, 1);
  const r = p.report.income;
  assert.equal(p.ledger.inventory, 300); // Industrial spends 30% of its cost making widgets
  assert.equal(r.revenue.revOps, CONFIG.baseRevenue);
  assert.equal(r.expenses.expDep, 100);
  assert.equal(r.tax, Math.round(r.preTax * CONFIG.corporateTax));
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

test('stores sell from their own shelves every turn; more stores raise the price', () => {
  const g = createGame(['A', 'B'], 3);
  const p = g.players[0];
  give(p, 1000);
  p.carried = 0;
  store(g, 0, 1, 'rare', 1000, 900);
  assert.deepEqual(retailTerms(g, 0), { units: 150, price: 2, stores: 1 });
  store(g, 0, 2, 'uncommon', 200, 100);
  assert.deepEqual(retailTerms(g, 0), { units: 180, price: 2.25, stores: 2 });
  g.phase = 'act';
  act(g, 0, { a: 'end' });
  assert.equal(p.ledger.inventory, 820);
  assert.equal(g.tiles[posOfSpace(1)].stock, 750);
  assert.equal(g.tiles[posOfSpace(2)].stock, 70);
  assert.equal(incomeStatement(p).revenue.revSales, 406); // $337.50 + $67.50, each rounded
  assert.equal(incomeStatement(p).expenses.cogs, 180);
});

test('landing on a store: your own runs a special sale, someone else\'s sells through theirs', () => {
  const g = createGame(['A', 'B'], 3);
  const [a, b] = g.players;
  give(a, 1000);
  a.carried = 0;
  give(b, 1000);
  const pos = posOfSpace(1);
  store(g, 0, 1, 'rare', 1000, 1000);
  g.phase = 'act';
  assert.equal(act(g, 0, { a: 'sell', option: 'clearance' }), 'There is no sale to make here.');
  a.sale = { pos };
  assert.equal(act(g, 0, { a: 'sell', option: 'clearance' }), null);
  assert.equal(g.tiles[pos].stock, 550); // 3 x 150 widgets at 75% of $2
  assert.equal(incomeStatement(a).revenue.revSales, 675);
  assert.equal(a.sale, null, 'one sale per landing');

  g.turn = 1;
  b.sale = { pos };
  const before = a.ledger.cash;
  assert.equal(act(g, 1, { a: 'sell' }), null);
  assert.equal(b.carried, 850);
  assert.equal(incomeStatement(b).revenue.revSales, 300);
  assert.equal(a.ledger.cash, before + 75, 'the store owner keeps a 25% commission');
  for (const p of g.players) {
    const s = balanceSheet(p);
    assert.ok(Math.abs(s.totalAssets - s.totalLiabilitiesAndEquity) < 0.01);
  }
});

test('tokens carry widgets from factories to stores, and transport tiles ship along a side', () => {
  const g = createGame(['A', 'B'], 3);
  const [a, b] = g.players;
  const factory = posOfSpace(2);
  Object.assign(g.tiles[factory], { owner: 0, zone: 'industrial', building: { rarity: 'common', cost: 100, dep: 0 }, stock: 0 });
  give(a, 300);
  a.carried = 0;
  g.tiles[factory].stock = 300;
  const shop = posOfSpace(30); // bottom side, like the airport at space 34
  store(g, 0, 30, 'common', 100);
  const airport = posOfSpace(34);
  g.tiles[airport].owner = 1;

  // Walking past the factory picks its widgets up.
  a.pos = factory - 1;
  g.phase = 'roll';
  act(g, 0, { a: 'roll' });
  assert.equal(g.tiles[factory].stock, 0);
  assert.equal(a.carried, 300);
  assert.equal(sideOf(airport), 'bottom');

  // Passing B's airport on the bottom side ships them to A's store there, for a freight fee.
  Object.assign(g, { turn: 0, phase: 'roll' });
  a.pos = airport - 1;
  const bCash = b.ledger.cash;
  act(g, 0, { a: 'roll' });
  assert.equal(a.carried, 0);
  assert.equal(g.tiles[shop].stock, 300);
  assert.equal(b.ledger.cash, bCash + 30);
  assert.equal(incomeStatement(a).expenses.expFreight, 30);
});

test('loans add a liability and charge interest at year end', () => {
  const g = createGame(['A', 'B'], 4);
  const p = g.players[0];
  g.phase = 'act';
  assert.match(act(g, 0, { a: 'borrow', amount: 500 }), /Bank/);
  p.atBank = true;
  assert.match(act(g, 0, { a: 'borrow', amount: 5000 }), /at most/);
  assert.equal(act(g, 0, { a: 'borrow', amount: 2000 }), null);
  assert.equal(balanceSheet(p).liabilities.loan, 2000);
  assert.equal(act(g, 0, { a: 'repay', amount: 500 }), null);
  assert.equal(balanceSheet(p).liabilities.loan, 1500);
});

test('frauds are found at the Interim Review: fined and sent to CPE', () => {
  const g = createGame(['A', 'B'], 5);
  const p = g.players[0];
  p.hand = ['cook'];
  g.phase = 'act';
  assert.equal(act(g, 0, { a: 'play', card: 0 }), null);
  assert.equal(p.frauds, 1);
  assert.equal(viewFor(g, 1).players[0].frauds, undefined, 'others cannot see frauds');
  assert.equal(viewFor(g, 1).players[0].hand, undefined, 'others cannot see the hand');
  act(g, 0, { a: 'end' });
  act(g, 1, { a: 'roll' });
  act(g, 1, { a: 'pass' });
  act(g, 1, { a: 'end' });
  // Walk A onto the Interim Review square.
  while (true) {
    g.turn = 0;
    g.phase = 'roll';
    p.pos = 52 - 7;
    const cash = p.ledger.cash;
    act(g, 0, { a: 'roll' });
    if (p.pos === 31 && p.skip) {
      assert.equal(p.frauds, 0);
      assert.ok(p.ledger.cash <= cash - CONFIG.fraudFine);
      break;
    }
  }
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
  assert.ok(netWorth(g.players[0]) > 0);
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
  assert.equal(act(g, 0, { a: 'build', pos: empty, card: 9 }), 'That land already has a building.');
});

test('frauds can also be found when passing FYE', () => {
  let caught = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const g = createGame(['A', 'B'], seed, { easyBooks: true });
    const p = g.players[0];
    p.frauds = 2;
    p.pos = BOARD_SIZE - 2;
    act(g, 0, { a: 'roll' });
    caught += 2 - p.frauds;
  }
  assert.ok(caught > 5 && caught < 40, `about a quarter of 80 frauds found, got ${caught}`);
});
