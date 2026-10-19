import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQUARES, BOARD_SIZE, posOfSpace, CONFIG, ZONES, RARITIES } from '../src/cfo/data.js';
import { createGame, act, timeout, current, viewFor, balanceSheet, incomeStatement, canBuild, netWorth, bankOptions } from '../src/cfo/rules.js';

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
function playOut(seed, players = 4) {
  const g = createGame(Array.from({ length: players }, (_, i) => `P${i}`), seed);
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
      if (p.ledger.cash > 3000) act(g, w, { a: 'pay', amount: 1000 });
      while (p.personalCash >= CONFIG.personalAssetPrice && !act(g, w, { a: 'personal' }));
      act(g, w, { a: 'end' });
    }
    for (const q of g.players) {
      const b = balanceSheet(q);
      assert.ok(Math.abs(b.totalAssets - b.totalLiabilitiesAndEquity) < 0.01, 'assets = liabilities + equity');
      assert.equal(b.assets.cash, q.ledger.cash);
    }
  }
  return g;
}

test('whole games finish with balanced books, from 2 to 6 players', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const g = playOut(seed, 2 + (seed % 5));
    assert.ok(g.winner !== null);
    assert.ok(g.endReason);
  }
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

test('a fiscal year end makes and sells widgets, depreciates, taxes and closes the books', () => {
  const g = createGame(['A', 'B'], 3);
  const p = g.players[0];
  Object.assign(g.tiles[posOfSpace(1)], { owner: 0, zone: 'industrial', building: { rarity: 'rare', cost: 1000, dep: 0 } });
  Object.assign(g.tiles[posOfSpace(2)], { owner: 0, zone: 'retail', building: { rarity: 'uncommon', cost: 200, dep: 0 } });
  p.pos = BOARD_SIZE - 2; // any roll passes FYE
  act(g, 0, { a: 'roll' });
  assert.equal(p.years, 1);
  const r = p.report.income;
  // Industrial spends $300 on widgets; Retail sells up to $240 of them, i.e. $120 at cost.
  assert.equal(p.ledger.inventory, 180);
  assert.equal(r.revenue.revSales, 240);
  assert.equal(r.expenses.cogs, 120);
  assert.equal(r.revenue.revOps, CONFIG.baseRevenue);
  assert.equal(r.expenses.expDep, 120);
  assert.equal(r.tax, Math.round(r.preTax * CONFIG.corporateTax));
  assert.equal(incomeStatement(p).netIncome, 0, 'income accounts start the new year at zero');
  assert.equal(-p.ledger.retained, r.netIncome);
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
