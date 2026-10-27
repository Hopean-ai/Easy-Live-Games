// CFO Career, stage 1: the startup. You are the CFO of a one-product widget shop run by its
// founder and CEO, Sam. Each turn is a week: the business trades, and the documents it produces
// land on your desk. You post them as journal entries, file the books at each month end, and make
// the finance decisions: how to fund growth, when to hand routine posting to a POS system or a
// bookkeeper, and how honest to be with the tax office. A year end decides whether the company is
// ready to raise money and grow (the next stage).
//
// Everything here is pure: a run is a plain object, and `act` applies one player action using the
// run's own seeded dice. Every document carries its true entry; what the player posts is kept
// beside it, so the true books and the books as kept can always be compared.

import { ACCOUNTS, ACCOUNT_NAMES, BOOKKEEPER_KINDS, CONFIG, DAYS, MONTHS, STAGES } from './data.js';

const C = CONFIG;
const LOG_LIMIT = 80;
const WEEKS_PER_YEAR = C.weeksPerMonth * C.monthsPerYear;

// ---- Calendar ----
export const monthOf = (week) => Math.floor((week - 1) / C.weeksPerMonth) + 1; // counted from the start
export const weekInMonth = (week) => ((week - 1) % C.weeksPerMonth) + 1;
export const yearOf = (week) => Math.floor((week - 1) / WEEKS_PER_YEAR) + 1;
export const monthInYear = (month) => ((month - 1) % C.monthsPerYear) + 1;
const monthName = (month) => MONTHS[monthInYear(month) - 1];
const yearOfMonth = (month) => Math.floor((month - 1) / C.monthsPerYear) + 1;
const lastWeekOfYear = (week) => week % WEEKS_PER_YEAR === 0;
const money = (n) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const cents = (n) => Math.round(n * 100) / 100;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// mulberry32 over the run's own state, so a run's luck is fixed by the server's seed.
function rand(s) {
  let t = (s.seed = (s.seed + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---- Starting a run ----
export function start(seed) {
  const s = {
    v: 1, seed: seed | 0, turn: 0, stage: 1,
    week: 1, hours: C.hoursPerWeek,
    machines: 1, workers: 1, pendingMachines: 0, inventory: 0,
    pos: null, bookkeeper: null, review: false, supplierTerms: false, creditLine: false,
    loan: 0, investorShare: 0, payables: [],
    docs: [], nextDoc: 1, lockedThrough: 0,
    filings: [], request: null, nextAskWeek: 0, lostWeeks: 0, holidayAsked: false,
    history: [], year: { hidden: 0, omitted: 0, dodged: 0, tax: 0 }, years: [],
    fines: 0, frauds: 0, caught: 0,
    log: [], over: false, result: null, score: null,
  };
  addDoc(s, 'opening', 'Opening balances',
    `Sam and the other founders put in ${money(C.startCash)} of cash and the first widget machine, worth ${money(C.machinePrice)}.`,
    [dr('Cash', C.startCash), dr('Equipment', C.machinePrice), cr('Contributed capital', C.startCash + C.machinePrice)],
    { by: 'opening' });
  note(s, 'You join Sam\'s widget shop as its first CFO. Sam runs the shop; the money and the books are yours.');
  beginWeek(s);
  return s;
}

const dr = (account, amount) => ({ account, dr: cents(amount), cr: 0 });
const cr = (account, amount) => ({ account, dr: 0, cr: cents(amount) });

function addDoc(s, kind, title, text, lines, { by = null, posted = null, fraud = 0 } = {}) {
  const doc = { id: s.nextDoc++, kind, week: s.week, title, text, lines, posted: null, fraud };
  if (by) doc.posted = { by, lines: posted ?? lines };
  s.docs.push(doc);
  return doc;
}

function note(s, text) {
  s.log.push({ week: s.week, text });
  if (s.log.length > LOG_LIMIT) s.log.splice(0, s.log.length - LOG_LIMIT);
}

// ---- Ledgers ----
// Balances as debits minus credits, from each document's true lines or the lines as posted.
function balances(s, { kept = false, through = Infinity, from = 0 } = {}) {
  const b = Object.fromEntries(ACCOUNTS.map((a) => [a.name, 0]));
  for (const d of s.docs) {
    if (d.week > through || d.week < from) continue;
    const lines = kept ? d.posted?.lines : d.lines;
    if (!lines) continue;
    for (const l of lines) b[l.account] = cents(b[l.account] + l.dr - l.cr);
  }
  return b;
}

export const bankBalance = (s) => balances(s).Cash;

const isIncome = (name) => ['revenue', 'expense'].includes(ACCOUNTS.find((a) => a.name === name).type);

function profitOf(b, { beforeTax = false } = {}) {
  let p = 0;
  for (const a of ACCOUNTS) {
    if (!isIncome(a.name)) continue;
    if (beforeTax && a.name === 'Income tax expense') continue;
    p -= b[a.name];
  }
  return cents(p);
}

const yearStart = (year) => (year - 1) * WEEKS_PER_YEAR + 1;
const yearEnd = (year) => year * WEEKS_PER_YEAR;

// The statements as the player's books show them (kept) or as they truly are.
export function statements(s, { kept = true, year = yearOf(s.week), month = null } = {}) {
  const ytd = balances(s, { kept, from: yearStart(year), through: yearEnd(year) });
  const all = balances(s, { kept, through: yearEnd(year) });
  const prior = year > 1 ? balances(s, { kept, through: yearEnd(year - 1) }) : null;
  const m = month ? balances(s, { kept, from: (month - 1) * C.weeksPerMonth + 1, through: month * C.weeksPerMonth }) : null;
  const line = (b, a) => (a.type === 'revenue' || a.type === 'liability' || a.type === 'equity' ? -b[a.name] : b[a.name]);
  const income = ACCOUNTS.filter((a) => isIncome(a.name)).map((a) => ({ name: a.name, type: a.type, contra: Boolean(a.contra), year: line(ytd, a), month: m ? line(m, a) : null }));
  const retained = prior ? profitOf(prior) : 0;
  const balance = ACCOUNTS.filter((a) => !isIncome(a.name)).map((a) => ({
    name: a.name, type: a.type, contra: Boolean(a.contra),
    amount: a.name === 'Retained earnings' ? cents(line(all, a) + retained) : line(all, a),
  }));
  const profit = profitOf(ytd);
  const assets = cents(balance.filter((l) => l.type === 'asset').reduce((t, l) => t + l.amount, 0));
  const liabilities = cents(balance.filter((l) => l.type === 'liability').reduce((t, l) => t + l.amount, 0));
  const equity = cents(balance.filter((l) => l.type === 'equity').reduce((t, l) => t + l.amount, 0) + profit);
  return { income, profit, monthProfit: m ? profitOf(m) : null, balance, assets, liabilities, equity };
}

// ---- Checking entries ----
function net(lines) {
  const n = {};
  for (const l of lines ?? []) n[l.account] = cents((n[l.account] ?? 0) + l.dr - l.cr);
  return n;
}

export function sameEntry(a, b) {
  const x = net(a);
  const y = net(b);
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if (Math.abs((x[k] ?? 0) - (y[k] ?? 0)) > 0.005) return false;
  return true;
}

// What a document looks like to a reviewer: fine, wrong, or not posted. A fraud is posted the way
// the player chose and looks fine from outside; only an audit finds it.
function status(d) {
  if (!d.posted) return 'missing';
  if (d.fraud) return 'ok';
  return sameEntry(d.posted.lines, d.lines) ? 'ok' : 'wrong';
}

function problems(docs) {
  return docs.filter((d) => d.kind !== 'opening' && status(d) !== 'ok');
}

// Turn the player's lines into clean ones, or say what's wrong.
export function cleanLines(raw) {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 8) return { error: 'An entry needs two to eight lines.' };
  const lines = [];
  for (const l of raw) {
    if (!l || typeof l !== 'object') return { error: 'Each line needs an account and an amount.' };
    const account = String(l.account ?? '');
    if (!ACCOUNT_NAMES.has(account)) return { error: 'Pick an account for every line.' };
    const d = Number(l.dr || 0);
    const c = Number(l.cr || 0);
    if (!Number.isFinite(d) || !Number.isFinite(c) || d < 0 || c < 0 || d > 1e8 || c > 1e8) return { error: 'Amounts must be positive numbers.' };
    if ((d > 0) === (c > 0)) return { error: 'Each line is either a debit or a credit.' };
    lines.push({ account, dr: cents(d), cr: cents(c) });
  }
  const debits = cents(lines.reduce((t, l) => t + l.dr, 0));
  const credits = cents(lines.reduce((t, l) => t + l.cr, 0));
  if (Math.abs(debits - credits) > 0.005) return { error: `Debits (${money(debits)}) and credits (${money(credits)}) must be equal.` };
  return { lines };
}

// ---- The week ----
function demandFor(s) {
  return C.demand.start + C.demand.growthPerWeek * (s.week - 1);
}

const capacity = (s) => s.machines * C.capacityPerMachine;

function beginWeek(s) {
  const w = s.week;
  const wim = weekInMonth(w);
  const month = monthOf(w);
  const m = monthName(month);
  s.hours = C.hoursPerWeek - (s.review && s.bookkeeper ? C.bookkeeper.reviewHours : 0);
  if (s.pendingMachines) {
    s.machines += s.pendingMachines;
    s.workers += s.pendingMachines;
    note(s, `${plural(s.pendingMachines, 'new machine')} started work, with ${plural(s.pendingMachines, 'new worker')}.`);
    s.pendingMachines = 0;
  }

  // Monthly bills.
  if (wim === 1) {
    if (monthInYear(month) === 1) {
      addDoc(s, 'insurance', `Insurance policy, ${yearOf(w) === 1 ? 'first' : 'new'} year`,
        `The shop's insurance for January to December, paid up front: ${money(C.insurance)}.`,
        [dr('Prepaid insurance', C.insurance), cr('Cash', C.insurance)]);
    }
    addDoc(s, 'rent', `Rent for ${m}`, `Rent for the shop for ${m}, paid: ${money(C.rent)}.`,
      [dr('Rent expense', C.rent), cr('Cash', C.rent)]);
    if (s.pos) {
      addDoc(s, 'pos', `POS subscription for ${m}`, `The point-of-sale system's subscription for ${m}, paid: ${money(C.pos.monthly)}.`,
        [dr('Software expense', C.pos.monthly), cr('Cash', C.pos.monthly)]);
    }
  }
  if (wim === 3) {
    const amount = C.utilities.base + C.utilities.perMachine * s.machines;
    addDoc(s, 'utilities', `Utilities for ${m}`, `Electricity and water for ${m}, paid: ${money(amount)}.`,
      [dr('Utilities expense', amount), cr('Cash', amount)]);
  }

  // Supplier invoices from four weeks ago fall due.
  for (const p of s.payables.filter((p) => p.due === w)) {
    addDoc(s, 'supplierPay', 'Payment to the supplier', `Paid the supplier's invoice from week ${weekInMonth(p.week)} of ${monthName(monthOf(p.week))}: ${money(p.amount)}.`,
      [dr('Accounts payable', p.amount), cr('Cash', p.amount)]);
  }
  s.payables = s.payables.filter((p) => p.due !== w);

  // The CEO restocks for a week of expected sales, then the shop trades.
  const expected = Math.round(Math.min(demandFor(s) * C.stockBuffer, capacity(s)) * C.tradingDays);
  const buy = Math.max(0, expected - s.inventory);
  if (buy > 0) {
    const amount = buy * C.unitCost;
    s.inventory += buy;
    if (s.supplierTerms) {
      s.payables.push({ week: w, due: w + C.weeksPerMonth, amount });
      addDoc(s, 'stock', 'Supplier invoice', `${buy} widgets from the supplier at ${money(C.unitCost)} each: ${money(amount)}, due in ${C.supplierTerms.days} days.`,
        [dr('Inventory', amount), cr('Accounts payable', amount)]);
    } else {
      addDoc(s, 'stock', 'Supplier invoice', `${buy} widgets from the supplier at ${money(C.unitCost)} each: ${money(amount)}, paid on delivery.`,
        [dr('Inventory', amount), cr('Cash', amount)]);
    }
  }
  let sold = 0;
  let lost = 0;
  let turnedAway = 0;
  let demand = 0;
  for (let d = 0; d < C.tradingDays; d++) {
    const want = Math.max(0, Math.round(demandFor(s) * (1 + C.demand.noise * (rand(s) * 2 - 1))));
    const units = Math.min(want, capacity(s), s.inventory);
    demand += want;
    lost += want - units;
    turnedAway += want - Math.min(want, capacity(s));
    sold += units;
    s.inventory -= units;
    if (!units) continue;
    // The till is emptied every so many sales, and each emptying is a receipt to post.
    const tills = Math.ceil(units / C.tillSize);
    for (let i = 0; i < tills; i++) {
      const u = Math.floor(units / tills) + (i < units % tills ? 1 : 0);
      addDoc(s, 'sale', `Till receipt, ${DAYS[d]}${tills > 1 ? ` (${i + 1} of ${tills})` : ''}`,
        `${u} widgets sold for cash at ${money(C.price)} each (${money(u * C.price)}). They cost ${money(C.unitCost)} each from stock (${money(u * C.unitCost)}).`,
        [dr('Cash', u * C.price), cr('Sales revenue', u * C.price), dr('Cost of goods sold', u * C.unitCost), cr('Inventory', u * C.unitCost)]);
    }
  }
  const wages = s.workers * C.wagePerWorker;
  addDoc(s, 'wages', 'Payroll', `${plural(s.workers, 'worker')} at ${money(C.wagePerWorker)} for the week, paid: ${money(wages)}.`,
    [dr('Wages expense', wages), cr('Cash', wages)]);
  if (s.bookkeeper) {
    addDoc(s, 'bookkeeper', 'Bookkeeper\'s pay', `The part-time bookkeeper's pay for the week: ${money(C.bookkeeper.weekly)}.`,
      [dr('Bookkeeping expense', C.bookkeeper.weekly), cr('Cash', C.bookkeeper.weekly)]);
  }
  let refunds = 0;
  if (rand(s) < C.refundChance) {
    const u = 1 + Math.floor(rand(s) * 3);
    refunds = u * C.price;
    addDoc(s, 'refund', 'Customer refund', `A customer brought back ${plural(u, 'damaged widget')} and got ${money(refunds)} back in cash. The widgets were thrown away.`,
      [dr('Sales returns', refunds), cr('Cash', refunds)]);
  }
  if (rand(s) < C.founderCardChance) {
    const amount = 80 + 10 * Math.floor(rand(s) * 23);
    addDoc(s, 'founderCard', 'Receipt from Sam', `Sam bought cleaning supplies for the shop (${money(amount)}) on a personal card, and says to count it as more of the founders' capital, not a loan.`,
      [dr('Supplies expense', amount), cr('Contributed capital', amount)]);
  }

  // Month end: the adjusting entries.
  if (wim === C.weeksPerMonth) {
    const dep = Math.round((s.machines * C.machinePrice) / C.machineLifeMonths);
    addDoc(s, 'depreciation', `Depreciation for ${m}`, `One month's depreciation on ${plural(s.machines, 'machine')} (${money(C.machinePrice)} each, straight line over ${C.machineLifeMonths / 12} years): ${money(dep)}.`,
      [dr('Depreciation expense', dep), cr('Accumulated depreciation', dep)]);
    const prepaid = balances(s)['Prepaid insurance'];
    if (prepaid > 0) {
      const used = Math.min(prepaid, C.insurance / C.monthsPerYear);
      addDoc(s, 'insuranceUsed', `Insurance used in ${m}`, `One month of the year's insurance policy has been used up: ${money(used)}.`,
        [dr('Insurance expense', used), cr('Prepaid insurance', used)]);
    }
    let interest = cents(s.loan * C.loan.rate);
    const cash = bankBalance(s);
    if (cash < 0) interest = cents(interest - cash * (s.creditLine ? C.overdraftRate.creditLine : C.overdraftRate.none));
    if (interest > 0) {
      addDoc(s, 'interest', `Bank interest for ${m}`, `Interest the bank took for ${m}${s.loan ? ` on the ${money(s.loan)} loan` : ''}${cash < 0 ? ' and the overdrawn account' : ''}: ${money(interest)}.`,
        [dr('Interest expense', interest), cr('Cash', interest)]);
    }
  }

  s.history.push({ week: w, demand, sold, lost, revenue: sold * C.price - refunds });
  s.lostWeeks = turnedAway > 0 ? s.lostWeeks + 1 : 0;
  if (lost > 0) note(s, `The shop turned away ${plural(lost, 'customer')} this week: ${turnedAway ? 'the machines were at full capacity' : 'it ran out of stock'}.`);

  // What the CEO brings to you.
  if (wim === C.weeksPerMonth && monthInYear(month) === C.monthsPerYear) {
    s.request = { kind: 'tax' };
  } else if (!s.request && s.lostWeeks >= 2 && w >= s.nextAskWeek && !s.pendingMachines) {
    s.request = { kind: 'expand' };
  } else if (!s.request && !s.holidayAsked && w >= C.pressure.fromWeek && w <= C.pressure.toWeek && rand(s) < C.pressure.chance) {
    s.holidayAsked = true;
    s.request = { kind: 'holiday' };
  }

  delegate(s);
}

// The POS system and the bookkeeper post what they can. The bookkeeper makes mistakes unless you
// spend hours reviewing the work.
const SLIPS = {
  Inventory: 'Supplies expense', 'Wages expense': 'Rent expense', 'Rent expense': 'Utilities expense',
  'Utilities expense': 'Rent expense', 'Software expense': 'Supplies expense', 'Bookkeeping expense': 'Wages expense',
  'Interest expense': 'Loan payable', 'Accounts payable': 'Inventory', 'Insurance expense': 'Prepaid insurance',
  'Depreciation expense': 'Equipment', 'Prepaid insurance': 'Insurance expense',
};

function delegate(s) {
  let posted = 0;
  let caught = 0;
  for (const d of s.docs) {
    if (d.posted || d.week <= s.lockedThrough) continue;
    if (s.pos && d.kind === 'sale' && d.week >= s.pos) {
      d.posted = { by: 'pos', lines: d.lines };
      continue;
    }
    if (s.bookkeeper && BOOKKEEPER_KINDS.has(d.kind)) {
      posted++;
      if (rand(s) < C.bookkeeper.errorRate) {
        if (s.review) {
          caught++;
        } else {
          const lines = d.lines.map((l, i) => (i === 0 && SLIPS[l.account] ? { ...l, account: SLIPS[l.account] } : l));
          d.posted = { by: 'bookkeeper', lines };
          continue;
        }
      }
      d.posted = { by: 'bookkeeper', lines: d.lines };
    }
  }
  if (posted) note(s, `The bookkeeper posted ${plural(posted, 'document')}${caught ? `; your review caught ${plural(caught, 'mistake')}` : ''}.`);
}

// ---- Requests (cards) ----
function bankWillLend(s) {
  const last = s.filings.slice(-C.bankNeeds.filings);
  if (last.length < C.bankNeeds.filings) return `The bank wants to see ${C.bankNeeds.filings} filed months first.`;
  if (last.some((f) => f.late || f.errors + f.missing > C.bankNeeds.maxErrors)) return `The bank wants your last ${C.bankNeeds.filings} filings on time, with no more than ${C.bankNeeds.maxErrors} problems each.`;
  return null;
}

function yearRevenue(s, year = yearOf(s.week)) {
  return s.history.filter((h) => yearOf(h.week) === year).reduce((t, h) => t + h.revenue, 0);
}

function taxBase(s) {
  const b = balances(s, { from: yearStart(yearOf(s.week)), through: yearEnd(yearOf(s.week)) });
  return Math.max(0, profitOf(b, { beforeTax: true }));
}

const CARDS = {
  expand: {
    title: () => 'Sam wants another machine',
    text: (s) => {
      const last = s.history.at(-1);
      return `The shop turned away ${plural(last.lost, 'customer')} last week. Sam wants a second line: a machine for ${money(C.machinePrice)} and one more worker (${money(C.wagePerWorker)} a week), adding ${C.capacityPerMachine} widgets a day. The bank balance is ${money(bankBalance(s))}. How do we pay for it?`;
    },
    choices: (s) => {
      const bank = bankWillLend(s);
      return [
        { label: 'Pay cash', hint: `1 hour. Keeps at least ${money(C.cashReserve)} in the bank.`, hours: 1, off: bankBalance(s) - C.machinePrice < C.cashReserve ? 'Not enough cash.' : null },
        { label: `Borrow ${money(C.machinePrice)} from the bank`, hint: `${C.loan.hours} hours to apply. ${C.loan.rate * 100}% interest a month.`, hours: C.loan.hours, off: bank },
        { label: `Raise ${money(C.investor.amount)} from friends and family`, hint: `${C.investor.hours} hours to pitch. They take ${C.investor.share * 100}% of the company.`, hours: C.investor.hours, off: s.investorShare ? 'You already raised from them.' : null },
        { label: 'Not now', hint: `Sam will ask again in ${C.askAgainWeeks} weeks.`, hours: 0 },
      ];
    },
    pick: (s, i) => {
      if (i === 3) {
        s.nextAskWeek = s.week + C.askAgainWeeks;
        note(s, 'You told Sam the company can\'t afford another machine yet.');
        return;
      }
      if (i === 1) {
        s.loan += C.machinePrice;
        addDoc(s, 'loan', 'Bank loan', `The bank lent the company ${money(C.machinePrice)} at ${C.loan.rate * 100}% a month, interest only for now. The money is in the account.`,
          [dr('Cash', C.machinePrice), cr('Loan payable', C.machinePrice)]);
      }
      if (i === 2) {
        s.investorShare = C.investor.share;
        addDoc(s, 'investment', 'Investment from friends and family', `Friends and family invested ${money(C.investor.amount)} for ${C.investor.share * 100}% of the company. The money is in the account.`,
          [dr('Cash', C.investor.amount), cr('Contributed capital', C.investor.amount)]);
      }
      addDoc(s, 'equipment', 'New machine', `A new widget machine, bought for ${money(C.machinePrice)} and paid from the company account. It starts work next week.`,
        [dr('Equipment', C.machinePrice), cr('Cash', C.machinePrice)]);
      s.pendingMachines += 1;
      s.lostWeeks = 0;
      s.nextAskWeek = s.week + C.askAgainWeeks;
      note(s, ['You paid cash for a new machine.', 'You took a bank loan for a new machine.', 'You raised money from friends and family and bought a new machine.'][i]);
    },
  },
  holiday: {
    title: () => 'Sam\'s holiday',
    text: () => `Sam put the family holiday on the company card: ${money(C.pressure.holiday)}. "Book it as business travel," Sam says. "It cuts our tax, and nobody checks."`,
    choices: () => [
      { label: 'Record it as a payout to the founders', hint: '1 hour. Honest: it\'s not a business cost, so it doesn\'t cut tax.', hours: 1 },
      { label: 'Book it as business travel', hint: '1 hour. Fraud: it cuts this year\'s tax, and a tax audit could find it.', hours: 1 },
      { label: 'Refuse: Sam pays it back', hint: 'No hours. The company is repaid in full.', hours: 0 },
    ],
    pick: (s, i) => {
      const amount = C.pressure.holiday;
      if (i === 2) {
        note(s, 'You made Sam pay for the holiday personally. Sam was not pleased.');
        return;
      }
      const honest = [dr('Distributions to founders', amount), cr('Cash', amount)];
      const text = `The company card paid ${money(amount)} for Sam's family holiday.`;
      if (i === 0) {
        addDoc(s, 'holiday', 'Sam\'s holiday', text, honest, { by: 'you' });
        note(s, 'You recorded Sam\'s holiday as a payout to the founders.');
      } else {
        addDoc(s, 'holiday', 'Sam\'s holiday', text, honest, { by: 'you', posted: [dr('Travel expense', amount), cr('Cash', amount)], fraud: amount });
        s.year.hidden += amount;
        s.frauds++;
        note(s, 'You booked Sam\'s holiday as business travel.');
      }
    },
  },
  tax: {
    title: () => 'The tax return',
    text: (s) => `The year is over and the tax return is due. On the true numbers, the year's taxable profit is ${money(Math.max(0, taxBase(s) - s.year.hidden))}${s.year.hidden ? ` (after the ${money(s.year.hidden)} booked as travel)` : ''}, and the tax is ${money(Math.round(C.taxRate * Math.max(0, taxBase(s) - s.year.hidden)))}. Sam points out that much of the shop's revenue is cash, and cash is hard to trace.`,
    choices: (s) => {
      const revenue = yearRevenue(s);
      return [
        { label: 'File honestly', hint: '2 hours.', hours: 2 },
        { label: 'Leave out 10% of cash sales', hint: `2 hours. Fraud: hides ${money(Math.round(revenue * 0.1))} of revenue and raises the chance of an audit.`, hours: 2 },
        { label: 'Leave out 25% of cash sales', hint: `2 hours. Fraud: hides ${money(Math.round(revenue * 0.25))} of revenue; an audit becomes likely.`, hours: 2 },
      ];
    },
    pick: (s, i) => {
      const omitted = Math.round(yearRevenue(s) * [0, 0.1, 0.25][i]);
      const honestBase = Math.max(0, taxBase(s));
      const filedBase = Math.max(0, honestBase - s.year.hidden - omitted);
      const tax = Math.round(C.taxRate * filedBase);
      s.year.omitted = omitted;
      s.year.tax = tax;
      s.year.dodged = Math.round(C.taxRate * honestBase) - tax;
      if (omitted) s.frauds++;
      if (tax > 0) {
        addDoc(s, 'tax', 'Income tax for the year', `The tax return shows ${money(tax)} of income tax for the year, to be paid next week. Book it in this year.`,
          [dr('Income tax expense', tax), cr('Income tax payable', tax)]);
      }
      note(s, omitted ? `You filed a tax return leaving out ${money(omitted)} of cash sales.` : 'You filed an honest tax return.');
    },
  },
};

// ---- Projects: delegation and finance work the CFO can take on ----
function projects(s) {
  const filed = s.filings.filter((f) => !f.late && f.errors + f.missing <= C.bankNeeds.maxErrors).length;
  return [
    {
      id: 'pos', name: 'Set up a point-of-sale system',
      text: `Posts every till receipt for you, correctly. ${money(C.pos.monthly)} a month.`,
      hours: C.pos.setupHours, done: Boolean(s.pos), off: null,
    },
    {
      id: 'bookkeeper', name: 'Hire a part-time bookkeeper',
      text: `Posts routine bills, month-end entries and payroll. ${money(C.bookkeeper.weekly)} a week. Gets about ${C.bookkeeper.errorRate * 100}% of them wrong unless you review.`,
      hours: C.bookkeeper.hireHours, done: Boolean(s.bookkeeper), off: null,
    },
    {
      id: 'review', name: s.review ? 'Stop reviewing the bookkeeper' : 'Review the bookkeeper\'s work',
      text: s.review ? `You spend ${C.bookkeeper.reviewHours} hours a week catching the bookkeeper's mistakes.` : `${C.bookkeeper.reviewHours} hours every week, starting next week. Catches every mistake before it's posted.`,
      hours: 0, done: false, toggle: true, off: s.bookkeeper ? null : 'Hire a bookkeeper first.',
    },
    {
      id: 'terms', name: 'Negotiate 30-day terms with the supplier',
      text: 'Pay for stock four weeks after it arrives, so cash stays in the bank longer.',
      hours: C.supplierTerms.hours, done: s.supplierTerms,
      off: filed < C.supplierTerms.needFilings ? `The supplier wants ${C.supplierTerms.needFilings} good filings first.` : null,
    },
    {
      id: 'creditLine', name: 'Open a bank credit line',
      text: `If the account is overdrawn, the bank charges ${C.overdraftRate.creditLine * 100}% a month instead of ${C.overdraftRate.none * 100}%.`,
      hours: C.creditLine.hours, done: s.creditLine,
      off: filed < C.creditLine.needFilings ? 'The bank wants a good filing first.' : null,
    },
  ];
}

// ---- Actions ----
export function act(s, action) {
  if (s.over) return { error: 'This career is over.' };
  const type = action?.type;
  const result = type === 'post' ? post(s, action)
    : type === 'file' ? file(s)
      : type === 'choose' ? choose(s, action)
        : type === 'project' ? project(s, action)
          : type === 'endWeek' ? endWeek(s)
            : { error: 'Unknown action.' };
  if (!result.error) s.turn++;
  return result;
}

function spend(s, hours) {
  if (hours > s.hours) return `That takes ${plural(hours, 'hour')} and you have ${plural(s.hours, 'hour')} left this week.`;
  s.hours -= hours;
  return null;
}

function post(s, { doc: id, lines: raw }) {
  const d = s.docs.find((x) => x.id === Number(id));
  if (!d || d.kind === 'opening' || d.fraud) return { error: 'That document isn\'t on your desk.' };
  if (d.week <= s.lockedThrough) return { error: 'That year is closed.' };
  if (d.week > s.week) return { error: 'That document isn\'t on your desk.' };
  const clean = cleanLines(raw);
  if (clean.error) return clean;
  const hours = d.posted ? C.fixHours : (C.postHours[d.kind] ?? C.postHours.default);
  const short = spend(s, hours);
  if (short) return { error: short };
  d.posted = { by: 'you', lines: clean.lines };
  return { ok: true };
}

function file(s) {
  if (weekInMonth(s.week) !== C.weeksPerMonth) return { error: 'You file the books in the last week of the month.' };
  const month = monthOf(s.week);
  if (s.filings.some((f) => f.month === month)) return { error: 'This month is already filed.' };
  const short = spend(s, C.fileHours);
  if (short) return { error: short };
  fileMonth(s, month, false);
  return { ok: true };
}

function fileMonth(s, month, late) {
  const docs = s.docs.filter((d) => monthOf(d.week) === month && d.kind !== 'opening');
  const bad = problems(docs);
  const filing = {
    month, late,
    errors: bad.filter((d) => d.posted).length,
    missing: bad.filter((d) => !d.posted).length,
    found: bad.map((d) => d.id),
  };
  s.filings.push(filing);
  const issues = filing.errors + filing.missing;
  note(s, `${late ? 'You missed the deadline, so the books for' : 'You filed the books for'} ${monthName(month)}${late ? ' went in late' : ''}. Your accountant's review found ${issues ? plural(issues, 'problem') : 'no problems'}.`);
  if (late) {
    s.lateFee = (s.lateFee ?? 0) + C.lateFilingFee;
  }
}

function choose(s, { i }) {
  if (!s.request) return { error: 'Nothing is waiting for an answer.' };
  const card = CARDS[s.request.kind];
  const choices = card.choices(s);
  const n = Number(i);
  const c = choices[n];
  if (!c) return { error: 'Pick one of the choices.' };
  if (c.off) return { error: c.off };
  const short = spend(s, c.hours);
  if (short) return { error: short };
  s.request = null;
  card.pick(s, n);
  return { ok: true };
}

function project(s, { id }) {
  const p = projects(s).find((x) => x.id === id);
  if (!p) return { error: 'Unknown project.' };
  if (p.off) return { error: p.off };
  if (p.done) return { error: 'Already done.' };
  const short = spend(s, p.hours);
  if (short) return { error: short };
  if (id === 'pos') {
    s.pos = s.week;
    addDoc(s, 'pos', 'POS subscription, first month', `The point-of-sale system's first month, paid: ${money(C.pos.monthly)}.`,
      [dr('Software expense', C.pos.monthly), cr('Cash', C.pos.monthly)]);
    note(s, 'You set up a POS system. From now on it posts every till receipt.');
    delegate(s);
  } else if (id === 'bookkeeper') {
    s.bookkeeper = s.week;
    note(s, 'You hired a part-time bookkeeper, who starts on routine documents next week.');
  } else if (id === 'review') {
    s.review = !s.review;
    note(s, s.review ? 'You will review the bookkeeper\'s work each week.' : 'You stopped reviewing the bookkeeper\'s work.');
  } else if (id === 'terms') {
    s.supplierTerms = true;
    note(s, 'The supplier agreed to 30-day terms. New stock is paid for four weeks after it arrives.');
  } else if (id === 'creditLine') {
    s.creditLine = true;
    note(s, 'The bank opened a credit line for overdrafts.');
  }
  return { ok: true };
}

function endWeek(s) {
  if (s.request) return { error: 'Answer Sam first.' };
  const w = s.week;
  if (weekInMonth(w) === C.weeksPerMonth && !s.filings.some((f) => f.month === monthOf(w))) fileMonth(s, monthOf(w), true);
  if (lastWeekOfYear(w)) closeYear(s);
  if (s.over) return { ok: true };
  s.week++;
  beginWeek(s);
  // Penalties and taxes owed from last week.
  if (s.lateFee) {
    addDoc(s, 'penalty', 'Late filing fee', `The fee for filing last month's books late: ${money(s.lateFee)}, paid.`,
      [dr('Penalties expense', s.lateFee), cr('Cash', s.lateFee)]);
    s.lateFee = 0;
  }
  if (s.owed) {
    for (const o of s.owed) addDoc(s, o.kind, o.title, o.text, o.lines);
    s.owed = null;
  }
  return { ok: true };
}

// The tax office reviews the year: fines for documents still wrong or missing, and an audit that
// may find any fraud. Then the year decides whether the company is ready for the next stage.
function closeYear(s) {
  const year = yearOf(s.week);
  const docs = s.docs.filter((d) => yearOf(d.week) === year && d.kind !== 'opening');
  const bad = problems(docs);
  const fine = bad.length * C.fineFor.error;
  const owed = [];
  const revenue = yearRevenue(s, year);
  if (s.year.tax > 0) {
    owed.push({ kind: 'taxPay', title: 'Income tax paid', text: `Paid last year's income tax to the tax office: ${money(s.year.tax)}.`,
      lines: [dr('Income tax payable', s.year.tax), cr('Cash', s.year.tax)] });
  }
  if (fine) {
    s.fines += fine;
    owed.push({ kind: 'penalty', title: 'Tax office fine', text: `The tax office fined the company ${money(fine)} for ${plural(bad.length, 'document')} wrong or missing in last year's books, paid.`,
      lines: [dr('Penalties expense', fine), cr('Cash', fine)] });
  }
  const hidden = s.year.hidden + s.year.omitted;
  let audited = false;
  if (hidden > 0) {
    const chance = Math.min(C.audit.max, C.audit.base + C.audit.perGap * (hidden / Math.max(1, revenue)));
    if (rand(s) < chance) {
      audited = true;
      s.caught++;
      const back = Math.max(0, s.year.dodged);
      const penalty = Math.round(back * C.fraudPenalty);
      s.fines += penalty;
      if (back + penalty > 0) owed.push({ kind: 'backTax', title: 'Tax audit', text: `A tax audit found ${money(hidden)} hidden from the tax office. Back taxes of ${money(back)} and a penalty of ${money(penalty)}, paid.`,
        lines: [dr('Income tax expense', back), dr('Penalties expense', penalty), cr('Cash', back + penalty)].filter((l) => l.dr || l.cr) });
    }
  }
  s.owed = owed;
  const truth = statements(s, { kept: false, year });
  const recent = s.history.slice(-C.graduate.months * C.weeksPerMonth);
  const monthly = Math.round(recent.reduce((t, h) => t + h.revenue, 0) / C.graduate.months);
  const cash = bankBalance(s);
  const record = { year, problems: bad.length, fine, hidden, audited, revenue, profit: truth.profit, monthly, cash };
  s.years.push(record);
  s.lockedThrough = s.week;
  note(s, `The tax office reviewed year ${year}: ${bad.length ? `${plural(bad.length, 'problem')}, a fine of ${money(fine)}` : 'clean books'}.${audited ? ' An audit found the hidden income.' : ''}`);

  const missing = [];
  if (monthly < C.graduate.revenue) missing.push(`average monthly revenue of ${money(C.graduate.revenue)} over the last ${C.graduate.months} months (you had ${money(monthly)})`);
  if (bad.length > C.graduate.maxErrors) missing.push(`no more than ${C.graduate.maxErrors} problems in the year's books (you had ${bad.length})`);
  if (cash < 0) missing.push('money in the bank at year end');
  if (!missing.length) {
    s.over = true;
    s.result = 'graduated';
    s.score = score(s, truth);
    note(s, `Investors are lining up: the company is ready to grow. Stage 1 complete, with a score of ${s.score.toLocaleString('en-US')}.`);
  } else if (year >= C.maxYears) {
    s.over = true;
    s.result = 'replaced';
    s.score = score(s, truth);
    note(s, `After ${plural(year, 'year')} the company still isn't ready to grow, and the founders hire a new CFO. It needed ${missing.join('; ')}.`);
  } else {
    note(s, `Not ready to raise money yet. The company needs ${missing.join('; ')}. You have one more year.`);
  }
  s.missing = missing;
  s.year = { hidden: 0, omitted: 0, dodged: 0, tax: 0 };
}

// The founders' share of what the company is worth: its equity plus a multiple of the year's
// profit, after everything paid in fines and penalties. A company that takes an extra year to be
// ready is worth that much less to the founders, so stalling never pays.
export function score(s, truth = statements(s, { kept: false })) {
  const value = truth.equity + C.valueMultiple * Math.max(0, truth.profit);
  return Math.max(0, Math.round((value * (1 - s.investorShare)) / yearOf(s.week)));
}

// ---- What the page sees ----
export function view(s) {
  const month = monthOf(s.week);
  const kept = statements(s, { kept: true, month });
  const lastFiling = s.filings.at(-1) ?? null;
  const card = s.request ? CARDS[s.request.kind] : null;
  const docView = (d) => ({
    id: d.id, kind: d.kind, title: d.title, text: d.text, week: d.week,
    when: `Week ${weekInMonth(d.week)}, ${monthName(monthOf(d.week))}${yearOf(d.week) > 1 ? `, year ${yearOf(d.week)}` : ''}`,
    hours: d.posted ? C.fixHours : (C.postHours[d.kind] ?? C.postHours.default),
    posted: d.posted ? { by: d.posted.by, lines: d.posted.lines } : null,
    fixable: d.kind !== 'opening' && !d.fraud && d.week > s.lockedThrough,
  });
  const last = s.history.at(-1);
  return {
    turn: s.turn,
    stage: STAGES.find((x) => x.id === s.stage),
    stages: STAGES,
    week: s.week,
    weekInMonth: weekInMonth(s.week),
    weeksPerMonth: C.weeksPerMonth,
    month: monthName(month),
    year: yearOf(s.week),
    hours: s.hours,
    hoursPerWeek: C.hoursPerWeek,
    canFile: weekInMonth(s.week) === C.weeksPerMonth && !s.filings.some((f) => f.month === month),
    fileHours: C.fileHours,
    bank: bankBalance(s),
    business: {
      machines: s.machines, workers: s.workers, capacity: capacity(s) * C.tradingDays, stock: s.inventory,
      demand: last?.demand ?? 0, sold: last?.sold ?? 0, lost: last?.lost ?? 0, revenue: last?.revenue ?? 0,
      loan: s.loan, investorShare: s.investorShare, payables: s.payables.reduce((t, p) => t + p.amount, 0),
    },
    delegates: { pos: Boolean(s.pos), bookkeeper: Boolean(s.bookkeeper), review: s.review, supplierTerms: s.supplierTerms, creditLine: s.creditLine },
    inbox: s.docs.filter((d) => !d.posted).map(docView),
    journal: s.docs.filter((d) => d.posted && d.kind !== 'opening').slice(-40).reverse().map(docView),
    accounts: ACCOUNTS.map((a) => ({ name: a.name, type: a.type })),
    statements: kept,
    review: lastFiling ? {
      month: monthName(lastFiling.month),
      year: yearOfMonth(lastFiling.month),
      late: lastFiling.late,
      errors: lastFiling.errors,
      missing: lastFiling.missing,
      found: lastFiling.found.map((id) => s.docs.find((d) => d.id === id)).map((d) => ({
        id: d.id, title: d.title, when: docView(d).when, problem: status(d) === 'ok' ? 'fixed' : status(d),
        posted: d.posted?.lines ?? null, correct: d.lines,
      })),
    } : null,
    filings: s.filings.map((f) => ({ month: monthName(f.month), year: yearOfMonth(f.month), late: f.late, problems: f.errors + f.missing })),
    card: card ? {
      title: card.title(s),
      text: card.text(s),
      choices: card.choices(s).map(({ label, hint, hours, off }) => ({ label, hint, hours, off: off ?? (hours > s.hours ? `Needs ${plural(hours, 'hour')}.` : null) })),
    } : null,
    projects: projects(s).map((p) => ({ ...p, off: p.off ?? (!p.done && p.hours > s.hours ? `Needs ${plural(p.hours, 'hour')}.` : null) })),
    goal: { revenue: C.graduate.revenue, months: C.graduate.months, maxErrors: C.graduate.maxErrors, years: C.maxYears },
    years: s.years,
    log: s.log.slice(-15),
    missing: s.missing ?? [],
    over: s.over,
    result: s.result,
    score: s.over ? s.score : score(s),
    frauds: s.frauds,
    caught: s.caught,
  };
}
