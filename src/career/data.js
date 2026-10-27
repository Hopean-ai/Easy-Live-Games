// CFO Career: every number and name for the startup stage, kept apart from the rules so the
// design can be tuned without touching logic. Design doc: "CFO Career: game design" (Miles,
// 2026-10-25/27). Values marked PLACEHOLDER are first guesses that need playtesting.

export const CONFIG = {
  weeksPerMonth: 4,
  monthsPerYear: 12,
  hoursPerWeek: 30, // PLACEHOLDER: the CFO's hours each week; also runs HR and admin, so less than 40
  // Hours to post a document yourself. A till receipt takes longest: count the till, then post the
  // sale and the cost of what was sold.
  postHours: { sale: 2, default: 1 }, // PLACEHOLDER
  fixHours: 1, // PLACEHOLDER: re-post a document you (or a delegate) got wrong
  fileHours: 3, // PLACEHOLDER: the month-end close: review the statements and file them
  lateFilingFee: 300, // PLACEHOLDER: charged when a month isn't filed by the end of its last week

  // The business, run by the CEO (a non-player character). Miles: the CFO makes only finance and
  // accounting decisions, so prices, stock and hiring follow the CEO's plan.
  price: 25, // per widget
  unitCost: 10, // what the supplier charges per widget
  tradingDays: 6,
  capacityPerMachine: 30, // widgets a day
  machinePrice: 12000,
  machineLifeMonths: 60, // straight line, no salvage
  wagePerWorker: 600, // a week; one worker per machine
  rent: 2000, // a month
  utilities: { base: 300, perMachine: 100 }, // a month
  insurance: 2400, // a year, paid up front each January
  demand: { start: 22, growthPerWeek: 1, noise: 0.1 }, // widgets a day
  tillSize: 25, // the till is emptied (one receipt to post) every this many widgets sold in a day
  stockBuffer: 1.15, // the CEO orders this much over expected sales
  refundChance: 0.2, // a week
  founderCardChance: 0.12, // a week: a founder paid a company cost on their own card

  startCash: 20000, // the founders' starting capital, plus the first machine

  // Delegation. Each saves your hours and costs money; staff make mistakes unless you review.
  pos: { setupHours: 4, monthly: 150 },
  bookkeeper: { hireHours: 3, weekly: 250, errorRate: 0.15, reviewHours: 2 },

  // Funding the CEO's growth plans.
  loan: { hours: 4, rate: 0.01 }, // interest a month; interest only, the principal stays for now
  bankNeeds: { filings: 2, maxErrors: 2 }, // the bank reads your last filings before it lends
  investor: { hours: 6, amount: 15000, share: 0.2 }, // friends and family, once
  cashReserve: 3000, // paying cash for a machine must leave this much
  askAgainWeeks: 4, // a declined request comes back after this long

  // Finance projects the CFO can take on with spare hours.
  supplierTerms: { hours: 3, needFilings: 2, days: 30 }, // pay stock four weeks later
  creditLine: { hours: 4, needFilings: 1 },
  overdraftRate: { none: 0.03, creditLine: 0.01 }, // a month on an overdrawn balance

  // Year end.
  taxRate: 0.2,
  fineFor: { error: 250 }, // PLACEHOLDER: per document still wrong or unposted when the tax office reviews the year
  // Tax fraud is a bet: the audit chance grows with what you hid against the year's revenue.
  audit: { base: 0.05, perGap: 2, max: 0.9 }, // PLACEHOLDER
  fraudPenalty: 2, // PLACEHOLDER: caught, you repay the tax you dodged plus this many times it again
  pressure: { holiday: 3000, fromWeek: 18, toWeek: 32, chance: 0.15 }, // the CEO's family holiday
  graduate: { revenue: 28000, months: 3, maxErrors: 6 }, // average monthly revenue over the last 3 months
  maxYears: 2, // fail to graduate by the end of year 2 and the founders replace you
  valueMultiple: 4, // company value = equity + this x the year's profit
};

// The chart of accounts, in statement order. `side` is the normal balance.
export const ACCOUNTS = [
  { name: 'Cash', type: 'asset' },
  { name: 'Inventory', type: 'asset' },
  { name: 'Prepaid insurance', type: 'asset' },
  { name: 'Equipment', type: 'asset' },
  { name: 'Accumulated depreciation', type: 'asset', contra: true },
  { name: 'Accounts payable', type: 'liability' },
  { name: 'Income tax payable', type: 'liability' },
  { name: 'Loan payable', type: 'liability' },
  { name: 'Contributed capital', type: 'equity' },
  { name: 'Distributions to founders', type: 'equity', contra: true },
  { name: 'Retained earnings', type: 'equity' },
  { name: 'Sales revenue', type: 'revenue' },
  { name: 'Sales returns', type: 'revenue', contra: true },
  { name: 'Cost of goods sold', type: 'expense' },
  { name: 'Wages expense', type: 'expense' },
  { name: 'Rent expense', type: 'expense' },
  { name: 'Utilities expense', type: 'expense' },
  { name: 'Insurance expense', type: 'expense' },
  { name: 'Depreciation expense', type: 'expense' },
  { name: 'Interest expense', type: 'expense' },
  { name: 'Supplies expense', type: 'expense' },
  { name: 'Travel expense', type: 'expense' },
  { name: 'Software expense', type: 'expense' },
  { name: 'Bookkeeping expense', type: 'expense' },
  { name: 'Penalties expense', type: 'expense' },
  { name: 'Income tax expense', type: 'expense' },
];
export const ACCOUNT_NAMES = new Set(ACCOUNTS.map((a) => a.name));
export const accountType = (name) => ACCOUNTS.find((a) => a.name === name)?.type ?? null;

// Documents the bookkeeper may post: routine bills. Till receipts are the POS system's; anything
// unusual (founder costs, refunds, funding, equipment, year end) stays with you.
export const BOOKKEEPER_KINDS = new Set(['stock', 'wages', 'rent', 'utilities', 'pos', 'bookkeeper', 'interest', 'supplierPay', 'insuranceUsed', 'depreciation']);

export const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// The stages of a career. Only the startup is built so far.
export const STAGES = [
  { id: 1, name: 'Startup', built: true },
  { id: 2, name: 'Growth', built: false },
  { id: 3, name: 'Public company', built: false },
];
